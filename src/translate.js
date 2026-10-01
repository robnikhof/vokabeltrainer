/*
 * POST /api/translate  <- { text, lang }      lang: en | fr | nl | it | es
 *                      -> { result: {...}, cached }
 *
 * Schlägt ein Wort oder eine Wendung über die Claude API (Anthropic) nach und
 * liefert ein festes Format, das die App direkt als Karte übernehmen kann.
 * Ergebnisse werden in D1 (Tabelle lookups) zwischengespeichert; neue
 * Abfragen zählen gegen ein Tageslimit pro Person (Tabelle lookup_usage).
 *
 * Environment:
 *   ANTHROPIC_API_KEY   Secret (erforderlich)
 *   ANTHROPIC_MODEL     optional, Standard: claude-haiku-4-5-20251001
 *   LOOKUP_DAILY_LIMIT  optional, Standard: 200
 *   ANTHROPIC_BASE_URL  optional, nur für lokale Tests
 */

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_TEXT = 120;

const LANG_NAMES = {
  en: "Englisch",
  fr: "Französisch",
  nl: "Niederländisch",
  it: "Italienisch",
  es: "Spanisch"
};

const TOOL = {
  name: "vokabel",
  description: "Gibt das Nachschlage-Ergebnis als Karteikarte für einen deutschsprachigen Lernenden zurück.",
  input_schema: {
    type: "object",
    properties: {
      term: {
        type: "string",
        description: "Das Wort bzw. die Wendung in der Fremdsprache, korrekt geschrieben, bei Nomen mit bestimmtem Artikel (z. B. 'la boulangerie', 'de fiets', 'het huis'). Verben im Infinitiv."
      },
      meaning: {
        type: "string",
        description: "Die gebräuchlichste deutsche Übersetzung, kurz. Bei Nomen mit deutschem Artikel."
      },
      alternatives: {
        type: "array",
        items: { type: "string" },
        maxItems: 3,
        description: "Bis zu drei weitere deutsche Bedeutungen, falls es wirklich andere Bedeutungen gibt. Sonst leer."
      },
      gender: {
        type: "string",
        description: "Nur bei Nomen: 'mask.', 'fem.' (Französisch, Italienisch, Spanisch), 'de-Wort' oder 'het-Wort' (Niederländisch). Sonst leerer String."
      },
      kind: {
        type: "string",
        enum: ["word", "phrase", "verb", "grammar"],
        description: "word = einzelnes Wort außer Verb, verb = Verb, phrase = Wendung/Redewendung, grammar = Grammatikregel."
      },
      example: {
        type: "string",
        description: "Ein kurzer, alltagstauglicher Beispielsatz in der Fremdsprache, der den Begriff enthält."
      },
      example_de: {
        type: "string",
        description: "Die deutsche Übersetzung des Beispielsatzes."
      },
      tip: {
        type: "string",
        description: "Optional ein sehr kurzer Lernhinweis (z. B. falscher Freund, unregelmäßiges Verb, trennbares Verb). Sonst leerer String."
      },
      found: {
        type: "boolean",
        description: "false, wenn die Eingabe kein sinnvolles Wort der Sprache ist (Tippfehler ohne klare Korrektur, Unsinn)."
      }
    },
    required: ["term", "meaning", "alternatives", "gender", "kind", "example", "example_de", "tip", "found"]
  }
};

export async function translate(env, user, request) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "translate_not_configured" }, 503);
  }

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "bad_json" }, 400); }
  const lang = String(body && body.lang || "");
  const text = String(body && body.text || "").replace(/\s+/g, " ").trim();
  if (!LANG_NAMES[lang]) return json({ error: "bad_lang" }, 400);
  if (!text) return json({ error: "empty" }, 400);
  if (text.length > MAX_TEXT) return json({ error: "too_long" }, 400);

  const q = text.toLowerCase();

  // 1. Cache
  const hit = await env.DB.prepare("SELECT data FROM lookups WHERE lang = ? AND q = ?").bind(lang, q).first();
  if (hit) {
    try { return json({ result: JSON.parse(hit.data), cached: true }); } catch (_) { /* neu nachschlagen */ }
  }

  // 2. Tageslimit pro Person
  const limit = parseInt(env.LOOKUP_DAILY_LIMIT || "200", 10) || 200;
  const day = new Date().toISOString().slice(0, 10);
  const used = await env.DB.prepare("SELECT n FROM lookup_usage WHERE user = ? AND day = ?").bind(user, day).first();
  if (used && used.n >= limit) return json({ error: "limit_reached", limit }, 429);

  // 3. Claude fragen
  const langName = LANG_NAMES[lang];
  const system =
    "Du bist ein präzises Wörterbuch für deutschsprachige Lernende der Sprache " + langName + ". " +
    "Die Eingabe ist entweder ein Wort/eine Wendung auf " + langName + " oder auf Deutsch. " +
    "Erkenne die Richtung selbst: Ist die Eingabe deutsch, gib in 'term' die passende " + langName + "-Entsprechung an. " +
    "Korrigiere offensichtliche Tippfehler stillschweigend. Antworte ausschließlich über das Werkzeug 'vokabel'.";

  let res;
  try {
    res = await fetch((env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        max_tokens: 600,
        system,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: [{ role: "user", content: text }]
      })
    });
  } catch (e) {
    return json({ error: "upstream_unreachable" }, 502);
  }

  if (!res.ok) {
    let detail = "";
    try { const e = await res.json(); detail = e && e.error && e.error.message || ""; } catch (_) {}
    const code = res.status === 401 ? "translate_bad_key" : "upstream_error";
    return json({ error: code, status: res.status, detail: detail.slice(0, 200) }, 502);
  }

  const data = await res.json();
  const block = (data.content || []).find(function (c) { return c.type === "tool_use"; });
  if (!block || !block.input) return json({ error: "upstream_error", detail: "keine Werkzeug-Antwort" }, 502);

  const result = clean(block.input, lang);

  // 4. Zähler erhöhen und Ergebnis zwischenspeichern
  const now = Date.now();
  const stmts = [
    env.DB.prepare(
      "INSERT INTO lookup_usage (user, day, n) VALUES (?, ?, 1) ON CONFLICT(user, day) DO UPDATE SET n = n + 1"
    ).bind(user, day)
  ];
  if (result.found) {
    stmts.push(env.DB.prepare(
      "INSERT OR REPLACE INTO lookups (lang, q, data, created) VALUES (?, ?, ?, ?)"
    ).bind(lang, q, JSON.stringify(result), now));
  }
  await env.DB.batch(stmts);

  return json({ result, cached: false });
}

function clean(r, lang) {
  const s = function (v, max) { return String(v == null ? "" : v).trim().slice(0, max || 300); };
  const kinds = ["word", "phrase", "verb", "grammar"];
  return {
    lang,
    term: s(r.term, 120),
    meaning: s(r.meaning, 160),
    alternatives: (Array.isArray(r.alternatives) ? r.alternatives : []).map(function (a) { return s(a, 80); }).filter(Boolean).slice(0, 3),
    gender: s(r.gender, 20),
    kind: kinds.indexOf(r.kind) > -1 ? r.kind : "word",
    example: s(r.example, 240),
    example_de: s(r.example_de, 240),
    tip: s(r.tip, 160),
    found: r.found !== false
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
