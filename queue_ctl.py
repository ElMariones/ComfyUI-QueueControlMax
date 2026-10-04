"""Queue control: pause, FIFO reordering, parking, autosave / auto-restore, named saves and history recording.

ComfyUI's PromptQueue is a heap ordered by each item's number; new jobs get the next (largest) number, so they
naturally run last. Reordering only permutes the existing numbers between items, which keeps that guarantee.
"""
import asyncio
import copy
import heapq
import json
import logging
import os
import re
import threading
import time
import types
import uuid

import execution
from server import PromptServer

from . import store
from .summary import summarize

log = logging.getLogger("QueueControlMax")
AUTOSAVE = os.path.join(store.DATA_DIR, "autosave.json")
SAVES_DIR = os.path.join(store.DATA_DIR, "saves")
MEDIA_KEYS = ("images", "gifs", "videos", "video", "animated")

_paused = False
_restored = False
notices = []  # one-shot messages for the UI


def pq():
    return PromptServer.instance.prompt_queue


# ── pause ────────────────────────────────────────────────────────
def is_paused():
    return _paused


def set_paused(value):
    global _paused
    _paused = bool(value)
    q = pq()
    with q.not_empty:
        q.not_empty.notify_all()
    q.server.queue_updated()
    log.info("[QueueControlMax] queue %s", "PAUSED" if _paused else "RESUMED")


# ── patches ──────────────────────────────────────────────────────
def install():
    q = pq()
    orig_done = q.task_done

    def get(self, timeout=None):
        with self.not_empty:
            while len(self.queue) == 0 or _paused:
                self.not_empty.wait(timeout=timeout)
                if timeout is not None and (len(self.queue) == 0 or _paused):
                    return None
            item = heapq.heappop(self.queue)
            i = self.task_counter
            self.currently_running[i] = copy.deepcopy(item)
            self.task_counter += 1
            self.server.queue_updated()
            return (item, i)

    def task_done(self, item_id, history_result, status, *args, **kwargs):
        running = self.currently_running.get(item_id)
        result = orig_done(item_id, history_result, status, *args, **kwargs)
        if running is not None:
            try:
                record_history(running, history_result, status)
            except Exception:
                log.exception("[QueueControlMax] could not record history")
        return result

    q.get = types.MethodType(get, q)
    q.task_done = types.MethodType(task_done, q)


# ── history ──────────────────────────────────────────────────────
def collect_outputs(outputs):
    found = []
    for node_out in (outputs or {}).values():
        for key in MEDIA_KEYS:
            for f in node_out.get(key, []) or []:
                if isinstance(f, dict) and f.get("filename") and f.get("type", "output") == "output":
                    found.append({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": "output"})
    return found


def record_history(item, history_result, status):
    _number, prompt_id, prompt, extra = item[0], item[1], item[2], item[3]
    messages = list(getattr(status, "messages", None) or [])
    times = {m[0]: m[1].get("timestamp") for m in messages if isinstance(m, (list, tuple)) and len(m) > 1 and isinstance(m[1], dict)}
    if status is None:
        state = "interrupted"
    elif any(m[0] == "execution_interrupted" for m in messages if isinstance(m, (list, tuple))):
        state = "interrupted"
    else:
        state = status.status_str
    finished = time.time()
    start = times.get("execution_start")
    duration = (finished - start / 1000) if start else None
    queued_at = (extra.get("create_time") or 0) / 1000 or finished
    workflow = (extra.get("extra_pnginfo") or {}).get("workflow")
    store.add_history(store.history_row(prompt_id, queued_at, finished, duration, state, summarize(prompt, extra),
                                        collect_outputs((history_result or {}).get("outputs")), "run", prompt, workflow))


# ── queue listing / editing ──────────────────────────────────────
def ordered_queue():
    with pq().mutex:
        return sorted(pq().queue, key=lambda it: it[0])


def running_items():
    with pq().mutex:
        return list(pq().currently_running.values())


def find_item(prompt_id):
    for item in running_items() + ordered_queue():
        if item[1] == prompt_id:
            return item
    return None


def move(prompt_id, to):
    """to: 'up' | 'down' | 'top' | 'bottom' | int position. Permutes numbers, so new jobs still go last."""
    q = pq()
    with q.mutex:
        items = sorted(q.queue, key=lambda it: it[0])
        numbers = [it[0] for it in items]
        idx = next((i for i, it in enumerate(items) if it[1] == prompt_id), None)
        if idx is None:
            return False
        item = items.pop(idx)
        target = {"up": idx - 1, "down": idx + 1, "top": 0, "bottom": len(items)}.get(to, to)
        items.insert(max(0, min(int(target), len(items))), item)
        q.queue = [(n,) + it[1:] for n, it in zip(numbers, items)]
        heapq.heapify(q.queue)
        q.server.queue_updated()
    return True


def delete(prompt_ids):
    ids = set(prompt_ids)
    q = pq()
    with q.mutex:
        q.queue = [it for it in q.queue if it[1] not in ids]
        heapq.heapify(q.queue)
        q.server.queue_updated()


def clear():
    pq().wipe_queue()


def enqueue(prompt, extra, outputs_to_execute, front=False, prompt_id=None):
    server = PromptServer.instance
    number = server.number
    server.number += 1
    if front:
        number = -number
    extra = dict(extra or {})
    extra["create_time"] = int(time.time() * 1000)
    pid = prompt_id or str(uuid.uuid4())
    server.prompt_queue.put((number, pid, prompt, extra, outputs_to_execute, {}))
    return pid


async def submit(prompt, extra, front=False, prompt_id=None):
    """Validate like POST /prompt does, then append (or put at the front)."""
    pid = prompt_id or str(uuid.uuid4())
    valid = await execution.validate_prompt(pid, prompt, None)
    if not valid[0]:
        err = valid[1] or {}
        return None, err.get("message", "invalid prompt") + (": " + err.get("details") if err.get("details") else "")
    return enqueue(prompt, extra, valid[2], front, pid), None


def park(prompt_ids, note=""):
    ids = set(prompt_ids)
    items = [it for it in ordered_queue() if it[1] in ids]
    for it in items:
        store.add_parked(it[1], time.time(), note, summarize(it[2], it[3]), it[2], it[3], it[4])
    delete(ids)
    return len(items)


def unpark(prompt_ids, front=False, client_id=None):
    items = store.parked_items(prompt_ids)
    for pid, prompt, extra, outputs in (reversed(items) if front else items):
        if client_id:
            extra["client_id"] = client_id
        enqueue(prompt, extra, outputs, front)
    store.delete_parked([i[0] for i in items])
    return len(items)


# ── saving / loading ─────────────────────────────────────────────
def snapshot(include_running=True):
    items = []
    if include_running:
        for it in running_items():
            items.append({"prompt_id": it[1], "prompt": it[2], "extra_data": it[3], "outputs_to_execute": it[4], "was_running": True})
    for it in ordered_queue():
        items.append({"prompt_id": it[1], "prompt": it[2], "extra_data": it[3], "outputs_to_execute": it[4]})
    return {"version": 1, "app": "ComfyUI-QueueControlMax", "saved_at": int(time.time() * 1000), "item_count": len(items), "items": items}


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def safe_name(name):
    name = re.sub(r"[^\w\- .()\[\]]+", "_", str(name)).strip(" .")
    return name[:80] or "queue"


def save_named(name, include_running=False):
    data = snapshot(include_running)
    data["name"] = name
    write_json(os.path.join(SAVES_DIR, safe_name(name) + ".json"), data)
    return data["item_count"]


def list_saves():
    out = []
    if os.path.isdir(SAVES_DIR):
        for fn in sorted(os.listdir(SAVES_DIR)):
            if fn.endswith(".json"):
                try:
                    with open(os.path.join(SAVES_DIR, fn), encoding="utf-8") as f:
                        data = json.load(f)
                    out.append({"name": fn[:-5], "count": data.get("item_count", len(data.get("items", []))), "saved_at": data.get("saved_at")})
                except (OSError, ValueError):
                    continue
    return sorted(out, key=lambda s: s["saved_at"] or 0, reverse=True)


def read_save(name):
    with open(os.path.join(SAVES_DIR, safe_name(name) + ".json"), encoding="utf-8") as f:
        return json.load(f)


def delete_save(name):
    path = os.path.join(SAVES_DIR, safe_name(name) + ".json")
    if os.path.exists(path):
        os.remove(path)


async def load_items(items, client_id=None, park_invalid=True):
    """Append saved items to the end of the queue in order. Invalid ones are parked with the reason."""
    added, parked = 0, 0
    for it in items:
        prompt, extra = it.get("prompt") or {}, dict(it.get("extra_data") or {})
        if client_id:
            extra["client_id"] = client_id
        pid, err = await submit(prompt, extra, prompt_id=it.get("prompt_id") if not find_item(it.get("prompt_id")) else None)
        if pid:
            added += 1
        elif park_invalid:
            store.add_parked(it.get("prompt_id") or str(uuid.uuid4()), time.time(), "Could not be queued: " + err,
                             summarize(prompt, extra), prompt, extra, it.get("outputs_to_execute") or [])
            parked += 1
    return added, parked


# ── autosave / auto-restore ──────────────────────────────────────
def _autosave_loop():
    last = None
    while True:
        time.sleep(2)
        try:
            data = snapshot(include_running=True)
            ids = tuple(i["prompt_id"] for i in data["items"])
            if ids != last:
                write_json(AUTOSAVE, data)
                last = ids
        except Exception:
            log.exception("[QueueControlMax] autosave failed")


async def startup():
    """Restore the queue that was waiting when ComfyUI last stopped, then start autosaving."""
    global _restored
    await asyncio.sleep(2)
    try:
        if os.path.exists(AUTOSAVE):
            with open(AUTOSAVE, encoding="utf-8") as f:
                items = json.load(f).get("items", [])
            if items:
                settings = store.get_settings()
                after_crash = os.environ.get("QCM_RESTARTED_AFTER_CRASH") == "1"
                resume = settings["resume_after_restore"] == "always" or (settings["resume_after_restore"] == "crash" and after_crash)
                set_paused(True)
                added, parked = await load_items(items)
                msg = f"Restored {added} job(s) from the last session."
                if parked:
                    msg += f" {parked} could not be queued and were moved to Parked."
                if resume:
                    set_paused(False)
                    msg += " Queue resumed automatically" + (" after a crash." if after_crash else ".")
                else:
                    msg += " The queue is paused - press Resume to continue."
                notices.append(msg)
                log.info("[QueueControlMax] %s", msg)
    except Exception:
        log.exception("[QueueControlMax] restore failed")
    _restored = True
    threading.Thread(target=_autosave_loop, daemon=True, name="qcm-autosave").start()
