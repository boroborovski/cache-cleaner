import json
import os
import sqlite3
import subprocess
import uuid
from datetime import datetime
from pathlib import Path
from functools import wraps

from apscheduler.schedulers.background import BackgroundScheduler
from flask import Flask, g, jsonify, render_template, request

app = Flask(__name__)

DATA_DIR  = os.environ.get("DATA_DIR", "/data")
DB_PATH   = os.path.join(DATA_DIR, "cache_cleaner.db")
ADMIN_PIN = os.environ.get("ADMIN_PIN", "")   # empty = no PIN required

os.makedirs(DATA_DIR, exist_ok=True)

scheduler = BackgroundScheduler()
scheduler.start()


# ── Database ──────────────────────────────────────────────────────────

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


@app.teardown_appcontext
def close_db(_):
    db = g.pop("db", None)
    if db:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS hosts (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            hostname     TEXT NOT NULL,
            port         INTEGER NOT NULL DEFAULT 22,
            username     TEXT NOT NULL,
            ssh_key      TEXT NOT NULL DEFAULT '/root/.ssh/id_ed25519',
            grp          TEXT NOT NULL DEFAULT '',
            remote_paths TEXT NOT NULL,
            schedule     TEXT,
            keep_last    INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS clear_history (
            id            TEXT PRIMARY KEY,
            host_id       TEXT NOT NULL,
            started_at    TEXT NOT NULL,
            finished_at   TEXT,
            status        TEXT NOT NULL DEFAULT 'running',
            files_deleted INTEGER,
            message       TEXT,
            FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
        );
    """)
    db.close()


# ── Admin PIN guard ───────────────────────────────────────────────────

def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if ADMIN_PIN:
            provided = request.headers.get("X-Admin-Pin", "")
            if provided != ADMIN_PIN:
                return jsonify({"error": "Admin PIN required"}), 403
        return f(*args, **kwargs)
    return decorated


# ── SSH clear engine ──────────────────────────────────────────────────

def run_clear(host_id):
    """SSH into a host and delete all files under each configured path."""
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    host = db.execute("SELECT * FROM hosts WHERE id = ?", (host_id,)).fetchone()
    if not host:
        db.close()
        return

    run_id = str(uuid.uuid4())
    now    = datetime.utcnow().isoformat()
    db.execute(
        "INSERT INTO clear_history (id, host_id, started_at, status) VALUES (?, ?, ?, 'running')",
        (run_id, host_id, now),
    )
    db.commit()

    paths         = json.loads(host["remote_paths"])
    errors        = []
    total_deleted = 0

    ssh_base = [
        "ssh", "-q",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-p", str(host["port"]),
    ]
    if host["ssh_key"]:
        ssh_base += ["-i", host["ssh_key"]]
    ssh_base.append(f"{host['username']}@{host['hostname']}")

    for remote_path in paths:
        remote_path = remote_path.strip()
        if not remote_path:
            continue

        cmd_str = f"sudo find {remote_path} -type f -exec rm -v {{}} \\;"
        cmd = ssh_base + [cmd_str]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
            deleted = len([l for l in result.stdout.splitlines() if l.strip()])
            total_deleted += deleted
            if result.returncode != 0:
                stderr = result.stderr.strip()
                fatal = [l for l in stderr.splitlines()
                         if "No such file" not in l and l.strip()]
                if fatal:
                    errors.append(f"{remote_path}: {chr(10).join(fatal)[:200]}")
        except subprocess.TimeoutExpired:
            errors.append(f"{remote_path}: timed out after 1 hour")
        except Exception as e:
            errors.append(f"{remote_path}: {str(e)[:200]}")

    finished = datetime.utcnow().isoformat()
    if errors:
        db.execute(
            "UPDATE clear_history SET finished_at=?, status='failed', files_deleted=?, message=? WHERE id=?",
            (finished, total_deleted, "\n".join(errors)[:500], run_id),
        )
    else:
        db.execute(
            "UPDATE clear_history SET finished_at=?, status='success', files_deleted=? WHERE id=?",
            (finished, total_deleted, run_id),
        )
    db.commit()

    keep_last = host["keep_last"]
    if keep_last and keep_last > 0:
        db.execute(
            "DELETE FROM clear_history WHERE host_id = ? AND id NOT IN "
            "(SELECT id FROM clear_history WHERE host_id = ? ORDER BY started_at DESC LIMIT ?)",
            (host_id, host_id, keep_last),
        )
        db.commit()

    db.close()


# ── Scheduler helpers ─────────────────────────────────────────────────

def load_schedules():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    hosts = db.execute("SELECT id, schedule FROM hosts WHERE schedule IS NOT NULL AND schedule != ''").fetchall()
    for host in hosts:
        _add_schedule(host["id"], host["schedule"])
    db.close()


def _add_schedule(host_id, cron_expr):
    job_id = f"clear_{host_id}"
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
    try:
        parts = cron_expr.strip().split()
        if len(parts) != 5:
            return
        scheduler.add_job(
            run_clear, "cron", args=[host_id], id=job_id,
            minute=parts[0], hour=parts[1], day=parts[2],
            month=parts[3], day_of_week=parts[4],
        )
    except Exception:
        pass


def _remove_schedule(host_id):
    job_id = f"clear_{host_id}"
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)


# ── API: Admin status ─────────────────────────────────────────────────

@app.route("/api/admin-required", methods=["GET"])
def admin_required():
    return jsonify({"required": bool(ADMIN_PIN)})


# ── API: Hosts ────────────────────────────────────────────────────────

@app.route("/api/hosts", methods=["GET"])
def list_hosts():
    rows = get_db().execute("""
        SELECT h.*,
               ch.status        AS last_status,
               ch.started_at    AS last_run,
               ch.files_deleted AS last_files_deleted
        FROM hosts h
        LEFT JOIN clear_history ch
               ON ch.id = (
                   SELECT id FROM clear_history
                   WHERE host_id = h.id
                   ORDER BY started_at DESC LIMIT 1
               )
        ORDER BY h.name
    """).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/hosts", methods=["POST"])
@require_admin
def create_host():
    data    = request.json
    host_id = str(uuid.uuid4())
    db      = get_db()
    db.execute(
        "INSERT INTO hosts (id, name, hostname, port, username, ssh_key, grp, remote_paths, schedule, keep_last, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (host_id, data["name"], data["hostname"], data.get("port", 22),
         data["username"], data.get("ssh_key") or "/root/.ssh/id_ed25519",
         data.get("grp") or "",
         json.dumps(data["remote_paths"]),
         data.get("schedule") or None, data.get("keep_last", 0),
         datetime.utcnow().isoformat()),
    )
    db.commit()
    if data.get("schedule"):
        _add_schedule(host_id, data["schedule"])
    return jsonify({"id": host_id}), 201


@app.route("/api/hosts/<host_id>", methods=["PUT"])
@require_admin
def update_host(host_id):
    data = request.json
    db   = get_db()
    db.execute(
        "UPDATE hosts SET name=?, hostname=?, port=?, username=?, ssh_key=?, grp=?, remote_paths=?, schedule=?, keep_last=? WHERE id=?",
        (data["name"], data["hostname"], data.get("port", 22),
         data["username"], data.get("ssh_key") or "/root/.ssh/id_ed25519",
         data.get("grp") or "",
         json.dumps(data["remote_paths"]),
         data.get("schedule") or None, data.get("keep_last", 0), host_id),
    )
    db.commit()
    _remove_schedule(host_id)
    if data.get("schedule"):
        _add_schedule(host_id, data["schedule"])
    return jsonify({"ok": True})


@app.route("/api/hosts/<host_id>", methods=["DELETE"])
@require_admin
def delete_host(host_id):
    db = get_db()
    db.execute("DELETE FROM hosts WHERE id = ?", (host_id,))
    db.commit()
    _remove_schedule(host_id)
    return jsonify({"ok": True})


# ── API: Clear operations ─────────────────────────────────────────────

@app.route("/api/test/<host_id>", methods=["POST"])
def test_connection(host_id):
    host = get_db().execute("SELECT * FROM hosts WHERE id = ?", (host_id,)).fetchone()
    if not host:
        return jsonify({"ok": False, "message": "Host not found"}), 404
    cmd = ["ssh", "-q",
           "-o", "BatchMode=yes",
           "-o", "ConnectTimeout=8",
           "-o", "StrictHostKeyChecking=no",
           "-o", "UserKnownHostsFile=/dev/null",
           "-p", str(host["port"]),
    ]
    if host["ssh_key"]:
        cmd += ["-i", host["ssh_key"]]
    cmd += [f"{host['username']}@{host['hostname']}", "echo ok"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=12)
        if result.returncode == 0:
            return jsonify({"ok": True, "message": "Connection successful"})
        msg = result.stderr.strip()[:300] or "Connection refused or auth failed"
        return jsonify({"ok": False, "message": msg})
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "message": "Connection timed out"})
    except Exception as e:
        return jsonify({"ok": False, "message": str(e)[:300]})


@app.route("/api/clear/<host_id>", methods=["POST"])
def trigger_clear(host_id):
    import threading
    t = threading.Thread(target=run_clear, args=(host_id,), daemon=True)
    t.start()
    return jsonify({"ok": True, "message": "Cache clear started"})


@app.route("/api/history", methods=["GET"])
def clear_history():
    host_id = request.args.get("host_id")
    db      = get_db()
    if host_id:
        rows = db.execute(
            "SELECT ch.*, hosts.name as host_name FROM clear_history ch "
            "JOIN hosts ON ch.host_id = hosts.id "
            "WHERE host_id = ? ORDER BY started_at DESC LIMIT 50", (host_id,),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT ch.*, hosts.name as host_name FROM clear_history ch "
            "JOIN hosts ON ch.host_id = hosts.id "
            "ORDER BY started_at DESC LIMIT 100"
        ).fetchall()
    return jsonify([dict(r) for r in rows])


# ── Frontend ──────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ── Startup ───────────────────────────────────────────────────────────

init_db()

# Migrate: add columns to existing databases
_mdb = sqlite3.connect(DB_PATH)
for _sql in [
    "ALTER TABLE hosts ADD COLUMN grp TEXT NOT NULL DEFAULT ''",
]:
    try:
        _mdb.execute(_sql)
        _mdb.commit()
    except sqlite3.OperationalError:
        pass
_mdb.close()

load_schedules()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
