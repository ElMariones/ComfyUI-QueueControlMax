"""Thumbnails, "show in folder", and importing images that already exist in the output folder into the history."""
import hashlib
import json
import logging
import os
import subprocess
import sys
import threading

import folder_paths
from PIL import Image

from . import store
from .summary import summarize

log = logging.getLogger("QueueControlMax")
THUMB_DIR = os.path.join(store.DATA_DIR, "thumbs")
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
import_state = {"running": False, "done": 0, "total": 0, "added": 0}


def resolve(filename, subfolder="", type_="output"):
    """Absolute path of an output/input/temp file, or None if it would escape that folder."""
    base = folder_paths.get_directory_by_type(type_ or "output")
    if base is None or not filename:
        return None
    base = os.path.abspath(base)
    full = os.path.abspath(os.path.join(base, subfolder or "", filename))
    if os.path.commonpath([full, base]) != base or not os.path.isfile(full):
        return None
    return full


def thumbnail(path, size=320):
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_mtime_ns}|{size}".encode()).hexdigest()
    out = os.path.join(THUMB_DIR, key[:2], key + ".webp")
    if not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with Image.open(path) as im:
            im.thumbnail((size, size))
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
            im.save(out, "WEBP", quality=82)
    return out


def reveal(path):
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path])
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(path)])


def _png_meta(path):
    with Image.open(path) as im:
        info = im.info
        prompt, workflow = info.get("prompt"), info.get("workflow")
    return (json.loads(prompt) if prompt else None), (json.loads(workflow) if workflow else None)


def _import_outputs():
    base = os.path.abspath(folder_paths.get_output_directory())
    files = []
    for root, _dirs, names in os.walk(base):
        for n in names:
            if os.path.splitext(n)[1].lower() in IMAGE_EXT:
                p = os.path.join(root, n)
                files.append((os.path.getmtime(p), p))
    files.sort()
    known = store.history_output_keys()
    import_state.update(running=True, done=0, total=len(files), added=0)
    rows, group = [], None

    def flush():
        if group:
            prompt, workflow, mtime, outs = group
            rows.append(store.history_row("file:" + outs[0]["subfolder"] + "/" + outs[0]["filename"], mtime, mtime, None, "success",
                                          summarize(prompt), outs, "imported", prompt, workflow))

    for mtime, path in files:
        import_state["done"] += 1
        rel = os.path.relpath(path, base)
        sub, name = os.path.dirname(rel).replace("\\", "/"), os.path.basename(rel)
        if ("output", sub, name) in known:
            continue
        try:
            prompt, workflow = _png_meta(path) if path.lower().endswith(".png") else (None, None)
        except Exception:
            prompt, workflow = None, None
        out = {"filename": name, "subfolder": sub, "type": "output"}
        # images of one batch share the prompt and are written within seconds of each other
        if group and prompt is not None and group[0] == prompt and mtime - group[2] < 60:
            group[3].append(out)
            continue
        flush()
        group = (prompt, workflow, mtime, [out])
        if len(rows) >= 200:
            store.add_history_many(rows)
            import_state["added"] += len(rows)
            rows.clear()
    flush()
    store.add_history_many(rows)
    import_state["added"] += len(rows)
    import_state["running"] = False
    log.info("[QueueControlMax] imported %d history entries from %d output files", import_state["added"], len(files))


def _run_import():
    try:
        _import_outputs()
    except Exception:
        log.exception("[QueueControlMax] importing past images failed")
    finally:
        import_state["running"] = False


def start_import():
    if import_state["running"]:
        return False
    import_state["running"] = True
    threading.Thread(target=_run_import, daemon=True, name="qcm-import").start()
    return True
