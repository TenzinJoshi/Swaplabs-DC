#!/usr/bin/env python3
"""Generate a one-time, local-only import from the preserved SwapLabs JSON store.

No original file is changed and no existing destination record is overwritten.
Run after the D1 schema migrations, then execute the emitted SQL with Wrangler
--local. The import marker prevents deleted legacy accounts being resurrected
on a later launch. Private chat attachments are listed in a separate manifest
for the local R2 importer. Neither SQL nor the manifest is a public web asset.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMPORT_KEY = "original-swaplabs-v1"


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def build_import(source: Path, output: Path):
    raw = source.read_bytes()
    data = json.loads(raw)
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    fallback_date = data.get("updated_at") or now
    statements = [
        "-- Private local import generated from the immutable original SwapLabs archive.",
        "CREATE TABLE IF NOT EXISTS sl_local_migrations (migration_key TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, imported_at TEXT NOT NULL);",
    ]
    counts = Counter()
    user_ids = {user["id"] for user in data.get("users", [])}
    attachments = []
    guard = " WHERE NOT EXISTS (SELECT 1 FROM sl_local_migrations WHERE migration_key = " + literal(IMPORT_KEY) + ")"

    def insert(table, row):
        columns = ", ".join(row)
        values = ", ".join(literal(value) for value in row.values())
        statements.append(f"INSERT OR IGNORE INTO {table} ({columns}) SELECT {values}{guard};")
        counts[table] += 1

    def app_record(collection, original, owner="", record_id=None):
        record = dict(original)
        key = str(record_id or record.get("id") or record.get("user_id") or "")
        if not key:
            key = "legacy_" + hashlib.sha256(json_text(record).encode()).hexdigest()[:24]
        record["id"] = key
        record["owner_id"] = str(record.get("owner_id") or owner or "")
        record.setdefault("created_at", fallback_date)
        record.setdefault("updated_at", record["created_at"])
        insert("sl_app_records", {
            "collection": collection, "record_id": key, "owner_id": record["owner_id"],
            "record_json": json_text(record), "created_at": record["created_at"], "updated_at": record["updated_at"],
        })

    for user in data.get("users", []):
        profile = dict(user.get("profile") or {})
        created = user.get("created_at") or fallback_date
        insert("sl_users", {
            "id": user["id"], "username": user["username"], "email": user["email"],
            "password_hash": user["password_hash"], "role": user.get("role", "member"),
            "status": user.get("status", "active"), "verified": bool(user.get("verified")),
            "time_credits": user.get("time_credits", 30), "reward_points": user.get("reward_points", 0),
            "profile_json": json_text(profile), "preferences_json": json_text(user.get("preferences") or {}),
            "safety_json": json_text(user.get("safety") or {}), "moderation_label": user.get("moderation_label", "none"),
            "admin_notes": user.get("admin_notes", ""), "messaging_restricted": bool(user.get("messaging_restricted")),
            "suspended_until": user.get("suspended_until"), "suspension_reason": user.get("suspension_reason", ""),
            "created_at": created, "updated_at": user.get("updated_at") or created,
            "last_login_at": user.get("last_login_at"), "terms_accepted_at": user.get("terms_accepted_at") or created,
        })

    for record in data.get("audit_log", []):
        insert("sl_audit_log", {
            "id": record["id"], "actor_id": record.get("actor_id"), "target_id": record.get("target_id"),
            "action": record.get("action", "legacy"), "details": record.get("details", ""),
            "created_at": record.get("created_at") or fallback_date,
        })
    latest_follows = {}
    for record in data.get("follow_requests", []):
        pair = (record.get("requester_id"), record.get("target_id"))
        previous = latest_follows.get(pair)
        if not previous or str(record.get("responded_at") or record.get("created_at", "")) >= str(previous.get("responded_at") or previous.get("created_at", "")):
            latest_follows[pair] = record
    for record in latest_follows.values():
        insert("sl_follows", {
            "id": record["id"], "follower_id": record.get("requester_id", ""), "following_id": record.get("target_id", ""),
            "status": record.get("status", "pending"), "created_at": record.get("created_at") or fallback_date,
            "updated_at": record.get("responded_at") or record.get("created_at") or fallback_date,
        })
    for record in data.get("notifications", []):
        details = record.get("data") or {}
        insert("sl_notifications", {
            "id": record["id"], "user_id": record.get("user_id", ""), "actor_id": record.get("actor_id"),
            "type": record.get("type", "notice"), "entity_id": record.get("entity_id") or details.get("conversation_id") or details.get("event_id") or details.get("request_id"),
            "title": record.get("title", ""), "message": record.get("message", ""), "read": bool(record.get("read")),
            "created_at": record.get("created_at") or fallback_date,
        })

    conversation_ids = set()
    for record in data.get("conversations", []):
        conversation_ids.add(record["id"])
        participants = record.get("participant_ids", [])
        creator = record.get("created_by") or (participants[0] if participants else "")
        created = record.get("created_at") or fallback_date
        metadata = {key: value for key, value in record.items() if key not in {"id", "kind", "title", "created_by", "participant_ids", "created_at", "updated_at"}}
        insert("sl_conversations", {
            "id": record["id"], "kind": record.get("kind", "direct"), "title": record.get("title", ""),
            "created_by": creator, "metadata_json": json_text(metadata), "created_at": created,
            "updated_at": record.get("updated_at") or created,
        })
        for user_id in participants:
            if user_id not in user_ids:
                continue
            admin_ids = record.get("group_admin_ids", [])
            deleted = (record.get("deleted_at_by") or {}).get(user_id)
            deleted_at = deleted.get("deleted_at", "") if isinstance(deleted, dict) else deleted
            newest_message = max((str(m.get("created_at", "")) for m in data.get("messages", []) if m.get("conversation_id") == record["id"]), default="")
            insert("sl_conversation_members", {
                "conversation_id": record["id"], "user_id": user_id,
                "role": "admin" if user_id in admin_ids or user_id == creator else "member",
                "muted": user_id in record.get("muted_by", []), "hidden": bool(deleted_at and newest_message <= str(deleted_at)),
                "last_read_at": None, "created_at": created,
            })
            cleared = (record.get("cleared_at_by") or {}).get(user_id)
            if isinstance(cleared, dict):
                cleared = cleared.get("cleared_at")
            if cleared:
                for message in data.get("messages", []):
                    if message.get("conversation_id") == record["id"] and str(message.get("created_at", "")) <= cleared:
                        insert("sl_message_visibility", {"message_id": message["id"], "user_id": user_id, "hidden": 1, "created_at": cleared})
        if record.get("kind") == "direct" and len(participants) == 2:
            insert("sl_direct_conversations", {"pair_key": "::".join(sorted(participants)), "conversation_id": record["id"]})

    for record in data.get("messages", []):
        if record.get("conversation_id") not in conversation_ids:
            continue
        metadata = dict(record.get("metadata") or {})
        attachment = record.get("attachment")
        if attachment and attachment.get("stored_name"):
            attachment_path = source.parent / "message_uploads" / Path(attachment["stored_name"]).name
            if attachment_path.is_file():
                safe_id = "".join(c for c in str(attachment.get("id") or record["id"]) if c.isalnum() or c in "_-")
                key = f"uploads/msg_legacy_{safe_id}{attachment_path.suffix.lower()}"
                metadata["attachment"] = {"url": "/" + key, "key": key, "name": attachment.get("name") or attachment_path.name, "mime": attachment.get("mime") or "application/octet-stream", "size": attachment.get("size") or attachment_path.stat().st_size}
                attachments.append({"key": key, "file": str(attachment_path.resolve()), "type": metadata["attachment"]["mime"], "content_type": metadata["attachment"]["mime"]})
        created = record.get("created_at") or fallback_date
        insert("sl_messages", {
            "id": record["id"], "conversation_id": record["conversation_id"], "sender_id": record.get("sender_id") if record.get("sender_id") in user_ids else None,
            "body": record.get("body", ""), "metadata_json": json_text(metadata), "moderation_status": record.get("moderation_status", "visible"),
            "pinned": bool(record.get("pinned")), "created_at": created, "updated_at": record.get("updated_at") or created,
        })

    events_by_workshop = {event.get("workshop_id"): event for event in data.get("calendar_events", []) if event.get("workshop_id")}
    for record in data.get("workshops", []):
        created = record.get("created_at") or fallback_date
        event = events_by_workshop.get(record["id"], {})
        insert("sl_workshops", {
            "id": record["id"], "host_id": record.get("host_id", ""), "event_id": event.get("id") or "legacy_evt_" + record["id"],
            "title": record.get("title", "Workshop"), "description": record.get("description", ""), "category": record.get("category", "Other"),
            "level": record.get("level", "All levels"), "format": record.get("format", "Online"), "location": record.get("location", "SwapLabs Live Room"),
            "timezone": record.get("timezone") or event.get("timezone") or "UTC", "starts_at": record["starts_at"],
            "duration_minutes": record.get("duration_minutes", 60), "seat_limit": record.get("seat_limit", 12),
            "outcomes_json": json_text(record.get("outcomes", [])), "tags_json": json_text(record.get("tags", [])),
            "status": record.get("status", "scheduled"), "admin_notes": record.get("admin_notes", ""), "created_at": created, "updated_at": record.get("updated_at") or created,
        })
    for record in data.get("workshop_registrations", []):
        insert("sl_workshop_registrations", {key: record.get(key, fallback_date if key.endswith("_at") else "") for key in ("id", "workshop_id", "user_id", "status", "created_at", "updated_at")})

    for group in data.get("community_groups", []):
        created = group.get("created_at") or fallback_date
        members = group.get("member_ids", [])
        moderators = group.get("moderator_ids", [])
        creator = group.get("created_by") or (moderators[0] if moderators else members[0] if members else "")
        conversation_id = group.get("conversation_id") or "legacy_group_conv_" + group["id"]
        if conversation_id not in conversation_ids:
            insert("sl_conversations", {"id": conversation_id, "kind": "group", "title": group.get("title", "Group"), "created_by": creator, "metadata_json": "{}", "created_at": created, "updated_at": created})
            for user_id in members:
                insert("sl_conversation_members", {"conversation_id": conversation_id, "user_id": user_id, "role": "admin" if user_id in moderators else "member", "muted": 0, "hidden": 0, "last_read_at": None, "created_at": created})
        insert("sl_community_groups", {"id": group["id"], "conversation_id": conversation_id, "title": group.get("title", "Group"), "description": group.get("description", ""), "category": group.get("category", "Community"), "icon": group.get("icon", "bx-group"), "accent": group.get("accent", "blue"), "requires_approval": bool(group.get("requires_approval")), "created_by": creator, "created_at": created, "updated_at": group.get("updated_at") or created})
        for user_id in members:
            insert("sl_community_group_members", {"group_id": group["id"], "user_id": user_id, "status": "active", "role": "moderator" if user_id in moderators else "member", "created_at": created, "updated_at": created})

    mapping = {"calendar_events": "events", "availability_rules": "availability", "credit_ledger": "ledger", "credit_disputes": "disputes", "learning_journal_entries": "journals", "roadmap_items": "roadmap", "newsletter_subscribers": "newsletter", "swap_requests": "swap_requests", "message_reports": "reports", "ideas": "ideas", "marketplace_items": "marketplace_items", "marketplace_orders": "marketplace_orders", "skill_battles": "skill_battles", "skill_battle_entries": "skill_battle_entries", "contact_messages": "contact_messages", "complaints": "complaints", "feedback": "feedback", "mentor_applications": "mentor_applications", "points_ledger": "points_ledger"}
    pledges_by_idea = {}
    for pledge in data.get("funding_pledges", []):
        pledges_by_idea.setdefault(pledge.get("idea_id"), []).append(pledge)
    for original_collection, target in mapping.items():
        for original in data.get(original_collection, []):
            record = dict(original)
            owner = record.get("owner_id") or record.get("user_id") or record.get("host_id") or record.get("seller_id") or record.get("requester_id") or record.get("reporter_id") or record.get("created_by") or ""
            if target == "availability":
                record["id"] = record.get("user_id")
            if target == "roadmap":
                record["votes"] = record.get("voters", [])
                record["vote_count"] = len(record["votes"])
            if target == "ideas":
                record["like_user_ids"] = record.get("liked_by", [])
                record["save_user_ids"] = record.get("saved_by", [])
                record["pledges"] = pledges_by_idea.get(record.get("id"), [])
                record["summary"] = record.get("tagline") or record.get("problem", "")
            app_record(target, record, owner)

    attendance_by_room = {}
    for attendance in data.get("video_attendance", []):
        attendance_by_room.setdefault(attendance.get("room_id"), []).append(dict(attendance))
    signals_by_room = {}
    for signal in data.get("video_signals", []):
        signals_by_room.setdefault(signal.get("room_id"), []).append(dict(signal))
    for room in data.get("video_rooms", []):
        record = dict(room)
        record["attendance"] = attendance_by_room.get(room["id"], [])
        record["signals"] = signals_by_room.get(room["id"], [])
        app_record("video_rooms", record, room.get("host_id", ""))

    # Preserve every source collection in private DB records even if a newer
    # workflow does not have an exact schema equivalent.
    for collection, records in data.items():
        if isinstance(records, list):
            for record in records:
                if isinstance(record, dict):
                    app_record("legacy_" + collection, record, record.get("user_id") or record.get("owner_id") or "")

    digest = hashlib.sha256(raw).hexdigest()
    statements.append("INSERT OR IGNORE INTO sl_local_migrations (migration_key, source_sha256, imported_at) VALUES (" + ", ".join(map(literal, [IMPORT_KEY, digest, now])) + ");")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(statements) + "\n", encoding="utf-8")
    (output.parent / "legacy-attachments.json").write_text(json.dumps(attachments, indent=2) + "\n")
    photos = source.parent / "uploads"
    photo_count = 0
    if photos.is_dir():
        destination = ROOT / "uploads"
        destination.mkdir(exist_ok=True)
        for photo in photos.iterdir():
            if photo.is_file() and photo.name.startswith(("usr_", "group_")) and photo.suffix.lower() in {".jpg", ".png", ".webp"}:
                target = destination / photo.name
                if not target.exists():
                    shutil.copy2(photo, target)
                photo_count += 1
    summary = {"source_sha256": digest, "source_accounts": len(user_ids), "statements": len(statements), "profile_photos": photo_count, "private_attachments": len(attachments), "tables": dict(counts)}
    (output.parent / "legacy-import-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Prepared local import: {len(user_ids)} preserved accounts, {photo_count} profile photos, {len(attachments)} private attachments. Original archive is unchanged.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / ".original-swaplabs" / "data" / "users.json")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "legacy-import.sql")
    args = parser.parse_args()
    build_import(args.source.resolve(), args.output.resolve())
