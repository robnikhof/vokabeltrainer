/*
 * Vokabeltrainer API (Cloudflare Pages Function)
 *
 *   GET  /api/me                 -> { email, serverTime }
 *   GET  /api/sync?since=<ms>    -> { serverTime, cards: [...], settings: {...}|null }
 *   POST /api/sync               <- { cards: [...], settings: {...}|null }
 *                                -> { serverTime, accepted }
 *
 * Who is asking comes from Cloudflare Access: every request carries a signed
 * JWT (header Cf-Access-Jwt-Assertion, or cookie CF_Authorization). We verify
 * the signature against the team's public keys and use the email inside it as
 * the user key, so each person only ever sees their own cards.
 *
 * Environment (Pages project -> Settings):
 *   DB                  D1 binding (required)
 *   ACCESS_TEAM_DOMAIN  e.g. "meinteam.cloudflareaccess.com" (required)
 *   ACCESS_AUD          Application Audience (AUD) tag of the Access app (required)
 *   ALLOWED_EMAILS      optional, comma-separated allow-list
 *   DEV_USER            local development only: skips Access, never set in production
 */

const MAX_CARDS_PER_PUSH = 500;
const MAX_CARD_BYTES = 16 * 1024;
const PULL_OVERLAP_MS = 5000;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (!env.DB) return json({ error: "not_configured", detail: "D1-Binding 'DB' fehlt" }, 503);
  if (!env.DEV_USER && (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)) {
    return json({ error: "not_configured", detail: "ACCESS_TEAM_DOMAIN / ACCESS_AUD fehlen" }, 503);
  }

  let user;
  try {
    user = await authenticate(request, env);
  } catch (e) {
    return json({ error: "auth_failed", detail: String(e && e.message || e) }, 401);
  }
  if (!user) return json({ error: "unauthenticated" }, 401);

  try {
    if (path === "/api/me" && request.method === "GET") {
      return json({ email: user, serverTime: Date.now() });
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

async function authenticate(request, env) {
  // Local development only (wrangler pages dev). Never set DEV_USER in production.
  if (env.DEV_USER) {
    return normalizeEmail(request.headers.get("X-Dev-User") || env.DEV_USER);
  }

  const team = String(env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const aud = String(env.ACCESS_AUD || "").trim();
  if (!team || !aud) throw new Error("ACCESS_TEAM_DOMAIN / ACCESS_AUD nicht gesetzt");

  const token = request.headers.get("Cf-Access-Jwt-Assertion") || readCookie(request, "CF_Authorization");
  if (!token) return null;

  const payload = await verifyAccessJwt(token, team, aud);
  const email = normalizeEmail(payload.email);
  if (!email) return null;

  const allow = String(env.ALLOWED_EMAILS || "").split(",").map(normalizeEmail).filter(Boolean);
  if (allow.length && allow.indexOf(email) === -1) return null;
  return email;
}

let keyCache = { team: "", at: 0, keys: {} };

async function getKeys(team, forceRefresh) {
  const fresh = keyCache.team === team && Date.now() - keyCache.at < 3600 * 1000;
  if (fresh && !forceRefresh) return keyCache.keys;
  const res = await fetch("https://" + team + "/cdn-cgi/access/certs");
  if (!res.ok) throw new Error("Access-Zertifikate nicht abrufbar (" + res.status + ")");
  const body = await res.json();
  const keys = {};
  for (const jwk of body.keys || []) {
    keys[jwk.kid] = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
    );
  }
  keyCache = { team, at: Date.now(), keys };
  return keys;
}

async function verifyAccessJwt(token, team, aud) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("JWT ungültig");
  const header = JSON.parse(b64urlText(parts[0]));
  const payload = JSON.parse(b64urlText(parts[1]));
  if (header.alg !== "RS256") throw new Error("JWT-Algorithmus unerwartet");

  let keys = await getKeys(team, false);
  let key = keys[header.kid];
  if (!key) { keys = await getKeys(team, true); key = keys[header.kid]; }
  if (!key) throw new Error("JWT-Schlüssel unbekannt");

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  if (!ok) throw new Error("JWT-Signatur ungültig");

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) throw new Error("JWT abgelaufen");
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) throw new Error("JWT noch nicht gültig");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (auds.indexOf(aud) === -1) throw new Error("JWT-Audience passt nicht");
  if (payload.iss && payload.iss !== "https://" + team) throw new Error("JWT-Aussteller passt nicht");
  return payload;
}

/* --------------------------------------------------------------- helpers */

function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlText(s) {
  return new TextDecoder().decode(b64urlBytes(s));
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
