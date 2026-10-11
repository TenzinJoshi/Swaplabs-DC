#!/usr/bin/env python3
"""Serve SwapLabs locally with SQL-backed browser state.

The pages keep their existing local API behaviour in JavaScript, while this
small server gives that local mode a durable SQLite file on the computer's
SSD. The hosted Worker is never contacted unless an explicit remote-proxy
flag is supplied.
"""

from __future__ import annotations

import http.server
import json
import os
import re
import sqlite3
import ssl
import threading
import urllib.error
import urllib.request
from urllib.parse import unquote, urlsplit
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
# PostgreSQL is already listening on port 8000 on this machine, so the local
# web server defaults to the existing SwapLabs preview port instead.
PORT = int(os.environ.get("relayskills_PORT", os.environ.get("RELAYSKILLS_PORT", "8765")))
LOCAL_DB_PATH = Path(os.environ.get(
    "RELAYSKILLS_LOCAL_DB_PATH",
    str(ROOT / "data" / "relayskills-local.sqlite3"),
)).expanduser().resolve()
PUBLIC_ORIGIN = os.environ.get("relayskills_PUBLIC_ORIGIN", os.environ.get("RELAYSKILLS_PUBLIC_ORIGIN", "")).strip()
REMOTE_PROXY_ENABLED = os.environ.get("RELAYSKILLS_USE_REMOTE_API", "").lower() in {"1", "true", "yes", "on"}
STATE_KEY = "browser-app"
MAX_STATE_BYTES = 100 * 1024 * 1024
DB_LOCK = threading.RLock()
LOCAL_SCHEMA_VERSION = "5"

# The browser adapter still sends one state object so the existing local API
# contract stays unchanged. SQLite stores that object in these named,
# collection-specific tables instead of one opaque JSON blob.
LIST_COLLECTIONS = (
    "users",
    "notifications",
    "conversations",
    "messages",
    "events",
    "workshops",
    "workshop_registrations",
    "courses",
    "contact_messages",
    "complaints",
    "posts",
    "stories",
    "blogs",
    "blog_comments",
    "groups",
    "ideas",
    "journals",
    "ledger",
    "disputes",
    "vouchers",
    "livestreams",
    "swapjobs",
    "follows",
    "feedback",
    "session_ratings",
    "session_point_reviews",
    "session_progress_reports",
    "study_invitations",
    "study_rooms",
    "study_sessions",
    "study_messages",
    "study_favorites",
    "study_reports",
    "adminMessages",
    "reports",
)
DICT_COLLECTIONS = (
    "portfolios",
    "achievements",
    "roadmapVotes",
    "onboarding",
    "study_profiles",
    "study_availability",
)
NORMALIZED_COLLECTIONS = LIST_COLLECTIONS + DICT_COLLECTIONS
TABLE_NAMES = {
    collection: "data_" + re.sub(r"(?<!^)(?=[A-Z])", "_", collection).lower()
    for collection in NORMALIZED_COLLECTIONS
}
BACKUP_TABLE = "app_state_legacy_backup"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_schema(connection: sqlite3.Connection) -> None:
    """Create the local storage layout without changing application data."""
    connection.execute(
        "CREATE TABLE IF NOT EXISTS schema_meta ("
        "meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL, updated_at TEXT NOT NULL"
        ")"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS app_kv ("
        "namespace TEXT NOT NULL, item_key TEXT NOT NULL, value_json TEXT NOT NULL, "
        "updated_at TEXT NOT NULL, PRIMARY KEY(namespace, item_key)"
        ")"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_kv_namespace_updated "
        "ON app_kv(namespace, updated_at)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS migration_log ("
        "migration_id INTEGER PRIMARY KEY AUTOINCREMENT, from_schema TEXT NOT NULL, "
        "to_schema TEXT NOT NULL, migrated_at TEXT NOT NULL, records_migrated INTEGER NOT NULL, "
        "notes TEXT NOT NULL"
        ")"
    )
    connection.execute(
        f"CREATE TABLE IF NOT EXISTS {BACKUP_TABLE} ("
        "backup_id INTEGER PRIMARY KEY AUTOINCREMENT, state_key TEXT NOT NULL, "
        "state_json TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL"
        ")"
    )
    connection.execute(
        f"CREATE INDEX IF NOT EXISTS idx_{BACKUP_TABLE}_created "
        f"ON {BACKUP_TABLE}(created_at)"
    )
    for table_name in TABLE_NAMES.values():
        connection.execute(
            f"CREATE TABLE IF NOT EXISTS {table_name} ("
            "record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at TEXT NOT NULL"
            ")"
        )
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{table_name}_updated "
            f"ON {table_name}(updated_at)"
        )
    _set_schema_value(connection, "schema_version", LOCAL_SCHEMA_VERSION, _utc_now())
    connection.commit()


def _connect_db() -> sqlite3.Connection:
    LOCAL_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(LOCAL_DB_PATH), timeout=30)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    _ensure_schema(connection)
    return connection


def _schema_value(connection: sqlite3.Connection, meta_key: str):
    row = connection.execute(
        "SELECT meta_value FROM schema_meta WHERE meta_key = ?", (meta_key,)
    ).fetchone()
    return row[0] if row else None


def _set_schema_value(connection: sqlite3.Connection, meta_key: str, meta_value, updated_at: str) -> None:
    connection.execute(
        "INSERT INTO schema_meta(meta_key, meta_value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, "
        "updated_at = excluded.updated_at",
        (meta_key, str(meta_value), updated_at),
    )


def _legacy_state(connection: sqlite3.Connection):
    try:
        row = connection.execute(
            "SELECT state_json FROM app_state WHERE state_key = ?", (STATE_KEY,)
        ).fetchone()
    except sqlite3.OperationalError:
        return None
    return json.loads(row[0]) if row else None


def _record_id(item, index: int) -> str:
    if isinstance(item, dict):
        for field in ("id", "key", "slug", "username"):
            value = item.get(field)
            if value not in (None, ""):
                return str(value)
    return f"row-{index:08d}"


def _unique_record_id(candidate: str, used: set[str]) -> str:
    record_id = candidate
    suffix = 2
    while record_id in used:
        record_id = f"{candidate}-{suffix}"
        suffix += 1
    used.add(record_id)
    return record_id


def _clear_normalized_records(connection: sqlite3.Connection) -> None:
    for table_name in TABLE_NAMES.values():
        connection.execute(f"DELETE FROM {table_name}")
    connection.execute("DELETE FROM app_kv WHERE namespace = 'state'")


def _populate_normalized_records(connection: sqlite3.Connection, state: dict, updated_at: str) -> int:
    """Write the state into named tables while preserving its JSON value shape."""
    _clear_normalized_records(connection)
    record_count = 0
    known_collections = set(NORMALIZED_COLLECTIONS)

    for collection in LIST_COLLECTIONS:
        value = state.get(collection)
        if not isinstance(value, list):
            continue
        table_name = TABLE_NAMES[collection]
        used_ids = set()
        rows = []
        for index, item in enumerate(value):
            record_id = _unique_record_id(_record_id(item, index), used_ids)
            rows.append((record_id, json.dumps(item, ensure_ascii=False, separators=(",", ":")), updated_at))
        if rows:
            connection.executemany(
                f"INSERT INTO {table_name}(record_id, record_json, updated_at) VALUES (?, ?, ?)",
                rows,
            )
            record_count += len(rows)

    for collection in DICT_COLLECTIONS:
        value = state.get(collection)
        if not isinstance(value, dict):
            continue
        table_name = TABLE_NAMES[collection]
        rows = [
            (str(key), json.dumps(item, ensure_ascii=False, separators=(",", ":")), updated_at)
            for key, item in value.items()
        ]
        if rows:
            connection.executemany(
                f"INSERT INTO {table_name}(record_id, record_json, updated_at) VALUES (?, ?, ?)",
                rows,
            )
            record_count += len(rows)

    # Scalars and future collections that are not yet promoted to their own
    # table remain queryable in one small, namespaced key/value table.
    kv_rows = []
    for key, value in state.items():
        if key in known_collections:
            if key in LIST_COLLECTIONS and isinstance(value, list):
                continue
            if key in DICT_COLLECTIONS and isinstance(value, dict):
                continue
        kv_rows.append(("state", str(key), json.dumps(value, ensure_ascii=False, separators=(",", ":")), updated_at))
    if kv_rows:
        connection.executemany(
            "INSERT INTO app_kv(namespace, item_key, value_json, updated_at) VALUES (?, ?, ?, ?)",
            kv_rows,
        )
        record_count += len(kv_rows)

    _set_schema_value(connection, "schema_version", LOCAL_SCHEMA_VERSION, updated_at)
    _set_schema_value(connection, "state_initialized", "1", updated_at)
    _set_schema_value(connection, "last_write_at", updated_at, updated_at)
    _set_schema_value(connection, "last_record_count", record_count, updated_at)
    return record_count


def _migrate_legacy_if_needed(connection: sqlite3.Connection) -> bool:
    if _schema_value(connection, "state_initialized") == "1":
        return False
    legacy = _legacy_state(connection)
    if legacy is None:
        return False

    updated_at = _utc_now()
    encoded = json.dumps(legacy, ensure_ascii=False, separators=(",", ":"))
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            f"INSERT INTO {BACKUP_TABLE}(state_key, state_json, created_at, reason) VALUES (?, ?, ?, ?)",
            (STATE_KEY, encoded, updated_at, "Pre-normalization SQLite state backup"),
        )
        record_count = _populate_normalized_records(connection, legacy, updated_at)
        connection.execute(
            "INSERT INTO migration_log(from_schema, to_schema, migrated_at, records_migrated, notes) "
            "VALUES (?, ?, ?, ?, ?)",
            ("app_state-json", LOCAL_SCHEMA_VERSION, updated_at, record_count, "Migrated browser-app into named collection tables"),
        )
        # The original row is now safely retained in app_state_legacy_backup.
        connection.execute("DROP TABLE IF EXISTS app_state")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    return True


def _read_normalized_state(connection: sqlite3.Connection):
    if _schema_value(connection, "state_initialized") != "1":
        return None
    state = {}
    for collection in LIST_COLLECTIONS:
        rows = connection.execute(
            f"SELECT record_json FROM {TABLE_NAMES[collection]} ORDER BY rowid"
        ).fetchall()
        state[collection] = [json.loads(row[0]) for row in rows]
    for collection in DICT_COLLECTIONS:
        rows = connection.execute(
            f"SELECT record_id, record_json FROM {TABLE_NAMES[collection]} ORDER BY rowid"
        ).fetchall()
        state[collection] = {record_id: json.loads(record_json) for record_id, record_json in rows}
    rows = connection.execute(
        "SELECT item_key, value_json FROM app_kv WHERE namespace = 'state' ORDER BY item_key"
    ).fetchall()
    for item_key, value_json in rows:
        state[item_key] = json.loads(value_json)
    return state


def _read_state():
    with DB_LOCK:
        connection = _connect_db()
        try:
            _migrate_legacy_if_needed(connection)
            normalized = _read_normalized_state(connection)
            if normalized is not None:
                return normalized
            return _legacy_state(connection)
        finally:
            connection.close()


def _write_state(state) -> None:
    encoded = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_STATE_BYTES:
        raise ValueError("Local app data is larger than the 100 MB local limit.")
    with DB_LOCK:
        connection = _connect_db()
        try:
            _migrate_legacy_if_needed(connection)
            updated_at = _utc_now()
            connection.execute("BEGIN IMMEDIATE")
            try:
                _populate_normalized_records(connection, state, updated_at)
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        finally:
            connection.close()


def _clear_state() -> None:
    with DB_LOCK:
        connection = _connect_db()
        try:
            connection.execute("BEGIN IMMEDIATE")
            try:
                _clear_normalized_records(connection)
                updated_at = _utc_now()
                _set_schema_value(connection, "state_initialized", "0", updated_at)
                _set_schema_value(connection, "last_clear_at", updated_at, updated_at)
                try:
                    connection.execute("DELETE FROM app_state")
                except sqlite3.OperationalError:
                    pass
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        finally:
            connection.close()


class SwapLabsHandler(http.server.SimpleHTTPRequestHandler):
    server_version = "SwapLabsLocal/2.0"
    local_api_script = b'<script src="scripts/relayskills-local-api.js?v=20261004-credit-policy1"></script>'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > MAX_STATE_BYTES:
            raise ValueError("Local app data is larger than the 100 MB local limit.")
        raw = self.rfile.read(length) if length else b"{}"
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("Local state must be a JSON object.")
        return parsed

    def _local_state(self):
        try:
            self._send_json({"ok": True, "storage": "sqlite", "state": _read_state()})
        except (OSError, sqlite3.Error, ValueError, json.JSONDecodeError) as error:
            self._send_json({"ok": False, "error": f"Local SQL storage is unavailable: {error}"}, 503)

    def _save_local_state(self):
        try:
            payload = self._read_json()
            state = payload.get("state")
            if not isinstance(state, dict):
                raise ValueError("Local state must be a JSON object.")
            _write_state(state)
            self._send_json({"ok": True, "storage": "sqlite"})
        except (OSError, sqlite3.Error, ValueError, json.JSONDecodeError) as error:
            self._send_json({"ok": False, "error": f"Local SQL storage could not save: {error}"}, 400)

    def _delete_local_state(self):
        try:
            _clear_state()
            self._send_json({"ok": True, "storage": "sqlite"})
        except (OSError, sqlite3.Error) as error:
            self._send_json({"ok": False, "error": f"Local SQL storage could not reset: {error}"}, 503)

    def _proxy_api(self) -> None:
        if not REMOTE_PROXY_ENABLED or not PUBLIC_ORIGIN:
            self._send_json({"ok": False, "error": "Local API mode is active; no remote API proxy is configured."}, 404)
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length else None
        headers = {}
        for key, value in self.headers.items():
            if key.lower() in {"host", "origin", "referer", "content-length", "accept-encoding"}:
                continue
            headers[key] = value
        request = urllib.request.Request(
            PUBLIC_ORIGIN.rstrip("/") + self.path,
            data=body,
            headers=headers,
            method=self.command,
        )
        try:
            response = urllib.request.urlopen(request, timeout=30, context=ssl._create_unverified_context())
            status = response.status
            response_headers = response.headers
            payload = response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            response_headers = error.headers
            payload = error.read()
        except urllib.error.URLError as error:
            status = 502
            response_headers = {"Content-Type": "application/json; charset=utf-8"}
            payload = ('{"error":"Local API proxy could not reach the hosted relayskills service: %s"}' % error.reason).encode()

        self.send_response(status)
        forwarded = {"content-type", "cache-control", "etag", "last-modified"}
        for key in forwarded:
            value = response_headers.get(key)
            if value:
                self.send_header(key, value)
        cookies = response_headers.get_all("Set-Cookie", []) if hasattr(response_headers, "get_all") else []
        for cookie in cookies or []:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _serve_local_html(self):
        """Serve local pages with the browser-backed local API adapter enabled."""
        relative_path = unquote(urlsplit(self.path).path).lstrip("/") or "index.html"
        file_path = (ROOT / relative_path).resolve()
        try:
            file_path.relative_to(ROOT)
        except ValueError:
            self.send_error(404, "File not found")
            return
        if file_path.suffix.lower() != ".html" or not file_path.is_file():
            super().do_GET()
            return
        body = file_path.read_bytes()
        marker = b"</head>"
        if marker in body and self.local_api_script not in body:
            body = body.replace(marker, b"\n    " + self.local_api_script + b"\n  " + marker, 1)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/__local-state":
            self._local_state()
        elif self.path == "/__local-state/status":
            try:
                with DB_LOCK:
                    connection = _connect_db()
                    try:
                        _migrate_legacy_if_needed(connection)
                        table_count = connection.execute(
                            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'data_%'"
                        ).fetchone()[0]
                        backup_count = connection.execute(
                            f"SELECT COUNT(*) FROM {BACKUP_TABLE}"
                        ).fetchone()[0]
                        status = {
                            "ok": True,
                            "storage": "sqlite",
                            "database": str(LOCAL_DB_PATH.name),
                            "schemaVersion": _schema_value(connection, "schema_version") or LOCAL_SCHEMA_VERSION,
                            "normalized": _schema_value(connection, "state_initialized") == "1",
                            "collectionTables": table_count,
                            "legacyBackups": backup_count,
                        }
                    finally:
                        connection.close()
                self._send_json(status)
            except (OSError, sqlite3.Error, ValueError, json.JSONDecodeError) as error:
                self._send_json({"ok": False, "error": f"Local SQL storage status unavailable: {error}"}, 503)
        elif self.path.startswith("/api/"):
            self._proxy_api()
        else:
            self._serve_local_html()

    def do_PUT(self):  # noqa: N802
        if self.path == "/__local-state":
            self._save_local_state()
        elif self.path.startswith("/api/"):
            self._proxy_api()
        else:
            self.send_error(405, "PUT is only supported for local state or API routes")

    def do_DELETE(self):  # noqa: N802
        if self.path == "/__local-state":
            self._delete_local_state()
        elif self.path.startswith("/api/"):
            self._proxy_api()
        else:
            self.send_error(405, "DELETE is only supported for local state or API routes")

    def do_POST(self):  # noqa: N802
        if self.path.startswith("/api/"):
            self._proxy_api()
        else:
            self.send_error(405, "POST is only supported for API routes")

    def do_PATCH(self):  # noqa: N802
        if self.path.startswith("/api/"):
            self._proxy_api()
        else:
            self.send_error(405, "PATCH is only supported for API routes")

if __name__ == "__main__":
    connection = _connect_db()
    try:
        migrated = _migrate_legacy_if_needed(connection)
    finally:
        connection.close()
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), SwapLabsHandler)
    print(f"SwapLabs local server: http://localhost:{PORT}/index.html")
    print(f"Local SQL file: {LOCAL_DB_PATH}")
    if migrated:
        print("Migrated the legacy JSON state into normalized SQLite collection tables")
    print("Remote API proxy: enabled" if REMOTE_PROXY_ENABLED and PUBLIC_ORIGIN else "Remote API proxy: disabled")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
