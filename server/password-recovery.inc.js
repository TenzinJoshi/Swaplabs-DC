// Included in the canonical Worker by build-worker.mjs. Disabled until the
// sender has been onboarded and RECOVERY_EMAIL_ENABLED is explicitly true.
const RECOVERY_UNAVAILABLE = "Email verification is not available yet. Your password has not been changed. Please try later or contact support.";
const RECOVERY_SECONDS = 600;
function recoveryReady(env) {
  return env?.LOCAL_MODE === "true" || (env?.RECOVERY_EMAIL_ENABLED === "true" && typeof env?.RECOVERY_EMAIL?.send === "function");
}
async function ensureRecoverySchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS sl_password_recovery (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', code_hash TEXT NOT NULL,
      password_snapshot TEXT NOT NULL DEFAULT '', contact_email TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending', temporary_hash TEXT, reset_hash TEXT, consume_nonce TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS sl_recovery_temporary ON sl_password_recovery(temporary_hash)"),
    db.prepare("CREATE INDEX IF NOT EXISTS sl_recovery_reset ON sl_password_recovery(reset_hash)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sl_recovery_limits (bucket_hash TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TEXT NOT NULL)")
  ]);
}
async function readRecoveryJson(request) {
  if (!(request.headers.get("content-type") || "").startsWith("application/json")) throw Object.assign(new Error("Send the form as JSON."), {status: 400});
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error("Complete the recovery form."), {status: 400});
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw Object.assign(new Error("The recovery form is too large."), {status: 413}); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!isObject(body)) throw new Error();
    return body;
  } catch (_error) { throw Object.assign(new Error("Complete the recovery form."), {status: 400}); }
}
function recoveryName(value) { return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(); }
function recoveryDetailsMatch(row, body) {
  if (!row || row.status !== "active" || row.role === "admin") return false;
  const profile = rowParts(row).profile; const contact = body.contact.trim();
  const matchesContact = contact.includes("@") ? contact.toLowerCase() === row.email.toLowerCase() :
    Boolean(profile.phone_number && phoneLookup(contact) === phoneLookup(profile.phone_number));
  return matchesContact && recoveryName(body.full_name) === recoveryName(completeName(profile, row.username)) &&
    Boolean(profile.date_of_birth && body.date_of_birth === profile.date_of_birth);
}
async function recoveryLimit(db, request, username = "") {
  const window = Math.floor(Date.now() / 900000);
  const expires = new Date((window + 2) * 900000).toISOString();
  const keys = [{key: "ip:" + (request.headers.get("cf-connecting-ip") || "local"), max: 10}];
  if (username) keys.push({key: "account:" + username.toLowerCase(), max: 3});
  const statements = [];
  for (const entry of keys) statements.push(db.prepare(`INSERT INTO sl_recovery_limits(bucket_hash,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(bucket_hash) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count`)
    .bind(await sha256Hex("recovery:" + window + ":" + entry.key), expires, entry.max));
  const results = await db.batch(statements);
  return results.every(result => result.results?.length === 1);
}
function recoveryCode() {
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= 4200000000);
  return String(value[0] % 100000000).padStart(8, "0");
}
async function recoverySecretEqual(left, right) {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  return crypto.subtle.timingSafeEqual(a, b);
}
async function deliverRecoveryChallenge(env, token, body) {
  const db = dbFor(env); const tokenHash = await sha256Hex(token);
  try {
    const row = await db.prepare("SELECT * FROM sl_users WHERE lower(username)=lower(?) LIMIT 1").bind(body.username).first();
    if (!recoveryDetailsMatch(row, body)) {
      await db.prepare("UPDATE sl_password_recovery SET state='awaiting' WHERE token_hash=? AND state='pending'").bind(tokenHash).run();
      return;
    }
    const code = recoveryCode();
    await db.prepare(`UPDATE sl_password_recovery SET user_id=?, code_hash=?, password_snapshot=?, contact_email=?
      WHERE token_hash=? AND state='pending'`).bind(row.id, await sha256Hex(token + ":" + code), row.password_hash, row.email, tokenHash).run();
    if (env.LOCAL_MODE === "true") {
      await db.prepare("UPDATE sl_password_recovery SET state='awaiting' WHERE token_hash=? AND state='pending'").bind(tokenHash).run();
      return code;
    }
    await env.RECOVERY_EMAIL.send({
      from: "security@relayskills.com", to: row.email, subject: "Your SwapLabs recovery code",
      text: "Your SwapLabs recovery code is " + code + ". It expires in 10 minutes. Enter it only on relayskills.com or www.relayskills.com. If you did not request recovery, ignore this message. Your password has not changed.",
      html: "<h1>Account recovery</h1><p>Your verification code:</p><p><strong>" + code + "</strong></p><p>Expires in 10 minutes. Enter it only on relayskills.com or www.relayskills.com. Never share it. If you did not request recovery, ignore this message. Your password has not changed.</p>"
    });
    await db.prepare("UPDATE sl_password_recovery SET state='awaiting' WHERE token_hash=? AND state='pending'").bind(tokenHash).run();
  } catch (_error) {
    await db.prepare("UPDATE sl_password_recovery SET state='failed' WHERE token_hash=? AND state='pending'").bind(tokenHash).run();
    console.error(JSON.stringify({event: "recovery_delivery_unavailable"}));
  }
}
async function recoveryRequest(request, env, ctx) {
  if (!recoveryReady(env) || !ctx?.waitUntil) return apiResponse({error: RECOVERY_UNAVAILABLE, code: "recovery_unavailable"}, 503);
  const body = await readRecoveryJson(request);
  if (typeof body.username !== "string" || !/^[a-z0-9._-]{3,30}$/i.test(body.username.trim()) ||
      typeof body.full_name !== "string" || body.full_name.trim().length < 2 || body.full_name.length > 160 ||
      typeof body.date_of_birth !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date_of_birth) ||
      !Number.isFinite(Date.parse(body.date_of_birth)) || body.date_of_birth > new Date().toISOString().slice(0, 10) ||
      typeof body.contact !== "string" || body.contact.length > 254 ||
      !(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.contact.trim()) || /^\+?[\d\s().-]{7,32}$/.test(body.contact.trim()))) {
    return apiResponse({error: "Complete your username, full name, date of birth, and registered email or phone."}, 400);
  }
  body.username = body.username.trim();
  const db = dbFor(env); await ensureRecoverySchema(db);
  if (!(await recoveryLimit(db, request, body.username))) return apiResponse({error: "Too many recovery attempts. Please try again in 15 minutes."}, 429);
  const token = randomToken(32); const expires = new Date(Date.now() + RECOVERY_SECONDS * 1000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM sl_password_recovery WHERE expires_at < ?").bind(new Date(Date.now() - 86400000).toISOString()),
    db.prepare("DELETE FROM sl_recovery_limits WHERE expires_at < ?").bind(new Date().toISOString()),
    db.prepare("INSERT INTO sl_password_recovery(token_hash,code_hash,expires_at) VALUES (?,?,?)").bind(await sha256Hex(token), await sha256Hex(randomToken(32)), expires)
  ]);
  if (env.LOCAL_MODE === "true") {
    const code = await deliverRecoveryChallenge(env, token, body);
    return apiResponse({ok: true, request_token: token, local_code: code || null, channel: "local",
      message: code ? `Local verification code: ${code}. Enter it below to continue. It expires in 10 minutes.` : "The supplied details could not be matched. Check your username, full name, date of birth, and registered contact, then start again."}, 202);
  }
  // Account lookup and delivery are off the response path for both matching
  // and nonmatching details. Never disclose which detail mismatched.
  ctx.waitUntil(deliverRecoveryChallenge(env, token, body).catch(() => {
    console.error(JSON.stringify({event: "recovery_delivery_unavailable"}));
  }));
  return apiResponse({ok: true, request_token: token, message: "If these details match an eligible account, a verification code will arrive at its registered email. Enter it below."}, 202);
}
async function recoveryVerify(request, env) {
  const body = await readRecoveryJson(request);
  const invalid = () => apiResponse({error: "The code is invalid, expired, or still being delivered. Check your details and email, or start again."}, 400);
  if (!/^[A-Za-z0-9_-]{43}$/.test(body.request_token || "") || !/^\d{8}$/.test(body.code || "")) return invalid();
  const db = dbFor(env); await ensureRecoverySchema(db);
  if (!(await recoveryLimit(db, request))) return apiResponse({error: "Too many attempts. Please try again in 15 minutes."}, 429);
  const tokenHash = await sha256Hex(body.request_token); const now = new Date().toISOString();
  const challenge = await db.prepare(`UPDATE sl_password_recovery SET attempts=attempts+1
    WHERE token_hash=? AND state='awaiting' AND attempts < 5 AND expires_at > ? RETURNING *`).bind(tokenHash, now).first();
  const correct = await recoverySecretEqual(await sha256Hex(body.request_token + ":" + body.code), challenge?.code_hash || "");
  if (!challenge || !correct || !challenge.user_id) return invalid();
  const row = await findUserById(db, challenge.user_id);
  if (!row || row.role === "admin" || row.status !== "active" || row.email !== challenge.contact_email || row.password_hash !== challenge.password_snapshot) return invalid();
  const temporary = "Rly-" + randomToken(24);
  const result = await db.prepare(`UPDATE sl_password_recovery SET state='temporary', code_hash='', temporary_hash=?, expires_at=?
    WHERE token_hash=? AND state='awaiting' AND expires_at > ? AND code_hash=?`).bind(await sha256Hex(temporary), new Date(Date.now() + RECOVERY_SECONDS * 1000).toISOString(), tokenHash, now, challenge.code_hash).run();
  if (result.meta?.changes !== 1) return invalid();
  return apiResponse({ok: true, temporary_password: temporary, expires_in: RECOVERY_SECONDS});
}
async function recoveryTemporaryLogin(request, env, row, password) {
  if (!row || row.role === "admin" || row.status !== "active" || !/^Rly-[A-Za-z0-9_-]{32}$/.test(password) || !recoveryReady(env)) return null;
  const db = dbFor(env); await ensureRecoverySchema(db);
  const resetToken = randomToken(32); const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE sl_password_recovery SET state='authorized', temporary_hash=NULL, reset_hash=?, expires_at=?
    WHERE temporary_hash=? AND user_id=? AND state='temporary' AND expires_at > ? AND password_snapshot=? AND contact_email=?`).bind(
    await sha256Hex(resetToken), new Date(Date.now() + RECOVERY_SECONDS * 1000).toISOString(), await sha256Hex(password), row.id, now, row.password_hash, row.email).run();
  if (result.meta?.changes !== 1) return null;
  // This cookie authorizes only changing the password, never normal account APIs.
  return apiResponse({ok: true, password_change_required: true}, 200, [
    ...expiredAuthCookieHeaders(request, "sl_session"),
    ...authCookieHeaders(request, "sl_recovery_session", resetToken, {httpOnly: true, maxAge: RECOVERY_SECONDS})
  ]);
}
async function recoveryPassword(request, env, ctx) {
  const body = await readRecoveryJson(request);
  const next = typeof body.new_password === "string" ? body.new_password : "";
  if (next.length > 256 || !passwordMeetsPolicy(next)) return apiResponse({error: passwordPolicyMessage()}, 400);
  if (next !== body.confirm_password) return apiResponse({error: "The passwords do not match."}, 400);
  const token = parseCookies(request).sl_recovery_session;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || "")) return apiResponse({error: "Log in with your temporary password first, or start recovery again."}, 401);
  const db = dbFor(env); await ensureRecoverySchema(db);
  const now = new Date().toISOString(); const tokenHash = await sha256Hex(token);
  const challenge = await db.prepare("SELECT * FROM sl_password_recovery WHERE reset_hash=? AND state='authorized' AND expires_at > ? LIMIT 1").bind(tokenHash, now).first();
  const row = challenge ? await findUserById(db, challenge.user_id) : null;
  if (!row || row.role === "admin" || row.status !== "active" || row.email !== challenge.contact_email || row.password_hash !== challenge.password_snapshot) {
    return apiResponse({error: "Recovery has expired. Please start again."}, 401, expiredAuthCookieHeaders(request, "sl_recovery_session"));
  }
  if (await verifyPassword(next, row.password_hash)) return apiResponse({error: "Choose a password different from your previous one."}, 400);
  const passwordHash = await hashPassword(next); const nonce = randomToken(32);
  const results = await db.batch([
    db.prepare("UPDATE sl_password_recovery SET state='consumed', reset_hash=NULL, consume_nonce=? WHERE reset_hash=? AND state='authorized' AND expires_at > ?").bind(nonce, tokenHash, now),
    db.prepare(`UPDATE sl_users SET password_hash=?, updated_at=? WHERE id=? AND password_hash=? AND status='active' AND role!='admin' AND email=?
      AND EXISTS(SELECT 1 FROM sl_password_recovery WHERE consume_nonce=? AND state='consumed')`).bind(passwordHash, now, row.id, row.password_hash, row.email, nonce),
    db.prepare("DELETE FROM sl_sessions WHERE user_id=? AND EXISTS(SELECT 1 FROM sl_users WHERE id=? AND password_hash=?)").bind(row.id, row.id, passwordHash),
    db.prepare(`INSERT INTO sl_audit_log(id,actor_id,target_id,action,details,created_at)
      SELECT ?,?,?,'password_recovered','Contact verification completed; password changed and existing sessions revoked.',?
      WHERE EXISTS(SELECT 1 FROM sl_password_recovery WHERE consume_nonce=? AND state='consumed')
      AND EXISTS(SELECT 1 FROM sl_users WHERE id=? AND password_hash=?)`).bind(newId("audit"), row.id, row.id, now, nonce, row.id, passwordHash),
    db.prepare("DELETE FROM sl_password_recovery WHERE user_id=? AND EXISTS(SELECT 1 FROM sl_users WHERE id=? AND password_hash=?)").bind(row.id, row.id, passwordHash)
  ]);
  const cookies = [...expiredAuthCookieHeaders(request, "sl_recovery_session"), ...expiredAuthCookieHeaders(request, "sl_session")];
  if (results[0].meta?.changes !== 1 || results[1].meta?.changes !== 1) return apiResponse({error: "Recovery has expired. Please start again."}, 409, cookies);
  if (env.LOCAL_MODE !== "true" && recoveryReady(env) && ctx?.waitUntil) ctx.waitUntil(env.RECOVERY_EMAIL.send({
    from: "security@relayskills.com", to: row.email, subject: "Your SwapLabs password was changed",
    text: "Your SwapLabs password was changed through account recovery. Existing sessions and recovery codes have been invalidated. If this was not you, contact support at http://localhost:8000/contact.html immediately.",
    html: "<h1>Password changed</h1><p>Your SwapLabs password was changed through account recovery. Existing sessions and recovery codes have been invalidated.</p><p>If this was not you, <a href='http://localhost:8000/contact.html'>contact support</a> immediately.</p>"
  }).catch(() => { console.error(JSON.stringify({event: "recovery_notification_unavailable"})); }));
  return apiResponse({ok: true, message: "Your password has been saved. Existing sessions have been signed out. Log in with your new password."}, 200, cookies);
}
async function recoveryApi(request, env, ctx, path) {
  try {
    if (request.method === "GET" && path === "/api/auth/recovery/status") return apiResponse({enabled: recoveryReady(env), message: env.LOCAL_MODE === "true" ? "Local verification is available. Complete your account details to get a one-time code on this computer." : RECOVERY_UNAVAILABLE, channel: env.LOCAL_MODE === "true" ? "local" : "email"});
    if (request.method !== "POST" || !["request", "verify", "password"].some(action => path === "/api/auth/recovery/" + action)) return apiResponse({error: "Not found."}, 404);
    if (!csrfIsValid(request)) return apiResponse({error: "Refresh the page and try again. Your secure session has expired."}, 403);
    if (path.endsWith("/password")) return await recoveryPassword(request, env, ctx);
    if (!recoveryReady(env)) return apiResponse({error: RECOVERY_UNAVAILABLE, code: "recovery_unavailable"}, 503);
    if (path.endsWith("/request")) return await recoveryRequest(request, env, ctx);
    return await recoveryVerify(request, env);
  } catch (error) {
    return apiResponse({error: error.status ? error.message : "Recovery is temporarily unavailable. Your password has not been changed."}, error.status || 503);
  }
}
