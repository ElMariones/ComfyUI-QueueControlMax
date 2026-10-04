"""ComfyUI-QueueControlMax - one queue manager for ComfyUI.

FIFO queue with pause / resume and manual reordering, parked jobs, autosave + auto-restore (+ auto-resume after a
crash), named saves, export / import, and a persistent searchable history of every job with its images, prompt,
model and LoRAs and a one-click "open workflow". UI: a panel docked on the right side of ComfyUI.
"""
import json
import logging
import time

from aiohttp import web
from server import PromptServer

from . import media, queue_ctl, store
from .summary import summarize

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

log = logging.getLogger("QueueControlMax")
routes = PromptServer.instance.routes


def queue_entry(item, running=False):
    s = summarize(item[2], item[3])
    return {"id": item[1], "number": item[0], "front": item[0] < 0, "running": running,
            "create_time": item[3].get("create_time"), "has_workflow": bool((item[3].get("extra_pnginfo") or {}).get("workflow")), **s}


async def body(request):
    try:
        return await request.json()
    except ValueError:
        return {}


# ── queue ────────────────────────────────────────────────────────
@routes.get("/qcm/queue")
async def get_queue(request):
    return web.json_response({
        "paused": queue_ctl.is_paused(),
        "running": [queue_entry(it, True) for it in queue_ctl.running_items()],
        "pending": [queue_entry(it) for it in queue_ctl.ordered_queue()],
        "parked": store.parked_count(),
    })


@routes.get("/qcm/status")
async def get_status(request):
    notices, queue_ctl.notices[:] = list(queue_ctl.notices), []
    return web.json_response({"paused": queue_ctl.is_paused(), "notices": notices, "import": media.import_state})


@routes.post("/qcm/pause")
async def post_pause(request):
    data = await body(request)
    queue_ctl.set_paused(data.get("paused", not queue_ctl.is_paused()))
    return web.json_response({"paused": queue_ctl.is_paused()})


@routes.post("/qcm/move")
async def post_move(request):
    data = await body(request)
    return web.json_response({"ok": queue_ctl.move(data.get("id"), data.get("to"))})


@routes.post("/qcm/delete")
async def post_delete(request):
    queue_ctl.delete((await body(request)).get("ids", []))
    return web.json_response({"ok": True})


@routes.post("/qcm/clear")
async def post_clear(request):
    queue_ctl.clear()
    return web.json_response({"ok": True})


@routes.get("/qcm/job/{id}")
async def get_job(request):
    """Prompt + workflow of a queued, parked or finished job."""
    pid = request.match_info["id"]
    item = queue_ctl.find_item(pid)
    if item:
        return web.json_response({"prompt": item[2], "workflow": (item[3].get("extra_pnginfo") or {}).get("workflow")})
    parked = store.parked_items([pid])
    if parked:
        return web.json_response({"prompt": parked[0][1], "workflow": (parked[0][2].get("extra_pnginfo") or {}).get("workflow")})
    prompt, workflow = store.history_blobs(pid)
    if prompt is None and workflow is None:
        return web.json_response({"error": "job not found"}, status=404)
    return web.json_response({"prompt": prompt, "workflow": workflow})


# ── parked ───────────────────────────────────────────────────────
@routes.get("/qcm/parked")
async def get_parked(request):
    return web.json_response(store.list_parked())


@routes.post("/qcm/park")
async def post_park(request):
    return web.json_response({"parked": queue_ctl.park((await body(request)).get("ids", []))})


@routes.post("/qcm/unpark")
async def post_unpark(request):
    data = await body(request)
    return web.json_response({"queued": queue_ctl.unpark(data.get("ids", []), bool(data.get("front")), data.get("client_id"))})


@routes.post("/qcm/parked/delete")
async def post_parked_delete(request):
    store.delete_parked((await body(request)).get("ids", []))
    return web.json_response({"ok": True})


# ── saves / export / import ──────────────────────────────────────
@routes.get("/qcm/saves")
async def get_saves(request):
    return web.json_response(queue_ctl.list_saves())


@routes.post("/qcm/save")
async def post_save(request):
    data = await body(request)
    name = data.get("name") or time.strftime("Queue %Y-%m-%d %H-%M")
    return web.json_response({"name": queue_ctl.safe_name(name), "count": queue_ctl.save_named(name, bool(data.get("include_running")))})


@routes.post("/qcm/load")
async def post_load(request):
    data = await body(request)
    try:
        items = queue_ctl.read_save(data.get("name", "")).get("items", [])
    except (OSError, ValueError) as e:
        return web.json_response({"error": str(e)}, status=404)
    added, parked = await queue_ctl.load_items(items, data.get("client_id"))
    return web.json_response({"added": added, "parked": parked})


@routes.post("/qcm/saves/delete")
async def post_save_delete(request):
    queue_ctl.delete_save((await body(request)).get("name", ""))
    return web.json_response({"ok": True})


@routes.get("/qcm/export")
async def get_export(request):
    data = queue_ctl.snapshot(include_running=request.query.get("running") == "1")
    return web.Response(text=json.dumps(data), content_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="queue-{time.strftime("%Y%m%d-%H%M")}.json"'})


@routes.post("/qcm/import")
async def post_import(request):
    data = await body(request)
    items = (data.get("data") or {}).get("items", [])
    added, parked = await queue_ctl.load_items(items, data.get("client_id"))
    return web.json_response({"added": added, "parked": parked})


# ── history ──────────────────────────────────────────────────────
@routes.get("/qcm/history")
async def get_history(request):
    q = request.query
    total, items = store.list_history(int(q.get("offset", 0)), min(int(q.get("limit", 50)), 200), q.get("search", ""),
                                      q.get("status", ""), q.get("starred") == "1")
    return web.json_response({"total": total, "items": items})


@routes.post("/qcm/history/delete")
async def post_history_delete(request):
    store.delete_history((await body(request)).get("ids", []))
    return web.json_response({"ok": True})


@routes.post("/qcm/history/clear")
async def post_history_clear(request):
    store.clear_history(bool((await body(request)).get("keep_starred", True)))
    return web.json_response({"ok": True})


@routes.post("/qcm/history/star")
async def post_history_star(request):
    data = await body(request)
    store.star_history(data.get("id"), data.get("starred"))
    return web.json_response({"ok": True})


@routes.post("/qcm/history/requeue")
async def post_history_requeue(request):
    data = await body(request)
    prompt, workflow = store.history_blobs(data.get("id"))
    if prompt is None:
        return web.json_response({"error": "This entry has no saved prompt."}, status=404)
    extra = {"extra_pnginfo": {"workflow": workflow}} if workflow else {}
    if data.get("client_id"):
        extra["client_id"] = data["client_id"]
    pid, err = await queue_ctl.submit(prompt, extra, bool(data.get("front")))
    return web.json_response({"id": pid, "error": err}, status=200 if pid else 400)


@routes.post("/qcm/history/import_outputs")
async def post_import_outputs(request):
    return web.json_response({"started": media.start_import(), "state": media.import_state})


# ── media ────────────────────────────────────────────────────────
@routes.get("/qcm/thumb")
async def get_thumb(request):
    q = request.query
    path = media.resolve(q.get("filename"), q.get("subfolder", ""), q.get("type", "output"))
    if not path:
        return web.Response(status=404)
    try:
        thumb = media.thumbnail(path, min(int(q.get("size", 320)), 1024))
    except Exception:
        return web.Response(status=415)
    return web.FileResponse(thumb, headers={"Cache-Control": "max-age=31536000"})


@routes.post("/qcm/reveal")
async def post_reveal(request):
    data = await body(request)
    path = media.resolve(data.get("filename"), data.get("subfolder", ""), data.get("type", "output"))
    if not path:
        return web.json_response({"error": "file not found"}, status=404)
    media.reveal(path)
    return web.json_response({"ok": True})


# ── settings ─────────────────────────────────────────────────────
@routes.get("/qcm/settings")
async def get_settings(request):
    return web.json_response(store.get_settings())


@routes.post("/qcm/settings")
async def post_settings(request):
    data = await body(request)
    if data.get("resume_after_restore") in ("crash", "always", "never"):
        store.set_setting("resume_after_restore", data["resume_after_restore"])
    return web.json_response(store.get_settings())


queue_ctl.install()
PromptServer.instance.loop.create_task(queue_ctl.startup())
log.info("[QueueControlMax] loaded - data in %s", store.DATA_DIR)
