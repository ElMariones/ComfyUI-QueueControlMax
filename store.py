"""SQLite storage: persistent job history, parked jobs and settings.

Lives in <ComfyUI user dir>/queue_control_max/qcm.db. Prompts and workflows are stored zlib-compressed;
the summary columns (model, LoRAs, prompt text...) are plain text so they can be searched.
"""
import json
import os
import sqlite3
import threading
import zlib

import folder_paths

DATA_DIR = os.path.join(folder_paths.get_user_directory(), "queue_control_max")
DB_PATH = os.path.join(DATA_DIR, "qcm.db")

SUMMARY_COLS = ("workflow_name", "model", "loras", "positive", "negative", "settings", "size")

SCHEMA = """
CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    queued_at REAL,
    finished_at REAL,
    duration REAL,
    status TEXT,
    workflow_name TEXT, model TEXT, loras TEXT, positive TEXT, negative TEXT, settings TEXT, size TEXT,
    outputs TEXT,
    starred INTEGER DEFAULT 0,
    source TEXT DEFAULT 'run',
    prompt BLOB,
    workflow BLOB
);
CREATE INDEX IF NOT EXISTS history_finished ON history(finished_at);
CREATE TABLE IF NOT EXISTS parked (
    id TEXT PRIMARY KEY,
    parked_at REAL,
    note TEXT,
    workflow_name TEXT, model TEXT, loras TEXT, positive TEXT, negative TEXT, settings TEXT, size TEXT,
    prompt BLOB,
    extra BLOB,
    outputs_to_execute TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
"""

_lock = threading.RLock()
_conn = None


def pack(obj):
    return zlib.compress(json.dumps(obj).encode("utf-8"), 6) if obj is not None else None


def unpack(blob):
    return json.loads(zlib.decompress(blob)) if blob else None


def _db():
    global _conn
    if _conn is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(SCHEMA)
    return _conn


def execute(sql, params=()):
    with _lock:
        db = _db()
        cur = db.execute(sql, params)
        db.commit()
        return cur.rowcount


def executemany(sql, rows):
    with _lock:
        db = _db()
        db.executemany(sql, rows)
        db.commit()


def query(sql, params=()):
    with _lock:
        return [dict(r) for r in _db().execute(sql, params).fetchall()]


# ── settings ─────────────────────────────────────────────────────
DEFAULT_SETTINGS = {"resume_after_restore": "crash"}  # crash | always | never


def get_settings():
    out = dict(DEFAULT_SETTINGS)
    for row in query("SELECT key, value FROM settings"):
        out[row["key"]] = json.loads(row["value"])
    return out


def set_setting(key, value):
    execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, json.dumps(value)))


# ── history ──────────────────────────────────────────────────────
HISTORY_INSERT = ("INSERT OR REPLACE INTO history (id, queued_at, finished_at, duration, status, workflow_name, model, loras, positive, "
                  "negative, settings, size, outputs, starred, source, prompt, workflow) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")


def history_row(id, queued_at, finished_at, duration, status, summary, outputs, source, prompt, workflow):
    return (id, queued_at, finished_at, duration, status, summary["workflow_name"], summary["model"], json.dumps(summary["loras"]),
            summary["positive"], summary["negative"], summary["settings"], summary["size"], json.dumps(outputs), 0, source,
            pack(prompt), pack(workflow))


def add_history(row):
    execute(HISTORY_INSERT, row)


def add_history_many(rows):
    executemany(HISTORY_INSERT, rows)


def _decode(row):
    row["loras"] = json.loads(row["loras"] or "[]")
    if "outputs" in row:
        row["outputs"] = json.loads(row["outputs"] or "[]")
    row["starred"] = bool(row.get("starred"))
    return row


def list_history(offset=0, limit=50, search="", status="", starred=False):
    where, params = [], []
    for word in search.lower().split():
        where.append("(lower(positive) LIKE ? OR lower(model) LIKE ? OR lower(loras) LIKE ? OR lower(workflow_name) LIKE ?)")
        params += [f"%{word}%"] * 4
    if status == "done":
        where.append("status = 'success'")
    elif status == "failed":
        where.append("status != 'success'")
    if starred:
        where.append("starred = 1")
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    total = query(f"SELECT count(*) AS n FROM history {clause}", params)[0]["n"]
    cols = "id, queued_at, finished_at, duration, status, " + ", ".join(SUMMARY_COLS) + ", outputs, starred, source"
    rows = query(f"SELECT {cols} FROM history {clause} ORDER BY finished_at DESC LIMIT ? OFFSET ?", params + [limit, offset])
    return total, [_decode(r) for r in rows]


def history_blobs(id):
    rows = query("SELECT prompt, workflow FROM history WHERE id = ?", (id,))
    return (unpack(rows[0]["prompt"]), unpack(rows[0]["workflow"])) if rows else (None, None)


def history_output_keys():
    keys = set()
    for row in query("SELECT outputs FROM history"):
        for o in json.loads(row["outputs"] or "[]"):
            keys.add((o.get("type", "output"), o.get("subfolder", ""), o.get("filename")))
    return keys


def history_ids(prefix):
    return {r["id"] for r in query("SELECT id FROM history WHERE id LIKE ?", (prefix + "%",))}


def delete_history(ids):
    with _lock:
        db = _db()
        db.executemany("DELETE FROM history WHERE id = ?", [(i,) for i in ids])
        db.commit()


def clear_history(keep_starred=True):
    execute("DELETE FROM history" + (" WHERE starred = 0" if keep_starred else ""))


def star_history(id, starred):
    execute("UPDATE history SET starred = ? WHERE id = ?", (1 if starred else 0, id))


# ── parked jobs ──────────────────────────────────────────────────
def add_parked(id, parked_at, note, summary, prompt, extra, outputs_to_execute):
    execute("INSERT OR REPLACE INTO parked (id, parked_at, note, " + ", ".join(SUMMARY_COLS) + ", prompt, extra, outputs_to_execute) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (id, parked_at, note, summary["workflow_name"], summary["model"], json.dumps(summary["loras"]), summary["positive"],
             summary["negative"], summary["settings"], summary["size"], pack(prompt), pack(extra), json.dumps(outputs_to_execute)))


def list_parked():
    rows = query("SELECT id, parked_at, note, " + ", ".join(SUMMARY_COLS) + " FROM parked ORDER BY parked_at")
    return [_decode(r) for r in rows]


def parked_items(ids):
    marks = ",".join("?" * len(ids))
    rows = query(f"SELECT id, prompt, extra, outputs_to_execute FROM parked WHERE id IN ({marks}) ORDER BY parked_at", list(ids))
    return [(r["id"], unpack(r["prompt"]), unpack(r["extra"]) or {}, json.loads(r["outputs_to_execute"] or "[]")) for r in rows]


def delete_parked(ids):
    with _lock:
        db = _db()
        db.executemany("DELETE FROM parked WHERE id = ?", [(i,) for i in ids])
        db.commit()


def parked_count():
    return query("SELECT count(*) AS n FROM parked")[0]["n"]
