#!/usr/bin/env python3
"""Seed a large, clearly synthetic SwapLabs preview community.

This is intentionally local-only.  It writes to the same normalized SQLite
state that the localhost browser adapter uses, keeps the existing accounts and
records intact, and replaces only records created by this seed when re-run.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("RELAYSKILLS_LOCAL_DB_PATH", str(ROOT / "data" / "relayskills-local.sqlite3"))).expanduser().resolve()
PREFIX = "bulk40-20260928-"
SEED_VERSION = "relayskills-bulk-demo-40-v1"
DEMO_PASSWORD = "SwapLabsDemo!2026"
BASE = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)

LIST_COLLECTIONS = (
    "users", "notifications", "conversations", "messages", "events", "workshops",
    "workshop_registrations", "courses", "contact_messages", "complaints", "posts",
    "stories", "blogs", "blog_comments", "groups", "ideas", "journals", "ledger",
    "disputes", "vouchers", "livestreams", "swapjobs", "follows", "feedback",
    "session_ratings", "session_point_reviews", "session_progress_reports",
    "adminMessages", "reports",
)
DICT_COLLECTIONS = ("portfolios", "achievements", "roadmapVotes", "onboarding")
ALL_COLLECTIONS = set(LIST_COLLECTIONS + DICT_COLLECTIONS)


def table_name(collection: str) -> str:
    return "data_" + re.sub(r"(?<!^)(?=[A-Z])", "_", collection).lower()


def iso(days: int = 0, hours: int = 0, minutes: int = 0) -> str:
    value = BASE + timedelta(days=days, hours=hours, minutes=minutes)
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def values(value) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [part.strip() for part in str(value or "").split(",") if part.strip()]


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def load_state(connection: sqlite3.Connection) -> dict:
    state: dict = {}
    for collection in LIST_COLLECTIONS:
        table = table_name(collection)
        state[collection] = [json.loads(raw) for (raw,) in connection.execute(f"SELECT record_json FROM {table} ORDER BY rowid")]
    for collection in DICT_COLLECTIONS:
        table = table_name(collection)
        state[collection] = {
            str(record_id): json.loads(raw)
            for record_id, raw in connection.execute(f"SELECT record_id, record_json FROM {table} ORDER BY rowid")
        }
    for item_key, raw in connection.execute("SELECT item_key, value_json FROM app_kv WHERE namespace = 'state' ORDER BY item_key"):
        state[str(item_key)] = json.loads(raw)
    for collection in LIST_COLLECTIONS:
        state.setdefault(collection, [])
    for collection in DICT_COLLECTIONS:
        state.setdefault(collection, {})
    return state


def ensure_storage(connection: sqlite3.Connection) -> None:
    """Create collection tables added after an older local server started."""
    connection.execute(
        "CREATE TABLE IF NOT EXISTS app_kv ("
        "namespace TEXT NOT NULL, item_key TEXT NOT NULL, value_json TEXT NOT NULL, "
        "updated_at TEXT NOT NULL, PRIMARY KEY(namespace, item_key)"
        ")"
    )
    for collection in LIST_COLLECTIONS + DICT_COLLECTIONS:
        table = table_name(collection)
        connection.execute(
            f"CREATE TABLE IF NOT EXISTS {table} ("
            "record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at TEXT NOT NULL"
            ")"
        )
        connection.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_updated ON {table}(updated_at)")
    connection.commit()


def is_seed_record(record) -> bool:
    return isinstance(record, dict) and str(record.get("id", "")).startswith(PREFIX)


def remove_previous_seed(state: dict) -> None:
    for collection in LIST_COLLECTIONS:
        state[collection] = [record for record in state.get(collection, []) if not is_seed_record(record)]
    for collection in DICT_COLLECTIONS:
        state[collection] = {
            key: value for key, value in state.get(collection, {}).items() if not str(key).startswith(PREFIX)
        }


def add(state: dict, collection: str, record: dict) -> dict:
    state.setdefault(collection, []).append(record)
    return record


def bulk_id(kind: str, number: int | str) -> str:
    return f"{PREFIX}{kind}-{int(number):03d}"


ACCOUNT_SPECS = [
    ("Meera Kapoor", "New Delhi", "Web design, responsive web design", "Web development, accessibility", "Interface design student", "Making digital spaces feel clear", "I like turning rough ideas into calm, usable interfaces and sharing practical feedback.", "indigo"),
    ("Kabir Nair", "Kochi", "Backend development, Node.js, API design", "UI design, product planning", "Computer science learner", "Building useful things behind the screen", "I enjoy explaining backend ideas with small services, diagrams, and a working example.", "teal"),
    ("Diya Shah", "Ahmedabad", "Python, data analysis, Excel", "Machine learning, data visualization", "Data curious student", "Finding stories in everyday data", "I help beginners get comfortable with data by making the first experiment small and concrete.", "coral"),
    ("Reyansh Rao", "Hyderabad", "UI design, UX research, Figma", "Frontend development, accessibility", "Product design learner", "Making interfaces kinder", "I enjoy thoughtful critique, simple prototypes, and designing for people who are usually overlooked.", "violet"),
    ("Anaya Sen", "Kolkata", "Graphic design, branding, illustration", "Motion design, typography", "Visual communication student", "Giving good ideas a visual voice", "I share approachable visual systems and love turning a messy brief into a friendly direction.", "rose"),
    ("Vihaan Malhotra", "Mumbai", "Motion design, After Effects, storyboarding", "Video editing, illustration", "Motion design creator", "Making movement explain an idea", "I teach motion through tiny experiments that make timing and storytelling easier to notice.", "purple"),
    ("Siya Iyer", "Chennai", "Photography, Lightroom, composition", "Video editing, travel planning", "Visual storyteller", "Looking for the light in ordinary places", "I like street photography, patient critique, and helping people make stronger visual choices.", "mint"),
    ("Arjun Menon", "Bengaluru", "Video editing, DaVinci Resolve, storytelling", "Photography, sound design", "Media maker", "Cutting stories with intention", "I can help with an editing workflow and enjoy exchanging ideas about what makes a story land.", "blue"),
    ("Myra Joshi", "Pune", "Content writing, copywriting, SEO", "Branding, digital marketing", "Content strategist", "Useful words for real people", "I help small projects make their message more human, specific, and discoverable.", "peach"),
    ("Advik Bhat", "Jaipur", "Public speaking, presentation design, storytelling", "Interview practice, video editing", "Communication coach", "Helping ideas land with confidence", "I enjoy low-pressure practice, clear feedback, and presentations that sound like the person giving them.", "amber"),
    ("Tara Verma", "Lucknow", "Spanish conversation, translation, language exchange", "Travel planning, public speaking", "Language exchange host", "Curiosity sounds better in conversation", "I create friendly prompts for language practice and love learning how people express the same idea differently.", "lilac"),
    ("Kian D'Souza", "Goa", "Guitar, music theory, songwriting", "Video editing, sound design", "Independent musician", "Small songs, patient practice", "I teach guitar in a relaxed way and love trading creative routines with other learners.", "coral"),
    ("Rhea Bansal", "Gurugram", "Baking, food styling, Indian cooking", "Branding, photography", "Creative maker", "Warm skills for curious kitchens", "I teach approachable baking and enjoy the overlap between good food and visual storytelling.", "yellow"),
    ("Ishaan Gupta", "Noida", "Fitness, running, habit building", "Nutrition, mindfulness", "Student coach", "Progress that fits real life", "I care about sustainable routines, beginner-friendly movement, and encouraging people without pressure.", "green"),
    ("Nitya Pillai", "Thiruvananthapuram", "Yoga, mindfulness, journaling", "Nutrition, frontend development", "Wellbeing facilitator", "Making space to notice what matters", "I share gentle practices and want to understand how thoughtful digital products are built.", "sage"),
    ("Dev Arora", "Chandigarh", "Project management, Notion, facilitation", "Product strategy, public speaking", "Project coordinator", "Turning plans into useful momentum", "I make complex projects feel less intimidating by finding the next visible step.", "blue"),
    ("Zoya Khan", "Bhopal", "Entrepreneurship, digital marketing, community building", "Product management, finance", "Early-stage builder", "Good ideas need generous structure", "I like exploring practical business models and making room for more voices in the conversation.", "teal"),
    ("Aditi Sethi", "Surat", "Budgeting, financial literacy, Excel", "Entrepreneurship, data visualization", "Finance learner", "Making money topics less mysterious", "I translate intimidating finance ideas into clear examples people can actually use.", "mint"),
    ("Rudra Das", "Bhubaneswar", "Cybersecurity, online safety, privacy basics", "Cloud infrastructure, Python", "Security learner", "Safer habits, explained simply", "I enjoy helping people understand everyday digital safety without fear or jargon.", "indigo"),
    ("Ayesha Sheikh", "Mumbai", "Cloud infrastructure, DevOps, Docker", "Cybersecurity, backend development", "Cloud engineering student", "Shipping reliable foundations", "I share hands-on infrastructure practice and like debugging systems with a calm partner.", "violet"),
    ("Neil Thomas", "Bengaluru", "Machine learning, NLP, Python", "Data visualization, product research", "AI learner", "Making models more understandable", "I care about useful experiments, clear evaluation, and explaining machine learning to curious beginners.", "blue"),
    ("Kavya Reddy", "Hyderabad", "Excel, Power BI, data visualization", "Python, product strategy", "Business analytics student", "Turning numbers into decisions", "I enjoy building small dashboards and helping people ask better questions of their data.", "coral"),
    ("Yuvan Krishnan", "Chennai", "Java, data structures, algorithms", "Backend development, interview practice", "Software engineering student", "Practising the fundamentals together", "I like whiteboard problems, patient explanations, and examples that connect theory to real code.", "green"),
    ("Ira Mukherjee", "Kolkata", "C++, systems programming, Linux", "Java, cloud infrastructure", "Systems learner", "Understanding what runs underneath", "I enjoy taking systems apart carefully and making technical concepts feel approachable.", "rose"),
    ("Dhruv Mehta", "Vadodara", "React, TypeScript, frontend development", "UX research, backend development", "Frontend engineer", "Small interfaces that feel alive", "I share frontend patterns, debugging habits, and practical ways to make a prototype feel real.", "indigo"),
    ("Sana Farooq", "Delhi", "Vue, accessibility, HTML and CSS", "React, UX research", "Web accessibility advocate", "Designing for more people", "I help teams notice access needs early and build interfaces that are easier to use.", "mint"),
    ("Vivaan Roy", "Patna", "SQL, databases, data modelling", "Backend development, data analysis", "Database learner", "Making information findable", "I enjoy turning tangled data into a clean model and explaining why the structure matters.", "amber"),
    ("Pari Kulkarni", "Pune", "Product management, user research, product strategy", "UI design, analytics", "Product builder", "Starting with the right question", "I facilitate user research and enjoy helping teams choose a small, testable next step.", "peach"),
    ("Aarav Suri", "New Delhi", "Animation, illustration, visual design", "3D modelling, motion design", "Illustrator and animator", "Making ideas move", "I share playful visual experiments and like finding the simplest shape that can carry a story.", "purple"),
    ("Leela Nair", "Kochi", "3D modelling, Blender, product visualisation", "Animation, photography", "3D artist", "Building worlds one shape at a time", "I teach beginner-friendly Blender workflows and enjoy collaborating on visual ideas.", "teal"),
    ("Hriday Jain", "Indore", "Fashion design, textile craft, moodboards", "Branding, illustration", "Textile design student", "Material, colour, and useful making", "I like hands-on design, thoughtful references, and learning from people who make things differently.", "coral"),
    ("Mahi Thakur", "Dehradun", "Gardening, sustainability, composting", "Nutrition, photography", "Sustainability learner", "Small systems that help the planet", "I share practical home-growing experiments and enjoy connecting everyday choices to bigger ideas.", "sage"),
    ("Om Prakash", "Ranchi", "Resume writing, LinkedIn, interview practice", "Public speaking, product management", "Career readiness peer", "Making the next step visible", "I help people turn experience into a clear story and practise answers without sounding rehearsed.", "blue"),
    ("Sana Bose", "Siliguri", "Teaching, facilitation, lesson planning", "Psychology, public speaking", "Peer learning facilitator", "Good learning starts with welcome", "I design friendly practice spaces and love exchanging ideas about how people learn.", "lilac"),
    ("Kiaan Kapoor", "New Delhi", "Accessibility, sign language basics, inclusive design", "UX research, web design", "Inclusion advocate", "Making participation easier", "I care about inclusive communication and practical changes that help more people take part.", "violet"),
    ("Advaita Rao", "Mysuru", "Chess, strategy, problem solving", "Python, public speaking", "Strategy learner", "Thinking one useful move ahead", "I enjoy patient puzzles, reflective practice, and finding structure in complex decisions.", "amber"),
    ("Anvi Gupta", "Agra", "Travel planning, geography, research", "Photography, Spanish conversation", "Travel researcher", "Learning through place and perspective", "I build practical itineraries and love the stories that appear when people compare their home places.", "mint"),
    ("Parth Sood", "Shimla", "Drone photography, maps, outdoor planning", "Video editing, sustainability", "Outdoor media maker", "Seeing the bigger picture", "I combine maps, images, and careful planning to make outdoor projects more thoughtful.", "green"),
    ("Noor Ali", "Srinagar", "Calligraphy, lettering, Urdu poetry", "Graphic design, language exchange", "Lettering artist", "Letters with a little more feeling", "I enjoy slow craft, generous critique, and the connection between language and visual form.", "rose"),
    ("Yashvi Patel", "Rajkot", "Ceramics, DIY, craft entrepreneurship", "Product photography, digital marketing", "Maker and seller", "Useful things made by hand", "I share approachable making experiments and the small systems that help a creative practice grow.", "peach"),
]


def make_user(index: int, spec: tuple) -> dict:
    name, city, teach, learn, role, headline, bio, color = spec
    parts = name.replace("'", "").split()
    first = parts[0]
    last = " ".join(parts[1:])
    username = f"demo40.{slug(name)}"
    age = 22 + (index % 14)
    dob_year = 2026 - age
    dob_day = 2 + (index % 20)
    languages = ["Hindi", "Spanish", "Tamil", "Malayalam", "Bengali", "French", "Marathi"]
    return {
        "id": bulk_id("user", index),
        "username": username,
        "email": f"{username}@demo.relayskills.invalid",
        "password_hash": sha256(DEMO_PASSWORD),
        "role": "member",
        "status": "active",
        "verified": True,
        "time_credits": 140 + (index * 3),
        "reward_points": 70 + (index * 4),
        "profile": {
            "first_name": first,
            "last_name": last,
            "display_name": name,
            "phone_number": f"+91 90040 {index:04d}",
            "pronouns": "",
            "gender": "",
            "date_of_birth": f"{dob_year}-02-{dob_day:02d}",
            "age": str(age),
            "country": "India",
            "city": city,
            "timezone": "Asia/Kolkata",
            "primary_language": "English",
            "additional_languages": languages[index % len(languages)],
            "languages_to_learn": languages[(index + 2) % len(languages)],
            "occupation": role,
            "professional_role": role,
            "organization": "",
            "headline": headline,
            "bio": bio,
            "website": "",
            "availability": "Weekday evenings and Saturday mornings" if index % 2 else "Weekday mornings and Sunday afternoons",
            "preferred_format": "Remote or local",
            "teaching_style": ("Conversational", "Project-based", "Practice and feedback")[index % 3],
            "experience_level": ("Intermediate", "Advanced", "Intermediate", "Beginner friendly")[index % 4],
            "learning_goal": f"Make steady progress in {values(learn)[0]} through a practical exchange.",
            "skills_to_teach": teach,
            "skills_to_learn": learn,
            "skill_details": f"DEMO profile: practical sessions about {teach}.",
            "interests": "Community learning, creative projects, useful conversations",
            "profile_color": color,
            "avatar_url": "",
        },
        "preferences": {
            "match_visibility": True,
            "show_location": True,
            "email_notifications": True,
            "weekly_digest": True,
            "profile_visibility": "public",
            "theme": "light",
            "font_scale": "default",
            "content_density": "comfortable",
            "navigation_style": "expanded",
            "default_landing": "dashboard",
            "high_contrast": False,
            "reduced_motion": False,
            "link_underlines": False,
            "focus_mode": False,
            "show_ai_assistant": True,
            "auto_play_testimonials": True,
        },
        "safety": {
            "account_type": "adult",
            "guardian_consent_status": "not_applicable",
            "is_minor": False,
            "minor_messaging": "standard",
            "innovation_access": "standard",
        },
        "created_at": iso(days=-38 + index, hours=index % 8),
    }


def build_public_user(user: dict, state: dict) -> dict:
    profile = user.get("profile", {})
    user_id = user["id"]
    follows = state.get("follows", [])
    followers = sum(1 for item in follows if item.get("following_id") == user_id)
    following = sum(1 for item in follows if item.get("follower_id") == user_id)
    completed = sum(
        1
        for event in state.get("events", [])
        if event.get("status") == "completed" and (event.get("host_id") == user_id or user_id in values(event.get("participant_ids")))
    )
    ideas = sum(1 for idea in state.get("ideas", []) if idea.get("owner_id") == user_id and idea.get("status") == "published")
    return {
        "id": user_id,
        "username": user.get("username", ""),
        "role": user.get("role", "member"),
        "status": user.get("status", "active"),
        "verified": bool(user.get("verified")),
        "time_credits": int(user.get("time_credits", 0)),
        "profile": dict(profile),
        "profile_color": profile.get("profile_color", "indigo"),
        "display_name": profile.get("display_name") or user.get("username", "Member"),
        "country": profile.get("country", ""),
        "skills_to_teach": values(profile.get("skills_to_teach")),
        "skills_to_learn": values(profile.get("skills_to_learn")),
        "visibility": "public",
        "relationship": "none",
        "followers_count": followers,
        "following_count": following,
        "published_idea_count": ideas,
        "can_view_full": True,
        "is_minor": False,
        "joined_at": user.get("created_at", ""),
        "reputation": {
            "rating": round(4.35 + (int(user_id[-3:]) % 6) / 10, 1),
            "review_count": 4 + (int(user_id[-3:]) % 12),
            "completed_sessions": completed,
            "reliability_known": completed > 0,
            "reliability_score": min(99, 88 + completed),
        },
        "availability": {"label": profile.get("availability", "Availability not set"), "available_now": False, "next_overlap_at": None},
        "swap_requests_available": True,
    }


def add_message(state: dict, conversation: dict, sender: dict, body: str, number: int, day_offset: int, hour: int, read: bool = True) -> None:
    created = iso(days=day_offset, hours=hour)
    add(state, "messages", {
        "id": bulk_id("message", number),
        "conversation_id": conversation["id"],
        "sender_id": sender["id"],
        "body": body,
        "read": read,
        "created_at": created,
    })
    conversation["updated_at"] = created


def make_conversation(state: dict, number: int, kind: str, members: list[str], title: str, day_offset: int, event_id: str = "") -> dict:
    created = iso(days=day_offset, hours=10 + (number % 7))
    conversation = {
        "id": bulk_id(f"conversation-{kind}", number),
        "kind": kind,
        "title": title,
        "member_ids": members,
        "created_at": created,
        "updated_at": created,
        "blocked_for": [],
        "muted_for": [],
        "hidden_for": [],
    }
    if event_id:
        conversation["event_id"] = event_id
    add(state, "conversations", conversation)
    return conversation


def build_seed(state: dict) -> tuple[list[dict], dict[str, dict]]:
    users = [make_user(index, spec) for index, spec in enumerate(ACCOUNT_SPECS, 1)]
    by_id = {user["id"]: user for user in users}
    state["users"].extend(users)

    # Dense, reciprocal follows make the member directory, profiles, and
    # calendar contact picker feel like a real community.
    follow_pairs: set[tuple[str, str]] = set()
    follow_number = 1
    for index, user in enumerate(users):
        for jump in (1, 5, 11):
            target = users[(index + jump) % len(users)]
            if target["id"] == user["id"]:
                continue
            pair = (user["id"], target["id"])
            if pair in follow_pairs:
                continue
            follow_pairs.add(pair)
            add(state, "follows", {"id": bulk_id("follow", follow_number), "follower_id": pair[0], "following_id": pair[1], "created_at": iso(days=-30 + (follow_number % 22), hours=9 + (follow_number % 8))})
            follow_number += 1

    # Direct conversations: two connected rounds per learner plus plenty of
    # unread messages for inbox/dashboard states.
    direct_pairs: list[tuple[int, int]] = []
    seen_pairs: set[tuple[int, int]] = set()
    for index in range(len(users)):
        for target_index in ((index + 1) % len(users), (index + 10) % len(users)):
            pair = tuple(sorted((index, target_index)))
            if pair[0] != pair[1] and pair not in seen_pairs:
                seen_pairs.add(pair)
                direct_pairs.append((index, target_index))
    message_number = 1
    for number, (first_index, second_index) in enumerate(direct_pairs, 1):
        first, second = users[first_index], users[second_index]
        topic = values(second["profile"]["skills_to_teach"])[0]
        conversation = make_conversation(state, number, "direct", [first["id"], second["id"]], second["profile"]["display_name"], -22 + (number % 17))
        add_message(state, conversation, first, f"DEMO hello {second['profile']['first_name']} — I would love to learn about {topic}.", message_number, -20 + (number % 15), 9 + (number % 6), True); message_number += 1
        add_message(state, conversation, second, "Happy to help. I can bring a small example and keep the first exchange practical.", message_number, -20 + (number % 15), 10 + (number % 6), True); message_number += 1
        add_message(state, conversation, first, "Perfect. I will share my goal before we meet so we can use the time well.", message_number, -19 + (number % 15), 11 + (number % 6), number % 4 != 0); message_number += 1
        add_message(state, conversation, second, "Great — let us finish with one next step we can both try.", message_number, -19 + (number % 15), 12 + (number % 6), number % 5 != 0); message_number += 1

    # Eight interest groups add shared spaces and group inbox activity.
    group_specs = [
        ("Frontend Flight School", "Technology", "Small, supportive practice sessions for web interfaces and APIs.", "blue", "bx-code-alt", [0, 1, 3, 24, 25, 26, 33, 38]),
        ("Data and AI Lab", "Data and AI", "Bring a dataset, a question, or a model that needs a second pair of eyes.", "indigo", "bx-line-chart", [2, 17, 20, 21, 22, 23, 36]),
        ("Creative Studio", "Creative skills", "A friendly room for visual drafts, motion tests, photos, and lettering.", "coral", "bx-palette", [4, 5, 6, 7, 28, 29, 39]),
        ("Words and Voice", "Communication", "Practise writing, speaking, storytelling, and language exchange.", "lilac", "bx-conversation", [8, 9, 10, 11, 32, 33, 38]),
        ("Wellbeing Workshop", "Health and habits", "Low-pressure conversations about movement, food, focus, and routines.", "mint", "bx-heart", [12, 13, 14, 30, 31, 35, 37]),
        ("Builders and Founders", "Product and business", "Turn an early idea into a next experiment with practical peer feedback.", "teal", "bx-rocket", [15, 16, 17, 18, 27, 32, 39]),
        ("Safe Digital Life", "Digital literacy", "Everyday privacy, cloud, security, and accessibility explained plainly.", "green", "bx-shield", [18, 19, 23, 25, 26, 34, 36]),
        ("Maker Weekend", "Hands-on making", "Craft, cooking, outdoor planning, and small projects shared generously.", "amber", "bx-wrench", [6, 11, 12, 28, 29, 30, 31, 37, 39]),
    ]
    group_message_number = 1
    for number, (title, category, description, accent, icon, member_indices) in enumerate(group_specs, 1):
        member_ids = [users[index]["id"] for index in member_indices]
        conversation = make_conversation(state, number, "group", member_ids, title, -18 + number)
        pending_user = users[(member_indices[0] + 7) % len(users)]["id"]
        group = {
            "id": bulk_id("group", number),
            "title": title,
            "category": category,
            "description": description,
            "accent": accent,
            "icon": icon,
            "visibility": "public",
            "requires_approval": False,
            "owner_id": member_ids[0],
            "moderator_ids": [member_ids[0]],
            "member_ids": member_ids,
            "conversation_id": conversation["id"],
            "pinned_messages": [{"body": "DEMO room note: keep questions specific, kind, and useful for the next person.", "created_at": iso(days=-15 + number, hours=12)}],
            "pending_join_requests": [{"user_id": pending_user, "status": "pending", "created_at": iso(days=-2, hours=14)}],
            "created_at": iso(days=-18 + number, hours=15),
        }
        add(state, "groups", group)
        for offset, member_index in enumerate(member_indices[:5]):
            body = "Welcome to the demo room — what are you practising this week?" if offset == 0 else "I can share a small example for the group to try."
            add_message(state, conversation, users[member_index], body, message_number + group_message_number, -12 + number, 12 + offset, offset % 3 != 0)
            group_message_number += 1

    # Completed one-to-one sessions give every synthetic account a personal
    # journey, two mandatory reports, credit settlement, and ratings.
    event_number = 1
    session_message_number = message_number + 500
    completed_event_ids: list[str] = []
    for index, host in enumerate(users):
        learner = users[(index + 1) % len(users)]
        event_id = bulk_id("event-completed", event_number)
        conversation_id = bulk_id("conversation-meeting", event_number)
        start_days = -(1 + (index % 24))
        starts = iso(days=start_days, hours=8 + (index % 9))
        ends = iso(days=start_days, hours=9 + (index % 9))
        title = f"DEMO exchange: {values(host['profile']['skills_to_teach'])[0]} for {learner['profile']['first_name']}"
        event = {
            "id": event_id,
            "title": title,
            "description": "Synthetic completed session for the local SwapLabs preview.",
            "starts_at": starts,
            "ends_at": ends,
            "timezone": "Asia/Kolkata",
            "host_id": host["id"],
            "participant_ids": [learner["id"]],
            "conversation_id": conversation_id,
            "status": "completed",
            "location": "SwapLabs demo room",
            "meeting_url": "https://meet.demo.relayskills.invalid/room-" + str(event_number),
            "reminders_minutes": [1440, 60],
            "all_day": False,
            "completed_at": ends,
            "completed_by": host["id"],
            "points_status": "awarded",
            "session_cost_credits": 5,
            "one_way_reward_credits": 10,
            "credit_payer_id": learner["id"],
            "credit_status": "settled",
            "credit_settlement_id": f"{PREFIX}settlement-{event_number:03d}",
            "credit_settlement_at": iso(days=start_days, hours=10 + (index % 9)),
            "credit_reward_recipients": [{"teacher_id": host["id"], "learner_id": learner["id"], "skill": values(host["profile"]["skills_to_teach"])[0], "kind": "direct", "family": "", "amount": 10}],
        }
        add(state, "events", event)
        completed_event_ids.append(event_id)
        conversation = {
            "id": conversation_id,
            "kind": "meeting",
            "title": title,
            "member_ids": [host["id"], learner["id"]],
            "event_id": event_id,
            "created_at": starts,
            "updated_at": ends,
            "blocked_for": [],
            "muted_for": [],
            "hidden_for": [],
        }
        add(state, "conversations", conversation)
        add_message(state, conversation, host, f"We will practise {values(host['profile']['skills_to_teach'])[0]} and leave with one useful next step.", session_message_number, start_days, 8 + (index % 9), True); session_message_number += 1
        add_message(state, conversation, learner, "I brought a small question and an example to work through together.", session_message_number, start_days, 8 + (index % 9), True); session_message_number += 1
        add_message(state, conversation, host, "DEMO session complete — the reflection is ready for both participants.", session_message_number, start_days, 9 + (index % 9), True); session_message_number += 1

        # Credit cost is paid by the learner; a one-way teaching reward goes
        # to the host. This mirrors the product rule in the local API.
        learner["time_credits"] -= 5
        host["time_credits"] += 10
        add(state, "ledger", {"id": bulk_id("ledger-fee", event_number), "user_id": learner["id"], "type": "session_fee", "amount": -1, "balance_after": learner["time_credits"], "description": f"One-credit session fee for {title}", "counterparty": build_public_user(host, state), "reference_id": event["credit_settlement_id"], "reference_type": "session_fee", "created_by": learner["id"], "created_at": ends})
        add(state, "ledger", {"id": bulk_id("ledger-reward", event_number), "user_id": host["id"], "type": "session_reward", "amount": 10, "balance_after": host["time_credits"], "description": f"One-way teaching reward for {title}", "counterparty": build_public_user(learner, state), "reference_id": event["credit_settlement_id"], "reference_type": "one_way_session_reward", "created_by": host["id"], "created_at": ends})

        for reporter_index, reporter in enumerate((host, learner), 1):
            report_id = bulk_id("progress-report", event_number * 2 - 2 + reporter_index)
            report = {
                "id": report_id,
                "event_id": event_id,
                "reporter_id": reporter["id"],
                "what_happened": f"We worked through a small DEMO exercise in {values(host['profile']['skills_to_teach'])[0]}, compared approaches, and made space for questions.",
                "progress": "I can now describe the next practice step and have one example to continue with.",
                "overall_rating": 4 + ((index + reporter_index) % 2),
                "next_step": f"Repeat the {values(host['profile']['skills_to_teach'])[0]} exercise once before the next exchange.",
                "created_at": ends,
                "updated_at": ends,
            }
            add(state, "session_progress_reports", report)
            add(state, "journals", {"id": bulk_id("journal-session", event_number * 2 - 2 + reporter_index), "user_id": reporter["id"], "title": f"Session reflection: {title}", "skill": values(host["profile"]["skills_to_teach"])[0], "minutes": 60, "confidence": report["overall_rating"], "mood": "energized" if report["overall_rating"] >= 4 else "curious", "visibility": "private", "reflection": f"What happened: {report['what_happened']}\n\nProgress: {report['progress']}", "next_step": report["next_step"], "source_type": "session_progress_report", "source_id": report_id, "event_id": event_id, "created_at": ends, "updated_at": ends})
            rating_id = bulk_id("rating", event_number * 2 - 2 + reporter_index)
            add(state, "session_ratings", {"id": rating_id, "event_id": event_id, "rater_id": reporter["id"], "rating": 4 + ((index + reporter_index) % 2), "comment": "DEMO rating: focused, kind, and useful.", "created_at": ends, "points_awarded": 10, "points_status": "awarded"})
            reporter["reward_points"] += 10
            add(state, "notifications", {"id": bulk_id("notification-session", event_number * 2 - 2 + reporter_index), "user_id": reporter["id"], "type": "session_complete", "message": f"Your DEMO exchange “{title}” has a saved progress report.", "entity_id": event_id, "read": reporter_index == 1, "created_at": ends})
        event_number += 1

    # Upcoming and cancelled sessions add calendar variety without creating
    # fake report obligations for the learner journey.
    for index in range(1, 21):
        host = users[(index * 3) % len(users)]
        learner = users[(index * 3 + 7) % len(users)]
        event_id = bulk_id("event-scheduled", index)
        conversation_id = bulk_id("conversation-upcoming", index)
        start_days = 1 + (index % 20)
        starts = iso(days=start_days, hours=9 + index % 8)
        ends = iso(days=start_days, hours=10 + index % 8)
        title = f"Upcoming DEMO studio: {values(host['profile']['skills_to_teach'])[0]}"
        add(state, "events", {"id": event_id, "title": title, "description": "Synthetic upcoming exchange for the local preview.", "starts_at": starts, "ends_at": ends, "timezone": "Asia/Kolkata", "host_id": host["id"], "participant_ids": [learner["id"]], "conversation_id": conversation_id, "status": "scheduled", "location": "SwapLabs online room", "meeting_url": "https://meet.demo.relayskills.invalid/upcoming-" + str(index), "reminders_minutes": [1440, 60], "all_day": False, "session_cost_credits": 5, "one_way_reward_credits": 10, "credit_payer_id": learner["id"], "credit_status": "not_started", "credit_reward_recipients": []})
        conversation = make_conversation(state, 100 + index, "meeting", [host["id"], learner["id"]], title, -1, event_id)
        conversation["id"] = conversation_id
        # The normalized state stores records by their own IDs; update the ID
        # after the convenience constructor so the event link is exact.
        state["conversations"][-1]["id"] = conversation_id
        add_message(state, state["conversations"][-1], host, "I have reserved a DEMO slot — bring one concrete question.", session_message_number, -1 + index % 2, 13, True); session_message_number += 1
        add_message(state, state["conversations"][-1], learner, "Looking forward to it. I will share my current attempt first.", session_message_number, -1 + index % 2, 14, index % 3 != 0); session_message_number += 1
        add(state, "notifications", {"id": bulk_id("notification-upcoming", index), "user_id": learner["id"], "type": "session_reminder", "message": f"Upcoming DEMO session: {title}.", "entity_id": event_id, "read": index % 4 != 0, "created_at": iso(days=0, hours=8 + index % 5)})
        event_number += 1

    for index in range(1, 9):
        host = users[(index * 4 + 2) % len(users)]
        learner = users[(index * 4 + 9) % len(users)]
        event_id = bulk_id("event-cancelled", index)
        starts = iso(days=-(12 + index), hours=15)
        ends = iso(days=-(12 + index), hours=16)
        add(state, "events", {"id": event_id, "title": f"Cancelled DEMO exchange {index}: {values(host['profile']['skills_to_teach'])[0]}", "description": "Synthetic cancelled session for calendar history.", "starts_at": starts, "ends_at": ends, "timezone": "Asia/Kolkata", "host_id": host["id"], "participant_ids": [learner["id"]], "status": "cancelled", "location": "SwapLabs online room", "meeting_url": "", "reminders_minutes": [60], "all_day": False, "session_cost_credits": 5, "one_way_reward_credits": 10, "credit_payer_id": learner["id"], "credit_status": "not_started", "credit_reward_recipients": [], "cancelled_at": iso(days=-(11 + index), hours=9)})

    # Twelve future workshops provide a richer workshops/admin view.
    workshop_topics = [
        ("Build a friendly landing page", "Web design", "Beginner"), ("APIs without the fog", "Backend development", "Intermediate"),
        ("Python data stories", "Data and AI", "Beginner"), ("One-hour portfolio critique", "Career planning", "All levels"),
        ("Phone photography walk", "Photography", "Beginner"), ("Motion that explains", "Motion design", "Intermediate"),
        ("Plan your first product test", "Product strategy", "All levels"), ("Digital safety clinic", "Online safety", "Beginner"),
        ("Language exchange table", "Languages", "All levels"), ("Make a weekly practice habit", "Wellbeing", "Beginner"),
        ("From idea to tiny prototype", "Entrepreneurship", "Intermediate"), ("Data dashboards that answer questions", "Analytics", "Intermediate"),
    ]
    for index, (title, category, level) in enumerate(workshop_topics, 1):
        host = users[(index * 2 - 1) % len(users)]
        attendee_indices = [((index * 2 + offset * 3) % len(users)) for offset in range(2, 8)]
        attendee_ids = list(dict.fromkeys(users[item]["id"] for item in attendee_indices if users[item]["id"] != host["id"]))
        starts = iso(days=3 + index * 2, hours=11 + index % 6)
        ends = iso(days=3 + index * 2, hours=12 + index % 6, minutes=30)
        event_id = bulk_id("event-workshop", index)
        workshop_id = bulk_id("workshop", index)
        add(state, "events", {"id": event_id, "title": title, "description": "DEMO workshop connected to the local SwapLabs calendar.", "starts_at": starts, "ends_at": ends, "timezone": "Asia/Kolkata", "host_id": host["id"], "participant_ids": attendee_ids, "status": "scheduled", "location": "SwapLabs workshop room", "meeting_url": f"https://meet.demo.relayskills.invalid/workshop-{index}", "reminders_minutes": [1440, 60], "all_day": False, "session_cost_credits": 5, "one_way_reward_credits": 10, "credit_payer_id": host["id"], "credit_status": "not_started", "credit_reward_recipients": []})
        add(state, "workshops", {"id": workshop_id, "event_id": event_id, "host_id": host["id"], "title": title, "description": "A practical DEMO workshop with one clear outcome to take away.", "category": category, "level": level, "format": "Live online", "location": "SwapLabs workshop room", "timezone": "Asia/Kolkata", "starts_at": starts, "ends_at": ends, "duration_minutes": 90, "seat_limit": 18, "status": "scheduled", "registered_user_ids": attendee_ids, "outcomes": ["Leave with one working example", "Know the next useful practice step"], "tags": [category, "peer learning", "demo community"], "share_id": f"{PREFIX}share-{index:02d}", "share_expires_at": ends})
        for registration_index, user_id in enumerate(attendee_ids, 1):
            add(state, "workshop_registrations", {"id": bulk_id("registration", index * 20 + registration_index), "workshop_id": workshop_id, "user_id": user_id, "status": "registered", "admin_notes": "DEMO registration", "created_at": iso(days=1 + index, hours=9 + registration_index % 5)})
        add(state, "notifications", {"id": bulk_id("notification-workshop", index), "user_id": host["id"], "type": "workshop_registration", "message": f"Your DEMO workshop “{title}” has new registrations.", "entity_id": workshop_id, "read": index % 3 == 0, "created_at": iso(days=0, hours=10 + index % 5)})

    # Rich community and media activity.  The local preview uses the same
    # object shape for text posts, image posts, and stories.
    post_number = 1
    for index, user in enumerate(users):
        for slot in range(2):
            media = {"type": "image/png", "name": "SwapLabs demo community visual", "size": 0, "url": "/assets/home-reference-community.jpg"} if (index + slot) % 4 == 0 else None
            body = [
                f"DEMO note: I am practising {values(user['profile']['skills_to_teach'])[0]} this week. What is one small experiment that helped you?",
                f"A useful learning loop: try {values(user['profile']['skills_to_teach'])[0]}, explain what changed, then ask someone to challenge the next step.",
                f"Community prompt: what would make {values(user['profile']['skills_to_learn'])[0]} feel less intimidating for a beginner?",
                "A good exchange does not need a perfect plan — it needs a clear question and a generous follow-up.",
            ][(index + slot) % 4]
            add(state, "posts", {"id": bulk_id("post", post_number), "author": build_public_user(user, state), "author_id": user["id"], "body": body, "visibility": "public", "media": media, "counts": {"likes": 2 + (index % 9), "comments": 1 + (slot % 3), "shares": index % 4}, "viewer_liked": False, "viewer_shared": False, "created_at": iso(days=-((index + slot) % 23), hours=8 + slot * 3)})
            post_number += 1
    story_number = 1
    for index, user in enumerate(users[:20]):
        add(state, "stories", {"id": bulk_id("story", story_number), "author": build_public_user(user, state), "author_id": user["id"], "body": f"DEMO story: today I am sharing a quick {values(user['profile']['skills_to_teach'])[0]} practice prompt.", "visibility": "public", "media": {"type": "image/png", "name": "Demo story card", "size": 0, "url": "/assets/home-reference-community.jpg"} if index % 2 == 0 else None, "created_at": iso(days=-(index % 2), hours=9 + index % 8), "expires_at": iso(days=3, hours=9 + index % 8)})
        story_number += 1

    # Blogs and comments make the longer-form media experience populated.
    blog_number = 1
    for index, user in enumerate(users[:12]):
        skill = values(user["profile"]["skills_to_teach"])[0]
        blog_id = bulk_id("blog", blog_number)
        add(state, "blogs", {"id": blog_id, "author_id": user["id"], "title": f"DEMO field note: starting with {skill}", "excerpt": f"A short, practical note from a synthetic SwapLabs member about learning {skill}.", "body": f"This is a synthetic local preview article. I started with one small question about {skill}, found a generous peer, and turned the conversation into a practice step.\n\nThe useful part was not having every answer. It was naming what I already knew, trying one concrete example, and writing down what I would do next. That is the kind of progress SwapLabs is designed to make visible.", "tags": [skill, "Peer learning", "DEMO"], "visibility": "public", "media": [{"type": "image/png", "name": "Demo community visual", "size": 0, "url": "/assets/home-reference-community.jpg"}] if index % 3 != 1 else [], "like_user_ids": [users[(index + 1) % len(users)]["id"], users[(index + 4) % len(users)]["id"]], "share_user_ids": [users[(index + 7) % len(users)]["id"]], "counts": {"likes": 2, "comments": 3, "shares": 1}, "status": "published", "created_at": iso(days=-(index + 2), hours=12), "updated_at": iso(days=-(index + 2), hours=12)})
        for comment_index in range(1, 4):
            commenter = users[(index + comment_index + 5) % len(users)]
            add(state, "blog_comments", {"id": bulk_id("blog-comment", blog_number * 10 + comment_index), "blog_id": blog_id, "author_id": commenter["id"], "body": f"DEMO comment from {commenter['profile']['first_name']}: I am taking this into my next exchange.", "created_at": iso(days=-(index + 1), hours=13 + comment_index)})
        blog_number += 1

    # Ideas, courses, portfolios, and journals broaden the content surfaces.
    for index, user in enumerate(users[:12], 1):
        skill = values(user["profile"]["skills_to_teach"])[0]
        owner = build_public_user(user, state)
        comments = []
        for comment_index in range(2):
            commenter = users[(index + comment_index + 3) % len(users)]
            comments.append({"id": bulk_id("idea-comment", index * 10 + comment_index + 1), "author_id": commenter["id"], "author": build_public_user(commenter, state), "body": f"DEMO support: this would help people practise {skill} with less friction.", "created_at": iso(days=-index, hours=15 + comment_index)})
        add(state, "ideas", {"id": bulk_id("idea", index), "title": f"{skill} starter kits for curious learners", "summary": f"A small set of prompts and examples that helps a beginner start {skill} without a gatekeeper.", "tagline": f"A calmer first step into {skill}.", "category": "Community learning", "stage": ("pilot", "seeking_support", "published")[index % 3], "problem": "People often need a smaller, safer starting point before committing to a long course.", "solution": f"Create a lightweight set of prompts, examples, and peer checkpoints for {skill}.", "beneficiaries": "Students, career changers, and community members", "impact": "More useful first exchanges and clearer next steps.", "funding_currency": "time credits", "funding_needed": 20 + index * 3, "funds_use": "Facilitation, accessibility, and community documentation.", "skills_needed": [skill, values(user["profile"]["skills_to_learn"])[0], "Community building"], "collaboration": "Hosts, reviewers, and curious members", "reach": "Local and online learning circles", "prototype_url": "https://example.com/demo-relayskills-idea-" + str(index), "pitch": f"DEMO pitch for a kinder way to start learning {skill}.", "status": "published", "owner_id": user["id"], "owner": owner, "owner_age_group": "adult", "safety_review_status": "not required", "guardian_consent_status": "not required", "specialist_reviewer_id": "", "moderation_notes": "Synthetic local preview record.", "created_at": iso(days=-(index + 3), hours=14), "like_count": 4 + index, "save_count": 2 + index % 4, "comment_count": len(comments), "like_user_ids": [users[(index + 1) % len(users)]["id"]], "save_user_ids": [users[(index + 2) % len(users)]["id"]], "comments": comments, "pledges": []})
        state["portfolios"][user["id"]] = {"title": f"{user['profile']['display_name']}'s DEMO portfolio", "headline": user["profile"]["headline"], "intro": f"A synthetic collection of practice, exchange notes, and next steps around {skill}.", "visibility": "public", "accent": user["profile"]["profile_color"], "links": [], "show_completed_jobs": True, "show_journal": True, "show_ideas": True, "show_workshops": True, "projects": [{"id": bulk_id("project", index * 2 - 1), "title": f"A practical {skill} experiment", "summary": "A synthetic portfolio item connected to a local demo exchange.", "description": "A synthetic portfolio item connected to a local demo exchange.", "role": user["profile"]["professional_role"], "skills": [skill, values(user["profile"]["skills_to_learn"])[0]], "status": "complete", "created_at": iso(days=-(index + 4), hours=16)}, {"id": bulk_id("project", index * 2), "title": "Next small step", "summary": "A second synthetic project card to exercise the portfolio layout.", "description": "A second synthetic project card to exercise the portfolio layout.", "role": "Collaborator", "skills": [values(user["profile"]["skills_to_learn"])[0]], "status": "in progress", "created_at": iso(days=-(index + 2), hours=16)}]}
        state["achievements"][user["id"]] = ["profile-starter", "curious-teacher", "learning-direction", "reflection-keeper"]
        state["onboarding"][user["id"]] = True
        add(state, "journals", {"id": bulk_id("journal-practice", index), "user_id": user["id"], "title": "DEMO weekly practice note", "skill": skill, "minutes": 25 + index * 3, "practice_minutes": 25 + index * 3, "confidence": 3 + index % 3, "mood": ("curious", "energized", "focused")[index % 3], "visibility": "private", "reflection": f"I practised {skill} in a small, repeatable way and wrote down what became clearer.", "next_step": f"Try one more {skill} exercise before the next exchange.", "created_at": iso(days=-(index + 1), hours=17)})

    course_categories = ["Web design", "Backend development", "Data and AI", "Creative skills", "Communication", "Wellbeing", "Product", "Online safety", "Languages", "Photography", "Analytics", "Making"]
    for index, category in enumerate(course_categories, 1):
        owner = users[(index * 3) % len(users)]
        skill = values(owner["profile"]["skills_to_teach"])[0]
        add(state, "courses", {"id": bulk_id("course", index), "owner_id": owner["id"], "title": f"DEMO mini-course: {skill} in three practice steps", "description": f"A compact local-preview course for getting started with {skill} through examples, reflection, and a useful next step.", "category": category, "level": "Beginner friendly" if index % 2 else "Intermediate", "estimated_hours": 1.5 + (index % 4) * 0.5, "resource_url": f"https://example.com/relayskills-demo-course-{index}", "visibility": "public", "status": "published", "lessons": [{"id": "lesson-1", "title": "Choose a small outcome", "description": "Name what you want to be able to do by the end of the practice.", "resource_url": "https://example.com/lesson-1"}, {"id": "lesson-2", "title": "Try one example", "description": f"Work through a short {skill} example with a peer.", "resource_url": "https://example.com/lesson-2"}, {"id": "lesson-3", "title": "Reflect and continue", "description": "Write down what changed and choose the next small step.", "resource_url": "https://example.com/lesson-3"}], "created_at": iso(days=-(index + 6), hours=11), "updated_at": iso(days=-(index + 2), hours=11), "published_at": iso(days=-(index + 2), hours=11)})

    # Live media, tasks, credit vouchers, feedback, and admin queues.
    for index in range(1, 11):
        host = users[(index * 4) % len(users)]
        add(state, "livestreams", {"id": bulk_id("livestream", index), "host_id": host["id"], "title": f"DEMO live room: {values(host['profile']['skills_to_teach'])[0]}", "description": "A synthetic local broadcast with time for questions and peer feedback.", "category": "Community practice", "tags": ["DEMO", "live practice", values(host["profile"]["skills_to_teach"])[0]], "scheduled_at": iso(days=-1 if index % 4 == 0 else 2 + index, hours=18), "started_at": iso(days=-1, hours=18) if index % 4 == 0 else None, "ended_at": iso(days=-1, hours=19) if index % 4 == 0 else None, "status": "ended" if index % 4 == 0 else ("live" if index % 3 == 0 else "scheduled"), "duration_minutes": 90, "credits_donated": index * 2, "reward_credits_awarded": index, "host": build_public_user(host, state), "viewer_count": 8 + index * 3})
    for index in range(1, 21):
        owner = users[(index * 5) % len(users)]
        skill = values(owner["profile"]["skills_to_teach"])[0]
        add(state, "swapjobs", {"id": bulk_id("swapjob", index), "owner_id": owner["id"], "owner": build_public_user(owner, state), "title": f"DEMO task: make progress on {skill}", "description": f"A synthetic task for someone who can share a focused first step in {skill}.", "skills_needed": [skill, values(owner["profile"]["skills_to_learn"])[0]], "status": ("open", "in progress", "completed")[index % 3], "proposal_count": 2 + index % 6, "created_at": iso(days=-(index % 18), hours=10 + index % 6)})
    for index in range(1, 9):
        owner = users[(index * 4) % len(users)]
        add(state, "vouchers", {"id": bulk_id("voucher", index), "creator_id": owner["id"], "amount": 5 + index, "status": "active", "code_preview": f"RS-DEMO-{index:02d}-••••", "code": f"RS-DEMO-{index:02d}-LOCAL-ONLY"})

    for index in range(1, 21):
        author = users[(index * 2) % len(users)]
        add(state, "feedback", {"id": bulk_id("feedback", index), "name": author["profile"]["display_name"], "email": author["email"], "role": f"DEMO member · {values(author['profile']['skills_to_teach'])[0]}", "rating": 4 + index % 2, "title": "A useful next step", "message": "This synthetic local review shows how a focused exchange can turn a vague goal into something practical.", "permission_to_publish": True, "publication_permission": True, "featured": index <= 4, "request_type": "feedback", "author_id": author["id"], "status": "published", "admin_notes": "Synthetic local preview record.", "created_at": iso(days=-(index % 20), hours=13)})
    for index in range(1, 11):
        author = users[(index * 3) % len(users)]
        add(state, "contact_messages", {"id": bulk_id("contact", index), "name": author["profile"]["display_name"], "email": author["email"], "user_id": author["id"], "topic": ("Account access", "Workshops and events", "Matching", "Credits")[index % 4], "preferred_contact": "Email", "subject": f"DEMO question about {values(author['profile']['skills_to_learn'])[0]}", "message": "Synthetic local queue item for testing the operations response workflow.", "status": ("new", "reviewing", "in_progress")[index % 3], "admin_notes": "Synthetic local preview record.", "created_at": iso(days=-(index % 15), hours=9 + index % 4)})
    for index in range(1, 9):
        author = users[(index * 5) % len(users)]
        add(state, "complaints", {"id": bulk_id("complaint", index), "name": author["profile"]["display_name"], "email": author["email"], "user_id": author["id"], "category": ("Account access or profile", "Workshop delivery", "Credit balance", "Community content")[index % 4], "priority": ("standard", "time-sensitive")[index % 2], "subject": "DEMO operational review request", "reference": f"DEMO-CASE-{index:03d}", "details": "Synthetic local queue item with enough context for an administrator to practise triage and resolution.", "resolution": "Please confirm the owner and the next practical step.", "status": ("received", "reviewing", "resolved")[index % 3], "admin_notes": "Synthetic local preview record.", "created_at": iso(days=-(index % 12), hours=10), "updated_at": iso(days=-(index % 5), hours=11)})
    for index in range(1, 7):
        author = users[(index * 6) % len(users)]
        add(state, "disputes", {"id": bulk_id("dispute", index), "user_id": author["id"], "ledger_entry_id": bulk_id("ledger-fee", index), "reason": "Incorrect amount", "details": "Synthetic local credit review record.", "status": ("open", "reviewing", "resolved")[index % 3], "created_at": iso(days=-(index % 10), hours=12)})

    # A few non-sensitive content review records keep the admin moderation
    # surface active without inventing safety allegations.
    for index in range(1, 7):
        target_post = bulk_id("post", index)
        reporter = users[(index + 9) % len(users)]
        add(state, "reports", {"id": bulk_id("report", index), "reporter_id": reporter["id"], "target_type": "community_post", "target_id": target_post, "reason": "Duplicate or off-topic content", "details": "Synthetic local preview report for testing the review queue.", "status": ("open", "reviewing", "resolved")[index % 3], "created_at": iso(days=-(index % 9), hours=16)})

    add(state, "session_point_reviews", {"id": bulk_id("session-review", 1), "event_id": completed_event_ids[0], "status": "resolved", "reason": "quality_review", "rating_count": 2, "bad_count": 0, "eligible_count": 2, "rating_ids": [bulk_id("rating", 1), bulk_id("rating", 2)], "transcript": [], "created_at": iso(days=-2, hours=16), "updated_at": iso(days=-1, hours=10), "admin_id": next((user["id"] for user in state["users"] if user.get("role") == "admin"), ""), "admin_notes": "Synthetic local preview review closed after checking the exchange transcript."})
    add(state, "adminMessages", {"id": bulk_id("admin-message", 1), "subject": "DEMO community expansion ready", "body": "Forty synthetic accounts and broad cross-surface activity are available in the local preview.", "status": "sent", "created_at": iso(days=0, hours=11)})
    add(state, "adminMessages", {"id": bulk_id("admin-message", 2), "subject": "DEMO activity map", "body": "Profiles, matches, sessions, reports, credits, media, workshops, and dashboards now have local sample data.", "status": "sent", "created_at": iso(days=0, hours=11, minutes=5)})

    # Refresh stored author/owner snapshots after the accounts have accumulated
    # follows, sessions, ideas, and points.
    for collection in ("posts", "stories", "swapjobs"):
        for record in state[collection]:
            if is_seed_record(record):
                owner_id = record.get("author_id") or record.get("owner_id")
                owner = by_id.get(owner_id)
                if owner:
                    if "author_id" in record:
                        record["author"] = build_public_user(owner, state)
                    if "owner_id" in record:
                        record["owner"] = build_public_user(owner, state)
    for record in state["blogs"]:
        if is_seed_record(record):
            owner = by_id.get(record.get("author_id"))
            if owner:
                record["author_id"] = owner["id"]
    for record in state["ideas"]:
        if is_seed_record(record):
            owner = by_id.get(record.get("owner_id"))
            if owner:
                record["owner"] = build_public_user(owner, state)
                for comment in record.get("comments", []):
                    commenter = by_id.get(comment.get("author_id"))
                    if commenter:
                        comment["author"] = build_public_user(commenter, state)

    return users, by_id


def unique_record_id(item, index: int, used: set[str]) -> str:
    if isinstance(item, dict):
        for field in ("id", "key", "slug", "username"):
            if item.get(field) not in (None, ""):
                candidate = str(item[field])
                break
        else:
            candidate = f"row-{index:08d}"
    else:
        candidate = f"row-{index:08d}"
    result = candidate
    suffix = 2
    while result in used:
        result = f"{candidate}-{suffix}"
        suffix += 1
    used.add(result)
    return result


def save_state(connection: sqlite3.Connection, state: dict) -> int:
    updated_at = iso()
    connection.execute("BEGIN IMMEDIATE")
    try:
        for collection in LIST_COLLECTIONS + DICT_COLLECTIONS:
            connection.execute(f"DELETE FROM {table_name(collection)}")
        connection.execute("DELETE FROM app_kv WHERE namespace = 'state'")
        record_count = 0
        for collection in LIST_COLLECTIONS:
            used: set[str] = set()
            rows = []
            for index, item in enumerate(state.get(collection, [])):
                record_id = unique_record_id(item, index, used)
                rows.append((record_id, json.dumps(item, ensure_ascii=False, separators=(",", ":")), updated_at))
            if rows:
                connection.executemany(f"INSERT INTO {table_name(collection)}(record_id, record_json, updated_at) VALUES (?, ?, ?)", rows)
                record_count += len(rows)
        for collection in DICT_COLLECTIONS:
            rows = [(str(key), json.dumps(item, ensure_ascii=False, separators=(",", ":")), updated_at) for key, item in state.get(collection, {}).items()]
            if rows:
                connection.executemany(f"INSERT INTO {table_name(collection)}(record_id, record_json, updated_at) VALUES (?, ?, ?)", rows)
                record_count += len(rows)
        kv_rows = []
        for key, value in state.items():
            if key in ALL_COLLECTIONS:
                if key in LIST_COLLECTIONS and isinstance(value, list):
                    continue
                if key in DICT_COLLECTIONS and isinstance(value, dict):
                    continue
            kv_rows.append(("state", str(key), json.dumps(value, ensure_ascii=False, separators=(",", ":")), updated_at))
        if kv_rows:
            connection.executemany("INSERT INTO app_kv(namespace, item_key, value_json, updated_at) VALUES (?, ?, ?, ?)", kv_rows)
            record_count += len(kv_rows)
        connection.execute("INSERT INTO schema_meta(meta_key, meta_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value, updated_at=excluded.updated_at", ("state_initialized", "1", updated_at))
        connection.execute("INSERT INTO schema_meta(meta_key, meta_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value, updated_at=excluded.updated_at", ("schema_version", "4", updated_at))
        connection.execute("INSERT INTO schema_meta(meta_key, meta_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value, updated_at=excluded.updated_at", ("last_write_at", updated_at, updated_at))
        connection.execute("INSERT INTO schema_meta(meta_key, meta_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value, updated_at=excluded.updated_at", ("last_record_count", str(record_count), updated_at))
        connection.commit()
        return record_count
    except Exception:
        connection.rollback()
        raise


def main() -> None:
    connection = sqlite3.connect(str(DB_PATH), timeout=30)
    try:
        ensure_storage(connection)
        state = load_state(connection)
        remove_previous_seed(state)
        users, _ = build_seed(state)
        state["bulkDemoSeedVersion"] = SEED_VERSION
        state["bulkDemoSeedSummary"] = {
            "accounts_added": len(users),
            "password": DEMO_PASSWORD,
            "synthetic_only": True,
            "seeded_at": iso(),
            "coverage": ["profiles", "matching", "messages", "calendar", "sessions", "progress reports", "credits", "community", "media", "workshops", "ideas", "courses", "portfolios", "livestreams", "admin queues"],
        }
        record_count = save_state(connection, state)
        print(json.dumps({
            "ok": True,
            "database": str(DB_PATH),
            "seed_version": SEED_VERSION,
            "accounts_added": len(users),
            "demo_password": DEMO_PASSWORD,
            "record_count": record_count,
            "collections": {collection: len(state.get(collection, {} if collection in DICT_COLLECTIONS else [])) for collection in LIST_COLLECTIONS + DICT_COLLECTIONS},
        }, indent=2))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
