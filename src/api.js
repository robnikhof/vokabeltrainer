/*
 * Vokabeltrainer API (Cloudflare Worker, /api/*)
 *
 *   GET  /api/me                 -> { user, name, serverTime }
 *   GET  /api/sync?since=<ms>    -> { serverTime, cards: [...], settings: {...}|null }
 *   POST /api/sync               <- { cards: [...], settings: {...}|null }
 *                                -> { serverTime, accepted }
 *
 * Login: every person has a personal access key, stored as a Worker secret
 * named USERKEY_<NAME> (e.g. USERKEY_ROBERT, USERKEY_HEIKE). The app sends it
 * as "Authorization: Bearer <key>". The matching secret's name, lowercased
 * ("robert", "heike"), is the user id, so each person only sees their own cards.
 *
 * Environment:
 *   DB              D1 binding (required, set in wrangler.jsonc)
 *   USERKEY_<NAME>  one secret per person (required, at least one)
 *   DEV_USER        local development only: skips the key check, never set in production
 */

const MAX_CARDS_PER_PUSH = 500;
const MAX_CARD_BYTES = 16 * 1024;
const PULL_OVERLAP_MS = 5000;
const MIN_KEY_LENGTH = 20;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (!env.DB) return json({ error: "not_configured", detail: "D1-Binding 'DB' fehlt" }, 503);
  const users = userKeys(env);
  if (!env.DEV_USER && !users.length) {
    return json({ error: "not_configured", detail: "Kein USERKEY_*-Secret gesetzt" }, 503);
  }

  const user = await authenticate(request, env, users);
  if (!user) return json({ error: "unauthenticated" }, 401);

  try {
    if (path === "/api/me" && request.method === "GET") {
      return json({ user, name: user.charAt(0).toUpperCase() + user.slice(1), serverTime: Date.now() });
    }
    if (path === "/api/sync" && request.method === "GET") {
      return await pull(env, user, url);
    }
    if (path === "/api/sync" && request.method === "POST") {
      return await push(env, user, request);
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    return json({ error: "server_error", detail: String(e && e.message || e) }, 500);
  }
}

/* ------------------------------------------------------------------ sync */

async function pull(env, user, url) {
  const serverTime = Date.now();
  const since = Math.max(0, (parseInt(url.searchParams.get("since") || "0", 10) || 0) - PULL_OVERLAP_MS);

  const rows = await env.DB
    .prepare("SELECT data FROM cards WHERE user = ? AND srv > ? ORDER BY srv LIMIT 5000")
    .bind(user, since)
    .all();
  const cards = [];
  for (const r of rows.results || []) {
    try { cards.push(JSON.parse(r.data)); } catch (_) { /* skip corrupt row */ }
  }

  const s = await env.DB
    .prepare("SELECT data FROM settings WHERE user = ?")
    .bind(user)
    .first();
  let settings = null;
  if (s) { try { settings = JSON.parse(s.data); } catch (_) {} }

  return json({ serverTime, cards, settings });
}

async function push(env, user, request) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "bad_json" }, 400); }

  const incoming = Array.isArray(body && body.cards) ? body.cards : [];
  if (incoming.length > MAX_CARDS_PER_PUSH) return json({ error: "too_many_cards" }, 413);

  const now = Date.now();
  const stmts = [];
  let accepted = 0;

  for (const c of incoming) {
    if (!c || typeof c.id !== "string" || !c.id || c.id.length > 64) continue;
    const updatedAt = Number(c.updatedAt) || 0;
    const data = JSON.stringify(c);
    if (data.length > MAX_CARD_BYTES) continue;
    stmts.push(env.DB.prepare(
      "INSERT INTO cards (user, id, lang, data, updated_at, deleted, srv) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(user, id) DO UPDATE SET lang = excluded.lang, data = excluded.data, " +
      "updated_at = excluded.updated_at, deleted = excluded.deleted, srv = excluded.srv " +
      "WHERE excluded.updated_at >= cards.updated_at"
    ).bind(user, c.id, String(c.lang || "").slice(0, 8), data, updatedAt, c.deleted ? 1 : 0, now));
    accepted++;
  }

  const st = body && body.settings;
  if (st && typeof st === "object") {
    const data = JSON.stringify(st);
    if (data.length <= MAX_CARD_BYTES) {
      stmts.push(env.DB.prepare(
        "INSERT INTO settings (user, data, updated_at, srv) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(user) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, srv = excluded.srv " +
        "WHERE excluded.updated_at >= settings.updated_at"
      ).bind(user, data, Number(st.updatedAt) || 0, now));
    }
  }

  if (stmts.length) await env.DB.batch(stmts);
  return json({ serverTime: now, accepted });
}

/* ------------------------------------------------------------------ auth */

function userKeys(env) {
  const out = [];
  for (const name of Object.keys(env)) {
    const m = /^USERKEY_([A-Z0-9_]+)$/i.exec(name);
    if (!m) continue;
    const key = String(env[name] || "").trim();
    if (key.length < MIN_KEY_LENGTH) continue;          // zu kurze Schlüssel ignorieren
    out.push({ user: m[1].toLowerCase(), key });
  }
  return out;
}

async function authenticate(request, env, users) {
  // Local development only (wrangler dev). Never set DEV_USER in production.
  if (env.DEV_USER) {
    return String(request.headers.get("X-Dev-User") || env.DEV_USER).trim().toLowerCase();
  }
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const given = await sha256(m[1].trim());
  for (const u of users) {
    if (timingSafeEqual(given, await sha256(u.key))) return u.user;
  }
  return null;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* --------------------------------------------------------------- helpers */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
