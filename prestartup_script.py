"""One-time migration from ComfyUI-QueueControl (runs before any custom node is loaded).

Both extensions take over the same queue internals, so they cannot run together. If QueueControl is installed and
enabled, this copies its auto-backup (the queue waiting when ComfyUI last stopped) and its saved queue into
QueueControlMax, then disables QueueControl by renaming its folder to "<name>.disabled" (rename it back to undo).
Set the environment variable QCM_NO_MIGRATE=1 to skip this.
"""
import json
import logging
import os
import time

import folder_paths

DATA_DIR = os.path.join(folder_paths.get_user_directory(), "queue_control_max")
HERE = os.path.dirname(os.path.realpath(__file__))


def _qc_items(data):
    items = data.get("items", [])
    # QueueControl kept priorities; run what was running first, then by priority, then by submit time
    items.sort(key=lambda i: (not i.get("was_running"), i.get("priority", 5) if i.get("priority", 5) >= 0 else 0,
                              (i.get("extra_data") or {}).get("create_time", 0)))
    return [{"prompt_id": i.get("prompt_id"), "prompt": i.get("prompt"), "extra_data": i.get("extra_data") or {},
             "outputs_to_execute": i.get("outputs_to_execute") or []} for i in items]


def _write(path, items, name):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "app": "ComfyUI-QueueControlMax", "name": name, "saved_at": int(time.time() * 1000),
                   "item_count": len(items), "items": items}, f)


def migrate():
    for custom_nodes in folder_paths.get_folder_paths("custom_nodes"):
        for entry in os.listdir(custom_nodes):
            path = os.path.join(custom_nodes, entry)
            low = entry.lower()
            if "queuecontrol" not in low or "max" in low or low.endswith(".disabled") or os.path.realpath(path) == HERE:
                continue
            if not os.path.isfile(os.path.join(path, "__init__.py")):
                continue
            backup, saved = os.path.join(path, "auto_backup.json"), os.path.join(path, "saved_queue.json")
            autosave = os.path.join(DATA_DIR, "autosave.json")
            if os.path.exists(backup) and not os.path.exists(autosave):
                with open(backup, encoding="utf-8") as f:
                    _write(autosave, _qc_items(json.load(f)), "autosave")
            if os.path.exists(saved):
                with open(saved, encoding="utf-8") as f:
                    _write(os.path.join(DATA_DIR, "saves", "Imported from QueueControl.json"), _qc_items(json.load(f)), "Imported from QueueControl")
            os.rename(path, path + ".disabled")
            logging.warning("[QueueControlMax] Took over from %s: imported its queue and disabled it (renamed to %s.disabled). "
                            "Rename it back to undo.", entry, entry)


if os.environ.get("QCM_NO_MIGRATE") != "1":
    try:
        migrate()
    except Exception:
        logging.exception("[QueueControlMax] migration from QueueControl failed")
