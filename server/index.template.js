import {DurableObject} from "cloudflare:workers";
import {scryptSync} from "node:crypto";

/* MONTHLY_CREDIT_IMPLEMENTATION */

// The direct Cloudflare deployment is self-contained. Keep the old tunnel
// path disabled so production never depends on a temporary developer URL.
const UPSTREAM_ORIGIN = "";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade"
]);
const PUBLIC_API_CACHE = new Set([
  "/api/public/content", "/api/testimonials", "/api/leaderboard"
]);
const RETIRED_ROUTE_REDIRECTS = new Map([
  ["/early-home.html", "/"],
  ["/early-registration.html", "/register.html"],
  ["/early-registration-success.html", "/"],
  ["/pre-registration.html", "/register.html"],
  ["/swaplabs.html", "/"]
]);
const PUBLIC_CACHE_TTL_MS = 30_000;
const PUBLIC_CACHE_STALE_MS = 120_000;
const PUBLIC_MEMORY_CACHE = new Map();
const PUBLIC_IN_FLIGHT = new Map();
// Anonymous directory/feed reads are backed by the hosted D1 database. Keep a
// very short worker-local cache for those reads so every page refresh does not
// repeat the same multi-query D1 round trip. A real session is never cached.
const LOCAL_PUBLIC_API_CACHE = new Set([
  "/api/community", "/api/community/feed", "/api/community/groups", "/api/livestreams",
  "/api/public/content", "/api/testimonials", "/api/leaderboard"
]);
const LOCAL_CACHE_TTL_MS = 10_000;
const LOCAL_CACHE_STALE_MS = 30_000;
const LOCAL_MEMORY_CACHE = new Map();
const LOCAL_IN_FLIGHT = new Map();
// The platform cache is a shared, rebuildable secondary-memory layer for
// anonymous D1-backed reads. It never becomes the source of truth and can be
// unavailable without blocking a durable write or a direct D1 read.
const EDGE_CACHE_NAMESPACE = "d1-r2-edge-v1";
const EDGE_CACHE_TTL_SECONDS = 10;
const EDGE_CACHE_STALE_SECONDS = 30;
// Only transient in-process context for a trusted, server-created review
// replay. No browser request can set this WeakMap key or forge this context.
const MODERATION_REPLAY_CONTEXTS = new WeakMap();
const MODERATION_ACTOR_OVERRIDE = Symbol("relayskills.moderation.actor");
const MODERATION_TRUSTED_REPLAY = Symbol("relayskills.moderation.replay");

const PROFILE_FIELDS = [
  "first_name", "last_name", "display_name", "phone_number", "pronouns", "gender", "date_of_birth", "age",
  "country", "city", "timezone", "primary_language", "additional_languages", "languages_to_learn", "occupation",
  "professional_role", "organization", "headline", "bio", "website", "availability", "preferred_format",
  "teaching_style", "experience_level", "learning_goal", "skills_to_teach", "skills_to_learn", "skill_details", "interests",
  "profile_color", "avatar_url"
];
const PROFILE_LIMITS = {
  first_name: 80, last_name: 80, display_name: 120, phone_number: 32, pronouns: 80, gender: 100, date_of_birth: 20, age: 4,
  country: 120, city: 120, timezone: 120, primary_language: 80, additional_languages: 300, languages_to_learn: 300, occupation: 140,
  professional_role: 140, organization: 180, headline: 140, bio: 700, website: 300, availability: 180,
  preferred_format: 80, teaching_style: 120, experience_level: 60, learning_goal: 1000, skills_to_teach: 12000,
  skills_to_learn: 12000, skill_details: 50000, interests: 12000, profile_color: 20, avatar_url: 120
};
const DEFAULT_PREFERENCES = {
  match_visibility: true, show_location: true, email_notifications: true, weekly_digest: true,
  profile_visibility: "public", theme: "light", font_scale: "default", content_density: "comfortable",
  navigation_style: "expanded", default_landing: "dashboard", high_contrast: false, reduced_motion: false,
  link_underlines: false, focus_mode: false, show_ai_assistant: true, auto_play_testimonials: true
};
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_ITERATIONS = 100_000;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const ONLINE_PRESENCE_WINDOW_SECONDS = 60 * 60;
const ONLINE_PRESENCE_HISTORY_SECONDS = 14 * 24 * 60 * 60;
const ALLOWED_COMMUNITY_MEDIA_TYPES = new Map([
  ["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"],
  ["video/mp4", "mp4"], ["video/webm", "webm"]
]);
const COMMUNITY_MEDIA_PATH = /^\/community-media\/(?:blog|post|story)_[A-Za-z0-9_-]+\.(?:jpg|png|webp|mp4|webm)$/;
const VOUCHER_CODE_PATTERN = /^SL-GIFT-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/;
const VOUCHER_MAX_AMOUNT = 100_000;
const NOTHING_FOR_NOW_VALUE = "nothing for now";
const DEFAULT_STREAK_TIMEZONE = "Asia/Kolkata";
const EXCHANGE_CREDIT_AMOUNT = 1;
// Early registration is intentionally time-gated on the server as well as in
// the standalone pre-launch UI. Both moments are expressed in IST so the
// public countdown and the account-creation API agree at midnight in India.
const EARLY_REGISTRATION_OPEN_AT = Date.parse("2026-10-01T00:00:00+05:30");
const PLATFORM_LAUNCH_AT = Date.parse("2026-10-04T00:00:00+05:30");
const STREAK_MILESTONES = [
  {target: 7, reward_credits: 25},
  {target: 30, reward_credits: 100},
  {target: 100, reward_credits: 400},
  {target: 365, reward_credits: 1_000}
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value, limit) {
  return String(value == null ? "" : value).trim().slice(0, limit || 500);
}

function isSyntheticDemoId(value) {
  return String(value || "").startsWith("demo-26-");
}

const NAME_FORMAT_ERROR = "Use letters and spaces only, with at least a first and last name (for example, Tenzin Joshi).";
const FULL_NAME_PATTERN = /^\p{L}+(?:\s+\p{L}+)+$/u;
const NAME_PART_PATTERN = /^\p{L}+$/u;
function validName(value, fieldName = "full_name") {
  const pattern = fieldName === "full_name" || fieldName === "display_name" ? FULL_NAME_PATTERN : NAME_PART_PATTERN;
  return pattern.test(String(value == null ? "" : value).trim());
}

function safeBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["true", "on", "1"].includes(value.toLowerCase())) return true;
    if (["false", "off", "0"].includes(value.toLowerCase())) return false;
  }
  return Boolean(fallback);
}

function passwordMeetsPolicy(password) {
  const value = String(password || "");
  return value.length >= PASSWORD_MIN_LENGTH && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value);
}

function passwordPolicyMessage() {
  return `Use at least ${PASSWORD_MIN_LENGTH} characters with uppercase, lowercase, a number, and a symbol.`;
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return isObject(parsed) ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

function jsonArray(value, fallback) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "");
    return Array.isArray(parsed) ? parsed : (fallback || []);
  } catch (_error) {
    return fallback || [];
  }
}

function normalizeWebsite(value) {
  const candidate = safeText(value, PROFILE_LIMITS.website);
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString().slice(0, PROFILE_LIMITS.website) : "";
  } catch (_error) {
    return "";
  }
}

function normalizeCourseUrl(value) {
  const candidate = safeText(value, 500);
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString().slice(0, 500) : "";
  } catch (_error) {
    return "";
  }
}

function normalizeProfile(input, previous) {
  const source = isObject(input) ? input : {};
  const old = isObject(previous) ? previous : {};
  const result = {};
  PROFILE_FIELDS.forEach(field => {
    const fallback = safeText(old[field], PROFILE_LIMITS[field] || 500);
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      result[field] = fallback;
      return;
    }
    if (field === "avatar_url") {
      result[field] = fallback;
      return;
    }
    result[field] = field === "website" ? normalizeWebsite(source[field]) : safeText(source[field], PROFILE_LIMITS[field] || 500);
  });
  if (!["indigo", "blue", "pink", "purple", "green", "orange"].includes(result.profile_color)) result.profile_color = "indigo";
  return result;
}

function ageFromDate(value) {
  const candidate = safeText(value, 20);
  const date = new Date(candidate + "T12:00:00Z");
  if (!candidate || Number.isNaN(date.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - date.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < date.getUTCMonth() ||
    (now.getUTCMonth() === date.getUTCMonth() && now.getUTCDate() < date.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

function profileAge(profile) {
  const derived = ageFromDate(profile.date_of_birth);
  if (derived !== null) return derived;
  const supplied = Number(profile.age);
  return Number.isFinite(supplied) ? Math.floor(supplied) : null;
}

function normalizePreferences(input, previous) {
  const source = isObject(input) ? input : {};
  const result = {...DEFAULT_PREFERENCES, ...(isObject(previous) ? previous : {})};
  ["match_visibility", "show_location", "email_notifications", "weekly_digest", "high_contrast",
    "reduced_motion", "link_underlines", "focus_mode", "show_ai_assistant", "auto_play_testimonials"].forEach(field => {
    if (Object.prototype.hasOwnProperty.call(source, field)) result[field] = safeBoolean(source[field], result[field]);
  });
  ["theme", "font_scale", "content_density", "navigation_style", "default_landing"].forEach(field => {
    if (Object.prototype.hasOwnProperty.call(source, field)) result[field] = safeText(source[field], 40);
  });
  if (Object.prototype.hasOwnProperty.call(source, "profile_visibility")) result.profile_visibility = source.profile_visibility === "private" ? "private" : "public";
  return result;
}

function normalizeSafety(input, profile, previous) {
  const source = isObject(input) ? input : {};
  const old = isObject(previous) ? previous : {};
  const age = profileAge(profile);
  const isMinor = Number.isFinite(age) && age >= 3 && age < 13;
  const accountType = isMinor ? "child" : "adult";
  const priorStatus = safeText(old.guardian_consent_status || "pending", 30);
  return {
    account_type: accountType,
    guardian_name: safeText(Object.prototype.hasOwnProperty.call(source, "guardian_name") ? source.guardian_name : old.guardian_name, 120),
    guardian_email: safeText(Object.prototype.hasOwnProperty.call(source, "guardian_email") ? source.guardian_email : old.guardian_email, 120),
    guardian_relationship: safeText(Object.prototype.hasOwnProperty.call(source, "guardian_relationship") ? source.guardian_relationship : old.guardian_relationship, 80),
    guardian_consent_declared: safeBoolean(Object.prototype.hasOwnProperty.call(source, "guardian_consent_declared") ? source.guardian_consent_declared : old.guardian_consent_declared, false),
    guardian_consent_status: isMinor && ["pending", "verified", "rejected"].includes(priorStatus) ? priorStatus : isMinor ? "pending" : "not_applicable",
    guardian_notes: safeText(old.guardian_notes, 2000),
    guardian_verified_at: safeText(old.guardian_verified_at, 40),
    is_minor: isMinor,
    minor_messaging: isMinor ? "connection_only" : "standard",
    innovation_access: isMinor ? "specialist_review" : "standard"
  };
}

function registrationInput(body) {
  const contact = safeText(body && (body.contact || body.email), 254);
  const isEmailContact = /^\S+@\S+\.\S+$/.test(contact);
  const phoneContact = isEmailContact ? "" : phoneLookup(contact);
  const phoneDigits = phoneContact.replace(/\D/g, "");
  const suppliedProfile = isObject(body && body.profile) ? {...body.profile} : {};
  const fullName = safeText(body && body.full_name, 120);
  if (!suppliedProfile.display_name && fullName) suppliedProfile.display_name = fullName;
  if (!isEmailContact && contact && !suppliedProfile.phone_number) suppliedProfile.phone_number = contact;
  const profile = normalizeProfile(suppliedProfile);
  if ((!profile.first_name || !profile.last_name) && profile.display_name) {
    const nameParts = profile.display_name.split(/\s+/).filter(Boolean);
    if (!profile.first_name) profile.first_name = nameParts.shift() || "";
    if (!profile.last_name) profile.last_name = nameParts.join(" ");
  }
  const suppliedPreferences = isObject(body && body.preferences) ? {...body.preferences} : {};
  // Early/pre-registration forms intentionally omit advanced settings. Treat
  // that omission as the safe matching default instead of persisting a false
  // opt-out for every new account.
  if (["early_registration", "pre_registration"].includes(safeText(body && body.registration_source, 60)) && !Object.prototype.hasOwnProperty.call(suppliedPreferences, "match_visibility")) {
    suppliedPreferences.match_visibility = true;
  }
  const preferences = normalizePreferences(suppliedPreferences);
  const safety = normalizeSafety(body && body.safety, profile);
  const errors = [];
  const username = safeText(body && body.username, 30).toLowerCase();
  const email = isEmailContact ? contact.toLowerCase() : `phone-${phoneDigits}@accounts.relayskills.local`;
  const password = String(body && body.password || "");
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) errors.push("Choose a username with 3–30 letters, numbers, dots, dashes, or underscores.");
  if (!contact || (!isEmailContact && (phoneDigits.length < 7 || phoneDigits.length > 15))) errors.push("Enter a valid email address or phone number.");
  if (!profile.display_name) errors.push("Enter your full name.");
  if (!validName(profile.display_name, "display_name") || !validName(profile.first_name, "first_name") || !validName(profile.last_name, "last_name")) errors.push(NAME_FORMAT_ERROR);
  if (!profile.date_of_birth) errors.push("Enter your date of birth so we can apply the correct safety settings.");
  const age = profileAge(profile);
  if (!Number.isFinite(age) || age < 3 || age > 120) errors.push("SwapLabs accounts are available for ages 3–120.");
  if (age !== null) profile.age = String(age);
  if (age >= 3 && age < 13) {
    preferences.show_location = false;
    if (!safety.guardian_name || !safety.guardian_email || !safety.guardian_relationship || !safety.guardian_consent_declared) {
      errors.push("A parent or guardian must provide consent for children under 13.");
    }
  }
  if (!passwordMeetsPolicy(password)) errors.push(passwordPolicyMessage());
  if (!safeBoolean(body && body.accepted_terms, false)) errors.push("Accept the Terms and Privacy Policy before creating your account.");
  return {username, email, password, profile, preferences, safety, errors};
}

function newId(prefix) {
  return prefix + "_" + randomToken(18);
}

function randomToken(size) {
  const bytes = new Uint8Array(size || 32);
  crypto.getRandomValues(bytes);
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncode(bytes) {
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return new Uint8Array(digest);
}

async function sha256Hex(value) {
  return [...await sha256(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password) {
  const salt = randomToken(16);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), {name: "PBKDF2"}, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: PASSWORD_ITERATIONS, hash: "SHA-256"
  }, key, 256);
  return "pbkdf2$sha256$" + PASSWORD_ITERATIONS + "$" + salt + "$" + base64UrlEncode(new Uint8Array(bits));
}

function constantTimeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function verifyPassword(password, stored) {
  // Preserve accounts from the original local Python/Werkzeug application.
  const legacy = /^scrypt:(32768):(8):(1)\$([A-Za-z0-9]+)\$([a-f0-9]{128})$/.exec(String(stored || ""));
  if (legacy) {
    try {
      const actual = scryptSync(String(password || ""), legacy[4], 64, {
        N: Number(legacy[1]), r: Number(legacy[2]), p: Number(legacy[3]), maxmem: 132 * 32768 * 8
      }).toString("hex");
      return constantTimeEqual(actual, legacy[5]);
    } catch (_error) { return false; }
  }
  const parts = String(stored || "").split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 500_000) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password || "")), {name: "PBKDF2"}, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2", salt: new TextEncoder().encode(parts[3]), iterations, hash: "SHA-256"
  }, key, 256);
  return constantTimeEqual(base64UrlEncode(new Uint8Array(bits)), parts[4]);
}

function parseCookies(request) {
  const result = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try { result[name] = decodeURIComponent(value); } catch (_error) { result[name] = value; }
  }
  return result;
}

function cookieDomainForRequest(request) {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return hostname === "relayskills.com" || hostname === "www.relayskills.com" ? "relayskills.com" : "";
  } catch (_error) {
    return "";
  }
}

function cookieHeader(name, value, options) {
  const settings = options || {};
  const parts = [name + "=" + encodeURIComponent(value), "Path=/", "SameSite=Lax", "Max-Age=" + (settings.maxAge == null ? 86400 : settings.maxAge)];
  if (settings.secure !== false) parts.push("Secure");
  if (settings.domain) parts.push("Domain=" + settings.domain);
  if (settings.httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}

function expiredCookie(name, options) {
  const settings = options || {};
  const parts = [name + "=; Path=/; SameSite=Lax; Secure; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (settings.domain) parts.push("Domain=" + settings.domain);
  return parts.join("; ");
}

function authCookieHeaders(request, name, value, options) {
  const domain = cookieDomainForRequest(request);
  const localHttp = new URL(request.url).protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname);
  const scopedOptions = {...(options || {}), secure: !localHttp, ...(domain ? {domain} : {})};
  const cookies = [cookieHeader(name, value, scopedOptions)];
  if (domain) cookies.push(expiredCookie(name));
  return cookies;
}

function expiredAuthCookieHeaders(request, name) {
  const domain = cookieDomainForRequest(request);
  const cookies = [expiredCookie(name)];
  if (domain) cookies.push(expiredCookie(name, {domain}));
  return cookies;
}

function apiResponse(payload, status, cookies) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-swappublic-api": "local"
  });
  (cookies || []).forEach(cookie => headers.append("set-cookie", cookie));
  return new Response(JSON.stringify(payload), {status: status || 200, headers});
}

function publicApiResponse(request, payload, status, cookies) {
  const response = apiResponse(payload, status, cookies);
  const origin = request.headers.get("origin") || "";
  if (origin === "http://localhost:8000" || origin === "http://127.0.0.1:8000") {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("vary", "Origin");
  }
  return response;
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : {};
  } catch (_error) {
    throw Object.assign(new Error("Send the request as JSON."), {status: 400});
  }
}

async function readFeatureBody(request, path) {
  const replayContext = MODERATION_REPLAY_CONTEXTS.get(request);
  if (replayContext && replayContext.path === path) return replayContext.body || {};
  const contentType = request.headers.get("content-type") || "";
  if (path === "/api/blog/posts" && request.method.toUpperCase() === "POST" && contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    return {
      title: form.get("title") || "",
      excerpt: form.get("excerpt") || "",
      body: form.get("body") || "",
      tags: form.get("tags") || "",
      visibility: form.get("visibility") || "public",
      media: form.getAll("media").filter(file => file && typeof file.arrayBuffer === "function")
    };
  }
  return readJson(request);
}

function dbFor(env) {
  if (!env || !env.DB) throw new Error("The hosted account database is not configured.");
  return env.DB;
}

function edgeCacheFor() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch (_error) {
    return null;
  }
}

function edgeCacheKey(request, path) {
  const url = new URL(request.url);
  url.pathname = path;
  url.searchParams.set("__storage_cache", EDGE_CACHE_NAMESPACE);
  return new Request(url.toString(), {method: "GET"});
}

async function readEdgeCache(request, path) {
  const cache = edgeCacheFor();
  if (!cache) return null;
  try {
    const response = await cache.match(edgeCacheKey(request, path));
    if (!response) return null;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("set-cookie");
    headers.delete("vary");
    return {
      body: await response.text(),
      status: response.status,
      statusText: response.statusText,
      headers,
      cacheSource: "d1-edge",
      expiresAt: Date.now() + LOCAL_CACHE_TTL_MS,
      staleUntil: Date.now() + LOCAL_CACHE_TTL_MS + LOCAL_CACHE_STALE_MS
    };
  } catch (_error) {
    return null;
  }
}

function publishEdgeCache(ctx, request, path, entry) {
  const cache = edgeCacheFor();
  if (!cache || !entry) return;
  const task = (async () => {
    const headers = new Headers(entry.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("set-cookie");
    headers.delete("vary");
    headers.set("cache-control", `public, max-age=${EDGE_CACHE_TTL_SECONDS}, stale-while-revalidate=${EDGE_CACHE_STALE_SECONDS}`);
    headers.set("x-swappublic-cache", "d1-edge");
    await cache.put(edgeCacheKey(request, path), new Response(entry.body, {
      status: entry.status,
      statusText: entry.statusText,
      headers
    }));
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(task.catch(() => null));
  else task.catch(() => null);
}

async function storageStatus(_request, env) {
  const result = {
    ok: false,
    mode: "managed-platform-storage",
    architecture: {
      source_of_truth: "Cloudflare D1",
      secondary_memory: "Cloudflare Workers Cache API with worker-local fallback",
      object_storage: "Cloudflare R2",
      writes_to_cache: false
    },
    d1: {binding: "DB", ready: false, application_tables: 0},
    r2: {binding: "BUCKET", ready: Boolean(env && env.BUCKET), required_for: ["community media uploads", "blog media uploads", "chat attachments"]},
    cache: {provider: "Workers Cache API", ready: Boolean(edgeCacheFor()), rebuildable: true, ttl_seconds: EDGE_CACHE_TTL_SECONDS},
    checked_at: new Date().toISOString()
  };
  if (env && env.DB) {
    try {
      const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'sl_%'").first();
      result.d1.ready = true;
      result.d1.application_tables = Number(row && row.count || 0);
    } catch (_error) {
      result.d1.ready = false;
    }
  }
  // D1 is the account/database source of truth. Keep the health flag useful
  // when R2 is not subscribed yet: the database is healthy, while media
  // uploads are explicitly reported as degraded below.
  result.ok = Boolean(result.d1.ready);
  result.degraded = !result.r2.ready;
  result.warnings = result.degraded ? ["Cloudflare R2 is not enabled; existing bundled photos can be served, but new media uploads are unavailable until R2 is activated."] : [];
  return apiResponse(result);
}

async function findUserById(db, id) {
  return db.prepare("SELECT * FROM sl_users WHERE id = ? LIMIT 1").bind(String(id)).first();
}

function phoneLookup(value) {
  return safeText(value, 32).replace(/[^\d+]/g, "");
}

async function findUserByLogin(db, login) {
  const normalized = safeText(login, 254).toLowerCase();
  const phone = phoneLookup(login);
  // Empty phone lookups must never match empty profile phone fields. The old
  // three-way OR treated every username/email login as a phone lookup with an
  // empty value, so SQLite could return an unrelated account before the exact
  // username row. Check direct identifiers first, then use phone matching only
  // when the input actually contains phone digits.
  const direct = await db.prepare("SELECT * FROM sl_users WHERE lower(username) = lower(?) OR lower(email) = lower(?) ORDER BY CASE WHEN lower(username) = lower(?) THEN 0 ELSE 1 END, created_at ASC LIMIT 1")
    .bind(normalized, normalized, normalized).first();
  if (direct || !phone) return direct;
  return db.prepare("SELECT * FROM sl_users WHERE replace(replace(replace(replace(json_extract(profile_json, '$.phone_number'), ' ', ''), '-', ''), '(', ''), ')', '') = ? LIMIT 1")
    .bind(phone).first();
}

async function allUserRows(db) {
  const result = await db.prepare("SELECT * FROM sl_users ORDER BY created_at DESC").all();
  return result.results || [];
}

function rowParts(row) {
  const profile = parseJson(row.profile_json, normalizeProfile({}));
  const rawSafety = parseJson(row.safety_json, {});
  return {
    profile,
    preferences: normalizePreferences(parseJson(row.preferences_json, {})),
    safety: normalizeSafety(rawSafety, profile, rawSafety)
  };
}

function completeName(profile, username) {
  return [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.display_name || username || "SwapLabs member";
}

function publicAvatarUrl(value) {
  const source = String(value || "");
  // /uploads is retained for R2 compatibility, while /profile-media avoids
  // clients and extensions that incorrectly block a generic upload path.
  return /^\/uploads\/usr_[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/.test(source)
    ? source.replace(/^\/uploads\//, "/profile-media/")
    : source;
}

function reputation() {
  return {rating: null, review_count: 0, completed_sessions: 0, reliability_known: false, reliability_score: 0};
}

function commonPublicFields(row, profile, preferences, safety, viewerId, relationship, counts) {
  const self = viewerId && row.id === viewerId;
  const relation = relationship || "none";
  const publicProfile = preferences.profile_visibility !== "private";
  const canViewFull = Boolean(self || publicProfile || relation === "following");
  const fullName = completeName(profile, row.username);
  const visible = {
    display_name: profile.display_name || fullName,
    full_name: canViewFull ? fullName : (profile.display_name || row.username),
    profile_color: profile.profile_color || "indigo",
    // A profile photo is a basic identity signal, including on a private
    // profile preview. Protected fields remain redacted below until access is
    // granted, but avatars should render consistently across the directory,
    // media, inbox, and profile cards.
    avatar_url: publicAvatarUrl(profile.avatar_url),
    headline: canViewFull ? profile.headline || "" : "",
    professional_role: canViewFull ? profile.professional_role || "" : "",
    occupation: canViewFull ? profile.occupation || "" : ""
  };
  if (canViewFull) {
    ["bio", "website", "availability", "preferred_format", "teaching_style", "experience_level", "learning_goal",
      "skills_to_teach", "skills_to_learn", "interests", "primary_language", "additional_languages", "languages_to_learn", "organization", "pronouns"]
      .forEach(field => {
        visible[field] = field === "skills_to_teach" ? [...new Set([...csvValues(profile.skills_to_teach), ...csvValues(profile.additional_languages)])] : field === "skills_to_learn" ? [...new Set([...csvValues(profile.skills_to_learn), ...csvValues(profile.languages_to_learn)])] : ["interests", "additional_languages", "languages_to_learn"].includes(field) ? csvValues(profile[field]) : profile[field] || "";
      });
    if (self) {
      ["additional_languages", "languages_to_learn"].forEach(field => { visible[field] = profile[field] || ""; });
      ["first_name", "last_name", "phone_number", "date_of_birth", "age", "city", "country", "timezone"]
        .forEach(field => { visible[field] = profile[field] || ""; });
    } else if (preferences.show_location) {
      visible.city = profile.city || "";
      visible.country = profile.country || "";
      visible.timezone = "";
    }
  } else {
    visible.city = "Private";
    visible.country = "Private";
  }
  return {
    id: row.id, username: row.username, role: "member", status: row.status, verified: Boolean(row.verified),
    visibility: publicProfile ? "public" : "private", relationship: self ? "self" : relation, can_view_full: canViewFull,
    profile: visible, followers_count: Number(counts?.followers_count || 0), following_count: Number(counts?.following_count || 0), published_idea_count: 0, reputation: reputation(),
    messaging_available: !safety.is_minor, swap_requests_available: !safety.is_minor,
    availability: canViewFull ? {label: profile.availability || "Availability not listed", available_now: false} : {label: "Private availability", available_now: false},
    joined_at: row.created_at, created_at: row.created_at, updated_at: row.updated_at
  };
}

let featureSchemaPromise;
let notificationTitleSchemaPromise;
let communitySeedPromise;

async function ensureFeatureSchema(db) {
  if (!featureSchemaPromise) {
    featureSchemaPromise = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS sl_user_presence (user_id TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL, page_path TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_user_presence_last_seen ON sl_user_presence(last_seen_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_user_presence_days (user_id TEXT NOT NULL REFERENCES sl_users(id) ON DELETE CASCADE, day_key TEXT NOT NULL, last_seen_at TEXT NOT NULL, page_path TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY (user_id, day_key))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_user_presence_days_last_seen ON sl_user_presence_days(last_seen_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_follows (id TEXT PRIMARY KEY, follower_id TEXT NOT NULL, following_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_follows_pair_unique ON sl_follows(follower_id, following_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_follows_following_status ON sl_follows(following_id, status)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_follows_follower_status ON sl_follows(follower_id, status)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, actor_id TEXT, type TEXT NOT NULL, entity_id TEXT, message TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_notifications_user_read_created ON sl_notifications(user_id, read, created_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_direct_conversations (pair_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_direct_conversations_id ON sl_direct_conversations(conversation_id)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (blocker_id, blocked_id))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_blocks_blocked ON sl_blocks(blocked_id)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_message_visibility (message_id TEXT NOT NULL, user_id TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, PRIMARY KEY (message_id, user_id))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_message_visibility_user_hidden ON sl_message_visibility(user_id, hidden)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_community_groups (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Community', icon TEXT NOT NULL DEFAULT 'bx-group', accent TEXT NOT NULL DEFAULT 'blue', requires_approval INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_community_groups_created ON sl_community_groups(created_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_community_group_members (group_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (group_id, user_id))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_community_group_members_user_status ON sl_community_group_members(user_id, status)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_community_group_join_requests (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_community_group_join_requests_unique ON sl_community_group_join_requests(group_id, user_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_community_group_join_requests_group_status ON sl_community_group_join_requests(group_id, status)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_livestreams (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Community', tags_json TEXT NOT NULL DEFAULT '[]', scheduled_at TEXT, started_at TEXT, ended_at TEXT, status TEXT NOT NULL DEFAULT 'scheduled', duration_minutes INTEGER NOT NULL DEFAULT 120, credits_donated INTEGER NOT NULL DEFAULT 0, reward_credits_awarded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_livestreams_status_schedule ON sl_livestreams(status, scheduled_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_livestreams_host_created ON sl_livestreams(host_id, created_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_livestream_members (stream_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', joined_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, left_at TEXT, PRIMARY KEY (stream_id, user_id))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_livestream_members_stream_active ON sl_livestream_members(stream_id, left_at, last_seen_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_livestream_chat (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, donation_credits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_livestream_chat_stream_created ON sl_livestream_chat(stream_id, created_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_livestream_signals (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_livestream_signals_stream_created ON sl_livestream_signals(stream_id, created_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_livestream_signals_target_created ON sl_livestream_signals(stream_id, to_id, created_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, allow_external_access INTEGER NOT NULL DEFAULT 1, blocked_categories_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_organizations_owner_unique ON sl_organizations(owner_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_organizations_created ON sl_organizations(created_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_organization_members (organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL, PRIMARY KEY (organization_id, user_id))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_organization_members_user_role ON sl_organization_members(user_id, role)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_organization_activity (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_organization_activity_org_created ON sl_organization_activity(organization_id, created_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_courses (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Other', level TEXT NOT NULL DEFAULT 'All levels', estimated_hours REAL NOT NULL DEFAULT 1, resource_url TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'private', status TEXT NOT NULL DEFAULT 'draft', lessons_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_courses_public_created ON sl_courses(visibility, status, published_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_courses_owner_created ON sl_courses(owner_id, created_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_workshop_shares (share_id TEXT PRIMARY KEY, workshop_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_workshop_shares_workshop_unique ON sl_workshop_shares(workshop_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_workshop_shares_expiry ON sl_workshop_shares(expires_at)"),
      // A small JSON record layer keeps the rest of the product durable while
      // feature-specific tables are introduced. It is intentionally scoped by
      // collection and owner, indexed for the common private/public reads, and
      // never used for identity, sessions, or permission checks.
      db.prepare("CREATE TABLE IF NOT EXISTS sl_app_records (collection TEXT NOT NULL, record_id TEXT NOT NULL, owner_id TEXT NOT NULL DEFAULT '', record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (collection, record_id))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_app_records_collection_updated ON sl_app_records(collection, updated_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_app_records_owner_updated ON sl_app_records(owner_id, updated_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_learning_streaks (user_id TEXT PRIMARY KEY, current_streak INTEGER NOT NULL DEFAULT 0, longest_streak INTEGER NOT NULL DEFAULT 0, last_activity_date TEXT, streak_freezes INTEGER NOT NULL DEFAULT 3, freezes_used INTEGER NOT NULL DEFAULT 0, milestones_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_learning_streak_days (user_id TEXT NOT NULL, activity_date TEXT NOT NULL, day_type TEXT NOT NULL DEFAULT 'learning_session', source_id TEXT NOT NULL DEFAULT '', occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, activity_date))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_learning_streak_days_user_date ON sl_learning_streak_days(user_id, activity_date)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_learning_streak_days_type ON sl_learning_streak_days(user_id, day_type, activity_date)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_study_profiles (user_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', visibility TEXT NOT NULL DEFAULT 'discoverable', subjects_json TEXT NOT NULL DEFAULT '[]', topics_json TEXT NOT NULL DEFAULT '[]', goals_json TEXT NOT NULL DEFAULT '[]', learning_level TEXT NOT NULL DEFAULT 'all_levels', timezone TEXT NOT NULL DEFAULT 'UTC', session_duration_minutes INTEGER NOT NULL DEFAULT 50, study_style TEXT NOT NULL DEFAULT 'quiet_focus', modes_json TEXT NOT NULL DEFAULT '[\"focus\"]', languages_json TEXT NOT NULL DEFAULT '[\"English\"]', interests_json TEXT NOT NULL DEFAULT '[]', cross_subject INTEGER NOT NULL DEFAULT 1, age_band TEXT NOT NULL DEFAULT 'any', current_goal TEXT NOT NULL DEFAULT '', reliability_score REAL NOT NULL DEFAULT 0, completed_sessions INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_profiles_discoverable ON sl_study_profiles(status, visibility, updated_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_profiles_duration ON sl_study_profiles(status, session_duration_minutes)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_study_availability (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'recurring', weekday INTEGER, date_key TEXT, start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL, timezone TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_availability_user ON sl_study_availability(user_id, kind, weekday, date_key)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_availability_window ON sl_study_availability(weekday, start_minute, end_minute)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_study_availability_slots (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, availability_id TEXT NOT NULL, slot_day TEXT NOT NULL, slot_start_utc TEXT NOT NULL, slot_end_utc TEXT NOT NULL, created_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_slots_start_end ON sl_study_availability_slots(slot_start_utc, slot_end_utc, user_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_slots_user_day ON sl_study_availability_slots(user_id, slot_day)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_study_invitations (id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL, proposed_start_utc TEXT NOT NULL, duration_minutes INTEGER NOT NULL DEFAULT 50, mode TEXT NOT NULL DEFAULT 'focus', study_style TEXT NOT NULL DEFAULT 'quiet_focus', sender_subject TEXT NOT NULL DEFAULT '', recipient_subject TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', counter_start_utc TEXT, counter_duration_minutes INTEGER, counter_message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_invitations_recipient_status ON sl_study_invitations(recipient_id, status, updated_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_invitations_sender_status ON sl_study_invitations(sender_id, status, updated_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_study_rooms (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'public', subject TEXT NOT NULL DEFAULT '', max_participants INTEGER NOT NULL DEFAULT 4, starts_at TEXT NOT NULL, duration_minutes INTEGER NOT NULL DEFAULT 50, study_style TEXT NOT NULL DEFAULT 'quiet_focus', modes_json TEXT NOT NULL DEFAULT '[\"focus\"]', pomodoro_json TEXT NOT NULL DEFAULT '{\"focus\":50,\"break\":10,\"rounds\":1}', rules_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_rooms_lobby ON sl_study_rooms(status, visibility, starts_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_rooms_host ON sl_study_rooms(host_id, updated_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_study_room_members (room_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'participant', status TEXT NOT NULL DEFAULT 'active', joined_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (room_id, user_id))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_room_members_user ON sl_study_room_members(user_id, status, updated_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_room_members_room ON sl_study_room_members(room_id, status)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_study_sessions (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, invitation_id TEXT, created_by TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', mode TEXT NOT NULL DEFAULT 'focus', study_style TEXT NOT NULL DEFAULT 'quiet_focus', goal_json TEXT NOT NULL DEFAULT '{}', pomodoro_json TEXT NOT NULL DEFAULT '{\"focus\":50,\"break\":10,\"rounds\":1}', video_room_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_sessions_time ON sl_study_sessions(status, starts_at, ends_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_sessions_room ON sl_study_sessions(room_id, starts_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_study_session_members (session_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'participant', status TEXT NOT NULL DEFAULT 'scheduled', goal TEXT NOT NULL DEFAULT '', goal_completed INTEGER NOT NULL DEFAULT 0, progress_note TEXT NOT NULL DEFAULT '', joined_at TEXT, left_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (session_id, user_id))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_session_members_user ON sl_study_session_members(user_id, status, updated_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_session_members_session ON sl_study_session_members(session_id, status)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_study_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat', metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_messages_session ON sl_study_messages(session_id, created_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_study_favorites (user_id TEXT NOT NULL, partner_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, partner_id))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_favorites_partner ON sl_study_favorites(partner_id, created_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_study_reports (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, target_user_id TEXT, room_id TEXT, session_id TEXT, reason TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_study_reports_status ON sl_study_reports(status, created_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_blocked_words (id TEXT PRIMARY KEY, phrase TEXT NOT NULL, normalized_phrase TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT, updated_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_blocked_words_normalized_unique ON sl_blocked_words(normalized_phrase)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_blocked_words_enabled ON sl_blocked_words(enabled, created_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_moderation_items (id TEXT PRIMARY KEY, user_id TEXT, content_type TEXT NOT NULL, source_path TEXT NOT NULL, source_method TEXT NOT NULL, payload_json TEXT NOT NULL, content_json TEXT NOT NULL, file_context_json TEXT NOT NULL DEFAULT '[]', submitter_json TEXT NOT NULL DEFAULT '{}', triggered_rule_id TEXT, triggered_rule TEXT NOT NULL, triggered_rules_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','deleted')), submitted_at TEXT NOT NULL, reviewed_by TEXT, reviewed_at TEXT, review_lock_at TEXT, replay_secret_hash TEXT NOT NULL DEFAULT '')"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_moderation_items_status_submitted ON sl_moderation_items(status, submitted_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_moderation_items_user_submitted ON sl_moderation_items(user_id, submitted_at)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_moderation_files (item_id TEXT NOT NULL, file_index INTEGER NOT NULL, file_name TEXT NOT NULL, content_type TEXT NOT NULL, file_size INTEGER NOT NULL, chunk_index INTEGER NOT NULL, chunk_data BLOB NOT NULL, PRIMARY KEY (item_id, file_index, chunk_index))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_moderation_files_item ON sl_moderation_files(item_id, file_index, chunk_index)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_moderation_audit (id TEXT PRIMARY KEY, content_id TEXT NOT NULL, user_id TEXT, triggered_rule TEXT NOT NULL, previous_status TEXT NOT NULL, new_status TEXT NOT NULL CHECK (new_status IN ('pending','approved','deleted')), admin_id TEXT, action TEXT NOT NULL, created_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_moderation_audit_content_created ON sl_moderation_audit(content_id, created_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_moderation_audit_created ON sl_moderation_audit(created_at)")
    ]).catch(error => {
      featureSchemaPromise = null;
      throw error;
    });
  }
  await featureSchemaPromise;
  if (!notificationTitleSchemaPromise) {
    notificationTitleSchemaPromise = db.prepare("PRAGMA table_info(sl_notifications)").all().then(async result => {
      const columns = result.results || [];
      if (!columns.some(column => column.name === "title")) {
        await db.prepare("ALTER TABLE sl_notifications ADD COLUMN title TEXT NOT NULL DEFAULT ''").run();
      }
    }).catch(error => {
      notificationTitleSchemaPromise = null;
      throw error;
    });
  }
  await notificationTitleSchemaPromise;
  if (!communitySeedPromise) {
    communitySeedPromise = ensureCommunitySeedGroups(db).catch(error => {
      communitySeedPromise = null;
      throw error;
    });
  }
  await communitySeedPromise;
}

function streakTimezone(value) {
  const candidate = safeText(value, 120);
  if (!candidate) return DEFAULT_STREAK_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: candidate}).format(new Date());
    return candidate;
  } catch (_error) {
    return DEFAULT_STREAK_TIMEZONE;
  }
}

function streakTimezoneFor(row) {
  return streakTimezone(rowParts(row).profile.timezone || DEFAULT_STREAK_TIMEZONE);
}

function calendarDateForTime(value, timezone = DEFAULT_STREAK_TIMEZONE) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: streakTimezone(timezone), year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function streakDateValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
}

function streakDateDistance(later, earlier) {
  const difference = streakDateValue(later) - streakDateValue(earlier);
  return Number.isFinite(difference) ? Math.round(difference / 86_400_000) : NaN;
}

function shiftStreakDate(value, amount) {
  const dateValue = streakDateValue(value);
  if (!Number.isFinite(dateValue)) return "";
  const date = new Date(dateValue + Number(amount || 0) * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function streakMilestoneRecords(value) {
  let parsed = [];
  try {
    parsed = Array.isArray(value) ? value : JSON.parse(String(value || "[]"));
  } catch (_error) {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(item => {
    const target = Number(isObject(item) ? item.target : item);
    const definition = STREAK_MILESTONES.find(candidate => candidate.target === target);
    if (!definition) return null;
    return {
      ...definition,
      id: `streak-${definition.target}`,
      awarded: isObject(item) ? item.awarded !== false : true,
      awarded_at: isObject(item) ? item.awarded_at || null : null
    };
  }).filter(Boolean);
}

function streakMilestoneState(current, longest, records = []) {
  const awarded = new Set(records.filter(item => item.awarded !== false).map(item => Number(item.target)));
  return STREAK_MILESTONES.map(definition => ({
    id: `streak-${definition.target}`,
    target: definition.target,
    title: `${definition.target}-day streak`,
    description: `Complete a learning session on ${definition.target} consecutive days.`,
    reward_credits: definition.reward_credits,
    earned: Number(longest || 0) >= definition.target,
    reward_awarded: awarded.has(definition.target),
    progress: Math.min(100, Math.round(Number(current || 0) / definition.target * 100))
  }));
}

async function ensureStreakAccount(db, userId, updatedAt = new Date().toISOString()) {
  await db.prepare("INSERT OR IGNORE INTO sl_learning_streaks (user_id, current_streak, longest_streak, last_activity_date, streak_freezes, freezes_used, milestones_json, updated_at) VALUES (?, 0, 0, NULL, 3, 0, '[]', ?)")
    .bind(userId, updatedAt).run();
  return db.prepare("SELECT * FROM sl_learning_streaks WHERE user_id = ? LIMIT 1").bind(userId).first();
}

function streakAccountInsert(db, userId, updatedAt) {
  return db.prepare("INSERT OR IGNORE INTO sl_learning_streaks (user_id, current_streak, longest_streak, last_activity_date, streak_freezes, freezes_used, milestones_json, updated_at) VALUES (?, 0, 0, NULL, 3, 0, '[]', ?)")
    .bind(userId, updatedAt);
}

async function streakSummaryFor(db, userRow) {
  const streak = await ensureStreakAccount(db, userRow.id);
  const timezone = streakTimezoneFor(userRow);
  const today = calendarDateForTime(new Date(), timezone);
  const result = await db.prepare("SELECT activity_date, day_type FROM sl_learning_streak_days WHERE user_id = ? ORDER BY activity_date DESC LIMIT 500").bind(userRow.id).all();
  const days = new Map((result.results || []).map(item => [item.activity_date, item.day_type]));
  const lastActivityDate = streak?.last_activity_date || null;
  const distanceFromLast = lastActivityDate ? streakDateDistance(today, lastActivityDate) : 0;
  const currentStreak = distanceFromLast > 1 ? 0 : Number(streak?.current_streak || 0);
  const recentDays = Array.from({length: 7}, (_, index) => {
    const date = shiftStreakDate(today, index - 6);
    const type = days.get(date) || "";
    const status = type === "learning_session" ? "complete" : type === "streak_freeze" ? "freeze" : date === today ? "today" : "missed";
    return {
      date,
      label: new Intl.DateTimeFormat("en-US", {timeZone: "UTC", weekday: "short"}).format(new Date(`${date}T12:00:00Z`)),
      status,
      completed: type === "learning_session",
      protected: type === "streak_freeze"
    };
  });
  const longestStreak = Number(streak?.longest_streak || 0);
  const milestoneRecords = streakMilestoneRecords(streak?.milestones_json);
  return {
    current_streak: currentStreak,
    longest_streak: longestStreak,
    streak_freezes: Number(streak?.streak_freezes || 0),
    freezes_used: Number(streak?.freezes_used || 0),
    last_activity_date: lastActivityDate,
    today,
    today_complete: days.get(today) === "learning_session",
    timezone,
    recent_days: recentDays,
    milestones: streakMilestoneState(currentStreak, longestStreak, milestoneRecords)
  };
}

async function recordLearningSessionCompletion(db, userId, {occurredAt = new Date().toISOString(), sourceId = ""} = {}) {
  const userRow = await findUserById(db, userId);
  if (!userRow) return null;
  const occurred = new Date(occurredAt);
  const safeOccurredAt = Number.isNaN(occurred.getTime()) ? new Date().toISOString() : occurred.toISOString();
  const activityDate = calendarDateForTime(safeOccurredAt, streakTimezoneFor(userRow));
  const inserted = await db.prepare("INSERT OR IGNORE INTO sl_learning_streak_days (user_id, activity_date, day_type, source_id, occurred_at, created_at) VALUES (?, ?, 'learning_session', ?, ?, ?)")
    .bind(userId, activityDate, safeText(sourceId, 180), safeOccurredAt, new Date().toISOString()).run();
  if (Number(inserted?.meta?.changes || 0) !== 1) return streakSummaryFor(db, userRow);

  const previous = await ensureStreakAccount(db, userId);
  const previousDate = previous?.last_activity_date || "";
  const previousCurrent = Number(previous?.current_streak || 0);
  let nextCurrent = previousDate ? 1 : 1;
  let freezes = Number(previous?.streak_freezes ?? 3);
  let freezesUsed = Number(previous?.freezes_used || 0);
  const freezeStatements = [];
  const distance = previousDate ? streakDateDistance(activityDate, previousDate) : NaN;
  if (previousDate && Number.isFinite(distance) && distance <= 0) {
    return streakSummaryFor(db, userRow);
  }
  if (previousDate && distance === 1) {
    nextCurrent = previousCurrent + 1;
  } else if (previousDate && Number.isFinite(distance) && distance > 1) {
    const missedDays = distance - 1;
    if (freezes >= missedDays) {
      freezes -= missedDays;
      freezesUsed += missedDays;
      nextCurrent = previousCurrent + distance;
      for (let offset = 1; offset < distance; offset += 1) {
        const protectedDate = shiftStreakDate(previousDate, offset);
        freezeStatements.push(db.prepare("INSERT OR IGNORE INTO sl_learning_streak_days (user_id, activity_date, day_type, source_id, occurred_at, created_at) VALUES (?, ?, 'streak_freeze', ?, ?, ?)")
          .bind(userId, protectedDate, `freeze:${previousDate}:${activityDate}`, safeOccurredAt, new Date().toISOString()));
      }
    } else {
      nextCurrent = 1;
    }
  }
  const longest = Math.max(Number(previous?.longest_streak || 0), nextCurrent);
  const updatedAt = new Date().toISOString();
  const previousMilestones = streakMilestoneRecords(previous?.milestones_json);
  const reachedMilestones = STREAK_MILESTONES.filter(definition => longest >= definition.target).map(definition => {
    const previousMilestone = previousMilestones.find(item => item.target === definition.target);
    return {
      ...definition,
      id: `streak-${definition.target}`,
      awarded: previousMilestone ? previousMilestone.awarded !== false : true,
      awarded_at: previousMilestone?.awarded_at || updatedAt
    };
  });
  const alreadyAwarded = new Set(previousMilestones.filter(item => item.awarded !== false).map(item => Number(item.target)));
  const ledgerRows = reachedMilestones.some(item => !alreadyAwarded.has(item.target))
    ? await appRecords(db, "ledger", userId)
    : [];
  const newlyAwarded = reachedMilestones.filter(item =>
    !alreadyAwarded.has(item.target) &&
    !ledgerRows.some(entry => entry.reference_type === "streak_milestone" && entry.reference_id === `streak-milestone-${userId}-${item.target}`)
  );
  const startingCredits = Number(userRow.time_credits || 0);
  let rewardBalance = startingCredits;
  const rewardRecords = newlyAwarded.map(item => {
    rewardBalance += Number(item.reward_credits || 0);
    return {
      id: `streak-reward-${userId}-${item.target}`,
      user_id: userId,
      type: "streak_reward",
      amount: Number(item.reward_credits || 0),
      balance_after: rewardBalance,
      description: `${item.target}-day streak milestone reward`,
      reference_id: `streak-milestone-${userId}-${item.target}`,
      reference_type: "streak_milestone",
      created_by: "system",
      created_at: updatedAt,
      updated_at: updatedAt
    };
  });
  const milestones = JSON.stringify(reachedMilestones);
  const statements = [
    ...freezeStatements,
    db.prepare("UPDATE sl_learning_streaks SET current_streak = ?, longest_streak = ?, last_activity_date = ?, streak_freezes = ?, freezes_used = ?, milestones_json = ?, updated_at = ? WHERE user_id = ?")
      .bind(nextCurrent, longest, activityDate, freezes, freezesUsed, milestones, updatedAt, userId)
  ];
  if (rewardRecords.length) {
    statements.push(db.prepare("UPDATE sl_users SET time_credits = ?, updated_at = ? WHERE id = ?").bind(rewardBalance, updatedAt, userId));
    rewardRecords.forEach(record => statements.push(db.prepare("INSERT INTO sl_app_records (collection, record_id, owner_id, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(collection, record_id) DO NOTHING").bind("ledger", record.id, userId, JSON.stringify(record), record.created_at, record.updated_at)));
  }
  await db.batch([
    ...statements
  ]);
  if (rewardRecords.length) {
    await Promise.all(rewardRecords.map(record => createNotification(db, {
      userId,
      actorId: userId,
      type: "streak_milestone_reward",
      entityId: record.reference_id,
      message: `You reached a ${record.description.replace(" milestone reward", "")} and earned ${record.amount} credits.`
    })));
  }
  return streakSummaryFor(db, userRow);
}

async function streakApi(request, env) {
  const row = await sessionUser(request, env);
  if (!row) return apiResponse({error: "Please log in to view your learning streak."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  return apiResponse({streak: await streakSummaryFor(db, row)});
}

async function ensureCommunitySeedGroups(db) {
  const existing = await db.prepare("SELECT COUNT(*) AS count FROM sl_community_groups").first();
  if (Number(existing?.count || 0) > 0) return;
  const owner = await db.prepare("SELECT id FROM sl_users WHERE role IN ('admin', 'member') AND status = 'active' ORDER BY role = 'admin' DESC, created_at ASC LIMIT 1").first();
  if (!owner?.id) return;
  const now = new Date().toISOString();
  const seed = [
    ["group_skill-lounge", "conv_skill-lounge", "Skill Swap Lounge", "Ask for feedback, trade practical skills, and find your next useful exchange.", "Skill exchange", "bx-shuffle", "blue"],
    ["group_creators-corner", "conv_creators-corner", "Creators Corner", "A warm room for makers sharing works in progress, ideas, and encouragement.", "Creative practice", "bx-palette", "pink"],
    ["group_language-exchange", "conv_language-exchange", "Language Exchange", "Practise a language with real people and keep the conversation moving.", "Languages", "bx-conversation", "purple"]
  ];
  const statements = [];
  seed.forEach(([groupId, conversationId, title, description, category, icon, accent]) => {
    statements.push(db.prepare("INSERT OR IGNORE INTO sl_conversations (id, kind, title, created_by, metadata_json, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?, ?)").bind(conversationId, title, owner.id, JSON.stringify({category, source: "community"}), now, now));
    statements.push(db.prepare("INSERT OR IGNORE INTO sl_conversation_members (conversation_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)").bind(conversationId, owner.id, now));
    statements.push(db.prepare("INSERT OR IGNORE INTO sl_community_groups (id, conversation_id, title, description, category, icon, accent, requires_approval, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)").bind(groupId, conversationId, title, description, category, icon, accent, owner.id, now, now));
    statements.push(db.prepare("INSERT OR IGNORE INTO sl_community_group_members (group_id, user_id, status, role, created_at, updated_at) VALUES (?, ?, 'active', 'moderator', ?, ?)").bind(groupId, owner.id, now, now));
  });
  await db.batch(statements);
}

async function followSnapshot(db, viewerId) {
  await ensureFeatureSchema(db);
  const result = await db.prepare("SELECT follower_id, following_id, status FROM sl_follows WHERE status IN ('pending', 'accepted')").all();
  const relationship = new Map();
  const followers = new Map();
  const following = new Map();
  const outgoing = new Map();
  const incoming = new Map();
  for (const row of result.results || []) {
    if (row.status === "accepted") {
      followers.set(row.following_id, Number(followers.get(row.following_id) || 0) + 1);
      following.set(row.follower_id, Number(following.get(row.follower_id) || 0) + 1);
    }
    if (viewerId && row.follower_id === viewerId) outgoing.set(row.following_id, row.status);
    if (viewerId && row.following_id === viewerId) incoming.set(row.follower_id, row.status);
  }
  if (viewerId) {
    const connectedIds = new Set([...outgoing.keys(), ...incoming.keys()]);
    for (const targetId of connectedIds) {
      const follows = outgoing.get(targetId);
      const followedBy = incoming.get(targetId);
      relationship.set(targetId,
        follows === "accepted" && followedBy === "accepted" ? "mutual" :
        follows === "accepted" ? "following" :
        followedBy === "accepted" ? "follower" :
        follows === "pending" ? "requested" : "incoming_request");
    }
  }
  return {relationship, followers, following};
}

function publicUserCounts(snapshot, userId) {
  return {
    followers_count: Number(snapshot.followers.get(userId) || 0),
    following_count: Number(snapshot.following.get(userId) || 0)
  };
}

async function connectionPeople(db, userId, direction, viewerId, snapshot, userCache = null) {
  const isFollowers = direction === "followers";
  const column = isFollowers ? "following_id" : "follower_id";
  const result = await db.prepare(`SELECT follower_id, following_id, created_at FROM sl_follows WHERE ${column} = ? AND status = 'accepted' ORDER BY created_at DESC LIMIT 250`).bind(userId).all();
  const cache = userCache || new Map((await allUserRows(db)).map(row => [String(row.id), row]));
  const people = [];
  for (const follow of result.results || []) {
    const personId = isFollowers ? follow.follower_id : follow.following_id;
    const row = cache.get(String(personId));
    if (!row || row.status !== "active" || row.role !== "member") continue;
    const parts = rowParts(row);
    const relationship = row.id === viewerId ? "self" : snapshot.relationship.get(row.id) || "none";
    people.push({...commonPublicFields(row, parts.profile, parts.preferences, parts.safety, viewerId, relationship, publicUserCounts(snapshot, row.id)), connected_at: follow.created_at});
  }
  return people;
}

async function connectionListsForUser(db, userId, viewerId, snapshot = null, userCache = null) {
  const resolvedSnapshot = snapshot || await followSnapshot(db, viewerId);
  const cache = userCache || new Map((await allUserRows(db)).map(row => [String(row.id), row]));
  const [followers, following] = await Promise.all([
    connectionPeople(db, userId, "followers", viewerId, resolvedSnapshot, cache),
    connectionPeople(db, userId, "following", viewerId, resolvedSnapshot, cache)
  ]);
  return {followers, following, followers_count: followers.length, following_count: following.length};
}

function selfUser(row) {
  const parts = rowParts(row);
  return {
    id: row.id, username: row.username, email: row.email, role: row.role, status: row.status,
    verified: Boolean(row.verified), time_credits: Number(row.time_credits || 0), reward_points: Number(row.reward_points || 0),
    moderation_label: row.moderation_label || "none", messaging_restricted: Boolean(row.messaging_restricted),
    suspended_until: row.suspended_until, suspension_reason: row.suspension_reason || "",
    profile: {...parts.profile, prelaunch_profile_only: false, avatar_url: publicAvatarUrl(parts.profile.avatar_url), full_name: completeName(parts.profile, row.username)}, preferences: parts.preferences, safety: parts.safety,
    joined_at: row.created_at, created_at: row.created_at, updated_at: row.updated_at, last_login_at: row.last_login_at,
    terms_accepted_at: row.terms_accepted_at, visibility: parts.preferences.profile_visibility === "private" ? "private" : "public"
  };
}

function adminUser(row) {
  return {...selfUser(row), admin_notes: row.admin_notes || ""};
}

async function sessionUser(request, env) {
  const moderationContext = MODERATION_REPLAY_CONTEXTS.get(request);
  if (moderationContext && moderationContext.actorOverride) return moderationContext.actor || null;
  const token = parseCookies(request).sl_session;
  if (!token) return null;
  const hash = await sha256Hex(token);
  return dbFor(env).prepare("SELECT u.* FROM sl_sessions s INNER JOIN sl_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1")
    .bind(hash, new Date().toISOString()).first();
}

async function sessionValues(userId) {
  const token = randomToken(32);
  return {token, tokenHash: await sha256Hex(token), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString()};
}

function csrfIsValid(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const cookies = parseCookies(request);
  return Boolean(cookies.sl_csrf && request.headers.get("x-csrf-token") && constantTimeEqual(cookies.sl_csrf, request.headers.get("x-csrf-token")));
}

function createUserRow(data) {
  const createdAt = data.createdAt;
  return {
    id: data.id, username: data.username, email: data.email, password_hash: data.passwordHash,
    role: data.role || "member", status: data.status || "active", verified: data.verified ? 1 : 0,
    time_credits: data.timeCredits == null ? SIGNUP_CREDIT_AMOUNT : Math.max(0, Math.floor(Number(data.timeCredits) || 0)), reward_points: Math.max(0, Math.floor(Number(data.rewardPoints) || 0)),
    profile_json: JSON.stringify(data.profile), preferences_json: JSON.stringify(data.preferences), safety_json: JSON.stringify(data.safety),
    moderation_label: "none", admin_notes: safeText(data.adminNotes, 2000), messaging_restricted: 0,
    suspended_until: null, suspension_reason: "", created_at: createdAt, updated_at: createdAt, last_login_at: null,
    terms_accepted_at: data.termsAcceptedAt || null
  };
}

function userInsert(db, row) {
  return db.prepare("INSERT INTO sl_users (id, username, email, password_hash, role, status, verified, time_credits, reward_points, profile_json, preferences_json, safety_json, moderation_label, admin_notes, messaging_restricted, suspended_until, suspension_reason, created_at, updated_at, last_login_at, terms_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.username, row.email, row.password_hash, row.role, row.status, row.verified, row.time_credits, row.reward_points, row.profile_json, row.preferences_json, row.safety_json, row.moderation_label, row.admin_notes, row.messaging_restricted, row.suspended_until, row.suspension_reason, row.created_at, row.updated_at, row.last_login_at, row.terms_accepted_at);
}

function auditInsert(db, data) {
  return db.prepare("INSERT INTO sl_audit_log (id, actor_id, target_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId("audit"), data.actorId || null, data.targetId || null, safeText(data.action, 80), safeText(data.details, 1000), data.createdAt || new Date().toISOString());
}

const MODERATION_SECRET_KEY = /password|passphrase|csrf|token|secret|credential|authorization|cookie|otp|verification|recovery/i;
const MODERATION_NON_CONTENT_KEY = /^(?:id|.*_id|csrf|token|secret|role|status|visibility|action|method|sort|limit|offset|page|type|kind|format|timezone|date_of_birth|dob|age|phone|.*_phone|email|.*_email|contact|created_at|updated_at|starts_at|ends_at|scheduled_at|published_at|terms|accepted_terms|consent|registration_source|profile_color|avatar_url|media|file|files|binary|size|content_type|sdp|candidate|ice_candidate|session_description)$/i;
const MODERATION_LEET_MAP = {"0":"o", "1":"i", "3":"e", "4":"a", "5":"s", "$":"s", "7":"t", "@":"a", "8":"b", "9":"g", "а":"a", "е":"e", "о":"o", "р":"p", "с":"c", "х":"x", "у":"y", "і":"i", "ј":"j", "Α":"a", "α":"a", "Ε":"e", "ε":"e", "Ο":"o", "ο":"o", "Ι":"i", "ι":"i", "Ρ":"p", "ρ":"p", "Χ":"x", "χ":"x"};

function moderationCompact(value) {
  const source = String(value == null ? "" : value);
  let compact = "";
  const offsets = [];
  let offset = 0;
  for (const sourceChar of source) {
    let folded = sourceChar.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "");
    folded = [...folded].map(char => MODERATION_LEET_MAP[char] || char).join("");
    if (folded === "ß") folded = "ss";
    for (const char of folded) {
      if (!/[\p{L}\p{N}]/u.test(char)) continue;
      compact += char;
      offsets.push(offset);
    }
    offset += sourceChar.length;
  }
  return {compact, offsets, source};
}

function moderationRuleKey(value) {
  return moderationCompact(value).compact;
}

function moderationTextMatches(text, rule) {
  const normalized = moderationCompact(text);
  const needle = rule && rule.normalized_phrase;
  if (!needle || needle.length < 2) return false;
  let index = normalized.compact.indexOf(needle);
  while (index >= 0) {
    const first = normalized.offsets[index];
    const lastOffset = normalized.offsets[index + needle.length - 1];
    const lastChar = [...normalized.source.slice(lastOffset)][0] || "";
    const before = first > 0 ? [...normalized.source.slice(0, first)].pop() || "" : "";
    const after = normalized.source.slice(lastOffset + lastChar.length, lastOffset + lastChar.length + 2);
    if ((!before || !/[\p{L}\p{N}]/u.test(before)) && (!after || !/^[\p{L}\p{N}]/u.test(after))) return true;
    index = normalized.compact.indexOf(needle, index + 1);
  }
  return false;
}

function moderationTextFields(value, fields, path = "", key = "") {
  if (typeof value === "string") {
    if (value.trim() && !MODERATION_SECRET_KEY.test(key) && !MODERATION_NON_CONTENT_KEY.test(key)) fields.push({field: path || "text", value});
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => moderationTextFields(item, fields, `${path}[${index}]`, key));
    return;
  }
  if (isObject(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      const childPath = path ? `${path}.${childKey}` : childKey;
      moderationTextFields(childValue, fields, childPath, childKey);
    }
  }
}

function moderationSanitize(value) {
  if (Array.isArray(value)) return value.map(moderationSanitize);
  if (!isObject(value)) return value;
  const safe = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (MODERATION_SECRET_KEY.test(key)) continue;
    safe[key] = moderationSanitize(childValue);
  }
  return safe;
}

function moderationContentType(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  const route = parts.slice(1).join("/");
  if (route === "profile") return "Profile";
  if (route === "auth/register") return "Account registration";
  if (route.startsWith("community/posts")) return "Community post or comment";
  if (route.startsWith("community/stories")) return "Community story";
  if (route.startsWith("inbox/")) return "Message or group conversation";
  if (route.startsWith("calendar/events")) return "Session or event";
  if (route.startsWith("livestreams")) return "Livestream or chat";
  if (route.startsWith("blog/")) return "Blog post or comment";
  if (route.startsWith("courses")) return "Course";
  if (route.startsWith("workshops")) return "Workshop";
  if (route.startsWith("marketplace")) return "Marketplace listing";
  if (route.startsWith("ideas")) return "Idea or comment";
  if (route.startsWith("early-registration")) return "Early registration";
  if (route.startsWith("auth/")) return "Account submission";
  if (route.startsWith("organizations/")) return "Organization submission";
  if (route.startsWith("contact")) return "Contact message";
  if (route.startsWith("complaints")) return "Complaint";
  if (route.startsWith("feedback")) return "Feedback or review";
  return route.split("/").map(part => part.replace(/[-_]/g, " ")).join(" / ") || "User submission";
}

async function moderationRules(db) {
  const result = await db.prepare("SELECT id, phrase, normalized_phrase FROM sl_blocked_words WHERE enabled = 1 ORDER BY length(normalized_phrase) DESC, created_at ASC").all();
  return result.results || [];
}

function moderationMatches(fields, rules) {
  const matches = [];
  for (const field of fields) {
    for (const rule of rules) {
      if (moderationTextMatches(field.value, rule)) matches.push({rule_id: rule.id, phrase: rule.phrase, field: field.field});
    }
  }
  return matches;
}

async function parseModerationSubmission(request, path) {
  const contentType = request.headers.get("content-type") || "";
  const size = Number(request.headers.get("content-length") || 0);
  if (size > 12_000_000) return {tooLarge: true};
  if (contentType.includes("multipart/form-data")) {
    const form = await request.clone().formData();
    const body = {};
    const files = [];
    for (const [key, value] of form.entries()) {
      if (value && typeof value.arrayBuffer === "function") {
        const fileIndex = files.length;
        files.push({file: value, field: key, fileIndex, name: safeText(value.name, 180) || `upload-${fileIndex + 1}`, type: safeText(value.type, 160) || "application/octet-stream", size: Number(value.size || 0)});
        const metadata = {name: files[fileIndex].name, type: files[fileIndex].type, size: files[fileIndex].size, moderation_file_index: fileIndex};
        if (Array.isArray(body[key])) body[key].push(metadata);
        else if (Object.prototype.hasOwnProperty.call(body, key)) body[key] = [body[key], metadata];
        else body[key] = metadata;
      } else if (Object.prototype.hasOwnProperty.call(body, key)) {
        if (Array.isArray(body[key])) body[key].push(String(value));
        else body[key] = [body[key], String(value)];
      } else body[key] = String(value);
    }
    return {body, files};
  }
  const raw = await request.clone().text();
  if (new TextEncoder().encode(raw).byteLength > 12_000_000) return {tooLarge: true};
  if (!raw) return {body: {}, files: []};
  if (contentType.includes("application/json")) {
    try { return {body: JSON.parse(raw), files: []}; } catch (_error) { return {body: {}, files: []}; }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = {};
    for (const [key, value] of new URLSearchParams(raw)) {
      if (Object.prototype.hasOwnProperty.call(body, key)) body[key] = Array.isArray(body[key]) ? [...body[key], value] : [body[key], value];
      else body[key] = value;
    }
    return {body, files: []};
  }
  return {body: {text: raw}, files: []};
}

async function moderationStoreFiles(db, itemId, files) {
  const statements = [];
  const result = [];
  let total = 0;
  for (const entry of files || []) {
    total += entry.size;
    if (entry.size < 0 || total > 8_000_000) throw Object.assign(new Error("Attachments are too large to hold for private moderation. Keep the combined upload under 8 MB."), {status: 413});
    const bytes = new Uint8Array(await entry.file.arrayBuffer());
    const chunkSize = 128 * 1024;
    const chunks = Math.max(1, Math.ceil(bytes.length / chunkSize));
    for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex += 1) {
      statements.push(db.prepare("INSERT INTO sl_moderation_files (item_id, file_index, file_name, content_type, file_size, chunk_index, chunk_data) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(itemId, entry.fileIndex, entry.name, entry.type, entry.size, chunkIndex, bytes.slice(chunkIndex * chunkSize, Math.min(bytes.length, (chunkIndex + 1) * chunkSize))));
    }
    result.push({field: entry.field, file_index: entry.fileIndex, name: entry.name, type: entry.type, size: entry.size});
  }
  if (statements.length > 90) throw Object.assign(new Error("Attachments are too large to hold for private moderation."), {status: 413});
  return {statements, metadata: result};
}

function moderationWriteAudit(db, item, previousStatus, nextStatus, adminId, action, at) {
  return db.prepare("INSERT INTO sl_moderation_audit (id, content_id, user_id, triggered_rule, previous_status, new_status, admin_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(newId("modaudit"), item.id, item.user_id || null, item.triggered_rule || "", previousStatus, nextStatus, adminId || null, action, at);
}

async function holdSubmissionForReview(request, env, path, actor) {
  const parsed = await parseModerationSubmission(request, path);
  if (parsed.tooLarge) return apiResponse({error: "This submission is too large to review safely. Reduce its size and try again."}, 413);
  const safeBody = moderationSanitize(isObject(parsed.body) || Array.isArray(parsed.body) ? parsed.body : {text: String(parsed.body || "")});
  const fields = [];
  moderationTextFields(safeBody, fields);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const matches = moderationMatches(fields, await moderationRules(db));
  if (!matches.length) return null;
  const publicSubmission = ["/api/contact", "/api/complaints", "/api/feedback", "/api/newsletter/subscribe", "/api/early-registration", "/api/organizations/register"].includes(path);
  if (!actor && !publicSubmission) return null;
  const itemId = newId("moderation");
  const at = new Date().toISOString();
  const submitter = actor ? {
    user_id: actor.id, username: actor.username, full_name: rowParts(actor).profile.display_name || completeName(rowParts(actor).profile, actor.username), email: actor.email || ""
  } : {
    user_id: null, username: safeText(safeBody.username || safeBody.admin_username, 80),
    full_name: safeText(safeBody.full_name || safeBody.name || safeBody.display_name, 180),
    email: safeText(safeBody.email || safeBody.contact, 254)
  };
  let secretHash = "";
  if (typeof parsed.body?.password === "string" && parsed.body.password) secretHash = await hashPassword(parsed.body.password);
  const storedPayload = safeBody;
  const payloadJson = JSON.stringify(storedPayload);
  const contentJson = JSON.stringify({fields, submission: storedPayload, attachments: []});
  const contextBytes = new TextEncoder().encode(payloadJson).byteLength + new TextEncoder().encode(contentJson).byteLength;
  if (contextBytes > 700_000) return apiResponse({error: "This flagged submission is too large to store safely for administrator review. Reduce the text and try again."}, 413);
  let fileResult;
  try { fileResult = await moderationStoreFiles(db, itemId, parsed.files); }
  catch (error) {
    if (error?.status) return apiResponse({error: error.message}, error.status);
    throw error;
  }
  const item = {
    id: itemId, user_id: actor?.id || null, content_type: moderationContentType(path), source_path: path,
    source_method: request.method.toUpperCase(), payload_json: payloadJson,
    content_json: JSON.stringify({fields, submission: storedPayload, attachments: fileResult.metadata}),
    file_context_json: JSON.stringify(fileResult.metadata), submitter_json: JSON.stringify(submitter),
    triggered_rule_id: matches[0].rule_id, triggered_rule: matches[0].phrase,
    triggered_rules_json: JSON.stringify(matches), status: "pending", submitted_at: at, replay_secret_hash: secretHash
  };
  await db.batch([
    ...fileResult.statements,
    db.prepare("INSERT INTO sl_moderation_items (id, user_id, content_type, source_path, source_method, payload_json, content_json, file_context_json, submitter_json, triggered_rule_id, triggered_rule, triggered_rules_json, status, submitted_at, replay_secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
      .bind(item.id, item.user_id, item.content_type, item.source_path, item.source_method, item.payload_json, item.content_json, item.file_context_json, item.submitter_json, item.triggered_rule_id, item.triggered_rule, item.triggered_rules_json, item.submitted_at, item.replay_secret_hash),
    moderationWriteAudit(db, item, "submitted", "pending", null, "blocked_word_detected", at)
  ]);
  return apiResponse({ok: true, message: "Your submission is pending administrator review. It will not be visible until approved.", moderation: {id: item.id, status: "pending", content_type: item.content_type}}, 202);
}

async function moderationLoadFiles(db, itemId, metadata) {
  const entries = [];
  for (const file of metadata || []) {
    const result = await db.prepare("SELECT chunk_data FROM sl_moderation_files WHERE item_id = ? AND file_index = ? ORDER BY chunk_index ASC").bind(itemId, file.file_index).all();
    const chunks = (result.results || []).map(row => row.chunk_data instanceof Uint8Array ? row.chunk_data : new Uint8Array(row.chunk_data || []));
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
    const blob = new Blob([bytes], {type: file.type || "application/octet-stream"});
    entries.push({field: file.field, file_index: file.file_index, file: {name: file.name, type: file.type, size: file.size, arrayBuffer: () => blob.arrayBuffer()}});
  }
  return entries;
}

function moderationStoredJson(value, fallback) {
  try { return JSON.parse(value || ""); } catch (_error) { return fallback; }
}

function replaceModerationFileMarkers(value, files) {
  if (Array.isArray(value)) return value.map(item => replaceModerationFileMarkers(item, files));
  if (!isObject(value)) return value;
  const fileIndex = Number(value.moderation_file_index);
  if (Number.isInteger(fileIndex) && files.has(fileIndex)) return files.get(fileIndex);
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = replaceModerationFileMarkers(child, files);
  return result;
}

async function moderationAppendFormValue(form, key, value, files) {
  if (Array.isArray(value)) {
    for (const entry of value) await moderationAppendFormValue(form, key, entry, files);
    return;
  }
  if (isObject(value) && Number.isInteger(Number(value.moderation_file_index))) {
    const file = files.get(Number(value.moderation_file_index));
    if (!file) throw new Error("A private moderation attachment could not be restored.");
    const blob = new Blob([await file.arrayBuffer()], {type: file.type || "application/octet-stream"});
    form.append(key, blob, safeText(file.name, 180) || "moderated-upload");
    return;
  }
  form.append(key, typeof value === "string" ? value : value == null ? "" : JSON.stringify(value));
}

async function moderationCreateAccount(db, item, adminId) {
  const payload = moderationStoredJson(item.payload_json, {});
  const data = payload.registration_data;
  if (!data || !item.replay_secret_hash) return apiResponse({error: "Registration approval could not be completed because its private record is incomplete."}, 500);
  const phoneDigits = phoneLookup(data.profile?.phone_number).replace(/\D/g, "");
  const duplicatePhone = phoneDigits ? await db.prepare("SELECT id FROM sl_users WHERE replace(replace(replace(replace(replace(json_extract(profile_json, '$.phone_number'), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') = ? LIMIT 1").bind(phoneDigits).first() : null;
  if (await findUserByLogin(db, data.username) || await findUserByLogin(db, data.email) || duplicatePhone) {
    return apiResponse({error: "The username, email, or phone number is now in use, so the approved account could not be created."}, 409);
  }
  const createdAt = new Date().toISOString();
  const row = createUserRow({id: item.user_id, username: data.username, email: data.email, passwordHash: item.replay_secret_hash,
    profile: data.profile, preferences: data.preferences, safety: data.safety, timeCredits: SIGNUP_CREDIT_AMOUNT,
    createdAt, termsAcceptedAt: data.terms_accepted_at});
  try {
    await db.batch([
      userInsert(db, row), streakAccountInsert(db, row.id, createdAt),
      auditInsert(db, {actorId: adminId, targetId: row.id, action: "moderated_registration_approved", details: "Administrator approved a blocked-word registration submission.", createdAt})
    ]);
  } catch (error) {
    if (uniqueViolation(error)) return apiResponse({error: "The username, email, or phone number is now in use, so the approved account could not be created."}, 409);
    throw error;
  }
  return apiResponse({ok: true, message: "Registration approved and account created."}, 201);
}

async function moderationReplaySubmission(request, env, item, adminId) {
  const db = dbFor(env);
  if (item.source_path === "/api/auth/register") return moderationCreateAccount(db, item, adminId);
  const studyChat = /^\/api\/study\/rooms\/([A-Za-z0-9_-]{1,120})\/chat$/.exec(item.source_path || "");
  if (studyChat) {
    if (!env?.STUDY_ROOM_HUB) return apiResponse({error: "Live room publishing is unavailable for this approved message."}, 503);
    const payload = moderationStoredJson(item.payload_json, {});
    if (payload.room_id !== studyChat[1] || !payload.body || !item.user_id) {
      return apiResponse({error: "The private room-message record is incomplete, so the approved message could not be published."}, 500);
    }
    const stub = env.STUDY_ROOM_HUB.getByName(`study-room:${studyChat[1]}`);
    const result = await stub.fetch(new Request("https://study-room.internal/__moderation/approve-chat", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({id: item.id, user_id: item.user_id, display_name: payload.display_name, body: payload.body, created_at: item.submitted_at})
    }));
    if (!result.ok) return apiResponse(await result.json().catch(() => ({error: "The approved room message could not be published."})), result.status);
    return apiResponse({ok: true, message: "Room message approved."});
  }
  if (!item.source_path.startsWith("/api/") || item.source_path.startsWith("/api/admin/") || item.source_path.includes("..")) {
    return apiResponse({error: "This approved submission cannot be safely published. Contact support."}, 400);
  }
  const actor = item.user_id ? await db.prepare("SELECT * FROM sl_users WHERE id = ? LIMIT 1").bind(item.user_id).first() : null;
  if (item.user_id && !actor) return apiResponse({error: "The submitting account is no longer available, so this approved content could not be published."}, 409);
  const payload = moderationStoredJson(item.payload_json, null);
  if (!isObject(payload)) return apiResponse({error: "The approved submission could not be read for publishing. Contact support."}, 500);
  if (item.replay_secret_hash) payload.__moderation_password_hash = item.replay_secret_hash;
  const metadata = moderationStoredJson(item.file_context_json, []);
  const storedFiles = await moderationLoadFiles(db, item.id, metadata);
  const files = new Map(storedFiles.map(entry => [entry.file_index, entry.file]));
  const replayBody = replaceModerationFileMarkers(payload, files);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("host");
  let replay;
  if (metadata.length) {
    const form = new FormData();
    for (const [key, value] of Object.entries(payload)) await moderationAppendFormValue(form, key, value, files);
    headers.delete("content-type");
    replay = new Request(new URL(item.source_path, request.url), {method: item.source_method, headers, body: form});
  } else {
    headers.set("content-type", "application/json; charset=utf-8");
    replay = new Request(new URL(item.source_path, request.url), {method: item.source_method, headers, body: JSON.stringify(replayBody)});
  }
  MODERATION_REPLAY_CONTEXTS.set(replay, {actorOverride: true, actor, path: item.source_path, body: replayBody});
  return localApi(replay, env, item.source_path);
}

async function adminModerationApi(request, env, path) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const method = request.method.toUpperCase();
  if (path === "/api/admin/moderation/pending" && method === "GET") {
    const result = await db.prepare("SELECT id, user_id, content_type, source_path, source_method, content_json, file_context_json, submitter_json, triggered_rule_id, triggered_rule, triggered_rules_json, status, submitted_at FROM sl_moderation_items WHERE status = 'pending' ORDER BY submitted_at ASC LIMIT 500").all();
    const items = (result.results || []).map(row => ({
      id: row.id, user_id: row.user_id, content_type: row.content_type, source_path: row.source_path, source_method: row.source_method,
      content: moderationStoredJson(row.content_json, {}), attachments: moderationStoredJson(row.file_context_json, []),
      submitter: moderationStoredJson(row.submitter_json, {}), triggered_rule_id: row.triggered_rule_id, triggered_rule: row.triggered_rule,
      triggered_rules: moderationStoredJson(row.triggered_rules_json, []), status: row.status, submitted_at: row.submitted_at
    }));
    return apiResponse({items, count: items.length});
  }
  const moderationFileMatch = /^\/api\/admin\/moderation\/pending\/([^/]+)\/files\/(\d+)$/.exec(path);
  if (moderationFileMatch && method === "GET") {
    const itemId = decodeURIComponent(moderationFileMatch[1]);
    const fileIndex = Number(moderationFileMatch[2]);
    const pending = await db.prepare("SELECT id FROM sl_moderation_items WHERE id = ? AND status = 'pending' LIMIT 1").bind(itemId).first();
    if (!pending) return apiResponse({error: "That pending attachment is no longer available."}, 404);
    const result = await db.prepare("SELECT file_name, file_size, chunk_data FROM sl_moderation_files WHERE item_id = ? AND file_index = ? ORDER BY chunk_index ASC").bind(itemId, fileIndex).all();
    const rows = result.results || [];
    if (!rows.length) return apiResponse({error: "That attachment was not found."}, 404);
    const chunks = rows.map(row => row.chunk_data instanceof Uint8Array ? row.chunk_data : new Uint8Array(row.chunk_data || []));
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const filename = safeText(rows[0].file_name, 180).replace(/[^A-Za-z0-9._ -]/g, "_") || "moderation-attachment";
    return new Response(bytes, {status: 200, headers: {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    }});
  }
  if (path === "/api/admin/moderation/audit" && method === "GET") {
    const result = await db.prepare("SELECT id, content_id, user_id, triggered_rule, previous_status, new_status, admin_id, action, created_at FROM sl_moderation_audit ORDER BY created_at DESC LIMIT 250").all();
    return apiResponse({items: result.results || []});
  }
  if (path === "/api/admin/moderation/words" && method === "GET") {
    const result = await db.prepare("SELECT id, phrase, enabled, created_by, updated_by, created_at, updated_at FROM sl_blocked_words ORDER BY created_at DESC").all();
    return apiResponse({items: (result.results || []).map(row => ({...row, enabled: Boolean(row.enabled)}))});
  }
  if (path === "/api/admin/moderation/words" && method === "POST") {
    const body = await readJson(request);
    const phrase = safeText(body.phrase, 120);
    const normalized = moderationRuleKey(phrase);
    if (phrase.length < 2 || normalized.length < 2) return apiResponse({error: "Enter a blocked word or phrase with at least two letters or numbers."}, 400);
    const now = new Date().toISOString();
    try {
      await db.prepare("INSERT INTO sl_blocked_words (id, phrase, normalized_phrase, enabled, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(newId("word"), phrase, normalized, body.enabled === false ? 0 : 1, access.row.id, access.row.id, now, now).run();
    } catch (error) {
      if (uniqueViolation(error)) return apiResponse({error: "That blocked word or phrase already exists."}, 409);
      throw error;
    }
    return apiResponse({ok: true, message: "Blocked phrase saved. It applies to new submissions immediately."}, 201);
  }
  const wordMatch = /^\/api\/admin\/moderation\/words\/([^/]+)$/.exec(path);
  if (wordMatch && ["PATCH", "DELETE"].includes(method)) {
    const id = decodeURIComponent(wordMatch[1]);
    const current = await db.prepare("SELECT * FROM sl_blocked_words WHERE id = ? LIMIT 1").bind(id).first();
    if (!current) return apiResponse({error: "That blocked phrase was not found."}, 404);
    if (method === "DELETE") {
      await db.prepare("DELETE FROM sl_blocked_words WHERE id = ?").bind(id).run();
      return apiResponse({ok: true, message: "Blocked phrase deleted."});
    }
    const body = await readJson(request);
    const phrase = body.phrase === undefined ? current.phrase : safeText(body.phrase, 120);
    const normalized = moderationRuleKey(phrase);
    if (phrase.length < 2 || normalized.length < 2) return apiResponse({error: "Enter a blocked word or phrase with at least two letters or numbers."}, 400);
    const enabled = body.enabled === undefined ? Number(current.enabled) : (body.enabled ? 1 : 0);
    try {
      await db.prepare("UPDATE sl_blocked_words SET phrase = ?, normalized_phrase = ?, enabled = ?, updated_by = ?, updated_at = ? WHERE id = ?")
        .bind(phrase, normalized, enabled, access.row.id, new Date().toISOString(), id).run();
    } catch (error) {
      if (uniqueViolation(error)) return apiResponse({error: "That blocked word or phrase already exists."}, 409);
      throw error;
    }
    return apiResponse({ok: true, message: "Blocked phrase updated."});
  }
  const reviewMatch = /^\/api\/admin\/moderation\/pending\/([^/]+)$/.exec(path);
  if (reviewMatch && method === "PATCH") {
    const id = decodeURIComponent(reviewMatch[1]);
    const body = await readJson(request);
    if (!["approve", "delete"].includes(body.action)) return apiResponse({error: "Choose either approve or delete."}, 400);
    const pendingFiles = body.action === "approve"
      ? await db.prepare("SELECT file_index FROM sl_moderation_files WHERE item_id = ? LIMIT 1").bind(id).first()
      : null;
    if (pendingFiles && !env?.BUCKET) {
      return apiResponse({error: "This submission includes media, but public media storage is not configured. It remains pending and hidden until storage is available."}, 503);
    }
    const now = new Date().toISOString();
    const claimed = await db.prepare("UPDATE sl_moderation_items SET review_lock_at = ? WHERE id = ? AND status = 'pending' AND (review_lock_at IS NULL OR review_lock_at < ?)")
      .bind(now, id, new Date(Date.now() - 10 * 60 * 1000).toISOString()).run();
    if (!Number(claimed.meta?.changes || 0)) return apiResponse({error: "This item is no longer pending or is already being reviewed."}, 409);
    const item = await db.prepare("SELECT * FROM sl_moderation_items WHERE id = ? AND status = 'pending' AND review_lock_at = ? LIMIT 1").bind(id, now).first();
    if (!item) return apiResponse({error: "This item is no longer pending."}, 409);
    if (body.action === "delete") {
      await db.batch([
        db.prepare("UPDATE sl_moderation_items SET status = 'deleted', reviewed_by = ?, reviewed_at = ?, review_lock_at = NULL, payload_json = '{}', content_json = '{}', file_context_json = '[]', submitter_json = '{}', replay_secret_hash = '' WHERE id = ? AND status = 'pending' AND review_lock_at = ?").bind(access.row.id, now, id, now),
        moderationWriteAudit(db, item, "pending", "deleted", access.row.id, "deleted_by_admin", now),
        db.prepare("DELETE FROM sl_moderation_files WHERE item_id = ?").bind(id)
      ]);
      return apiResponse({ok: true, status: "deleted", message: "Submission deleted and removed from public availability."});
    }
    const approved = await db.batch([
      db.prepare("UPDATE sl_moderation_items SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending' AND review_lock_at = ?").bind(access.row.id, now, id, now),
      moderationWriteAudit(db, item, "pending", "approved", access.row.id, "approved_by_admin", now)
    ]);
    if (!Number(approved?.[0]?.meta?.changes || 0)) {
      return apiResponse({error: "This item is no longer pending."}, 409);
    }
    let replayResponse;
    try { replayResponse = await moderationReplaySubmission(request, env, item, access.row.id); }
    catch (error) {
      const completedAt = new Date().toISOString();
      await db.batch([
        db.prepare("UPDATE sl_moderation_items SET review_lock_at = NULL WHERE id = ? AND status = 'approved' AND review_lock_at = ?").bind(id, now),
        moderationWriteAudit(db, item, "approved", "approved", access.row.id, "approved_publish_failed", completedAt)
      ]);
      return apiResponse({ok: true, status: "approved", publication_error: true, message: "The item is approved, but the platform could not finish publishing it. It is not pending review; check the audit log."});
    }
    if (!replayResponse || replayResponse.status < 200 || replayResponse.status >= 300) {
      const replayError = replayResponse ? await replayResponse.clone().json().catch(() => ({})) : {};
      const completedAt = new Date().toISOString();
      await db.batch([
        db.prepare("UPDATE sl_moderation_items SET review_lock_at = NULL WHERE id = ? AND status = 'approved' AND review_lock_at = ?").bind(id, now),
        moderationWriteAudit(db, item, "approved", "approved", access.row.id, "approved_publish_failed", completedAt)
      ]);
      return apiResponse({ok: true, status: "approved", publication_error: true, message: `The item is approved, but the platform could not finish publishing it: ${safeText(replayError.error, 300) || "please check the audit log."} It is not pending review.`});
    }
    await db.batch([
      db.prepare("UPDATE sl_moderation_items SET review_lock_at = NULL, replay_secret_hash = '' WHERE id = ? AND status = 'approved' AND review_lock_at = ?").bind(id, now),
      db.prepare("DELETE FROM sl_moderation_files WHERE item_id = ?").bind(id)
    ]);
    return apiResponse({ok: true, status: "approved", message: "Submission approved and published according to its normal platform rules."});
  }
  return apiResponse({error: "Moderation endpoint not found."}, 404);
}

function sessionInsert(db, userId, session) {
  return db.prepare("INSERT INTO sl_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(session.tokenHash, userId, session.createdAt, session.expiresAt);
}

function uniqueViolation(error) {
  return /unique constraint|constraint failed/i.test(String(error && error.message || error));
}

let googleAuthSchemaPromise;

async function ensureGoogleAuthSchema(db) {
  if (!googleAuthSchemaPromise) {
    googleAuthSchemaPromise = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS sl_auth_identities (id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_subject TEXT NOT NULL, user_id TEXT NOT NULL, provider_email TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(provider, provider_subject), UNIQUE(provider, user_id))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_auth_identities_user ON sl_auth_identities(user_id)"),
      db.prepare("CREATE TABLE IF NOT EXISTS sl_oauth_states (state_hash TEXT PRIMARY KEY, flow TEXT NOT NULL, user_id TEXT, return_to TEXT NOT NULL DEFAULT 'dashboard.html', code_verifier TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_sl_oauth_states_expires ON sl_oauth_states(expires_at)")
    ]).catch(error => {
      googleAuthSchemaPromise = null;
      throw error;
    });
  }
  await googleAuthSchemaPromise;
}

function googleAuthConfig(env) {
  if (env?.LOCAL_MODE === "true") return {clientId: "", clientSecret: "", enabled: false};
  const clientId = String(env && (env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_CLIENT_ID) || "").trim();
  const clientSecret = String(env && (env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET) || "").trim();
  return {clientId, clientSecret, enabled: Boolean(clientId && clientSecret)};
}

function googleAuthOrigin(request) {
  const incoming = new URL(request.url);
  if (["localhost", "127.0.0.1", "[::1]"].includes(incoming.hostname)) return incoming.origin;
  const allowed = new Set([
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://127.0.0.1:8765",
    "http://localhost:8765"
  ]);
  return allowed.has(incoming.origin) ? incoming.origin : "http://localhost:8000";
}

function googleRedirectUri(request) {
  return googleAuthOrigin(request) + "/api/auth/google/callback";
}

function googleReturnPath(value, fallback) {
  const raw = safeText(value, 500);
  if (!raw || raw.startsWith("//") || raw.includes("://") || raw.includes("\\") || /[\u0000-\u001f]/.test(raw)) return fallback;
  try {
    const target = new URL(raw, "https://relayskills.local");
    if (target.origin !== "https://relayskills.local" || !/^\/[^/].*\.html$/i.test(target.pathname)) return fallback;
    return `${target.pathname.replace(/^\//, "")}${target.search}${target.hash}`;
  } catch (_error) {
    return fallback;
  }
}

function googleDestination(origin, path) {
  return new URL(path, `${origin}/`).toString();
}

function googleMessagePath(path, key, value) {
  const target = new URL(path, "https://relayskills.local");
  target.searchParams.set(key, safeText(value, 240));
  return `${target.pathname.replace(/^\//, "")}${target.search}${target.hash}`;
}

function redirectResponse(location, cookies) {
  const headers = new Headers({location, "cache-control": "no-store", "x-swappublic-api": "local"});
  (cookies || []).forEach(cookie => headers.append("set-cookie", cookie));
  return new Response(null, {status: 302, headers});
}

async function googleAuthStatus(request, env) {
  const config = googleAuthConfig(env);
  const viewer = await sessionUser(request, env);
  let identity = null;
  if (viewer) {
    const db = dbFor(env);
    await ensureGoogleAuthSchema(db);
    identity = await db.prepare("SELECT provider_email FROM sl_auth_identities WHERE provider = 'google' AND user_id = ? LIMIT 1").bind(viewer.id).first();
  }
  return apiResponse({
    enabled: config.enabled,
    provider: "google",
    linked: Boolean(identity),
    provider_email: identity?.provider_email || ""
  });
}

async function googleAuthStart(request, env) {
  const config = googleAuthConfig(env);
  const incoming = new URL(request.url);
  const flow = incoming.searchParams.get("flow") === "link" ? "link" : "login";
  const origin = googleAuthOrigin(request);
  const defaultReturn = flow === "link" ? "profile.html#learning" : "dashboard.html";
  const returnTo = googleReturnPath(incoming.searchParams.get("return_to"), defaultReturn);
  const viewer = flow === "link" ? await sessionUser(request, env) : null;
  const fallback = flow === "link" ? returnTo : "login.html";
  if (flow === "link" && (!viewer || viewer.role === "admin")) {
    return redirectResponse(googleDestination(origin, googleMessagePath("login.html", "google_error", "Sign in as a member before linking Google.")));
  }
  if (!config.enabled) {
    return redirectResponse(googleDestination(origin, googleMessagePath(fallback, "google_error", "Google sign-in is not configured on the published site yet.")));
  }

  const db = dbFor(env);
  await ensureGoogleAuthSchema(db);
  await ensureFeatureSchema(db);
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const state = randomToken(32);
  const stateHash = await sha256Hex(state);
  const codeVerifier = randomToken(48);
  const codeChallenge = base64UrlEncode(await sha256(codeVerifier));
  await db.batch([
    db.prepare("DELETE FROM sl_oauth_states WHERE expires_at <= ?").bind(createdAt),
    db.prepare("INSERT INTO sl_oauth_states (state_hash, flow, user_id, return_to, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(stateHash, flow, viewer?.id || null, returnTo, codeVerifier, createdAt, expiresAt)
  ]);
  const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorization.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: googleRedirectUri(request),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "online",
    prompt: "select_account"
  }).toString();
  return redirectResponse(authorization.toString(), authCookieHeaders(request, "sl_google_oauth_state", state, {httpOnly: true, maxAge: 600}));
}

async function googleAuthCallback(request, env) {
  const incoming = new URL(request.url);
  const origin = googleAuthOrigin(request);
  const config = googleAuthConfig(env);
  const stateValue = safeText(incoming.searchParams.get("state"), 180);
  const stateHash = stateValue ? await sha256Hex(stateValue) : "";
  let stateRow = null;
  let db = null;
  try {
    if (!config.enabled) throw new Error("Google sign-in is not configured on the published site yet.");
    db = dbFor(env);
    await ensureGoogleAuthSchema(db);
    if (!stateValue || !constantTimeEqual(parseCookies(request).sl_google_oauth_state, stateValue)) throw new Error("This Google sign-in attempt has expired. Please try again.");
    stateRow = await db.prepare("SELECT * FROM sl_oauth_states WHERE state_hash = ? AND expires_at > ? LIMIT 1").bind(stateHash, new Date().toISOString()).first();
    if (!stateRow) throw new Error("This Google sign-in attempt has expired. Please try again.");
    const fallback = stateRow.flow === "link" ? stateRow.return_to : "login.html";
    const providerError = safeText(incoming.searchParams.get("error"), 80);
    if (providerError) throw new Error(providerError === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in could not be completed.");
    const code = safeText(incoming.searchParams.get("code"), 2000);
    if (!code) throw new Error("Google did not return a sign-in code. Please try again.");
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {"content-type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: googleRedirectUri(request),
        grant_type: "authorization_code",
        code_verifier: stateRow.code_verifier
      })
    });
    if (!tokenResponse.ok) throw new Error("Google sign-in could not be completed.");
    const tokens = await tokenResponse.json();
    if (!tokens?.access_token) throw new Error("Google did not return an access token.");
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: {authorization: `Bearer ${tokens.access_token}`}
    });
    if (!profileResponse.ok) throw new Error("Google account details could not be verified.");
    const profile = await profileResponse.json();
    const providerSubject = safeText(profile?.sub, 254);
    const providerEmail = safeText(profile?.email, 254).toLowerCase();
    if (!providerSubject || !providerEmail || profile?.email_verified !== true) throw new Error("Google did not provide a verified email address.");
    const now = new Date().toISOString();
    const identity = await db.prepare("SELECT * FROM sl_auth_identities WHERE provider = 'google' AND provider_subject = ? LIMIT 1").bind(providerSubject).first();
    if (stateRow.flow === "link") {
      const viewer = await findUserById(db, stateRow.user_id);
      if (!viewer || viewer.status !== "active" || viewer.role === "admin") throw new Error("That SwapLabs account cannot link Google right now.");
      if (identity && identity.user_id !== viewer.id) throw new Error("That Google account is already linked to another SwapLabs account.");
      if (identity) {
        await db.prepare("UPDATE sl_auth_identities SET provider_email = ?, updated_at = ? WHERE id = ?").bind(providerEmail, now, identity.id).run();
      } else {
        try {
          await db.prepare("INSERT INTO sl_auth_identities (id, provider, provider_subject, user_id, provider_email, created_at, updated_at) VALUES (?, 'google', ?, ?, ?, ?, ?)").bind(newId("identity"), providerSubject, viewer.id, providerEmail, now, now).run();
        } catch (error) {
          if (uniqueViolation(error)) throw new Error("That Google account is already linked to another SwapLabs account.");
          throw error;
        }
      }
      await db.batch([
        db.prepare("DELETE FROM sl_oauth_states WHERE state_hash = ?").bind(stateHash),
        auditInsert(db, {actorId: viewer.id, targetId: viewer.id, action: "google_identity_linked", details: "Google sign-in was linked to the member account.", createdAt: now})
      ]);
      return redirectResponse(googleDestination(origin, googleMessagePath(fallback, "google", "linked")), expiredAuthCookieHeaders(request, "sl_google_oauth_state"));
    }

    if (!identity) {
      const existingEmail = await findUserByLogin(db, providerEmail);
      const message = existingEmail ?
        "This Google address matches an existing account. Sign in with your SwapLabs password once, then link Google from your profile." :
        "This Google account is not linked yet. Create a SwapLabs account first, then link Google from your profile.";
      throw new Error(message);
    }
    const viewer = await findUserById(db, identity.user_id);
    if (!viewer || viewer.role === "admin" || viewer.status !== "active") throw new Error("This SwapLabs account is not available for Google sign-in.");
    const session = await sessionValues(viewer.id);
    await db.batch([
      sessionInsert(db, viewer.id, session),
      db.prepare("UPDATE sl_auth_identities SET provider_email = ?, updated_at = ? WHERE id = ?").bind(providerEmail, now, identity.id),
      db.prepare("UPDATE sl_users SET last_login_at = ?, updated_at = ? WHERE id = ?").bind(now, now, viewer.id),
      db.prepare("DELETE FROM sl_oauth_states WHERE state_hash = ?").bind(stateHash),
      auditInsert(db, {actorId: viewer.id, targetId: viewer.id, action: "google_signed_in", details: "Member signed in with a linked Google account.", createdAt: now})
    ]);
    const successDestination = stateRow.flow === "login" ? "dashboard.html" : googleMessagePath(fallback, "google", "signed_in");
    return redirectResponse(googleDestination(origin, successDestination), [
      ...authCookieHeaders(request, "sl_session", session.token, {httpOnly: true, maxAge: SESSION_MAX_AGE_SECONDS}),
      ...expiredAuthCookieHeaders(request, "sl_google_oauth_state")
    ]);
  } catch (error) {
    if (db && stateHash) {
      try { await db.prepare("DELETE FROM sl_oauth_states WHERE state_hash = ?").bind(stateHash).run(); } catch (_cleanupError) { /* The state expires automatically. */ }
    }
    const returnTo = stateRow?.return_to || "login.html";
    const destination = googleMessagePath(returnTo, "google_error", error instanceof Error ? error.message : "Google sign-in could not be completed.");
    return redirectResponse(googleDestination(origin, destination), expiredAuthCookieHeaders(request, "sl_google_oauth_state"));
  }
}

async function authCsrf(request) {
  const existing = parseCookies(request).sl_csrf;
  const token = /^[A-Za-z0-9_-]{30,60}$/.test(existing || "") ? existing : randomToken(32);
  return apiResponse({csrf_token: token}, 200, authCookieHeaders(request, "sl_csrf", token));
}

async function authMe(request, env) {
  const cookies = parseCookies(request);
  const row = await sessionUser(request, env);
  const existing = cookies.sl_csrf;
  const token = /^[A-Za-z0-9_-]{30,60}$/.test(existing || "") ? existing : randomToken(32);
  const responseCookies = authCookieHeaders(request, "sl_csrf", token);
  // Migrate an existing host-only session to the shared apex cookie so a
  // member who signed in on one hostname can immediately use the other.
  if (row && cookies.sl_session && cookieDomainForRequest(request)) {
    responseCookies.push(...authCookieHeaders(request, "sl_session", cookies.sl_session, {httpOnly: true, maxAge: SESSION_MAX_AGE_SECONDS}));
  }
  return apiResponse({authenticated: Boolean(row), user: row ? selfUser(row) : null, csrf_token: token}, 200, responseCookies);
}

function safePresencePage(value) {
  const page = safeText(value, 120).split(/[?#]/, 1)[0].replace(/^\/+/, "");
  return /^[A-Za-z0-9._/-]+$/.test(page) && page ? page : "app";
}

async function presenceHeartbeat(request, env) {
  const row = await sessionUser(request, env);
  if (!row) return apiResponse({error: "Please log in to continue."}, 401);
  if (row.status !== "active") return apiResponse({error: "This account is not active."}, 403);
  const body = await readJson(request);
  const now = new Date().toISOString();
  const page = safePresencePage(body.page);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const cutoff = new Date(Date.now() - ONLINE_PRESENCE_WINDOW_SECONDS * 1000).toISOString();
  const historyCutoff = new Date(Date.now() - ONLINE_PRESENCE_HISTORY_SECONDS * 1000).toISOString();
  const dayKey = now.slice(0, 10);
  await db.batch([
    db.prepare(`INSERT INTO sl_user_presence (user_id, last_seen_at, page_path, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, page_path = excluded.page_path, updated_at = excluded.updated_at`)
      .bind(row.id, now, page, now),
    db.prepare(`INSERT INTO sl_user_presence_days (user_id, day_key, last_seen_at, page_path, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, day_key) DO UPDATE SET last_seen_at = excluded.last_seen_at, page_path = excluded.page_path, updated_at = excluded.updated_at`)
      .bind(row.id, dayKey, now, page, now),
    db.prepare("DELETE FROM sl_user_presence WHERE last_seen_at < ?").bind(cutoff),
    db.prepare("DELETE FROM sl_user_presence_days WHERE last_seen_at < ?").bind(historyCutoff)
  ]);
  return apiResponse({ok: true, last_seen_at: now, active_window_seconds: ONLINE_PRESENCE_WINDOW_SECONDS});
}

async function authUsernameAvailability(request, env) {
  const username = safeText(new URL(request.url).searchParams.get("username"), 30).toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    return apiResponse({available: false, reason: "invalid", username});
  }
  const row = await dbFor(env).prepare("SELECT id FROM sl_users WHERE lower(username) = lower(?) LIMIT 1").bind(username).first();
  return apiResponse({available: !row, reason: row ? "taken" : "available", username});
}

async function authRegister(request, env) {
  const body = await readJson(request);
  const input = registrationInput(body);
  const registrationSource = safeText(body && body.registration_source, 60);
  const isPreRegistration = registrationSource === "pre_registration" || registrationSource === "early_registration";
  const welcomeCredits = SIGNUP_CREDIT_AMOUNT;
  if (isPreRegistration && Date.now() < EARLY_REGISTRATION_OPEN_AT) {
    return apiResponse({
      error: "Early registration opens on October 1, 2026 at midnight IST.",
      code: "early_registration_not_open",
      opens_at: new Date(EARLY_REGISTRATION_OPEN_AT).toISOString(),
      launches_at: new Date(PLATFORM_LAUNCH_AT).toISOString()
    }, 403);
  }
  if (input.errors.length) return apiResponse({error: input.errors[0], errors: input.errors}, 400);
  const createdAt = new Date().toISOString();
  const row = createUserRow({
    id: newId("usr"), username: input.username, email: input.email, passwordHash: await hashPassword(input.password),
    profile: input.profile, preferences: input.preferences, safety: input.safety, timeCredits: welcomeCredits, createdAt, termsAcceptedAt: createdAt
  });
  const session = await sessionValues(row.id);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const phoneDigits = phoneLookup(input.profile.phone_number).replace(/\D/g, "");
  try {
    const usernameTaken = await db.prepare("SELECT id FROM sl_users WHERE lower(username) = lower(?) LIMIT 1").bind(input.username).first();
    if (usernameTaken) return apiResponse({error: "That username is already taken. Try another username.", code: "username_taken"}, 409);
    if (phoneDigits) {
      const phoneTaken = await db.prepare("SELECT id FROM sl_users WHERE replace(replace(replace(replace(replace(json_extract(profile_json, '$.phone_number'), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') = ? LIMIT 1").bind(phoneDigits).first();
      if (phoneTaken) return apiResponse({error: "That phone number is already registered. Try another number or sign in.", code: "phone_taken"}, 409);
    } else {
      const emailTaken = await db.prepare("SELECT id FROM sl_users WHERE lower(email) = lower(?) LIMIT 1").bind(input.email).first();
      if (emailTaken) return apiResponse({error: "That email address is already registered. Try another email or sign in.", code: "email_taken"}, 409);
    }
    const submittedFields = [];
    moderationTextFields(moderationSanitize(body), submittedFields);
    const moderationHits = moderationMatches(submittedFields, await moderationRules(db));
    if (moderationHits.length) {
      const itemId = newId("moderation");
      const pendingAt = new Date().toISOString();
      const submitter = {user_id: row.id, username: input.username, full_name: input.profile.display_name, email: input.email};
      const registrationData = {username: input.username, email: input.email, profile: input.profile, preferences: input.preferences, safety: input.safety, time_credits: welcomeCredits, terms_accepted_at: createdAt};
      const pendingItem = {id: itemId, user_id: row.id, triggered_rule: moderationHits[0].phrase};
      const registrationPayloadJson = JSON.stringify({registration_data: registrationData});
      const registrationContentJson = JSON.stringify({fields: submittedFields, submission: moderationSanitize(body), attachments: []});
      if (new TextEncoder().encode(registrationPayloadJson).byteLength + new TextEncoder().encode(registrationContentJson).byteLength > 700_000) {
        return apiResponse({error: "This flagged registration is too large to store safely for administrator review. Reduce the text and try again."}, 413);
      }
      await db.batch([
        db.prepare("INSERT INTO sl_moderation_items (id, user_id, content_type, source_path, source_method, payload_json, content_json, file_context_json, submitter_json, triggered_rule_id, triggered_rule, triggered_rules_json, status, submitted_at, replay_secret_hash) VALUES (?, ?, 'Account registration', '/api/auth/register', 'POST', ?, ?, '[]', ?, ?, ?, ?, 'pending', ?, ?)")
          .bind(itemId, row.id, registrationPayloadJson, registrationContentJson, JSON.stringify(submitter), moderationHits[0].rule_id, moderationHits[0].phrase, JSON.stringify(moderationHits), pendingAt, row.password_hash),
        moderationWriteAudit(db, pendingItem, "submitted", "pending", null, "blocked_word_detected", pendingAt)
      ]);
      return apiResponse({ok: true, message: "Your account submission is pending administrator review. It will not be visible until approved.", moderation: {id: itemId, status: "pending", content_type: "Account registration"}}, 202);
    }
    await db.batch([
      userInsert(db, row),
      streakAccountInsert(db, row.id, createdAt),
      sessionInsert(db, row.id, session),
      auditInsert(db, {targetId: row.id, action: "registered", details: `New ${isPreRegistration ? "early-registration" : "member"} account created with ${welcomeCredits} starter credits.`, createdAt})
    ]);
  } catch (error) {
    if (uniqueViolation(error)) {
      const usernameTaken = await db.prepare("SELECT id FROM sl_users WHERE lower(username) = lower(?) LIMIT 1").bind(input.username).first();
      if (usernameTaken) return apiResponse({error: "That username is already taken. Try another username.", code: "username_taken"}, 409);
      if (phoneDigits) {
        const phoneTaken = await db.prepare("SELECT id FROM sl_users WHERE replace(replace(replace(replace(replace(json_extract(profile_json, '$.phone_number'), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') = ? LIMIT 1").bind(phoneDigits).first();
        if (phoneTaken) return apiResponse({error: "That phone number is already registered. Try another number or sign in.", code: "phone_taken"}, 409);
      }
      return apiResponse({error: "That email address is already registered. Try another email or sign in.", code: "email_taken"}, 409);
    }
    throw error;
  }
  return apiResponse({ok: true, message: `Your ${isPreRegistration ? "early-registration" : "live member"} account is ready with ${welcomeCredits} starter credits.`, user: selfUser(row), csrf_token: parseCookies(request).sl_csrf}, 201,
    authCookieHeaders(request, "sl_session", session.token, {httpOnly: true, maxAge: SESSION_MAX_AGE_SECONDS})
  );
}

function organizationPasswordValid(password) {
  return passwordMeetsPolicy(password);
}

function organizationPolicy(row) {
  return {
    allow_external_access: Boolean(row && row.allow_external_access),
    blocked_categories: [...new Set(jsonArray(row && row.blocked_categories_json, []).map(category => safeText(category, 60)).filter(Boolean))]
  };
}

function organizationView(row) {
  return {
    id: row.id,
    name: row.name,
    owner_id: row.owner_id,
    policy: organizationPolicy(row),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function organizationActivityInsert(db, data) {
  return db.prepare("INSERT INTO sl_organization_activity (id, organization_id, actor_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId("org_activity"), data.organizationId, data.actorId || null, safeText(data.action, 80), safeText(data.details, 1000), data.createdAt);
}

async function organizationOwnerContext(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return {response: apiResponse({error: "Please log in to manage an organisation."}, 401)};
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const organization = await db.prepare("SELECT o.* FROM sl_organizations o INNER JOIN sl_organization_members m ON m.organization_id = o.id WHERE m.user_id = ? AND m.role = 'owner' LIMIT 1").bind(viewer.id).first();
  if (!organization) return {response: apiResponse({error: "This account is not an organisation administrator."}, 403)};
  return {db, viewer, organization};
}

async function organizationRegister(request, env) {
  const body = await readJson(request);
  const name = safeText(body.name, 160);
  const username = safeText(body.admin_username, 30).toLowerCase();
  const email = safeText(body.email, 254).toLowerCase();
  const password = String(body.password || "");
  const trustedReplay = MODERATION_REPLAY_CONTEXTS.get(request);
  const replayPasswordHash = trustedReplay?.path === "/api/organizations/register" ? safeText(body.__moderation_password_hash, 500) : "";
  const errors = [];
  if (name.length < 2) errors.push("Enter an organisation name.");
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) errors.push("Choose an administrator username with 3–30 letters, numbers, dots, dashes, or underscores; spaces are not allowed.");
  if (!/^\S+@\S+\.\S+$/.test(email)) errors.push("Enter a valid administrator email address.");
  if (!replayPasswordHash && !organizationPasswordValid(password)) errors.push(passwordPolicyMessage());
  if (!safeBoolean(body.terms, false)) errors.push("Accept the SwapLabs terms before creating your organisation.");
  if (errors.length) return apiResponse({error: errors[0], errors}, 400);

  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const existingUser = await findUserByLogin(db, email) || await findUserByLogin(db, username);
  if (existingUser) return apiResponse({error: "That administrator username or email address is already registered. Choose another."}, 409);

  const createdAt = new Date().toISOString();
  const profile = normalizeProfile({first_name: username, display_name: username, organization: name});
  const row = createUserRow({
    id: newId("usr"), username, email, passwordHash: replayPasswordHash || await hashPassword(password), profile,
    preferences: normalizePreferences({profile_visibility: "private"}), safety: normalizeSafety({}, profile),
    timeCredits: SIGNUP_CREDIT_AMOUNT, createdAt, termsAcceptedAt: createdAt
  });
  const organization = {id: newId("org"), name, owner_id: row.id, allow_external_access: 1, blocked_categories_json: "[]", created_at: createdAt, updated_at: createdAt};
  const session = await sessionValues(row.id);
  try {
    await db.batch([
      userInsert(db, row),
      streakAccountInsert(db, row.id, createdAt),
      sessionInsert(db, row.id, session),
      db.prepare("INSERT INTO sl_organizations (id, name, owner_id, allow_external_access, blocked_categories_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(organization.id, organization.name, organization.owner_id, organization.allow_external_access, organization.blocked_categories_json, organization.created_at, organization.updated_at),
      db.prepare("INSERT INTO sl_organization_members (organization_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(organization.id, row.id, createdAt),
      organizationActivityInsert(db, {organizationId: organization.id, actorId: row.id, action: "organisation_created", details: "Organisation workspace created.", createdAt}),
      auditInsert(db, {actorId: row.id, targetId: row.id, action: "organization_registered", details: `Organisation workspace created: ${name}.`, createdAt})
    ]);
  } catch (error) {
    if (uniqueViolation(error)) return apiResponse({error: "That administrator username or email address is already registered. Choose another."}, 409);
    throw error;
  }
  return apiResponse({ok: true, message: "Organisation created.", organization: organizationView(organization), user: selfUser(row), csrf_token: parseCookies(request).sl_csrf}, 201,
    authCookieHeaders(request, "sl_session", session.token, {httpOnly: true, maxAge: SESSION_MAX_AGE_SECONDS})
  );
}

async function organizationOverview(request, env) {
  const context = await organizationOwnerContext(request, env);
  if (context.response) return context.response;
  const {db, organization} = context;
  const membersResult = await db.prepare("SELECT u.*, m.role AS organization_role, m.created_at AS member_since FROM sl_organization_members m INNER JOIN sl_users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.created_at ASC").bind(organization.id).all();
  const activityResult = await db.prepare("SELECT action, details, created_at FROM sl_organization_activity WHERE organization_id = ? ORDER BY created_at DESC LIMIT 50").bind(organization.id).all();
  const members = (membersResult.results || []).map(row => ({...selfUser(row), organization_role: row.organization_role, member_since: row.member_since}));
  return apiResponse({ok: true, organization: organizationView(organization), policy: organizationPolicy(organization), members, activity: activityResult.results || []});
}

async function organizationCreateMember(request, env) {
  const context = await organizationOwnerContext(request, env);
  if (context.response) return context.response;
  const {db, viewer, organization} = context;
  const body = await readJson(request);
  const displayName = safeText(body.display_name, 120);
  const email = safeText(body.email, 254).toLowerCase();
  const password = String(body.password || "");
  const trustedReplay = MODERATION_REPLAY_CONTEXTS.get(request);
  const replayPasswordHash = trustedReplay?.path === "/api/organizations/members" ? safeText(body.__moderation_password_hash, 500) : "";
  if (!displayName) return apiResponse({error: "Enter the member's name."}, 400);
  if (!/^\S+@\S+\.\S+$/.test(email)) return apiResponse({error: "Enter a valid member email address."}, 400);
  if (!replayPasswordHash && !organizationPasswordValid(password)) return apiResponse({error: passwordPolicyMessage()}, 400);
  if (await findUserByLogin(db, email)) return apiResponse({error: "That member email address is already registered."}, 409);

  const emailPrefix = safeText(email.split("@")[0], 24).toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 20) || "member";
  let username = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${emailPrefix}-${randomToken(4).toLowerCase()}`.slice(0, 30);
    if (!(await findUserByLogin(db, candidate))) { username = candidate; break; }
  }
  if (!username) return apiResponse({error: "The member account could not be prepared. Please try again."}, 503);

  const createdAt = new Date().toISOString();
  const profile = normalizeProfile({first_name: displayName, display_name: displayName, organization: organization.name});
  const row = createUserRow({
    id: newId("usr"), username, email, passwordHash: replayPasswordHash || await hashPassword(password), profile,
    preferences: normalizePreferences({profile_visibility: "private"}), safety: normalizeSafety({}, profile),
    timeCredits: SIGNUP_CREDIT_AMOUNT, createdAt, termsAcceptedAt: createdAt
  });
  try {
    await db.batch([
      userInsert(db, row),
      streakAccountInsert(db, row.id, createdAt),
      db.prepare("INSERT INTO sl_organization_members (organization_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(organization.id, row.id, createdAt),
      organizationActivityInsert(db, {organizationId: organization.id, actorId: viewer.id, action: "member_created", details: `Member account created for ${displayName}.`, createdAt}),
      auditInsert(db, {actorId: viewer.id, targetId: row.id, action: "organization_member_created", details: `Organisation member account created for ${displayName}.`, createdAt})
    ]);
  } catch (error) {
    if (uniqueViolation(error)) return apiResponse({error: "That member email address is already registered."}, 409);
    throw error;
  }
  return apiResponse({ok: true, message: "Member account created.", member: {...selfUser(row), organization_role: "member"}}, 201);
}

async function organizationResetMemberPassword(request, env, userId) {
  const context = await organizationOwnerContext(request, env);
  if (context.response) return context.response;
  const {db, viewer, organization} = context;
  const row = await db.prepare("SELECT u.* FROM sl_organization_members m INNER JOIN sl_users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.user_id = ? AND m.role = 'member' LIMIT 1").bind(organization.id, userId).first();
  if (!row) return apiResponse({error: "That organisation member was not found."}, 404);
  const temporary = temporaryPassword();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE sl_users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(temporary), now, row.id),
    db.prepare("DELETE FROM sl_sessions WHERE user_id = ?").bind(row.id),
    organizationActivityInsert(db, {organizationId: organization.id, actorId: viewer.id, action: "member_password_reset", details: `Temporary password generated for ${row.username}.`, createdAt: now}),
    auditInsert(db, {actorId: viewer.id, targetId: row.id, action: "organization_member_password_reset", details: "Organisation administrator generated a one-time temporary password.", createdAt: now})
  ]);
  return apiResponse({ok: true, message: "Temporary password generated. It is shown only once; ask the member to change it after signing in.", temporary_password: temporary});
}

async function organizationUpdatePolicy(request, env) {
  const context = await organizationOwnerContext(request, env);
  if (context.response) return context.response;
  const {db, viewer, organization} = context;
  const body = await readJson(request);
  const rawCategories = Array.isArray(body.blocked_categories) ? body.blocked_categories : safeText(body.blocked_categories, 1200).split(",");
  const blockedCategories = [...new Set(rawCategories.map(category => safeText(category, 60)).filter(Boolean))].slice(0, 20);
  const allowExternalAccess = Object.prototype.hasOwnProperty.call(body, "allow_external_access")
    ? safeBoolean(body.allow_external_access, true)
    : Boolean(organization.allow_external_access);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE sl_organizations SET allow_external_access = ?, blocked_categories_json = ?, updated_at = ? WHERE id = ?").bind(allowExternalAccess ? 1 : 0, JSON.stringify(blockedCategories), now, organization.id),
    organizationActivityInsert(db, {organizationId: organization.id, actorId: viewer.id, action: "policy_updated", details: "Organisation access policy updated.", createdAt: now})
  ]);
  const updated = {...organization, allow_external_access: allowExternalAccess ? 1 : 0, blocked_categories_json: JSON.stringify(blockedCategories), updated_at: now};
  return apiResponse({ok: true, policy: organizationPolicy(updated), organization: organizationView(updated)});
}

function giftVoucherCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const groups = [];
  for (let index = 0; index < bytes.length; index += 4) {
    groups.push([...bytes.slice(index, index + 4)].map(byte => alphabet[byte % alphabet.length]).join(""));
  }
  return "SL-GIFT-" + groups.join("-");
}

function normalizeVoucherCode(value) {
  return safeText(value, 40).toUpperCase().replace(/\s+/g, "");
}

function voucherAmount(value) {
  const amount = Number(value);
  return Number.isInteger(amount) && amount >= 1 && amount <= VOUCHER_MAX_AMOUNT ? amount : null;
}

function voucherView(row) {
  return {
    id: row.id,
    amount: Number(row.amount || 0),
    status: row.status,
    code_preview: row.code_prefix ? row.code_prefix + "-••••-••••" : "SL-GIFT-••••-••••-••••",
    created_at: row.created_at,
    redeemed_at: row.redeemed_at || null,
    redeemer_id: row.redeemer_id || null,
    redeemer_username: row.redeemer_username || null,
    redeemer_display_name: row.redeemer_display_name || null
  };
}

async function giftVouchers(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to manage gift vouchers."}, 401);
  const db = dbFor(env);
  const account = await findUserById(db, viewer.id);
  const result = await db.prepare("SELECT v.*, u.username AS redeemer_username, json_extract(u.profile_json, '$.display_name') AS redeemer_display_name FROM sl_credit_vouchers v LEFT JOIN sl_users u ON u.id = v.redeemer_id WHERE v.creator_id = ? ORDER BY v.created_at DESC LIMIT 100").bind(viewer.id).all();
  return apiResponse({ok: true, balance: Number(account?.time_credits || 0), vouchers: (result.results || []).map(voucherView)});
}

async function createGiftVoucher(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before creating a gift voucher."}, 401);
  if (viewer.status !== "active") return apiResponse({error: "This account cannot create a voucher right now."}, 403);
  const body = await readJson(request);
  const amount = voucherAmount(body.amount);
  if (amount === null) return apiResponse({error: `Choose a whole-number voucher amount between 1 and ${VOUCHER_MAX_AMOUNT.toLocaleString()} credits.`}, 400);
  const db = dbFor(env);
  const now = new Date().toISOString();
  const voucherId = newId("vch");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = giftVoucherCode();
    const codeHash = await sha256Hex(code);
    const codePrefix = code.split("-").slice(0, 3).join("-");
    try {
      const results = await db.batch([
        db.prepare("UPDATE sl_users SET time_credits = time_credits - ?, updated_at = ? WHERE id = ? AND status = 'active' AND time_credits >= ?").bind(amount, now, viewer.id, amount),
        db.prepare("INSERT INTO sl_credit_vouchers (id, code_hash, code_prefix, creator_id, amount, status, redeemer_id, created_at, redeemed_at) SELECT ?, ?, ?, ?, ?, 'active', NULL, ?, NULL WHERE changes() = 1").bind(voucherId, codeHash, codePrefix, viewer.id, amount, now),
        db.prepare("INSERT INTO sl_audit_log (id, actor_id, target_id, action, details, created_at) SELECT ?, ?, ?, 'voucher_created', ?, ? WHERE EXISTS (SELECT 1 FROM sl_credit_vouchers WHERE id = ?)").bind(newId("audit"), viewer.id, voucherId, `Created a ${amount}-credit gift voucher.`, now, voucherId)
      ]);
      if (Number(results?.[0]?.meta?.changes || 0) !== 1) return apiResponse({error: "You do not have enough credits for that voucher amount."}, 400);
      const updated = await findUserById(db, viewer.id);
      return apiResponse({ok: true, message: "Your one-time gift voucher is ready to share.", balance: Number(updated?.time_credits || 0), voucher: {...voucherView({id: voucherId, amount, status: "active", code_prefix: codePrefix, created_at: now}), code}} , 201);
    } catch (error) {
      if (!uniqueViolation(error) || attempt === 2) throw error;
    }
  }
  return apiResponse({error: "The voucher could not be created. Please try again."}, 503);
}

async function redeemGiftVoucher(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before redeeming a gift voucher."}, 401);
  if (viewer.status !== "active") return apiResponse({error: "This account cannot redeem a voucher right now."}, 403);
  const body = await readJson(request);
  const code = normalizeVoucherCode(body.code);
  if (!VOUCHER_CODE_PATTERN.test(code)) return apiResponse({error: "Enter a valid SwapLabs gift voucher code."}, 400);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const codeHash = await sha256Hex(code);
  const voucher = await db.prepare("SELECT * FROM sl_credit_vouchers WHERE code_hash = ? LIMIT 1").bind(codeHash).first();
  if (!voucher) return apiResponse({error: "That voucher code is not valid."}, 404);
  if (voucher.status !== "active") return apiResponse({error: "That voucher has already been redeemed and cannot be used again."}, 409);
  if (voucher.creator_id === viewer.id) return apiResponse({error: "Gift vouchers must be redeemed by someone else."}, 400);
  const amount = Number(voucher.amount || 0);
  const now = new Date().toISOString();
  const viewerParts = rowParts(viewer);
  const redeemerName = viewerParts.profile.display_name || completeName(viewerParts.profile, viewer.username);
  const results = await db.batch([
    db.prepare("UPDATE sl_users SET time_credits = time_credits + (SELECT amount FROM sl_credit_vouchers WHERE id = ? AND status = 'active' AND creator_id != ?) , updated_at = ? WHERE id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM sl_credit_vouchers WHERE id = ? AND status = 'active' AND creator_id != ?)").bind(voucher.id, viewer.id, now, viewer.id, voucher.id, viewer.id),
    db.prepare("UPDATE sl_credit_vouchers SET status = 'redeemed', redeemer_id = ?, redeemed_at = ? WHERE id = ? AND status = 'active' AND creator_id != ? AND changes() = 1").bind(viewer.id, now, voucher.id, viewer.id),
    db.prepare("INSERT INTO sl_audit_log (id, actor_id, target_id, action, details, created_at) SELECT ?, ?, ?, 'voucher_redeemed', ?, ? WHERE EXISTS (SELECT 1 FROM sl_credit_vouchers WHERE id = ? AND status = 'redeemed')").bind(newId("audit"), viewer.id, voucher.id, `Redeemed a ${amount}-credit gift voucher.`, now, voucher.id),
    db.prepare("INSERT INTO sl_notifications (id, user_id, actor_id, type, entity_id, message, read, created_at) SELECT ?, creator_id, ?, 'gift_voucher_redeemed', ?, ?, 0, ? FROM sl_credit_vouchers WHERE id = ? AND status = 'redeemed'").bind(newId("notif"), viewer.id, voucher.id, `${redeemerName} redeemed your ${amount}-credit gift voucher.`, now, voucher.id)
  ]);
  if (Number(results?.[0]?.meta?.changes || 0) !== 1 || Number(results?.[1]?.meta?.changes || 0) !== 1) {
    return apiResponse({error: "That voucher is no longer available."}, 409);
  }
  const updated = await findUserById(db, viewer.id);
  return apiResponse({ok: true, message: `${amount.toLocaleString()} credits were added to your account.`, balance: Number(updated?.time_credits || 0), amount}, 200);
}

/* PASSWORD_RECOVERY_IMPLEMENTATION */

async function authLogin(request, env) {
  const body = await readJson(request);
  const login = safeText(body.login || body.admin_id, 254);
  const password = String(body.password || "");
  if (!login || !password) return apiResponse({error: "Enter your username, email, or phone number and password."}, 400);
  if (password.length < PASSWORD_MIN_LENGTH) return apiResponse({error: passwordPolicyMessage()}, 400);
  const db = dbFor(env);
  const row = await findUserByLogin(db, login);
  const recovered = await recoveryTemporaryLogin(request, env, row, password);
  if (recovered) return recovered;
  if (!row || !(await verifyPassword(password, row.password_hash))) return apiResponse({error: "The username, email, or password is incorrect."}, 401);
  if (row.role === "admin") return apiResponse({error: "Use the administrator access checkpoint."}, 403);
  if (row.status === "suspended") return apiResponse({error: row.suspension_reason || "This account is temporarily suspended.", access_status: "suspended"}, 403);
  if (row.status !== "active") return apiResponse({error: "This account is not available."}, 403);
  const session = await sessionValues(row.id);
  const now = new Date().toISOString();
  await db.batch([
    sessionInsert(db, row.id, session),
    db.prepare("UPDATE sl_users SET last_login_at = ?, updated_at = ? WHERE id = ?").bind(now, now, row.id),
    auditInsert(db, {actorId: row.id, targetId: row.id, action: "signed_in", details: "Account sign-in completed.", createdAt: now})
  ]);
  return apiResponse({ok: true, user: selfUser({...row, last_login_at: now, updated_at: now}), csrf_token: parseCookies(request).sl_csrf}, 200,
    authCookieHeaders(request, "sl_session", session.token, {httpOnly: true, maxAge: SESSION_MAX_AGE_SECONDS})
  );
}

async function adminGate(request, env) {
  const expected = String(env && env.SWAPLABS_ADMIN_ACCESS_CODE || "");
  const body = await readJson(request);
  const submittedCode = safeText(body.code, 200);
  if (!expected || !constantTimeEqual(submittedCode, expected)) return apiResponse({error: "The administrator code is incorrect."}, 401);
  const db = dbFor(env);
  const row = await db.prepare("SELECT * FROM sl_users WHERE role = 'admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1").first();
  if (!row) return apiResponse({error: "Administrator access is not configured yet."}, 503);
  const session = await sessionValues(row.id);
  const now = new Date().toISOString();
  await db.batch([
    sessionInsert(db, row.id, session),
    db.prepare("UPDATE sl_users SET last_login_at = ?, updated_at = ? WHERE id = ?").bind(now, now, row.id),
    auditInsert(db, {actorId: row.id, targetId: row.id, action: "admin_gate_signed_in", details: "Administrator access checkpoint completed.", createdAt: now})
  ]);
  return apiResponse({ok: true, user: adminUser({...row, last_login_at: now, updated_at: now}), csrf_token: parseCookies(request).sl_csrf}, 200,
    authCookieHeaders(request, "sl_session", session.token, {httpOnly: true, maxAge: SESSION_MAX_AGE_SECONDS})
  );
}

async function authLogout(request, env) {
  const token = parseCookies(request).sl_session;
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const session = token ? await db.prepare("SELECT user_id FROM sl_sessions WHERE token_hash = ? LIMIT 1").bind(await sha256Hex(token)).first() : null;
  if (token) await db.prepare("DELETE FROM sl_sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  if (session?.user_id) await db.prepare("DELETE FROM sl_user_presence WHERE user_id = ?").bind(session.user_id).run();
  return apiResponse({ok: true}, 200, expiredAuthCookieHeaders(request, "sl_session"));
}

async function profileUpdate(request, env) {
  const row = await sessionUser(request, env);
  if (!row) return apiResponse({error: "Please log in to update your profile."}, 401);
  const body = await readJson(request);
  const old = rowParts(row);
  const profile = normalizeProfile(body.profile, old.profile);
  const preferences = normalizePreferences(body.preferences, old.preferences);
  const safety = normalizeSafety(body.safety, profile, old.safety);
  const age = profileAge(profile);
  if (Number.isFinite(age)) profile.age = String(age);
  profile.display_name = profile.display_name || [profile.first_name, profile.last_name].filter(Boolean).join(" ");
  if (row.role !== "admin" && (!validName(profile.display_name, "display_name") || !validName(profile.first_name, "first_name") || !validName(profile.last_name, "last_name"))) {
    return apiResponse({error: NAME_FORMAT_ERROR}, 400);
  }
  if (safety.is_minor) {
    preferences.show_location = false;
    if (!safety.guardian_name || !safety.guardian_email || !safety.guardian_relationship || !safety.guardian_consent_declared) {
      return apiResponse({error: "A parent or guardian must provide consent for children under 13."}, 400);
    }
  }
  if (!profile.display_name) return apiResponse({error: "Your profile needs a display name."}, 400);
  const now = new Date().toISOString();
  const db = dbFor(env);
  await db.batch([
    db.prepare("UPDATE sl_users SET profile_json = ?, preferences_json = ?, safety_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(profile), JSON.stringify(preferences), JSON.stringify(safety), now, row.id),
    auditInsert(db, {actorId: row.id, targetId: row.id, action: "profile_updated", details: "Member profile and preferences updated.", createdAt: now})
  ]);
  return apiResponse({ok: true, user: selfUser({...row, profile_json: JSON.stringify(profile), preferences_json: JSON.stringify(preferences), safety_json: JSON.stringify(safety), updated_at: now})});
}

async function profilePassword(request, env) {
  const row = await sessionUser(request, env);
  if (!row) return apiResponse({error: "Please log in to change your password."}, 401);
  const body = await readJson(request);
  const current = String(body.current_password || "");
  const next = String(body.new_password || "");
  if (!(await verifyPassword(current, row.password_hash))) return apiResponse({error: "Your current password is incorrect."}, 400);
  if (!passwordMeetsPolicy(next)) return apiResponse({error: passwordPolicyMessage()}, 400);
  const now = new Date().toISOString();
  const db = dbFor(env);
  await db.batch([
    db.prepare("UPDATE sl_users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(next), now, row.id),
    auditInsert(db, {actorId: row.id, targetId: row.id, action: "password_changed", details: "Member password changed.", createdAt: now})
  ]);
  return apiResponse({ok: true, message: "Your password has been updated."});
}

function photoKeyFromUrl(value) {
  const match = /^\/uploads\/(usr_[A-Za-z0-9_-]+\.(?:jpg|png|webp))$/.exec(String(value || ""));
  return match ? "uploads/" + match[1] : null;
}

async function staticAsset(request, env, assetPath = null) {
  if (!env || !env.ASSETS || !["GET", "HEAD"].includes(request.method)) return null;
  const target = new URL(request.url);
  if (assetPath) target.pathname = assetPath;
  const assetRequest = new Request(target.toString(), {
    method: request.method,
    headers: request.headers
  });
  const response = await env.ASSETS.fetch(assetRequest);
  if (response.status === 404) return null;
  if (["/credits.html", "/site-credits.html"].includes(target.pathname) && request.method === "GET") {
    // Keep both original SwapLabs credit pages intact; supply the shared
    // navigation dependency at response time only.
    const body = (await response.text()).replace(
      '<script src="scripts/swaplabs.js',
      '<script src="/scripts/relay-components.js"></script>\n  <script src="scripts/swaplabs.js'
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set("cache-control", "no-store");
    return new Response(body, {status: response.status, headers});
  }
  if (["/forgot-password.html", "/reset-password.html", "/login.html"].includes(target.pathname)) {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    return new Response(request.method === "HEAD" ? null : response.body, {status: response.status, statusText: response.statusText, headers});
  }
  if (hasPrivateSession(request)) return response;
  const headers = new Headers(response.headers);
  const contentType = headers.get("content-type") || "";
  const policy = cachePolicy(target.pathname, request) || (contentType.startsWith("text/html") ? "public, max-age=60, stale-while-revalidate=300" : null);
  if (policy) headers.set("cache-control", policy);
  return new Response(request.method === "HEAD" ? null : response.body, {status: response.status, statusText: response.statusText, headers});
}

async function notFoundPage(request, env) {
  if (!env || !env.ASSETS || !["GET", "HEAD"].includes(request.method)) {
    return new Response("Not Found", {status: 404, headers: {"content-type": "text/plain; charset=utf-8", "cache-control": "no-store"}});
  }
  const page = await staticAsset(request, env, "/404.html");
  if (!page) return new Response("Not Found", {status: 404, headers: {"content-type": "text/plain; charset=utf-8", "cache-control": "no-store"}});
  const headers = new Headers(page.headers);
  headers.set("cache-control", hasPrivateSession(request) ? "private, no-store" : "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400");
  headers.set("x-swappublic-page", "not-found");
  return new Response(request.method === "HEAD" ? null : page.body, {status: 404, statusText: "Not Found", headers});
}

async function servePhoto(request, env, path) {
  const match = /^\/(?:uploads|profile-media)\/(usr_[A-Za-z0-9_-]+\.(?:jpg|png|webp))$/.exec(path);
  if (!match) return null;
  const key = "uploads/" + match[1];
  if (!env || !env.BUCKET) return staticAsset(request, env, "/" + key);
  const object = await env.BUCKET.get(key);
  if (!object) return staticAsset(request, env, "/" + key) || new Response("Not Found", {status: 404, headers: {"cache-control": "public, max-age=60"}});
  const headers = new Headers({"cache-control": "public, max-age=86400, stale-while-revalidate=604800", "content-type": object.httpMetadata && object.httpMetadata.contentType || "image/jpeg"});
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(request.method === "HEAD" ? null : object.body, {status: 200, headers});
}

async function serveMessageAttachment(request, env, path) {
  const match = /^\/uploads\/(msg_[A-Za-z0-9_-]+\.[A-Za-z0-9]+)$/.exec(path);
  if (!match || !env || !env.BUCKET) return null;
  const viewer = await sessionUser(request, env);
  if (!viewer) return new Response("Not Found", {status: 404, headers: {"cache-control": "no-store"}});
  const key = "uploads/" + match[1];
  const db = dbFor(env);
  const authorized = await db.prepare(`SELECT 1 FROM sl_messages m
    INNER JOIN sl_conversation_members cm ON cm.conversation_id = m.conversation_id
    WHERE cm.user_id = ? AND cm.hidden = 0 AND json_extract(m.metadata_json, '$.attachment.key') = ? LIMIT 1`).bind(viewer.id, key).first();
  if (!authorized) return new Response("Not Found", {status: 404, headers: {"cache-control": "no-store"}});
  const object = await env.BUCKET.get(key);
  if (!object) return new Response("Not Found", {status: 404, headers: {"cache-control": "private, no-store"}});
  const headers = new Headers({"cache-control": "private, no-store", "content-type": object.httpMetadata?.contentType || "application/octet-stream"});
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(request.method === "HEAD" ? null : object.body, {status: 200, headers});
}

function communityMediaView(row) {
  if (!row || !row.media_key) return null;
  return {
    url: "/" + row.media_key,
    type: row.media_type || row.media_content_type || "",
    content_type: row.media_content_type || row.media_type || ""
  };
}

function communityAuthorView(row, viewerId, canViewFull) {
  const profile = parseJson(row.profile_json, normalizeProfile({}));
  const preferences = normalizePreferences(parseJson(row.preferences_json, {}));
  const publicProfile = preferences.profile_visibility !== "private";
  const fullName = completeName(profile, row.username);
  return {
    id: row.id,
    username: row.username,
    display_name: profile.display_name || fullName,
    full_name: fullName,
    // Keep the avatar visible as part of the member identity preview even when
    // the rest of a private profile is locked.
    avatar_url: publicAvatarUrl(profile.avatar_url),
    profile_color: profile.profile_color || "indigo",
    headline: profile.headline || profile.professional_role || "SwapLabs member",
    visibility: publicProfile ? "public" : "private"
  };
}

function communityJoinedUser(row) {
  return {
    id: row.author_id,
    username: row.author_username,
    profile_json: row.author_profile_json,
    preferences_json: row.author_preferences_json,
    safety_json: row.author_safety_json
  };
}

function communityVisibilityAllowed(authorId, visibility, viewerId, followingSet) {
  if (visibility !== "followers") return true;
  return Boolean(viewerId && (viewerId === authorId || followingSet.has(authorId)));
}

async function communityFollowingSet(db, viewerId) {
  if (!viewerId) return new Set();
  await ensureFeatureSchema(db);
  const result = await db.prepare("SELECT following_id FROM sl_follows WHERE follower_id = ? AND status = 'accepted'").bind(viewerId).all();
  return new Set((result.results || []).map(row => row.following_id));
}

async function communityPostRow(db, postId) {
  return db.prepare("SELECT p.*, u.username AS author_username, u.profile_json AS author_profile_json, u.preferences_json AS author_preferences_json, u.safety_json AS author_safety_json FROM sl_community_posts p INNER JOIN sl_users u ON u.id = p.author_id WHERE p.id = ? AND u.status = 'active' LIMIT 1").bind(postId).first();
}

async function communityStoryRow(db, storyId) {
  return db.prepare("SELECT s.*, u.username AS author_username, u.profile_json AS author_profile_json, u.preferences_json AS author_preferences_json, u.safety_json AS author_safety_json FROM sl_community_stories s INNER JOIN sl_users u ON u.id = s.author_id WHERE s.id = ? AND u.status = 'active' LIMIT 1").bind(storyId).first();
}

function communityPostView(row, viewerId, followingSet) {
  const visible = communityVisibilityAllowed(row.author_id, row.visibility, viewerId, followingSet);
  const author = communityAuthorView(communityJoinedUser(row), viewerId, visible);
  return {
    id: row.id,
    body: row.body || "",
    visibility: row.visibility,
    created_at: row.created_at,
    updated_at: row.updated_at,
    author,
    media: visible ? communityMediaView(row) : null,
    counts: {
      likes: Number(row.like_count || 0),
      comments: Number(row.comment_count || 0),
      shares: Number(row.share_count || 0)
    },
    viewer_liked: Boolean(Number(row.viewer_liked || 0)),
    viewer_shared: Boolean(Number(row.viewer_shared || 0))
  };
}

function communityStoryView(row, viewerId, followingSet) {
  const visible = communityVisibilityAllowed(row.author_id, row.visibility, viewerId, followingSet);
  return {
    id: row.id,
    body: row.body || "",
    visibility: row.visibility,
    created_at: row.created_at,
    expires_at: row.expires_at,
    author: communityAuthorView(communityJoinedUser(row), viewerId, visible),
    media: visible ? communityMediaView(row) : null
  };
}

function communityAuthorFromPublicUser(user) {
  return {
    ...user,
    display_name: user.profile?.display_name || user.username,
    avatar_url: publicAvatarUrl(user.profile?.avatar_url),
    profile_color: user.profile?.profile_color || "indigo",
    headline: user.profile?.headline || user.profile?.professional_role || "SwapLabs member"
  };
}

async function communityFeed(request, env) {
  let viewer = null;
  try { viewer = await sessionUser(request, env); } catch (_error) { viewer = null; }
  const db = dbFor(env);
  const followingSet = await communityFollowingSet(db, viewer?.id);
  const url = new URL(request.url);
  const sort = url.searchParams.get("sort") === "following" ? "following" : "latest";
  const viewerId = viewer?.id || "";
  const postsResult = await db.prepare(`SELECT p.*, u.username AS author_username, u.profile_json AS author_profile_json, u.preferences_json AS author_preferences_json, u.safety_json AS author_safety_json,
      (SELECT COUNT(*) FROM sl_community_post_likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM sl_community_post_comments c WHERE c.post_id = p.id AND c.status = 'visible') AS comment_count,
      (SELECT COUNT(*) FROM sl_community_post_shares s WHERE s.post_id = p.id) AS share_count,
      CASE WHEN ? != '' AND EXISTS (SELECT 1 FROM sl_community_post_likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) THEN 1 ELSE 0 END AS viewer_liked,
      CASE WHEN ? != '' AND EXISTS (SELECT 1 FROM sl_community_post_shares s2 WHERE s2.post_id = p.id AND s2.user_id = ?) THEN 1 ELSE 0 END AS viewer_shared
    FROM sl_community_posts p
    INNER JOIN sl_users u ON u.id = p.author_id
    WHERE p.status = 'published' AND u.status = 'active'
    ORDER BY p.created_at DESC LIMIT 80`).bind(viewerId, viewerId, viewerId, viewerId).all();
  const postRows = (postsResult.results || []).filter(row =>
    communityVisibilityAllowed(row.author_id, row.visibility, viewer?.id, followingSet) &&
    (sort !== "following" || Boolean(viewer && (row.author_id === viewer.id || followingSet.has(row.author_id))))
  );
  const posts = postRows.slice(0, 40).map(row => communityPostView(row, viewer?.id, followingSet));

  const now = new Date().toISOString();
  const storiesResult = await db.prepare("SELECT s.*, u.username AS author_username, u.profile_json AS author_profile_json, u.preferences_json AS author_preferences_json, u.safety_json AS author_safety_json FROM sl_community_stories s INNER JOIN sl_users u ON u.id = s.author_id WHERE s.status = 'published' AND s.expires_at > ? AND u.status = 'active' ORDER BY s.created_at DESC LIMIT 80").bind(now).all();
  const stories = (storiesResult.results || []).filter(row => communityVisibilityAllowed(row.author_id, row.visibility, viewer?.id, followingSet)).slice(0, 40).map(row => communityStoryView(row, viewer?.id, followingSet));

  const snapshot = await followSnapshot(db, viewer?.id);
  const allRows = await allUserRows(db);
  const discover = allRows.filter(row => row.role === "member" && row.status === "active" && row.id !== viewer?.id)
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    .slice(0, 8)
    .map(row => {
      const parts = rowParts(row);
      const relationship = snapshot.relationship.get(row.id) || "none";
      return communityAuthorFromPublicUser(commonPublicFields(row, parts.profile, parts.preferences, parts.safety, viewer?.id, relationship, publicUserCounts(snapshot, row.id)));
    });
  return apiResponse({
    ok: true,
    viewer: viewer ? selfUser(viewer) : null,
    posts,
    stories,
    discover,
    sort,
    updated_at: new Date().toISOString()
  });
}

function communityVisibilityFor(parts, requested) {
  const requestedVisibility = requested === "followers" ? "followers" : "public";
  return parts.safety.is_minor || parts.preferences.profile_visibility === "private" ? "followers" : requestedVisibility;
}

async function communityMediaUpload(env, file, prefix, maxBytes) {
  if (!file || typeof file.arrayBuffer !== "function") return {key: "", type: "", contentType: ""};
  if (!env || !env.BUCKET) throw Object.assign(new Error("Community media storage is temporarily unavailable."), {status: 503});
  const contentType = String(file.type || "").toLowerCase();
  const extension = ALLOWED_COMMUNITY_MEDIA_TYPES.get(contentType);
  if (!extension) throw Object.assign(new Error("Choose a JPG, PNG, WebP, MP4, or WebM file."), {status: 400});
  if (Number(file.size || 0) > maxBytes) throw Object.assign(new Error(`That file is too large. Choose a file no larger than ${Math.round(maxBytes / 1_000_000)} MB.`), {status: 400});
  const key = `community-media/${prefix}.${extension}`;
  await env.BUCKET.put(key, await file.arrayBuffer(), {httpMetadata: {contentType, cacheControl: "public, max-age=86400, stale-while-revalidate=604800"}});
  return {key, type: contentType.startsWith("video/") ? "video" : "image", contentType};
}

async function createCommunityPost(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before publishing a post."}, 401);
  if (viewer.status !== "active") return apiResponse({error: "This account cannot publish right now."}, 403);
  const type = request.headers.get("content-type") || "";
  let body = {};
  let file = null;
  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    body.body = form.get("body");
    body.visibility = form.get("visibility");
    file = form.get("media");
  } else body = await readJson(request);
  const text = safeText(body.body, 2000);
  if (String(body.body || "").length > 2000) return apiResponse({error: "Keep posts to 2,000 characters or fewer."}, 400);
  if (!text && (!file || typeof file.arrayBuffer !== "function")) return apiResponse({error: "Add a thought or attach a photo/video before posting."}, 400);
  const db = dbFor(env);
  const parts = rowParts(viewer);
  const visibility = communityVisibilityFor(parts, body.visibility);
  const id = newId("post");
  const media = await communityMediaUpload(env, file, id, String(file?.type || "").startsWith("video/") ? 40_000_000 : 8_000_000);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO sl_community_posts (id, author_id, body, visibility, media_key, media_type, media_content_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)").bind(id, viewer.id, text, visibility, media.key, media.type, media.contentType, now, now),
    auditInsert(db, {actorId: viewer.id, targetId: viewer.id, action: "community_post_created", details: "Published a community post.", createdAt: now})
  ]);
  return apiResponse({ok: true, message: "Your post is live in the SwapLabs community.", post_id: id}, 201);
}

async function createCommunityStory(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before sharing a story."}, 401);
  if (viewer.status !== "active") return apiResponse({error: "This account cannot share a story right now."}, 403);
  const type = request.headers.get("content-type") || "";
  let body = {};
  let file = null;
  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    body.body = form.get("body");
    body.visibility = form.get("visibility");
    file = form.get("media");
  } else body = await readJson(request);
  const text = safeText(body.body, 500);
  if (String(body.body || "").length > 500) return apiResponse({error: "Keep stories to 500 characters or fewer."}, 400);
  if (!text && (!file || typeof file.arrayBuffer !== "function")) return apiResponse({error: "Add a short note or attach a photo/video before sharing."}, 400);
  const db = dbFor(env);
  const parts = rowParts(viewer);
  const visibility = communityVisibilityFor(parts, body.visibility);
  const id = newId("story");
  const media = await communityMediaUpload(env, file, id, String(file?.type || "").startsWith("video/") ? 25_000_000 : 8_000_000);
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  await db.batch([
    db.prepare("INSERT INTO sl_community_stories (id, author_id, body, visibility, media_key, media_type, media_content_type, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)").bind(id, viewer.id, text, visibility, media.key, media.type, media.contentType, expiresAt, createdAt, createdAt),
    auditInsert(db, {actorId: viewer.id, targetId: viewer.id, action: "community_story_created", details: "Shared a 24-hour community story.", createdAt})
  ]);
  return apiResponse({ok: true, message: "Your story is live for 24 hours.", story_id: id}, 201);
}

function groupMemberView(row) {
  const profile = parseJson(row.profile_json, normalizeProfile({}));
  return {
    id: row.user_id || row.id,
    username: row.username,
    display_name: profile.display_name || completeName(profile, row.username),
    avatar_url: publicAvatarUrl(profile.avatar_url),
    profile_color: profile.profile_color || "indigo"
  };
}

async function communityGroupView(db, row, viewerId) {
  const memberResult = await db.prepare("SELECT gm.*, u.username, u.profile_json, u.preferences_json, u.safety_json FROM sl_community_group_members gm INNER JOIN sl_users u ON u.id = gm.user_id WHERE gm.group_id = ? AND gm.status = 'active' AND u.status = 'active' ORDER BY gm.created_at ASC LIMIT 12").bind(row.id).all();
  const members = (memberResult.results || []).map(groupMemberView);
  const count = await db.prepare("SELECT COUNT(*) AS count FROM sl_community_group_members WHERE group_id = ? AND status = 'active'").bind(row.id).first();
  const moderatorsResult = await db.prepare("SELECT user_id FROM sl_community_group_members WHERE group_id = ? AND status = 'active' AND role IN ('moderator', 'admin')").bind(row.id).all();
  const membership = viewerId ? await db.prepare("SELECT * FROM sl_community_group_members WHERE group_id = ? AND user_id = ? LIMIT 1").bind(row.id, viewerId).first() : null;
  const pending = viewerId ? await db.prepare("SELECT id FROM sl_community_group_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending' LIMIT 1").bind(row.id, viewerId).first() : null;
  const viewerIsModerator = Boolean(membership && membership.status === "active" && ["moderator", "admin"].includes(membership.role));
  let pendingJoinRequests = [];
  if (viewerIsModerator) {
    const requestResult = await db.prepare("SELECT r.*, u.username, u.profile_json, u.preferences_json, u.safety_json FROM sl_community_group_join_requests r INNER JOIN sl_users u ON u.id = r.user_id WHERE r.group_id = ? AND r.status = 'pending' AND u.status = 'active' ORDER BY r.created_at ASC LIMIT 50").bind(row.id).all();
    pendingJoinRequests = (requestResult.results || []).map(groupMemberView);
  }
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    title: row.title,
    description: row.description || "",
    category: row.category || "Community",
    icon: row.icon || "bx-group",
    accent: row.accent || "blue",
    requires_approval: Boolean(row.requires_approval),
    member_count: Number(count?.count || 0),
    moderator_ids: (moderatorsResult.results || []).map(item => item.user_id),
    members,
    pinned_messages: [],
    joined: Boolean(membership && membership.status === "active"),
    viewer_request_pending: Boolean(pending),
    viewer_is_moderator: viewerIsModerator,
    pending_join_count: pendingJoinRequests.length,
    pending_join_requests: pendingJoinRequests
  };
}

async function communityGroups(request, env) {
  let viewer = null;
  try { viewer = await sessionUser(request, env); } catch (_error) { viewer = null; }
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const result = await db.prepare("SELECT * FROM sl_community_groups ORDER BY updated_at DESC, created_at ASC").all();
  const groups = [];
  for (const row of result.results || []) groups.push(await communityGroupView(db, row, viewer?.id));
  return apiResponse({ok: true, groups, updated_at: new Date().toISOString()});
}

async function communityGroupJoin(request, env, groupId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before joining a community group."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const group = await db.prepare("SELECT * FROM sl_community_groups WHERE id = ? LIMIT 1").bind(groupId).first();
  if (!group) return apiResponse({error: "That community group is no longer available."}, 404);
  const now = new Date().toISOString();
  const current = await db.prepare("SELECT * FROM sl_community_group_members WHERE group_id = ? AND user_id = ? LIMIT 1").bind(groupId, viewer.id).first();
  if (request.method === "DELETE") {
    if (group.created_by === viewer.id) return apiResponse({error: "The group creator cannot leave this community group."}, 400);
    await db.batch([
      db.prepare("DELETE FROM sl_community_group_members WHERE group_id = ? AND user_id = ?").bind(groupId, viewer.id),
      db.prepare("DELETE FROM sl_conversation_members WHERE conversation_id = ? AND user_id = ?").bind(group.conversation_id, viewer.id),
      db.prepare("UPDATE sl_community_group_join_requests SET status = 'cancelled', updated_at = ? WHERE group_id = ? AND user_id = ? AND status = 'pending'").bind(now, groupId, viewer.id)
    ]);
    return apiResponse({ok: true, message: `You left ${group.title}.`});
  }
  if (current?.status === "active") return apiResponse({ok: true, message: `You are already in ${group.title}.`, group: await communityGroupView(db, group, viewer.id)});
  if (Boolean(group.requires_approval)) {
    await db.prepare("INSERT OR IGNORE INTO sl_community_group_join_requests (id, group_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)").bind(newId("group-request"), groupId, viewer.id, now, now).run();
    await db.prepare("UPDATE sl_community_group_join_requests SET status = 'pending', updated_at = ? WHERE group_id = ? AND user_id = ?").bind(now, groupId, viewer.id).run();
    return apiResponse({ok: true, message: "Your request to join is waiting for a moderator."});
  }
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO sl_community_group_members (group_id, user_id, status, role, created_at, updated_at) VALUES (?, ?, 'active', 'member', COALESCE((SELECT created_at FROM sl_community_group_members WHERE group_id = ? AND user_id = ?), ?), ?)").bind(groupId, viewer.id, groupId, viewer.id, now, now),
    db.prepare("INSERT OR IGNORE INTO sl_conversation_members (conversation_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(group.conversation_id, viewer.id, now),
    db.prepare("UPDATE sl_community_group_join_requests SET status = 'approved', updated_at = ? WHERE group_id = ? AND user_id = ? AND status = 'pending'").bind(now, groupId, viewer.id)
  ]);
  return apiResponse({ok: true, message: `You joined ${group.title}.`, group: await communityGroupView(db, group, viewer.id)});
}

async function communityGroupJoinRequest(request, env, groupId, memberId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to moderate community groups."}, 401);
  const body = await readJson(request);
  const approve = safeBoolean(body.approve, false);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const group = await db.prepare("SELECT * FROM sl_community_groups WHERE id = ? LIMIT 1").bind(groupId).first();
  if (!group) return apiResponse({error: "That community group is no longer available."}, 404);
  const moderator = await db.prepare("SELECT * FROM sl_community_group_members WHERE group_id = ? AND user_id = ? AND status = 'active' AND role IN ('moderator', 'admin') LIMIT 1").bind(groupId, viewer.id).first();
  if (!moderator) return apiResponse({error: "Only community moderators can review join requests."}, 403);
  const requestRow = await db.prepare("SELECT * FROM sl_community_group_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending' LIMIT 1").bind(groupId, memberId).first();
  if (!requestRow) return apiResponse({error: "That join request is no longer pending."}, 404);
  const now = new Date().toISOString();
  if (approve) {
    await db.batch([
      db.prepare("UPDATE sl_community_group_join_requests SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, requestRow.id),
      db.prepare("INSERT OR REPLACE INTO sl_community_group_members (group_id, user_id, status, role, created_at, updated_at) VALUES (?, ?, 'active', 'member', COALESCE((SELECT created_at FROM sl_community_group_members WHERE group_id = ? AND user_id = ?), ?), ?)").bind(groupId, memberId, groupId, memberId, now, now),
      db.prepare("INSERT OR IGNORE INTO sl_conversation_members (conversation_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(group.conversation_id, memberId, now)
    ]);
  } else {
    await db.prepare("UPDATE sl_community_group_join_requests SET status = 'declined', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, requestRow.id).run();
  }
  await createNotification(db, {userId: memberId, actorId: viewer.id, type: approve ? "community_group_join_approved" : "community_group_join_declined", entityId: groupId, message: approve ? `Your request to join ${group.title} was approved.` : `Your request to join ${group.title} was declined.`, createdAt: now});
  return apiResponse({ok: true, message: approve ? "Member approved." : "Join request declined."});
}

async function groupRequestBody(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("multipart/form-data")) return readJson(request);
  const form = await request.formData();
  return {
    name: form.get("name") || form.get("title") || "",
    title: form.get("title") || form.get("name") || "",
    description: form.get("description") || "",
    participant_ids: form.get("participant_ids") || form.getAll("participant_ids"),
    admin_ids: form.get("admin_ids") || form.getAll("admin_ids")
  };
}

async function createInboxGroup(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before creating a group chat."}, 401);
  const body = await groupRequestBody(request);
  const participantIds = [...new Set(jsonArray(body.participant_ids).map(value => safeText(value, 100)).filter(value => value && value !== viewer.id))];
  if (participantIds.length < 2) return apiResponse({error: "Choose at least two other active members for the group."}, 400);
  const title = safeText(body.name || body.title, 120);
  const description = safeText(body.description, 600);
  if (!title) return apiResponse({error: "Give the group chat a name."}, 400);
  const adminIds = new Set(jsonArray(body.admin_ids).map(value => safeText(value, 100)));
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const members = [];
  for (const id of participantIds) {
    const member = await findUserById(db, id);
    if (member?.role === "member" && member.status === "active") members.push(member);
  }
  if (members.length < 2) return apiResponse({error: "Choose at least two other active members for the group."}, 400);
  const now = new Date().toISOString();
  const conversationId = newId("conv");
  const groupId = newId("group");
  const statements = [
    db.prepare("INSERT INTO sl_conversations (id, kind, title, created_by, metadata_json, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?, ?)").bind(conversationId, title, viewer.id, JSON.stringify({category: "Community", description}), now, now),
    db.prepare("INSERT INTO sl_conversation_members (conversation_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)").bind(conversationId, viewer.id, now),
    db.prepare("INSERT INTO sl_community_groups (id, conversation_id, title, description, category, icon, accent, requires_approval, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'Community', 'bx-group', 'blue', 0, ?, ?, ?)").bind(groupId, conversationId, title, description, viewer.id, now, now),
    db.prepare("INSERT INTO sl_community_group_members (group_id, user_id, status, role, created_at, updated_at) VALUES (?, ?, 'active', 'moderator', ?, ?)").bind(groupId, viewer.id, now, now)
  ];
  members.forEach(member => {
    const role = adminIds.has(member.id) ? "moderator" : "member";
    statements.push(db.prepare("INSERT INTO sl_conversation_members (conversation_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(conversationId, member.id, role, now));
    statements.push(db.prepare("INSERT INTO sl_community_group_members (group_id, user_id, status, role, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)").bind(groupId, member.id, role, now, now));
  });
  await db.batch(statements);
  const row = await db.prepare("SELECT * FROM sl_conversations WHERE id = ?").bind(conversationId).first();
  const memberRows = await db.prepare("SELECT * FROM sl_conversation_members WHERE conversation_id = ?").bind(conversationId).all();
  return apiResponse({ok: true, message: "Group created and invitations delivered.", conversation: await conversationSummary(db, row, viewer.id, memberRows.results || [])}, 201);
}

async function updateInboxGroup(request, env, conversationId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before editing a group chat."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const group = await db.prepare("SELECT * FROM sl_community_groups WHERE conversation_id = ? LIMIT 1").bind(conversationId).first();
  if (!group) return apiResponse({error: "That group chat is not available."}, 404);
  const moderator = await db.prepare("SELECT 1 FROM sl_community_group_members WHERE group_id = ? AND user_id = ? AND status = 'active' AND role IN ('moderator', 'admin') LIMIT 1").bind(group.id, viewer.id).first();
  if (!moderator) return apiResponse({error: "Only group moderators can edit this chat."}, 403);
  const body = await groupRequestBody(request);
  const title = safeText(body.name || body.title || group.title, 120);
  const description = safeText(body.description == null ? group.description : body.description, 600);
  if (!title) return apiResponse({error: "Give the group chat a name."}, 400);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE sl_community_groups SET title = ?, description = ?, updated_at = ? WHERE id = ?").bind(title, description, now, group.id),
    db.prepare("UPDATE sl_conversations SET title = ?, metadata_json = ?, updated_at = ? WHERE id = ?").bind(title, JSON.stringify({category: group.category, description}), now, conversationId)
  ]);
  const row = await db.prepare("SELECT * FROM sl_conversations WHERE id = ?").bind(conversationId).first();
  const memberRows = await db.prepare("SELECT * FROM sl_conversation_members WHERE conversation_id = ?").bind(conversationId).all();
  return apiResponse({ok: true, message: "Group updated for every member.", conversation: await conversationSummary(db, row, viewer.id, memberRows.results || [])});
}

async function leaveInboxGroup(request, env, conversationId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before leaving a group chat."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const group = await db.prepare("SELECT * FROM sl_community_groups WHERE conversation_id = ? LIMIT 1").bind(conversationId).first();
  if (!group) return apiResponse({error: "That group chat is not available."}, 404);
  if (group.created_by === viewer.id) return apiResponse({error: "The group creator cannot leave this chat."}, 400);
  await db.batch([
    db.prepare("DELETE FROM sl_community_group_members WHERE group_id = ? AND user_id = ?").bind(group.id, viewer.id),
    db.prepare("DELETE FROM sl_conversation_members WHERE conversation_id = ? AND user_id = ?").bind(conversationId, viewer.id)
  ]);
  return apiResponse({ok: true, message: "You left the group."});
}

function livestreamTags(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(source.map(item => safeText(item, 40).replace(/^#/, "")).filter(Boolean))].slice(0, 10);
}

function livestreamMilestone(elapsedSeconds) {
  const minutes = Math.floor(Number(elapsedSeconds || 0) / 60);
  if (minutes >= 180) return 6500;
  if (minutes >= 120) return 4000;
  if (minutes >= 60) return 2000;
  if (minutes >= 30) return 500;
  return 0;
}

async function livestreamAuthor(db, userId, viewerId) {
  const row = await findUserById(db, userId);
  if (!row) return null;
  const parts = rowParts(row);
  return commonPublicFields(row, parts.profile, parts.preferences, parts.safety, viewerId, "none", {followers_count: 0, following_count: 0});
}

async function livestreamView(db, row, viewerId, includeChat) {
  const host = await livestreamAuthor(db, row.host_id, viewerId);
  const membership = viewerId ? await db.prepare("SELECT * FROM sl_livestream_members WHERE stream_id = ? AND user_id = ? LIMIT 1").bind(row.id, viewerId).first() : null;
  const viewerCount = await db.prepare("SELECT COUNT(*) AS count FROM sl_livestream_members WHERE stream_id = ? AND left_at IS NULL").bind(row.id).first();
  const startedAt = row.started_at ? new Date(row.started_at).getTime() : 0;
  const endedAt = row.ended_at ? new Date(row.ended_at).getTime() : (row.status === "live" ? Date.now() : startedAt);
  const elapsedSeconds = startedAt ? Math.max(0, Math.floor((endedAt - startedAt) / 1000)) : 0;
  const result = {
    id: row.id,
    title: row.title,
    description: row.description || "",
    category: row.category || "Community",
    tags: livestreamTags(jsonArray(row.tags_json)),
    status: row.status,
    scheduled_at: row.scheduled_at || null,
    started_at: row.started_at || null,
    ended_at: row.ended_at || null,
    duration_minutes: Number(row.duration_minutes || 120),
    elapsed_seconds: elapsedSeconds,
    viewer_count: Number(viewerCount?.count || 0),
    credits_donated: Number(row.credits_donated || 0),
    reward_credits_awarded: Number(row.reward_credits_awarded || 0),
    host,
    joined: Boolean(membership && membership.left_at == null),
    is_host: Boolean(viewerId && viewerId === row.host_id),
    can_manage: Boolean(viewerId && viewerId === row.host_id)
  };
  if (includeChat) {
    const chatResult = await db.prepare("SELECT c.*, u.username, u.profile_json, u.preferences_json, u.safety_json FROM sl_livestream_chat c INNER JOIN sl_users u ON u.id = c.user_id WHERE c.stream_id = ? ORDER BY c.created_at ASC LIMIT 200").bind(row.id).all();
    result.chat = [];
    for (const item of chatResult.results || []) {
      result.chat.push({id: item.id, body: item.body, donation_credits: Number(item.donation_credits || 0), created_at: item.created_at, author: commonPublicFields({id: item.user_id, username: item.username, status: "active", verified: 0, role: "member"}, parseJson(item.profile_json, normalizeProfile({})), normalizePreferences(parseJson(item.preferences_json, {})), normalizeSafety(parseJson(item.safety_json, {})), viewerId, "none", {followers_count: 0, following_count: 0})});
    }
  }
  return result;
}

async function livestreams(request, env) {
  let viewer = null;
  try { viewer = await sessionUser(request, env); } catch (_error) { viewer = null; }
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const url = new URL(request.url);
  const query = safeText(url.searchParams.get("q"), 120).toLowerCase();
  const status = safeText(url.searchParams.get("status"), 20);
  const category = safeText(url.searchParams.get("category"), 60).toLowerCase();
  const result = await db.prepare("SELECT * FROM sl_livestreams ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'ended' THEN 2 ELSE 3 END, COALESCE(scheduled_at, created_at) ASC, created_at DESC LIMIT 200").all();
  const allRows = result.results || [];
  const streams = [];
  const categories = new Set();
  for (const row of allRows) {
    if (row.category) categories.add(row.category);
    const haystack = `${row.title} ${row.description} ${row.category} ${livestreamTags(jsonArray(row.tags_json)).join(" ")}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    if (status && status !== "all" && row.status !== status) continue;
    if (category && String(row.category || "").toLowerCase() !== category) continue;
    streams.push(await livestreamView(db, row, viewer?.id, false));
  }
  const liveRows = allRows.filter(row => row.status === "live");
  const viewerStats = await db.prepare("SELECT COUNT(*) AS count FROM sl_livestream_members m INNER JOIN sl_livestreams s ON s.id = m.stream_id WHERE s.status = 'live' AND m.left_at IS NULL").first();
  const donatedStats = await db.prepare("SELECT COALESCE(SUM(credits_donated), 0) AS total FROM sl_livestreams").first();
  let myLivestreams = [];
  if (viewer) {
    const mine = await db.prepare("SELECT * FROM sl_livestreams WHERE host_id = ? ORDER BY created_at DESC LIMIT 50").bind(viewer.id).all();
    for (const row of mine.results || []) myLivestreams.push(await livestreamView(db, row, viewer.id, false));
  }
  return apiResponse({ok: true, livestreams: streams, categories: [...categories].sort(), my_livestreams: myLivestreams, stats: {live: liveRows.length, viewers: Number(viewerStats?.count || 0), credits_donated: Number(donatedStats?.total || 0)}, updated_at: new Date().toISOString()});
}

async function createLivestream(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before scheduling a livestream."}, 401);
  if (viewer.status !== "active") return apiResponse({error: "This account cannot schedule a livestream right now."}, 403);
  const body = await readJson(request);
  const title = safeText(body.title, 140);
  const description = safeText(body.description, 2400);
  const category = safeText(body.category, 60) || "Community";
  const duration = Math.max(15, Math.min(240, Math.floor(Number(body.duration_minutes) || 120)));
  const scheduledDate = body.scheduled_at ? new Date(String(body.scheduled_at)) : null;
  const scheduledAt = scheduledDate && !Number.isNaN(scheduledDate.getTime()) ? scheduledDate.toISOString() : null;
  if (!title || !description) return apiResponse({error: "Add a clear broadcast title and description."}, 400);
  if (body.scheduled_at && !scheduledAt) return apiResponse({error: "Choose a valid broadcast start time."}, 400);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const now = new Date().toISOString();
  const id = newId("stream");
  await db.prepare("INSERT INTO sl_livestreams (id, host_id, title, description, category, tags_json, scheduled_at, status, duration_minutes, credits_donated, reward_credits_awarded, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, 0, 0, ?, ?)").bind(id, viewer.id, title, description, category, JSON.stringify(livestreamTags(body.tags)), scheduledAt, duration, now, now).run();
  const row = await db.prepare("SELECT * FROM sl_livestreams WHERE id = ?").bind(id).first();
  return apiResponse({ok: true, message: "Broadcast created. Start it from your broadcast list when ready.", livestream: await livestreamView(db, row, viewer.id, true)}, 201);
}

async function livestreamDetail(request, env, streamId) {
  let viewer = null;
  try { viewer = await sessionUser(request, env); } catch (_error) { viewer = null; }
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await db.prepare("SELECT * FROM sl_livestreams WHERE id = ? LIMIT 1").bind(streamId).first();
  if (!row) return apiResponse({error: "That livestream is no longer available."}, 404);
  return apiResponse({ok: true, livestream: await livestreamView(db, row, viewer?.id, true)});
}

async function startLivestream(request, env, streamId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to start your broadcast."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await db.prepare("SELECT * FROM sl_livestreams WHERE id = ? LIMIT 1").bind(streamId).first();
  if (!row) return apiResponse({error: "That livestream is no longer available."}, 404);
  if (row.host_id !== viewer.id) return apiResponse({error: "Only the host can start this broadcast."}, 403);
  if (row.status !== "scheduled") return apiResponse({error: "Only a scheduled broadcast can be started."}, 400);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE sl_livestreams SET status = 'live', started_at = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'").bind(now, now, streamId),
    db.prepare("INSERT OR REPLACE INTO sl_livestream_members (stream_id, user_id, role, joined_at, last_seen_at, left_at) VALUES (?, ?, 'host', COALESCE((SELECT joined_at FROM sl_livestream_members WHERE stream_id = ? AND user_id = ?), ?), ?, NULL)").bind(streamId, viewer.id, streamId, viewer.id, now, now)
  ]);
  const updated = await db.prepare("SELECT * FROM sl_livestreams WHERE id = ?").bind(streamId).first();
  return apiResponse({ok: true, message: "Your broadcast is live.", livestream: await livestreamView(db, updated, viewer.id, true)});
}

async function endLivestream(request, env, streamId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to end your broadcast."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await db.prepare("SELECT * FROM sl_livestreams WHERE id = ? LIMIT 1").bind(streamId).first();
  if (!row) return apiResponse({error: "That livestream is no longer available."}, 404);
  if (row.host_id !== viewer.id) return apiResponse({error: "Only the host can end this broadcast."}, 403);
  if (row.status !== "live") return apiResponse({error: "That broadcast is not live."}, 400);
  const now = new Date().toISOString();
  const elapsedSeconds = row.started_at ? Math.max(0, Math.floor((Date.now() - new Date(row.started_at).getTime()) / 1000)) : 0;
  const milestone = livestreamMilestone(elapsedSeconds);
  const additional = Math.max(0, milestone - Number(row.reward_credits_awarded || 0));
  await db.batch([
    db.prepare("UPDATE sl_livestreams SET status = 'ended', ended_at = ?, reward_credits_awarded = ?, updated_at = ? WHERE id = ? AND status = 'live'").bind(now, milestone, now, streamId),
    db.prepare("UPDATE sl_users SET time_credits = time_credits + ?, updated_at = ? WHERE id = ?").bind(additional, now, viewer.id),
    auditInsert(db, {actorId: viewer.id, targetId: viewer.id, action: "livestream_ended", details: `Ended a broadcast and added ${additional} milestone credits.`, createdAt: now})
  ]);
  const updated = await db.prepare("SELECT * FROM sl_livestreams WHERE id = ?").bind(streamId).first();
  return apiResponse({ok: true, message: additional ? `Broadcast ended. ${additional.toLocaleString()} milestone credits were added.` : "Broadcast ended.", livestream: await livestreamView(db, updated, viewer.id, true)});
}

async function updateLivestream(request, env, streamId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to manage this broadcast."}, 401);
  const body = await readJson(request);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await db.prepare("SELECT * FROM sl_livestreams WHERE id = ? LIMIT 1").bind(streamId).first();
  if (!row) return apiResponse({error: "That livestream is no longer available."}, 404);
  if (row.host_id !== viewer.id && viewer.role !== "admin") return apiResponse({error: "Only the host can update this broadcast."}, 403);
  if (body.status !== "cancelled" || !["scheduled"].includes(row.status)) return apiResponse({error: "Only scheduled broadcasts can be cancelled."}, 400);
  const now = new Date().toISOString();
  await db.prepare("UPDATE sl_livestreams SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'scheduled'").bind(now, streamId).run();
  return apiResponse({ok: true, message: "Broadcast cancelled."});
}

async function joinLivestream(request, env, streamId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to join a livestream."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await db.prepare("SELECT * FROM sl_livestreams WHERE id = ? LIMIT 1").bind(streamId).first();
  if (!row) return apiResponse({error: "That livestream is no longer available."}, 404);
  if (row.status !== "live") return apiResponse({error: "This room is not live right now."}, 400);
  const now = new Date().toISOString();
  await db.prepare("INSERT OR REPLACE INTO sl_livestream_members (stream_id, user_id, role, joined_at, last_seen_at, left_at) VALUES (?, ?, 'viewer', COALESCE((SELECT joined_at FROM sl_livestream_members WHERE stream_id = ? AND user_id = ?), ?), ?, NULL)").bind(streamId, viewer.id, streamId, viewer.id, now, now).run();
  return apiResponse({ok: true, livestream: await livestreamView(db, row, viewer.id, true)});
}

async function leaveLivestream(request, env, streamId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to leave a livestream."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  await db.prepare("UPDATE sl_livestream_members SET left_at = ?, last_seen_at = ? WHERE stream_id = ? AND user_id = ? AND role = 'viewer'").bind(new Date().toISOString(), new Date().toISOString(), streamId, viewer.id).run();
  const row = await db.prepare("SELECT * FROM sl_livestreams WHERE id = ? LIMIT 1").bind(streamId).first();
  if (!row) return apiResponse({error: "That livestream is no longer available."}, 404);
  return apiResponse({ok: true, livestream: await livestreamView(db, row, viewer.id, true)});
}

async function heartbeatLivestream(request, env, streamId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to stay connected to this livestream."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE sl_livestream_members SET last_seen_at = ? WHERE stream_id = ? AND user_id = ? AND left_at IS NULL").bind(now, streamId, viewer.id).run();
  if (!Number(result?.meta?.changes || 0)) return apiResponse({error: "Join the livestream before sending a heartbeat."}, 400);
  return apiResponse({ok: true, server_time: now});
}

async function livestreamChat(request, env, streamId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to chat in a livestream."}, 401);
  const body = await readJson(request);
  const text = safeText(body.body, 1200);
  const donation = Math.max(0, Math.min(10000, Math.floor(Number(body.donation_credits) || 0)));
  if (!text) return apiResponse({error: "Write a message before sending."}, 400);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await db.prepare("SELECT * FROM sl_livestreams WHERE id = ? LIMIT 1").bind(streamId).first();
  if (!row || row.status !== "live") return apiResponse({error: "Chat is available while the broadcast is live."}, 400);
  const member = await db.prepare("SELECT * FROM sl_livestream_members WHERE stream_id = ? AND user_id = ? AND left_at IS NULL LIMIT 1").bind(streamId, viewer.id).first();
  if (!member) return apiResponse({error: "Join the livestream before chatting."}, 403);
  if (donation > 0 && viewer.id === row.host_id) return apiResponse({error: "Hosts cannot donate credits to their own broadcast."}, 400);
  const now = new Date().toISOString();
  if (donation > 0) {
    const debit = await db.prepare("UPDATE sl_users SET time_credits = time_credits - ?, updated_at = ? WHERE id = ? AND status = 'active' AND time_credits >= ?").bind(donation, now, viewer.id, donation).run();
    if (Number(debit?.meta?.changes || 0) !== 1) return apiResponse({error: "You do not have enough credits for that donation."}, 400);
    await db.batch([
      db.prepare("UPDATE sl_users SET time_credits = time_credits + ?, updated_at = ? WHERE id = ?").bind(donation, now, row.host_id),
      db.prepare("UPDATE sl_livestreams SET credits_donated = credits_donated + ?, updated_at = ? WHERE id = ?").bind(donation, now, streamId),
      db.prepare("INSERT INTO sl_audit_log (id, actor_id, target_id, action, details, created_at) VALUES (?, ?, ?, 'livestream_donation', ?, ?)").bind(newId("audit"), viewer.id, row.host_id, `Donated ${donation} credits in a livestream.`, now)
    ]);
  }
  await db.prepare("INSERT INTO sl_livestream_chat (id, stream_id, user_id, body, donation_credits, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(newId("live-chat"), streamId, viewer.id, text, donation, now).run();
  const updated = await findUserById(db, viewer.id);
  const latest = await db.prepare("SELECT * FROM sl_livestreams WHERE id = ?").bind(streamId).first();
  return apiResponse({ok: true, message: "Message sent.", balance: Number(updated?.time_credits || 0), livestream: await livestreamView(db, latest, viewer.id, true)});
}

async function livestreamSignals(request, env, streamId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to connect to this livestream."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const membership = await db.prepare("SELECT * FROM sl_livestream_members WHERE stream_id = ? AND user_id = ? AND left_at IS NULL LIMIT 1").bind(streamId, viewer.id).first();
  const stream = await db.prepare("SELECT * FROM sl_livestreams WHERE id = ? LIMIT 1").bind(streamId).first();
  if (!stream) return apiResponse({error: "That livestream is no longer available."}, 404);
  if (!membership && stream.host_id !== viewer.id) return apiResponse({error: "Join the livestream before connecting media."}, 403);
  if (request.method === "GET") {
    const url = new URL(request.url);
    const after = safeText(url.searchParams.get("after"), 40);
    const result = await db.prepare("SELECT * FROM sl_livestream_signals WHERE stream_id = ? AND (to_id IS NULL OR to_id = ?) AND created_at > ? ORDER BY created_at ASC LIMIT 200").bind(streamId, viewer.id, after || "").all();
    return apiResponse({ok: true, signals: (result.results || []).map(row => ({id: row.id, from_id: row.from_id, type: row.type, payload: parseJson(row.payload_json, {}), created_at: row.created_at})), server_time: new Date().toISOString()});
  }
  const body = await readJson(request);
  const type = safeText(body.type, 20);
  if (!["offer", "answer", "ice"].includes(type)) return apiResponse({error: "That media signal is not supported."}, 400);
  const targetId = safeText(body.target_id, 100) || null;
  const payload = isObject(body.payload) ? body.payload : {};
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO sl_livestream_signals (id, stream_id, from_id, to_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(newId("signal"), streamId, viewer.id, targetId, type, JSON.stringify(payload).slice(0, 12000), now).run();
  return apiResponse({ok: true, server_time: now});
}

async function communityPostInteractionAccess(request, env, postId) {
  let viewer = null;
  try { viewer = await sessionUser(request, env); } catch (_error) { viewer = null; }
  const db = dbFor(env);
  const row = await communityPostRow(db, postId);
  if (!row || row.status !== "published") return {response: apiResponse({error: "That post is no longer available."}, 404)};
  const followingSet = await communityFollowingSet(db, viewer?.id);
  if (!communityVisibilityAllowed(row.author_id, row.visibility, viewer?.id, followingSet)) return {response: apiResponse({error: "That post is only available to the author’s followers."}, 403)};
  return {viewer, db, row, followingSet};
}

async function communityPostLike(request, env, postId) {
  const access = await communityPostInteractionAccess(request, env, postId);
  if (access.response) return access.response;
  if (!access.viewer) return apiResponse({error: "Please log in to like posts."}, 401);
  await ensureFeatureSchema(access.db);
  const now = new Date().toISOString();
  if (request.method === "DELETE") {
    await access.db.prepare("DELETE FROM sl_community_post_likes WHERE post_id = ? AND user_id = ?").bind(postId, access.viewer.id).run();
  } else {
    await access.db.prepare("INSERT OR IGNORE INTO sl_community_post_likes (id, post_id, user_id, created_at) VALUES (?, ?, ?, ?)").bind(newId("like"), postId, access.viewer.id, now).run();
    if (access.row.author_id !== access.viewer.id) await createNotification(access.db, {userId: access.row.author_id, actorId: access.viewer.id, type: "community_post_liked", entityId: postId, message: `${rowParts(access.viewer).profile.display_name || access.viewer.username} liked your community post.`, createdAt: now});
  }
  const result = await access.db.prepare("SELECT COUNT(*) AS count FROM sl_community_post_likes WHERE post_id = ?").bind(postId).first();
  return apiResponse({ok: true, liked: request.method !== "DELETE", likes: Number(result?.count || 0)});
}

async function communityPostShare(request, env, postId) {
  const access = await communityPostInteractionAccess(request, env, postId);
  if (access.response) return access.response;
  if (!access.viewer) return apiResponse({error: "Please log in to share posts."}, 401);
  await ensureFeatureSchema(access.db);
  const now = new Date().toISOString();
  await access.db.prepare("INSERT OR IGNORE INTO sl_community_post_shares (id, post_id, user_id, created_at) VALUES (?, ?, ?, ?)").bind(newId("share"), postId, access.viewer.id, now).run();
  const result = await access.db.prepare("SELECT COUNT(*) AS count FROM sl_community_post_shares WHERE post_id = ?").bind(postId).first();
  return apiResponse({ok: true, shared: true, shares: Number(result?.count || 0), message: "Post link ready to share."});
}

async function communityPostComments(request, env, postId) {
  const access = await communityPostInteractionAccess(request, env, postId);
  if (access.response) return access.response;
  if (request.method === "GET") {
    const result = await access.db.prepare("SELECT c.*, u.id AS author_id, u.username, u.profile_json, u.preferences_json, u.safety_json FROM sl_community_post_comments c INNER JOIN sl_users u ON u.id = c.author_id WHERE c.post_id = ? AND c.status = 'visible' AND u.status = 'active' ORDER BY c.created_at ASC LIMIT 100").bind(postId).all();
    return apiResponse({ok: true, comments: (result.results || []).map(row => ({id: row.id, body: row.body, created_at: row.created_at, author: communityAuthorView({id: row.author_id, username: row.username, profile_json: row.profile_json, preferences_json: row.preferences_json, safety_json: row.safety_json}, access.viewer?.id, true)}))});
  }
  if (!access.viewer) return apiResponse({error: "Please log in to comment on posts."}, 401);
  const body = await readJson(request);
  const text = safeText(body.body, 800);
  if (String(body.body || "").length > 800 || !text) return apiResponse({error: "Write a comment of up to 800 characters."}, 400);
  const now = new Date().toISOString();
  const commentId = newId("comment");
  await ensureFeatureSchema(access.db);
  await access.db.batch([
    access.db.prepare("INSERT INTO sl_community_post_comments (id, post_id, author_id, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'visible', ?, ?)").bind(commentId, postId, access.viewer.id, text, now, now),
    auditInsert(access.db, {actorId: access.viewer.id, targetId: access.row.author_id, action: "community_post_commented", details: "Commented on a community post.", createdAt: now})
  ]);
  if (access.row.author_id !== access.viewer.id) await createNotification(access.db, {userId: access.row.author_id, actorId: access.viewer.id, type: "community_post_commented", entityId: postId, message: `${rowParts(access.viewer).profile.display_name || access.viewer.username} commented on your community post.`, createdAt: now});
  return apiResponse({ok: true, message: "Comment posted.", comment_id: commentId}, 201);
}

async function deleteCommunityPost(request, env, postId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to manage your post."}, 401);
  const db = dbFor(env);
  const row = await communityPostRow(db, postId);
  if (!row) return apiResponse({error: "That post is no longer available."}, 404);
  if (row.author_id !== viewer.id && viewer.role !== "admin") return apiResponse({error: "You can only remove your own posts."}, 403);
  if (row.media_key && env.BUCKET) await env.BUCKET.delete(row.media_key);
  await db.batch([
    db.prepare("DELETE FROM sl_community_post_likes WHERE post_id = ?").bind(postId),
    db.prepare("DELETE FROM sl_community_post_comments WHERE post_id = ?").bind(postId),
    db.prepare("DELETE FROM sl_community_post_shares WHERE post_id = ?").bind(postId),
    db.prepare("DELETE FROM sl_community_posts WHERE id = ?").bind(postId),
    auditInsert(db, {actorId: viewer.id, targetId: row.author_id, action: "community_post_deleted", details: "Removed a community post.", createdAt: new Date().toISOString()})
  ]);
  return apiResponse({ok: true, message: "Post removed."});
}

async function deleteCommunityStory(request, env, storyId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to manage your story."}, 401);
  const db = dbFor(env);
  const row = await communityStoryRow(db, storyId);
  if (!row) return apiResponse({error: "That story is no longer available."}, 404);
  if (row.author_id !== viewer.id && viewer.role !== "admin") return apiResponse({error: "You can only remove your own stories."}, 403);
  if (row.media_key && env.BUCKET) await env.BUCKET.delete(row.media_key);
  await db.batch([
    db.prepare("DELETE FROM sl_community_stories WHERE id = ?").bind(storyId),
    auditInsert(db, {actorId: viewer.id, targetId: row.author_id, action: "community_story_deleted", details: "Removed a community story.", createdAt: new Date().toISOString()})
  ]);
  return apiResponse({ok: true, message: "Story removed."});
}

async function serveCommunityMedia(request, env, path) {
  if (!env || !env.BUCKET || !COMMUNITY_MEDIA_PATH.test(path)) return null;
  const key = path.slice(1);
  const db = dbFor(env);
  const isStory = key.startsWith("community-media/story_");
  const isBlog = key.startsWith("community-media/blog_");
  let record;
  if (isBlog) {
    const blog = (await appRecords(db, "blogs", null)).find(item => {
      const media = Array.isArray(item?.media) ? item.media : item?.media ? [item.media] : [];
      return media.some(entry => String(isObject(entry) ? entry.url : entry || "") === "/" + key);
    });
    const media = Array.isArray(blog?.media) ? blog.media : blog?.media ? [blog.media] : [];
    const entry = media.find(item => String(isObject(item) ? item.url : item || "") === "/" + key);
    record = blog ? {
      author_id: blog.owner_id || blog.author_id || "",
      visibility: blog.visibility || "public",
      status: blog.status || "published",
      media_content_type: isObject(entry) ? entry.content_type || entry.type || "" : ""
    } : null;
  } else {
    record = isStory
      ? await db.prepare("SELECT author_id, visibility, status, expires_at, media_content_type FROM sl_community_stories WHERE media_key = ? LIMIT 1").bind(key).first()
      : await db.prepare("SELECT author_id, visibility, status, media_content_type FROM sl_community_posts WHERE media_key = ? LIMIT 1").bind(key).first();
  }
  if (!record || record.status !== "published" || (isStory && record.expires_at <= new Date().toISOString())) return new Response("Not Found", {status: 404, headers: {"cache-control": "no-store"}});
  if (record.visibility === "followers") {
    const viewer = await sessionUser(request, env);
    const followingSet = await communityFollowingSet(db, viewer?.id);
    if (!communityVisibilityAllowed(record.author_id, record.visibility, viewer?.id, followingSet)) return new Response("Not Found", {status: 404, headers: {"cache-control": "no-store"}});
  }
  const object = await env.BUCKET.get(key);
  if (!object) return new Response("Not Found", {status: 404, headers: {"cache-control": "public, max-age=60"}});
  const headers = new Headers({"cache-control": record.visibility === "public" ? "public, max-age=86400, stale-while-revalidate=604800" : "private, no-store", "content-type": record.media_content_type || object.httpMetadata?.contentType || "application/octet-stream"});
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(request.method === "HEAD" ? null : object.body, {status: 200, headers});
}

async function deleteAccount(request, env) {
  const row = await sessionUser(request, env);
  if (!row) return apiResponse({error: "Please log in to delete your account."}, 401);
  if (row.role === "admin") return apiResponse({error: "The primary administrator account cannot be deleted from this page."}, 403);
  const body = await readJson(request);
  if (!(await verifyPassword(String(body.password || ""), row.password_hash))) return apiResponse({error: "Your password is incorrect."}, 400);
  if (String(body.confirmation || "") !== "DELETE " + row.username) return apiResponse({error: "Type DELETE " + row.username + " to confirm account deletion."}, 400);
  const db = dbFor(env);
  await ensureGoogleAuthSchema(db);
  await ensureFeatureSchema(db);
  const photoKey = photoKeyFromUrl(rowParts(row).profile.avatar_url);
  if (photoKey && env.BUCKET) await env.BUCKET.delete(photoKey);
  await db.batch([
    db.prepare("DELETE FROM sl_sessions WHERE user_id = ?").bind(row.id),
    db.prepare("DELETE FROM sl_auth_identities WHERE user_id = ?").bind(row.id),
    db.prepare("DELETE FROM sl_oauth_states WHERE user_id = ?").bind(row.id),
    db.prepare("DELETE FROM sl_app_records WHERE owner_id = ?").bind(row.id),
    db.prepare("DELETE FROM sl_learning_streak_days WHERE user_id = ?").bind(row.id),
    db.prepare("DELETE FROM sl_learning_streaks WHERE user_id = ?").bind(row.id),
    db.prepare("DELETE FROM sl_users WHERE id = ?").bind(row.id),
    auditInsert(db, {actorId: row.id, targetId: row.id, action: "account_deleted", details: "Member account permanently deleted by the account owner."})
  ]);
  return apiResponse({ok: true, message: "Your SwapLabs account has been deleted."}, 200, expiredAuthCookieHeaders(request, "sl_session"));
}

const PROFILE_COMPLETION_FIELDS = [
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["date_of_birth", "Date of birth"],
  ["country", "Country"],
  ["primary_language", "Primary language"],
  ["skills_to_teach", "A skill you can teach"],
  ["skills_to_learn", "A skill you want to learn"],
  ["learning_goal", "Main learning goal"]
];

function profileCompletionFieldFilled(value) {
  if (Array.isArray(value)) return value.some(profileCompletionFieldFilled);
  const normalized = String(value ?? "").trim().toLowerCase();
  return Boolean(normalized) && normalized !== "nothing for now";
}

function profileCompleteness(profile) {
  const source = profile || {};
  return Math.round(PROFILE_COMPLETION_FIELDS.filter(([field]) => profileCompletionFieldFilled(source[field])).length /
    PROFILE_COMPLETION_FIELDS.length * 100);
}

function profileCompletionMissing(profile) {
  const source = profile || {};
  return PROFILE_COMPLETION_FIELDS.filter(([field]) => !profileCompletionFieldFilled(source[field])).map(([, label]) => label);
}

function profileCompletionGate(row, returnTo = "skill-matching.html") {
  if (!row || row.role === "admin") return null;
  const parts = rowParts(row);
  const completeness = profileCompleteness(parts.profile);
  if (completeness >= 100) return null;
  const requestedReturn = safeText(returnTo, 300);
  const safeReturn = requestedReturn && !requestedReturn.startsWith("//") && !requestedReturn.includes("://") ? requestedReturn : "skill-matching.html";
  const missing = profileCompletionMissing(parts.profile);
  return apiResponse({
    error: `Finish your profile to unlock this action${missing.length ? `: add ${missing.slice(0, 3).join(", ").toLowerCase()}${missing.length > 3 ? ", and the remaining essentials" : ""}` : ""}.`,
    code: "profile_incomplete",
    profile_completeness: completeness,
    required_profile_fields: missing,
    profile_url: `profile.html?complete=1&return_to=${encodeURIComponent(safeReturn)}`,
    return_to: safeReturn
  }, 403);
}

async function dashboard(request, env) {
  const row = await sessionUser(request, env);
  if (!row) return apiResponse({error: "Please log in to open your dashboard."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const user = selfUser(row);
  const completeness = profileCompleteness(user.profile);
  const streak = await streakSummaryFor(db, row);
  return apiResponse({
    user,
    streak,
    summary: {credit_balance: user.time_credits, pending_requests: 0, unread_messages: 0, completed_sessions: 0},
    analytics: {
      completed_session_hours: 0, credits_earned: user.time_credits, credits_spent: 0, conversations: 0,
      messages_sent: 0, profile_completeness: completeness, sessions: {completed: 0, scheduled: 0, cancelled: 0},
      workshops_hosted: 0, ideas_published: 0
    },
    metrics: {active_members: 0, skills: 0},
    suggested_action: {
      icon: completeness >= 100 ? "bx-group" : "bx-user-check",
      title: completeness >= 100 ? "Explore your member community" : "Finish your profile",
      description: completeness >= 100 ? "Meet members whose skills and goals complement yours." : "Complete every essential profile field before you start matching or making member connections.",
      href: completeness >= 100 ? "community.html" : "profile.html"
    },
    learning_goal: {title: user.profile.learning_goal || "Add your first learning goal", completed_sessions: 0, profile_completeness: completeness},
    recommended_matches: [], upcoming_sessions: [], recent_messages: [], onboarding_complete: completeness >= 100
  });
}

async function members(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to view registered members."}, 401);
  const db = dbFor(env);
  const snapshot = await followSnapshot(db, viewer.id);
  const rows = await allUserRows(db);
  const users = rows.filter(row => row.role === "member" && row.status === "active").map(row => {
    const parts = rowParts(row);
    const relationship = row.id === viewer.id ? "self" : snapshot.relationship.get(row.id) || "none";
    return commonPublicFields(row, parts.profile, parts.preferences, parts.safety, viewer.id, relationship, publicUserCounts(snapshot, row.id));
  });
  return apiResponse({members: users});
}

async function community(request, env) {
  let viewer = null;
  try { viewer = await sessionUser(request, env); } catch (_error) { viewer = null; }
  const db = dbFor(env);
  const snapshot = await followSnapshot(db, viewer?.id);
  const rows = await allUserRows(db);
  const active = rows.filter(row => row.role === "member" && row.status === "active");
  const users = active.map(row => {
    const parts = rowParts(row);
    const relationship = viewer && row.id === viewer.id ? "self" : snapshot.relationship.get(row.id) || "none";
    return commonPublicFields(row, parts.profile, parts.preferences, parts.safety, viewer && viewer.id, relationship, publicUserCounts(snapshot, row.id));
  });
  // Private members are discoverable by identity, but commonPublicFields has
  // already redacted their protected profile fields. The client can therefore
  // render a locked card and use the follow-request flow to ask for access.
  const discoverableUsers = users;
  const publicUsers = discoverableUsers.filter(user => user.visibility === "public");
  const countries = new Set(publicUsers.map(user => user.profile.country).filter(Boolean));
  return apiResponse({
    users: discoverableUsers,
    stats: {total: discoverableUsers.length, public: publicUsers.length, private: discoverableUsers.length - publicUsers.length, countries: countries.size, published_ideas: 0}
  });
}

async function portfolio(request, env, userId) {
  let viewer = null;
  try { viewer = await sessionUser(request, env); } catch (_error) { viewer = null; }
  const db = dbFor(env);
  const row = await findUserById(db, userId);
  // Administrator accounts can have a public-facing profile too. They must
  // still be active, and commonPublicFields continues to redact protected
  // fields according to the profile visibility rules below.
  if (!row || !["member", "admin"].includes(row.role) || row.status !== "active") return apiResponse({error: "That member profile is not available."}, 404);
  const parts = rowParts(row);
  const snapshot = await followSnapshot(db, viewer?.id);
  const relationship = viewer && row.id === viewer.id ? "self" : snapshot.relationship.get(row.id) || "none";
  const publicUser = commonPublicFields(row, parts.profile, parts.preferences, parts.safety, viewer && viewer.id, relationship, publicUserCounts(snapshot, row.id));
  // Keep the legacy public `role` value compatible with member cards while
  // giving the full portfolio page enough context to avoid member actions on
  // the protected administrator account.
  publicUser.account_type = row.role === "admin" ? "administrator" : "member";
  const ideas = (await appRecords(db, "ideas", null)).filter(item => item.owner_id === row.id && ["published", "public", "approved", ""].includes(String(item.status || "published"))).map(item => featureIdeaView(item, viewer?.id));
  const events = (await appRecords(db, "events", null)).filter(item => item.host_id === row.id || jsonArray(item.participant_ids, []).includes(row.id));
  const blogs = (await appRecords(db, "blogs", null)).filter(item => item.owner_id === row.id && item.status !== "draft");
  const posts = (await db.prepare("SELECT id, body, created_at FROM sl_community_posts WHERE author_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 12").bind(row.id).all()).results || [];
  const hostedWorkshops = (await db.prepare("SELECT id, title, description, starts_at, status, category FROM sl_workshops WHERE host_id = ? ORDER BY starts_at DESC LIMIT 12").bind(row.id).all()).results || [];
  const savedPortfolio = await appRecord(db, "portfolios", row.id);
  const activity = [
    ...events.map(item => ({type: "session", title: item.title || "SwapLabs session", status: item.status || "scheduled", created_at: item.created_at || item.starts_at})),
    ...blogs.map(item => ({type: "blog", title: item.title || "Published story", status: "published", created_at: item.created_at})),
    ...posts.map(item => ({type: "community", title: item.body || "Community post", status: "published", created_at: item.created_at}))
  ].filter(item => item.created_at).sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))).slice(0, 20);
  return apiResponse({
    portfolio: {
      user: publicUser, locked: !publicUser.can_view_full,
      portfolio: {accent: savedPortfolio?.accent || parts.profile.profile_color || "indigo", title: savedPortfolio?.title || `${publicUser.profile.display_name || row.username}'s portfolio`, headline: savedPortfolio?.headline || "", intro: savedPortfolio?.intro || ""},
      stats: {completed_sessions: events.filter(item => item.status === "completed").length, published_ideas: ideas.length, followers: publicUser.followers_count, following: publicUser.following_count},
      ideas, achievements: [], workshops: hostedWorkshops, activity, projects: jsonArray(savedPortfolio?.projects, [])
    }
  });
}

async function requireAdmin(request, env) {
  const row = await sessionUser(request, env);
  if (!row) return {response: apiResponse({error: "Administrator sign-in is required."}, 401)};
  if (row.role !== "admin") return {response: apiResponse({error: "Administrator access only."}, 403)};
  return {row};
}

function adminPresenceUserView(row, isOnline = true, pagePath = row.page_path) {
  const parts = rowParts(row);
  const displayName = parts.profile.display_name || completeName(parts.profile, row.username);
  const lastSeenMs = Date.parse(row.last_seen_at);
  return {
    id: row.id,
    username: row.username,
    display_name: displayName,
    role: row.role === "admin" ? "admin" : "member",
    status: row.status,
    profile: {
      display_name: displayName,
      profile_color: parts.profile.profile_color || "indigo",
      avatar_url: publicAvatarUrl(parts.profile.avatar_url)
    },
    page_path: safePresencePage(pagePath),
    last_seen_at: row.last_seen_at,
    seconds_since_seen: Number.isFinite(lastSeenMs) ? Math.max(0, Math.floor((Date.now() - lastSeenMs) / 1000)) : null,
    is_online: Boolean(isOnline)
  };
}

function adminPresenceDayStart(request) {
  const candidate = Date.parse(new URL(request.url).searchParams.get("since") || "");
  const now = Date.now();
  if (Number.isFinite(candidate) && candidate <= now + 24 * 60 * 60 * 1000 && candidate >= now - 48 * 60 * 60 * 1000) {
    return new Date(candidate).toISOString();
  }
  const fallback = new Date(now);
  fallback.setUTCHours(0, 0, 0, 0);
  return fallback.toISOString();
}

async function adminPresence(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const cutoff = new Date(Date.now() - ONLINE_PRESENCE_WINDOW_SECONDS * 1000).toISOString();
  const result = await db.prepare(`
    SELECT p.user_id, p.last_seen_at, p.page_path, u.*
    FROM sl_user_presence p
    INNER JOIN sl_users u ON u.id = p.user_id
    WHERE u.status = 'active' AND p.last_seen_at >= ?
    ORDER BY p.last_seen_at DESC
  `).bind(cutoff).all();
  const checkedAt = new Date().toISOString();
  const users = (result.results || []).map(row => adminPresenceUserView(row));
  return apiResponse({ok: true, checked_at: checkedAt, active_window_seconds: ONLINE_PRESENCE_WINDOW_SECONDS, users});
}

async function adminPresenceToday(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const dayStart = adminPresenceDayStart(request);
  const onlineCutoff = new Date(Date.now() - ONLINE_PRESENCE_WINDOW_SECONDS * 1000).toISOString();
  const result = await db.prepare(`
    SELECT d.user_id, d.last_seen_at, d.page_path, u.*, p.user_id AS current_presence_user_id,
      p.last_seen_at AS current_last_seen_at, p.page_path AS current_page_path
    FROM sl_user_presence_days d
    INNER JOIN sl_users u ON u.id = d.user_id
    LEFT JOIN sl_user_presence p ON p.user_id = d.user_id
    WHERE u.status = 'active' AND d.last_seen_at >= ?
    ORDER BY d.last_seen_at DESC
  `).bind(dayStart).all();
  const checkedAt = new Date().toISOString();
  const usersById = new Map();
  (result.results || []).forEach(row => {
    const isOnline = Boolean(row.current_presence_user_id) && String(row.current_last_seen_at || "") >= onlineCutoff;
    const pagePath = isOnline ? row.current_page_path : row.page_path;
    const view = adminPresenceUserView(row, isOnline, pagePath);
    const existing = usersById.get(view.id);
    if (!existing || String(view.last_seen_at).localeCompare(String(existing.last_seen_at)) > 0) usersById.set(view.id, view);
  });
  const users = [...usersById.values()].sort((left, right) => String(right.last_seen_at).localeCompare(String(left.last_seen_at)));
  return apiResponse({
    ok: true,
    checked_at: checkedAt,
    day_start: dayStart,
    online_window_seconds: ONLINE_PRESENCE_WINDOW_SECONDS,
    users
  });
}

async function adminOverview(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  const rows = await allUserRows(db);
  const users = rows.map(adminUser);
  const members = rows.filter(row => row.role === "member");
  const stats = {
    total: rows.length,
    members: members.length,
    active: rows.filter(row => row.status === "active").length,
    suspended: rows.filter(row => row.status === "suspended").length,
    verified: rows.filter(row => row.verified).length,
    credits: rows.reduce((sum, row) => sum + Number(row.time_credits || 0), 0)
  };
  const skills = new Map();
  members.forEach(row => {
    const profile = rowParts(row).profile;
    [profile.skills_to_teach, profile.skills_to_learn].forEach(value => String(value || "").split(",").map(item => item.trim()).filter(Boolean).forEach(skill => skills.set(skill, (skills.get(skill) || 0) + 1)));
  });
  const now = Date.now();
  const engaged = members.filter(row => row.last_login_at || row.updated_at).length;
  const recent = members.filter(row => now - new Date(row.updated_at).getTime() <= 30 * 24 * 60 * 60 * 1000).length;
  const auditResult = await db.prepare("SELECT a.*, u.username AS actor_username, u.profile_json AS actor_profile_json FROM sl_audit_log a LEFT JOIN sl_users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 100").all();
  const audit_log = (auditResult.results || []).map(entry => {
    const actorProfile = parseJson(entry.actor_profile_json, {});
    return {
      id: entry.id, actor_id: entry.actor_id, target_id: entry.target_id, action: entry.action,
      details: entry.details, created_at: entry.created_at, actor_name: actorProfile.display_name || entry.actor_username || "System"
    };
  });
  return apiResponse({
    users, stats, audit_log,
    analytics: {
      engagement_rate: members.length ? Math.round(engaged / members.length * 100) : 0,
      engaged_members: engaged,
      average_profile_completeness: members.length ? Math.round(members.reduce((sum, row) => sum + profileCompleteness(rowParts(row).profile), 0) / members.length) : 0,
      completed_session_hours: 0,
      credits_earned: members.length * SIGNUP_CREDIT_AMOUNT,
      credits_spent: 0,
      sessions: {scheduled: 0, completed: 0},
      active_last_30_days: recent,
      top_skills: [...skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(item => ({label: item[0], value: item[1]})),
      content: {ideas: 0, groups: 0, conversations: 0, feedback: 0}
    }
  });
}

async function adminCreateUser(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const body = await readJson(request);
  const username = safeText(body.username, 30).toLowerCase();
  const email = safeText(body.email, 254).toLowerCase();
  const password = String(body.password || "");
  if (!/^[a-z0-9._-]{3,30}$/.test(username) || !/^\S+@\S+\.\S+$/.test(email)) return apiResponse({error: "Enter a valid username and email address."}, 400);
  if (!passwordMeetsPolicy(password)) return apiResponse({error: passwordPolicyMessage()}, 400);
  const profile = normalizeProfile(body.profile);
  profile.display_name = profile.display_name || [profile.first_name, profile.last_name].filter(Boolean).join(" ");
  if (!profile.display_name) return apiResponse({error: "Add a display name for this member."}, 400);
  if (!validName(profile.display_name, "display_name") || !validName(profile.first_name, "first_name") || !validName(profile.last_name, "last_name")) {
    return apiResponse({error: NAME_FORMAT_ERROR}, 400);
  }
  const preferences = normalizePreferences({profile_visibility: "public"});
  const safety = normalizeSafety(body.safety, profile);
  if (safety.is_minor) {
    preferences.show_location = false;
    if (!safety.guardian_name || !safety.guardian_email || !safety.guardian_relationship || !safety.guardian_consent_declared) {
      return apiResponse({error: "A parent or guardian must provide consent for children under 13."}, 400);
    }
  }
  const createdAt = new Date().toISOString();
  const row = createUserRow({
    id: newId("usr"), username, email, passwordHash: await hashPassword(password), profile, preferences, safety,
    timeCredits: Math.max(0, Math.min(100_000, Number(body.starting_credits ?? SIGNUP_CREDIT_AMOUNT))), createdAt, termsAcceptedAt: createdAt
  });
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  try {
    await db.batch([
      userInsert(db, row),
      streakAccountInsert(db, row.id, createdAt),
      auditInsert(db, {actorId: access.row.id, targetId: row.id, action: "admin_user_created", details: "Administrator created member " + username + ".", createdAt})
    ]);
  } catch (error) {
    if (uniqueViolation(error)) return apiResponse({error: "That username or email address is already registered."}, 409);
    throw error;
  }
  return apiResponse({ok: true, message: "Member account created.", account_id: row.id, credentials: {username, email}, user: adminUser(row)}, 201);
}

function temporaryPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%";
  const all = upper + lower + digits + symbols;
  const pick = alphabet => alphabet[crypto.getRandomValues(new Uint8Array(1))[0] % alphabet.length];
  const characters = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (characters.length < 12) characters.push(pick(all));
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.getRandomValues(new Uint8Array(1))[0] % (index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return characters.join("");
}

async function adminResetUserPassword(request, env, userId) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await findUserById(db, userId);
  if (!row) return apiResponse({error: "That account was not found."}, 404);
  if (row.role === "admin") return apiResponse({error: "Administrator passwords cannot be reset from the member panel."}, 403);
  const temporary = temporaryPassword();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE sl_users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(temporary), now, row.id),
    db.prepare("DELETE FROM sl_sessions WHERE user_id = ?").bind(row.id),
    auditInsert(db, {actorId: access.row.id, targetId: row.id, action: "admin_password_reset", details: "Administrator generated a one-time temporary password.", createdAt: now})
  ]);
  return apiResponse({ok: true, message: "Temporary password generated. It is shown only once; ask the member to change it after signing in.", temporary_password: temporary});
}

async function adminUpdateUser(request, env, userId) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await findUserById(db, userId);
  if (!row) return apiResponse({error: "That account was not found."}, 404);
  const body = await readJson(request);
  if (row.role === "admin" && body.status === "suspended") return apiResponse({error: "The primary administrator cannot be suspended."}, 403);
  const status = body.status === "suspended" ? "suspended" : "active";
  const minutes = Math.max(1, Math.min(525_600, Number(body.suspension_minutes || 1)));
  const suspendedUntil = status === "suspended" ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
  const now = new Date().toISOString();
  const label = ["none", "review", "trusted", "warning"].includes(body.moderation_label) ? body.moderation_label : row.moderation_label || "none";
  const credits = Math.max(0, Math.min(100_000, Math.floor(Number(body.time_credits == null ? row.time_credits : body.time_credits) || 0)));
  const verified = safeBoolean(body.verified, Boolean(row.verified)) ? 1 : 0;
  const restricted = row.role === "admin" ? 0 : safeBoolean(body.messaging_restricted, Boolean(row.messaging_restricted)) ? 1 : 0;
  const notes = safeText(body.admin_notes == null ? row.admin_notes : body.admin_notes, 2000);
  const reason = status === "suspended" ? safeText(body.suspension_reason, 1000) : "";
  await db.batch([
    db.prepare("UPDATE sl_users SET status = ?, verified = ?, time_credits = ?, moderation_label = ?, admin_notes = ?, messaging_restricted = ?, suspended_until = ?, suspension_reason = ?, updated_at = ? WHERE id = ?").bind(status, verified, credits, label, notes, restricted, suspendedUntil, reason, now, row.id),
    auditInsert(db, {actorId: access.row.id, targetId: row.id, action: "admin_account_updated", details: "Administrator updated " + row.username + ": " + status + ", " + credits + " credits.", createdAt: now})
  ]);
  const updated = {...row, status, verified, time_credits: credits, moderation_label: label, admin_notes: notes, messaging_restricted: restricted, suspended_until: suspendedUntil, suspension_reason: reason, updated_at: now};
  return apiResponse({ok: true, message: "Account controls saved.", user: adminUser(updated)});
}

async function adminDeleteUser(request, env, userId) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await findUserById(db, userId);
  if (!row) return apiResponse({error: "That account was not found."}, 404);
  if (row.role === "admin") return apiResponse({error: "The primary administrator cannot be deleted."}, 403);
  await db.batch([
    db.prepare("DELETE FROM sl_sessions WHERE user_id = ?").bind(row.id),
    db.prepare("DELETE FROM sl_app_records WHERE owner_id = ?").bind(row.id),
    db.prepare("DELETE FROM sl_learning_streak_days WHERE user_id = ?").bind(row.id),
    db.prepare("DELETE FROM sl_learning_streaks WHERE user_id = ?").bind(row.id),
    db.prepare("DELETE FROM sl_users WHERE id = ?").bind(row.id),
    auditInsert(db, {actorId: access.row.id, targetId: row.id, action: "admin_account_deleted", details: "Administrator permanently deleted " + row.username + "."})
  ]);
  return apiResponse({ok: true, message: "Member account permanently deleted."});
}

async function adminBulk(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const body = await readJson(request);
  const action = safeText(body.action, 40);
  const ids = Array.isArray(body.user_ids) ? [...new Set(body.user_ids.map(id => safeText(id, 100)).filter(Boolean))].slice(0, 100) : [];
  if (!ids.length) return apiResponse({error: "Select at least one member account."}, 400);
  const placeholders = ids.map(() => "?").join(",");
  const db = dbFor(env);
  const result = await db.prepare("SELECT * FROM sl_users WHERE id IN (" + placeholders + ")").bind(...ids).all();
  const statements = [];
  const now = new Date().toISOString();
  let changed = 0;
  for (const row of result.results || []) {
    if (row.role === "admin") continue;
    let status = row.status;
    let label = row.moderation_label || "none";
    let verified = Number(row.verified || 0);
    let restricted = Number(row.messaging_restricted || 0);
    let suspendedUntil = row.suspended_until;
    let reason = row.suspension_reason || "";
    if (action === "mark_review") label = "review";
    else if (action === "mark_trusted") label = "trusted";
    else if (action === "verify") verified = 1;
    else if (action === "suspend") {
      status = "suspended";
      suspendedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      reason = "Bulk administrator suspension for 24 hours.";
    } else if (action === "activate") {
      status = "active";
      suspendedUntil = null;
      reason = "";
    } else if (action === "restrict_messaging") restricted = 1;
    else if (action === "restore_messaging") restricted = 0;
    else continue;
    statements.push(db.prepare("UPDATE sl_users SET status = ?, moderation_label = ?, verified = ?, messaging_restricted = ?, suspended_until = ?, suspension_reason = ?, updated_at = ? WHERE id = ?").bind(status, label, verified, restricted, suspendedUntil, reason, now, row.id));
    statements.push(auditInsert(db, {actorId: access.row.id, targetId: row.id, action: "admin_bulk_update", details: "Bulk action " + action + " applied.", createdAt: now}));
    changed += 1;
  }
  if (!changed) return apiResponse({error: "No member accounts were changed."}, 400);
  await db.batch(statements);
  return apiResponse({ok: true, message: changed + " member account" + (changed === 1 ? "" : "s") + " updated."});
}

async function guardianConsent(request, env, userId) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  const row = await findUserById(db, userId);
  if (!row) return apiResponse({error: "That account was not found."}, 404);
  const parts = rowParts(row);
  const body = await readJson(request);
  const status = ["pending", "verified", "rejected"].includes(body.status) ? body.status : "pending";
  parts.safety.guardian_consent_status = status;
  parts.safety.guardian_notes = safeText(body.guardian_notes, 2000);
  parts.safety.guardian_verified_at = status === "verified" ? new Date().toISOString() : "";
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE sl_users SET safety_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(parts.safety), now, row.id),
    auditInsert(db, {actorId: access.row.id, targetId: row.id, action: "guardian_consent_reviewed", details: "Guardian consent marked " + status + ".", createdAt: now})
  ]);
  return apiResponse({ok: true, user: adminUser({...row, safety_json: JSON.stringify(parts.safety), updated_at: now})});
}

async function adminReportView(db, report, viewerId, memberCache = null) {
  const message = report.message_id ? await db.prepare("SELECT * FROM sl_messages WHERE id = ? LIMIT 1").bind(report.message_id).first() : null;
  const reportedId = report.reported_user_id || message?.sender_id || "";
  const reporter = report.reporter_id ? await featureMemberView(db, report.reporter_id, viewerId) : null;
  const reported = reportedId ? await featureMemberView(db, reportedId, viewerId) : null;
  const conversationRow = report.conversation_id ? await db.prepare("SELECT id, kind, title, created_at, updated_at FROM sl_conversations WHERE id = ? LIMIT 1").bind(report.conversation_id).first() : null;
  const activityRows = report.conversation_id ? (await db.prepare("SELECT * FROM sl_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 500").bind(report.conversation_id).all()).results || [] : [];
  const activity = [];
  for (const row of activityRows) activity.push(await messageView(db, row, viewerId, memberCache));
  return {
    ...report,
    status: report.status || "open",
    category: report.category || "member_report",
    reporter,
    reported_user_id: reportedId,
    reported_user: reported,
    conversation: conversationRow ? {id: conversationRow.id, kind: conversationRow.kind, title: conversationRow.title || "SwapLabs conversation", created_at: conversationRow.created_at, updated_at: conversationRow.updated_at} : null,
    conversation_activity: activity,
    evidence: activity,
    evidence_captured_at: report.evidence_captured_at || report.created_at
  };
}

async function adminDisputeView(db, dispute, viewerId, ledgerRows) {
  const ledgerEntry = ledgerRows.find(entry => entry.id === dispute.ledger_entry_id) || null;
  const userId = dispute.user_id || ledgerEntry?.user_id || "";
  const user = userId ? await featureMemberView(db, userId, viewerId) : null;
  let counterparty = null;
  if (ledgerEntry?.counterparty_id) counterparty = await featureMemberView(db, ledgerEntry.counterparty_id, viewerId);
  return {...dispute, status: dispute.status || "open", user, counterparty, ledger_entry: ledgerEntry};
}

async function adminSessionReviewView(db, review, viewerRow, memberCache = null) {
  const event = review?.event_id ? await appRecord(db, "events", review.event_id) : null;
  const ratings = (await appRecords(db, "session_ratings", null)).filter(item => item.event_id === review?.event_id);
  const ratingViews = [];
  for (const rating of ratings) ratingViews.push({...rating, rating: Number(rating.rating || 0), rater: await featureMemberView(db, rating.rater_id, viewerRow.id, memberCache), points_status: rating.points_status || "awarded", points_awarded: Number(rating.points_awarded || 0), points_revoked: Number(rating.points_revoked || 0)});
  let transcript = [];
  if (event?.conversation_id) {
    const rows = (await db.prepare("SELECT * FROM sl_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 500").bind(event.conversation_id).all()).results || [];
    for (const row of rows) transcript.push(await messageView(db, row, viewerRow.id, memberCache));
  }
  return {...review, event: event ? await featureEventViewFor(db, event, viewerRow, {memberCache}) : null, ratings: ratingViews, transcript};
}

async function adminOperations(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const [conversationRows, messageRows, reportRows, disputeRows, ledgerRows, eventRows, users, auditRows, reviewRows, ratingRows, progressRows] = await Promise.all([
    db.prepare("SELECT * FROM sl_conversations ORDER BY updated_at DESC").all().then(result => result.results || []),
    db.prepare("SELECT * FROM sl_messages ORDER BY created_at DESC LIMIT 5000").all().then(result => result.results || []),
    appRecords(db, "reports", null),
    appRecords(db, "disputes", null),
    appRecords(db, "ledger", null),
    appRecords(db, "events", null),
    allUserRows(db),
    db.prepare("SELECT * FROM sl_audit_log ORDER BY created_at DESC LIMIT 500").all().then(result => result.results || []),
    appRecords(db, "session_point_reviews", null),
    appRecords(db, "session_ratings", null),
    appRecords(db, "session_progress_reports", null)
  ]);
  const eventContext = {ratings: ratingRows, reports: progressRows, pointReviews: reviewRows, memberCache: new Map(users.map(row => [String(row.id), row]))};
  const reports = [];
  const memberCache = eventContext.memberCache;
  for (const report of reportRows) reports.push(await adminReportView(db, report, access.row.id, memberCache));
  const disputes = [];
  for (const dispute of disputeRows) disputes.push(await adminDisputeView(db, dispute, access.row.id, ledgerRows));
  const events = [];
  for (const event of eventRows) {
    const base = await featureEventViewFor(db, event, access.row, eventContext);
    const review = reviewRows.find(item => item.event_id === event.id);
    events.push({...base, points_review: review ? await adminSessionReviewView(db, review, access.row, memberCache) : null});
  }
  const messages = [];
  for (const row of messageRows.slice(0, 500)) messages.push(await messageView(db, row, access.row.id, memberCache));
  const activity = users.filter(row => row.role !== "admin").map(row => {
    const memberMessages = messageRows.filter(message => message.sender_id === row.id);
    const memberReports = reportRows.filter(report => report.reported_user_id === row.id || report.reporter_id === row.id);
    const memberEvents = eventRows.filter(event => event.host_id === row.id || featureParticipantIds(event).includes(row.id));
    const memberLedger = ledgerRows.filter(entry => entry.user_id === row.id);
    const parts = rowParts(row);
    return {
      user: {...commonPublicFields(row, parts.profile, parts.preferences, parts.safety, access.row.id), display_name: parts.profile.display_name || row.username, time_credits: Number(row.time_credits || 0), messaging_restricted: Boolean(row.messaging_restricted)},
      messages_sent: memberMessages.length,
      reports_received: memberReports.filter(report => report.reported_user_id === row.id).length,
      open_reports: memberReports.filter(report => report.reported_user_id === row.id && !["resolved", "dismissed"].includes(report.status)).length,
      calendar_events: memberEvents.length,
      ledger_entries: memberLedger.length,
      last_message_at: memberMessages.map(message => message.created_at).sort().at(-1) || null
    };
  });
  const audit = [];
  for (const row of auditRows) {
    const actor = row.actor_id ? await findUserById(db, row.actor_id) : null;
    audit.push({...row, actor_name: actor ? (rowParts(actor).profile.display_name || actor.username) : "SwapLabs system"});
  }
  const sessionPointReviews = [];
  for (const review of reviewRows) sessionPointReviews.push(await adminSessionReviewView(db, review, access.row, memberCache));
  return apiResponse({
    stats: {
      conversations: conversationRows.length,
      messages: messageRows.length,
      open_reports: reports.filter(item => !["resolved", "dismissed"].includes(item.status)).length,
      scheduled_events: eventRows.filter(item => item.status === "scheduled").length,
      ledger_entries: ledgerRows.length,
      open_disputes: disputes.filter(item => !["resolved", "dismissed"].includes(item.status)).length,
      pending_session_point_reviews: sessionPointReviews.filter(item => item.status === "pending").length
    },
    messages, reports, disputes, sessions: events, events, session_point_reviews: sessionPointReviews, activity, ledger: ledgerRows, audit
  });
}

async function adminModerateMessage(request, env, messageId) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const body = await readJson(request);
  const status = ["visible", "removed"].includes(body.status) ? body.status : "visible";
  const db = dbFor(env);
  const row = await db.prepare("SELECT * FROM sl_messages WHERE id = ? LIMIT 1").bind(messageId).first();
  if (!row) return apiResponse({error: "That message was not found."}, 404);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE sl_messages SET moderation_status = ?, updated_at = ? WHERE id = ?").bind(status, now, messageId),
    auditInsert(db, {actorId: access.row.id, targetId: row.sender_id, action: status === "removed" ? "message_removed" : "message_restored", details: safeText(body.reason || "Administrator moderation decision.", 1000), createdAt: now})
  ]);
  const updated = {...row, moderation_status: status, updated_at: now};
  return apiResponse({ok: true, message: await messageView(db, updated, access.row.id)});
}

async function adminMessageReportUpdate(request, env, reportId) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  const report = await appRecord(db, "reports", reportId);
  if (!report) return apiResponse({error: "That message report was not found."}, 404);
  const body = await readJson(request);
  const message = report.message_id ? await db.prepare("SELECT * FROM sl_messages WHERE id = ? LIMIT 1").bind(report.message_id).first() : null;
  const reportedId = report.reported_user_id || message?.sender_id || "";
  const action = safeText(body.action || report.action || "pending", 40).toLowerCase();
  const nextStatus = ["open", "reviewing", "resolved", "dismissed"].includes(body.status) ? body.status : action === "dismissed" ? "dismissed" : (report.status || "reviewing");
  const notes = safeText(body.admin_notes, 2000);
  const now = new Date().toISOString();
  const statements = [];
  if (reportedId) {
    const target = await findUserById(db, reportedId);
    if (target && target.role !== "admin") {
      if (action === "restricted") statements.push(db.prepare("UPDATE sl_users SET messaging_restricted = 1, moderation_label = 'warning', updated_at = ? WHERE id = ?").bind(now, reportedId));
      if (action === "restored") statements.push(db.prepare("UPDATE sl_users SET status = 'active', messaging_restricted = 0, suspended_until = NULL, suspension_reason = '', updated_at = ? WHERE id = ?").bind(now, reportedId));
      if (action === "suspended") {
        const minutes = Math.max(1, Math.min(525600, Number(body.suspension_minutes || 1440)));
        const until = new Date(Date.now() + minutes * 60_000).toISOString();
        statements.push(db.prepare("UPDATE sl_users SET status = 'suspended', suspended_until = ?, suspension_reason = ?, moderation_label = 'warning', updated_at = ? WHERE id = ?").bind(until, safeText(body.suspension_reason || notes || "Administrator safety review.", 1000), now, reportedId));
      }
      if (action === "warning") statements.push(db.prepare("UPDATE sl_users SET moderation_label = 'warning', updated_at = ? WHERE id = ?").bind(now, reportedId));
    }
  }
  const saved = await saveAppRecord(db, "reports", {...report, status: nextStatus, action, admin_notes: notes, reviewed_by: access.row.id, reviewed_at: now}, report.owner_id || report.reporter_id || access.row.id);
  statements.push(auditInsert(db, {actorId: access.row.id, targetId: reportedId, action: "message_report_reviewed", details: `${action} · ${nextStatus}`, createdAt: now}));
  if (statements.length) await db.batch(statements);
  return apiResponse({ok: true, report: await adminReportView(db, saved, access.row.id)});
}

async function adminCreditDisputeUpdate(request, env, disputeId) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  const dispute = await appRecord(db, "disputes", disputeId);
  if (!dispute) return apiResponse({error: "That credit dispute was not found."}, 404);
  if (["resolved", "dismissed"].includes(dispute.status)) return apiResponse({error: "That credit dispute already has a final decision."}, 409);
  const body = await readJson(request);
  const resolution = ["approved", "partial", "denied"].includes(body.resolution) ? body.resolution : "denied";
  const ledgerRows = await appRecords(db, "ledger", null);
  const ledgerEntry = ledgerRows.find(entry => entry.id === dispute.ledger_entry_id) || null;
  const amount = Math.max(0, Math.min(Math.abs(Number(ledgerEntry?.amount || 0)), Number(body.refund_amount || 0)));
  const userId = dispute.user_id || ledgerEntry?.user_id || "";
  const reference = `dispute-refund-${dispute.id}`;
  const statements = [];
  const now = new Date().toISOString();
  if (resolution !== "denied" && amount > 0 && userId && !ledgerRows.some(entry => entry.reference_id === reference)) {
    const user = await findUserById(db, userId);
    if (user) {
      const balance = Number(user.time_credits || 0) + amount;
      statements.push(db.prepare("UPDATE sl_users SET time_credits = ?, updated_at = ? WHERE id = ?").bind(balance, now, userId));
      await saveAppRecord(db, "ledger", {id: newId("ledger"), user_id: userId, type: "refund", amount, balance_after: balance, description: `Refund for credit dispute ${dispute.id}`, reference_id: reference, reference_type: "dispute_refund", created_by: access.row.id, created_at: now}, userId);
    }
  }
  const saved = await saveAppRecord(db, "disputes", {...dispute, status: resolution === "denied" ? "dismissed" : "resolved", resolution, refund_amount: amount, admin_notes: safeText(body.admin_notes, 2000), resolved_by: access.row.id, resolved_at: now}, dispute.owner_id || userId || access.row.id);
  statements.push(auditInsert(db, {actorId: access.row.id, targetId: userId, action: "credit_dispute_resolved", details: `${resolution} · ${amount} credits`, createdAt: now}));
  if (statements.length) await db.batch(statements);
  return apiResponse({ok: true, message: "Credit dispute resolved.", dispute: await adminDisputeView(db, saved, access.row.id, [...ledgerRows, ...(await appRecords(db, "ledger", null))])});
}

async function adminIdeaMutation(request, env, ideaId) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  const idea = await appRecord(db, "ideas", ideaId);
  if (!idea) return apiResponse({error: "That idea could not be found."}, 404);
  if (request.method === "DELETE") {
    await deleteAppRecord(db, "ideas", ideaId);
    return apiResponse({ok: true, message: "Idea deleted permanently."});
  }
  const body = await readJson(request);
  const textFields = ["title", "tagline", "category", "stage", "problem", "solution", "beneficiaries", "impact", "funding_currency", "funds_use", "collaboration", "reach", "prototype_url", "pitch", "status", "moderation_notes"];
  const updated = {...idea};
  textFields.forEach(field => { if (body[field] !== undefined) updated[field] = safeText(body[field], field === "pitch" ? 6000 : 2000); });
  if (body.funding_needed !== undefined) updated.funding_needed = Math.max(0, Number(body.funding_needed) || 0);
  if (body.skills_needed !== undefined) updated.skills_needed = Array.isArray(body.skills_needed) ? body.skills_needed.map(value => safeText(value, 120)).filter(Boolean) : csvValues(body.skills_needed);
  const saved = await saveAppRecord(db, "ideas", updated, idea.owner_id || access.row.id);
  return apiResponse({ok: true, message: "Idea changes saved.", idea: featureIdeaView(saved, access.row.id)});
}

async function adminSessionReviewMutation(request, env, reviewId) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  const review = await appRecord(db, "session_point_reviews", reviewId);
  if (!review) return apiResponse({error: "That session point review could not be found."}, 404);
  if (review.status && review.status !== "pending") return apiResponse({error: "That session review already has a final administrator decision."}, 409);
  const body = await readJson(request);
  const decision = safeText(body.decision, 20).toLowerCase();
  if (!["approve", "deny"].includes(decision)) return apiResponse({error: "Choose whether to approve or deny the session points."}, 400);
  const ratings = (await appRecords(db, "session_ratings", null)).filter(item => item.event_id === review.event_id);
  const now = new Date().toISOString();
  for (const rating of ratings) {
    if (decision === "approve" && rating.points_status !== "awarded") {
      const recipient = await findUserById(db, rating.rater_id);
      if (recipient) await db.prepare("UPDATE sl_users SET reward_points = ?, updated_at = ? WHERE id = ?").bind(Number(recipient.reward_points || 0) + 10, now, recipient.id).run();
      await saveAppRecord(db, "session_ratings", {...rating, points_status: "awarded", points_awarded: 10, points_awarded_at: now}, rating.owner_id || rating.rater_id);
    } else if (decision === "deny") {
      await saveAppRecord(db, "session_ratings", {...rating, points_status: "withheld", points_revoked: Number(rating.points_awarded || 0), points_revoked_at: now}, rating.owner_id || rating.rater_id);
    }
  }
  const event = review.event_id ? await appRecord(db, "events", review.event_id) : null;
  if (event) await saveAppRecord(db, "events", {...event, points_status: decision === "approve" ? "awarded" : "withheld", points_review_id: review.id}, event.owner_id || event.host_id || access.row.id);
  const saved = await saveAppRecord(db, "session_point_reviews", {...review, status: decision === "approve" ? "approved" : "denied", admin_id: access.row.id, admin_notes: safeText(body.admin_notes, 2000), decided_at: now, updated_at: now}, review.owner_id || review.event_id || access.row.id);
  await db.prepare("INSERT INTO sl_audit_log (id, actor_id, target_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(newId("audit"), access.row.id, review.event_id || null, "session_points_reviewed", `${decision} · ${review.id}`, now).run();
  return apiResponse({ok: true, message: decision === "approve" ? "Session points approved and awarded privately." : "Session points denied and withheld privately.", review: await adminSessionReviewView(db, saved, access.row)});
}

async function adminContentMutation(request, env, collection, recordId) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  const body = request.method === "PATCH" ? await readJson(request) : {};
  const collectionMap = {contacts: "contact_messages", complaints: "complaints", feedback: "feedback", ideas: "ideas", blogs: "blogs", reports: "reports"};
  if (collectionMap[collection]) {
    const actual = collectionMap[collection];
    const record = await appRecord(db, actual, recordId);
    if (!record) return apiResponse({error: "That record was not found."}, 404);
    if (request.method === "DELETE") await deleteAppRecord(db, actual, recordId);
    else await saveAppRecord(db, actual, {...record, ...body, updated_at: new Date().toISOString()}, record.owner_id || access.row.id);
    return apiResponse({ok: true, message: request.method === "DELETE" ? "Record deleted." : "Record updated."});
  }
  if (collection === "workshops") {
    const row = await db.prepare("SELECT * FROM sl_workshops WHERE id = ? LIMIT 1").bind(recordId).first();
    if (!row) return apiResponse({error: "That workshop was not found."}, 404);
    if (request.method === "DELETE") await db.prepare("DELETE FROM sl_workshops WHERE id = ?").bind(recordId).run();
    else {
      const title = body.title === undefined ? row.title : safeText(body.title, 160);
      const description = body.description === undefined ? row.description : safeText(body.description, 4000);
      const status = body.status === undefined ? row.status : safeText(body.status, 40);
      const adminNotes = body.admin_notes === undefined ? row.admin_notes : safeText(body.admin_notes, 2000);
      await db.prepare("UPDATE sl_workshops SET title = ?, description = ?, status = ?, admin_notes = ?, updated_at = ? WHERE id = ?").bind(title, description, status, adminNotes, new Date().toISOString(), recordId).run();
    }
    return apiResponse({ok: true, message: request.method === "DELETE" ? "Workshop deleted." : "Workshop updated."});
  }
  if (collection === "registrations") {
    const row = await db.prepare("SELECT * FROM sl_workshop_registrations WHERE id = ? LIMIT 1").bind(recordId).first();
    if (!row) return apiResponse({error: "That workshop registration was not found."}, 404);
    if (request.method === "DELETE") await db.prepare("DELETE FROM sl_workshop_registrations WHERE id = ?").bind(recordId).run();
    else await db.prepare("UPDATE sl_workshop_registrations SET status = ?, updated_at = ? WHERE id = ?").bind(safeText(body.status || row.status, 40), new Date().toISOString(), recordId).run();
    return apiResponse({ok: true, message: request.method === "DELETE" ? "Registration deleted." : "Registration updated."});
  }
  return apiResponse({error: "Unsupported administration collection."}, 404);
}

async function adminNewsletterMutation(request, env, recordId) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  const record = await appRecord(db, "newsletter", recordId);
  if (!record) return apiResponse({error: "That subscriber was not found."}, 404);
  await deleteAppRecord(db, "newsletter", recordId);
  return apiResponse({ok: true, message: "Subscriber removed."});
}

async function adminContent(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  const contactMessages = await appRecords(db, "contact_messages", null);
  const complaints = await appRecords(db, "complaints", null);
  const feedback = await appRecords(db, "feedback", null);
  const ideas = await appRecords(db, "ideas", null);
  const workshops = (await db.prepare("SELECT * FROM sl_workshops ORDER BY starts_at ASC").all()).results || [];
  const registrations = (await db.prepare("SELECT * FROM sl_workshop_registrations ORDER BY created_at DESC").all()).results || [];
  const isSafetySubmission = item => {
    const text = [item?.request_type, item?.category, item?.topic, item?.subject, item?.details, item?.message]
      .map(value => String(value || "").trim().toLowerCase()).join(" ");
    return String(item?.request_type || "").trim().toLowerCase() === "safety" || /\b(safety|harassment|fraud|impersonation|threat|unsafe|student safety)\b/.test(text);
  };
  return apiResponse({
    contact_messages: contactMessages, complaints, feedback, workshops, workshop_registrations: registrations, ideas,
    stats: {
      ideas: ideas.length,
      student_reviews: ideas.filter(item => ["under_review", "specialist_review"].includes(item.status)).length,
      published_testimonials: feedback.filter(item => (item.permission_to_publish || item.publication_permission) && item.status !== "archived").length,
      open_complaints: complaints.filter(item => !isSafetySubmission(item) && !["resolved", "closed"].includes(item.status)).length,
      safety_reports: complaints.filter(item => isSafetySubmission(item) && !["resolved", "closed", "dismissed"].includes(item.status)).length,
      new_contacts: contactMessages.filter(item => ["new", "reviewing", "in_progress", "waiting", ""].includes(String(item.status || "new"))).length,
      workshop_registrations: registrations.length
    }
  });
}

async function adminNewsletter(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const db = dbFor(env);
  return apiResponse({subscribers: await appRecords(db, "newsletter", null)});
}

async function privacy(request, env) {
  const row = await sessionUser(request, env);
  if (!row) return apiResponse({error: "Please log in to manage privacy settings."}, 401);
  const parts = rowParts(row);
  if (request.method === "PATCH") {
    const body = await readJson(request);
    parts.preferences.data_retention = safeText(body.data_retention, 40);
    parts.preferences.message_retention = safeText(body.message_retention, 40);
    parts.preferences.session_history_retention = safeText(body.session_history_retention, 40);
    parts.preferences.allow_research_analytics = safeBoolean(body.allow_research_analytics, false);
    const now = new Date().toISOString();
    const db = dbFor(env);
    await db.batch([
      db.prepare("UPDATE sl_users SET preferences_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(parts.preferences), now, row.id),
      auditInsert(db, {actorId: row.id, targetId: row.id, action: "privacy_updated", details: "Privacy and retention settings updated.", createdAt: now})
    ]);
  }
  return apiResponse({preferences: parts.preferences, counts: {messages: 0, calendar_events: 0, ledger_entries: 0, ideas: 0}, schedule: {}});
}

async function privacyCleanup(request, env) {
  const row = await sessionUser(request, env);
  if (!row) return apiResponse({error: "Please log in to manage privacy settings."}, 401);
  return apiResponse({removed: {messages: 0, calendar_events: 0, ideas: 0}});
}

function workshopInput(body) {
  const source = isObject(body) ? body : {};
  const outcomes = jsonArray(source.outcomes).map(value => safeText(value, 160)).filter(Boolean).slice(0, 6);
  const tags = jsonArray(source.tags).map(value => safeText(value, 40)).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).slice(0, 10);
  const startsAt = safeText(source.starts_at, 80);
  const parsedStart = new Date(startsAt);
  const duration = Math.floor(Number(source.duration_minutes));
  const seats = Math.floor(Number(source.seat_limit));
  const errors = [];
  if (!safeText(source.title, 160)) errors.push("Add a workshop title.");
  if (!safeText(source.description, 4000)) errors.push("Add a short workshop description.");
  if (!safeText(source.category, 80)) errors.push("Choose a workshop category.");
  if (!safeText(source.location, 240)) errors.push("Add an online link or location.");
  if (!safeText(source.timezone, 120)) errors.push("Choose a timezone.");
  if (!startsAt || Number.isNaN(parsedStart.getTime())) errors.push("Choose a valid start date and time.");
  else if (parsedStart.getTime() <= Date.now()) errors.push("Choose a start time in the future.");
  if (!Number.isInteger(duration) || duration < 15 || duration > 480) errors.push("Workshop duration must be between 15 and 480 minutes.");
  if (!Number.isInteger(seats) || seats < 1 || seats > 500) errors.push("Choose between 1 and 500 seats.");
  if (!outcomes.length) errors.push("Add at least one learning outcome.");
  if (!safeBoolean(source.hosting_agreement, false)) errors.push("Confirm the hosting agreement before publishing.");
  return {
    title: safeText(source.title, 160), description: safeText(source.description, 4000),
    category: safeText(source.category, 80), level: safeText(source.level || "All levels", 60),
    format: safeText(source.format || "Online", 60), location: safeText(source.location, 240),
    timezone: safeText(source.timezone, 120), startsAt: Number.isNaN(parsedStart.getTime()) ? startsAt : parsedStart.toISOString(),
    duration, seats, outcomes, tags, errors
  };
}

function workshopEndsAt(row) {
  const starts = new Date(row?.starts_at || "").getTime();
  const duration = Math.max(15, Number(row?.duration_minutes || 60));
  return Number.isFinite(starts) ? new Date(starts + duration * 60000).toISOString() : "";
}

async function ensureWorkshopShare(db, row) {
  if (!row?.id) return null;
  const existing = await db.prepare("SELECT share_id, workshop_id, expires_at, created_at FROM sl_workshop_shares WHERE workshop_id = ? LIMIT 1").bind(row.id).first();
  const expiresAt = workshopEndsAt(row);
  if (existing) {
    if (expiresAt && existing.expires_at !== expiresAt) {
      await db.prepare("UPDATE sl_workshop_shares SET expires_at = ? WHERE share_id = ?").bind(expiresAt, existing.share_id).run();
      return {...existing, expires_at: expiresAt};
    }
    return existing;
  }
  if (!expiresAt) return null;
  const createdAt = new Date().toISOString();
  const share = {share_id: newId("ws"), workshop_id: row.id, expires_at: expiresAt, created_at: createdAt};
  await db.prepare("INSERT OR IGNORE INTO sl_workshop_shares (share_id, workshop_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(share.share_id, share.workshop_id, share.expires_at, share.created_at).run();
  return await db.prepare("SELECT share_id, workshop_id, expires_at, created_at FROM sl_workshop_shares WHERE workshop_id = ? LIMIT 1").bind(row.id).first() || share;
}

async function workshopView(db, row, viewerId, registeredCount, share = null) {
  const hostRow = await findUserById(db, row.host_id);
  const hostParts = hostRow ? rowParts(hostRow) : {profile: normalizeProfile({}), preferences: normalizePreferences({}), safety: {is_minor: false}};
  const host = hostRow ? commonPublicFields(hostRow, hostParts.profile, hostParts.preferences, hostParts.safety, viewerId) : null;
  const registered = Number(registeredCount || 0);
  const viewerRegistration = viewerId ? await db.prepare("SELECT 1 FROM sl_workshop_registrations WHERE workshop_id = ? AND user_id = ? AND status = 'registered' LIMIT 1").bind(row.id, viewerId).first() : null;
  const resolvedShare = share || await ensureWorkshopShare(db, row);
  const expiresAt = resolvedShare?.expires_at || workshopEndsAt(row);
  return {
    id: row.id, event_id: row.event_id, title: row.title, description: row.description, category: row.category,
    level: row.level, format: row.format, location: row.location, timezone: row.timezone, starts_at: row.starts_at,
    duration_minutes: Number(row.duration_minutes || 0), seat_limit: Number(row.seat_limit || 0),
    outcomes: jsonArray(row.outcomes_json), tags: jsonArray(row.tags_json), status: row.status,
    registered_count: registered, seats_remaining: Math.max(0, Number(row.seat_limit || 0) - registered),
    viewer_registered: Boolean(viewerRegistration), viewer_is_host: viewerId === row.host_id, host,
    share_id: resolvedShare?.share_id || "", share_expires_at: expiresAt,
    share_active: row.status === "scheduled" && Boolean(expiresAt) && new Date(expiresAt).getTime() > Date.now(),
    created_at: row.created_at, updated_at: row.updated_at
  };
}

async function workshops(request, env) {
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  let viewer = null;
  try { viewer = await sessionUser(request, env); } catch (_error) { viewer = null; }
  const result = await db.prepare("SELECT * FROM sl_workshops WHERE status = 'scheduled' ORDER BY starts_at ASC").all();
  const rows = result.results || [];
  const countsResult = await db.prepare("SELECT workshop_id, COUNT(*) AS count FROM sl_workshop_registrations WHERE status = 'registered' GROUP BY workshop_id").all();
  const counts = new Map((countsResult.results || []).map(item => [item.workshop_id, Number(item.count || 0)]));
  const sharesResult = await db.prepare("SELECT share_id, workshop_id, expires_at, created_at FROM sl_workshop_shares").all();
  const shares = new Map((sharesResult.results || []).map(item => [item.workshop_id, item]));
  const items = [];
  for (const row of rows) items.push(await workshopView(db, row, viewer && viewer.id, counts.get(row.id) || 0, shares.get(row.id)));
  const stats = {
    scheduled: items.length,
    seats: items.reduce((sum, item) => sum + item.seats_remaining, 0),
    registered: items.reduce((sum, item) => sum + item.registered_count, 0),
    hosts: new Set(items.map(item => item.host?.id).filter(Boolean)).size
  };
  return apiResponse({workshops: items, stats});
}

async function sharedWorkshop(request, env, shareId) {
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const share = await db.prepare("SELECT share_id, workshop_id, expires_at, created_at FROM sl_workshop_shares WHERE share_id = ? LIMIT 1").bind(shareId).first();
  if (!share) return apiResponse({error: "This workshop link is invalid or has expired.", code: "workshop_link_invalid"}, 404);
  const row = await db.prepare("SELECT * FROM sl_workshops WHERE id = ? LIMIT 1").bind(share.workshop_id).first();
  const expiresAt = share.expires_at || workshopEndsAt(row);
  if (!row || row.status !== "scheduled" || !expiresAt || new Date(expiresAt).getTime() <= Date.now()) {
    return apiResponse({error: "This workshop link has expired because the workshop has already happened.", code: "workshop_link_expired", expired_at: expiresAt || null}, 410);
  }
  let viewer = null;
  try { viewer = await sessionUser(request, env); } catch (_error) { viewer = null; }
  const count = await db.prepare("SELECT COUNT(*) AS count FROM sl_workshop_registrations WHERE workshop_id = ? AND status = 'registered'").bind(row.id).first();
  const workshop = await workshopView(db, row, viewer?.id, Number(count?.count || 0), share);
  const shareUrl = new URL("/workshops.html", request.url);
  shareUrl.searchParams.set("share", shareId);
  return apiResponse({workshop, share_id: shareId, share_expires_at: expiresAt, share_url: shareUrl.toString()});
}

function courseInput(body) {
  const source = isObject(body) ? body : {};
  const title = safeText(source.title, 120);
  const description = safeText(source.description, 1800);
  const category = safeText(source.category || "Other", 80) || "Other";
  const level = safeText(source.level || "All levels", 60) || "All levels";
  const estimatedHours = source.estimated_hours === "" || source.estimated_hours == null ? 1 : Number(source.estimated_hours);
  const rawResourceUrl = safeText(source.resource_url, 500);
  const resourceUrl = normalizeCourseUrl(rawResourceUrl);
  const rawLessons = jsonArray(source.lessons, []);
  const lessons = rawLessons.map((lesson, index) => ({
    id: safeText(lesson?.id || `lesson_${index + 1}`, 80),
    position: index + 1,
    title: safeText(lesson?.title, 140),
    description: safeText(lesson?.description, 600),
    resource_url: normalizeCourseUrl(lesson?.resource_url)
  })).filter(lesson => lesson.title).slice(0, 50);
  const errors = [];
  if (title.length < 3) errors.push("Add a course title with at least 3 characters.");
  if (description.length < 20) errors.push("Add a short description of what learners will learn.");
  if (rawResourceUrl && !resourceUrl) errors.push("Use a valid HTTPS resource link, or leave the course link empty.");
  if (!Number.isFinite(estimatedHours) || estimatedHours < 0.5 || estimatedHours > 100) errors.push("Estimated course time must be between 0.5 and 100 hours.");
  if (!lessons.length) errors.push("Add at least one lesson before publishing.");
  if (rawLessons.some(lesson => safeText(lesson?.resource_url, 500) && !normalizeCourseUrl(lesson.resource_url))) {
    errors.push("Use valid HTTPS links for lesson resources, or leave them empty.");
  }
  return {
    title, description, category, level,
    estimated_hours: Math.round(estimatedHours * 2) / 2,
    resource_url: resourceUrl,
    lessons,
    visibility: source.visibility === "public" ? "public" : "private",
    errors
  };
}

async function courseView(db, row, viewerId) {
  const ownerRow = await findUserById(db, row.owner_id);
  const ownerParts = ownerRow ? rowParts(ownerRow) : {profile: normalizeProfile({}), preferences: normalizePreferences({}), safety: {is_minor: false}};
  const owner = ownerRow ? commonPublicFields(ownerRow, ownerParts.profile, ownerParts.preferences, ownerParts.safety, viewerId) : null;
  const lessons = jsonArray(row.lessons_json, []).map((lesson, index) => ({
    id: safeText(lesson?.id || `lesson_${index + 1}`, 80),
    position: index + 1,
    title: safeText(lesson?.title, 140),
    description: safeText(lesson?.description, 600),
    resource_url: normalizeCourseUrl(lesson?.resource_url)
  })).filter(lesson => lesson.title).slice(0, 50);
  return {
    id: row.id, owner_id: row.owner_id, owner,
    title: row.title, description: row.description, category: row.category || "Other", level: row.level || "All levels",
    estimated_hours: Number(row.estimated_hours || 1), resource_url: normalizeCourseUrl(row.resource_url),
    visibility: row.visibility === "public" ? "public" : "private", status: row.status === "published" ? "published" : "draft",
    lessons, lesson_count: lessons.length, created_at: row.created_at, updated_at: row.updated_at, published_at: row.published_at || null,
    is_owner: Boolean(viewerId && viewerId === row.owner_id)
  };
}

async function courses(request, env) {
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  let viewer = null;
  try { viewer = await sessionUser(request, env); } catch (_error) { viewer = null; }
  const publicResult = await db.prepare("SELECT * FROM sl_courses WHERE visibility = 'public' AND status = 'published' ORDER BY COALESCE(published_at, created_at) DESC").all();
  const mineResult = viewer ? await db.prepare("SELECT * FROM sl_courses WHERE owner_id = ? ORDER BY updated_at DESC").bind(viewer.id).all() : {results: []};
  const publicItems = [];
  for (const row of publicResult.results || []) publicItems.push(await courseView(db, row, viewer?.id));
  const mine = [];
  for (const row of mineResult.results || []) mine.push(await courseView(db, row, viewer?.id));
  return apiResponse({
    courses: publicItems,
    mine,
    categories: [...new Set(publicItems.map(item => item.category).filter(Boolean))].sort((first, second) => first.localeCompare(second)),
    stats: {
      published: publicItems.length,
      lessons: publicItems.reduce((total, item) => total + Number(item.lesson_count || 0), 0),
      creators: new Set(publicItems.map(item => item.owner_id).filter(Boolean)).size
    }
  });
}

async function createCourse(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before publishing a course."}, 401);
  if (viewer.status !== "active") return apiResponse({error: "Your account cannot publish courses right now."}, 403);
  const input = courseInput(await readJson(request));
  if (input.errors.length) return apiResponse({error: input.errors[0], errors: input.errors}, 400);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const timestamp = new Date().toISOString();
  const row = {
    id: newId("course"), owner_id: viewer.id, title: input.title, description: input.description,
    category: input.category, level: input.level, estimated_hours: input.estimated_hours,
    resource_url: input.resource_url, visibility: input.visibility,
    status: input.visibility === "public" ? "published" : "draft", lessons_json: JSON.stringify(input.lessons),
    created_at: timestamp, updated_at: timestamp, published_at: input.visibility === "public" ? timestamp : null
  };
  await db.batch([
    db.prepare("INSERT INTO sl_courses (id, owner_id, title, description, category, level, estimated_hours, resource_url, visibility, status, lessons_json, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(row.id, row.owner_id, row.title, row.description, row.category, row.level, row.estimated_hours, row.resource_url, row.visibility, row.status, row.lessons_json, row.created_at, row.updated_at, row.published_at),
    auditInsert(db, {actorId: viewer.id, targetId: row.id, action: "course_created", details: "Member created course " + row.title + ".", createdAt: timestamp})
  ]);
  return apiResponse({ok: true, message: row.status === "published" ? "Your course is public." : "Your course was saved as a draft.", course: await courseView(db, row, viewer.id)}, 201);
}

async function updateCourse(request, env, courseId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before changing a course."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const existing = await db.prepare("SELECT * FROM sl_courses WHERE id = ? LIMIT 1").bind(courseId).first();
  if (!existing) return apiResponse({error: "Course not found."}, 404);
  if (existing.owner_id !== viewer.id && viewer.role !== "admin") return apiResponse({error: "You do not have permission to change this course."}, 403);
  const body = await readJson(request);
  const input = courseInput({...existing, lessons: jsonArray(existing.lessons_json, []), ...body});
  if (input.errors.length) return apiResponse({error: input.errors[0], errors: input.errors}, 400);
  const timestamp = new Date().toISOString();
  const publishedAt = input.visibility === "public" ? (existing.published_at || timestamp) : null;
  const row = {...existing, ...input, lessons_json: JSON.stringify(input.lessons), status: input.visibility === "public" ? "published" : "draft", updated_at: timestamp, published_at: publishedAt};
  await db.batch([
    db.prepare("UPDATE sl_courses SET title = ?, description = ?, category = ?, level = ?, estimated_hours = ?, resource_url = ?, visibility = ?, status = ?, lessons_json = ?, updated_at = ?, published_at = ? WHERE id = ?").bind(row.title, row.description, row.category, row.level, row.estimated_hours, row.resource_url, row.visibility, row.status, row.lessons_json, row.updated_at, row.published_at, row.id),
    auditInsert(db, {actorId: viewer.id, targetId: row.id, action: "course_updated", details: "Member updated course " + row.title + ".", createdAt: timestamp})
  ]);
  return apiResponse({ok: true, message: row.status === "published" ? "Your course is public." : "Your course was saved as a draft.", course: await courseView(db, row, viewer.id)});
}

async function deleteCourse(request, env, courseId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before removing a course."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const existing = await db.prepare("SELECT * FROM sl_courses WHERE id = ? LIMIT 1").bind(courseId).first();
  if (!existing) return apiResponse({error: "Course not found."}, 404);
  if (existing.owner_id !== viewer.id && viewer.role !== "admin") return apiResponse({error: "You do not have permission to remove this course."}, 403);
  await db.batch([
    db.prepare("DELETE FROM sl_courses WHERE id = ?").bind(courseId),
    auditInsert(db, {actorId: viewer.id, targetId: courseId, action: "course_deleted", details: "Course removed.", createdAt: new Date().toISOString()})
  ]);
  return apiResponse({ok: true, message: "Course removed."});
}

async function createWorkshop(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before hosting a workshop."}, 401);
  const completionGate = profileCompletionGate(viewer, "workshops.html");
  if (completionGate) return completionGate;
  if (viewer.role !== "member" || viewer.status !== "active") return apiResponse({error: "Only active member accounts can host workshops."}, 403);
  const input = workshopInput(await readJson(request));
  if (input.errors.length) return apiResponse({error: input.errors[0], errors: input.errors}, 400);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const now = new Date().toISOString();
  const row = {
    id: newId("wrk"), host_id: viewer.id, event_id: newId("evt"), title: input.title, description: input.description,
    category: input.category, level: input.level, format: input.format, location: input.location, timezone: input.timezone,
    starts_at: input.startsAt, duration_minutes: input.duration, seat_limit: input.seats,
    outcomes_json: JSON.stringify(input.outcomes), tags_json: JSON.stringify(input.tags), status: "scheduled", admin_notes: "",
    created_at: now, updated_at: now
  };
  const share = {share_id: newId("ws"), workshop_id: row.id, expires_at: workshopEndsAt(row), created_at: now};
  await db.batch([
    db.prepare("INSERT INTO sl_workshops (id, host_id, event_id, title, description, category, level, format, location, timezone, starts_at, duration_minutes, seat_limit, outcomes_json, tags_json, status, admin_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(row.id, row.host_id, row.event_id, row.title, row.description, row.category, row.level, row.format, row.location, row.timezone, row.starts_at, row.duration_minutes, row.seat_limit, row.outcomes_json, row.tags_json, row.status, row.admin_notes, row.created_at, row.updated_at),
    db.prepare("INSERT INTO sl_workshop_shares (share_id, workshop_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(share.share_id, share.workshop_id, share.expires_at, share.created_at),
    auditInsert(db, {actorId: viewer.id, targetId: row.id, action: "workshop_created", details: "Member published workshop " + row.title + ".", createdAt: now})
  ]);
  return apiResponse({ok: true, message: "Your workshop is published and ready for registrations.", event_id: row.event_id, workshop: await workshopView(db, row, viewer.id, 0, share)}, 201);
}

async function registerForWorkshop(request, env, workshopId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to reserve a workshop place."}, 401);
  const completionGate = profileCompletionGate(viewer, "workshops.html");
  if (completionGate) return completionGate;
  if (viewer.status !== "active") return apiResponse({error: "Your account cannot register for workshops right now."}, 403);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await db.prepare("SELECT * FROM sl_workshops WHERE id = ? AND status = 'scheduled' LIMIT 1").bind(workshopId).first();
  if (!row) return apiResponse({error: "That workshop is no longer available."}, 404);
  if (request.method === "POST" && new Date(row.starts_at).getTime() <= Date.now()) {
    return apiResponse({error: "Registration is closed because this workshop has started.", code: "workshop_registration_closed"}, 410);
  }
  const now = new Date().toISOString();
  if (request.method === "DELETE") {
    await db.prepare("UPDATE sl_workshop_registrations SET status = 'cancelled', updated_at = ? WHERE workshop_id = ? AND user_id = ?").bind(now, row.id, viewer.id).run();
    const count = await db.prepare("SELECT COUNT(*) AS count FROM sl_workshop_registrations WHERE workshop_id = ? AND status = 'registered'").bind(row.id).first();
    return apiResponse({ok: true, message: "Your workshop place has been cancelled.", workshop: await workshopView(db, row, viewer.id, Number(count?.count || 0))});
  }
  if (row.host_id === viewer.id) return apiResponse({error: "You are already hosting this workshop."}, 400);
  const existing = await db.prepare("SELECT * FROM sl_workshop_registrations WHERE workshop_id = ? AND user_id = ? LIMIT 1").bind(row.id, viewer.id).first();
  const count = await db.prepare("SELECT COUNT(*) AS count FROM sl_workshop_registrations WHERE workshop_id = ? AND status = 'registered'").bind(row.id).first();
  if (existing?.status !== "registered" && Number(count?.count || 0) >= Number(row.seat_limit || 0)) return apiResponse({error: "This workshop is full."}, 409);
  if (existing) {
    await db.prepare("UPDATE sl_workshop_registrations SET status = 'registered', updated_at = ? WHERE workshop_id = ? AND user_id = ?").bind(now, row.id, viewer.id).run();
  } else {
    await db.prepare("INSERT INTO sl_workshop_registrations (id, workshop_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, 'registered', ?, ?)").bind(newId("wreg"), row.id, viewer.id, now, now).run();
  }
  const updatedCount = existing && existing.status === "registered" ? Number(count?.count || 0) : Number(count?.count || 0) + 1;
  return apiResponse({ok: true, message: "Your place is reserved.", workshop: await workshopView(db, row, viewer.id, updatedCount)});
}

function directConversationPairKey(actorId, targetId) {
  return [String(actorId), String(targetId)].sort().join("::");
}

async function directConversationCandidates(db, actorId, targetId) {
  const result = await db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at
    FROM sl_conversations c
    WHERE c.kind = 'direct'
      AND (SELECT COUNT(*) FROM sl_conversation_members cm WHERE cm.conversation_id = c.id) = 2
      AND EXISTS (SELECT 1 FROM sl_conversation_members cm WHERE cm.conversation_id = c.id AND cm.user_id = ?)
      AND EXISTS (SELECT 1 FROM sl_conversation_members cm WHERE cm.conversation_id = c.id AND cm.user_id = ?)
    ORDER BY c.created_at ASC, c.id ASC
  `).bind(actorId, targetId).all();
  return result.results || [];
}

async function directConversationById(db, conversationId, actorId, targetId) {
  return db.prepare(`
    SELECT c.id
    FROM sl_conversations c
    WHERE c.id = ?
      AND c.kind = 'direct'
      AND (SELECT COUNT(*) FROM sl_conversation_members cm WHERE cm.conversation_id = c.id) = 2
      AND EXISTS (SELECT 1 FROM sl_conversation_members cm WHERE cm.conversation_id = c.id AND cm.user_id = ?)
      AND EXISTS (SELECT 1 FROM sl_conversation_members cm WHERE cm.conversation_id = c.id AND cm.user_id = ?)
  `).bind(conversationId, actorId, targetId).first();
}

async function mergeDirectConversations(db, canonicalId, duplicateIds) {
  const duplicates = [...new Set((duplicateIds || []).filter(id => id && id !== canonicalId))];
  if (!duplicates.length) return canonicalId;
  const allIds = [canonicalId, ...duplicates];
  const allPlaceholders = allIds.map(() => "?").join(", ");
  const duplicatePlaceholders = duplicates.map(() => "?").join(", ");
  const conversationResult = await db.prepare(`SELECT id, title, created_at, updated_at FROM sl_conversations WHERE id IN (${allPlaceholders})`).bind(...allIds).all();
  const conversationRows = conversationResult.results || [];
  const canonical = conversationRows.find(row => row.id === canonicalId);
  if (!canonical) return canonicalId;
  const memberResult = await db.prepare(`SELECT * FROM sl_conversation_members WHERE conversation_id IN (${allPlaceholders}) ORDER BY created_at ASC`).bind(...allIds).all();
  const memberRows = memberResult.results || [];
  const memberIds = [...new Set(memberRows.map(row => row.user_id).filter(Boolean))];
  const createdAt = conversationRows.map(row => row.created_at).filter(Boolean).sort()[0] || canonical.created_at;
  const updatedAt = conversationRows.map(row => row.updated_at || row.created_at).filter(Boolean).sort().at(-1) || createdAt;
  const title = conversationRows.map(row => String(row.title || "").trim()).find(Boolean) || "";
  const statements = [
    db.prepare(`UPDATE sl_messages SET conversation_id = ? WHERE conversation_id IN (${duplicatePlaceholders})`).bind(canonicalId, ...duplicates),
    db.prepare(`UPDATE sl_notifications SET entity_id = ? WHERE entity_id IN (${duplicatePlaceholders})`).bind(canonicalId, ...duplicates),
    db.prepare(`UPDATE sl_direct_conversations SET conversation_id = ? WHERE conversation_id IN (${duplicatePlaceholders})`).bind(canonicalId, ...duplicates),
    db.prepare("UPDATE sl_conversations SET title = ?, created_at = ?, updated_at = ? WHERE id = ?").bind(title, createdAt, updatedAt, canonicalId)
  ];
  memberIds.forEach(userId => {
    const states = memberRows.filter(row => row.user_id === userId);
    const canonicalState = states.find(row => row.conversation_id === canonicalId);
    const role = canonicalState?.role || states[0]?.role || "member";
    const created = states.map(row => row.created_at).filter(Boolean).sort()[0] || createdAt;
    const hidden = states.length > 0 && states.every(row => Boolean(row.hidden)) ? 1 : 0;
    const muted = states.some(row => Boolean(row.muted)) ? 1 : 0;
    const lastReadAt = states.map(row => row.last_read_at).filter(Boolean).sort().at(-1) || null;
    if (canonicalState) {
      statements.push(db.prepare("UPDATE sl_conversation_members SET role = ?, muted = ?, hidden = ?, last_read_at = ? WHERE conversation_id = ? AND user_id = ?").bind(role, muted, hidden, lastReadAt, canonicalId, userId));
    } else {
      statements.push(db.prepare("INSERT OR IGNORE INTO sl_conversation_members (conversation_id, user_id, role, muted, hidden, last_read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(canonicalId, userId, role, muted, hidden, lastReadAt, created));
    }
  });
  statements.push(db.prepare(`DELETE FROM sl_conversation_members WHERE conversation_id IN (${duplicatePlaceholders})`).bind(...duplicates));
  statements.push(db.prepare(`DELETE FROM sl_conversations WHERE id IN (${duplicatePlaceholders})`).bind(...duplicates));
  await db.batch(statements);
  return canonicalId;
}

async function directConversation(db, actorId, targetId, {reopenForActor = true} = {}) {
  const pairKey = directConversationPairKey(actorId, targetId);
  let mapped = await db.prepare("SELECT conversation_id FROM sl_direct_conversations WHERE pair_key = ? LIMIT 1").bind(pairKey).first();
  let canonicalId = "";
  if (mapped?.conversation_id && await directConversationById(db, mapped.conversation_id, actorId, targetId)) {
    canonicalId = mapped.conversation_id;
  } else if (mapped?.conversation_id) {
    await db.prepare("DELETE FROM sl_direct_conversations WHERE pair_key = ?").bind(pairKey).run();
    mapped = null;
  }
  let candidates = await directConversationCandidates(db, actorId, targetId);
  if (!canonicalId) canonicalId = candidates[0]?.id || "";
  if (!canonicalId) {
    const now = new Date().toISOString();
    const newConversationId = newId("conv");
    await db.batch([
      db.prepare("INSERT INTO sl_conversations (id, kind, title, created_by, metadata_json, created_at, updated_at) VALUES (?, 'direct', '', ?, '{}', ?, ?)").bind(newConversationId, actorId, now, now),
      db.prepare("INSERT INTO sl_conversation_members (conversation_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(newConversationId, actorId, now),
      db.prepare("INSERT INTO sl_conversation_members (conversation_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(newConversationId, targetId, now),
      db.prepare("INSERT OR IGNORE INTO sl_direct_conversations (pair_key, conversation_id) VALUES (?, ?)").bind(pairKey, newConversationId)
    ]);
    mapped = await db.prepare("SELECT conversation_id FROM sl_direct_conversations WHERE pair_key = ? LIMIT 1").bind(pairKey).first();
    canonicalId = mapped?.conversation_id || newConversationId;
    if (canonicalId !== newConversationId) await mergeDirectConversations(db, canonicalId, [newConversationId]);
  } else {
    await db.prepare("INSERT OR IGNORE INTO sl_direct_conversations (pair_key, conversation_id) VALUES (?, ?)").bind(pairKey, canonicalId).run();
    mapped = await db.prepare("SELECT conversation_id FROM sl_direct_conversations WHERE pair_key = ? LIMIT 1").bind(pairKey).first();
    if (mapped?.conversation_id && mapped.conversation_id !== canonicalId) {
      await mergeDirectConversations(db, mapped.conversation_id, [canonicalId]);
      canonicalId = mapped.conversation_id;
    }
  }
  candidates = await directConversationCandidates(db, actorId, targetId);
  const duplicateIds = candidates.map(row => row.id).filter(id => id !== canonicalId);
  if (duplicateIds.length) await mergeDirectConversations(db, canonicalId, duplicateIds);
  if (reopenForActor) await db.prepare("UPDATE sl_conversation_members SET hidden = 0 WHERE conversation_id = ? AND user_id = ?").bind(canonicalId, actorId).run();
  return canonicalId;
}

async function consolidateDirectConversations(db, viewerId) {
  const result = await db.prepare("SELECT DISTINCT c.id FROM sl_conversations c INNER JOIN sl_conversation_members cm ON cm.conversation_id = c.id WHERE c.kind = 'direct' AND cm.user_id = ?").bind(viewerId).all();
  for (const row of result.results || []) {
    const membersResult = await db.prepare("SELECT user_id FROM sl_conversation_members WHERE conversation_id = ?").bind(row.id).all();
    const memberIds = (membersResult.results || []).map(member => member.user_id).filter(memberId => memberId !== viewerId);
    if (memberIds.length === 1 && (membersResult.results || []).length === 2) {
      await directConversation(db, viewerId, memberIds[0], {reopenForActor: false});
    }
  }
}

function messageBodyFromRow(row) {
  const metadata = parseJson(row.metadata_json, {});
  return {
    id: row.id, conversation_id: row.conversation_id, sender_id: row.sender_id, body: row.body,
    metadata, moderation_status: row.moderation_status || "visible",
    pinned: Boolean(row.pinned), created_at: row.created_at, updated_at: row.updated_at
  };
}

async function messageView(db, row, viewerId, memberCache = null) {
  const message = messageBodyFromRow(row);
  if (isObject(message.metadata?.attachment)) message.attachment = message.metadata.attachment;
  if (row.sender_id) {
    const senderRow = memberCache ? (memberCache.get(String(row.sender_id)) || null) : await findUserById(db, row.sender_id);
    if (senderRow) {
    const parts = rowParts(senderRow);
      const senderView = commonPublicFields(senderRow, parts.profile, parts.preferences, parts.safety, viewerId);
      message.sender = {...senderView, display_name: senderView.profile?.display_name || senderRow.username, profile_color: senderView.profile?.profile_color || "indigo", avatar_url: senderView.profile?.avatar_url || "", role: senderRow.role};
      message.sender_kind = senderRow.role === "admin" ? "admin" : "member";
    }
  }
  if (message.metadata?.type === "calendar_event") message.sender_kind = "system";
  return message;
}

async function conversationAccess(db, conversationId, viewerId, includeHidden = false) {
  const hiddenClause = includeHidden ? "" : " AND cm.hidden = 0";
  return db.prepare(`SELECT c.*, cm.role AS member_role, cm.muted, cm.hidden, cm.last_read_at
    FROM sl_conversations c
    INNER JOIN sl_conversation_members cm ON cm.conversation_id = c.id
    WHERE c.id = ? AND cm.user_id = ?${hiddenClause} LIMIT 1`).bind(conversationId, viewerId).first();
}

async function conversationMessages(db, conversationId, viewerId, limit = 200) {
  const [result, senderResult] = await db.batch([
    db.prepare(`SELECT m.* FROM sl_messages m
      WHERE m.conversation_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sl_message_visibility mv
          WHERE mv.message_id = m.id AND mv.user_id = ? AND mv.hidden = 1
        )
      ORDER BY m.created_at ASC LIMIT ?`).bind(conversationId, viewerId, limit),
    db.prepare("SELECT * FROM sl_users WHERE id IN (SELECT DISTINCT sender_id FROM sl_messages WHERE conversation_id = ? AND sender_id IS NOT NULL)").bind(conversationId)
  ]);
  const rows = result.results || [];
  const memberCache = new Map();
  (senderResult.results || []).forEach(member => memberCache.set(String(member.id), member));
  const messages = [];
  for (const message of rows) messages.push(await messageView(db, message, viewerId, memberCache));
  return messages;
}

async function blockedConversationMember(db, viewerId, memberId) {
  if (!viewerId || !memberId || viewerId === memberId) return false;
  const row = await db.prepare(`SELECT 1 FROM sl_blocks
    WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
    LIMIT 1`).bind(viewerId, memberId, memberId, viewerId).first();
  return Boolean(row);
}

async function conversationSummary(db, row, viewerId, memberRows, context = {}) {
  const userCache = context.userCache || null;
  const members = [];
  for (const member of memberRows.filter(item => item.user_id !== viewerId)) {
    const memberId = String(member.user_id || "");
    const memberRow = userCache && userCache.has(memberId) ? userCache.get(memberId) : await findUserById(db, memberId);
    if (!memberRow) continue;
    const parts = rowParts(memberRow);
    members.push({...commonPublicFields(memberRow, parts.profile, parts.preferences, parts.safety, viewerId), role: memberRow.role});
  }
  const hasLatestMessage = Object.prototype.hasOwnProperty.call(context, "latestMessage");
  const hasLatestRow = Object.prototype.hasOwnProperty.call(context, "latestRow");
  const latestRow = hasLatestMessage ? null : hasLatestRow ? context.latestRow : await db.prepare(`SELECT m.* FROM sl_messages m
    WHERE m.conversation_id = ?
      AND NOT EXISTS (SELECT 1 FROM sl_message_visibility mv WHERE mv.message_id = m.id AND mv.user_id = ? AND mv.hidden = 1)
    ORDER BY m.created_at DESC LIMIT 1`).bind(row.id, viewerId).first();
  const membership = memberRows.find(item => item.user_id === viewerId);
  const unreadCount = Object.prototype.hasOwnProperty.call(context, "unreadCount") ? Number(context.unreadCount || 0) : Number((membership?.last_read_at
    ? await db.prepare(`SELECT COUNT(*) AS count FROM sl_messages m
      WHERE m.conversation_id = ? AND m.sender_id != ? AND m.created_at > ?
        AND NOT EXISTS (SELECT 1 FROM sl_message_visibility mv WHERE mv.message_id = m.id AND mv.user_id = ? AND mv.hidden = 1)`).bind(row.id, viewerId, membership.last_read_at, viewerId).first()
    : await db.prepare(`SELECT COUNT(*) AS count FROM sl_messages m
      WHERE m.conversation_id = ? AND m.sender_id != ?
        AND NOT EXISTS (SELECT 1 FROM sl_message_visibility mv WHERE mv.message_id = m.id AND mv.user_id = ? AND mv.hidden = 1)`).bind(row.id, viewerId, viewerId).first())?.count || 0);
  const member = members[0];
  const metadata = parseJson(row.metadata_json, {});
  const group = Object.prototype.hasOwnProperty.call(context, "group") ? context.group : row.kind === "group" ? await db.prepare("SELECT * FROM sl_community_groups WHERE conversation_id = ? LIMIT 1").bind(row.id).first() : null;
  const groupAdminIds = Object.prototype.hasOwnProperty.call(context, "groupAdminIds") ? context.groupAdminIds : group ? (await db.prepare("SELECT user_id FROM sl_community_group_members WHERE group_id = ? AND status = 'active' AND role IN ('admin', 'moderator')").bind(group.id).all()).results.map(item => item.user_id) : [];
  const blocked = Object.prototype.hasOwnProperty.call(context, "blocked") ? Boolean(context.blocked) : row.kind === "direct" && member ? await blockedConversationMember(db, viewerId, member.id) : false;
  let event = Object.prototype.hasOwnProperty.call(context, "event") ? context.event : null;
  if (!Object.prototype.hasOwnProperty.call(context, "event") && metadata.event_id) event = await appRecord(db, "events", safeText(metadata.event_id, 120));
  return {
    id: row.id, kind: row.kind, title: row.title || member?.profile?.display_name || member?.username || "SwapLabs conversation",
    subtitle: row.kind === "direct" && member ? "Private member conversation" : "SwapLabs conversation", members,
    latest_message: hasLatestMessage ? context.latestMessage : latestRow ? await messageView(db, latestRow, viewerId, userCache) : null, unread_count: unreadCount,
    group_id: group?.id || "", description: group?.description || metadata.description || "",
    group_admin_ids: groupAdminIds,
    viewer_is_group_admin: Boolean(group && (groupAdminIds.includes(viewerId) || ["admin", "moderator"].includes(membership?.member_role || membership?.role))),
    blocked, muted: Boolean(membership?.muted), event: event || null,
    created_at: row.created_at, updated_at: row.updated_at
  };
}

async function inbox(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to open your inbox."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  // Direct conversations are normalized when they are created or reopened.
  // Running a member-by-member consolidation scan on every Inbox refresh made
  // a read-heavy page perform a write-heavy N+1 query sequence first.
  // Keep the read-heavy inbox to one D1 batch. The previous implementation
  // issued a member lookup, latest-message lookup, unread-count lookup, and
  // user lookup for every conversation, which made latency grow with every
  // chat in the account.
  const batch = await db.batch([
    db.prepare("SELECT c.*, cm.user_id, cm.role AS member_role, cm.muted, cm.hidden, cm.last_read_at FROM sl_conversations c INNER JOIN sl_conversation_members cm ON cm.conversation_id = c.id WHERE cm.user_id = ? AND cm.hidden = 0 ORDER BY c.updated_at DESC").bind(viewer.id),
    // The compose directory is loaded on demand. The first inbox paint only
    // needs profiles that belong to one of the viewer's conversations.
    db.prepare("SELECT * FROM sl_users WHERE id IN (SELECT DISTINCT cm.user_id FROM sl_conversation_members cm INNER JOIN sl_conversation_members viewer_cm ON viewer_cm.conversation_id = cm.conversation_id AND viewer_cm.user_id = ? AND viewer_cm.hidden = 0)").bind(viewer.id),
    db.prepare("SELECT cm.* FROM sl_conversation_members cm INNER JOIN sl_conversation_members viewer_cm ON viewer_cm.conversation_id = cm.conversation_id WHERE viewer_cm.user_id = ? AND viewer_cm.hidden = 0").bind(viewer.id),
    db.prepare(`SELECT * FROM (
      SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at DESC, m.id DESC) AS row_number
      FROM sl_messages m
      INNER JOIN sl_conversation_members viewer_cm ON viewer_cm.conversation_id = m.conversation_id AND viewer_cm.user_id = ? AND viewer_cm.hidden = 0
      WHERE NOT EXISTS (SELECT 1 FROM sl_message_visibility mv WHERE mv.message_id = m.id AND mv.user_id = ? AND mv.hidden = 1)
    ) latest WHERE latest.row_number = 1`).bind(viewer.id, viewer.id),
    db.prepare(`SELECT m.conversation_id, COUNT(*) AS count
      FROM sl_messages m
      INNER JOIN sl_conversation_members viewer_cm ON viewer_cm.conversation_id = m.conversation_id AND viewer_cm.user_id = ? AND viewer_cm.hidden = 0
      WHERE m.sender_id != ?
        AND (viewer_cm.last_read_at IS NULL OR m.created_at > viewer_cm.last_read_at)
        AND NOT EXISTS (SELECT 1 FROM sl_message_visibility mv WHERE mv.message_id = m.id AND mv.user_id = ? AND mv.hidden = 1)
      GROUP BY m.conversation_id`).bind(viewer.id, viewer.id, viewer.id),
    db.prepare("SELECT * FROM sl_follows WHERE following_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 100").bind(viewer.id),
    db.prepare("SELECT g.* FROM sl_community_groups g INNER JOIN sl_conversation_members cm ON cm.conversation_id = g.conversation_id AND cm.user_id = ? AND cm.hidden = 0").bind(viewer.id),
    db.prepare("SELECT gm.group_id, gm.user_id FROM sl_community_group_members gm INNER JOIN sl_community_groups g ON g.id = gm.group_id INNER JOIN sl_conversation_members cm ON cm.conversation_id = g.conversation_id AND cm.user_id = ? AND cm.hidden = 0 WHERE gm.status = 'active' AND gm.role IN ('admin', 'moderator')").bind(viewer.id),
    db.prepare("SELECT blocker_id, blocked_id FROM sl_blocks WHERE blocker_id = ? OR blocked_id = ?").bind(viewer.id, viewer.id),
    db.prepare(`SELECT ar.* FROM sl_app_records ar
      WHERE ar.collection = 'events'
        AND ar.record_id IN (
          SELECT json_extract(c.metadata_json, '$.event_id')
          FROM sl_conversations c
          INNER JOIN sl_conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.hidden = 0
          WHERE json_extract(c.metadata_json, '$.event_id') IS NOT NULL
        )`).bind(viewer.id)
  ]);
  const [conversationResult, userResult, membersResult, latestResult, unreadResult, pendingResult, groupResult, groupAdminResult, blockResult, eventResult] = batch;
  const conversationRows = conversationResult.results || [];
  const userRows = userResult.results || [];
  const userCache = new Map(userRows.map(row => [String(row.id), row]));
  const membersByConversation = new Map();
  (membersResult.results || []).forEach(member => {
    const list = membersByConversation.get(String(member.conversation_id)) || [];
    list.push(member);
    membersByConversation.set(String(member.conversation_id), list);
  });
  const latestByConversation = new Map((latestResult.results || []).map(message => [String(message.conversation_id), message]));
  const unreadByConversation = new Map((unreadResult.results || []).map(item => [String(item.conversation_id), Number(item.count || 0)]));
  const groupByConversation = new Map((groupResult.results || []).map(group => [String(group.conversation_id), group]));
  const groupAdminIdsByGroup = new Map();
  (groupAdminResult.results || []).forEach(item => {
    const list = groupAdminIdsByGroup.get(String(item.group_id)) || [];
    list.push(item.user_id);
    groupAdminIdsByGroup.set(String(item.group_id), list);
  });
  const blockRows = blockResult.results || [];
  const eventById = new Map((eventResult.results || []).map(record => [String(record.record_id), parseJson(record.record_json, null)]));
  const summaries = await Promise.all(conversationRows.map(row => {
    const metadata = parseJson(row.metadata_json, {});
    const memberRows = membersByConversation.get(String(row.id)) || [];
    const memberId = memberRows.find(item => item.user_id !== viewer.id)?.user_id || "";
    const blocked = row.kind === "direct" && memberId ? blockRows.some(item =>
      (item.blocker_id === viewer.id && item.blocked_id === memberId) ||
      (item.blocker_id === memberId && item.blocked_id === viewer.id)
    ) : false;
    const group = groupByConversation.get(String(row.id)) || null;
    return conversationSummary(db, row, viewer.id, memberRows, {
      userCache,
      latestRow: latestByConversation.get(String(row.id)) || null,
      unreadCount: unreadByConversation.get(String(row.id)) || 0,
      group,
      groupAdminIds: group ? groupAdminIdsByGroup.get(String(group.id)) || [] : [],
      blocked,
      event: metadata.event_id ? eventById.get(String(safeText(metadata.event_id, 120))) || null : null
    });
  }));
  const contacts = [];
  const incoming_requests = [];
  for (const follow of pendingResult.results || []) {
    const requestView = await followRequestView(db, follow, viewer.id, userCache);
    if (requestView) incoming_requests.push(requestView);
  }
  const unread_count = summaries.reduce((sum, item) => sum + item.unread_count, 0);
  return apiResponse({conversations: summaries, contacts, incoming_requests, unread_count});
}

async function inboxContacts(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to view available contacts."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const result = await db.prepare("SELECT * FROM sl_users WHERE id != ? AND role = 'member' AND status = 'active' ORDER BY created_at DESC").bind(viewer.id).all();
  const contacts = (result.results || []).map(row => {
    const parts = rowParts(row);
    return {...commonPublicFields(row, parts.profile, parts.preferences, parts.safety, viewer.id), display_name: parts.profile.display_name || completeName(parts.profile, row.username)};
  }).filter(contact => contact.visibility === "public");
  return apiResponse({contacts});
}

async function conversationDetail(request, env, conversationId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to open this conversation."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  // Resolve the conversation, members, messages, senders, and read state in
  // one D1 batch. Opening a chat used to add several serial round trips after
  // the inbox itself had already loaded.
  const [accessResult, membersResult, memberUsersResult, messageResult, senderResult, unreadResult, blockedResult, groupResult, groupAdminResult, eventResult] = await db.batch([
    db.prepare(`SELECT c.*, cm.role AS member_role, cm.muted, cm.hidden, cm.last_read_at
      FROM sl_conversations c
      INNER JOIN sl_conversation_members cm ON cm.conversation_id = c.id
      WHERE c.id = ? AND cm.user_id = ? AND cm.hidden = 0 LIMIT 1`).bind(conversationId, viewer.id),
    db.prepare("SELECT * FROM sl_conversation_members WHERE conversation_id = ?").bind(conversationId),
    db.prepare("SELECT u.* FROM sl_users u INNER JOIN sl_conversation_members cm ON cm.user_id = u.id WHERE cm.conversation_id = ?").bind(conversationId),
    db.prepare(`SELECT m.* FROM sl_messages m
      WHERE m.conversation_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sl_message_visibility mv
          WHERE mv.message_id = m.id AND mv.user_id = ? AND mv.hidden = 1
        )
      ORDER BY m.created_at ASC LIMIT 200`).bind(conversationId, viewer.id),
    db.prepare("SELECT * FROM sl_users WHERE id IN (SELECT DISTINCT sender_id FROM sl_messages WHERE conversation_id = ? AND sender_id IS NOT NULL)").bind(conversationId),
    db.prepare(`SELECT COUNT(*) AS count FROM sl_messages m
      INNER JOIN sl_conversation_members viewer_cm ON viewer_cm.conversation_id = m.conversation_id AND viewer_cm.user_id = ?
      WHERE m.conversation_id = ? AND m.sender_id != ?
        AND (viewer_cm.last_read_at IS NULL OR m.created_at > viewer_cm.last_read_at)
        AND NOT EXISTS (SELECT 1 FROM sl_message_visibility mv WHERE mv.message_id = m.id AND mv.user_id = ? AND mv.hidden = 1)`).bind(viewer.id, conversationId, viewer.id, viewer.id),
    db.prepare(`SELECT 1 FROM sl_blocks b
      INNER JOIN sl_conversation_members peer ON peer.conversation_id = ? AND peer.user_id != ?
      WHERE (b.blocker_id = ? AND b.blocked_id = peer.user_id) OR (b.blocker_id = peer.user_id AND b.blocked_id = ?)
      LIMIT 1`).bind(conversationId, viewer.id, viewer.id, viewer.id),
    db.prepare("SELECT * FROM sl_community_groups WHERE conversation_id = ? LIMIT 1").bind(conversationId),
    db.prepare("SELECT gm.user_id FROM sl_community_group_members gm INNER JOIN sl_community_groups g ON g.id = gm.group_id WHERE g.conversation_id = ? AND gm.status = 'active' AND gm.role IN ('admin', 'moderator')").bind(conversationId),
    db.prepare("SELECT ar.record_json FROM sl_app_records ar WHERE ar.collection = 'events' AND ar.record_id = (SELECT json_extract(metadata_json, '$.event_id') FROM sl_conversations WHERE id = ?) LIMIT 1").bind(conversationId)
  ]);
  const row = accessResult.results?.[0] || null;
  if (!row) return apiResponse({error: "That conversation is not available."}, 404);
  const userCache = new Map((memberUsersResult.results || []).map(member => [String(member.id), member]));
  (senderResult.results || []).forEach(sender => userCache.set(String(sender.id), sender));
  const messages = [];
  for (const message of messageResult.results || []) messages.push(await messageView(db, message, viewer.id, userCache));
  const memberRows = membersResult.results || [];
  // Opening a conversation is the read action. Persist that state while the
  // detail request is already in flight so the client does not need a second
  // round trip (and cannot repaint an old unread badge after the chat opens).
  // D1 batch SELECT results expose rows under `results`. Reading
  // `unreadResult.count` always produced zero, so the UI could open a chat
  // successfully while the member's read watermark was never persisted.
  const unreadCount = Number(unreadResult?.results?.[0]?.count || 0);
  if (unreadCount > 0) {
    await db.prepare("UPDATE sl_conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?")
      .bind(new Date().toISOString(), conversationId, viewer.id).run();
  }
  const conversation = await conversationSummary(db, row, viewer.id, memberRows, {
    userCache,
    latestMessage: messages.at(-1) || null,
    unreadCount: 0,
    blocked: Boolean(blockedResult.results?.[0]),
    group: groupResult.results?.[0] || null,
    groupAdminIds: (groupAdminResult.results || []).map(item => item.user_id),
    event: eventResult.results?.[0] ? parseJson(eventResult.results[0].record_json, null) : null
  });
  return apiResponse({conversation, messages, typing_users: [], shared_content: {posts: [], ideas: [], workshops: []}});
}

async function conversationContent(request, env, conversationId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to open shared conversation content."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await conversationAccess(db, conversationId, viewer.id);
  if (!row) return apiResponse({error: "That conversation is not available."}, 404);
  const messages = await conversationMessages(db, row.id, viewer.id, 500);
  const media = [];
  const files = [];
  const links = [];
  messages.forEach(message => {
    const attachment = message.attachment;
    if (attachment?.url) {
      const item = {url: attachment.url, preview_url: attachment.url, name: attachment.name || "Attachment", mime: attachment.mime || "application/octet-stream", size: Number(attachment.size || 0), sender: message.sender || null, created_at: message.created_at};
      if (String(item.mime).startsWith("image/") || String(item.mime).startsWith("video/")) media.push(item);
      else files.push(item);
    }
    const foundLinks = String(message.body || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
    foundLinks.forEach(url => links.push({url: url.replace(/[),.;!?]+$/, ""), sender: message.sender || null, created_at: message.created_at}));
  });
  const membersResult = await db.prepare("SELECT * FROM sl_conversation_members WHERE conversation_id = ?").bind(row.id).all();
  return apiResponse({content: {media, files, links, counts: {media: media.length, files: files.length, links: links.length}}, conversation: await conversationSummary(db, row, viewer.id, membersResult.results || [])});
}

async function markConversationRead(request, env, conversationId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to update this conversation."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const now = new Date().toISOString();
  const row = await conversationAccess(db, conversationId, viewer.id);
  if (!row) return apiResponse({error: "That conversation is not available."}, 404);
  await db.prepare("UPDATE sl_conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?").bind(now, conversationId, viewer.id).run();
  return apiResponse({ok: true, conversation_id: conversationId, unread_count: 0});
}

async function hideConversationHistory(db, conversationId, viewerId) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT OR REPLACE INTO sl_message_visibility (message_id, user_id, hidden, created_at)
    SELECT id, ?, 1, ? FROM sl_messages WHERE conversation_id = ?`).bind(viewerId, now, conversationId).run();
}

async function muteConversation(request, env, conversationId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to update this conversation."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await conversationAccess(db, conversationId, viewer.id);
  if (!row) return apiResponse({error: "That conversation is not available."}, 404);
  const body = await readJson(request);
  await db.prepare("UPDATE sl_conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?").bind(body.muted === false ? 0 : 1, conversationId, viewer.id).run();
  const membersResult = await db.prepare("SELECT * FROM sl_conversation_members WHERE conversation_id = ?").bind(conversationId).all();
  return apiResponse({ok: true, conversation: await conversationSummary(db, row, viewer.id, membersResult.results || [])});
}

async function clearConversationHistory(request, env, conversationId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to clear this conversation."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await conversationAccess(db, conversationId, viewer.id);
  if (!row) return apiResponse({error: "That conversation is not available."}, 404);
  await hideConversationHistory(db, conversationId, viewer.id);
  return apiResponse({message: "Conversation history cleared for you.", conversation_id: conversationId});
}

async function deleteConversation(request, env, conversationId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to delete this conversation."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await conversationAccess(db, conversationId, viewer.id);
  if (!row) return apiResponse({error: "That conversation is not available."}, 404);
  await db.batch([
    db.prepare("UPDATE sl_conversation_members SET hidden = 1 WHERE conversation_id = ? AND user_id = ?").bind(conversationId, viewer.id),
    db.prepare(`INSERT OR REPLACE INTO sl_message_visibility (message_id, user_id, hidden, created_at)
      SELECT id, ?, 1, ? FROM sl_messages WHERE conversation_id = ?`).bind(viewer.id, new Date().toISOString(), conversationId)
  ]);
  return apiResponse({message: "Chat deleted from your Inbox.", conversation_id: conversationId});
}

async function pinConversationMessage(request, env, conversationId, messageId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to pin messages."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const row = await conversationAccess(db, conversationId, viewer.id);
  if (!row) return apiResponse({error: "That conversation is not available."}, 404);
  const memberRows = await db.prepare("SELECT * FROM sl_conversation_members WHERE conversation_id = ?").bind(conversationId).all();
  const group = row.kind === "group" ? await db.prepare("SELECT id FROM sl_community_groups WHERE conversation_id = ? LIMIT 1").bind(conversationId).first() : null;
  const admin = viewer.role === "admin" || Boolean(group && (await db.prepare("SELECT 1 FROM sl_community_group_members WHERE group_id = ? AND user_id = ? AND status = 'active' AND role IN ('admin', 'moderator') LIMIT 1").bind(group.id, viewer.id).first())) || ["admin", "moderator"].includes(memberRows.results?.find(item => item.user_id === viewer.id)?.role);
  if (!admin) return apiResponse({error: "Only group admins can pin messages."}, 403);
  const body = await readJson(request);
  const pinned = body.pinned !== false;
  const result = await db.prepare("UPDATE sl_messages SET pinned = ?, updated_at = ? WHERE id = ? AND conversation_id = ?").bind(pinned ? 1 : 0, new Date().toISOString(), messageId, conversationId).run();
  if (!Number(result?.meta?.changes || 0)) return apiResponse({error: "That message is no longer available."}, 404);
  const messageRow = await db.prepare("SELECT * FROM sl_messages WHERE id = ? LIMIT 1").bind(messageId).first();
  return apiResponse({ok: true, notice: pinned ? "Message pinned." : "Message unpinned.", message: await messageView(db, messageRow, viewer.id)});
}

async function blockConversationUser(request, env, memberId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to manage blocked members."}, 401);
  if (!memberId || memberId === viewer.id) return apiResponse({error: "Choose another member."}, 400);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  if (request.method === "DELETE") {
    await db.prepare("DELETE FROM sl_blocks WHERE blocker_id = ? AND blocked_id = ?").bind(viewer.id, memberId).run();
    return apiResponse({ok: true, message: "Member unblocked."});
  }
  const body = await readJson(request);
  if (body.blocked === false) {
    await db.prepare("DELETE FROM sl_blocks WHERE blocker_id = ? AND blocked_id = ?").bind(viewer.id, memberId).run();
    return apiResponse({ok: true, message: "Member unblocked."});
  }
  await db.prepare("INSERT OR REPLACE INTO sl_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)").bind(viewer.id, memberId, new Date().toISOString()).run();
  return apiResponse({ok: true, message: "Member blocked."});
}

async function createConversation(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before starting a conversation."}, 401);
  const body = await readJson(request);
  const targetId = safeText(body.target_user_id, 100);
  if (!targetId || targetId === viewer.id) return apiResponse({error: "Choose another active member."}, 400);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const target = await findUserById(db, targetId);
  if (!target || target.role !== "member" || target.status !== "active") return apiResponse({error: "That member is not available."}, 404);
  if (rowParts(viewer).safety.is_minor || rowParts(target).safety.is_minor) {
    return apiResponse({error: "Direct member messaging is disabled for student accounts."}, 403);
  }
  const id = await directConversation(db, viewer.id, target.id);
  const row = await db.prepare("SELECT * FROM sl_conversations WHERE id = ?").bind(id).first();
  const membersResult = await db.prepare("SELECT * FROM sl_conversation_members WHERE conversation_id = ?").bind(id).all();
  return apiResponse({ok: true, conversation: await conversationSummary(db, row, viewer.id, membersResult.results || [])});
}

async function createSwapRequest(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before requesting a skill swap."}, 401);
  const body = await readJson(request);
  const targetId = safeText(body.target_user_id, 100);
  const skill = safeText(body.skill, 160);
  const offer = safeText(body.offer, 160);
  if (!targetId || targetId === viewer.id) return apiResponse({error: "Choose another active member for your swap request."}, 400);
  if (!skill) return apiResponse({error: "Choose the skill you want to learn before sending the request."}, 400);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const target = await findUserById(db, targetId);
  if (!target || target.role !== "member" || target.status !== "active") return apiResponse({error: "That member is not available."}, 404);
  if (rowParts(viewer).safety.is_minor || rowParts(target).safety.is_minor) {
    return apiResponse({error: "Skill-swap requests are unavailable for student accounts."}, 403);
  }
  const targetParts = rowParts(target);
  const viewerParts = rowParts(viewer);
  const targetName = targetParts.profile.display_name || completeName(targetParts.profile, target.username);
  const viewerName = viewerParts.profile.display_name || completeName(viewerParts.profile, viewer.username);
  const conversationId = await directConversation(db, viewer.id, target.id);
  const now = new Date().toISOString();
  const messageBody = `Hi ${targetName}! I’d like to learn ${skill}${offer ? ` and can offer ${offer} in return` : ""}. Would you be open to a skill swap?`;
  const messageId = newId("msg");
  await db.batch([
    db.prepare("INSERT INTO sl_messages (id, conversation_id, sender_id, body, metadata_json, moderation_status, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'visible', 0, ?, ?)").bind(messageId, conversationId, viewer.id, messageBody, JSON.stringify({type: "swap_request", skill, offer, sender_name: viewerName}), now, now),
    db.prepare("UPDATE sl_conversations SET updated_at = ? WHERE id = ?").bind(now, conversationId),
    db.prepare("INSERT INTO sl_audit_log (id, actor_id, target_id, action, details, created_at) VALUES (?, ?, ?, 'swap_requested', ?, ?)").bind(newId("audit"), viewer.id, target.id, `Requested a swap with ${targetName} to learn ${skill}.`, now)
  ]);
  const conversationRow = await db.prepare("SELECT * FROM sl_conversations WHERE id = ?").bind(conversationId).first();
  const membersResult = await db.prepare("SELECT * FROM sl_conversation_members WHERE conversation_id = ?").bind(conversationId).all();
  return apiResponse({ok: true, message: "Your skill-swap request was sent.", conversation: await conversationSummary(db, conversationRow, viewer.id, membersResult.results || [])}, 201);
}

async function sendConversationMessage(request, env, conversationId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before sending a message."}, 401);
  if (viewer.role !== "admin" && rowParts(viewer).safety.is_minor) return apiResponse({error: "Direct member messaging is disabled for student accounts."}, 403);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const membership = await conversationAccess(db, conversationId, viewer.id);
  if (!membership) return apiResponse({error: "That conversation is not available."}, 404);
  const peer = membership.kind === "direct" ? await db.prepare("SELECT user_id FROM sl_conversation_members WHERE conversation_id = ? AND user_id != ? LIMIT 1").bind(conversationId, viewer.id).first() : null;
  if (peer?.user_id && await blockedConversationMember(db, viewer.id, peer.user_id)) return apiResponse({error: "Messaging is blocked between these members."}, 403);
  let body = {};
  let attachment = null;
  const type = request.headers.get("content-type") || "";
  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    body.body = form.get("body");
    const file = form.get("attachment");
    if (file && typeof file.arrayBuffer === "function") {
      const mime = safeText(file.type, 120).toLowerCase();
      const name = safeText(file.name, 160) || "attachment";
      const size = Number(file.size || 0);
      if (!mime || size <= 0 || size > 2_500_000) return apiResponse({error: "Attachments must be smaller than 2.5 MB."}, 400);
      const extension = mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
      const messageId = newId("msg");
      if (!env || !env.BUCKET) return apiResponse({error: "Chat attachment storage is temporarily unavailable. Please try again shortly."}, 503);
      const key = `uploads/${messageId}.${extension}`;
      await env.BUCKET.put(key, await file.arrayBuffer(), {httpMetadata: {contentType: mime, cacheControl: "private, no-store"}});
      attachment = {url: "/" + key, name, mime, size, key};
    }
  } else body = await readJson(request);
  const text = safeText(body.body, 4000);
  if (!text && !attachment) return apiResponse({error: "Write a message before sending."}, 400);
  const now = new Date().toISOString();
  const id = attachment?.key ? attachment.key.split("/").pop().split(".")[0] : newId("msg");
  const metadata = attachment ? {attachment} : {};
  const memberRows = await db.prepare("SELECT user_id FROM sl_conversation_members WHERE conversation_id = ? AND user_id != ?").bind(conversationId, viewer.id).all();
  const viewerParts = rowParts(viewer);
  const senderName = viewerParts.profile.display_name || completeName(viewerParts.profile, viewer.username);
  const notificationStatements = (memberRows.results || []).map(member => db.prepare("INSERT INTO sl_notifications (id, user_id, actor_id, type, entity_id, message, read, created_at) VALUES (?, ?, ?, 'message', ?, ?, 0, ?)").bind(newId("notif"), member.user_id, viewer.id, conversationId, `${senderName} sent you a message.`, now));
  await db.batch([
    db.prepare("INSERT INTO sl_messages (id, conversation_id, sender_id, body, metadata_json, moderation_status, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'visible', 0, ?, ?)").bind(id, conversationId, viewer.id, text, JSON.stringify(metadata), now, now),
    db.prepare("UPDATE sl_conversations SET updated_at = ? WHERE id = ?").bind(now, conversationId),
    ...notificationStatements
  ]);
  const messageRow = await db.prepare("SELECT * FROM sl_messages WHERE id = ? LIMIT 1").bind(id).first();
  return apiResponse({ok: true, notice: "Message sent.", message_id: id, message: await messageView(db, messageRow, viewer.id)});
}

async function createNotification(db, data) {
  await db.prepare("INSERT INTO sl_notifications (id, user_id, actor_id, type, entity_id, message, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)")
    .bind(newId("notif"), data.userId, data.actorId || null, data.type, data.entityId || null, safeText(data.message, 300), data.createdAt || new Date().toISOString()).run();
}

async function notificationView(db, row, viewerId, snapshot = null, userCache = null) {
  let actor = null;
  if (row.actor_id) {
    const actorRow = userCache && userCache.has(String(row.actor_id)) ? userCache.get(String(row.actor_id)) : await findUserById(db, row.actor_id);
    if (actorRow) {
      const parts = rowParts(actorRow);
      const relationship = actorRow.id === viewerId ? "self" : snapshot?.relationship.get(actorRow.id) || "none";
      actor = commonPublicFields(actorRow, parts.profile, parts.preferences, parts.safety, viewerId, relationship, snapshot ? publicUserCounts(snapshot, actorRow.id) : undefined);
      if (row.type === "new_follower" && viewerId) {
        const incoming = await db.prepare("SELECT status FROM sl_follows WHERE follower_id = ? AND following_id = ? LIMIT 1").bind(actorRow.id, viewerId).first();
        actor.follows_viewer = incoming?.status === "accepted";
      }
    }
  }
  return {
    id: row.id, type: row.type, entity_id: row.entity_id || null, title: row.title || "", message: row.message,
    read: Boolean(row.read), created_at: row.created_at, actor
  };
}

async function notificationReminders(db, viewerId) {
  const now = new Date().toISOString();
  const eventRows = (await appRecords(db, "events", null)).filter(event => {
    const member = event.host_id === viewerId || jsonArray(event.participant_ids, []).includes(viewerId);
    return member && event.status !== "cancelled" && event.starts_at && new Date(event.starts_at).getTime() >= Date.now();
  }).sort((left, right) => String(left.starts_at).localeCompare(String(right.starts_at))).slice(0, 6);
  const registeredResult = await db.prepare("SELECT workshop_id FROM sl_workshop_registrations WHERE user_id = ? AND status = 'registered'").bind(viewerId).all();
  const registeredWorkshopIds = new Set((registeredResult.results || []).map(row => String(row.workshop_id)));
  const workshopRows = (await db.prepare("SELECT id, host_id, title, starts_at, duration_minutes, format, location, status FROM sl_workshops WHERE status = 'scheduled' AND starts_at >= ? ORDER BY starts_at ASC LIMIT 100").bind(now).all()).results || [];
  const reminders = [
    ...eventRows.map(event => ({
      id: event.id, kind: "session", title: event.title || "SwapLabs session", starts_at: event.starts_at,
      ends_at: event.ends_at || "", status: event.status || "scheduled", format: event.format || "",
      location: event.location || "", href: `calendar.html?event=${encodeURIComponent(event.id)}`
    })),
    ...workshopRows.filter(workshop => workshop.host_id === viewerId || registeredWorkshopIds.has(String(workshop.id))).map(workshop => ({
      id: workshop.id, kind: "workshop", title: workshop.title || "SwapLabs workshop", starts_at: workshop.starts_at,
      ends_at: workshopEndsAt(workshop), status: workshop.status || "scheduled", format: workshop.format || "",
      location: workshop.location || "", href: `workshops.html#${encodeURIComponent(workshop.id)}`
    }))
  ];
  return reminders.sort((left, right) => String(left.starts_at).localeCompare(String(right.starts_at))).slice(0, 8);
}

async function followRequestView(db, row, viewerId, userCache = null) {
  const requesterId = String(row.follower_id || "");
  const requesterRow = userCache && userCache.has(requesterId) ? userCache.get(requesterId) : await findUserById(db, requesterId);
  if (!requesterRow) return null;
  const parts = rowParts(requesterRow);
  return {
    id: row.id,
    requester: commonPublicFields(requesterRow, parts.profile, parts.preferences, parts.safety, viewerId, "none"),
    created_at: row.created_at
  };
}

async function changeFollow(request, env, targetId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before following a member."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const target = await findUserById(db, targetId);
  if (!target || target.role !== "member" || target.status !== "active") return apiResponse({error: "That member is not available."}, 404);
  if (target.id === viewer.id) return apiResponse({error: "You cannot follow your own account."}, 400);
  const viewerParts = rowParts(viewer);
  const targetParts = rowParts(target);
  const existing = await db.prepare("SELECT * FROM sl_follows WHERE follower_id = ? AND following_id = ? LIMIT 1").bind(viewer.id, target.id).first();
  const now = new Date().toISOString();
  if (request.method === "DELETE") {
    if (existing) await db.prepare("DELETE FROM sl_follows WHERE id = ? AND follower_id = ?").bind(existing.id, viewer.id).run();
    return apiResponse({ok: true, relationship: "none", message: "Follow connection removed."});
  }
  const status = targetParts.preferences.profile_visibility === "private" ? "pending" : "accepted";
  if (existing && existing.status === status) {
    return apiResponse({ok: true, relationship: status === "accepted" ? "following" : "requested", message: status === "accepted" ? `You are already following ${targetParts.profile.display_name || target.username}.` : "Your follow request is already waiting for approval."});
  }
  const followId = existing?.id || newId("follow");
  const displayName = targetParts.profile.display_name || completeName(targetParts.profile, target.username);
  const actorName = viewerParts.profile.display_name || completeName(viewerParts.profile, viewer.username);
  const statements = [existing
    ? db.prepare("UPDATE sl_follows SET status = ?, updated_at = ? WHERE id = ? AND follower_id = ? AND following_id = ?").bind(status, now, followId, viewer.id, target.id)
    : db.prepare("INSERT INTO sl_follows (id, follower_id, following_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(followId, viewer.id, target.id, status, now, now)];
  statements.push(db.prepare("INSERT INTO sl_audit_log (id, actor_id, target_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(newId("audit"), viewer.id, target.id, status === "pending" ? "follow_requested" : "followed_member", status === "pending" ? `Follow request sent to ${displayName}.` : `Started following ${displayName}.`, now));
  if (status === "pending") {
    statements.push(db.prepare("INSERT INTO sl_notifications (id, user_id, actor_id, type, entity_id, message, read, created_at) VALUES (?, ?, ?, 'follow_request', ?, ?, 0, ?)").bind(newId("notif"), target.id, viewer.id, followId, `${actorName} asked to follow you.` , now));
  } else {
    statements.push(db.prepare("INSERT INTO sl_notifications (id, user_id, actor_id, type, entity_id, message, read, created_at) VALUES (?, ?, ?, 'new_follower', ?, ?, 0, ?)").bind(newId("notif"), target.id, viewer.id, followId, `${actorName} is now following you.` , now));
  }
  await db.batch(statements);
  return apiResponse({ok: true, relationship: status === "accepted" ? "following" : "requested", message: status === "pending" ? `Follow request sent to ${displayName}.` : `You are now following ${displayName}.`});
}

async function notifications(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to view notifications."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const snapshot = await followSnapshot(db, viewer.id);
  const userCache = new Map((await allUserRows(db)).map(row => [String(row.id), row]));
  const result = await db.prepare("SELECT cm.last_read_at, cm.conversation_id FROM sl_conversation_members cm WHERE cm.user_id = ? AND cm.hidden = 0").bind(viewer.id).all();
  let unread_count = 0;
  for (const membership of result.results || []) {
    const count = membership.last_read_at ? await db.prepare("SELECT COUNT(*) AS count FROM sl_messages WHERE conversation_id = ? AND sender_id != ? AND created_at > ?").bind(membership.conversation_id, viewer.id, membership.last_read_at).first() : await db.prepare("SELECT COUNT(*) AS count FROM sl_messages WHERE conversation_id = ? AND sender_id != ?").bind(membership.conversation_id, viewer.id).first();
    unread_count += Number(count?.count || 0);
  }
  const pendingResult = await db.prepare("SELECT * FROM sl_follows WHERE following_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 100").bind(viewer.id).all();
  const incoming_requests = [];
  for (const row of pendingResult.results || []) {
    const requestView = await followRequestView(db, row, viewer.id, userCache);
    if (requestView) incoming_requests.push(requestView);
  }
  const notificationResult = await db.prepare("SELECT * FROM sl_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").bind(viewer.id).all();
  const notificationRows = notificationResult.results || [];
  const notificationItems = [];
  for (const row of notificationRows) notificationItems.push(await notificationView(db, row, viewer.id, snapshot, userCache));
  const connections = await connectionListsForUser(db, viewer.id, viewer.id, snapshot, userCache);
  const unreadNotifications = notificationRows.filter(row => !row.read).length;
  return apiResponse({
    notifications: notificationItems, incoming_requests, unread_count, inbox_unread_count: unread_count,
    notification_unread_count: unreadNotifications, pending_count: incoming_requests.length,
    followers: connections.followers, following: connections.following,
    followers_count: connections.followers_count, following_count: connections.following_count,
    following_activity: connections.following.slice(0, 8), reminders: await notificationReminders(db, viewer.id)
  });
}

async function removeFollower(request, env, followerId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before managing your followers."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const follow = await db.prepare("SELECT * FROM sl_follows WHERE follower_id = ? AND following_id = ? AND status = 'accepted' LIMIT 1").bind(followerId, viewer.id).first();
  if (!follow) return apiResponse({error: "That member is not currently following you."}, 404);
  const follower = await findUserById(db, followerId);
  const viewerName = rowParts(viewer).profile.display_name || viewer.username;
  const followerName = follower ? rowParts(follower).profile.display_name || follower.username : "member";
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("DELETE FROM sl_follows WHERE id = ? AND follower_id = ? AND following_id = ?").bind(follow.id, followerId, viewer.id),
    db.prepare("INSERT INTO sl_audit_log (id, actor_id, target_id, action, details, created_at) VALUES (?, ?, ?, 'follower_removed', ?, ?)").bind(newId("audit"), viewer.id, followerId, `Removed ${followerName} from their followers.`, now)
  ]);
  return apiResponse({ok: true, message: `${followerName} was removed from your followers.`, removed_user_id: followerId, actor_name: viewerName});
}

async function profileConnections(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to view your connections."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const snapshot = await followSnapshot(db, viewer.id);
  const userCache = new Map((await allUserRows(db)).map(row => [String(row.id), row]));
  const connections = await connectionListsForUser(db, viewer.id, viewer.id, snapshot, userCache);
  return apiResponse(connections);
}

async function respondToFollowRequest(request, env, requestId, accept) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to manage follow requests."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const follow = await db.prepare("SELECT * FROM sl_follows WHERE id = ? AND following_id = ? AND status = 'pending' LIMIT 1").bind(requestId, viewer.id).first();
  if (!follow) return apiResponse({error: "That follow request is no longer available."}, 404);
  const requester = await findUserById(db, follow.follower_id);
  const now = new Date().toISOString();
  if (accept) {
    await db.batch([
      db.prepare("UPDATE sl_follows SET status = 'accepted', updated_at = ? WHERE id = ?").bind(now, follow.id),
      db.prepare("INSERT INTO sl_notifications (id, user_id, actor_id, type, entity_id, message, read, created_at) VALUES (?, ?, ?, 'follow_accepted', ?, ?, 0, ?)").bind(newId("notif"), follow.follower_id, viewer.id, follow.id, `${rowParts(viewer).profile.display_name || viewer.username} accepted your follow request.`, now),
      db.prepare("UPDATE sl_notifications SET read = 1 WHERE user_id = ? AND entity_id = ? AND type = 'follow_request'").bind(viewer.id, follow.id),
      db.prepare("INSERT INTO sl_audit_log (id, actor_id, target_id, action, details, created_at) VALUES (?, ?, ?, 'follow_accepted', ?, ?)").bind(newId("audit"), viewer.id, follow.follower_id, `Accepted a follow request from ${requester ? rowParts(requester).profile.display_name || requester.username : "a member"}.`, now)
    ]);
    return apiResponse({ok: true, message: "Follow request accepted."});
  }
  await db.batch([
    db.prepare("UPDATE sl_follows SET status = 'declined', updated_at = ? WHERE id = ?").bind(now, follow.id),
    db.prepare("UPDATE sl_notifications SET read = 1 WHERE user_id = ? AND entity_id = ? AND type = 'follow_request'").bind(viewer.id, follow.id),
    db.prepare("INSERT INTO sl_audit_log (id, actor_id, target_id, action, details, created_at) VALUES (?, ?, ?, 'follow_declined', 'Deleted a follow request.', ?)").bind(newId("audit"), viewer.id, follow.follower_id, now)
  ]);
  return apiResponse({ok: true, message: "Follow request deleted."});
}

async function markNotificationRead(request, env, notificationId) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to update notifications."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const result = await db.prepare("UPDATE sl_notifications SET read = 1 WHERE id = ? AND user_id = ?").bind(notificationId, viewer.id).run();
  if (!Number(result?.meta?.changes || 0)) return apiResponse({error: "That notification is no longer available."}, 404);
  return apiResponse({ok: true});
}

async function markAllNotificationsRead(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in to update notifications."}, 401);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  await db.prepare("UPDATE sl_notifications SET read = 1 WHERE user_id = ?").bind(viewer.id).run();
  return apiResponse({ok: true});
}

function matchesAdminMessageFilters(row, filters) {
  const parts = rowParts(row);
  const profile = parts.profile;
  const age = profileAge(profile);
  const minAge = Number(filters.min_age);
  const maxAge = Number(filters.max_age);
  if (Number.isFinite(minAge) && minAge > 0 && (!Number.isFinite(age) || age < minAge)) return false;
  if (Number.isFinite(maxAge) && maxAge > 0 && (!Number.isFinite(age) || age > maxAge)) return false;
  const timezone = safeText(filters.timezone, 120).toLowerCase();
  const country = safeText(filters.country, 120).toLowerCase();
  if (timezone && !safeText(profile.timezone, 120).toLowerCase().includes(timezone)) return false;
  if (country && !safeText(profile.country, 120).toLowerCase().includes(country)) return false;
  const minCredits = Number(filters.min_credits);
  const maxCredits = Number(filters.max_credits);
  if (Number.isFinite(minCredits) && minCredits >= 0 && Number(row.time_credits || 0) < minCredits) return false;
  if (Number.isFinite(maxCredits) && maxCredits >= 0 && Number(row.time_credits || 0) > maxCredits) return false;
  const verified = safeText(filters.verified, 20).toLowerCase();
  if (verified === "verified" && !row.verified) return false;
  if (verified === "unverified" && row.verified) return false;
  return true;
}

async function adminMessages(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const body = await readJson(request);
  const text = safeText(body.body, 4000);
  if (!text) return apiResponse({error: "Write a message before sending."}, 400);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const rows = (await allUserRows(db)).filter(row => row.id !== access.row.id && row.role === "member" && row.status === "active" && !row.messaging_restricted);
  let recipients = [];
  const targetId = safeText(body.target_user_id, 100);
  if (targetId) {
    recipients = rows.filter(row => row.id === targetId);
    if (!recipients.length) return apiResponse({error: "That active member account was not found."}, 404);
  } else if (safeBoolean(body.broadcast, false)) {
    const filters = isObject(body.filters) ? body.filters : {};
    recipients = rows.filter(row => matchesAdminMessageFilters(row, filters)).slice(0, 500);
    if (!recipients.length) return apiResponse({error: "No active members match those filters."}, 404);
  } else return apiResponse({error: "Choose one member or switch to filtered member outreach."}, 400);
  let sent = 0;
  const conversationIds = [];
  for (const recipient of recipients) {
    const conversationId = await directConversation(db, access.row.id, recipient.id);
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO sl_messages (id, conversation_id, sender_id, body, metadata_json, moderation_status, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', 'visible', 0, ?, ?)").bind(newId("msg"), conversationId, access.row.id, text, now, now),
      db.prepare("UPDATE sl_conversations SET updated_at = ? WHERE id = ?").bind(now, conversationId),
      auditInsert(db, {actorId: access.row.id, targetId: recipient.id, action: "admin_message_sent", details: "Administrator sent a direct member message.", createdAt: now})
    ]);
    sent += 1;
    conversationIds.push(conversationId);
  }
  return apiResponse({ok: true, message: `Message sent to ${sent} member${sent === 1 ? "" : "s"}.`, sent, matched: recipients.length, conversation_ids: conversationIds});
}

async function adminNotificationBroadcast(request, env) {
  const access = await requireAdmin(request, env);
  if (access.response) return access.response;
  const body = await readJson(request);
  const title = safeText(body.title, 120);
  const message = safeText(body.message, 1500);
  const audience = safeText(body.audience, 20).toLowerCase();
  if (title.length < 3) return apiResponse({error: "Add a clear notification title (at least 3 characters)."}, 400);
  if (message.length < 3) return apiResponse({error: "Write a notification message (at least 3 characters)."}, 400);
  if (!["all", "filtered"].includes(audience)) return apiResponse({error: "Choose all active members or a filtered audience."}, 400);

  const filters = audience === "filtered" && isObject(body.filters) ? body.filters : {};
  const where = ["role = 'member'", "status = 'active'"];
  const params = [];
  let activeFilters = 0;
  const addNumber = (name, min, max, label) => {
    const raw = safeText(filters[name], 24);
    if (!raw) return {value: null};
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return {error: `${label} must be a whole number from ${min} to ${max}.`};
    activeFilters += 1;
    return {value};
  };
  const minAge = addNumber("min_age", 3, 120, "Minimum age");
  const maxAge = addNumber("max_age", 3, 120, "Maximum age");
  const minCredits = addNumber("min_credits", 0, 100000000, "Minimum credits");
  const maxCredits = addNumber("max_credits", 0, 100000000, "Maximum credits");
  const activeWithin = addNumber("active_within_days", 1, 3650, "Active-within days");
  const inactiveFor = addNumber("inactive_for_days", 1, 3650, "Inactive-for days");
  for (const result of [minAge, maxAge, minCredits, maxCredits, activeWithin, inactiveFor]) {
    if (result.error) return apiResponse({error: result.error}, 400);
  }
  if (minAge.value !== null && maxAge.value !== null && minAge.value > maxAge.value) return apiResponse({error: "Minimum age cannot exceed maximum age."}, 400);
  if (minCredits.value !== null && maxCredits.value !== null && minCredits.value > maxCredits.value) return apiResponse({error: "Minimum credits cannot exceed maximum credits."}, 400);
  if (activeWithin.value !== null && inactiveFor.value !== null) return apiResponse({error: "Choose either a recent-activity filter or an inactivity filter, not both."}, 400);

  const ageExpression = "CASE WHEN date(json_extract(profile_json, '$.date_of_birth')) IS NOT NULL THEN CAST(strftime('%Y','now') AS INTEGER) - CAST(strftime('%Y',json_extract(profile_json, '$.date_of_birth')) AS INTEGER) - (strftime('%m-%d','now') < strftime('%m-%d',json_extract(profile_json, '$.date_of_birth'))) ELSE CAST(json_extract(profile_json, '$.age') AS INTEGER) END";
  if (minAge.value !== null) { where.push(`${ageExpression} >= ?`); params.push(minAge.value); }
  if (maxAge.value !== null) { where.push(`${ageExpression} <= ?`); params.push(maxAge.value); }
  if (minCredits.value !== null) { where.push("time_credits >= ?"); params.push(minCredits.value); }
  if (maxCredits.value !== null) { where.push("time_credits <= ?"); params.push(maxCredits.value); }

  for (const [name, field] of [["country", "country"], ["timezone", "timezone"]]) {
    const value = safeText(filters[name], 120);
    if (value) {
      where.push(`instr(lower(COALESCE(json_extract(profile_json, '$.${field}'), '')), lower(?)) > 0`);
      params.push(value);
      activeFilters += 1;
    }
  }

  const verified = safeText(filters.verified, 20).toLowerCase();
  if (verified && !["verified", "unverified"].includes(verified)) return apiResponse({error: "Choose a valid verification filter."}, 400);
  if (verified) { where.push(`verified = ${verified === "verified" ? 1 : 0}`); activeFilters += 1; }

  const parseDate = (name, label) => {
    const value = safeText(filters[name], 10);
    if (!value) return {value: ""};
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return {error: `${label} must be a valid date.`};
    activeFilters += 1;
    return {value};
  };
  const joinedAfter = parseDate("joined_after", "Joined-after date");
  const joinedBefore = parseDate("joined_before", "Joined-before date");
  if (joinedAfter.error) return apiResponse({error: joinedAfter.error}, 400);
  if (joinedBefore.error) return apiResponse({error: joinedBefore.error}, 400);
  if (joinedAfter.value && joinedBefore.value && joinedAfter.value > joinedBefore.value) return apiResponse({error: "The starting join date must be on or before the ending date."}, 400);
  if (joinedAfter.value) { where.push("substr(created_at, 1, 10) >= ?"); params.push(joinedAfter.value); }
  if (joinedBefore.value) { where.push("substr(created_at, 1, 10) <= ?"); params.push(joinedBefore.value); }

  const activityCutoff = days => new Date(Date.now() - days * 86400000).toISOString();
  if (activeWithin.value !== null) {
    where.push("last_login_at IS NOT NULL AND last_login_at >= ?");
    params.push(activityCutoff(activeWithin.value));
  }
  if (inactiveFor.value !== null) {
    where.push("(last_login_at IS NULL OR last_login_at <= ?)");
    params.push(activityCutoff(inactiveFor.value));
  }
  const teachingSkills = safeText(filters.teaching_skills, 12).toLowerCase();
  if (teachingSkills && !["has", "none"].includes(teachingSkills)) return apiResponse({error: "Choose a valid teaching-skills filter."}, 400);
  if (teachingSkills) {
    const skillsPresent = "(TRIM(COALESCE(json_extract(profile_json, '$.skills_to_teach'), '')) NOT IN ('', '[]') OR TRIM(COALESCE(json_extract(profile_json, '$.additional_languages'), '')) NOT IN ('', '[]'))";
    where.push(teachingSkills === "has" ? skillsPresent : `NOT ${skillsPresent}`);
    activeFilters += 1;
  }

  if (audience === "filtered" && !activeFilters) return apiResponse({error: "Add at least one audience filter before sending a filtered announcement."}, 400);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const whereSql = where.join(" AND ");
  const matched = Number((await db.prepare(`SELECT COUNT(*) AS total FROM sl_users WHERE ${whereSql}`).bind(...params).first())?.total || 0);
  if (!matched) return apiResponse({error: "No active members match this audience."}, 404);

  const now = new Date().toISOString();
  const campaignId = newId("announcement");
  const inserted = await db.batch([
    db.prepare(`INSERT INTO sl_notifications (id, user_id, actor_id, type, entity_id, title, message, created_at, read)
      SELECT lower(hex(randomblob(16))), id, ?, 'admin_announcement', ?, ?, ?, ?, 0 FROM sl_users WHERE ${whereSql}`)
      .bind(access.row.id, campaignId, title, message, now, ...params),
    auditInsert(db, {actorId: access.row.id, action: "admin_notification_broadcast", details: JSON.stringify({audience, filters: audience === "filtered" ? filters : {}, title, recipients: matched}), createdAt: now})
  ]);
  const sent = Number(inserted?.[0]?.meta?.changes ?? matched);
  return apiResponse({ok: true, sent, matched, campaign_id: campaignId, message: `Announcement sent to ${sent} active member${sent === 1 ? "" : "s"}.`});
}

function csvValues(value) {
  return [...new Set(String(value || "").split(",").map(item => safeText(item, 120)).filter(item => item && item.toLowerCase() !== NOTHING_FOR_NOW_VALUE))];
}

function matchList(value) {
  const values = Array.isArray(value) ? value : csvValues(value);
  return [...new Set(values.map(item => safeText(item, 120)).filter(item => item && item.toLowerCase() !== NOTHING_FOR_NOW_VALUE))];
}

function matchKey(value) {
  return safeText(value, 160).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/c\+\+/g, " cpp ").replace(/c#/g, " csharp ").replace(/\.net\b/g, " dotnet ")
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

// Skill labels are user-entered, so exact string equality is too brittle for
// matching. Keep the original labels for display, but compare a canonical
// label plus a token-aware form so “web dev”, “web-development”, and “web
// development for beginners” can all reach the same useful result.
const MATCH_SKILL_ALIASES = new Map([
  ["web dev", "web development"], ["website development", "web development"],
  ["website design", "web design"], ["frontend", "frontend development"],
  ["front end", "frontend development"], ["front end dev", "frontend development"],
  ["backend", "backend development"], ["back end", "backend development"],
  ["back end dev", "backend development"], ["fullstack", "full stack development"],
  ["full stack dev", "full stack development"], ["ui ux", "ui ux design"],
  ["user interface", "ui design"], ["user experience", "ux design"],
  ["js", "javascript"], ["javascript programming", "javascript"],
  ["ts", "typescript"], ["python dev", "python programming"],
  ["data analytics", "data analysis"], ["machine learning ai", "machine learning"],
  ["graphic arts", "graphic design"], ["public speaking practice", "public speaking"],
  ["spoken english", "english conversation"], ["english speaking", "english conversation"],
  ["mindfulness meditation", "mindfulness"], ["yoga practice", "yoga"],
  ["fitness training", "fitness"], ["strength and conditioning", "strength training"],
  ["soccer football", "football"], ["content creation", "content writing"],
  ["project management basics", "project management"]
]);

const MATCH_NOISE_WORDS = new Set(["a", "an", "and", "for", "the", "to", "with", "in", "on", "of", "basics", "basic", "skills", "skill", "beginner", "beginners", "advanced", "expert", "fundamentals", "introduction", "intro"]);

function matchCanonicalKey(value) {
  const key = matchKey(value);
  return MATCH_SKILL_ALIASES.get(key) || key;
}

function matchTokens(value) {
  return matchCanonicalKey(value).split(" ").filter(token => token && !MATCH_NOISE_WORDS.has(token));
}

function matchTokenFit(left, right) {
  const leftKey = matchCanonicalKey(left);
  const rightKey = matchCanonicalKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;
  const leftTokens = new Set(matchTokens(left));
  const rightTokens = new Set(matchTokens(right));
  if (!leftTokens.size || !rightTokens.size) return false;
  const smaller = leftTokens.size <= rightTokens.size ? leftTokens : rightTokens;
  const larger = leftTokens.size <= rightTokens.size ? rightTokens : leftTokens;
  return [...smaller].every(token => larger.has(token));
}

function matchOverlap(left, right) {
  const first = matchList(left);
  const second = matchList(right);
  for (const requested of first) {
    const requestedKey = matchCanonicalKey(requested);
    if (!requestedKey) continue;
    const found = second.find(candidate => {
      const candidateKey = matchCanonicalKey(candidate);
      const comparable = Math.min(requestedKey.length, candidateKey.length) >= 3;
      return candidateKey && (matchTokenFit(requested, candidate) || comparable && (candidateKey.includes(requestedKey) || requestedKey.includes(candidateKey)));
    });
    if (found) return {requested, found, family: skillFamily(requested) || skillFamily(found)};
  }
  return null;
}

const RELATED_SKILL_FAMILIES = [
  {label: "Software and web", skills: ["web design", "web development", "frontend development", "front end development", "front end engineering", "backend development", "back end development", "full stack development", "full stack", "ui design", "ux design", "user interface design", "user experience design", "responsive web design", "web accessibility", "html", "css", "javascript", "typescript", "react", "vue", "angular", "svelte", "next js", "node js", "php", "java programming", "c programming", "c sharp", "c++ programming", "rust programming", "go programming", "kotlin", "swift", "coding", "programming", "software testing", "git", "github", "api integration", "mobile app development", "android development", "ios development", "flutter", "react native", "linux administration", "networking", "computer networking", "wordpress", "ecommerce development", "database design"]},
  {label: "Data and AI", skills: ["python", "python programming", "data analysis", "data science", "data visualization", "data engineering", "machine learning", "deep learning", "artificial intelligence", "ai application development", "sql", "statistics", "excel", "excel data analysis", "power bi", "tableau", "r programming", "computer vision", "natural language processing", "nlp", "prompt engineering", "generative ai", "cybersecurity", "cyber security", "network security", "ethical hacking", "research methods", "quantitative analysis"]},
  {label: "Visual design and media", skills: ["graphic design", "visual design", "branding", "illustration", "motion design", "animation", "3d modeling", "typography", "color theory", "photography", "portrait photography", "wildlife photography", "photo editing", "video editing", "video production", "filmmaking", "after effects", "premiere pro", "lightroom", "canva", "presentation design"]},
  {label: "Writing and communication", skills: ["creative writing", "content writing", "copywriting", "technical writing", "editing", "proofreading", "public speaking", "presentation", "storytelling", "interview practice", "communication", "writing", "blogging", "journalism", "resume writing", "business writing", "grant writing"]},
  {label: "Product and business", skills: ["product planning", "product strategy", "project planning", "project management", "entrepreneurship", "digital marketing", "marketing", "seo", "social media marketing", "sales", "career planning", "linkedin", "community building", "personal branding", "customer success", "business presentations", "finance basics", "budgeting", "leadership"]},
  {label: "Languages and education", skills: ["english", "english conversation", "spanish", "spanish conversation", "french", "german", "hindi", "nepali", "tibetan", "mandarin", "chinese", "japanese", "korean", "italian", "portuguese", "arabic", "sign language", "language exchange", "language learning", "tutoring", "teaching", "lesson planning", "curriculum design", "study skills", "exam preparation"]},
  {label: "Math and science", skills: ["mathematics", "math", "discrete mathematics", "algebra", "geometry", "calculus", "physics", "chemistry", "biology", "astronomy", "environmental science", "climate action"]},
  {label: "Music and audio", skills: ["music theory", "guitar", "piano", "singing", "vocals", "songwriting", "electronic music", "music production", "beat making", "djing", "audio editing", "mixing", "mastering", "drums", "ukulele", "violin", "sound design", "podcasting"]},
  {label: "Food and hospitality", skills: ["cooking", "cooking basics", "indian cooking", "baking", "bread baking", "pastry", "cake decorating", "meal prep", "food styling", "grilling", "restaurant service", "hospitality", "bartending", "coffee brewing"]},
  {label: "Maker, home and repair", skills: ["woodworking", "carpentry", "metalworking", "electronics", "robotics", "3d printing", "diy", "home repair", "plumbing", "electrical basics"]},
  {label: "Arts, crafts and fashion", skills: ["drawing", "sketching", "painting", "watercolor", "pottery", "ceramics", "embroidery", "knitting", "crochet", "jewelry making", "prop making", "fashion design", "styling", "makeup artistry", "floral design", "creative crafts"]},
  {label: "Wellbeing, fitness and outdoors", skills: ["fitness", "running", "yoga", "pilates", "mindfulness", "meditation", "nutrition", "habit building", "sleep hygiene", "mental wellness", "strength training", "football", "soccer", "basketball", "swimming", "snowboarding", "hiking", "camping", "gardening", "urban gardening"]},
  {label: "Life and community", skills: ["relationships", "parenting basics", "conflict mediation", "customer service", "time management", "volunteering", "sustainability", "pet care", "personal safety"]},
  {label: "Digital literacy", skills: ["digital literacy", "computer basics", "office software", "microsoft office", "technology", "online safety"]}
];

const RELATED_SKILL_HINTS = [
  {label: "Data and AI", hints: ["data", "analytics", "machine", "statistics", "sql", "python", "ai", "artificial", "cybersecurity", "cyber", "research", "quantitative", "power bi", "tableau", "sheets"]},
  {label: "Software and web", hints: ["web", "frontend", "backend", "development", "programming", "coding", "software", "framework", "database", "api", "mobile", "app", "server", "cloud", "linux", "network", "testing", "git", "devops", "django", "flask", "fastapi", "laravel", "postgresql", "mysql", "mongodb", "graphql", "unity", "unreal", "arduino", "raspberry"]},
  {label: "Music and audio", hints: ["music", "audio", "sound", "song", "vocal", "guitar", "piano", "drum", "dj", "podcast", "recording"]},
  {label: "Food and hospitality", hints: ["cook", "bake", "bread", "pastry", "food", "kitchen", "restaurant", "coffee", "tea", "catering", "hospitality", "barbecue", "grill"]},
  {label: "Math and science", hints: ["math", "algebra", "geometry", "calculus", "physics", "chemistry", "biology", "science", "astronomy", "geology", "environment", "climate", "engineering", "psychology", "sociology", "geography"]},
  {label: "Languages and education", hints: ["language", "conversation", "translation", "teaching", "tutor", "lesson", "education", "course", "learning", "study", "classroom", "curriculum", "school"]},
  {label: "Writing and communication", hints: ["writing", "speaking", "communication", "story", "journal", "editing", "proofreading", "presentation", "debate", "negotiation", "voiceover", "media literacy"]},
  {label: "Product and business", hints: ["business", "management", "marketing", "sales", "career", "finance", "accounting", "leadership", "strategy", "project", "product", "customer", "operations", "planning", "legal", "fundraising", "organization"]},
  {label: "Visual design and media", hints: ["design", "graphic", "visual", "brand", "logo", "illustration", "typography", "animation", "photo", "video", "film", "media", "camera", "editing", "motion", "blender", "cinematography"]},
  {label: "Arts, crafts and fashion", hints: ["drawing", "sketch", "painting", "watercolor", "art", "craft", "fashion", "style", "makeup", "pottery", "ceramic", "jewelry", "paper", "cosplay", "calligraphy", "textile"]},
  {label: "Maker, home and repair", hints: ["wood", "carpentry", "metal", "weld", "repair", "home", "electronics", "robot", "print", "plumbing", "sewing", "knitting", "crochet", "construction", "bicycle", "appliance"]},
  {label: "Wellbeing, fitness and outdoors", hints: ["fitness", "running", "yoga", "health", "mindfulness", "meditation", "nutrition", "sleep", "sport", "football", "soccer", "basketball", "hiking", "camping", "climbing", "swimming", "dance", "first aid", "outdoor", "survival"]},
  {label: "Life and community", hints: ["parent", "pet", "relationship", "community", "volunteer", "sustainability", "safety", "travel", "productivity", "time", "goal", "civic", "friendship", "elder care"]},
  {label: "Digital literacy", hints: ["digital", "computer", "office", "online", "privacy", "password", "smartphone", "remote work", "virtual collaboration"]}
];

function skillFamily(value) {
  const key = matchKey(value);
  if (!key) return "";
  const exact = RELATED_SKILL_FAMILIES.find(family => family.skills.some(skill => matchKey(skill) === key))?.label;
  if (exact) return exact;
  const tokens = new Set(key.split(" "));
  return RELATED_SKILL_HINTS.find(family => family.hints.some(hint => {
    const normalizedHint = matchKey(hint);
    return normalizedHint.includes(" ") ? key.includes(normalizedHint) : tokens.has(normalizedHint);
  }))?.label || "";
}

function relatedSkillFamily(left, right) {
  const leftKey = matchKey(left);
  const rightKey = matchKey(right);
  if (!leftKey || !rightKey || leftKey === rightKey) return "";
  const leftFamily = skillFamily(left);
  const rightFamily = skillFamily(right);
  return leftFamily && leftFamily === rightFamily ? leftFamily : "";
}

function matchSkillFit(requested, available) {
  return matchSkillFits(requested, available).best;
}

function matchSkillFits(requested, available) {
  const first = matchList(requested);
  const second = matchList(available);
  const direct = [];
  const related = [];
  for (const wanted of first) {
    const foundDirect = second.find(candidate => matchTokenFit(wanted, candidate));
    if (foundDirect) {
      direct.push({requested: wanted, found: foundDirect, family: skillFamily(wanted) || skillFamily(foundDirect), kind: "direct"});
      continue;
    }
    const foundRelated = second.find(candidate => relatedSkillFamily(wanted, candidate));
    if (foundRelated) related.push({requested: wanted, found: foundRelated, family: relatedSkillFamily(wanted, foundRelated), kind: "related"});
  }
  return {direct, related, best: direct[0] || related[0] || null};
}

function profileMatchSkills(profile) {
  return {
    teach: matchList([...csvValues(profile.skills_to_teach), ...csvValues(profile.additional_languages)]),
    learn: matchList([...csvValues(profile.skills_to_learn), ...csvValues(profile.languages_to_learn)])
  };
}

function profileMatchLanguages(profile) {
  return matchList([profile.primary_language, ...csvValues(profile.additional_languages), ...csvValues(profile.languages_to_learn)]);
}

function matchExperienceScore(viewerLevel, candidateLevel) {
  const levels = ["beginner", "intermediate", "advanced", "expert"];
  const first = matchKey(viewerLevel);
  const second = matchKey(candidateLevel);
  if (!first || !second) return 0;
  const firstIndex = levels.findIndex(level => first.includes(level));
  const secondIndex = levels.findIndex(level => second.includes(level));
  if (firstIndex < 0 || secondIndex < 0) return 0;
  const distance = Math.abs(firstIndex - secondIndex);
  return distance === 0 ? 5 : distance === 1 ? 3 : 1;
}

function availabilityDays(record) {
  const weekly = isObject(record?.weekly) ? record.weekly : {};
  return Object.entries(weekly)
    .filter(([, value]) => Array.isArray(value) ? value.length > 0 : Boolean(value))
    .map(([day]) => matchKey(day))
    .filter(Boolean);
}

function matchAvailabilityFit(viewerProfile, candidateProfile, viewerAvailability, candidateAvailability) {
  const viewerTimezone = matchKey(viewerAvailability?.timezone || viewerProfile.timezone);
  const candidateTimezone = matchKey(candidateAvailability?.timezone || candidateProfile.timezone);
  const viewerText = matchKey([viewerProfile.availability, ...availabilityDays(viewerAvailability)].filter(Boolean).join(" "));
  const candidateText = matchKey([candidateProfile.availability, ...availabilityDays(candidateAvailability)].filter(Boolean).join(" "));
  const flexible = value => /flexible|anytime|open|varies|most days|most times|weekdays|weekends/.test(value);
  const windows = ["morning", "afternoon", "evening", "night", "weekday", "weekend"];
  const sharedWindow = windows.some(window => viewerText.includes(window) && candidateText.includes(window));
  const sharedDay = availabilityDays(viewerAvailability).some(day => availabilityDays(candidateAvailability).includes(day));
  let points = viewerTimezone && candidateTimezone && viewerTimezone === candidateTimezone ? 3 : 0;
  if (viewerText && candidateText && (flexible(viewerText) || flexible(candidateText) || sharedWindow || sharedDay)) points += 5;
  else if (viewerText && candidateText) points += 2;
  return {
    points: Math.min(8, points),
    same_timezone: Boolean(viewerTimezone && candidateTimezone && viewerTimezone === candidateTimezone),
    shared_window: Boolean(sharedWindow || sharedDay),
    label: candidateProfile.availability || (candidateTimezone ? `Availability in ${candidateAvailability?.timezone || candidateProfile.timezone}` : "Availability to confirm")
  };
}

function memberHistoryCounts(events) {
  const counts = new Map();
  for (const event of events || []) {
    if (!["completed", "ended", "closed"].includes(String(event.status || "").toLowerCase())) continue;
    const memberIds = [event.host_id, ...jsonArray(event.participant_ids, []), ...jsonArray(event.member_ids, [])].filter(Boolean);
    for (const memberId of new Set(memberIds.map(String))) counts.set(memberId, (counts.get(memberId) || 0) + 1);
  }
  return counts;
}

function matchAgeBand(age) {
  const value = Number(age);
  if (!Number.isFinite(value) || value < 3) return null;
  if (value <= 12) return {key: "child", label: "3–12", index: 0};
  if (value <= 17) return {key: "teen", label: "13–17", index: 1};
  if (value <= 24) return {key: "young-adult", label: "18–24", index: 2};
  if (value <= 39) return {key: "adult", label: "25–39", index: 3};
  return {key: "experienced", label: "40+", index: 4};
}

function matchGender(profile) {
  return matchKey(profile.gender);
}

function matchQuality(score, direct, related, reciprocal) {
  if (direct && score >= 72) return "strong";
  if (direct) return "good";
  if (related || reciprocal) return "related";
  return "discovery";
}

async function memberMatches(request, env) {
  const viewer = await sessionUser(request, env);
  if (!viewer) return apiResponse({error: "Please log in before finding a swap."}, 401);
  const body = await readJson(request);
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const viewerParts = rowParts(viewer);
  const savedSkills = profileMatchSkills(viewerParts.profile);
  const requestedLearn = matchList(body.learn_skills);
  const requestedTeach = matchList(body.teach_skills);
  const learnSkills = matchList([...requestedLearn, ...savedSkills.learn]);
  const teachSkills = matchList([...requestedTeach, ...savedSkills.teach]);
  const sessionLanguages = matchList([...(Array.isArray(body.languages) ? body.languages : csvValues(body.languages)), ...profileMatchLanguages(viewerParts.profile)]);
  // Broad discovery is the useful default. The checkbox can still opt into
  // direct/related-only results, but an omitted field must not make a search
  // silently return nothing.
  const strict = Object.prototype.hasOwnProperty.call(body, "strict_skill_match")
    ? safeBoolean(body.strict_skill_match, false)
    : false;
  const useDemographicPreferences = safeBoolean(body.use_demographic_preferences, false);
  const viewerAge = profileAge(viewerParts.profile);
  const viewerBand = matchAgeBand(viewerAge);
  const viewerGender = matchGender(viewerParts.profile);
  const viewerMinor = Boolean(viewerParts.safety.is_minor);
  const [snapshot, rows, availabilityRows, eventRows] = await Promise.all([
    followSnapshot(db, viewer.id),
    allUserRows(db),
    appRecords(db, "availability", null),
    appRecords(db, "events", null)
  ]);
  const availabilityByUser = new Map(availabilityRows.map(item => [String(item.owner_id || item.user_id || item.id || ""), item]).filter(([key]) => key));
  const completedByUser = memberHistoryCounts(eventRows);
  const viewerAvailability = availabilityByUser.get(String(viewer.id)) || null;
  const matches = [];

  for (const row of rows) {
    if (row.id === viewer.id || row.role !== "member" || row.status !== "active") continue;
    const parts = rowParts(row);
    if (parts.preferences.match_visibility === false) continue;
    // Keep student swaps inside the same age-aware safety cohort. The swap
    // request endpoint applies the same guard when a request is sent.
    if (viewerMinor !== Boolean(parts.safety.is_minor)) continue;
    const skills = profileMatchSkills(parts.profile);
    const learningFits = matchSkillFits(learnSkills, skills.teach);
    const teachingFits = matchSkillFits(teachSkills, skills.learn);
    const direct = learningFits.direct[0] || null;
    const related = learningFits.related[0] || null;
    const bestLearningFit = direct || related || null;
    const reciprocal = teachingFits.best;
    if (strict && !bestLearningFit) continue;
    const exchangeType = bestLearningFit ? (reciprocal ? "mutual" : "one_way") : reciprocal ? "reverse_one_way" : "discovery";

    const age = profileAge(parts.profile);
    const ageBand = matchAgeBand(age);
    const gender = matchGender(parts.profile);
    const sameGender = Boolean(viewerGender && gender && viewerGender === gender);
    const ageDistance = viewerBand && ageBand ? Math.abs(viewerBand.index - ageBand.index) : null;
    const sameAgeBand = Boolean(viewerBand && ageBand && viewerBand.key === ageBand.key);
    const agePoints = useDemographicPreferences ? (sameAgeBand ? 8 : ageDistance === 1 ? 4 : 0) : 0;
    const genderPoints = useDemographicPreferences && sameGender ? 4 : 0;
    const languageOverlap = matchOverlap(sessionLanguages, profileMatchLanguages(parts.profile));
    const contextFit = matchSkillFit(
      [body.learning_goal, body.interests, viewerParts.profile.learning_goal, viewerParts.profile.interests],
      [parts.profile.learning_goal, parts.profile.interests, ...skills.teach, ...skills.learn]
    );
    const style = safeText(body.teaching_style, 120).toLowerCase();
    const candidateStyle = safeText(parts.profile.teaching_style, 120).toLowerCase();
    const stylePoints = style && candidateStyle && (style === candidateStyle || candidateStyle.includes("flexible") || style.includes("flexible")) ? 5 : 0;
    const requestedFormat = safeText(body.session_format, 80).toLowerCase();
    const candidateFormat = safeText(parts.profile.preferred_format, 80).toLowerCase();
    const formatPoints = requestedFormat && candidateFormat && (requestedFormat === candidateFormat || candidateFormat.includes("flexible") || requestedFormat.includes("flexible") || requestedFormat.includes("remote") && candidateFormat.includes("remote") || requestedFormat.includes("local") && candidateFormat.includes("local")) ? 5 : 0;
    const availabilityFit = matchAvailabilityFit(viewerParts.profile, parts.profile, viewerAvailability, availabilityByUser.get(String(row.id)) || null);
    const completedSessions = completedByUser.get(String(row.id)) || 0;
    const reliabilityPoints = Math.min(6, completedSessions * 2);
    const directPoints = direct ? Math.min(58, 46 + Math.max(0, learningFits.direct.length - 1) * 6) : 0;
    const relatedPoints = !direct && related ? Math.min(42, 30 + Math.max(0, learningFits.related.length - 1) * 5) : 0;
    const discoveryPoints = !direct && !related ? (strict ? 0 : 12) : 0;
    const reciprocalPoints = reciprocal ? (direct ? (reciprocal.kind === "related" ? 8 : 14) : 10) : 0;
    const contextPoints = contextFit ? 7 : 0;
    const languagePoints = languageOverlap ? 8 : 0;
    const experiencePoints = matchExperienceScore(body.proficiency || viewerParts.profile.experience_level, parts.profile.experience_level);
    const profilePoints = (parts.profile.headline ? 2 : 0) + (parts.profile.bio ? 2 : 0) + (skills.teach.length ? 2 : 0) + (parts.profile.availability ? 1 : 0);
    const score = directPoints + relatedPoints + discoveryPoints + reciprocalPoints + genderPoints + agePoints + contextPoints + languagePoints + experiencePoints + availabilityFit.points + stylePoints + formatPoints + reliabilityPoints + profilePoints;
    const relationship = snapshot.relationship.get(row.id) || "none";
    const publicFields = commonPublicFields(row, parts.profile, parts.preferences, parts.safety, viewer.id, relationship, publicUserCounts(snapshot, row.id));
    const canSeeProfile = Boolean(publicFields.can_view_full);
    const visibleTeach = canSeeProfile ? matchList(publicFields.profile.skills_to_teach) : [];
    const visibleLearn = canSeeProfile ? matchList(publicFields.profile.skills_to_learn) : [];
    const reputation = {
      ...publicFields.reputation,
      completed_sessions: Math.max(Number(publicFields.reputation?.completed_sessions || 0), completedSessions),
      reliability_known: Boolean(publicFields.reputation?.reliability_known || completedSessions),
      reliability_score: completedSessions ? Math.max(Number(publicFields.reputation?.reliability_score || 0), 100) : Number(publicFields.reputation?.reliability_score || 0)
    };
    const reasons = [
      direct
        ? {label: "Direct learning fit", points: directPoints, max_points: 58, explanation: `${publicFields.profile.display_name} teaches ${direct.found}, which is what you want to learn.`}
        : related
          ? {label: "Related skill group", points: relatedPoints, max_points: 42, explanation: `${publicFields.profile.display_name} teaches ${related.found}, a related skill in the ${related.family} group.`}
          : {label: "Broader discovery", points: discoveryPoints, max_points: 12, explanation: "No exact skill was required; this member is still surfaced using language, goals, availability, profile context, and exchange history."},
      {label: "Two-way potential", points: reciprocalPoints, max_points: 14, explanation: reciprocal ? `They also want to learn ${reciprocal.found}, which you can teach.` : "A reciprocal offer is optional; a one-way learning fit is enough to request a swap."},
      {label: "Learning goal and interests", points: contextPoints, max_points: 7, explanation: contextFit ? `Your goals or interests overlap with ${contextFit.found}.` : "No goal or interest overlap was found, so this factor did not change the order."},
      {label: "Shared language", points: languagePoints, max_points: 8, explanation: languageOverlap ? `You share ${languageOverlap.found} for the conversation.` : "No shared session language was found."},
      {label: "Availability and timezone", points: availabilityFit.points, max_points: 8, explanation: availabilityFit.same_timezone && availabilityFit.shared_window ? "The listed timezones and availability windows look compatible." : availabilityFit.same_timezone ? "The listed timezones match; confirm a window in chat." : availabilityFit.shared_window ? "The listed availability windows overlap; confirm the timezone in chat." : "Availability can be confirmed before scheduling."},
      {label: "Experience level", points: experiencePoints, max_points: 5, explanation: experiencePoints ? "The experience levels are compatible for a useful first exchange." : "Experience level was not used for this result."},
      {label: "Teaching style", points: stylePoints, max_points: 5, explanation: stylePoints ? "Their teaching style matches the style you selected." : "Teaching style is available for you to confirm in the conversation."},
      {label: "Session format", points: formatPoints, max_points: 5, explanation: formatPoints ? "Their preferred format fits the format you selected." : "Session format can be agreed after the request."},
      {label: "Completed exchanges", points: reliabilityPoints, max_points: 6, explanation: completedSessions ? `${completedSessions} completed exchange${completedSessions === 1 ? "" : "s"} add a small reliability boost.` : "No completed exchange history yet; new members remain eligible."},
      ...(useDemographicPreferences ? [
        {label: "Optional gender affinity", points: genderPoints, max_points: 4, explanation: sameGender ? "The profiles share the same optional gender preference." : "No optional gender affinity boost was applied."},
        {label: "Optional age proximity", points: agePoints, max_points: 8, explanation: sameAgeBand ? `Both profiles are in the ${ageBand.label} age band.` : ageDistance === 1 ? "The profiles are in adjacent broad age bands." : "Age proximity did not change the order."}
      ] : []),
      {label: "Profile context", points: profilePoints, max_points: 7, explanation: profilePoints >= 5 ? "This member has enough context to make the introduction practical." : "A lighter profile means more can be confirmed in chat."}
    ];
    const topReasons = [];
    if (direct) topReasons.push(`Teaches ${direct.found}, your requested learning skill.`);
    else if (related) topReasons.push(`Teaches ${related.found}, a related skill in the ${related.family} group.`);
    else topReasons.push("Broader discovery result: goals, language, timing, and profile context still make this member worth considering.");
    if (reciprocal) topReasons.push(`Can also learn ${reciprocal.found} from you, so no credits transfer at the end.`);
    else if (bestLearningFit) topReasons.push("One-way exchange: 1 credit transfers from the learner to the teacher after both reports are complete.");
    if (contextFit && !direct && !related) topReasons.push(`Your goals or interests overlap around ${contextFit.found}.`);
    if (availabilityFit.points >= 5) topReasons.push("The listed timezone or availability windows look practical for a first session.");
    if (completedSessions) topReasons.push(`${completedSessions} completed exchange${completedSessions === 1 ? "" : "s"} recorded.`);
    if (sameGender && useDemographicPreferences) topReasons.push("Ranked higher for your optional same-gender preference.");
    if (sameAgeBand && useDemographicPreferences) topReasons.push(`Ranked higher for the same broad age band (${ageBand.label}).`);
    if (!topReasons.length) topReasons.push("A broader discovery result based on your member profile.");
    const skillGroup = bestLearningFit?.family || contextFit?.family || "";
    matches.push({
      id: `match_${row.id}`,
      score: Math.max(0, Math.min(100, score)),
      match_quality: matchQuality(score, Boolean(direct), Boolean(related), Boolean(reciprocal)),
      top_reasons: topReasons,
      reasons,
      request_skill: bestLearningFit?.requested || learnSkills[0] || visibleTeach[0] || "a useful skill",
      request_offer: reciprocal?.requested || teachSkills[0] || "",
      exchange_type: exchangeType,
      exchange_credit_rule: exchangeType === "mutual" ? "No credit transfer when both members teach and learn from each other." : exchangeType === "one_way" ? "1 credit transfers from the learner to the teacher after the exchange." : "Confirm the exchange direction with the member before scheduling.",
      availability: {available_now: false, next_overlap_at: null, label: availabilityFit.label, same_timezone: availabilityFit.same_timezone, shared_window: availabilityFit.shared_window},
      candidate: {
        id: row.id,
        username: row.username,
        display_name: publicFields.profile.display_name,
        // Match cards show the same basic identity preview as the directory;
        // private portfolio fields remain locked until access is granted.
        avatar_url: publicAvatarUrl(parts.profile.avatar_url),
        profile_color: publicFields.profile.profile_color || "indigo",
        headline: publicFields.profile.headline || parts.profile.occupation || "SwapLabs member ready for a practical exchange.",
        country: publicFields.profile.country || "",
        skills_to_teach: visibleTeach,
        skills_to_learn: visibleLearn,
        skill_categories: skillGroup ? [skillGroup] : [],
        skill_group: skillGroup,
        reputation,
        profile_private: !canSeeProfile,
        swap_requests_available: !parts.safety.is_minor
      }
    });
  }

  matches.sort((left, right) => right.score - left.score || left.candidate.display_name.localeCompare(right.candidate.display_name, undefined, {sensitivity: "base"}));
  const limited = matches.slice(0, 24);
  return apiResponse({
    ok: true,
    matches: limited,
    empty_state: {message: strict ? "No direct or related teacher was found yet. Turn off exact-fit prioritisation to see broader discovery members." : "No active, discoverable members are available yet. Ask members to turn on ‘Appear in skill matching’ in their profile settings."},
    query: {learn_skills: learnSkills, teach_skills: teachSkills, strict_skill_match: strict, grouped_skill_families: [...new Set([...learnSkills, ...teachSkills].map(skillFamily).filter(Boolean))]},
    updated_at: new Date().toISOString()
  });
}

function publicDirectoryProfile(row) {
  const parts = rowParts(row);
  if (parts.preferences.profile_visibility === "private") return null;
  const profile = parts.profile;
  return {
    id: row.id,
    display_name: profile.display_name || completeName(profile, row.username),
    avatar_url: publicAvatarUrl(profile.avatar_url),
    profile_color: profile.profile_color || "indigo",
    headline: safeText(profile.headline, 140),
    country: parts.preferences.show_location ? safeText(profile.country, 120) : "",
    skills_to_teach: [...csvValues(profile.skills_to_teach), ...csvValues(profile.additional_languages)],
    skills_to_learn: [...csvValues(profile.skills_to_learn), ...csvValues(profile.languages_to_learn)]
  };
}

async function publicContent(request, env) {
  const db = dbFor(env);
  const rows = (await allUserRows(db)).filter(row => row.role === "member" && row.status === "active");
  const profiles = rows.map(publicDirectoryProfile).filter(Boolean);
  const members = profiles.map(member => ({
    href: `member-profile.html?id=${encodeURIComponent(member.id)}`,
    detail: member.skills_to_teach.length ? `${member.skills_to_teach.length} skill${member.skills_to_teach.length === 1 ? "" : "s"} to teach` : "Public member profile",
    title: member.display_name,
    description: [member.headline, member.country].filter(Boolean).join(" · ") || "A public SwapLabs member profile."
  }));
  const skillCounts = new Map();
  profiles.forEach(member => [...member.skills_to_teach, ...member.skills_to_learn].forEach(skill => {
    const key = skill.toLowerCase();
    const current = skillCounts.get(key);
    skillCounts.set(key, {title: current?.title || skill, count: (current?.count || 0) + 1});
  }));
  const skills = [...skillCounts.values()]
    .sort((first, second) => second.count - first.count || first.title.localeCompare(second.title))
    .slice(0, 60)
    .map(skill => ({
      href: "browse-skills.html",
      detail: `Listed by ${skill.count} public member${skill.count === 1 ? "" : "s"}`,
      title: skill.title,
      description: "A skill currently listed by a public SwapLabs member profile."
    }));
  const workshopResult = await db.prepare("SELECT * FROM sl_workshops WHERE status = 'scheduled' AND starts_at >= ? ORDER BY starts_at ASC LIMIT 24").bind(new Date().toISOString()).all();
  const workshops = (workshopResult.results || []).map(workshop => ({
    href: `workshops.html?id=${encodeURIComponent(workshop.id)}`,
    detail: `Scheduled · ${safeText(workshop.starts_at, 40).slice(0, 10)}`,
    title: workshop.title,
    description: workshop.description || "A scheduled SwapLabs workshop."
  }));
  const ideaRows = (await appRecords(db, "ideas", null)).filter(idea => ["published", "public", "approved", ""].includes(String(idea.status || "published")));
  const ideas = ideaRows.map(idea => ({
    href: `skill-innovation.html#idea-${encodeURIComponent(idea.id)}`,
    detail: `Published idea · ${safeText(idea.created_at, 40).slice(0, 10)}`,
    title: idea.title || "SwapLabs idea",
    description: idea.summary || idea.description || "A published idea from the SwapLabs community."
  }));
  const groupRows = (await db.prepare("SELECT id, title, description, category FROM sl_community_groups ORDER BY updated_at DESC LIMIT 24").all()).results || [];
  const groups = groupRows.map(group => ({
    href: `community.html#communityGroups`,
    detail: group.category || "Community group",
    title: group.title,
    description: group.description || "A SwapLabs community group."
  }));
  return apiResponse({ok: true, groups, workshops, ideas, members, skills, updated_at: new Date().toISOString()});
}

async function publicTestimonials(request, env) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 24)));
  const rows = (await appRecords(dbFor(env), "feedback", null))
    .filter(item => Boolean(item.permission_to_publish || item.publication_permission) && !["private", "archived"].includes(String(item.status || "published")))
    .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")))
    .slice(0, limit)
    .map(item => ({
      id: item.id,
      name: item.name || "SwapLabs member",
      role: item.role || "Community member",
      title: item.title || "Member feedback",
      message: item.message || "",
      rating: Number(item.rating || 0),
      featured: Boolean(item.featured),
      created_at: item.created_at || null,
      demo_content: Boolean(item.demo_content)
    }));
  return apiResponse({ok: true, testimonials: rows, updated_at: new Date().toISOString()});
}

async function publicLeaderboard(request, env) {
  const db = dbFor(env);
  const rows = await allUserRows(db);
  const eligible = rows.map(row => ({row, parts: rowParts(row)})).filter(({row, parts}) =>
    row.role === "member" && row.status === "active" && parts.preferences.profile_visibility !== "private"
  );
  eligible.sort((left, right) => {
    const creditDifference = Number(right.row.time_credits || 0) - Number(left.row.time_credits || 0);
    if (creditDifference) return creditDifference;
    const leftName = completeName(left.parts.profile, left.row.username);
    const rightName = completeName(right.parts.profile, right.row.username);
    return leftName.localeCompare(rightName, undefined, {sensitivity: "base"});
  });
  const leaders = eligible.map(({row, parts}, index) => {
    const publicFields = commonPublicFields(row, parts.profile, parts.preferences, parts.safety, null, "none", {followers_count: 0, following_count: 0});
    return {
      id: row.id,
      rank: index + 1,
      display_name: publicFields.profile.display_name,
      username: row.username,
      avatar_url: publicAvatarUrl(parts.profile.avatar_url),
      profile_color: publicFields.profile.profile_color,
      headline: publicFields.profile.headline || publicFields.profile.occupation || "SwapLabs member",
      skills_to_teach: publicFields.profile.skills_to_teach || [],
      skills_to_learn: publicFields.profile.skills_to_learn || [],
      credits: Number(row.time_credits || 0),
      reputation: publicFields.reputation
    };
  });
  const totalCredits = leaders.reduce((total, member) => total + member.credits, 0);
  return apiResponse({
    ok: true,
    leaders,
    stats: {
      total_credits: totalCredits,
      average_credits: leaders.length ? Math.round(totalCredits / leaders.length) : 0,
      ranked_members: leaders.length
    },
    updated_at: new Date().toISOString()
  });
}

// The first hosted migration only needed the identity, community, workshop,
// course, messaging, and livestream tables. The rest of the UI was still
// calling the old browser demo API, which meant a successful-looking write
// could disappear on refresh. These helpers provide a durable D1-backed record
// layer for the remaining product surfaces while keeping identity and access
// control in the typed tables above.
async function appRecords(db, collection, ownerId) {
  const result = ownerId == null
    ? await db.prepare("SELECT record_json FROM sl_app_records WHERE collection = ? ORDER BY updated_at DESC").bind(collection).all()
    : await db.prepare("SELECT record_json FROM sl_app_records WHERE collection = ? AND owner_id = ? ORDER BY updated_at DESC").bind(collection, ownerId).all();
  return (result.results || []).map(row => parseJson(row.record_json, {}));
}

const ASSISTANT_HISTORY_COLLECTION = "assistant_history";
const ASSISTANT_HISTORY_MESSAGE_LIMIT = 200;
const ASSISTANT_HISTORY_REMINDER_LIMIT = 100;

function assistantHistorySender(value) {
  const sender = isObject(value) ? value : {};
  const profile = isObject(sender.profile) ? sender.profile : {};
  return {
    display_name: safeText(sender.display_name || profile.display_name, 120),
    username: safeText(sender.username, 120),
    profile_color: safeText(sender.profile_color || profile.profile_color, 30),
    profile: {
      display_name: safeText(profile.display_name || sender.display_name, 120),
      profile_color: safeText(profile.profile_color || sender.profile_color, 30),
      avatar_url: safeText(profile.avatar_url || sender.avatar_url, 500)
    }
  };
}

function assistantHistoryMetadata(value) {
  const metadata = isObject(value) ? value : {};
  return {
    article_title: safeText(metadata.article_title, 180),
    confidence: Number.isFinite(Number(metadata.confidence)) ? Number(metadata.confidence) : undefined,
    links: jsonArray(metadata.links, []).slice(0, 8).map(link => isObject(link) ? {
      href: safeText(link.href, 500),
      label: safeText(link.label, 180),
      icon: safeText(link.icon, 80)
    } : null).filter(Boolean),
    followups: jsonArray(metadata.followups, []).slice(0, 6).map(item => safeText(item, 240)).filter(Boolean),
    interpreted_as: jsonArray(metadata.interpreted_as, []).slice(0, 8).map(item => safeText(item, 120)).filter(Boolean)
  };
}

function normalizeAssistantHistoryMessages(value) {
  return jsonArray(value, []).slice(-ASSISTANT_HISTORY_MESSAGE_LIMIT).map(item => {
    if (!isObject(item)) return null;
    const senderKind = ["member", "bot", "system"].includes(String(item.sender_kind)) ? String(item.sender_kind) : "bot";
    return {
      id: safeText(item.id, 180) || newId("ai_msg"),
      conversation_id: safeText(item.conversation_id, 180) || "relayskills-ai-assistant",
      sender_id: safeText(item.sender_id, 180),
      sender_kind: senderKind,
      sender: assistantHistorySender(item.sender),
      body: safeText(item.body, 20_000),
      metadata: assistantHistoryMetadata(item.metadata),
      read_by: jsonArray(item.read_by, []).slice(0, 20).map(id => safeText(id, 180)).filter(Boolean),
      created_at: safeText(item.created_at, 80) || new Date().toISOString()
    };
  }).filter(item => item && item.body);
}

function normalizeAssistantHistoryReminders(value) {
  return jsonArray(value, []).slice(-ASSISTANT_HISTORY_REMINDER_LIMIT).map(item => {
    if (!isObject(item)) return null;
    return {
      id: safeText(item.id, 180) || newId("reminder"),
      task: safeText(item.task, 500),
      due_at: safeText(item.due_at, 80),
      created_at: safeText(item.created_at, 80) || new Date().toISOString(),
      completed: Boolean(item.completed),
      dismissed: Boolean(item.dismissed),
      notified_at: safeText(item.notified_at, 80),
      calendar_event_id: safeText(item.calendar_event_id, 180),
      calendar_saved_at: safeText(item.calendar_saved_at, 80)
    };
  }).filter(item => item && item.task && item.due_at);
}

async function appRecord(db, collection, recordId) {
  const row = await db.prepare("SELECT record_json FROM sl_app_records WHERE collection = ? AND record_id = ? LIMIT 1").bind(collection, recordId).first();
  return row ? parseJson(row.record_json, null) : null;
}

async function saveAppRecord(db, collection, input, ownerId = "") {
  const timestamp = new Date().toISOString();
  const record = {
    ...(isObject(input) ? input : {}),
    id: String(input?.id || newId(collection.replace(/[^a-z0-9]/gi, "") || "record")),
    owner_id: String(input?.owner_id || ownerId || ""),
    created_at: input?.created_at || timestamp,
    updated_at: timestamp
  };
  await db.prepare("INSERT INTO sl_app_records (collection, record_id, owner_id, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(collection, record_id) DO UPDATE SET owner_id = excluded.owner_id, record_json = excluded.record_json, updated_at = excluded.updated_at")
    .bind(collection, record.id, record.owner_id, JSON.stringify(record), record.created_at, record.updated_at).run();
  return record;
}

async function featureDirectCallView(db, call, viewerRow) {
  const viewerId = String(viewerRow?.id || "");
  const participantIds = [...new Set([
    call?.caller_id,
    call?.callee_id,
    ...jsonArray(call?.participant_ids, [])
  ].map(value => String(value || "")).filter(Boolean))];
  const participants = (await Promise.all(participantIds.map(memberId => featureMemberView(db, memberId, viewerId)))).filter(Boolean);
  return {
    ...call,
    participant_ids: participantIds,
    pending_ids: jsonArray(call?.pending_ids, []),
    accepted_ids: jsonArray(call?.accepted_ids, []),
    declined_ids: jsonArray(call?.declined_ids, []),
    participants,
    caller: participants.find(member => member.id === call.caller_id) || null,
    callee: participants.find(member => member.id === call.callee_id) || null,
    viewer_role: call.caller_id === viewerId ? "caller" : call.callee_id === viewerId ? "callee" : "participant",
    viewer_is_participant: participantIds.includes(viewerId),
    viewer_is_pending: jsonArray(call?.pending_ids, []).includes(viewerId),
    viewer_has_accepted: jsonArray(call?.accepted_ids, []).includes(viewerId)
  };
}

async function updateDirectCallMessage(db, call, status, extra = {}) {
  if (!call?.message_id) return;
  const row = await db.prepare("SELECT metadata_json FROM sl_messages WHERE id = ? LIMIT 1").bind(call.message_id).first();
  if (!row) return;
  const metadata = parseJson(row.metadata_json, {});
  await db.prepare("UPDATE sl_messages SET metadata_json = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify({...metadata, status, ...extra}), new Date().toISOString(), call.message_id).run();
}

async function deleteAppRecord(db, collection, recordId) {
  await db.prepare("DELETE FROM sl_app_records WHERE collection = ? AND record_id = ?").bind(collection, recordId).run();
}

function featureEventView(event) {
  return {
    ...event,
    participant_ids: jsonArray(event.participant_ids, []),
    participants: jsonArray(event.participants, []),
    reminders_minutes: jsonArray(event.reminders_minutes, [60]),
    all_day: Boolean(event.all_day),
    status: event.status || "scheduled",
    viewer_can_edit: true,
    viewer_can_complete: event.status === "scheduled" && new Date(event.ends_at || 0).getTime() <= Date.now(),
    viewer_can_rate: event.status === "completed"
  };
}

function featureParticipantIds(event) {
  return [...new Set([
    ...jsonArray(event?.participant_ids, []),
    ...jsonArray(event?.participants, []).map(member => typeof member === "string" ? member : member?.id)
  ].map(value => String(value || "")).filter(Boolean))];
}

function featureDirectionalSkillFit(teacherRow, learnerRow) {
  if (!teacherRow || !learnerRow) return null;
  const teacherSkills = profileMatchSkills(rowParts(teacherRow).profile);
  const learnerSkills = profileMatchSkills(rowParts(learnerRow).profile);
  return matchSkillFit(learnerSkills.learn, teacherSkills.teach);
}

async function featureSessionExchangePlan(db, event, memberIds, memberCache = null) {
  const findMember = memberId => memberCache?.get(String(memberId)) || findUserById(db, memberId);
  const rows = await Promise.all(memberIds.slice(0, 2).map(findMember));
  const first = rows[0];
  const second = rows[1];
  if (!first || !second || memberIds.length !== 2) {
    return {mode: "standard_fee", payer_id: event.credit_payer_id || event.host_id || "", recipient_id: "", fit: null};
  }
  const firstTeachesSecond = featureDirectionalSkillFit(first, second);
  const secondTeachesFirst = featureDirectionalSkillFit(second, first);
  if (firstTeachesSecond && secondTeachesFirst) {
    return {mode: "mutual", payer_id: "", recipient_id: "", fit: null};
  }
  if (firstTeachesSecond) {
    return {mode: "one_way", payer_id: second.id, recipient_id: first.id, fit: firstTeachesSecond};
  }
  if (secondTeachesFirst) {
    return {mode: "one_way", payer_id: first.id, recipient_id: second.id, fit: secondTeachesFirst};
  }
  return {mode: "standard_fee", payer_id: event.credit_payer_id || event.host_id || "", recipient_id: "", fit: null};
}

async function featureMemberView(db, memberId, viewerId, memberCache = null) {
  const row = memberCache ? (memberCache.get(String(memberId)) || null) : await findUserById(db, memberId);
  if (!row) return null;
  const parts = rowParts(row);
  const view = commonPublicFields(row, parts.profile, parts.preferences, parts.safety, viewerId, "none", {followers_count: 0, following_count: 0});
  return {...view, display_name: view.profile?.display_name || row.username, profile_color: view.profile?.profile_color || "indigo", avatar_url: view.profile?.avatar_url || ""};
}

async function featureEventViewFor(db, event, viewerRow, context = null) {
  const viewerId = viewerRow?.id || "";
  const participantIds = featureParticipantIds(event);
  const memberIds = [...new Set([event?.host_id, ...participantIds].filter(Boolean))];
  const [host, participants, ratings, reports, pointReviews] = await Promise.all([
    featureMemberView(db, event?.host_id, viewerId, context?.memberCache || null),
    Promise.all(participantIds.map(memberId => featureMemberView(db, memberId, viewerId, context?.memberCache || null))).then(items => items.filter(Boolean)),
    context?.ratings || appRecords(db, "session_ratings", null),
    context?.reports || appRecords(db, "session_progress_reports", null),
    context?.pointReviews || appRecords(db, "session_point_reviews", null)
  ]);
  const eventRatings = ratings.filter(item => item.event_id === event.id);
  const eventReports = reports.filter(item => item.event_id === event.id && memberIds.includes(item.reporter_id));
  const viewerRating = eventRatings.find(item => item.rater_id === viewerId) || null;
  const viewerReport = eventReports.find(item => item.reporter_id === viewerId) || null;
  const review = pointReviews.find(item => item.event_id === event.id) || null;
  const ended = new Date(event.ends_at || 0).getTime() <= Date.now();
  const progressStatus = event.credit_status || (event.status === "completed" ? (eventReports.length ? "partially_reported" : "awaiting_reports") : "not_started");
  const exchangePlan = await featureSessionExchangePlan(db, event, memberIds, context?.memberCache || null);
  const progressSummary = {
    required_count: memberIds.length,
    submitted_count: eventReports.length,
    all_submitted: memberIds.length >= 2 && eventReports.length >= memberIds.length,
    viewer_submitted: Boolean(viewerReport),
    viewer_report_id: viewerReport?.id || "",
    status: progressStatus,
    session_cost_credits: EXCHANGE_CREDIT_AMOUNT,
    one_way_reward_credits: EXCHANGE_CREDIT_AMOUNT,
    credit_payer_id: event.credit_payer_id || event.host_id || "",
    credit_reward_recipients: jsonArray(event.credit_reward_recipients, []),
    credit_transfer_type: event.credit_transfer_type || exchangePlan.mode,
    credit_transfer_amount: Number(event.credit_transfer_amount || (exchangePlan.mode === "one_way" || exchangePlan.mode === "standard_fee" ? EXCHANGE_CREDIT_AMOUNT : 0)),
    credit_transfer_payer_id: event.credit_transfer_payer_id || exchangePlan.payer_id || "",
    credit_transfer_recipient_id: event.credit_transfer_recipient_id || exchangePlan.recipient_id || "",
    credit_transfer_skill: event.credit_transfer_skill || exchangePlan.fit?.found || exchangePlan.fit?.requested || ""
  };
  const badCount = eventRatings.filter(item => Number(item.rating) <= 2).length;
  const ratingSummary = {
    rating_count: eventRatings.length,
    eligible_count: memberIds.length,
    bad_count: badCount,
    majority_negative: eventRatings.length >= 2 && badCount > eventRatings.length / 2,
    status: review?.status || event.points_status || (eventRatings.length ? "awarded" : "awaiting_ratings"),
    viewer_rating: viewerRating ? {rating: Number(viewerRating.rating), comment: viewerRating.comment || "", points_status: viewerRating.points_status || "awarded", points_awarded: Number(viewerRating.points_awarded || 0)} : null,
    points_review_id: review?.id || event.points_review_id || ""
  };
  return {
    ...featureEventView(event),
    video_invite_token: viewerId && event.host_id === viewerId ? safeText(event.video_invite_token, 180) : "",
    host,
    participants,
    participant_ids: participantIds,
    viewer_is_member: memberIds.includes(viewerId),
    viewer_can_edit: Boolean(viewerId && event.host_id === viewerId && event.status !== "cancelled"),
    viewer_can_complete: Boolean(memberIds.includes(viewerId) && event.status === "scheduled" && ended),
    viewer_can_rate: Boolean(memberIds.includes(viewerId) && memberIds.length >= 2 && event.status === "completed" && !viewerRating),
    viewer_can_report_progress: Boolean(memberIds.includes(viewerId) && memberIds.length >= 2 && event.status === "completed"),
    viewer_rating: ratingSummary.viewer_rating,
    viewer_progress_report: viewerReport,
    rating_summary: ratingSummary,
    progress_summary: progressSummary,
    credit_summary: progressSummary,
    points_review: review ? {id: review.id, status: review.status, reason: review.reason, rating_count: review.rating_count, bad_count: review.bad_count, eligible_count: review.eligible_count, created_at: review.created_at, decided_at: review.decided_at || null} : null
  };
}

async function settleFeatureSessionCredits(db, event, memberIds, memberCache = null) {
  const reference = event.credit_settlement_id || `session-settlement-${event.id}`;
  if (event.credit_status === "settled" && event.credit_settlement_id) {
    return {newlySettled: false, plan: {mode: event.credit_transfer_type || "standard_fee", payer_id: event.credit_transfer_payer_id || "", recipient_id: event.credit_transfer_recipient_id || "", fit: null}, transfer: {type: event.credit_transfer_type || "standard_fee", amount: Number(event.credit_transfer_amount || 0), payer_id: event.credit_transfer_payer_id || "", recipient_id: event.credit_transfer_recipient_id || "", skill: event.credit_transfer_skill || ""}, patch: event};
  }
  const plan = await featureSessionExchangePlan(db, event, memberIds, memberCache);
  const ledger = await appRecords(db, "ledger", null);
  const timestamp = new Date().toISOString();
  let transfer = {type: plan.mode, amount: 0, payer_id: plan.payer_id || "", recipient_id: plan.recipient_id || "", skill: plan.fit?.found || plan.fit?.requested || ""};
  let rewardRecipients = [];

  if (plan.mode === "one_way") {
    const payer = await findUserById(db, plan.payer_id);
    const recipient = await findUserById(db, plan.recipient_id);
    if (payer && recipient && payer.id !== recipient.id) {
      const debitReference = `${reference}:debit`;
      const creditReference = `${reference}:credit`;
      const debitExists = ledger.some(entry => entry.reference_id === debitReference && entry.user_id === payer.id);
      const creditExists = ledger.some(entry => entry.reference_id === creditReference && entry.user_id === recipient.id);
      if (!debitExists && !creditExists) {
        const payerBalance = Number(payer.time_credits || 0) - EXCHANGE_CREDIT_AMOUNT;
        const recipientBalance = Number(recipient.time_credits || 0) + EXCHANGE_CREDIT_AMOUNT;
        await db.batch([
          db.prepare("UPDATE sl_users SET time_credits = ?, updated_at = ? WHERE id = ?").bind(payerBalance, timestamp, payer.id),
          db.prepare("UPDATE sl_users SET time_credits = ?, updated_at = ? WHERE id = ?").bind(recipientBalance, timestamp, recipient.id)
        ]);
        await saveAppRecord(db, "ledger", {id: `${reference}:debit`, user_id: payer.id, type: "session_exchange", amount: -EXCHANGE_CREDIT_AMOUNT, balance_after: payerBalance, description: `1 credit transferred to ${recipient.username} for ${event.title || "a SwapLabs exchange"}`, counterparty_id: recipient.id, reference_id: debitReference, reference_type: "session_exchange_transfer", created_by: payer.id, created_at: timestamp}, payer.id);
        await saveAppRecord(db, "ledger", {id: `${reference}:credit`, user_id: recipient.id, type: "session_exchange", amount: EXCHANGE_CREDIT_AMOUNT, balance_after: recipientBalance, description: `1 credit received from ${payer.username} for ${event.title || "a SwapLabs exchange"}`, counterparty_id: payer.id, reference_id: creditReference, reference_type: "session_exchange_transfer", created_by: payer.id, created_at: timestamp}, recipient.id);
      }
      transfer = {type: "one_way", amount: EXCHANGE_CREDIT_AMOUNT, payer_id: payer.id, recipient_id: recipient.id, skill: plan.fit?.found || plan.fit?.requested || ""};
      rewardRecipients = [{teacher_id: recipient.id, learner_id: payer.id, skill: transfer.skill, kind: plan.fit?.kind || "direct", family: plan.fit?.family || "", amount: EXCHANGE_CREDIT_AMOUNT}];
    } else {
      plan.mode = "standard_fee";
      transfer = {type: "standard_fee", amount: EXCHANGE_CREDIT_AMOUNT, payer_id: event.credit_payer_id || event.host_id || "", recipient_id: "", skill: ""};
    }
  }

  if (plan.mode === "standard_fee") {
    const payer = await findUserById(db, transfer.payer_id);
    const feeReference = `${reference}:fee`;
    if (payer && !ledger.some(entry => entry.reference_id === feeReference && entry.user_id === payer.id)) {
      const balance = Number(payer.time_credits || 0) - EXCHANGE_CREDIT_AMOUNT;
      await db.prepare("UPDATE sl_users SET time_credits = ?, updated_at = ? WHERE id = ?").bind(balance, timestamp, payer.id).run();
      await saveAppRecord(db, "ledger", {id: `${reference}:fee`, user_id: payer.id, type: "session_fee", amount: -EXCHANGE_CREDIT_AMOUNT, balance_after: balance, description: `1-credit exchange fee for ${event.title || "SwapLabs session"}`, reference_id: feeReference, reference_type: "session_fee", created_by: payer.id, created_at: timestamp}, payer.id);
      transfer.payer_id = payer.id;
    }
  }

  const patch = {
    credit_status: "settled",
    credit_settlement_id: reference,
    credit_settlement_at: timestamp,
    credit_transfer_type: transfer.type,
    credit_transfer_amount: transfer.amount,
    credit_transfer_payer_id: transfer.payer_id || "",
    credit_transfer_recipient_id: transfer.recipient_id || "",
    credit_transfer_skill: transfer.skill || "",
    credit_reward_recipients: rewardRecipients
  };
  return {newlySettled: true, plan, transfer, patch};
}

function featureRoomParticipantIds(room, event) {
  return [...new Set([
    room?.host_id,
    ...jsonArray(room?.participant_ids, []),
    ...jsonArray(room?.participants, []).map(member => typeof member === "string" ? member : member?.id),
    event?.host_id,
    ...featureParticipantIds(event || {})
  ].map(value => String(value || "")).filter(Boolean))];
}

function videoGuestSession(request, room) {
  const token = safeText(request?.headers?.get("x-relayskills-guest-token"), 180);
  if (!token) return null;
  return jsonArray(room?.guest_sessions, []).find(session => session?.token === token && session?.guest_id) || null;
}

async function ensureVideoRoomInvite(db, room, ownerId = "") {
  if (!room) return room;
  if (room.invite_token) return room;
  const saved = await saveAppRecord(db, "video_rooms", {
    ...room,
    invite_token: randomToken(24),
    guest_access: true,
    guest_participants: jsonArray(room.guest_participants, []),
    guest_sessions: jsonArray(room.guest_sessions, [])
  }, room.owner_id || ownerId);
  if (saved.event_id) {
    const event = await appRecord(db, "events", saved.event_id);
    if (event && event.video_invite_token !== saved.invite_token) {
      await saveAppRecord(db, "events", {...event, video_room_id: saved.id, video_invite_token: saved.invite_token}, event.owner_id || event.host_id || saved.owner_id || ownerId);
    }
  }
  return saved;
}

function featureGuestView(guest, viewerId = "") {
  if (!guest?.id) return null;
  const displayName = safeText(guest.display_name || "Guest", 80) || "Guest";
  return {
    id: String(guest.id),
    username: safeText(guest.username || "guest", 80) || "guest",
    display_name: displayName,
    full_name: displayName,
    avatar_url: "",
    profile_color: ["indigo", "blue", "pink", "purple", "green", "orange"].includes(guest.profile_color) ? guest.profile_color : "blue",
    role: "guest",
    status: "active",
    relationship: String(guest.id) === String(viewerId || "") ? "self" : "none",
    followers_count: 0,
    following_count: 0,
    profile: {display_name: displayName, profile_color: guest.profile_color || "blue", avatar_url: ""}
  };
}

async function featureVideoInvitePreview(db, room) {
  const host = room?.host_id ? await findUserById(db, room.host_id) : null;
  const hostParts = host ? rowParts(host) : null;
  return {
    room_id: room.id,
    title: room.title || "SwapLabs video room",
    status: room.status || "ready",
    waiting_room_enabled: room.waiting_room_enabled !== false,
    starts_at: room.event_id ? (await appRecord(db, "events", room.event_id))?.starts_at || "" : "",
    host: host ? {
      display_name: hostParts.profile.display_name || completeName(hostParts.profile, host.username),
      username: host.username,
      avatar_url: publicAvatarUrl(hostParts.profile.avatar_url),
      profile_color: hostParts.profile.profile_color || "indigo"
    } : {display_name: "SwapLabs host", username: "", avatar_url: "", profile_color: "indigo"}
  };
}

async function featureVideoRoomView(db, room, viewerRow, context = null) {
  room = await ensureVideoRoomInvite(db, room);
  const viewerId = context?.viewer_id || viewerRow?.id || "";
  const event = room?.event_id ? await appRecord(db, "events", room.event_id) : null;
  const participantIds = featureRoomParticipantIds(room, event);
  const guestById = new Map(jsonArray(room.guest_participants, []).map(guest => [String(guest?.id || ""), guest]).filter(([id]) => id));
  const memberRows = context?.memberCache
    ? participantIds.map(memberId => context.memberCache.get(String(memberId)) || null)
    : await Promise.all(participantIds.map(memberId => findUserById(db, memberId)));
  const memberById = new Map(memberRows.filter(Boolean).map(row => [row.id, row]));
  const members = participantIds.map(memberId => {
    const row = memberById.get(memberId);
    if (!row) return featureGuestView(guestById.get(String(memberId)), viewerId);
    const parts = rowParts(row);
    return commonPublicFields(row, parts.profile, parts.preferences, parts.safety, viewerId, "none", {followers_count: 0, following_count: 0});
  }).filter(Boolean);
  const attendance = jsonArray(room.attendance, []).map(record => ({
    ...record,
    member: members.find(member => member.id === record.user_id) || null
  }));
  const enrichedEvent = event ? await featureEventViewFor(db, event, viewerRow, context) : null;
  const safeRoom = {...room};
  delete safeRoom.guest_sessions;
  delete safeRoom.guest_participants;
  delete safeRoom.invite_token;
  return {
    ...safeRoom,
    invite_token: viewerId && viewerId === room.host_id ? String(room.invite_token || "") : "",
    participant_ids: participantIds,
    participants: members,
    attendance,
    signals: jsonArray(room.signals, []),
    status: room.status || "ready",
    waiting_room_enabled: Boolean(room.waiting_room_enabled),
    screen_sharing_enabled: Boolean(room.screen_sharing_enabled),
    video_enabled: room.video_enabled !== false,
    audio_enabled: room.audio_enabled !== false,
    viewer_is_host: Boolean(viewerId && viewerId === room.host_id),
    viewer_is_participant: participantIds.includes(viewerId),
    viewer_is_guest: Boolean(viewerId && guestById.has(String(viewerId))),
    event: enrichedEvent
  };
}

function featureIdeaView(idea, viewerId) {
  const likes = jsonArray(idea.like_user_ids, []);
  const saves = jsonArray(idea.save_user_ids, []);
  return {
    ...idea,
    skills_needed: jsonArray(idea.skills_needed, []),
    comments: jsonArray(idea.comments, []),
    pledges: jsonArray(idea.pledges, []),
    like_count: Number(idea.like_count || likes.length),
    save_count: Number(idea.save_count || saves.length),
    comment_count: Number(idea.comment_count || jsonArray(idea.comments, []).length),
    viewer_liked: Boolean(viewerId && likes.includes(viewerId)),
    viewer_saved: Boolean(viewerId && saves.includes(viewerId)),
    owner: idea.owner || null
  };
}

function featureAchievementBadges(user, pinnedIds = []) {
  const profile = user?.profile || {};
  const hasTeach = csvValues(profile.skills_to_teach).length > 0;
  const hasLearn = csvValues(profile.skills_to_learn).length > 0;
  return [
    {id: "profile-ready", title: "Profile ready", description: "Complete the essential parts of your member profile.", icon: "bx-user-check", target: 100, current: profileCompleteness(profile), earned: profileCompleteness(profile) >= 100},
    {id: "teacher", title: "Open hand", description: "List at least one skill you can teach.", icon: "bx-chalkboard", target: 1, current: hasTeach ? 1 : 0, earned: hasTeach},
    {id: "learner", title: "Curious mind", description: "Add a skill you want to learn.", icon: "bx-book-open", target: 1, current: hasLearn ? 1 : 0, earned: hasLearn},
    {id: "first-session", title: "First exchange", description: "Complete your first scheduled exchange.", icon: "bx-transfer-alt", target: 1, current: 0, earned: false}
  ].map(badge => ({...badge, progress: Math.min(100, Math.round((Number(badge.current || 0) / Math.max(1, Number(badge.target || 1))) * 100)), pinned: pinnedIds.includes(badge.id)}));
}

async function blogMediaUpload(env, files, prefix) {
  const uploads = Array.isArray(files) ? files.filter(file => file && typeof file.arrayBuffer === "function") : [];
  if (!uploads.length) return [];
  if (!env || !env.BUCKET) throw Object.assign(new Error("Blog media storage is temporarily unavailable."), {status: 503});
  if (uploads.length > 4) throw Object.assign(new Error("Add up to four images or videos."), {status: 400});

  const uploaded = [];
  let totalBytes = 0;
  try {
    for (let index = 0; index < uploads.length; index += 1) {
      const file = uploads[index];
      const contentType = String(file.type || "").toLowerCase();
      const extension = ALLOWED_COMMUNITY_MEDIA_TYPES.get(contentType);
      const size = Number(file.size || 0);
      if (!extension) throw Object.assign(new Error("Choose a JPG, PNG, WebP, MP4, or WebM file."), {status: 400});
      if (size <= 0 || size > 2_500_000) throw Object.assign(new Error("Each image or video must be 2.5 MB or smaller."), {status: 400});
      totalBytes += size;
      if (totalBytes > 8_000_000) throw Object.assign(new Error("Keep the combined blog media under 8 MB."), {status: 400});
      const key = `community-media/blog_${safeText(prefix, 80).replace(/[^A-Za-z0-9_-]/g, "_")}_${index}.${extension}`;
      await env.BUCKET.put(key, await file.arrayBuffer(), {httpMetadata: {contentType, cacheControl: "public, max-age=86400, stale-while-revalidate=604800"}});
      uploaded.push({key, contentType, type: contentType.startsWith("video/") ? "video" : "image", name: safeText(file.name, 160) || `Blog media ${index + 1}`, size});
    }
  } catch (error) {
    await Promise.all(uploaded.map(item => env.BUCKET.delete(item.key).catch(() => null)));
    throw error;
  }
  return uploaded.map(item => ({url: "/" + item.key, type: item.type, content_type: item.contentType, name: item.name, size: item.size}));
}

async function featureApi(request, env, path) {
  const db = dbFor(env);
  await ensureFeatureSchema(db);
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const viewerRow = await sessionUser(request, env);
  const viewer = viewerRow ? selfUser(viewerRow) : null;
  const requireViewer = () => viewerRow ? null : apiResponse({error: "Please log in to use this feature."}, 401);
  const body = ["POST", "PATCH", "PUT", "DELETE"].includes(method) ? await readFeatureBody(request, path) : {};
  const timestamp = () => new Date().toISOString();

  if (path === "/api/calendar" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    const rows = (await appRecords(db, "events", null)).filter(event => event.host_id === viewerRow.id || jsonArray(event.participant_ids, []).includes(viewerRow.id));
    const availability = await appRecord(db, "availability", viewerRow.id) || {id: viewerRow.id, timezone: viewer.profile.timezone || "UTC", buffer_minutes: 15, weekly: {}};
    const allMembers = await allUserRows(db);
    const follow = await followSnapshot(db, viewerRow.id);
    const eventContext = {
      ratings: await appRecords(db, "session_ratings", null),
      reports: await appRecords(db, "session_progress_reports", null),
      pointReviews: await appRecords(db, "session_point_reviews", null),
      memberCache: new Map(allMembers.map(row => [String(row.id), row]))
    };
    const contacts = allMembers.filter(row => row.id !== viewerRow.id && row.role === "member" && row.status === "active").map(row => {
      const parts = rowParts(row);
      const relationship = follow.relationship.get(row.id) || "none";
      return commonPublicFields(row, parts.profile, parts.preferences, parts.safety, viewerRow.id, relationship, publicUserCounts(follow, row.id));
    }).filter(member => ["following", "follower", "mutual"].includes(member.relationship));
    const events = await Promise.all(rows.map(async event => {
      let currentEvent = event;
      if (event.video_room_id) {
        const room = await appRecord(db, "video_rooms", event.video_room_id);
        const ensuredRoom = await ensureVideoRoomInvite(db, room, viewerRow.id);
        if (ensuredRoom?.invite_token && event.video_invite_token !== ensuredRoom.invite_token) {
          currentEvent = await saveAppRecord(db, "events", {
            ...event,
            video_room_id: ensuredRoom.id,
            video_invite_token: ensuredRoom.invite_token
          }, event.owner_id || event.host_id || viewerRow.id);
        }
      }
      return featureEventViewFor(db, currentEvent, viewerRow, eventContext);
    }));
    return apiResponse({events, contacts, contact_scope: "followers_or_following", availability});
  }
  if (path === "/api/calendar/availability" && ["GET", "PATCH"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    if (method === "GET") return apiResponse({availability: await appRecord(db, "availability", viewerRow.id) || {id: viewerRow.id, timezone: viewer.profile.timezone || "UTC", buffer_minutes: 15, weekly: {}}});
    const availability = await saveAppRecord(db, "availability", {id: viewerRow.id, ...body}, viewerRow.id);
    return apiResponse({availability, message: "Availability saved."});
  }
  const calendarEvent = /^\/api\/calendar\/events(?:\/([^/]+))?(?:\/(ics|rating|progress-report|duplicate))?$/.exec(path);
  if (calendarEvent) {
    const denied = requireViewer(); if (denied) return denied;
    const eventId = calendarEvent[1] ? decodeURIComponent(calendarEvent[1]) : "";
    const action = calendarEvent[2] || "detail";
    if (!eventId && method === "POST") {
      const starts = body.starts_at || new Date(Date.now() + 86_400_000).toISOString();
      const conversationId = safeText(body.conversation_id, 120);
      if (conversationId && !await conversationAccess(db, conversationId, viewerRow.id)) return apiResponse({error: "That conversation is not available for scheduling."}, 403);
      const event = await saveAppRecord(db, "events", {id: newId("event"), ...body, title: safeText(body.title || "SwapLabs session", 180), host_id: viewerRow.id, participant_ids: [...new Set(jsonArray(body.participant_ids, Array.isArray(body.participant_ids) ? body.participant_ids : []))], starts_at: starts, ends_at: body.ends_at || new Date(new Date(starts).getTime() + 3_600_000).toISOString(), status: "scheduled", session_cost_credits: EXCHANGE_CREDIT_AMOUNT, one_way_reward_credits: EXCHANGE_CREDIT_AMOUNT, credit_payer_id: viewerRow.id, credit_status: "not_started", credit_reward_recipients: [], credit_transfer_type: "", credit_transfer_amount: 0, credit_transfer_payer_id: "", credit_transfer_recipient_id: "", credit_transfer_skill: "", created_at: timestamp()}, viewerRow.id);
      const eventView = await featureEventViewFor(db, event, viewerRow);
      if (conversationId) {
        const createdAt = timestamp();
        await db.batch([
          db.prepare("INSERT INTO sl_messages (id, conversation_id, sender_id, body, metadata_json, moderation_status, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'visible', 0, ?, ?)").bind(newId("msg"), conversationId, viewerRow.id, "Session scheduled.", JSON.stringify({type: "calendar_event", event_id: event.id, event: eventView, calendar_action: "scheduled"}), createdAt, createdAt),
          db.prepare("UPDATE sl_conversations SET updated_at = ? WHERE id = ?").bind(createdAt, conversationId)
        ]);
      }
      await Promise.all(featureParticipantIds(event).filter(memberId => memberId !== viewerRow.id).map(memberId => createNotification(db, {
        userId: memberId,
        actorId: viewerRow.id,
        type: "calendar_event",
        entityId: event.id,
        message: `${viewerRow.username} scheduled “${event.title}” with you.`
      })));
      return apiResponse({event: eventView, message: "Session scheduled."}, 201);
    }
    const event = await appRecord(db, "events", eventId);
    if (!event) return apiResponse({error: "Session not found."}, 404);
    const belongs = event.host_id === viewerRow.id || jsonArray(event.participant_ids, []).includes(viewerRow.id) || viewerRow.role === "admin";
    if (!belongs) return apiResponse({error: "Only session members can access this session."}, 403);
    if (action === "ics" && method === "GET") {
      const escapeIcs = value => String(value || "").replace(/[\\;,\n]/g, character => character === "\n" ? "\\n" : "\\" + character);
      const start = new Date(event.starts_at || Date.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      return new Response(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${event.id}\r\nSUMMARY:${escapeIcs(event.title || "SwapLabs session")}\r\nDTSTART:${start}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`, {headers: {"content-type": "text/calendar; charset=utf-8", "cache-control": "no-store"}});
    }
    if (action === "duplicate" && method === "POST") {
      const duplicate = await saveAppRecord(db, "events", {...event, id: newId("event"), title: `${event.title || "Session"} (copy)`, status: "scheduled", starts_at: new Date(Date.now() + 86_400_000).toISOString(), ends_at: new Date(Date.now() + 90_000_000).toISOString(), session_cost_credits: EXCHANGE_CREDIT_AMOUNT, one_way_reward_credits: EXCHANGE_CREDIT_AMOUNT, credit_payer_id: viewerRow.id, credit_status: "not_started", credit_settlement_id: "", credit_settlement_at: "", credit_reward_recipients: [], credit_transfer_type: "", credit_transfer_amount: 0, credit_transfer_payer_id: "", credit_transfer_recipient_id: "", credit_transfer_skill: "", created_at: timestamp()}, viewerRow.id);
      return apiResponse({event: await featureEventViewFor(db, duplicate, viewerRow), message: "Session duplicated."}, 201);
    }
    if (action === "rating" && method === "GET") {
      const ratings = (await appRecords(db, "session_ratings", null)).filter(item => item.event_id === event.id);
      const viewerRating = ratings.find(item => item.rater_id === viewerRow.id) || null;
      return apiResponse({summary: {average: ratings.length ? Math.round(ratings.reduce((sum, item) => sum + Number(item.rating || 0), 0) / ratings.length * 10) / 10 : null, count: ratings.length, rating_count: ratings.length, viewer_rating: viewerRating}});
    }
    if (action === "rating" && method === "POST") {
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return apiResponse({error: "Choose a rating from 1 to 5."}, 400);
      const memberIds = [...new Set([event.host_id, ...featureParticipantIds(event)].filter(Boolean))];
      if (!memberIds.includes(viewerRow.id)) return apiResponse({error: "Only session members can submit a rating."}, 403);
      if (memberIds.length < 2) return apiResponse({error: "This calendar item does not have another session member to rate."}, 400);
      if (event.status !== "completed") return apiResponse({error: "Confirm the session before rating it."}, 400);
      const previousRatings = (await appRecords(db, "session_ratings", null)).filter(item => item.event_id === event.id);
      if (previousRatings.some(item => item.rater_id === viewerRow.id)) return apiResponse({error: "You have already rated this session."}, 409);
      const record = await saveAppRecord(db, "session_ratings", {id: newId("rating"), event_id: event.id, rater_id: viewerRow.id, rating, comment: safeText(body.comment, 1200)}, viewerRow.id);
      const ratings = [...previousRatings, record];
      return apiResponse({message: "Rating saved.", rating: record, summary: {average: Math.round(ratings.reduce((sum, item) => sum + Number(item.rating || 0), 0) / ratings.length * 10) / 10, count: ratings.length, rating_count: ratings.length, viewer_rating: record}});
    }
    if (action === "progress-report" && ["GET", "POST"].includes(method)) {
      const memberIds = [...new Set([event.host_id, ...featureParticipantIds(event)].filter(Boolean))];
      const reports = (await appRecords(db, "session_progress_reports", null)).filter(item => item.event_id === event.id && memberIds.includes(item.reporter_id));
      const isAdmin = viewerRow.role === "admin";
      if (method === "GET") {
        const report = isAdmin ? null : reports.find(item => item.reporter_id === viewerRow.id) || null;
        return apiResponse({report, reports: isAdmin ? reports : undefined, summary: {required_count: memberIds.length, submitted_count: reports.length, all_submitted: memberIds.length >= 2 && reports.length >= memberIds.length, viewer_submitted: Boolean(report), viewer_report_id: report?.id || "", status: event.credit_status || (event.status === "completed" ? "awaiting_reports" : "not_started"), session_cost_credits: EXCHANGE_CREDIT_AMOUNT, one_way_reward_credits: EXCHANGE_CREDIT_AMOUNT, credit_payer_id: event.credit_payer_id || event.host_id || "", credit_reward_recipients: jsonArray(event.credit_reward_recipients, []), credit_transfer_type: event.credit_transfer_type || "", credit_transfer_amount: Number(event.credit_transfer_amount || 0), credit_transfer_payer_id: event.credit_transfer_payer_id || "", credit_transfer_recipient_id: event.credit_transfer_recipient_id || "", credit_transfer_skill: event.credit_transfer_skill || ""}});
      }
      if (event.status !== "completed") return apiResponse({error: "Confirm the session before submitting its progress report."}, 400);
      if (memberIds.length < 2) return apiResponse({error: "This session needs two members before progress can be recorded."}, 400);
      const whatHappened = safeText(body.what_happened || body.summary, 4000).trim();
      const progress = safeText(body.progress || body.outcome, 2400).trim();
      const nextStep = safeText(body.next_step, 1200).trim();
      const overallRating = Number(body.overall_rating ?? body.rating);
      if (whatHappened.length < 5) return apiResponse({error: "Describe what happened during the exchange before saving the report."}, 400);
      if (progress.length < 5) return apiResponse({error: "Describe what progress was made before saving the report."}, 400);
      if (!Number.isInteger(overallRating) || overallRating < 1 || overallRating > 5) return apiResponse({error: "Choose an overall session rating from 1 to 5."}, 400);
      const reporterId = isAdmin ? String(body.reporter_id || "") : viewerRow.id;
      if (!memberIds.includes(reporterId)) return apiResponse({error: "Choose a session member whose report is being saved."}, 400);
      const existing = reports.find(item => item.reporter_id === reporterId) || null;
      const report = await saveAppRecord(db, "session_progress_reports", {id: existing?.id || newId("session-progress"), event_id: event.id, reporter_id: reporterId, what_happened: whatHappened, progress, overall_rating: overallRating, next_step: nextStep, created_at: existing?.created_at || timestamp()}, reporterId);
      const journalRows = await appRecords(db, "journals", reporterId);
      const existingJournal = journalRows.find(item => item.source_type === "session_progress_report" && item.source_id === report.id);
      await saveAppRecord(db, "journals", {id: existingJournal?.id || newId("journal"), user_id: reporterId, title: `Session reflection: ${event.title || "SwapLabs session"}`, skill: event.title || "Skill exchange", minutes: Math.max(0, Math.round((new Date(event.ends_at || 0).getTime() - new Date(event.starts_at || 0).getTime()) / 60000)), confidence: overallRating, mood: overallRating >= 4 ? "energized" : overallRating >= 3 ? "curious" : "needs support", visibility: "private", reflection: `What happened: ${whatHappened}\n\nProgress: ${progress}`, next_step: nextStep, source_type: "session_progress_report", source_id: report.id, event_id: event.id, created_at: existingJournal?.created_at || timestamp()}, reporterId);
      const nextReports = [...reports.filter(item => item.id !== report.id), report];
      const allSubmitted = nextReports.length >= memberIds.length;
      const creditStatus = allSubmitted ? (event.credit_status === "settled" ? "settled" : "settling") : "partially_reported";
      let updatedEvent = await saveAppRecord(db, "events", {...event, session_cost_credits: EXCHANGE_CREDIT_AMOUNT, one_way_reward_credits: EXCHANGE_CREDIT_AMOUNT, credit_status: creditStatus, credit_reward_recipients: jsonArray(event.credit_reward_recipients, [])}, event.owner_id || event.host_id || viewerRow.id);
      let settlement = {status: creditStatus, rewards: [], transfer: null};
      if (allSubmitted) {
        const settled = await settleFeatureSessionCredits(db, updatedEvent, memberIds, new Map([[String(viewerRow.id), viewerRow]]));
        updatedEvent = await saveAppRecord(db, "events", {...updatedEvent, ...settled.patch}, updatedEvent.owner_id || updatedEvent.host_id || viewerRow.id);
        settlement = {status: "settled", rewards: updatedEvent.credit_reward_recipients || [], transfer: settled.transfer};
        if (settled.newlySettled) {
          if (settled.transfer.type === "one_way") {
            await createNotification(db, {userId: settled.transfer.payer_id, actorId: reporterId, type: "session_credits_settled", entityId: event.id, message: `1 credit was transferred to the member who taught you ${settled.transfer.skill || "this skill"}.`});
            await createNotification(db, {userId: settled.transfer.recipient_id, actorId: reporterId, type: "session_credit_reward", entityId: event.id, message: `You received 1 credit for teaching ${settled.transfer.skill || "this skill"} in this one-way exchange.`});
          } else if (settled.transfer.type === "mutual") {
            for (const memberId of memberIds) await createNotification(db, {userId: memberId, actorId: reporterId, type: "session_credits_settled", entityId: event.id, message: `This was a mutual exchange, so no credits were transferred.`});
          } else {
            for (const memberId of memberIds) await createNotification(db, {userId: memberId, actorId: reporterId, type: "session_credits_settled", entityId: event.id, message: `The exchange ended and 1 credit was deducted from the session payer.`});
          }
        }
      } else {
        for (const memberId of memberIds.filter(id => id !== reporterId)) await createNotification(db, {userId: memberId, actorId: reporterId, type: "session_progress_report", entityId: event.id, message: `A session member saved a progress report for “${event.title || "your session"}”.`});
      }
      const summary = {required_count: memberIds.length, submitted_count: nextReports.length, all_submitted: allSubmitted, viewer_submitted: nextReports.some(item => item.reporter_id === viewerRow.id), viewer_report_id: nextReports.find(item => item.reporter_id === viewerRow.id)?.id || "", status: settlement.status, session_cost_credits: EXCHANGE_CREDIT_AMOUNT, one_way_reward_credits: EXCHANGE_CREDIT_AMOUNT, credit_payer_id: updatedEvent.credit_payer_id || updatedEvent.host_id || "", credit_reward_recipients: jsonArray(updatedEvent.credit_reward_recipients, []), credit_transfer_type: updatedEvent.credit_transfer_type || settlement.transfer?.type || "", credit_transfer_amount: Number(updatedEvent.credit_transfer_amount || settlement.transfer?.amount || 0), credit_transfer_payer_id: updatedEvent.credit_transfer_payer_id || settlement.transfer?.payer_id || "", credit_transfer_recipient_id: updatedEvent.credit_transfer_recipient_id || settlement.transfer?.recipient_id || "", credit_transfer_skill: updatedEvent.credit_transfer_skill || settlement.transfer?.skill || ""};
      return apiResponse({message: allSubmitted ? "Progress report saved. Both reports are complete and the exchange credits were settled." : "Progress report saved. The other participant still needs to submit their report.", report, summary, settlement});
    }
    if (method === "GET") return apiResponse({event: await featureEventViewFor(db, event, viewerRow)});
    if (method === "PATCH") {
      if (event.host_id !== viewerRow.id && viewerRow.role !== "admin" && Object.keys(body).some(field => field !== "status")) return apiResponse({error: "Only the session host can edit session details."}, 403);
      const wasCompleted = event.status === "completed";
      ["session_cost_credits", "one_way_reward_credits", "credit_payer_id", "credit_status", "credit_settlement_id", "credit_settlement_at", "credit_reward_recipients", "credit_transfer_type", "credit_transfer_amount", "credit_transfer_payer_id", "credit_transfer_recipient_id", "credit_transfer_skill"].forEach(field => { delete body[field]; });
      const updated = await saveAppRecord(db, "events", {...event, ...body, session_cost_credits: EXCHANGE_CREDIT_AMOUNT, one_way_reward_credits: EXCHANGE_CREDIT_AMOUNT}, event.owner_id || viewerRow.id);
      if (!wasCompleted && updated.status === "completed") {
        const memberIds = [...new Set([updated.host_id, ...featureParticipantIds(updated)].filter(Boolean))];
        await Promise.all(memberIds.map(memberId => recordLearningSessionCompletion(db, memberId, {occurredAt: timestamp(), sourceId: updated.id})));
      }
      return apiResponse({event: await featureEventViewFor(db, updated, viewerRow), message: "Session updated."});
    }
    if (method === "DELETE") {
      const updated = await saveAppRecord(db, "events", {...event, status: "cancelled"}, event.owner_id || viewerRow.id);
      return apiResponse({event: await featureEventViewFor(db, updated, viewerRow), message: "Session cancelled."});
    }
  }

  if (path === "/api/credits" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    const entries = await appRecords(db, "ledger", viewerRow.id);
    const disputes = await appRecords(db, "disputes", viewerRow.id);
    return apiResponse({balance: Number(viewerRow.time_credits || 0), entries, disputes, contacts: [], stats: {earned: entries.filter(item => Number(item.amount) > 0).reduce((sum, item) => sum + Number(item.amount), 0), spent: Math.abs(entries.filter(item => Number(item.amount) < 0).reduce((sum, item) => sum + Number(item.amount), 0)), open_disputes: disputes.filter(item => ["open", "reviewing"].includes(item.status)).length}});
  }
  if (path === "/api/credits/disputes" && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const dispute = await saveAppRecord(db, "disputes", {id: newId("dispute"), ...body, user_id: viewerRow.id, status: "open", created_at: timestamp()}, viewerRow.id);
    return apiResponse({message: "Credit dispute opened.", dispute}, 201);
  }
  if (path === "/api/credits/transfer" && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const amount = Math.floor(Number(body.amount || 0));
    const recipient = await findUserById(db, body.recipient_id);
    if (!recipient || recipient.id === viewerRow.id) return apiResponse({error: "Choose another active member to receive the credits."}, 400);
    if (!Number.isInteger(amount) || amount < 1) return apiResponse({error: "Enter a positive whole number of credits."}, 400);
    if (amount > Number(viewerRow.time_credits || 0)) return apiResponse({error: "You do not have enough time credits."}, 400);
    const reference = newId("transfer");
    const balanceAfter = Number(viewerRow.time_credits || 0) - amount;
    const recipientBalance = Number(recipient.time_credits || 0) + amount;
    await db.batch([
      db.prepare("UPDATE sl_users SET time_credits = ?, updated_at = ? WHERE id = ?").bind(balanceAfter, timestamp(), viewerRow.id),
      db.prepare("UPDATE sl_users SET time_credits = ?, updated_at = ? WHERE id = ?").bind(recipientBalance, timestamp(), recipient.id)
    ]);
    await saveAppRecord(db, "ledger", {id: newId("ledger"), user_id: viewerRow.id, amount: -amount, balance_after: balanceAfter, description: body.description || `Payment to ${recipient.username}`, reference_id: reference}, viewerRow.id);
    await saveAppRecord(db, "ledger", {id: newId("ledger"), user_id: recipient.id, amount, balance_after: recipientBalance, description: `Payment from ${viewerRow.username}`, reference_id: reference}, recipient.id);
    return apiResponse({message: "Credit payment recorded.", balance: balanceAfter});
  }

  if (path === "/api/journal" && ["GET", "POST"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    if (method === "GET") {
      const entries = await appRecords(db, "journals", viewerRow.id);
      return apiResponse({entries, goals: [], stats: {entries: entries.length, hours: Math.round(entries.reduce((sum, item) => sum + Number(item.minutes || item.practice_minutes || 0), 0) / 60 * 10) / 10, skills: new Set(entries.map(item => item.skill).filter(Boolean)).size}});
    }
    const entry = await saveAppRecord(db, "journals", {id: newId("journal"), ...body, user_id: viewerRow.id, title: safeText(body.title || "Reflection", 180), minutes: Number(body.minutes || body.practice_minutes || 0), created_at: timestamp()}, viewerRow.id);
    return apiResponse({entry, message: "Journal entry saved."}, 201);
  }
  const journalMatch = /^\/api\/journal\/([^/]+)$/.exec(path);
  if (journalMatch && ["PATCH", "DELETE"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    const entryId = decodeURIComponent(journalMatch[1]);
    const entry = await appRecord(db, "journals", entryId);
    if (!entry || entry.user_id !== viewerRow.id) return apiResponse({error: "Journal entry not found."}, 404);
    if (method === "DELETE") await deleteAppRecord(db, "journals", entryId);
    else await saveAppRecord(db, "journals", {...entry, ...body}, viewerRow.id);
    return apiResponse({message: method === "DELETE" ? "Journal entry removed." : "Journal entry updated."});
  }

  if (path === "/api/portfolio" && ["GET", "PATCH"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    const existing = await appRecord(db, "portfolios", viewerRow.id) || {id: viewerRow.id, owner_id: viewerRow.id, title: `${viewer.profile.display_name || viewerRow.username}'s portfolio`, headline: "", intro: "", visibility: "private", accent: viewer.profile.profile_color || "indigo", links: [], projects: [], show_completed_jobs: false, show_journal: false, show_ideas: false, show_workshops: false};
    if (method === "PATCH") {
      const saved = await saveAppRecord(db, "portfolios", {...existing, ...body, id: viewerRow.id}, viewerRow.id);
      return apiResponse({settings: saved, portfolio: saved, projects: jsonArray(saved.projects, []), message: "Portfolio settings saved."});
    }
    return apiResponse({settings: existing, portfolio: existing, projects: jsonArray(existing.projects, []), journal: await appRecords(db, "journals", viewerRow.id)});
  }
  const portfolioItem = /^\/api\/portfolio\/items(?:\/([^/]+))?$/.exec(path);
  if (portfolioItem && ["POST", "PATCH", "DELETE"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    const existing = await appRecord(db, "portfolios", viewerRow.id) || {id: viewerRow.id, owner_id: viewerRow.id, projects: []};
    const projects = jsonArray(existing.projects, []);
    const itemId = portfolioItem[1] ? decodeURIComponent(portfolioItem[1]) : "";
    if (method === "POST") projects.unshift({id: newId("project"), ...body, created_at: timestamp()});
    if (method === "PATCH") {
      const index = projects.findIndex(item => item.id === itemId);
      if (index < 0) return apiResponse({error: "Portfolio item not found."}, 404);
      projects[index] = {...projects[index], ...body, updated_at: timestamp()};
    }
    if (method === "DELETE") {
      if (!projects.some(item => item.id === itemId)) return apiResponse({error: "Portfolio item not found."}, 404);
      existing.projects = projects.filter(item => item.id !== itemId);
    } else existing.projects = projects;
    const saved = await saveAppRecord(db, "portfolios", existing, viewerRow.id);
    return apiResponse({settings: saved, portfolio: saved, projects: jsonArray(saved.projects, []), message: "Portfolio updated."}, method === "POST" ? 201 : 200);
  }

  if (path === "/api/ideas" && ["GET", "POST"].includes(method)) {
    if (method === "GET") {
      const ideas = (await appRecords(db, "ideas", null)).filter(idea => ["published", "public", "approved"].includes(String(idea.status || "published")) || !idea.status).map(idea => featureIdeaView(idea, viewerRow?.id));
      return apiResponse({ideas, stats: {published: ideas.length, likes: ideas.reduce((sum, item) => sum + item.like_count, 0), comments: ideas.reduce((sum, item) => sum + item.comment_count, 0)}});
    }
    const denied = requireViewer(); if (denied) return denied;
    const idea = await saveAppRecord(db, "ideas", {id: newId("idea"), ...body, owner_id: viewerRow.id, title: safeText(body.title || "Untitled idea", 180), summary: safeText(body.summary || body.tagline || body.problem, 2000), status: "published", skills_needed: Array.isArray(body.skills_needed) ? body.skills_needed : csvValues(body.skills_needed), like_user_ids: [], save_user_ids: [], comments: [], pledges: [], created_at: timestamp()}, viewerRow.id);
    return apiResponse({idea: featureIdeaView(idea, viewerRow.id), message: "Your idea is now published."}, 201);
  }
  const ideaAction = /^\/api\/ideas\/([^/]+)\/(like|save|comments)(?:\/([^/]+))?$/.exec(path);
  if (ideaAction && ["GET", "POST", "DELETE"].includes(method)) {
    const ideaId = decodeURIComponent(ideaAction[1]);
    const idea = await appRecord(db, "ideas", ideaId);
    if (!idea) return apiResponse({error: "That idea could not be found."}, 404);
    const action = ideaAction[2];
    if (action === "comments" && method === "GET") return apiResponse({comments: jsonArray(idea.comments, [])});
    const denied = requireViewer(); if (denied) return denied;
    if (action === "like" || action === "save") {
      const field = action === "like" ? "like_user_ids" : "save_user_ids";
      const ids = jsonArray(idea[field], []);
      const index = ids.indexOf(viewerRow.id);
      if (method === "POST" && index < 0) ids.push(viewerRow.id);
      if (method === "DELETE" && index >= 0) ids.splice(index, 1);
      const saved = await saveAppRecord(db, "ideas", {...idea, [field]: ids, [`${action}_count`]: ids.length}, idea.owner_id);
      const view = featureIdeaView(saved, viewerRow.id);
      return apiResponse({idea: view, liked: view.viewer_liked, saved: view.viewer_saved, like_count: view.like_count, save_count: view.save_count, message: action === "like" ? (view.viewer_liked ? "Idea supported." : "Support removed.") : (view.viewer_saved ? "Idea saved." : "Idea removed from saved items.")});
    }
    if (method === "POST") {
      const message = safeText(body.body || body.message || body.comment, 1200);
      if (!message) return apiResponse({error: "Write a comment before posting."}, 400);
      const comments = [...jsonArray(idea.comments, []), {id: newId("idea-comment"), idea_id: idea.id, author_id: viewerRow.id, message, created_at: timestamp()}];
      const saved = await saveAppRecord(db, "ideas", {...idea, comments, comment_count: comments.length}, idea.owner_id);
      return apiResponse({message: "Comment added.", comment: comments.at(-1), idea: featureIdeaView(saved, viewerRow.id)}, 201);
    }
    if (method === "DELETE") {
      const commentId = decodeURIComponent(ideaAction[3] || "");
      const comments = jsonArray(idea.comments, []);
      const comment = comments.find(item => item.id === commentId);
      if (!comment || (comment.author_id !== viewerRow.id && idea.owner_id !== viewerRow.id && viewerRow.role !== "admin")) return apiResponse({error: "That comment could not be found."}, 404);
      const saved = await saveAppRecord(db, "ideas", {...idea, comments: comments.filter(item => item.id !== commentId), comment_count: Math.max(0, comments.length - 1)}, idea.owner_id);
      return apiResponse({message: "Comment removed.", idea: featureIdeaView(saved, viewerRow.id)});
    }
  }

  if (path === "/api/funding" && method === "GET") return apiResponse({ideas: (await appRecords(db, "ideas", null)).map(idea => featureIdeaView(idea, viewerRow?.id)), requests: []});

  if (path === "/api/swapjobs" && ["GET", "POST"].includes(method)) {
    if (method === "GET") {
      const query = String(url.searchParams.get("q") || "").toLowerCase();
      const category = String(url.searchParams.get("category") || "").toLowerCase();
      const jobs = (await appRecords(db, "swapjobs", null)).filter(job => !query || `${job.title || ""} ${job.description || ""} ${jsonArray(job.skills_needed, []).join(" ")}`.toLowerCase().includes(query)).filter(job => !category || String(job.category || "").toLowerCase() === category);
      const mine = viewerRow ? jobs.filter(job => job.owner_id === viewerRow.id) : [];
      const proposals = viewerRow ? (await appRecords(db, "swapjob_proposals", viewerRow.id)) : [];
      return apiResponse({jobs, mine, my_proposals: proposals, categories: [...new Set(jobs.map(job => job.category).filter(Boolean))], matches: [], stats: {open: jobs.filter(job => job.status === "open").length, completed: jobs.filter(job => job.status === "completed").length}});
    }
    const denied = requireViewer(); if (denied) return denied;
    const job = await saveAppRecord(db, "swapjobs", {id: newId("job"), ...body, owner_id: viewerRow.id, title: safeText(body.title || "Untitled task", 180), description: safeText(body.description, 2000), skills_needed: Array.isArray(body.skills_needed) ? body.skills_needed : csvValues(body.skills_needed), status: "open", proposal_count: 0, proposals: [], created_at: timestamp()}, viewerRow.id);
    return apiResponse({job, message: "Task posted."}, 201);
  }
  const swapJobAction = /^\/api\/swapjobs\/([^/]+)(?:\/(proposals|complete|cancel)(?:\/([^/]+)(?:\/(accept))?)?)?$/.exec(path);
  if (swapJobAction && ["GET", "PATCH", "POST", "DELETE"].includes(method)) {
    const jobId = decodeURIComponent(swapJobAction[1]);
    const job = await appRecord(db, "swapjobs", jobId);
    if (!job) return apiResponse({error: "Task not found."}, 404);
    const action = swapJobAction[2] || "detail";
    if (action === "detail" && method === "GET") return apiResponse({job});
    const denied = requireViewer(); if (denied) return denied;
    if (action === "proposals" && method === "POST") {
      const proposals = jsonArray(job.proposals, []);
      const proposal = {id: newId("proposal"), job_id: job.id, applicant_id: viewerRow.id, message: safeText(body.message, 2000), skills: Array.isArray(body.skills) ? body.skills : csvValues(body.skills), status: "pending", created_at: timestamp()};
      proposals.push(proposal);
      const saved = await saveAppRecord(db, "swapjobs", {...job, proposals, proposal_count: proposals.length}, job.owner_id);
      await saveAppRecord(db, "swapjob_proposals", proposal, viewerRow.id);
      return apiResponse({proposal, job: saved, message: "Proposal sent."}, 201);
    }
    if (action === "complete" && method === "POST" && job.owner_id === viewerRow.id) return apiResponse({job: await saveAppRecord(db, "swapjobs", {...job, status: "completed", deliverable_url: safeText(body.deliverable_url, 500)}, job.owner_id), message: "Task marked complete."});
    if (action === "cancel" && method === "POST" && job.owner_id === viewerRow.id) return apiResponse({job: await saveAppRecord(db, "swapjobs", {...job, status: "cancelled"}, job.owner_id), message: "Task cancelled."});
    if (action === "proposals" && swapJobAction[3] && swapJobAction[4] === "accept" && method === "POST" && job.owner_id === viewerRow.id) {
      const proposals = jsonArray(job.proposals, []).map(item => item.id === decodeURIComponent(swapJobAction[3]) ? {...item, status: "accepted"} : item);
      return apiResponse({job: await saveAppRecord(db, "swapjobs", {...job, proposals, status: "in_progress"}, job.owner_id), message: "Proposal accepted."});
    }
  }

  return await featureApiSupport(request, env, path, db, viewerRow, viewer, body, timestamp);
}

async function featureApiSupport(request, env, path, db, viewerRow, viewer, body, timestamp) {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const requireViewer = () => viewerRow ? null : apiResponse({error: "Please log in to use this feature."}, 401);
  const requireAdmin = () => viewerRow?.role === "admin" ? null : apiResponse({error: "Administrator access is required."}, viewerRow ? 403 : 401);
  const ownerId = viewerRow?.id || "";

  // Study Together is deliberately implemented in the feature API layer so it
  // shares SwapLabs authentication, CSRF, notifications, blocks, and
  // profile privacy rules with the rest of the platform.
  const studyProfileRow = async userId => db.prepare("SELECT * FROM sl_study_profiles WHERE user_id = ? LIMIT 1").bind(userId).first();
  const studyProfileJson = row => {
    if (!row) return null;
    return {
      user_id: row.user_id,
      status: row.status,
      visibility: row.visibility,
      subjects: jsonArray(row.subjects_json, []),
      topics: jsonArray(row.topics_json, []),
      goals: jsonArray(row.goals_json, []),
      learning_level: row.learning_level,
      timezone: streakTimezone(row.timezone),
      session_duration_minutes: Number(row.session_duration_minutes || 50),
      study_style: row.study_style,
      modes: jsonArray(row.modes_json, ["focus"]),
      languages: jsonArray(row.languages_json, ["English"]),
      interests: jsonArray(row.interests_json, []),
      cross_subject: Boolean(row.cross_subject),
      age_band: row.age_band || "any",
      current_goal: row.current_goal || "",
      reliability_score: Number(row.reliability_score || 0),
      completed_sessions: Number(row.completed_sessions || 0),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  };
  const studyList = (value, limit = 20) => {
    const values = Array.isArray(value) ? value : String(value || "").split(",");
    return [...new Set(values.map(item => safeText(item, 120)).filter(item => item && item.toLowerCase() !== NOTHING_FOR_NOW_VALUE))].slice(0, limit);
  };
  const studyModes = value => studyList(value, 4).filter(item => ["focus", "audio", "video", "pomodoro", "check_ins"].includes(item));
  const studyStyle = value => ["quiet_focus", "occasional_chat", "discussion", "accountability", "co_working"].includes(String(value)) ? String(value) : "quiet_focus";
  const studyDuration = value => [25, 50, 60, 90].includes(Number(value)) ? Number(value) : 50;
  const studyVisibility = value => ["public", "friends", "invite_only", "private"].includes(String(value)) ? String(value) : "public";
  const studyMode = value => ["focus", "audio", "video"].includes(String(value)) ? String(value) : "focus";
  const studyMinute = value => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const hour = Number(match[1]); const minute = Number(match[2]);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : null;
  };
  const studyTimezone = value => streakTimezone(value || viewer?.profile?.timezone || DEFAULT_STREAK_TIMEZONE);
  const studyDateKey = (date, timezone) => calendarDateForTime(date, timezone);
  const studyZonedUtc = (dateKey, minute, timezone) => {
    const [year, month, day] = String(dateKey).split("-").map(Number);
    let guess = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
    for (let index = 0; index < 4; index += 1) {
      const parts = new Intl.DateTimeFormat("en-US", {timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(new Date(guess));
      const part = type => Number(parts.find(item => item.type === type)?.value || 0);
      const actual = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
      const wanted = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
      guess += wanted - actual;
    }
    return new Date(guess).toISOString();
  };
  const studyAvailabilitySlots = (userId, windows, timezone, now = new Date()) => {
    const days = new Map();
    for (let index = -1; index <= 35; index += 1) {
      const date = new Date(now.getTime() + index * 86_400_000);
      const key = studyDateKey(date, timezone);
      if (!days.has(key)) days.set(key, key);
    }
    const slots = [];
    for (const window of windows) {
      const start = studyMinute(window.start);
      const end = studyMinute(window.end);
      const weekday = Number(window.weekday);
      if (start === null || end === null || end <= start || weekday < 0 || weekday > 6) continue;
      for (const dateKey of days.keys()) {
        const utcDate = new Date(`${dateKey}T12:00:00Z`);
        if (utcDate.getUTCDay() !== weekday) continue;
        const startUtc = studyZonedUtc(dateKey, start, timezone);
        const endUtc = studyZonedUtc(dateKey, end, timezone);
        if (new Date(endUtc).getTime() <= new Date(startUtc).getTime()) continue;
        slots.push({window, dateKey, startUtc, endUtc});
      }
    }
    return slots.slice(0, 140);
  };
  const studyWindowRows = async userId => {
    const result = await db.prepare("SELECT id, kind, weekday, date_key, start_minute, end_minute, timezone FROM sl_study_availability WHERE user_id = ? ORDER BY kind, weekday, start_minute").bind(userId).all();
    return (result.results || []).map(row => ({id: row.id, kind: row.kind, weekday: row.weekday, date_key: row.date_key, start: `${String(Math.floor(Number(row.start_minute) / 60)).padStart(2, "0")}:${String(Number(row.start_minute) % 60).padStart(2, "0")}`, end: `${String(Math.floor(Number(row.end_minute) / 60)).padStart(2, "0")}:${String(Number(row.end_minute) % 60).padStart(2, "0")}`, timezone: row.timezone}));
  };
  const studyProfilePayload = async userId => {
    const profile = studyProfileJson(await studyProfileRow(userId));
    return profile ? {...profile, availability: await studyWindowRows(userId)} : null;
  };
  const studySafePerson = async (userId, profileOverride = null) => {
    const person = await findUserById(db, userId);
    if (!person) return null;
    const profile = profileOverride || studyProfileJson(await studyProfileRow(userId));
    if (!profile) return null;
    const parts = rowParts(person);
    const name = parts.profile.first_name || parts.profile.display_name || person.username || "SwapLabs member";
    return {
      id: person.id,
      username: person.username,
      display_name: name,
      profile_color: parts.profile.profile_color || "indigo",
      avatar_url: publicAvatarUrl(parts.profile.avatar_url),
      timezone: profile.timezone,
      timezone_region: String(profile.timezone || "UTC").split("/")[0],
      subjects: profile.subjects,
      topics: profile.topics,
      goals: profile.goals,
      current_goal: profile.current_goal,
      learning_level: profile.learning_level,
      study_style: profile.study_style,
      modes: profile.modes,
      languages: profile.languages,
      cross_subject: profile.cross_subject,
      interests: profile.interests,
      completed_sessions: profile.completed_sessions,
      reliability_score: profile.reliability_score
    };
  };
  const studyOverlap = async (leftId, rightId) => {
    const row = await db.prepare("SELECT MAX(a.slot_start_utc, b.slot_start_utc) AS start_utc, MIN(a.slot_end_utc, b.slot_end_utc) AS end_utc FROM sl_study_availability_slots a INNER JOIN sl_study_availability_slots b ON b.user_id = ? AND a.slot_start_utc < b.slot_end_utc AND b.slot_start_utc < a.slot_end_utc WHERE a.user_id = ? ORDER BY MAX(a.slot_start_utc, b.slot_start_utc) LIMIT 1").bind(rightId, leftId).first();
    if (!row) return null;
    const start = new Date(row.start_utc); const end = new Date(row.end_utc);
    return {start_utc: start.toISOString(), end_utc: end.toISOString(), minutes: Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000))};
  };
  const studyMatchScore = (mine, theirs, overlap) => {
    const mineSubjects = new Set(mine.subjects.map(item => item.toLowerCase()));
    const otherSubjects = new Set(theirs.subjects.map(item => item.toLowerCase()));
    const subjectOverlap = [...mineSubjects].some(item => otherSubjects.has(item));
    const languageOverlap = mine.languages.some(item => theirs.languages.map(value => value.toLowerCase()).includes(item.toLowerCase()));
    const styleSame = mine.study_style === theirs.study_style;
    const durationSame = Number(mine.session_duration_minutes) === Number(theirs.session_duration_minutes);
    const modeOverlap = mine.modes.some(item => theirs.modes.includes(item));
    const goalsOverlap = [...mine.goals, mine.current_goal].filter(Boolean).some(item => [...theirs.goals, theirs.current_goal].some(other => String(other).toLowerCase().split(/\s+/).some(word => word.length > 3 && String(item).toLowerCase().includes(word))));
    const reasons = [
      {label: "Schedule overlap", points: overlap ? 30 : 0, max_points: 30, explanation: overlap ? `You both have an open window starting ${new Date(overlap.start_utc).toLocaleString([], {weekday: "short", hour: "numeric", minute: "2-digit"})}.` : "Add a recurring availability window to improve this match."},
      {label: "Study rhythm", points: durationSame ? 20 : 10, max_points: 20, explanation: durationSame ? `Both of you prefer ${mine.session_duration_minutes}-minute sessions.` : "Your preferred session lengths are close enough to try together."},
      {label: "Shared style", points: styleSame ? 15 : 8, max_points: 15, explanation: styleSame ? "You share the same study style." : "Your styles are compatible even though they are not identical."},
      {label: "Focus mode", points: modeOverlap ? 15 : 6, max_points: 15, explanation: modeOverlap ? "You have at least one session mode in common." : "You can still meet in Focus Mode and keep cameras optional."},
      {label: "Language", points: languageOverlap ? 10 : 4, max_points: 10, explanation: languageOverlap ? "You share a preferred language." : "Language preferences are not a blocker for a quiet session."},
      {label: "Learning direction", points: subjectOverlap || (mine.cross_subject && theirs.cross_subject) ? 10 : goalsOverlap ? 7 : 4, max_points: 10, explanation: subjectOverlap ? "You have a subject in common." : "Different subjects are welcome here; your learning goals can still move together."}
    ];
    const score = Math.min(99, Math.max(38, Math.round(reasons.reduce((sum, item) => sum + item.points, 0) / 100 * 100)));
    return {score, reasons, top_reasons: reasons.filter(item => item.points >= 10).sort((a, b) => b.points - a.points).slice(0, 2).map(item => item.explanation), subject_overlap: subjectOverlap};
  };
  const studyMatches = async (userId, filters = {}) => {
    const mine = studyProfileJson(await studyProfileRow(userId));
    if (!mine) return [];
    const duration = studyDuration(filters.duration || mine.session_duration_minutes);
    const search = `%${safeText(filters.search, 80).toLowerCase()}%`;
    const query = `SELECT p.*, u.username, u.profile_json, u.preferences_json, u.safety_json FROM sl_study_profiles p INNER JOIN sl_users u ON u.id = p.user_id WHERE p.user_id != ? AND p.status = 'active' AND p.visibility = 'discoverable' AND u.status = 'active' AND (p.session_duration_minutes = ? OR p.session_duration_minutes BETWEEN ? AND ?) AND (lower(COALESCE(json_extract(u.profile_json, '$.first_name'), '')) LIKE ? OR lower(COALESCE(json_extract(u.profile_json, '$.display_name'), '')) LIKE ? OR lower(p.subjects_json) LIKE ? OR lower(p.topics_json) LIKE ?) AND NOT EXISTS (SELECT 1 FROM sl_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = p.user_id) OR (b.blocker_id = p.user_id AND b.blocked_id = ?)) AND EXISTS (SELECT 1 FROM sl_study_availability_slots mine_slot INNER JOIN sl_study_availability_slots their_slot ON their_slot.user_id = p.user_id AND mine_slot.slot_start_utc < their_slot.slot_end_utc AND their_slot.slot_start_utc < mine_slot.slot_end_utc WHERE mine_slot.user_id = ?) ORDER BY p.completed_sessions DESC, p.updated_at DESC LIMIT 80`;
    const result = await db.prepare(query).bind(userId, duration, Math.max(25, duration - 25), Math.min(90, duration + 25), search, search, search, search, userId, userId, userId).all();
    const favoriteRows = await db.prepare("SELECT partner_id FROM sl_study_favorites WHERE user_id = ?").bind(userId).all();
    const favorites = new Set((favoriteRows.results || []).map(row => String(row.partner_id)));
    const matches = [];
    for (const row of result.results || []) {
      const theirs = studyProfileJson(row);
      const ageCompatible = !mine.age_band || mine.age_band === "any" || !theirs.age_band || theirs.age_band === "any" || mine.age_band === theirs.age_band;
      if (!ageCompatible) continue;
      const overlap = await studyOverlap(userId, row.user_id);
      const match = studyMatchScore(mine, theirs, overlap);
      const person = await studySafePerson(row.user_id, theirs);
      if (!person) continue;
      matches.push({id: `study-match-${row.user_id}`, candidate: person, score: match.score, reasons: match.reasons, top_reasons: match.top_reasons, subject_overlap: match.subject_overlap, availability: {available_now: Boolean(overlap && new Date(overlap.start_utc).getTime() <= Date.now() && new Date(overlap.end_utc).getTime() >= Date.now()), next_overlap_at: overlap?.start_utc || null, label: overlap ? `Overlaps ${Math.round((new Date(overlap.end_utc).getTime() - new Date(overlap.start_utc).getTime()) / 60_000)} minutes` : "Schedule not shared"}, saved: favorites.has(String(row.user_id))});
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, 24);
  };
  const studyRoomView = async room => {
    const members = await db.prepare("SELECT user_id, role, status, joined_at FROM sl_study_room_members WHERE room_id = ? ORDER BY created_at").bind(room.id).all();
    const people = [];
    for (const member of members.results || []) {
      const person = await studySafePerson(member.user_id);
      if (person) people.push({...person, role: member.role, member_status: member.status, joined_at: member.joined_at});
    }
    return {...room, max_participants: Number(room.max_participants || 4), duration_minutes: Number(room.duration_minutes || 50), modes: jsonArray(room.modes_json, ["focus"]), pomodoro: parseJson(room.pomodoro_json, {focus: 50, break: 10, rounds: 1}), rules: jsonArray(room.rules_json, []), participant_count: people.filter(person => person.member_status === "active").length, participants: people};
  };
  const studySessionView = async session => {
    const room = await db.prepare("SELECT * FROM sl_study_rooms WHERE id = ? LIMIT 1").bind(session.room_id).first();
    const members = await db.prepare("SELECT * FROM sl_study_session_members WHERE session_id = ? ORDER BY created_at").bind(session.id).all();
    const participants = [];
    for (const member of members.results || []) {
      const person = await studySafePerson(member.user_id);
      if (person) participants.push({...person, role: member.role, status: member.status, goal: member.goal, goal_completed: Boolean(member.goal_completed), progress_note: member.progress_note, joined_at: member.joined_at, left_at: member.left_at});
    }
    return {...session, starts_at: session.starts_at, ends_at: session.ends_at, goal: parseJson(session.goal_json, {}), pomodoro: parseJson(session.pomodoro_json, {focus: 50, break: 10, rounds: 1}), participants, room: room ? {id: room.id, title: room.title, visibility: room.visibility, subject: room.subject, host_id: room.host_id, video_room_id: session.video_room_id || null} : null};
  };
  const studyOwnsSession = async sessionId => {
    return db.prepare("SELECT s.*, m.role AS viewer_role, m.status AS viewer_status FROM sl_study_sessions s INNER JOIN sl_study_session_members m ON m.session_id = s.id AND m.user_id = ? WHERE s.id = ? LIMIT 1").bind(ownerId, sessionId).first();
  };
  const studyNotifyParticipants = async (session, actorId, type, message) => {
    const members = await db.prepare("SELECT user_id FROM sl_study_session_members WHERE session_id = ? AND user_id != ?").bind(session.id, actorId).all();
    for (const member of members.results || []) await createNotification(db, {userId: member.user_id, actorId, type, entityId: session.id, message, createdAt: timestamp()});
  };

  if (path === "/api/study" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    const profile = await studyProfilePayload(ownerId);
    const now = timestamp();
    const invitationRows = await db.prepare("SELECT * FROM sl_study_invitations WHERE (sender_id = ? OR recipient_id = ?) AND status IN ('pending', 'countered', 'accepted') ORDER BY updated_at DESC LIMIT 20").bind(ownerId, ownerId).all();
    const invitations = [];
    for (const invitation of invitationRows.results || []) {
      const sender = await studySafePerson(invitation.sender_id);
      const recipient = await studySafePerson(invitation.recipient_id);
      invitations.push({...invitation, duration_minutes: Number(invitation.duration_minutes || 50), sender, recipient, is_incoming: invitation.recipient_id === ownerId});
    }
    const sessionsResult = await db.prepare("SELECT s.* FROM sl_study_sessions s INNER JOIN sl_study_session_members m ON m.session_id = s.id WHERE m.user_id = ? AND s.status IN ('scheduled', 'active') AND s.ends_at >= ? ORDER BY s.starts_at LIMIT 12").bind(ownerId, now).all();
    const upcoming = await Promise.all((sessionsResult.results || []).map(studySessionView));
    const lobbyResult = await db.prepare("SELECT r.*, COUNT(CASE WHEN m.status = 'active' THEN 1 END) AS active_count FROM sl_study_rooms r LEFT JOIN sl_study_room_members m ON m.room_id = r.id WHERE r.status = 'open' AND r.visibility = 'public' AND r.starts_at <= datetime(?, '+24 hours') AND r.starts_at >= datetime(?, '-30 minutes') GROUP BY r.id ORDER BY r.starts_at LIMIT 16").bind(now, now).all();
    const lobby = await Promise.all((lobbyResult.results || []).map(studyRoomView));
    const statsRow = await db.prepare("SELECT COUNT(DISTINCT s.id) AS completed, COALESCE(SUM((julianday(s.ends_at) - julianday(s.starts_at)) * 1440), 0) AS minutes, SUM(CASE WHEN m.goal_completed = 1 THEN 1 ELSE 0 END) AS goals FROM sl_study_sessions s INNER JOIN sl_study_session_members m ON m.session_id = s.id WHERE m.user_id = ? AND m.status = 'completed' AND s.status = 'completed'").bind(ownerId).first();
    return apiResponse({ok: true, server_time: now, profile, onboarding_complete: Boolean(profile && profile.subjects.length && profile.current_goal), invitations, upcoming_sessions: upcoming, lobby, matches: profile ? await studyMatches(ownerId, {}) : [], stats: {sessions_completed: Number(statsRow?.completed || 0), study_minutes: Math.round(Number(statsRow?.minutes || 0)), goals_completed: Number(statsRow?.goals || 0)}});
  }

  if (path === "/api/study/profile" && ["GET", "PUT", "PATCH"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    if (method === "GET") return apiResponse({ok: true, profile: await studyProfilePayload(ownerId)});
    const now = timestamp();
    const existing = await studyProfileRow(ownerId);
    const timezone = studyTimezone(body.timezone || existing?.timezone || viewer?.profile?.timezone);
    const subjects = studyList(body.subjects, 12);
    const topics = studyList(body.topics, 20);
    const goals = studyList(body.goals, 8);
    const languages = studyList(body.languages, 8);
    const interests = studyList(body.interests, 12);
    const modes = studyModes(body.modes?.length ? body.modes : jsonArray(existing?.modes_json, ["focus"]));
    const visibility = body.visibility === "private" ? "private" : "discoverable";
    const duration = studyDuration(body.session_duration_minutes || existing?.session_duration_minutes);
    const style = studyStyle(body.study_style || existing?.study_style);
    const windows = (Array.isArray(body.availability) ? body.availability : []).slice(0, 14).map(window => ({
      kind: window.kind === "one_off" ? "one_off" : "recurring",
      weekday: Number(window.weekday), date_key: /^\d{4}-\d{2}-\d{2}$/.test(String(window.date_key || "")) ? String(window.date_key) : null,
      start: String(window.start || ""), end: String(window.end || "")
    })).filter(window => studyMinute(window.start) !== null && studyMinute(window.end) !== null && studyMinute(window.end) > studyMinute(window.start) && (window.kind === "one_off" ? window.date_key : Number.isInteger(window.weekday) && window.weekday >= 0 && window.weekday <= 6));
    const id = ownerId;
    const profileValues = [id, "active", visibility, JSON.stringify(subjects), JSON.stringify(topics), JSON.stringify(goals), safeText(body.learning_level || existing?.learning_level || "all_levels", 40), timezone, duration, style, JSON.stringify(modes.length ? modes : ["focus"]), JSON.stringify(languages.length ? languages : ["English"]), JSON.stringify(interests), body.cross_subject === false ? 0 : 1, safeText(body.age_band || existing?.age_band || "any", 30), safeText(body.current_goal, 300), Number(existing?.reliability_score || 0), Number(existing?.completed_sessions || 0), existing?.created_at || now, now];
    const profileStatement = db.prepare("INSERT INTO sl_study_profiles (user_id, status, visibility, subjects_json, topics_json, goals_json, learning_level, timezone, session_duration_minutes, study_style, modes_json, languages_json, interests_json, cross_subject, age_band, current_goal, reliability_score, completed_sessions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, visibility = excluded.visibility, subjects_json = excluded.subjects_json, topics_json = excluded.topics_json, goals_json = excluded.goals_json, learning_level = excluded.learning_level, timezone = excluded.timezone, session_duration_minutes = excluded.session_duration_minutes, study_style = excluded.study_style, modes_json = excluded.modes_json, languages_json = excluded.languages_json, interests_json = excluded.interests_json, cross_subject = excluded.cross_subject, age_band = excluded.age_band, current_goal = excluded.current_goal, updated_at = excluded.updated_at").bind(...profileValues);
    const windowRows = windows.map(window => ({...window, id: newId("study_availability")}));
    await db.batch([
      profileStatement,
      db.prepare("DELETE FROM sl_study_availability_slots WHERE user_id = ?").bind(ownerId),
      db.prepare("DELETE FROM sl_study_availability WHERE user_id = ?").bind(ownerId),
      ...windowRows.map(window => db.prepare("INSERT INTO sl_study_availability (id, user_id, kind, weekday, date_key, start_minute, end_minute, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(window.id, ownerId, window.kind, window.kind === "recurring" ? window.weekday : null, window.kind === "one_off" ? window.date_key : null, studyMinute(window.start), studyMinute(window.end), timezone, now, now))
    ]);
    const generatedSlots = [];
    for (const window of windowRows) {
      const slotWindows = window.kind === "recurring" ? studyAvailabilitySlots(ownerId, [window], timezone, new Date()) : (() => {
        const start = studyMinute(window.start); const end = studyMinute(window.end);
        return [{dateKey: window.date_key, startUtc: studyZonedUtc(window.date_key, start, timezone), endUtc: studyZonedUtc(window.date_key, end, timezone)}];
      })();
      for (const slot of slotWindows) generatedSlots.push({id: newId("study_slot"), userId: ownerId, availabilityId: window.id, dateKey: slot.dateKey, startUtc: slot.startUtc, endUtc: slot.endUtc});
    }
    for (let index = 0; index < generatedSlots.length; index += 60) {
      await db.batch(generatedSlots.slice(index, index + 60).map(slot => db.prepare("INSERT INTO sl_study_availability_slots (id, user_id, availability_id, slot_day, slot_start_utc, slot_end_utc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(slot.id, slot.userId, slot.availabilityId, slot.dateKey, slot.startUtc, slot.endUtc, now)));
    }
    return apiResponse({ok: true, message: "Study profile saved.", profile: await studyProfilePayload(ownerId)});
  }

  if (path === "/api/study/matches" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    return apiResponse({ok: true, matches: await studyMatches(ownerId, {search: url.searchParams.get("search") || "", duration: url.searchParams.get("duration") || ""})});
  }

  if (path === "/api/study/invitations" && ["GET", "POST"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    if (method === "GET") {
      const rows = await db.prepare("SELECT * FROM sl_study_invitations WHERE sender_id = ? OR recipient_id = ? ORDER BY updated_at DESC LIMIT 40").bind(ownerId, ownerId).all();
      const items = [];
      for (const item of rows.results || []) items.push({...item, sender: await studySafePerson(item.sender_id), recipient: await studySafePerson(item.recipient_id), is_incoming: item.recipient_id === ownerId});
      return apiResponse({ok: true, invitations: items});
    }
    const targetId = safeText(body.target_user_id, 100);
    const target = await findUserById(db, targetId);
    if (!target || targetId === ownerId || target.status !== "active") return apiResponse({error: "Choose an available SwapLabs member."}, 400);
    if (rowParts(viewerRow).safety.is_minor || rowParts(target).safety.is_minor) return apiResponse({error: "Direct study invitations are unavailable for student accounts."}, 403);
    if (await blockedConversationMember(db, ownerId, targetId)) return apiResponse({error: "Invitations are blocked between these members."}, 403);
    const start = new Date(body.proposed_start_utc || "");
    if (Number.isNaN(start.getTime()) || start.getTime() < Date.now() + 60_000 || start.getTime() > Date.now() + 90 * 86_400_000) return apiResponse({error: "Choose a start time within the next 90 days."}, 400);
    const duration = studyDuration(body.duration_minutes);
    const pending = await db.prepare("SELECT id FROM sl_study_invitations WHERE sender_id = ? AND recipient_id = ? AND status IN ('pending', 'countered') LIMIT 1").bind(ownerId, targetId).first();
    if (pending) return apiResponse({error: "You already have an open invitation with this member."}, 409);
    const mine = studyProfileJson(await studyProfileRow(ownerId)); const theirs = studyProfileJson(await studyProfileRow(targetId));
    const invitation = {id: newId("study_invite"), sender_id: ownerId, recipient_id: targetId, proposed_start_utc: start.toISOString(), duration_minutes: duration, mode: studyMode(body.mode), study_style: studyStyle(body.study_style || mine?.study_style), sender_subject: safeText(body.sender_subject || mine?.subjects?.[0], 120), recipient_subject: safeText(body.recipient_subject || theirs?.subjects?.[0], 120), message: safeText(body.message, 500), status: "pending", counter_start_utc: null, counter_duration_minutes: null, counter_message: "", created_at: timestamp(), updated_at: timestamp()};
    await db.prepare("INSERT INTO sl_study_invitations (id, sender_id, recipient_id, proposed_start_utc, duration_minutes, mode, study_style, sender_subject, recipient_subject, message, status, counter_start_utc, counter_duration_minutes, counter_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(invitation.id, invitation.sender_id, invitation.recipient_id, invitation.proposed_start_utc, invitation.duration_minutes, invitation.mode, invitation.study_style, invitation.sender_subject, invitation.recipient_subject, invitation.message, invitation.status, null, null, "", invitation.created_at, invitation.updated_at).run();
    const senderName = viewer?.profile?.first_name || viewer?.username || "A SwapLabs member";
    await createNotification(db, {userId: targetId, actorId: ownerId, type: "study_invitation", entityId: invitation.id, message: `${senderName} invited you to a ${duration}-minute Study Together session.`, createdAt: timestamp()});
    return apiResponse({ok: true, invitation, message: "Study invitation sent."}, 201);
  }

  const studyInvitationMatch = /^\/api\/study\/invitations\/([^/]+)$/.exec(path);
  if (studyInvitationMatch && method === "PATCH") {
    const denied = requireViewer(); if (denied) return denied;
    const invitationId = decodeURIComponent(studyInvitationMatch[1]);
    const invitation = await db.prepare("SELECT * FROM sl_study_invitations WHERE id = ? LIMIT 1").bind(invitationId).first();
    if (!invitation || ![invitation.sender_id, invitation.recipient_id].includes(ownerId)) return apiResponse({error: "Invitation not found."}, 404);
    const action = safeText(body.action, 30);
    if (action === "decline" && invitation.recipient_id === ownerId) {
      await db.prepare("UPDATE sl_study_invitations SET status = 'declined', updated_at = ? WHERE id = ?").bind(timestamp(), invitationId).run();
      await createNotification(db, {userId: invitation.sender_id, actorId: ownerId, type: "study_invitation_declined", entityId: invitationId, message: "Your Study Together invitation was declined.", createdAt: timestamp()});
      return apiResponse({ok: true, status: "declined"});
    }
    if (action === "counter" && invitation.recipient_id === ownerId) {
      const proposed = new Date(body.proposed_start_utc || "");
      if (Number.isNaN(proposed.getTime()) || proposed.getTime() < Date.now() + 60_000) return apiResponse({error: "Choose a future time for your suggestion."}, 400);
      await db.prepare("UPDATE sl_study_invitations SET status = 'countered', counter_start_utc = ?, counter_duration_minutes = ?, counter_message = ?, updated_at = ? WHERE id = ?").bind(proposed.toISOString(), studyDuration(body.duration_minutes || invitation.duration_minutes), safeText(body.message, 500), timestamp(), invitationId).run();
      await createNotification(db, {userId: invitation.sender_id, actorId: ownerId, type: "study_invitation_countered", entityId: invitationId, message: "Your Study Together invitation received a new time suggestion.", createdAt: timestamp()});
      return apiResponse({ok: true, status: "countered"});
    }
    const acceptingCounter = invitation.status === "countered" && action === "accept_counter" && invitation.sender_id === ownerId;
    if ((action === "accept" && invitation.recipient_id === ownerId && invitation.status === "pending") || acceptingCounter) {
      const startsAt = acceptingCounter ? new Date(invitation.counter_start_utc) : new Date(invitation.proposed_start_utc);
      const duration = acceptingCounter ? studyDuration(invitation.counter_duration_minutes || invitation.duration_minutes) : studyDuration(invitation.duration_minutes);
      const startIso = startsAt.toISOString(); const endIso = new Date(startsAt.getTime() + duration * 60_000).toISOString(); const now = timestamp();
      const roomId = newId("study_room"); const sessionId = newId("study_session");
      const title = `Study Together · ${invitation.sender_subject || invitation.recipient_subject || "shared focus"}`;
      const senderProfile = studyProfileJson(await studyProfileRow(invitation.sender_id)); const recipientProfile = studyProfileJson(await studyProfileRow(invitation.recipient_id));
      await db.batch([
        db.prepare("UPDATE sl_study_invitations SET status = 'accepted', updated_at = ? WHERE id = ?").bind(now, invitationId),
        db.prepare("INSERT INTO sl_study_rooms (id, host_id, title, description, visibility, subject, max_participants, starts_at, duration_minutes, study_style, modes_json, pomodoro_json, rules_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'private', ?, 2, ?, ?, ?, ?, ?, ?, 'open', ?, ?)").bind(roomId, invitation.sender_id, title, invitation.message || "A private Study Together session.", invitation.sender_subject || invitation.recipient_subject || "", startIso, duration, invitation.study_style, JSON.stringify([invitation.mode]), JSON.stringify({focus: duration, break: 10, rounds: 1}), JSON.stringify(["Respect the shared focus block.", "Cameras and microphones are always optional."]), now, now),
        db.prepare("INSERT INTO sl_study_room_members (room_id, user_id, role, status, joined_at, created_at, updated_at) VALUES (?, ?, 'host', 'active', NULL, ?, ?), (?, ?, 'participant', 'active', NULL, ?, ?)").bind(roomId, invitation.sender_id, now, now, roomId, invitation.recipient_id, now, now),
        db.prepare("INSERT INTO sl_study_sessions (id, room_id, invitation_id, created_by, starts_at, ends_at, status, mode, study_style, goal_json, pomodoro_json, video_room_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, NULL, ?, ?)").bind(sessionId, roomId, invitationId, invitation.sender_id, startIso, endIso, invitation.mode, invitation.study_style, JSON.stringify({subject: invitation.sender_subject || invitation.recipient_subject || "", sender_goal: senderProfile?.current_goal || "", recipient_goal: recipientProfile?.current_goal || ""}), JSON.stringify({focus: duration, break: 10, rounds: 1}), now, now),
        db.prepare("INSERT INTO sl_study_session_members (session_id, user_id, role, status, goal, goal_completed, progress_note, created_at, updated_at) VALUES (?, ?, 'host', 'scheduled', ?, 0, '', ?, ?), (?, ?, 'participant', 'scheduled', ?, 0, '', ?, ?)").bind(sessionId, invitation.sender_id, senderProfile?.current_goal || "", now, now, sessionId, invitation.recipient_id, recipientProfile?.current_goal || "", now, now)
      ]);
      await createNotification(db, {userId: acceptingCounter ? invitation.recipient_id : invitation.sender_id, actorId: ownerId, type: "study_invitation_accepted", entityId: sessionId, message: "Your Study Together session is confirmed.", createdAt: timestamp()});
      const session = await db.prepare("SELECT * FROM sl_study_sessions WHERE id = ? LIMIT 1").bind(sessionId).first();
      return apiResponse({ok: true, status: "accepted", session: await studySessionView(session)}, 201);
    }
    return apiResponse({error: "That invitation action is not available."}, 400);
  }

  if (path === "/api/study/rooms" && ["GET", "POST"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    if (method === "GET") {
      const rows = await db.prepare("SELECT r.* FROM sl_study_rooms r LEFT JOIN sl_study_room_members mine ON mine.room_id = r.id AND mine.user_id = ? WHERE (r.visibility = 'public' AND r.status = 'open' AND r.starts_at <= datetime(?, '+24 hours') AND r.starts_at >= datetime(?, '-30 minutes')) OR mine.user_id IS NOT NULL ORDER BY r.starts_at LIMIT 40").bind(ownerId, timestamp(), timestamp()).all();
      return apiResponse({ok: true, rooms: await Promise.all((rows.results || []).map(studyRoomView))});
    }
    const starts = new Date(body.starts_at || Date.now() + 5 * 60_000);
    if (Number.isNaN(starts.getTime()) || starts.getTime() < Date.now() + 60_000 || starts.getTime() > Date.now() + 90 * 86_400_000) return apiResponse({error: "Choose a room start time within the next 90 days."}, 400);
    const duration = studyDuration(body.duration_minutes); const now = timestamp(); const roomId = newId("study_room"); const sessionId = newId("study_session");
    const end = new Date(starts.getTime() + duration * 60_000).toISOString(); const visibility = studyVisibility(body.visibility);
    const title = safeText(body.title || "Quiet study room", 140); const subject = safeText(body.subject, 120); const modes = studyModes(body.modes?.length ? body.modes : ["focus"]);
    await db.batch([
      db.prepare("INSERT INTO sl_study_rooms (id, host_id, title, description, visibility, subject, max_participants, starts_at, duration_minutes, study_style, modes_json, pomodoro_json, rules_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)").bind(roomId, ownerId, title, safeText(body.description, 800), visibility, subject, Math.max(2, Math.min(8, Number(body.max_participants || 4))), starts.toISOString(), duration, studyStyle(body.study_style), JSON.stringify(modes.length ? modes : ["focus"]), JSON.stringify({focus: Number(body.pomodoro?.focus || duration), break: Number(body.pomodoro?.break || 10), rounds: Number(body.pomodoro?.rounds || 1)}), JSON.stringify(studyList(body.rules, 6)), now, now),
      db.prepare("INSERT INTO sl_study_room_members (room_id, user_id, role, status, joined_at, created_at, updated_at) VALUES (?, ?, 'host', 'active', NULL, ?, ?)").bind(roomId, ownerId, now, now),
      db.prepare("INSERT INTO sl_study_sessions (id, room_id, invitation_id, created_by, starts_at, ends_at, status, mode, study_style, goal_json, pomodoro_json, video_room_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, 'scheduled', ?, ?, ?, ?, NULL, ?, ?)").bind(sessionId, roomId, ownerId, starts.toISOString(), end, modes.includes("video") ? "video" : modes.includes("audio") ? "audio" : "focus", studyStyle(body.study_style), JSON.stringify({subject, goal: safeText(body.goal, 300)}), JSON.stringify({focus: Number(body.pomodoro?.focus || duration), break: Number(body.pomodoro?.break || 10), rounds: Number(body.pomodoro?.rounds || 1)}), now, now),
      db.prepare("INSERT INTO sl_study_session_members (session_id, user_id, role, status, goal, goal_completed, progress_note, created_at, updated_at) VALUES (?, ?, 'host', 'scheduled', ?, 0, '', ?, ?)").bind(sessionId, ownerId, safeText(body.goal, 300), now, now)
    ]);
    const room = await db.prepare("SELECT * FROM sl_study_rooms WHERE id = ? LIMIT 1").bind(roomId).first();
    return apiResponse({ok: true, room: await studyRoomView(room), session: await studySessionView(await db.prepare("SELECT * FROM sl_study_sessions WHERE id = ? LIMIT 1").bind(sessionId).first())}, 201);
  }

  const studyRoomMatch = /^\/api\/study\/rooms\/([^/]+)(?:\/(join|leave|lock))?$/.exec(path);
  if (studyRoomMatch && ["GET", "POST", "PATCH"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    const roomId = decodeURIComponent(studyRoomMatch[1]); const action = studyRoomMatch[2] || "detail";
    const room = await db.prepare("SELECT * FROM sl_study_rooms WHERE id = ? LIMIT 1").bind(roomId).first();
    if (!room) return apiResponse({error: "Study room not found."}, 404);
    const membership = await db.prepare("SELECT * FROM sl_study_room_members WHERE room_id = ? AND user_id = ? LIMIT 1").bind(roomId, ownerId).first();
    if (action === "detail" && method === "GET") {
      if (!membership && room.visibility !== "public") return apiResponse({error: "This room is private."}, 403);
      return apiResponse({ok: true, room: await studyRoomView(room)});
    }
    if (action === "join" && method === "POST") {
      if (room.status !== "open") return apiResponse({error: "This study room is no longer open."}, 409);
      if (!membership && room.visibility !== "public") return apiResponse({error: "This room is invite-only."}, 403);
      const activeCount = await db.prepare("SELECT COUNT(*) AS count FROM sl_study_room_members WHERE room_id = ? AND status = 'active'").bind(roomId).first();
      if (!membership && Number(activeCount?.count || 0) >= Number(room.max_participants || 4)) return apiResponse({error: "This room is full."}, 409);
      const now = timestamp();
      await db.batch([
        db.prepare("INSERT INTO sl_study_room_members (room_id, user_id, role, status, joined_at, created_at, updated_at) VALUES (?, ?, 'participant', 'active', ?, ?, ?) ON CONFLICT(room_id, user_id) DO UPDATE SET status = 'active', joined_at = excluded.joined_at, updated_at = excluded.updated_at").bind(roomId, ownerId, now, now, now),
        db.prepare("INSERT INTO sl_study_session_members (session_id, user_id, role, status, goal, goal_completed, progress_note, created_at, updated_at) SELECT id, ?, 'participant', 'scheduled', '', 0, '', ?, ? FROM sl_study_sessions WHERE room_id = ? ON CONFLICT(session_id, user_id) DO UPDATE SET status = 'scheduled', updated_at = excluded.updated_at").bind(ownerId, now, now, roomId)
      ]);
      if (room.host_id !== ownerId) await createNotification(db, {userId: room.host_id, actorId: ownerId, type: "study_room_joined", entityId: roomId, message: "A member joined your Study Together room.", createdAt: now});
      return apiResponse({ok: true, room: await studyRoomView(room)});
    }
    if (action === "leave" && method === "POST") {
      if (!membership) return apiResponse({ok: true});
      const now = timestamp();
      await db.batch([db.prepare("UPDATE sl_study_room_members SET status = 'left', updated_at = ? WHERE room_id = ? AND user_id = ?").bind(now, roomId, ownerId), db.prepare("UPDATE sl_study_session_members SET status = 'left', left_at = ?, updated_at = ? WHERE session_id IN (SELECT id FROM sl_study_sessions WHERE room_id = ?) AND user_id = ? AND status != 'completed'").bind(now, now, roomId, ownerId)]);
      return apiResponse({ok: true, message: "You left the study room."});
    }
    if (action === "lock" && method === "PATCH") {
      if (room.host_id !== ownerId) return apiResponse({error: "Only the host can lock a room."}, 403);
      await db.prepare("UPDATE sl_study_rooms SET status = ?, updated_at = ? WHERE id = ?").bind(body.locked === false ? "open" : "locked", timestamp(), roomId).run();
      return apiResponse({ok: true, room: await studyRoomView(await db.prepare("SELECT * FROM sl_study_rooms WHERE id = ? LIMIT 1").bind(roomId).first())});
    }
  }

  if (path === "/api/study/sessions" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    const rows = await db.prepare("SELECT s.* FROM sl_study_sessions s INNER JOIN sl_study_session_members m ON m.session_id = s.id WHERE m.user_id = ? ORDER BY s.starts_at DESC LIMIT 80").bind(ownerId).all();
    return apiResponse({ok: true, sessions: await Promise.all((rows.results || []).map(studySessionView))});
  }

  const studySessionMatch = /^\/api\/study\/sessions\/([^/]+)(?:\/(messages|complete|leave|video-room))?$/.exec(path);
  if (studySessionMatch && ["GET", "POST", "PATCH"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    const sessionId = decodeURIComponent(studySessionMatch[1]); const action = studySessionMatch[2] || "detail";
    const session = await studyOwnsSession(sessionId);
    if (!session) return apiResponse({error: "Study session not found."}, 404);
    if (action === "detail" && method === "GET") return apiResponse({ok: true, session: await studySessionView(session)});
    if (action === "video-room" && method === "POST") {
      const mediaMode = ["video", "audio"].includes(String(body.mode)) ? String(body.mode) : String(session.mode);
      if (!["video", "audio"].includes(mediaMode)) return apiResponse({error: "Choose video or audio before opening the protected room."}, 400);
      if (session.viewer_status === "left") return apiResponse({error: "You have left this study session."}, 403);
      const existingRoom = session.video_room_id ? await appRecord(db, "video_rooms", session.video_room_id) : null;
      if (existingRoom) return apiResponse({ok: true, room: await featureVideoRoomView(db, existingRoom, viewerRow), session: await studySessionView(session)});
      const memberRows = await db.prepare("SELECT user_id, role, status FROM sl_study_session_members WHERE session_id = ? AND status != 'left' ORDER BY created_at").bind(sessionId).all();
      const participantIds = [...new Set((memberRows.results || []).map(member => String(member.user_id)).filter(Boolean))];
      if (!participantIds.includes(ownerId)) return apiResponse({error: "You are not a participant in this session."}, 403);
      const studyRoom = await db.prepare("SELECT title FROM sl_study_rooms WHERE id = ? LIMIT 1").bind(session.room_id).first();
      const roomId = newId("room"); const now = timestamp(); const hostId = String(session.created_by || participantIds[0] || ownerId);
      const attendance = participantIds.map(userId => ({user_id: userId, state: userId === hostId ? "admitted" : "invited", joined_at: null, left_at: null, duration_seconds: 0, participant_confirmed: false, host_confirmed: userId === hostId}));
      const room = await saveAppRecord(db, "video_rooms", {
        id: roomId, owner_id: hostId, host_id: hostId, event_id: "", status: "ready", participant_ids: participantIds,
        participants: [], invite_token: randomToken(24), guest_access: false, guest_participants: [], guest_sessions: [],
        attendance, signals: [], waiting_room_enabled: true, screen_sharing_enabled: mediaMode === "video",
        video_enabled: mediaMode === "video", audio_enabled: true, call_mode: mediaMode === "audio" ? "voice" : "video",
        title: safeText(body.title || studyRoom?.title || "SwapLabs Study Together room", 180), created_at: now
      }, hostId);
      await db.prepare("UPDATE sl_study_sessions SET video_room_id = ?, mode = ?, updated_at = ? WHERE id = ?").bind(roomId, mediaMode, now, sessionId).run();
      const updatedSession = await db.prepare("SELECT * FROM sl_study_sessions WHERE id = ? LIMIT 1").bind(sessionId).first();
      return apiResponse({ok: true, room: await featureVideoRoomView(db, room, viewerRow), session: await studySessionView(updatedSession)}, 201);
    }
    if (action === "messages" && method === "GET") {
      const rows = await db.prepare("SELECT m.*, u.username, u.profile_json FROM sl_study_messages m INNER JOIN sl_users u ON u.id = m.user_id WHERE m.session_id = ? ORDER BY m.created_at DESC LIMIT 80").bind(sessionId).all();
      return apiResponse({ok: true, messages: (rows.results || []).reverse().map(row => ({id: row.id, user_id: row.user_id, display_name: row.user_id === ownerId ? "You" : (rowParts(row).profile.first_name || row.username), body: row.body, kind: row.kind, metadata: parseJson(row.metadata_json, {}), created_at: row.created_at}))});
    }
    if (action === "messages" && method === "POST") {
      const text = safeText(body.body, 1200); if (!text) return apiResponse({error: "Write a message first."}, 400);
      const id = newId("study_message"); const now = timestamp();
      await db.prepare("INSERT INTO sl_study_messages (id, session_id, user_id, body, kind, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, sessionId, ownerId, text, ["chat", "check_in", "resource"].includes(body.kind) ? body.kind : "chat", JSON.stringify(isObject(body.metadata) ? body.metadata : {}), now).run();
      await studyNotifyParticipants(session, ownerId, "study_message", "You have a new Study Together message.");
      return apiResponse({ok: true, message: {id, user_id: ownerId, display_name: "You", body: text, kind: body.kind || "chat", created_at: now}}, 201);
    }
    if (action === "complete" && method === "POST") {
      const current = await db.prepare("SELECT status FROM sl_study_session_members WHERE session_id = ? AND user_id = ? LIMIT 1").bind(sessionId, ownerId).first();
      if (current?.status === "completed") return apiResponse({ok: true, session: await studySessionView(session)});
      const now = timestamp();
      await db.prepare("UPDATE sl_study_session_members SET status = 'completed', goal_completed = ?, progress_note = ?, left_at = ?, updated_at = ? WHERE session_id = ? AND user_id = ?").bind(body.goal_completed === false ? 0 : 1, safeText(body.progress_note, 600), now, now, sessionId, ownerId).run();
      const remaining = await db.prepare("SELECT COUNT(*) AS count FROM sl_study_session_members WHERE session_id = ? AND status NOT IN ('completed', 'left')").bind(sessionId).first();
      await db.batch([
        db.prepare("UPDATE sl_study_sessions SET status = ?, updated_at = ? WHERE id = ?").bind(Number(remaining?.count || 0) === 0 ? "completed" : "active", now, sessionId),
        db.prepare("UPDATE sl_study_profiles SET completed_sessions = completed_sessions + 1, updated_at = ? WHERE user_id = ?").bind(now, ownerId)
      ]);
      await recordLearningSessionCompletion(db, ownerId, {occurredAt: now, sourceId: sessionId});
      await studyNotifyParticipants(session, ownerId, "study_session_completed", "Your Study Together partner completed the session.");
      return apiResponse({ok: true, session: await studySessionView(await db.prepare("SELECT * FROM sl_study_sessions WHERE id = ? LIMIT 1").bind(sessionId).first())});
    }
    if (action === "leave" && method === "POST") {
      await db.prepare("UPDATE sl_study_session_members SET status = 'left', left_at = ?, updated_at = ? WHERE session_id = ? AND user_id = ? AND status != 'completed'").bind(timestamp(), timestamp(), sessionId, ownerId).run();
      return apiResponse({ok: true});
    }
    if (action === "detail" && method === "PATCH") {
      const member = await db.prepare("SELECT * FROM sl_study_session_members WHERE session_id = ? AND user_id = ? LIMIT 1").bind(sessionId, ownerId).first();
      await db.prepare("UPDATE sl_study_session_members SET goal = ?, goal_completed = ?, progress_note = ?, updated_at = ? WHERE session_id = ? AND user_id = ?").bind(safeText(body.goal, 300), body.goal_completed ? 1 : Number(member?.goal_completed || 0), safeText(body.progress_note, 600), timestamp(), sessionId, ownerId).run();
      return apiResponse({ok: true, session: await studySessionView(await db.prepare("SELECT * FROM sl_study_sessions WHERE id = ? LIMIT 1").bind(sessionId).first())});
    }
  }

  const studyFavoriteMatch = /^\/api\/study\/favorites\/([^/]+)$/.exec(path);
  if (studyFavoriteMatch && ["POST", "DELETE"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    const partnerId = decodeURIComponent(studyFavoriteMatch[1]);
    if (partnerId === ownerId || !(await findUserById(db, partnerId))) return apiResponse({error: "Partner not found."}, 404);
    if (method === "DELETE") await db.prepare("DELETE FROM sl_study_favorites WHERE user_id = ? AND partner_id = ?").bind(ownerId, partnerId).run();
    else await db.prepare("INSERT OR IGNORE INTO sl_study_favorites (user_id, partner_id, created_at) VALUES (?, ?, ?)").bind(ownerId, partnerId, timestamp()).run();
    return apiResponse({ok: true, saved: method !== "DELETE"});
  }

  if (path === "/api/study/reports" && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const targetId = safeText(body.target_user_id, 100); const reason = safeText(body.reason, 80);
    if (!reason || !["harassment", "spam", "unsafe", "inappropriate", "other"].includes(reason)) return apiResponse({error: "Choose a report reason."}, 400);
    await db.prepare("INSERT INTO sl_study_reports (id, reporter_id, target_user_id, room_id, session_id, reason, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)").bind(newId("study_report"), ownerId, targetId || null, safeText(body.room_id, 100) || null, safeText(body.session_id, 100) || null, reason, safeText(body.details, 1000), timestamp()).run();
    if (targetId) await db.prepare("INSERT OR REPLACE INTO sl_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)").bind(ownerId, targetId, timestamp()).run();
    return apiResponse({ok: true, message: "Thanks. The report is private and has been sent to moderation."}, 201);
  }

  if (path === "/api/calls" && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const targetId = safeText(body.target_user_id, 100);
    const mode = body.mode === "video" ? "video" : "voice";
    if (!targetId || targetId === ownerId) return apiResponse({error: "Choose another active member to call."}, 400);
    const target = await findUserById(db, targetId);
    if (!target || !["member", "admin"].includes(target.role) || target.status !== "active") return apiResponse({error: "That member is not available for a call."}, 404);
    if (rowParts(viewerRow).safety.is_minor || rowParts(target).safety.is_minor) return apiResponse({error: "Direct calls are unavailable for student accounts."}, 403);
    if (await blockedConversationMember(db, ownerId, target.id)) return apiResponse({error: "Calling is blocked between these members."}, 403);

    const recentCalls = await appRecords(db, "direct_calls", null);
    const existing = recentCalls.find(call => call.caller_id === ownerId && call.callee_id === target.id && ["ringing", "accepted"].includes(call.status) && Date.now() - new Date(call.created_at || 0).getTime() < 120_000);
    if (existing) {
      const existingRoom = await appRecord(db, "video_rooms", existing.room_id);
      return apiResponse({ok: true, existing: true, balance: Number(viewerRow.time_credits || 0), call: await featureDirectCallView(db, existing, viewerRow), room: existingRoom ? await featureVideoRoomView(db, existingRoom, viewerRow) : null});
    }
    const balanceUpdate = await db.prepare("UPDATE sl_users SET time_credits = time_credits - 1, updated_at = ? WHERE id = ? AND time_credits >= 1").bind(timestamp(), ownerId).run();
    if (!Number(balanceUpdate?.meta?.changes || 0)) return apiResponse({error: "You need at least 1 credit to start a direct call."}, 402);

    const conversationId = await directConversation(db, ownerId, target.id);
    const callId = newId("call");
    const roomId = newId("room");
    const now = timestamp();
    const targetParts = rowParts(target);
    const targetName = targetParts.profile.display_name || completeName(targetParts.profile, target.username);
    const room = await saveAppRecord(db, "video_rooms", {
      id: roomId,
      owner_id: ownerId,
      host_id: ownerId,
      event_id: "",
      call_id: callId,
      call_mode: mode,
      status: "ready",
      participant_ids: [ownerId, target.id],
      participants: [],
      invite_token: randomToken(24),
      guest_access: false,
      guest_participants: [],
      guest_sessions: [],
      attendance: [
        {user_id: ownerId, state: "admitted", joined_at: null, left_at: null, duration_seconds: 0, participant_confirmed: false, host_confirmed: true},
        {user_id: target.id, state: "invited", joined_at: null, left_at: null, duration_seconds: 0, participant_confirmed: false, host_confirmed: false}
      ],
      signals: [],
      waiting_room_enabled: false,
      screen_sharing_enabled: mode === "video",
      video_enabled: mode === "video",
      audio_enabled: true,
      title: `${mode === "video" ? "Video" : "Voice"} call with ${targetName}`,
      created_at: now
    }, ownerId);
    const call = await saveAppRecord(db, "direct_calls", {
      id: callId,
      owner_id: ownerId,
      caller_id: ownerId,
      callee_id: target.id,
      conversation_id: conversationId,
      room_id: room.id,
      mode,
      status: "ringing",
      credit_amount: 1,
      credit_reference: `direct-call:${callId}`,
      participant_ids: [ownerId, target.id],
      pending_ids: [target.id],
      accepted_ids: [ownerId],
      declined_ids: [],
      message_id: "",
      created_at: now
    }, ownerId);
    const messageId = newId("msg");
    const senderParts = rowParts(viewerRow);
    const senderName = senderParts.profile.display_name || completeName(senderParts.profile, viewerRow.username);
    const messageMetadata = {type: "call", call_id: call.id, room_id: room.id, mode, status: "ringing", credit_amount: 1};
    const notification = `${senderName} is calling you.`;
    await db.batch([
      db.prepare("INSERT INTO sl_messages (id, conversation_id, sender_id, body, metadata_json, moderation_status, pinned, created_at, updated_at) VALUES (?, ?, ?, '', ?, 'visible', 0, ?, ?)").bind(messageId, conversationId, ownerId, JSON.stringify(messageMetadata), now, now),
      db.prepare("UPDATE sl_conversations SET updated_at = ? WHERE id = ?").bind(now, conversationId),
      db.prepare("INSERT INTO sl_notifications (id, user_id, actor_id, type, entity_id, message, read, created_at) VALUES (?, ?, ?, 'incoming_call', ?, ?, 0, ?)").bind(newId("notif"), target.id, ownerId, call.id, notification, now),
      db.prepare("INSERT INTO sl_app_records (collection, record_id, owner_id, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(collection, record_id) DO UPDATE SET owner_id = excluded.owner_id, record_json = excluded.record_json, updated_at = excluded.updated_at").bind("direct_calls", call.id, ownerId, JSON.stringify({...call, message_id: messageId}), now, now)
    ]);
    const updatedCall = {...call, message_id: messageId};
    const updatedUser = await findUserById(db, ownerId);
    await saveAppRecord(db, "ledger", {
      id: newId("ledger"),
      user_id: ownerId,
      amount: -1,
      balance_after: Number(updatedUser?.time_credits || 0),
      description: `${mode === "video" ? "Video" : "Voice"} call with ${targetName}`,
      reference_id: callId,
      counterparty_id: target.id
    }, ownerId);
    return apiResponse({ok: true, message: `Calling ${targetName}.`, balance: Number(updatedUser?.time_credits || 0), call: await featureDirectCallView(db, updatedCall, viewerRow), room: await featureVideoRoomView(db, room, viewerRow)}, 201);
  }

  if (path === "/api/calls/incoming" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    const now = Date.now();
    const calls = [];
    for (const call of await appRecords(db, "direct_calls", null)) {
      const age = now - new Date(call.created_at || 0).getTime();
      const pending = jsonArray(call.pending_ids, []);
      if (call.status === "ringing" && pending.length && age >= 120_000) {
        const missed = await saveAppRecord(db, "direct_calls", {...call, status: "missed", pending_ids: [], missed_at: timestamp()}, call.owner_id || call.caller_id || ownerId);
        await updateDirectCallMessage(db, missed, "missed", {pending_ids: []});
        continue;
      }
      if (["ringing", "accepted"].includes(call.status) && pending.includes(ownerId) && age < 120_000) calls.push(call);
    }
    calls.sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
    calls.splice(5);
    return apiResponse({calls: await Promise.all(calls.map(call => featureDirectCallView(db, call, viewerRow))) });
  }

  const directCallParticipants = /^\/api\/calls\/([^/]+)\/participants$/.exec(path);
  if (directCallParticipants && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const callId = decodeURIComponent(directCallParticipants[1]);
    const call = await appRecord(db, "direct_calls", callId);
    if (!call) return apiResponse({error: "Call not found."}, 404);
    const acceptedIds = jsonArray(call.accepted_ids, []);
    if (!acceptedIds.includes(ownerId)) return apiResponse({error: "Join the call before inviting another participant."}, 403);
    const targetId = safeText(body.user_id || body.target_user_id, 100);
    const target = await findUserById(db, targetId);
    const targetParts = target ? rowParts(target) : null;
    const participantIds = jsonArray(call.participant_ids, []);
    if (!target || target.status !== "active" || target.id === ownerId) return apiResponse({error: "Choose an active member to invite."}, 404);
    if (participantIds.includes(target.id)) return apiResponse({error: "That member is already in this call."}, 409);
    const now = timestamp();
    const nextCall = await saveAppRecord(db, "direct_calls", {
      ...call,
      participant_ids: [...participantIds, target.id],
      pending_ids: [...new Set([...jsonArray(call.pending_ids, []), target.id])],
      accepted_ids: acceptedIds,
      invited_by: ownerId,
      updated_at: now
    }, call.owner_id || call.caller_id || ownerId);
    const room = await appRecord(db, "video_rooms", call.room_id);
    let updatedRoom = room;
    if (room) {
      const roomParticipantIds = [...new Set([...featureRoomParticipantIds(room, null), target.id])];
      const attendance = jsonArray(room.attendance, []);
      if (!attendance.some(record => record.user_id === target.id)) attendance.push({user_id: target.id, state: "invited", joined_at: null, left_at: null, duration_seconds: 0, participant_confirmed: false, host_confirmed: false});
      updatedRoom = await saveAppRecord(db, "video_rooms", {...room, participant_ids: roomParticipantIds, attendance}, room.owner_id || ownerId);
    }
    const inviterParts = rowParts(viewerRow);
    const inviterName = inviterParts.profile.display_name || completeName(inviterParts.profile, viewerRow.username);
    await createNotification(db, {userId: target.id, actorId: ownerId, type: "incoming_call", entityId: call.id, message: `${inviterName} invited you to join a ${call.mode === "video" ? "video" : "voice"} call.`, createdAt: now});
    return apiResponse({ok: true, message: `${targetParts?.profile?.display_name || target.username} was invited to the call.`, call: await featureDirectCallView(db, nextCall, viewerRow), room: updatedRoom ? await featureVideoRoomView(db, updatedRoom, viewerRow) : null}, 201);
  }

  const directCallDetail = /^\/api\/calls\/([^/]+)$/.exec(path);
  if (directCallDetail && ["GET", "PATCH"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    const callId = decodeURIComponent(directCallDetail[1]);
    const call = await appRecord(db, "direct_calls", callId);
    if (!call) return apiResponse({error: "Call not found."}, 404);
    const participantIds = [...new Set([call.caller_id, call.callee_id, ...jsonArray(call.participant_ids, []), ...jsonArray(call.pending_ids, [])])];
    if (!participantIds.includes(ownerId)) return apiResponse({error: "You are not part of this call."}, 403);
    if (method === "GET") {
      const room = await appRecord(db, "video_rooms", call.room_id);
      return apiResponse({call: await featureDirectCallView(db, call, viewerRow), room: room ? await featureVideoRoomView(db, room, viewerRow) : null});
    }
    const action = safeText(body.action, 40);
    const pending = jsonArray(call.pending_ids, []);
    const accepted = jsonArray(call.accepted_ids, []);
    const declined = jsonArray(call.declined_ids, []);
    const now = timestamp();
    let next = {...call};
    let messageStatus = call.status;
    if (action === "accept") {
      if (!pending.includes(ownerId)) return apiResponse({error: "This call is no longer waiting for you."}, 409);
      next.pending_ids = pending.filter(id => id !== ownerId);
      next.accepted_ids = [...new Set([...accepted, ownerId])];
      next.status = "accepted";
      next.accepted_at = next.accepted_at || now;
      messageStatus = "accepted";
    } else if (action === "decline") {
      if (!pending.includes(ownerId)) return apiResponse({error: "This call is no longer waiting for you."}, 409);
      next.pending_ids = pending.filter(id => id !== ownerId);
      next.declined_ids = [...new Set([...declined, ownerId])];
      if (ownerId === call.callee_id) next.status = "declined";
      next.declined_at = now;
      messageStatus = next.status;
    } else if (["end", "hangup"].includes(action)) {
      if (!accepted.includes(ownerId) && ownerId !== call.caller_id) return apiResponse({error: "Only a call participant can end this call."}, 403);
      next.status = "ended";
      next.ended_by = ownerId;
      next.ended_at = now;
      messageStatus = "ended";
    } else {
      return apiResponse({error: "Choose accept, decline, or end."}, 400);
    }
    const saved = await saveAppRecord(db, "direct_calls", next, call.owner_id || call.caller_id || ownerId);
    await updateDirectCallMessage(db, saved, messageStatus, {accepted_ids: saved.accepted_ids, pending_ids: saved.pending_ids});
    if (saved.status === "ended" || saved.status === "declined") {
      const room = await appRecord(db, "video_rooms", saved.room_id);
      if (room && room.status !== "closed") await saveAppRecord(db, "video_rooms", {...room, status: "closed"}, room.owner_id || ownerId);
    }
    const savedRoom = await appRecord(db, "video_rooms", saved.room_id);
    return apiResponse({ok: true, message: action === "accept" ? "Call accepted." : action === "decline" ? "Call declined." : "Call ended.", call: await featureDirectCallView(db, saved, viewerRow), room: savedRoom ? await featureVideoRoomView(db, savedRoom, viewerRow) : null});
  }

  const videoInvite = /^\/api\/video\/invites\/([^/]+)(?:\/(join))?$/.exec(path);
  if (videoInvite && ["GET", "POST"].includes(method)) {
    const token = decodeURIComponent(videoInvite[1]);
    const room = await ensureVideoRoomInvite(db, (await appRecords(db, "video_rooms", null)).find(item => item.invite_token === token && item.status !== "closed"));
    if (!room) return apiResponse({error: "That meeting invite is no longer available."}, 404);
    if (method === "GET") return apiResponse({invite: await featureVideoInvitePreview(db, room)});
    if (videoInvite[2] !== "join") return apiResponse({error: "Use the meeting invite link to join this room."}, 400);
    if (viewerRow) {
      const participantIds = featureRoomParticipantIds(room, null);
      if (!participantIds.includes(ownerId)) participantIds.push(ownerId);
      const attendance = jsonArray(room.attendance, []);
      let record = attendance.find(item => item.user_id === ownerId);
      if (record && ["denied", "removed"].includes(record.state)) return apiResponse({error: "The host has not admitted this account."}, 403);
      if (!record) {
        record = {user_id: ownerId, state: "invited", joined_at: null, left_at: null, duration_seconds: 0, participant_confirmed: false, host_confirmed: false};
        attendance.push(record);
      }
      record.state = ownerId === room.host_id ? "admitted" : (room.waiting_room_enabled !== false ? "waiting" : "admitted");
      record.join_requested_at = timestamp();
      const saved = await saveAppRecord(db, "video_rooms", {...room, participant_ids: participantIds, attendance}, room.owner_id || ownerId);
      return apiResponse({room: await featureVideoRoomView(db, saved, viewerRow), guest: false, signals: jsonArray(saved.signals, [])});
    }
    const displayName = safeText(body.display_name, 80);
    if (displayName.length < 2) return apiResponse({error: "Enter your name before joining the meeting."}, 400);
    const guests = jsonArray(room.guest_participants, []);
    if (guests.length >= 25) return apiResponse({error: "This meeting has reached its guest limit."}, 403);
    const guestId = newId("guest");
    const guestSessionToken = randomToken(32);
    const guest = {id: guestId, username: `guest-${guestId.slice(-8)}`, display_name: displayName, profile_color: "blue", created_at: timestamp()};
    const participantIds = [...new Set([...featureRoomParticipantIds(room, null), guestId])];
    const attendance = jsonArray(room.attendance, []);
    attendance.push({user_id: guestId, state: room.waiting_room_enabled !== false ? "waiting" : "admitted", joined_at: null, left_at: null, duration_seconds: 0, participant_confirmed: false, host_confirmed: false, join_requested_at: timestamp()});
    const saved = await saveAppRecord(db, "video_rooms", {
      ...room,
      participant_ids: participantIds,
      guest_access: true,
      guest_participants: [...guests, guest],
      guest_sessions: [...jsonArray(room.guest_sessions, []), {token: guestSessionToken, guest_id: guestId, display_name: displayName, created_at: timestamp()}],
      attendance
    }, room.owner_id || "");
    return apiResponse({room: await featureVideoRoomView(db, saved, null, {viewer_id: guestId}), guest: true, guest_id: guestId, guest_name: displayName, guest_session_token: guestSessionToken, signals: jsonArray(saved.signals, [])});
  }

  if (path === "/api/dashboard/onboarding" && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    await saveAppRecord(db, "onboarding", {id: ownerId, user_id: ownerId, complete: true, completed_at: timestamp()}, ownerId);
    return apiResponse({message: "Walkthrough saved."});
  }
  if (path === "/api/achievements" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    const pins = await appRecord(db, "achievements", ownerId);
    const badges = featureAchievementBadges(viewer, jsonArray(pins?.achievement_ids, []));
    return apiResponse({badges, stats: {earned: badges.filter(item => item.earned).length, total: badges.length, pinned: badges.filter(item => item.pinned).length}});
  }
  if (path === "/api/achievements/pins" && method === "PATCH") {
    const denied = requireViewer(); if (denied) return denied;
    const achievementIds = Array.isArray(body.achievement_ids) ? body.achievement_ids.slice(0, 4).map(String) : [];
    await saveAppRecord(db, "achievements", {id: ownerId, user_id: ownerId, achievement_ids: achievementIds}, ownerId);
    return apiResponse({badges: featureAchievementBadges(viewer, achievementIds)});
  }

  if (path === "/api/blog/feed" && method === "GET") {
    const sort = url.searchParams.get("sort") === "popular" ? "popular" : "latest";
    const posts = (await appRecords(db, "blogs", null)).filter(post => post.status !== "draft" && post.visibility !== "private" && (post.visibility !== "followers" || post.owner_id === ownerId));
    posts.sort((left, right) => sort === "popular" ? Number(right.like_count || 0) - Number(left.like_count || 0) || String(right.created_at).localeCompare(String(left.created_at)) : String(right.created_at).localeCompare(String(left.created_at)));
    return apiResponse({viewer, posts, stats: {posts: posts.length, media: posts.filter(post => jsonArray(post.media, []).length).length}});
  }
  if (path === "/api/blog/posts" && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const title = safeText(body.title, 180);
    const content = safeText(body.body || body.content, 20_000);
    if (title.length < 4) return apiResponse({error: "Give your blog a title of at least four characters."}, 400);
    if (content.length < 40) return apiResponse({error: "Add at least 40 characters so your blog has enough context."}, 400);
    const blogId = newId("blog");
    const mediaFiles = Array.isArray(body.media) ? body.media.filter(file => file && typeof file.arrayBuffer === "function") : [];
    const media = await blogMediaUpload(env, mediaFiles, blogId);
    const post = await saveAppRecord(db, "blogs", {id: blogId, ...body, media, owner_id: ownerId, author_id: ownerId, title, body: content, status: "published", visibility: body.visibility === "followers" ? "followers" : "public", tags: Array.isArray(body.tags) ? body.tags.slice(0, 6) : csvValues(body.tags), like_user_ids: [], share_user_ids: [], like_count: 0, comment_count: 0, created_at: timestamp()}, ownerId);
    return apiResponse({message: "Your blog is published.", post}, 201);
  }
  const blogPath = /^\/api\/blog\/posts\/([^/]+)(?:\/(like|comments|share))?$/.exec(path);
  if (blogPath) {
    const blogId = decodeURIComponent(blogPath[1]);
    const post = await appRecord(db, "blogs", blogId);
    if (!post) return apiResponse({error: "That blog could not be found."}, 404);
    const action = blogPath[2] || "detail";
    if (action === "detail" && method === "GET") return apiResponse({post});
    if (action === "comments" && method === "GET") return apiResponse({comments: await appRecords(db, "blog_comments", null).then(rows => rows.filter(item => item.blog_id === blogId))});
    const denied = requireViewer(); if (denied) return denied;
    if (action === "like" && ["POST", "DELETE"].includes(method)) {
      const ids = jsonArray(post.like_user_ids, []);
      const index = ids.indexOf(ownerId);
      if (method === "POST" && index < 0) ids.push(ownerId);
      if (method === "DELETE" && index >= 0) ids.splice(index, 1);
      const saved = await saveAppRecord(db, "blogs", {...post, like_user_ids: ids, like_count: ids.length}, post.owner_id);
      return apiResponse({post: saved});
    }
    if (action === "share" && method === "POST") {
      const ids = jsonArray(post.share_user_ids, []);
      if (!ids.includes(ownerId)) ids.push(ownerId);
      return apiResponse({message: "Blog link saved to your shared activity.", post: await saveAppRecord(db, "blogs", {...post, share_user_ids: ids}, post.owner_id)});
    }
    if (action === "comments" && method === "POST") {
      const message = safeText(body.body || body.message || body.comment, 800);
      if (!message) return apiResponse({error: "Write a comment before posting."}, 400);
      const comment = await saveAppRecord(db, "blog_comments", {id: newId("blog-comment"), blog_id: blogId, author_id: ownerId, body: message, created_at: timestamp()}, ownerId);
      const comments = await appRecords(db, "blog_comments", null);
      const saved = await saveAppRecord(db, "blogs", {...post, comment_count: comments.filter(item => item.blog_id === blogId).length}, post.owner_id);
      return apiResponse({message: "Comment added.", comment, post: saved}, 201);
    }
  }

  if (["/api/contact", "/api/complaints", "/api/feedback", "/api/newsletter/subscribe", "/api/early-registration"].includes(path) && method === "POST") {
    const collection = path === "/api/contact" ? "contact_messages" : path === "/api/complaints" ? "complaints" : path === "/api/feedback" ? "feedback" : path === "/api/early-registration" ? "early_registrations" : "newsletter";
    const idPrefix = collection.replace(/_/g, "-").replace(/s$/, "");
    const record = await saveAppRecord(db, collection, {id: newId(idPrefix), ...body, user_id: ownerId, status: "new", created_at: timestamp()}, ownerId);
    return apiResponse({message: path === "/api/complaints" ? "Your complaint was received and assigned a reference." : path === "/api/feedback" ? "Your feedback was saved." : "Your message was saved.", reference: record.id}, 201);
  }

  if (path === "/api/mentor/dashboard" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    const application = await appRecord(db, "mentor_applications", ownerId);
    return apiResponse({stats: {sessions: 0, learners: 0, credits: 0}, sessions: [], workshops: [], marketplace_items: [], application, applications: application ? [application] : []});
  }
  if (path === "/api/mentor/application" && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const application = await saveAppRecord(db, "mentor_applications", {id: ownerId, ...body, user_id: ownerId, status: "pending", created_at: timestamp()}, ownerId);
    return apiResponse({message: "Mentor application saved for review.", application}, 201);
  }
  if (path === "/api/student-safety" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    return apiResponse({authenticated: true, stats: {controls: 4, protected_accounts: 0, pending_reviews: 0}, controls: ["Guardian consent for minors", "Age-appropriate discovery and messaging", "Report, block, and moderation controls", "Audit trails for safeguarding decisions"], safety: viewer.safety, user: viewer});
  }
  if (path === "/api/student-safety/guardian-consent" && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const safety = {...(viewer.safety || {}), ...body, guardian_consent_status: "pending"};
    await db.prepare("UPDATE sl_users SET safety_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(safety), timestamp(), ownerId).run();
    return apiResponse({message: "Guardian consent details saved.", safety});
  }
  if (path === "/api/moderation/center" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    const reports = await appRecords(db, "reports", null);
    return apiResponse({stats: {open_reports: reports.filter(item => !["resolved", "dismissed"].includes(item.status)).length, student_reviews: 0, mentor_applications: 0}, reports, student_ideas: [], mentor_applications: []});
  }
  if (path === "/api/roadmap" && method === "GET") {
    const items = await appRecords(db, "roadmap", null);
    return apiResponse({stats: {planned: items.filter(item => item.status === "planned").length, in_progress: items.filter(item => item.status === "in_progress").length, shipped: items.filter(item => item.status === "shipped").length}, items});
  }
  const roadmapVote = /^\/api\/roadmap\/items\/([^/]+)\/vote$/.exec(path);
  if (roadmapVote && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const itemId = decodeURIComponent(roadmapVote[1]);
    const existing = await appRecord(db, "roadmap", itemId) || {id: itemId, title: "SwapLabs roadmap item", status: "planned", votes: []};
    const votes = jsonArray(existing.votes, []).filter(id => id !== ownerId);
    if (body.vote !== false) votes.push(ownerId);
    return apiResponse({item: await saveAppRecord(db, "roadmap", {...existing, votes, vote_count: votes.length}, existing.owner_id), message: "Roadmap vote saved."});
  }
  if (path === "/api/roadmap/suggestions" && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const suggestion = await saveAppRecord(db, "roadmap", {id: newId("roadmap"), ...body, owner_id: ownerId, status: "planned", votes: [ownerId], created_at: timestamp()}, ownerId);
    return apiResponse({message: "Roadmap suggestion saved.", item: suggestion}, 201);
  }
  if (path === "/api/skill-battle" && method === "GET") return apiResponse({battles: await appRecords(db, "skill_battles", null), entries: await appRecords(db, "skill_battle_entries", null)});
  const battleEntry = /^\/api\/skill-battle\/([^/]+)\/entries$/.exec(path);
  if (battleEntry && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const entry = await saveAppRecord(db, "skill_battle_entries", {id: newId("battle-entry"), battle_id: decodeURIComponent(battleEntry[1]), ...body, owner_id: ownerId, created_at: timestamp()}, ownerId);
    return apiResponse({entry, message: "Skill battle entry submitted."}, 201);
  }
  const battleLike = /^\/api\/skill-battle\/entries\/([^/]+)\/like$/.exec(path);
  if (battleLike && ["POST", "DELETE"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    const entryId = decodeURIComponent(battleLike[1]);
    const entry = await appRecord(db, "skill_battle_entries", entryId);
    if (!entry) return apiResponse({error: "Skill battle entry not found."}, 404);
    const ids = jsonArray(entry.like_user_ids, []);
    if (method === "POST" && !ids.includes(ownerId)) ids.push(ownerId);
    if (method === "DELETE") entry.like_user_ids = ids.filter(id => id !== ownerId); else entry.like_user_ids = ids;
    entry.like_count = entry.like_user_ids.length;
    return apiResponse({entry: await saveAppRecord(db, "skill_battle_entries", entry, entry.owner_id)});
  }

  if (path === "/api/marketplace" && method === "GET") {
    const items = await appRecords(db, "marketplace_items", null);
    const orders = viewerRow ? await appRecords(db, "marketplace_orders", ownerId) : [];
    return apiResponse({items, my_orders: orders, authenticated: Boolean(viewerRow), balance: Number(viewerRow?.time_credits || 0), stats: {offers: items.length, orders: orders.length, credits_moved: orders.reduce((sum, item) => sum + Number(item.price_credits || 0), 0)}});
  }
  const marketplacePurchase = /^\/api\/marketplace\/([^/]+)\/purchase$/.exec(path);
  if (marketplacePurchase && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const itemId = decodeURIComponent(marketplacePurchase[1]);
    const item = await appRecord(db, "marketplace_items", itemId);
    if (!item) return apiResponse({error: "Marketplace offer not found."}, 404);
    if (item.owner_id === ownerId) return apiResponse({error: "You cannot purchase your own offer."}, 400);
    const existingOrders = await appRecords(db, "marketplace_orders", ownerId);
    const existing = existingOrders.find(order => order.item_id === itemId && !["cancelled", "declined"].includes(order.status));
    if (existing) return apiResponse({order: existing, message: "You already have an open request for this offer."});
    const order = await saveAppRecord(db, "marketplace_orders", {id: newId("order"), item_id: itemId, buyer_id: ownerId, seller_id: item.owner_id, price_credits: Number(item.price_credits || 0), status: "requested", created_at: timestamp()}, ownerId);
    if (item.owner_id) await createNotification(db, {userId: item.owner_id, actorId: ownerId, type: "marketplace_order", entityId: order.id, message: `${viewer.profile?.display_name || viewer.username} requested your marketplace offer.`});
    return apiResponse({order, message: "Marketplace request sent."}, 201);
  }
  const marketplaceItem = /^\/api\/marketplace\/([^/]+)$/.exec(path);
  if (marketplaceItem && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const itemId = decodeURIComponent(marketplaceItem[1]);
    const item = await appRecord(db, "marketplace_items", itemId);
    if (!item) return apiResponse({error: "Marketplace offer not found."}, 404);
    const order = await saveAppRecord(db, "marketplace_orders", {id: newId("order"), item_id: itemId, buyer_id: ownerId, seller_id: item.owner_id, price_credits: Number(item.price_credits || 0), status: "requested", created_at: timestamp()}, ownerId);
    return apiResponse({order, message: "Marketplace request sent."}, 201);
  }

  if (path === "/api/session-room" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    const allMembers = await allUserRows(db);
    const eventContext = {
      ratings: await appRecords(db, "session_ratings", null),
      reports: await appRecords(db, "session_progress_reports", null),
      pointReviews: await appRecords(db, "session_point_reviews", null),
      memberCache: new Map(allMembers.map(row => [String(row.id), row]))
    };
    const events = await Promise.all((await appRecords(db, "events", null)).filter(event => event.host_id === ownerId || featureParticipantIds(event).includes(ownerId)).map(event => featureEventViewFor(db, event, viewerRow, eventContext)));
    const rooms = await Promise.all((await appRecords(db, "video_rooms", null)).filter(room => room.owner_id === ownerId || room.event_id && events.some(event => event.id === room.event_id)).map(room => featureVideoRoomView(db, room, viewerRow, eventContext)));
    return apiResponse({events, rooms, stats: {sessions: events.length, rooms: rooms.length, attendance: 0}});
  }
  if (path === "/api/video/rooms" && ["GET", "POST"].includes(method)) {
    const denied = requireViewer(); if (denied) return denied;
    if (method === "GET") {
      const rooms = (await appRecords(db, "video_rooms", null)).filter(room => room.owner_id === ownerId || room.host_id === ownerId || featureRoomParticipantIds(room, null).includes(ownerId));
      const allMembers = await allUserRows(db);
      const eventContext = {
        ratings: await appRecords(db, "session_ratings", null),
        reports: await appRecords(db, "session_progress_reports", null),
        pointReviews: await appRecords(db, "session_point_reviews", null),
        memberCache: new Map(allMembers.map(row => [String(row.id), row]))
      };
      return apiResponse({rooms: await Promise.all(rooms.map(room => featureVideoRoomView(db, room, viewerRow, eventContext)))});
    }
    const event = body.event_id ? await appRecord(db, "events", String(body.event_id)) : null;
    if (body.event_id && !event) return apiResponse({error: "The linked session was not found."}, 404);
    const eventMembers = event ? [event.host_id, ...featureParticipantIds(event)] : [];
    if (event && viewerRow.role !== "admin" && !eventMembers.includes(ownerId)) return apiResponse({error: "Only session members can create this room."}, 403);
    const hostId = event?.host_id || ownerId;
    const participantIds = [...new Set([hostId, ...eventMembers, ...jsonArray(body.participant_ids, [])].filter(Boolean))];
    const waitingRoom = body.waiting_room_enabled !== false;
    const room = await saveAppRecord(db, "video_rooms", {
      id: newId("room"), ...body, owner_id: ownerId, host_id: hostId, event_id: event?.id || body.event_id || "", status: "ready",
      participant_ids: participantIds, participants: [],
      invite_token: randomToken(24), guest_access: true, guest_participants: [], guest_sessions: [],
      attendance: participantIds.map(userId => ({user_id: userId, state: userId === hostId ? "admitted" : "invited", joined_at: null, left_at: null, duration_seconds: 0, participant_confirmed: false, host_confirmed: userId === hostId})),
      signals: [], waiting_room_enabled: waitingRoom, screen_sharing_enabled: body.screen_sharing_enabled !== false,
      video_enabled: true, audio_enabled: true, title: safeText(body.title || event?.title || "SwapLabs video room", 180), created_at: timestamp()
    }, ownerId);
    if (event) await saveAppRecord(db, "events", {...event, video_room_id: room.id, video_invite_token: room.invite_token}, event.owner_id || event.host_id || ownerId);
    return apiResponse({room: await featureVideoRoomView(db, room, viewerRow), signals: [], message: "Room ready."}, 201);
  }
  const videoAttendance = /^\/api\/video\/rooms\/([^/]+)\/attendance$/.exec(path);
  if (videoAttendance && method === "POST") {
    const roomId = decodeURIComponent(videoAttendance[1]);
    const room = await appRecord(db, "video_rooms", roomId);
    if (!room) return apiResponse({error: "Video room not found."}, 404);
    const guestSession = videoGuestSession(request, room);
    if (!viewerRow && !guestSession) {
      const denied = requireViewer(); if (denied) return denied;
    }
    const activeId = viewerRow?.id || String(guestSession?.guest_id || "");
    const participantIds = featureRoomParticipantIds(room, null);
    if (!participantIds.includes(activeId)) return apiResponse({error: "You are not invited to this room."}, 403);
    const action = String(body.action || "");
    const targetId = String(body.target_id || activeId);
    if (targetId !== activeId && room.host_id !== activeId) return apiResponse({error: "Only the room host can update another member's attendance."}, 403);
    const attendance = jsonArray(room.attendance, []);
    let record = attendance.find(item => item.user_id === targetId);
    if (!record) {
      record = {user_id: targetId, state: "invited", joined_at: null, left_at: null, duration_seconds: 0, participant_confirmed: false, host_confirmed: false};
      attendance.push(record);
    }
    if (action === "joined") {
      if (room.waiting_room_enabled && targetId !== room.host_id && !["admitted", "in_call"].includes(record.state)) return apiResponse({error: "Wait for the host to admit you."}, 403);
      record.state = "in_call";
      record.joined_at = record.joined_at || timestamp();
      record.left_at = null;
    } else if (action === "left") {
      record.left_at = timestamp();
      record.state = "left";
      if (record.joined_at) record.duration_seconds = Math.max(0, Math.round((new Date(record.left_at).getTime() - new Date(record.joined_at).getTime()) / 1000));
    } else if (action === "quality") {
      record.connection_check = isObject(body.connection_check) ? body.connection_check : {};
      record.last_quality_at = timestamp();
    } else if (action === "confirm") {
      if (targetId === activeId) record.participant_confirmed = true;
      if (room.host_id === activeId) record.host_confirmed = true;
      if (room.host_id === targetId && activeId === room.host_id) record.host_confirmed = true;
      record.confirmed_at = timestamp();
    } else {
      return apiResponse({error: "Unknown attendance action."}, 400);
    }
    const saved = await saveAppRecord(db, "video_rooms", {...room, participant_ids: participantIds, attendance}, room.owner_id || activeId);
    return apiResponse({room: await featureVideoRoomView(db, saved, viewerRow, guestSession ? {viewer_id: activeId} : null)});
  }
  const videoParticipant = /^\/api\/video\/rooms\/([^/]+)\/participants\/([^/]+)$/.exec(path);
  if (videoParticipant && method === "PATCH") {
    const denied = requireViewer(); if (denied) return denied;
    const roomId = decodeURIComponent(videoParticipant[1]);
    const targetId = decodeURIComponent(videoParticipant[2]);
    const room = await appRecord(db, "video_rooms", roomId);
    if (!room) return apiResponse({error: "Video room not found."}, 404);
    if (room.host_id !== ownerId && viewerRow.role !== "admin") return apiResponse({error: "Only the room host can manage participants."}, 403);
    const action = String(body.action || "");
    const attendance = jsonArray(room.attendance, []);
    let record = attendance.find(item => item.user_id === targetId);
    if (!record) {
      record = {user_id: targetId, state: "invited", joined_at: null, left_at: null, duration_seconds: 0, participant_confirmed: false, host_confirmed: false};
      attendance.push(record);
    }
    if (action === "admit") record.state = "admitted";
    else if (action === "deny") record.state = "denied";
    else if (action === "remove") record.state = "removed";
    else return apiResponse({error: "Unknown participant action."}, 400);
    const saved = await saveAppRecord(db, "video_rooms", {...room, attendance}, room.owner_id || ownerId);
    return apiResponse({room: await featureVideoRoomView(db, saved, viewerRow)});
  }
  const videoRoom = /^\/api\/video\/rooms\/([^/]+)(?:\/(join|leave|signals))?$/.exec(path);
  if (videoRoom && ["GET", "POST", "PATCH"].includes(method)) {
    const roomId = decodeURIComponent(videoRoom[1]);
    const room = await appRecord(db, "video_rooms", roomId);
    if (!room) return apiResponse({error: "Video room not found."}, 404);
    const guestSession = videoGuestSession(request, room);
    if (!viewerRow && !guestSession) {
      const denied = requireViewer(); if (denied) return denied;
    }
    const activeId = viewerRow?.id || String(guestSession?.guest_id || "");
    const viewContext = guestSession ? {viewer_id: activeId} : null;
    const action = videoRoom[2] || "detail";
    if (action === "signals") {
      const signals = jsonArray(room.signals, []);
      if (!featureRoomParticipantIds(room, null).includes(activeId)) return apiResponse({error: "You are not invited to this room."}, 403);
      if (method === "POST") signals.push({id: newId("signal"), sender_id: activeId, target_id: body.target_id || null, type: safeText(body.type, 80), payload: isObject(body.payload) ? body.payload : {}, created_at: timestamp()});
      const saved = method === "POST" ? await saveAppRecord(db, "video_rooms", {...room, signals: signals.slice(-200)}, room.owner_id || activeId) : room;
      const after = url.searchParams.get("after") || "";
      const visibleSignals = jsonArray(saved.signals, []).filter(signal => (!after || String(signal.created_at) > after) && (!signal.target_id || signal.target_id === activeId || signal.sender_id === activeId));
      return apiResponse({room: await featureVideoRoomView(db, saved, viewerRow, viewContext), signals: visibleSignals, server_time: timestamp()});
    }
    if (action === "detail" && method === "GET") return apiResponse({room: await featureVideoRoomView(db, room, viewerRow, viewContext), signals: jsonArray(room.signals, [])});
    if (action === "detail" && method === "PATCH") {
      if (!viewerRow || (room.host_id !== activeId && viewerRow.role !== "admin")) return apiResponse({error: "Only the room host can update room settings."}, 403);
      const allowed = ["title", "waiting_room_enabled", "screen_sharing_enabled", "video_enabled", "audio_enabled", "status"];
      const updates = Object.fromEntries(allowed.filter(key => body[key] !== undefined).map(key => [key, key === "title" ? safeText(body[key], 180) : Boolean(body[key])]));
      if (body.status !== undefined) updates.status = safeText(body.status, 40);
      const saved = await saveAppRecord(db, "video_rooms", {...room, ...updates}, room.owner_id || activeId);
      return apiResponse({room: await featureVideoRoomView(db, saved, viewerRow, viewContext)});
    }
    if (action === "join" && method === "POST") {
      const participantIds = featureRoomParticipantIds(room, null);
      if (!participantIds.includes(activeId)) return apiResponse({error: "You are not invited to this room."}, 403);
      const attendance = jsonArray(room.attendance, []);
      let record = attendance.find(item => item.user_id === activeId);
      if (!record) {
        record = {user_id: activeId, state: "invited", joined_at: null, left_at: null, duration_seconds: 0, participant_confirmed: false, host_confirmed: false};
        attendance.push(record);
      }
      if (["denied", "removed"].includes(record.state)) return apiResponse({error: "The host has not admitted this account."}, 403);
      record.state = room.waiting_room_enabled && activeId !== room.host_id ? "waiting" : "admitted";
      record.connection_check = isObject(body.connection_check) ? body.connection_check : record.connection_check || {};
      record.join_requested_at = timestamp();
      const saved = await saveAppRecord(db, "video_rooms", {...room, participant_ids: participantIds, attendance}, room.owner_id || activeId);
      return apiResponse({room: await featureVideoRoomView(db, saved, viewerRow, viewContext), signals: jsonArray(saved.signals, [])});
    }
    if (action === "leave" && method === "POST") {
      const attendance = jsonArray(room.attendance, []);
      const record = attendance.find(item => item.user_id === activeId);
      if (record) {
        record.left_at = timestamp();
        record.state = "left";
        if (record.joined_at) record.duration_seconds = Math.max(0, Math.round((new Date(record.left_at).getTime() - new Date(record.joined_at).getTime()) / 1000));
      }
      const saved = await saveAppRecord(db, "video_rooms", {...room, attendance}, room.owner_id || activeId);
      return apiResponse({room: await featureVideoRoomView(db, saved, viewerRow, viewContext), signals: jsonArray(saved.signals, [])});
    }
  }

  if (path === "/api/swapbot/history") {
    const denied = requireViewer(); if (denied) return denied;
    if (method === "GET") {
      const record = await appRecord(db, ASSISTANT_HISTORY_COLLECTION, ownerId);
      return apiResponse({
        exists: Boolean(record),
        messages: normalizeAssistantHistoryMessages(record?.messages),
        reminders: normalizeAssistantHistoryReminders(record?.reminders)
      });
    }
    if (method === "PUT") {
      const messages = normalizeAssistantHistoryMessages(body.messages);
      const reminders = normalizeAssistantHistoryReminders(body.reminders);
      const saved = await saveAppRecord(db, ASSISTANT_HISTORY_COLLECTION, {
        id: ownerId,
        user_id: ownerId,
        messages,
        reminders
      }, ownerId);
      return apiResponse({ok: true, exists: true, messages: saved.messages, reminders: saved.reminders, updated_at: saved.updated_at});
    }
    if (method === "DELETE") {
      await deleteAppRecord(db, ASSISTANT_HISTORY_COLLECTION, ownerId);
      return apiResponse({ok: true, exists: false, messages: [], reminders: []});
    }
  }
  if (path === "/api/swapbot/ask" && method === "POST") return apiResponse({answer: "SwapLabs can help you explore profiles, schedule an exchange, and keep track of your learning. Try the directory or your calendar next."});
  const fundingPledge = /^\/api\/funding\/ideas\/([^/]+)\/pledges$/.exec(path);
  if (fundingPledge && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const idea = await appRecord(db, "ideas", decodeURIComponent(fundingPledge[1]));
    if (!idea) return apiResponse({error: "That idea could not be found."}, 404);
    const pledges = [...jsonArray(idea.pledges, []), {id: newId("pledge"), user_id: ownerId, ...body, created_at: timestamp()}];
    return apiResponse({idea: await saveAppRecord(db, "ideas", {...idea, pledges}, idea.owner_id), message: "Your pledge was recorded."}, 201);
  }

  if (path === "/api/inbox/reports" && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const report = await saveAppRecord(db, "reports", {id: newId("report"), ...body, reporter_id: ownerId, status: "open", created_at: timestamp()}, ownerId);
    return apiResponse({message: "Your report was submitted.", report}, 201);
  }
  const blockUser = /^\/api\/inbox\/users\/([^/]+)\/block$/.exec(path);
  if (blockUser && method === "POST") {
    const denied = requireViewer(); if (denied) return denied;
    const block = await saveAppRecord(db, "blocks", {id: `${ownerId}:${decodeURIComponent(blockUser[1])}`, blocker_id: ownerId, blocked_id: decodeURIComponent(blockUser[1]), blocked: body.blocked !== false, created_at: timestamp()}, ownerId);
    return apiResponse({message: block.blocked ? "Member blocked." : "Member unblocked."});
  }

  if (path === "/api/account/export" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    const collections = ["events", "journals", "portfolios", "ideas", "swapjobs", "ledger", "disputes", "feedback", ASSISTANT_HISTORY_COLLECTION];
    const data = {user: viewer, records: {}};
    for (const collection of collections) data.records[collection] = await appRecords(db, collection, ownerId);
    return apiResponse({ok: true, exported_at: timestamp(), data});
  }
  if (path === "/api/account/session-history.csv" && method === "GET") {
    const denied = requireViewer(); if (denied) return denied;
    const events = (await appRecords(db, "events", null)).filter(event => event.host_id === ownerId || jsonArray(event.participant_ids, []).includes(ownerId));
    const csv = ["id,title,starts_at,ends_at,status", ...events.map(event => [event.id, event.title, event.starts_at, event.ends_at, event.status].map(value => `"${String(value || "").replace(/"/g, '""')}"`).join(","))].join("\r\n") + "\r\n";
    return new Response(csv, {headers: {"content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=relayskills-session-history.csv", "cache-control": "no-store"}});
  }

  if (path.startsWith("/api/admin/")) {
    const denied = requireAdmin(); if (denied) return denied;
    const contentMatch = /^\/api\/admin\/content\/([^/]+)\/([^/]+)$/.exec(path);
    if (contentMatch && ["PATCH", "DELETE"].includes(method)) {
      const collectionMap = {contacts: "contact_messages", complaints: "complaints", feedback: "feedback", ideas: "ideas", blogs: "blogs", reports: "reports"};
      const collection = collectionMap[contentMatch[1]] || contentMatch[1];
      const recordId = decodeURIComponent(contentMatch[2]);
      const record = await appRecord(db, collection, recordId);
      if (!record) return apiResponse({error: "That record was not found."}, 404);
      if (method === "DELETE") await deleteAppRecord(db, collection, recordId);
      else await saveAppRecord(db, collection, {...record, ...body}, record.owner_id);
      return apiResponse({message: method === "DELETE" ? "Record deleted." : "Record updated."});
    }
    const records = await appRecords(db, "reports", null);
    return apiResponse({items: records, reports: records, records, users: (await allUserRows(db)).map(adminUser)});
  }

  return null;
}

function isLocalApi(path) {
  // The deployed app owns the complete /api surface. Falling through to the
  // disabled upstream proxy made any newly added page action look like a 404.
  // Keep this broad so the hosted worker and the localhost adapter exercise
  // the same feature router; individual handlers still enforce auth and verbs.
  if (path.startsWith("/api/")) return true;
  return path === "/api/storage/status" || path === "/api/auth/csrf" || path === "/api/auth/me" || path === "/api/auth/username-availability" || path === "/api/auth/register" ||
    path === "/api/auth/login" || path === "/api/auth/admin-gate" || path === "/api/auth/logout" ||
    path === "/api/profile" || path === "/api/profile/password" ||
    path === "/api/account" || path === "/api/account/privacy" || path === "/api/account/privacy/cleanup" ||
    path === "/api/dashboard" || path === "/api/streak" || path === "/api/members" || path === "/api/community" || path === "/api/notifications" ||
    path === "/api/gifts/vouchers" || path === "/api/gifts/vouchers/redeem" ||
    path === "/api/platform/metrics" || path === "/api/public/content" || path === "/api/testimonials" || path === "/api/leaderboard" || path === "/api/matches" ||
    path === "/api/organizations/register" || path === "/api/organizations/overview" || path === "/api/organizations/members" || /^\/api\/organizations\/members\/[^/]+\/password$/.test(path) || path === "/api/organizations/policy" ||
    path === "/api/admin/overview" || path === "/api/admin/operations" ||
    path === "/api/admin/content" || path === "/api/admin/newsletter" || path === "/api/admin/messages" || path === "/api/admin/users" ||
    path === "/api/admin/users/bulk" || path.startsWith("/api/admin/users/") ||
    path === "/api/workshops" || /^\/api\/workshops\/share\/[^/]+$/.test(path) || /^\/api\/workshops\/[^/]+\/register$/.test(path) ||
    path === "/api/courses" || /^\/api\/courses\/[^/]+$/.test(path) ||
    path === "/api/swaps" ||
    path === "/api/inbox" || path.startsWith("/api/inbox/conversations/") || path === "/api/inbox/conversations" ||
    path === "/api/inbox/groups" || /^\/api\/inbox\/groups\/[^/]+(?:\/members\/me)?$/.test(path) ||
    path === "/api/community/feed" || path === "/api/community/posts" || path === "/api/community/stories" ||
    path === "/api/community/groups" || /^\/api\/community\/groups\/[^/]+(?:\/join|\/join-requests\/[^/]+)$/.test(path) ||
    /^\/api\/community\/posts\/[^/]+(?:\/(?:like|share|comments))?$/.test(path) ||
    /^\/api\/community\/stories\/[^/]+$/.test(path) ||
    /^\/api\/community\/users\/[^/]+\/portfolio$/.test(path) || /^\/api\/community\/users\/[^/]+\/follow$/.test(path) ||
    path === "/api/livestreams" || /^\/api\/livestreams\/[^/]+(?:\/(?:start|end|join|leave|heartbeat|chat|signals))?$/.test(path) ||
    path === "/api/notifications/read-all" || /^\/api\/notifications\/[^/]+$/.test(path) || /^\/api\/notifications\/follow-requests\/[^/]+(?:\/accept)?$/.test(path) ||
    path === "/api/calendar" || path === "/api/calendar/availability" || /^\/api\/calendar\/events(?:\/[^/]+)?(?:\/(?:ics|rating|duplicate))?$/.test(path) ||
    path === "/api/credits" || path === "/api/credits/transfer" || path === "/api/credits/disputes" ||
    path === "/api/journal" || /^\/api\/journal\/[^/]+$/.test(path) || path === "/api/portfolio" || /^\/api\/portfolio\/items(?:\/[^/]+)?$/.test(path) ||
    path === "/api/ideas" || /^\/api\/ideas\/[^/]+\/(?:like|save|comments)(?:\/[^/]+)?$/.test(path) || path === "/api/funding" || /^\/api\/funding\/ideas\/[^/]+\/pledges$/.test(path) ||
    path === "/api/swapjobs" || /^\/api\/swapjobs\/[^/]+(?:\/.*)?$/.test(path) || path === "/api/achievements" || path === "/api/achievements/pins" || path === "/api/dashboard/onboarding" ||
    path === "/api/blog/feed" || path === "/api/blog/posts" || /^\/api\/blog\/posts\/[^/]+(?:\/(?:like|comments|share))?$/.test(path) ||
    path === "/api/contact" || path === "/api/complaints" || path === "/api/feedback" || path === "/api/newsletter/subscribe" || path === "/api/early-registration" ||
    path === "/api/mentor/dashboard" || path === "/api/mentor/application" || path === "/api/student-safety" || path === "/api/student-safety/guardian-consent" || path === "/api/moderation/center" ||
    path === "/api/roadmap" || /^\/api\/roadmap\/items\/[^/]+\/vote$/.test(path) || path === "/api/roadmap/suggestions" || path === "/api/skill-battle" ||
    /^\/api\/skill-battle\/[^/]+\/entries$/.test(path) || /^\/api\/skill-battle\/entries\/[^/]+\/like$/.test(path) || path === "/api/marketplace" || /^\/api\/marketplace\/[^/]+$/.test(path) ||
    path === "/api/session-room" || path === "/api/video/rooms" || /^\/api\/video\/rooms\/[^/]+(?:\/(?:join|leave|signals))?$/.test(path) || path === "/api/swapbot/ask" || path === "/api/swapbot/history" ||
    path === "/api/inbox/reports" || /^\/api\/inbox\/users\/[^/]+\/block$/.test(path) || path === "/api/account/export" || path === "/api/account/session-history.csv" || path.startsWith("/api/admin/");
}

async function localApi(request, env, path) {
  if (request.method === "GET" && path === "/api/auth/google/status") return googleAuthStatus(request, env);
  if (request.method === "GET" && path === "/api/auth/google/start") return googleAuthStart(request, env);
  if (request.method === "GET" && path === "/api/auth/google/callback") return googleAuthCallback(request, env);
  if (request.method === "GET" && path === "/api/auth/csrf") return authCsrf(request);
  if (request.method === "GET" && path === "/api/auth/me") return authMe(request, env);
  if (request.method === "GET" && path === "/api/auth/username-availability") return authUsernameAvailability(request, env);
  if (request.method === "GET" && path === "/api/storage/status") return storageStatus(request, env);
  if (path === "/api/auth/bootstrap-admin") return apiResponse({error: "Not found."}, 404);
  if (path === "/api/profile/photo") return apiResponse({error: "Custom profile picture uploads are no longer supported."}, 404);
  if (!isLocalApi(path)) return null;
  if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method) && !csrfIsValid(request)) {
    return apiResponse({error: "Your secure session has expired. Refresh the page and try again."}, 403);
  }
  if (request.method === "POST" && path === "/api/presence/heartbeat") return presenceHeartbeat(request, env);
  if (["POST", "PATCH", "PUT"].includes(request.method) && !path.startsWith("/api/admin/") && !MODERATION_REPLAY_CONTEXTS.has(request) &&
      !["/api/auth/register", "/api/auth/login", "/api/auth/admin-gate", "/api/auth/logout", "/api/profile/password"].includes(path)) {
    const actor = await sessionUser(request, env);
    const held = await holdSubmissionForReview(request, env, path, actor);
    if (held) return held;
  }
  // Moderator approval is the explicit authorization required for this replay.
  const profileGatedWrite = !MODERATION_REPLAY_CONTEXTS.has(request) && ["POST", "PATCH", "PUT"].includes(request.method) && (
    path === "/api/matches" || path === "/api/swaps" || path === "/api/workshops" ||
    /^\/api\/workshops\/[^/]+\/register$/.test(path) || path === "/api/calendar/events" ||
    path === "/api/livestreams" || /^\/api\/livestreams\/[^/]+\/(?:start|join|chat|signals)$/.test(path) ||
    path === "/api/ideas" || path === "/api/journal" || /^\/api\/journal\/[^/]+$/.test(path) ||
    path === "/api/portfolio" || /^\/api\/portfolio\/items(?:\/[^/]+)?$/.test(path) ||
    path === "/api/gifts/vouchers" || path === "/api/gifts/vouchers/redeem" || path === "/api/swapjobs" ||
    path === "/api/organizations/register" || path === "/api/organizations/members" ||
    path === "/api/organizations/policy" || path === "/api/community/posts" || path === "/api/community/stories" ||
    /^\/api\/community\/posts\/[^/]+\/(?:like|share|comments)$/.test(path) ||
    /^\/api\/community\/groups\/[^/]+\/join$/.test(path) || path === "/api/livestreams"
  );
  if (profileGatedWrite) {
    const viewer = await sessionUser(request, env);
    const returnTo = path === "/api/matches" || path === "/api/swaps" ? "skill-matching.html?intent=swap" :
      path.includes("inbox") ? "notifications.html" : path.includes("workshop") ? "workshops.html" :
        path.includes("calendar") ? "calendar.html" : path.includes("portfolio") ? "portfolio.html" : "dashboard.html";
    const completionGate = profileCompletionGate(viewer, returnTo);
    if (completionGate) return completionGate;
  }
  if (path === "/api/auth/username-availability" && request.method === "GET") return authUsernameAvailability(request, env);
  if (path === "/api/auth/register" && request.method === "POST") return authRegister(request, env);
  if (path === "/api/auth/login" && request.method === "POST") return authLogin(request, env);
  if (path === "/api/auth/admin-gate" && request.method === "POST") return adminGate(request, env);
  if (path === "/api/auth/logout" && request.method === "POST") return authLogout(request, env);
  if (path === "/api/organizations/register" && request.method === "POST") return organizationRegister(request, env);
  if (path === "/api/organizations/overview" && request.method === "GET") return organizationOverview(request, env);
  if (path === "/api/organizations/members" && request.method === "POST") return organizationCreateMember(request, env);
  if (path === "/api/organizations/policy" && request.method === "PATCH") return organizationUpdatePolicy(request, env);
  const organizationPasswordMatch = /^\/api\/organizations\/members\/([^/]+)\/password$/.exec(path);
  if (organizationPasswordMatch && request.method === "POST") return organizationResetMemberPassword(request, env, decodeURIComponent(organizationPasswordMatch[1]));
  if (path === "/api/profile" && request.method === "PATCH") return profileUpdate(request, env);
  if (path === "/api/profile/password" && request.method === "POST") return profilePassword(request, env);
  if (path === "/api/profile/connections" && request.method === "GET") return profileConnections(request, env);
  if (path === "/api/account" && request.method === "DELETE") return deleteAccount(request, env);
  if (path === "/api/account/privacy" && ["GET", "PATCH"].includes(request.method)) return privacy(request, env);
  if (path === "/api/account/privacy/cleanup" && request.method === "POST") return privacyCleanup(request, env);
  if (path === "/api/notifications" && request.method === "GET") return notifications(request, env);
  if (path === "/api/notifications/read-all" && request.method === "POST") return markAllNotificationsRead(request, env);
  const notificationMatch = /^\/api\/notifications\/([^/]+)(?:\/read)?$/.exec(path);
  if (notificationMatch && ["PATCH", "POST"].includes(request.method)) return markNotificationRead(request, env, decodeURIComponent(notificationMatch[1]));
  const followRequestMatch = /^\/api\/notifications\/follow-requests\/([^/]+)(\/accept)?$/.exec(path);
  if (followRequestMatch && ["POST", "DELETE"].includes(request.method)) return respondToFollowRequest(request, env, decodeURIComponent(followRequestMatch[1]), Boolean(followRequestMatch[2]));
  if (path === "/api/public/content" && request.method === "GET") return publicContent(request, env);
  if (path === "/api/testimonials" && request.method === "GET") return publicTestimonials(request, env);
  if (path === "/api/leaderboard" && request.method === "GET") return publicLeaderboard(request, env);
  if (path === "/api/dashboard" && request.method === "GET") return dashboard(request, env);
  if (path === "/api/streak" && request.method === "GET") return streakApi(request, env);
  if (path === "/api/members" && request.method === "GET") return members(request, env);
  if (path === "/api/community" && request.method === "GET") return community(request, env);
  if (path === "/api/community/feed" && request.method === "GET") return communityFeed(request, env);
  if (path === "/api/community/groups" && request.method === "GET") return communityGroups(request, env);
  const communityGroupJoinMatch = /^\/api\/community\/groups\/([^/]+)\/join$/.exec(path);
  if (communityGroupJoinMatch && ["POST", "DELETE"].includes(request.method)) return communityGroupJoin(request, env, decodeURIComponent(communityGroupJoinMatch[1]));
  const communityGroupRequestMatch = /^\/api\/community\/groups\/([^/]+)\/join-requests\/([^/]+)$/.exec(path);
  if (communityGroupRequestMatch && request.method === "POST") return communityGroupJoinRequest(request, env, decodeURIComponent(communityGroupRequestMatch[1]), decodeURIComponent(communityGroupRequestMatch[2]));
  if (path === "/api/community/posts" && request.method === "POST") return createCommunityPost(request, env);
  if (path === "/api/community/stories" && request.method === "POST") return createCommunityStory(request, env);
  const communityPostMatch = /^\/api\/community\/posts\/([^/]+)(?:\/(like|share|comments))?$/.exec(path);
  if (communityPostMatch) {
    const postId = decodeURIComponent(communityPostMatch[1]);
    const action = communityPostMatch[2] || "post";
    if (action === "post" && request.method === "DELETE") return deleteCommunityPost(request, env, postId);
    if (action === "like" && ["POST", "DELETE"].includes(request.method)) return communityPostLike(request, env, postId);
    if (action === "share" && request.method === "POST") return communityPostShare(request, env, postId);
    if (action === "comments" && ["GET", "POST"].includes(request.method)) return communityPostComments(request, env, postId);
  }
  const communityStoryMatch = /^\/api\/community\/stories\/([^/]+)$/.exec(path);
  if (communityStoryMatch && request.method === "DELETE") return deleteCommunityStory(request, env, decodeURIComponent(communityStoryMatch[1]));
  if (path === "/api/gifts/vouchers" && request.method === "GET") return giftVouchers(request, env);
  if (path === "/api/gifts/vouchers" && request.method === "POST") return createGiftVoucher(request, env);
  if (path === "/api/gifts/vouchers/redeem" && request.method === "POST") return redeemGiftVoucher(request, env);
  if (path === "/api/platform/metrics" && request.method === "GET") {
    const db = dbFor(env);
    await ensureFeatureSchema(db);
    // Synthetic demo fixtures are intentionally visible in the directory and
    // content pages, but must not inflate the platform's real activity metrics.
    const rows = (await allUserRows(db)).filter(row => row.role === "member" && row.status === "active" && !isSyntheticDemoId(row.id));
    const skillNames = [...new Set(rows.flatMap(row => {
      const profile = rowParts(row).profile;
      return [...csvValues(profile.skills_to_teach), ...csvValues(profile.additional_languages), ...csvValues(profile.skills_to_learn), ...csvValues(profile.languages_to_learn)];
    }))].sort((first, second) => first.localeCompare(second));
    // This is an aggregate only: profile visibility controls what is shown on
    // member cards, but it must not make a country disappear from the site's
    // total. No profile names or individual locations leave this endpoint.
    const countries = new Set(rows.map(row => safeText(rowParts(row).profile.country, 120)).filter(Boolean));
    const [groupCount, privateGroupCount, upcomingWorkshopCount, eventRecords, directCallRecords, videoRoomRecords, studySessionResult] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS count FROM sl_community_groups WHERE id NOT LIKE 'demo-26-%'").first(),
      db.prepare("SELECT COUNT(*) AS count FROM sl_conversations c WHERE c.kind = 'group' AND NOT EXISTS (SELECT 1 FROM sl_community_groups g WHERE g.conversation_id = c.id)").first(),
      db.prepare("SELECT COUNT(*) AS count FROM sl_workshops WHERE status = 'scheduled' AND starts_at >= ? AND id NOT LIKE 'demo-26-%'").bind(new Date().toISOString()).first(),
      appRecords(db, "events", null),
      appRecords(db, "direct_calls", null),
      appRecords(db, "video_rooms", null),
      db.prepare("SELECT id, video_room_id, starts_at, ends_at, status FROM sl_study_sessions").all()
    ]);
    const events = eventRecords.filter(item => !isSyntheticDemoId(item.id));
    const directCalls = directCallRecords.filter(item => !isSyntheticDemoId(item.id));
    const videoRooms = videoRoomRecords.filter(item => !isSyntheticDemoId(item.id));
    const studySessions = studySessionResult.results || [];
    const ideas = (await appRecords(db, "ideas", null)).filter(item => !isSyntheticDemoId(item.id) && ["published", "public", "approved", ""].includes(String(item.status || "published")));
    const feedback = (await appRecords(db, "feedback", null)).filter(item => !isSyntheticDemoId(item.id) && Boolean(item.permission_to_publish || item.publication_permission) && !["private", "archived"].includes(String(item.status || "published")));
    const completedEvents = events.filter(item => item.status === "completed");
    const interactionStatus = item => String(item?.status || "").trim().toLowerCase();
    const elapsedInteraction = item => {
      const value = item?.ended_at || item?.ends_at || item?.completed_at || "";
      const time = new Date(value).getTime();
      return Number.isFinite(time) && time <= Date.now();
    };
    const excludedInteractionStatuses = new Set(["cancelled", "canceled", "declined", "missed", "rejected", "draft", "deleted"]);
    const eventOccurred = item => {
      const status = interactionStatus(item);
      return !excludedInteractionStatuses.has(status) && (["active", "completed", "ended", "closed", "in_progress", "started"].includes(status) || elapsedInteraction(item));
    };
    const callOccurred = item => ["accepted", "ended"].includes(interactionStatus(item));
    const attendanceOccurred = item => jsonArray(item?.attendance, []).some(record => Boolean(record?.joined_at || record?.left_at || Number(record?.duration_seconds || 0) > 0));
    const roomOccurred = item => {
      const status = interactionStatus(item);
      return attendanceOccurred(item) || ["completed", "ended"].includes(status) || (status === "closed" && !item?.event_id && !item?.call_id);
    };
    const occurredRooms = videoRooms.filter(roomOccurred);
    const occurredRoomIds = new Set(occurredRooms.map(item => String(item.id || "")).filter(Boolean));
    const occurredEventIds = new Set(occurredRooms.map(item => String(item.event_id || "")).filter(Boolean));
    const occurredCallIds = new Set(occurredRooms.map(item => String(item.call_id || "")).filter(Boolean));
    const countedEvents = events.filter(item => eventOccurred(item) || occurredEventIds.has(String(item.id || "")));
    const countedEventIds = new Set(countedEvents.map(item => String(item.id || "")).filter(Boolean));
    const countedCalls = directCalls.filter(item => callOccurred(item) || occurredCallIds.has(String(item.id || "")));
    const countedCallIds = new Set(countedCalls.map(item => String(item.id || "")).filter(Boolean));
    const countedStudySessions = studySessions.filter(item => {
      const status = interactionStatus(item);
      return !excludedInteractionStatuses.has(status) && (["active", "completed", "ended"].includes(status) || elapsedInteraction(item) || occurredRoomIds.has(String(item.video_room_id || "")));
    });
    const countedStudyRoomIds = new Set(countedStudySessions.map(item => String(item.video_room_id || "")).filter(Boolean));
    // Rooms linked to a calendar event, direct call, or Study Together record
    // are already represented above. Count only genuinely standalone rooms
    // here, which prevents the same meeting from appearing twice.
    const standaloneRooms = occurredRooms.filter(room => {
      const eventId = String(room.event_id || "");
      const callId = String(room.call_id || "");
      const roomId = String(room.id || "");
      return (!eventId || !countedEventIds.has(eventId)) && (!callId || !countedCallIds.has(callId)) && !countedStudyRoomIds.has(roomId);
    });
    const allInteractions = countedEvents.length + countedCalls.length + countedStudySessions.length + standaloneRooms.length;
    const exchangedMinutes = completedEvents.reduce((total, item) => {
      const starts = new Date(item.starts_at || 0).getTime();
      const ends = new Date(item.ends_at || 0).getTime();
      return total + (Number.isFinite(starts) && Number.isFinite(ends) && ends > starts ? (ends - starts) / 60000 : 0);
    }, 0);
    const feedbackRatings = feedback.map(item => Number(item.rating || 0)).filter(value => value > 0);
    const metrics = {
      active_members: rows.length,
      members: rows.length,
      public_members: rows.length,
      skills: skillNames.length,
      listed_skills: skillNames.length,
      public_skills: skillNames.length,
      countries: countries.size,
      sessions: events.length,
      all_interactions: allInteractions,
      completed_sessions: completedEvents.length,
      exchanges: completedEvents.length,
      swaps: completedEvents.length,
      hours_exchanged: Math.round(exchangedMinutes / 60 * 10) / 10,
      ideas: ideas.length,
      public_ideas: ideas.length,
      feedback_rating: feedbackRatings.length ? Math.round(feedbackRatings.reduce((total, value) => total + value, 0) / feedbackRatings.length * 10) / 10 : null,
      public_testimonials: feedback.length,
      public_feedback_entries: feedback.length,
      public_groups: Number(groupCount?.count || 0),
      private_group_chats: Number(privateGroupCount?.count || 0),
      upcoming_workshops: Number(upcomingWorkshopCount?.count || 0),
      updated_at: new Date().toISOString()
    };
    return publicApiResponse(request, {ok: true, metrics, skill_names: skillNames});
  }
  if (path === "/api/matches" && request.method === "POST") return memberMatches(request, env);
  if (path === "/api/workshops" && request.method === "GET") return workshops(request, env);
  if (path === "/api/workshops" && request.method === "POST") return createWorkshop(request, env);
  const workshopShareMatch = /^\/api\/workshops\/share\/([^/]+)$/.exec(path);
  if (workshopShareMatch && request.method === "GET") return sharedWorkshop(request, env, decodeURIComponent(workshopShareMatch[1]));
  if (path === "/api/courses" && request.method === "GET") return courses(request, env);
  if (path === "/api/courses" && request.method === "POST") return createCourse(request, env);
  if (path === "/api/swaps" && request.method === "POST") return createSwapRequest(request, env);
  if (path === "/api/livestreams" && request.method === "GET") return livestreams(request, env);
  if (path === "/api/livestreams" && request.method === "POST") return createLivestream(request, env);
  const livestreamMatch = /^\/api\/livestreams\/([^/]+)(?:\/(start|end|join|leave|heartbeat|chat|signals))?$/.exec(path);
  if (livestreamMatch) {
    const streamId = decodeURIComponent(livestreamMatch[1]);
    const action = livestreamMatch[2] || "detail";
    if (action === "detail" && request.method === "GET") return livestreamDetail(request, env, streamId);
    if (action === "detail" && request.method === "PATCH") return updateLivestream(request, env, streamId);
    if (action === "start" && request.method === "POST") return startLivestream(request, env, streamId);
    if (action === "end" && request.method === "POST") return endLivestream(request, env, streamId);
    if (action === "join" && request.method === "POST") return joinLivestream(request, env, streamId);
    if (action === "leave" && request.method === "POST") return leaveLivestream(request, env, streamId);
    if (action === "heartbeat" && request.method === "POST") return heartbeatLivestream(request, env, streamId);
    if (action === "chat" && request.method === "POST") return livestreamChat(request, env, streamId);
    if (action === "signals" && ["GET", "POST"].includes(request.method)) return livestreamSignals(request, env, streamId);
  }
  const workshopMatch = /^\/api\/workshops\/([^/]+)\/register$/.exec(path);
  if (workshopMatch && ["POST", "DELETE"].includes(request.method)) return registerForWorkshop(request, env, decodeURIComponent(workshopMatch[1]));
  const courseMatch = /^\/api\/courses\/([^/]+)$/.exec(path);
  if (courseMatch && request.method === "PATCH") return updateCourse(request, env, decodeURIComponent(courseMatch[1]));
  if (courseMatch && request.method === "DELETE") return deleteCourse(request, env, decodeURIComponent(courseMatch[1]));
  if (path.startsWith("/api/admin/moderation/")) return adminModerationApi(request, env, path);
  if (path === "/api/admin/presence/today" && request.method === "GET") return adminPresenceToday(request, env);
  if (path === "/api/admin/presence" && request.method === "GET") return adminPresence(request, env);
  if (path === "/api/admin/overview" && request.method === "GET") return adminOverview(request, env);
  if (path === "/api/admin/operations" && request.method === "GET") return adminOperations(request, env);
  if (path === "/api/admin/content" && request.method === "GET") return adminContent(request, env);
  if (path === "/api/admin/newsletter" && request.method === "GET") return adminNewsletter(request, env);
  if (path === "/api/admin/messages" && request.method === "POST") return adminMessages(request, env);
  if (path === "/api/admin/notifications" && request.method === "POST") return adminNotificationBroadcast(request, env);
  const adminModerationMatch = /^\/api\/admin\/messages\/([^/]+)\/moderate$/.exec(path);
  if (adminModerationMatch && request.method === "PATCH") return adminModerateMessage(request, env, decodeURIComponent(adminModerationMatch[1]));
  const adminReportMatch = /^\/api\/admin\/message-reports\/([^/]+)$/.exec(path);
  if (adminReportMatch && request.method === "PATCH") return adminMessageReportUpdate(request, env, decodeURIComponent(adminReportMatch[1]));
  const adminDisputeMatch = /^\/api\/admin\/credit-disputes\/([^/]+)$/.exec(path);
  if (adminDisputeMatch && request.method === "PATCH") return adminCreditDisputeUpdate(request, env, decodeURIComponent(adminDisputeMatch[1]));
  const adminIdeaMatch = /^\/api\/admin\/ideas\/([^/]+)$/.exec(path);
  if (adminIdeaMatch && ["PATCH", "DELETE"].includes(request.method)) return adminIdeaMutation(request, env, decodeURIComponent(adminIdeaMatch[1]));
  const adminReviewMatch = /^\/api\/admin\/session-reviews(?:\/([^/]+))?$/.exec(path);
  if (adminReviewMatch && request.method === "GET") {
    const access = await requireAdmin(request, env);
    if (access.response) return access.response;
    const db = dbFor(env);
    const reviews = await appRecords(db, "session_point_reviews", null);
    if (!adminReviewMatch[1]) {
      const items = [];
      for (const review of reviews) items.push(await adminSessionReviewView(db, review, access.row));
      return apiResponse({reviews: items});
    }
    const review = reviews.find(item => item.id === decodeURIComponent(adminReviewMatch[1]));
    if (!review) return apiResponse({error: "That session point review could not be found."}, 404);
    return apiResponse({review: await adminSessionReviewView(db, review, access.row)});
  }
  if (adminReviewMatch && adminReviewMatch[1] && request.method === "PATCH") return adminSessionReviewMutation(request, env, decodeURIComponent(adminReviewMatch[1]));
  const adminContentMatch = /^\/api\/admin\/content\/(contacts|complaints|feedback|workshops|registrations|blogs|reports)\/([^/]+)$/.exec(path);
  if (adminContentMatch && ["PATCH", "DELETE"].includes(request.method)) return adminContentMutation(request, env, adminContentMatch[1], decodeURIComponent(adminContentMatch[2]));
  const adminNewsletterMatch = /^\/api\/admin\/newsletter\/([^/]+)$/.exec(path);
  if (adminNewsletterMatch && request.method === "DELETE") return adminNewsletterMutation(request, env, decodeURIComponent(adminNewsletterMatch[1]));
  if (path === "/api/admin/users" && request.method === "POST") return adminCreateUser(request, env);
  if (path === "/api/admin/users/bulk" && request.method === "POST") return adminBulk(request, env);
  const adminPasswordPrefix = "/api/admin/users/";
  if (request.method === "POST" && path.startsWith(adminPasswordPrefix) && path.endsWith("/password")) {
    const userId = path.slice(adminPasswordPrefix.length, -"/password".length);
    if (userId && !userId.includes("/")) return adminResetUserPassword(request, env, decodeURIComponent(userId));
  }
  const guardianMatch = /^\/api\/admin\/users\/([^/]+)\/guardian-consent$/.exec(path);
  if (guardianMatch && request.method === "PATCH") return guardianConsent(request, env, decodeURIComponent(guardianMatch[1]));
  const userMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(path);
  if (userMatch) {
    const userId = decodeURIComponent(userMatch[1]);
    if (request.method === "PATCH") return adminUpdateUser(request, env, userId);
    if (request.method === "DELETE") return adminDeleteUser(request, env, userId);
  }
  const followMatch = /^\/api\/community\/users\/([^/]+)\/follow$/.exec(path);
  if (followMatch && ["POST", "DELETE"].includes(request.method)) return changeFollow(request, env, decodeURIComponent(followMatch[1]));
  const followerMatch = /^\/api\/community\/followers\/([^/]+)$/.exec(path);
  if (followerMatch && request.method === "DELETE") return removeFollower(request, env, decodeURIComponent(followerMatch[1]));
  const portfolioMatch = /^\/api\/community\/users\/([^/]+)\/portfolio$/.exec(path);
  if (portfolioMatch && request.method === "GET") return portfolio(request, env, decodeURIComponent(portfolioMatch[1]));
  if (path === "/api/inbox/contacts" && request.method === "GET") return inboxContacts(request, env);
  if (path === "/api/inbox" && request.method === "GET") return inbox(request, env);
  if (path === "/api/inbox/conversations" && request.method === "POST") return createConversation(request, env);
  if (path === "/api/inbox/groups" && request.method === "POST") return createInboxGroup(request, env);
  const inboxGroupMatch = /^\/api\/inbox\/groups\/([^/]+)(?:\/members\/me)?$/.exec(path);
  if (inboxGroupMatch) {
    const conversationId = decodeURIComponent(inboxGroupMatch[1]);
    if (path.endsWith("/members/me") && request.method === "DELETE") return leaveInboxGroup(request, env, conversationId);
    if (!path.endsWith("/members/me") && request.method === "PATCH") return updateInboxGroup(request, env, conversationId);
  }
  const pinMessageMatch = /^\/api\/inbox\/conversations\/([^/]+)\/messages\/([^/]+)\/pin$/.exec(path);
  if (pinMessageMatch && request.method === "PATCH") return pinConversationMessage(request, env, decodeURIComponent(pinMessageMatch[1]), decodeURIComponent(pinMessageMatch[2]));
  const blockUserMatch = /^\/api\/inbox\/users\/([^/]+)\/block$/.exec(path);
  if (blockUserMatch && ["POST", "DELETE"].includes(request.method)) return blockConversationUser(request, env, decodeURIComponent(blockUserMatch[1]));
  const conversationMatch = /^\/api\/inbox\/conversations\/([^/]+)(?:\/(read|messages|typing|content|mute|history))?$/.exec(path);
  if (conversationMatch) {
    const conversationId = decodeURIComponent(conversationMatch[1]);
    const action = conversationMatch[2] || "detail";
    if (action === "detail" && request.method === "DELETE") return deleteConversation(request, env, conversationId);
    if (action === "detail" && request.method === "GET") return conversationDetail(request, env, conversationId);
    if (action === "read" && request.method === "POST") return markConversationRead(request, env, conversationId);
    if (action === "messages" && request.method === "POST") return sendConversationMessage(request, env, conversationId);
    if (action === "typing" && request.method === "POST") return apiResponse({ok: true, typing_users: []});
    if (action === "content" && request.method === "GET") return conversationContent(request, env, conversationId);
    if (action === "mute" && request.method === "POST") return muteConversation(request, env, conversationId);
    if (action === "history" && request.method === "DELETE") return clearConversationHistory(request, env, conversationId);
  }
  const feature = await featureApi(request, env, path);
  if (feature) return feature;
  return apiResponse({error: "Method not allowed."}, 405);
}

function rewrittenLocation(value, requestUrl) {
  if (!value || !UPSTREAM_ORIGIN) return value;
  try {
    const upstream = new URL(value, UPSTREAM_ORIGIN);
    const current = new URL(requestUrl);
    if (upstream.origin === UPSTREAM_ORIGIN) return current.origin + upstream.pathname + upstream.search + upstream.hash;
  } catch (_error) {
    // Preserve malformed or relative Location headers as-is.
  }
  return value;
}

function isPublicApi(path) {
  return PUBLIC_API_CACHE.has(path) || path.startsWith("/api/testimonials?");
}

function hasPrivateSession(request) {
  return /(?:^|;\s*)sl_session=/.test(request.headers.get("cookie") || "");
}

function cachePolicy(path, request) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (["/forgot-password.html", "/reset-password.html", "/login.html"].includes(path)) return "private, no-store";
  if (isPublicApi(path)) return "public, max-age=30, stale-while-revalidate=120";
  if (hasPrivateSession(request)) return null;
  if (path.endsWith(".html")) return "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
  if (path.startsWith("/styles/") || path.startsWith("/scripts/") || path.endsWith(".css") || path.endsWith(".js") || path.endsWith(".jpg") || path.endsWith(".png") || path.endsWith(".svg")) return "public, max-age=86400, stale-while-revalidate=604800";
  return null;
}

function cachedResponse(entry) {
  const headers = new Headers(entry.headers);
  headers.set("cache-control", "public, max-age=30, stale-while-revalidate=120");
  headers.set("x-swappublic-proxy", "swaplabs");
  headers.set("x-swappublic-cache", entry.stale ? "edge-memory-stale" : "edge-memory");
  return new Response(entry.body, {status: entry.status, statusText: entry.statusText, headers});
}

function localCachedResponse(entry) {
  const headers = new Headers(entry.headers);
  headers.set("cache-control", "public, max-age=10, stale-while-revalidate=30");
  headers.set("x-swappublic-cache", entry.cacheSource || (entry.stale ? "d1-memory-stale" : "d1-memory"));
  return new Response(entry.body, {status: entry.status, statusText: entry.statusText, headers});
}

async function refreshLocalApiCache(request, env, path, key) {
  if (LOCAL_IN_FLIGHT.has(key)) return LOCAL_IN_FLIGHT.get(key);
  const task = (async () => {
    const response = await localApi(request, env, path);
    if (!response || !response.ok) return {response};
    const body = await response.text();
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("set-cookie");
    headers.delete("vary");
    const entry = {
      body,
      status: response.status,
      statusText: response.statusText,
      headers,
      expiresAt: Date.now() + LOCAL_CACHE_TTL_MS,
      staleUntil: Date.now() + LOCAL_CACHE_TTL_MS + LOCAL_CACHE_STALE_MS
    };
    LOCAL_MEMORY_CACHE.set(key, entry);
    return {entry};
  })().finally(() => LOCAL_IN_FLIGHT.delete(key));
  LOCAL_IN_FLIGHT.set(key, task);
  return task;
}

async function localApiWithPublicCache(request, env, ctx, path) {
  const cacheable = request.method === "GET" && !hasPrivateSession(request) && LOCAL_PUBLIC_API_CACHE.has(path);
  if (!cacheable) return localApi(request, env, path);
  const incoming = new URL(request.url);
  const key = path + incoming.search;
  const cached = LOCAL_MEMORY_CACHE.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return localCachedResponse({...cached, stale: false});
  if (cached && cached.staleUntil > now) {
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(refreshLocalApiCache(request, env, path, key).then(result => {
        if (result && result.entry) publishEdgeCache(ctx, request, path, result.entry);
      }).catch(() => null));
    }
    return localCachedResponse({...cached, stale: true});
  }
  const edgeCached = await readEdgeCache(request, path);
  if (edgeCached) {
    LOCAL_MEMORY_CACHE.set(key, edgeCached);
    return localCachedResponse({...edgeCached, stale: false});
  }
  const fresh = await refreshLocalApiCache(request, env, path, key);
  if (fresh && fresh.entry) {
    publishEdgeCache(ctx, request, path, fresh.entry);
    return localCachedResponse({...fresh.entry, stale: false});
  }
  return fresh && fresh.response ? fresh.response : localApi(request, env, path);
}

async function studySocketUpgrade(request, env, roomId) {
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Study room WebSocket upgrade required.", {status: 426, headers: {"content-type": "text/plain; charset=utf-8"}});
  }
  if (!env?.STUDY_ROOM_HUB || !env?.DB) return apiResponse({error: "Live room sync is not configured yet."}, 503);
  const viewerRow = await sessionUser(request, env);
  if (!viewerRow) return apiResponse({error: "Please log in to join this study room."}, 401);
  const membership = await env.DB.prepare("SELECT role, status FROM sl_study_room_members WHERE room_id = ? AND user_id = ? LIMIT 1").bind(roomId, viewerRow.id).first();
  if (!membership || membership.status !== "active") return apiResponse({error: "Join this study room before opening live sync."}, 403);
  const parts = rowParts(viewerRow);
  const headers = new Headers(request.headers);
  headers.set("x-study-room-id", roomId);
  headers.set("x-study-user-id", viewerRow.id);
  headers.set("x-study-display-name", parts.profile.first_name || parts.profile.display_name || viewerRow.username || "Member");
  headers.set("x-study-role", membership.role || "participant");
  const forwarded = new Request(request, {headers});
  return env.STUDY_ROOM_HUB.getByName(`study-room:${roomId}`).fetch(forwarded);
}

export class StudyTogetherRoomHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS study_room_state (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS study_room_messages (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)");
      ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_study_room_messages_created ON study_room_messages(created_at)");
      const existing = ctx.storage.sql.exec("SELECT id FROM study_room_state WHERE id = 1").toArray();
      if (!existing.length) ctx.storage.sql.exec("INSERT INTO study_room_state (id, state_json) VALUES (1, ?)", JSON.stringify({phase: "idle", ends_at: null, round: 0, presence: {}, whiteboard: []}));
    });
  }

  readState() {
    const row = this.ctx.storage.sql.exec("SELECT state_json FROM study_room_state WHERE id = 1").one();
    try { return JSON.parse(row.state_json); } catch (_error) { return {phase: "idle", ends_at: null, round: 0, presence: {}, whiteboard: []}; }
  }

  writeState(state) {
    this.ctx.storage.sql.exec("UPDATE study_room_state SET state_json = ? WHERE id = 1", JSON.stringify(state));
  }

  broadcast(payload, except = null) {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try { socket.send(message); } catch (_error) { /* close/error will clean up the socket */ }
    }
  }

  async publishModeratedChat(row) {
    const existing = this.ctx.storage.sql.exec("SELECT id FROM study_room_messages WHERE id = ? LIMIT 1", row.id).toArray();
    if (existing.length) return;
    this.ctx.storage.sql.exec("INSERT INTO study_room_messages (id, user_id, display_name, body, created_at) VALUES (?, ?, ?, ?, ?)", row.id, row.user_id, row.display_name, row.body, row.created_at);
    this.ctx.storage.sql.exec("DELETE FROM study_room_messages WHERE id NOT IN (SELECT id FROM study_room_messages ORDER BY created_at DESC LIMIT 100)");
    this.broadcast({type: "chat", message: row});
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__moderation/approve-chat") {
      const payload = await request.json().catch(() => null);
      if (!isObject(payload) || !/^moderation_[A-Za-z0-9_-]{10,100}$/.test(String(payload.id || "")) || !safeText(payload.user_id, 100) || !safeText(payload.body, 1200)) {
        return apiResponse({error: "The approved room message is invalid."}, 400);
      }
      const createdAt = Date.parse(payload.created_at);
      const row = {id: safeText(payload.id, 120), user_id: safeText(payload.user_id, 100), display_name: safeText(payload.display_name, 120) || "Member", body: safeText(payload.body, 1200), created_at: Number.isFinite(createdAt) ? createdAt : Date.now()};
      await this.publishModeratedChat(row);
      return apiResponse({ok: true});
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required.", {status: 426});
    const userId = safeText(request.headers.get("x-study-user-id"), 100);
    const displayName = safeText(request.headers.get("x-study-display-name"), 120) || "Member";
    const role = safeText(request.headers.get("x-study-role"), 30) || "participant";
    const roomId = safeText(request.headers.get("x-study-room-id"), 120);
    if (!userId) return new Response("Unauthorized.", {status: 401});
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({userId, displayName, role, roomId, joinedAt: Date.now()});
    const state = this.readState();
    state.presence = {...(state.presence || {}), [userId]: {user_id: userId, display_name: displayName, role, status: "ready", updated_at: Date.now()}};
    this.writeState(state);
    server.send(JSON.stringify({type: "state", state, connections: this.ctx.getWebSockets().length}));
    this.broadcast({type: "presence", presence: state.presence, connections: this.ctx.getWebSockets().length}, server);
    return new Response(null, {status: 101, webSocket: client});
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 8_000) return;
    let packet;
    try { packet = JSON.parse(message); } catch (_error) { ws.send(JSON.stringify({type: "error", message: "Send valid room messages."})); return; }
    if (!packet || typeof packet !== "object" || !["chat", "presence", "timer_set", "whiteboard", "ping"].includes(packet.type)) {
      ws.send(JSON.stringify({type: "error", message: "That room action is not available."})); return;
    }
    const attachment = ws.deserializeAttachment() || {};
    const state = this.readState();
    if (packet.type === "ping") { ws.send(JSON.stringify({type: "pong", at: Date.now()})); return; }
    if (packet.type === "chat") {
      const body = safeText(packet.body, 1200); if (!body) return;
      const userId = safeText(attachment.userId, 100);
      const displayName = safeText(attachment.displayName, 120) || "Member";
      const roomId = safeText(attachment.roomId, 120);
      const db = dbFor(this.env);
      await ensureFeatureSchema(db);
      const matches = moderationMatches([{field: "message", value: body}], await moderationRules(db));
      if (matches.length) {
        if (!roomId || !userId) {
          ws.send(JSON.stringify({type: "error", message: "This message could not be safely reviewed, so it was not shared."}));
          return;
        }
        const itemId = newId("moderation");
        const submittedAt = new Date().toISOString();
        const payload = {room_id: roomId, display_name: displayName, body};
        const submitter = {user_id: userId, username: "", full_name: displayName, email: ""};
        const item = {id: itemId, user_id: userId, triggered_rule: matches[0].phrase};
        await db.batch([
          db.prepare("INSERT INTO sl_moderation_items (id, user_id, content_type, source_path, source_method, payload_json, content_json, file_context_json, submitter_json, triggered_rule_id, triggered_rule, triggered_rules_json, status, submitted_at) VALUES (?, ?, 'Study Together room message', ?, 'WEBSOCKET', ?, ?, '[]', ?, ?, ?, ?, 'pending', ?)")
            .bind(itemId, userId, `/api/study/rooms/${roomId}/chat`, JSON.stringify(payload), JSON.stringify({fields: [{field: "message", value: body}], submission: {body}, attachments: []}), JSON.stringify(submitter), matches[0].rule_id, matches[0].phrase, JSON.stringify(matches), submittedAt),
          moderationWriteAudit(db, item, "submitted", "pending", null, "blocked_word_detected", submittedAt)
        ]);
        ws.send(JSON.stringify({type: "moderation_pending", message: "Your message is pending administrator review and is hidden from the room."}));
        return;
      }
      const row = {id: crypto.randomUUID(), user_id: userId, display_name: displayName, body, created_at: Date.now()};
      this.ctx.storage.sql.exec("INSERT INTO study_room_messages (id, user_id, display_name, body, created_at) VALUES (?, ?, ?, ?, ?)", row.id, row.user_id, row.display_name, row.body, row.created_at);
      this.ctx.storage.sql.exec("DELETE FROM study_room_messages WHERE id NOT IN (SELECT id FROM study_room_messages ORDER BY created_at DESC LIMIT 100)");
      this.broadcast({type: "chat", message: row});
      return;
    }
    if (packet.type === "presence") {
      const status = ["ready", "focusing", "break", "away"].includes(String(packet.status)) ? String(packet.status) : "ready";
      state.presence = {...(state.presence || {}), [attachment.userId]: {...(state.presence?.[attachment.userId] || {}), user_id: attachment.userId, display_name: attachment.displayName, role: attachment.role, status, updated_at: Date.now()}};
      this.writeState(state);
      this.broadcast({type: "presence", presence: state.presence});
      return;
    }
    if (packet.type === "timer_set") {
      if (attachment.role !== "host") { ws.send(JSON.stringify({type: "error", message: "Only the room host can control the shared timer."})); return; }
      const phase = ["idle", "focus", "break"].includes(String(packet.phase)) ? String(packet.phase) : "idle";
      const endsAt = packet.ends_at ? new Date(packet.ends_at) : null;
      if (phase !== "idle" && (!endsAt || Number.isNaN(endsAt.getTime()) || endsAt.getTime() < Date.now() || endsAt.getTime() > Date.now() + 6 * 60 * 60_000)) { ws.send(JSON.stringify({type: "error", message: "Choose a timer end within the next six hours."})); return; }
      state.phase = phase; state.ends_at = endsAt ? endsAt.toISOString() : null; state.round = Math.max(0, Math.min(20, Number(packet.round || 0))); state.updated_at = Date.now();
      this.writeState(state);
      this.broadcast({type: "timer", phase: state.phase, ends_at: state.ends_at, round: state.round});
      return;
    }
    if (packet.type === "whiteboard") {
      const operation = isObject(packet.operation) ? packet.operation : null;
      if (!operation || JSON.stringify(operation).length > 4_000) return;
      if (operation.action === "clear") {
        if (attachment.role !== "host") { ws.send(JSON.stringify({type: "error", message: "Only the room host can clear the shared board."})); return; }
        state.whiteboard = [];
        this.writeState(state);
        this.broadcast({type: "whiteboard_reset", whiteboard: []});
        return;
      }
      if (operation.action === "undo") {
        const index = [...(state.whiteboard || [])].map((item, itemIndex) => ({item, itemIndex})).reverse().find(entry => entry.item?.action === "stroke" && entry.item.user_id === attachment.userId)?.itemIndex;
        if (index !== undefined) state.whiteboard.splice(index, 1);
        this.writeState(state);
        this.broadcast({type: "whiteboard_reset", whiteboard: state.whiteboard});
        return;
      }
      if (operation.action !== "stroke" || !Array.isArray(operation.points) || operation.points.length < 2) return;
      state.whiteboard = [...(Array.isArray(state.whiteboard) ? state.whiteboard : []), {...operation, user_id: attachment.userId, at: Date.now()}].slice(-200);
      this.writeState(state);
      this.broadcast({type: "whiteboard", operation: state.whiteboard[state.whiteboard.length - 1]});
    }
  }

  async webSocketClose(ws) {
    const attachment = ws.deserializeAttachment() || {};
    const state = this.readState();
    if (attachment.userId && state.presence) delete state.presence[attachment.userId];
    this.writeState(state);
    this.broadcast({type: "presence", presence: state.presence, connections: Math.max(0, this.ctx.getWebSockets().length - 1)});
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }
}

async function fetchUpstream(request, incoming, path) {
  if (!UPSTREAM_ORIGIN) {
    const responseHeaders = new Headers({
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-swappublic-proxy": "disabled"
    });
    return {
      response: new Response("Not Found", {status: 404, headers: responseHeaders}),
      responseHeaders,
      status: 404,
      statusText: "Not Found"
    };
  }
  const target = new URL(path + incoming.search, UPSTREAM_ORIGIN);
  const headers = new Headers(request.headers);
  headers.set("bypass-tunnel-reminder", "1");
  headers.set("x-forwarded-host", incoming.host);
  headers.delete("host");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("upstream timeout"), 8_000);
  const init = {method: request.method, headers, redirect: "manual", signal: controller.signal};
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    const responseHeaders = new Headers({"content-type": "text/plain; charset=utf-8", "cache-control": "no-store"});
    return {response: new Response("SwapLabs is temporarily unavailable: " + (error && error.message || "upstream connection failed"), {status: 502, headers: responseHeaders}), responseHeaders, status: 502, statusText: "Bad Gateway"};
  } finally {
    clearTimeout(timeout);
  }
  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers) if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders.set(key, value);
  const location = responseHeaders.get("location");
  if (location) responseHeaders.set("location", rewrittenLocation(location, request.url));
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-swappublic-proxy", "swaplabs");
  responseHeaders.delete("x-localtunnel-agent-ips");
  return {response: new Response(upstream.body, {status: upstream.status, statusText: upstream.statusText, headers: responseHeaders}), responseHeaders, status: upstream.status, statusText: upstream.statusText};
}

async function refreshPublicCache(request, incoming, path, key) {
  if (PUBLIC_IN_FLIGHT.has(key)) return PUBLIC_IN_FLIGHT.get(key);
  const task = (async () => {
    const result = await fetchUpstream(request, incoming, path);
    if (!result.response.ok) return null;
    const body = await result.response.text();
    const headers = new Headers(result.responseHeaders);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("set-cookie");
    headers.delete("vary");
    const entry = {body, status: result.status, statusText: result.statusText, headers, expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS, staleUntil: Date.now() + PUBLIC_CACHE_TTL_MS + PUBLIC_CACHE_STALE_MS};
    PUBLIC_MEMORY_CACHE.set(key, entry);
    return entry;
  })().finally(() => PUBLIC_IN_FLIGHT.delete(key));
  PUBLIC_IN_FLIGHT.set(key, task);
  return task;
}

async function proxy(request, incoming, ctx, path) {
  const policy = cachePolicy(path, request);
  const canCache = request.method === "GET" && isPublicApi(path);
  const key = path + incoming.search;
  if (canCache) {
    const cached = PUBLIC_MEMORY_CACHE.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cachedResponse({...cached, stale: false});
    if (cached && cached.staleUntil > now) {
      if (ctx && ctx.waitUntil) ctx.waitUntil(refreshPublicCache(request, incoming, path, key).catch(() => null));
      return cachedResponse({...cached, stale: true});
    }
    const fresh = await refreshPublicCache(request, incoming, path, key);
    if (fresh) return cachedResponse({...fresh, stale: false});
  }
  const result = await fetchUpstream(request, incoming, path);
  result.response.headers.set("cache-control", policy || "no-store");
  return result.response;
}

export default {
  async scheduled(controller, env) {
    try {
      const result = await grantMonthlyCredits(env.DB, controller.scheduledTime);
      console.log(JSON.stringify({event: "monthly_credit_grant", ...result}));
    } catch (error) {
      console.error(JSON.stringify({event: "monthly_credit_grant_failed", message: error instanceof Error ? error.message : "Unknown failure"}));
      throw error;
    }
  },
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url);
    if (env.LOCAL_MODE === "true" && !["localhost", "127.0.0.1", "[::1]"].includes(incoming.hostname)) {
      return apiResponse({error: "SwapLabs is available on localhost only."}, 403);
    }
    const path = incoming.pathname === "/" ? "/index.html" : incoming.pathname;
    if (path === "/api/local/status" && request.method === "GET" && env.LOCAL_MODE === "true") {
      try {
        const result = await env.DB.prepare("SELECT COUNT(*) AS count FROM sl_users").first();
        return apiResponse({ok: true, app: "swaplabs-local", mode: "local", database: "sqlite", media: "local", live_rooms: "local", accounts: result.count, version: 1});
      } catch (_error) { return apiResponse({ok: false, app: "swaplabs-local", error: "The local database has not been initialized."}, 503); }
    }
    if (path === "/api/credits/policy" && request.method === "GET") return apiResponse(creditPolicy());
    if (path.startsWith("/api/auth/recovery/")) return recoveryApi(request, env, ctx, path);
    if (path === "/lander") {
      const canonical = new URL(incoming.toString());
      canonical.pathname = "/";
      return Response.redirect(canonical.toString(), 301);
    }
    if (["GET", "HEAD"].includes(request.method) && RETIRED_ROUTE_REDIRECTS.has(path)) {
      const canonical = new URL(incoming.toString());
      canonical.pathname = RETIRED_ROUTE_REDIRECTS.get(path);
      return Response.redirect(canonical.toString(), 301);
    }
    if ((path.startsWith("/uploads/") || path.startsWith("/profile-media/")) && ["GET", "HEAD"].includes(request.method)) {
      const photo = await servePhoto(request, env, path);
      if (photo) return photo;
      const attachment = await serveMessageAttachment(request, env, path);
      if (attachment) return attachment;
    }
    if (path.startsWith("/community-media/") && ["GET", "HEAD"].includes(request.method)) {
      const media = await serveCommunityMedia(request, env, path);
      if (media) return media;
    }
    const studySocketMatch = /^\/api\/study\/rooms\/([^/]+)\/socket$/.exec(path);
    if (studySocketMatch) {
      try {
        return await studySocketUpgrade(request, env, decodeURIComponent(studySocketMatch[1]));
      } catch (_error) {
        return apiResponse({error: "The live study room is temporarily unavailable."}, 503);
      }
    }
    if (path.startsWith("/api/")) {
      try {
        const local = await localApiWithPublicCache(request, env, ctx, path);
        if (local) return local;
      } catch (error) {
        const status = Number(error && error.status);
        if (status >= 400 && status < 500) return apiResponse({error: error.message || "Request could not be completed."}, status);
        return apiResponse({error: "SwapLabs account service is temporarily unavailable. Please try again shortly."}, 503);
      }
    }
    const local = await staticAsset(request, env, path);
    if (local) return local;
    if (["GET", "HEAD"].includes(request.method)) return notFoundPage(request, env);
    return proxy(request, incoming, ctx, path);
  }
};
