/**
 * drastic-measures — GATEWAY (aligned to repo gateway worker)
 *
 * + ASSET-ID ENFORCED (Origin -> AssetID)
 * + Clean/scan/sanitize BEFORE Guard + Upstream
 * + Guard at Edge
 * + Forward Upstream headers (x-gabo-*)
 * + Convert Upstream streaming (raw JSON OR SSE) -> SSE text deltas (UI-friendly)
 *
 * SSE parity:
 * - Uses "data:" (NO space) framing
 * - NO zero-width injection
 * - Normalizes CRLF/Lone-CR -> LF in stream buffer
 * - Does NOT modify payload content
 *
 * Routing parity:
 * - Uses env.UPSTREAM_URL (no service binding)
 * - Calls `${UPSTREAM_URL}/api/chat`
 *
 * Notes on GitHub Pages path:
 * - The browser `Origin` header never includes a path (e.g. `/tastycles/`).
 * - So `https://chattiavato-a11y.github.io/tastycles/` is covered by the Origin:
 *   `https://chattiavato-a11y.github.io`
 */

// -------------------------
// Allowed Origins + Asset IDs (Origin -> AssetID)
// -------------------------
const ORIGIN_ASSET_ID = new Map([
  // gabo.io
  [
    "https://www.gabo.io",
    "b91f605b23748de5cf02db0de2dd59117b31c709986a3c72837d0af8756473cf2779c206fc6ef80a57fdeddefa4ea11b972572f3a8edd9ed77900f9385e94bd6",
  ],
  [
    "https://gabo.io",
    "8cdeef86bd180277d5b080d571ad8e6dbad9595f408b58475faaa3161f07448fbf12799ee199e3ee257405b75de555055fd5f43e0ce75e0740c4dc11bf86d132",
  ],

  // GitHub Pages host (covers /tastycles/ because Origin has no path)
  [
    "https://chattiavato-a11y.github.io",
    "b8f12ffa3559cee4ac71cb5f54eba1aed46394027f52e562d20be7a523db2a036f20c6e8fb0577c0a8d58f2fd198046230ebc0a73f4f1e71ff7c377d656f0756",
  ],

  // OPTIONAL: keep ONLY if you actually serve a browser UI from this Worker domain
  [
    "https://drastic-measures.rulathemtodos.workers.dev/",
    "96dd27ea493d045ed9b46d72533e2ed2ec897668e2227dd3d79fff85ca2216a569c4bf622790c6fb0aab9f17b4e92d0f8e0fa040356bee68a9c3d50d5a60c945",
  ],
]);

const ALLOWED_ORIGINS = new Set(Array.from(ORIGIN_ASSET_ID.keys()));

// -------------------------
// Hop header parity (repo)
// -------------------------
const HOP_HDR = "x-gabo-hop";
const HOP_VAL = "gateway";

// -------------------------
// Models (Gateway)
// -------------------------
const MODEL_GUARD = "@cf/meta/llama-guard-3-8b";
const MODEL_STT = "@cf/openai/whisper-large-v3-turbo";
const TTS_EN = "@cf/deepgram/aura-2-en";
const TTS_ES = "@cf/deepgram/aura-2-es";
const TTS_FALLBACK = "@cf/myshell-ai/melotts";

// Language classifier fallback (only used when heuristics fail)
const MODEL_CHAT_FAST = "@cf/meta/llama-3.2-3b-instruct";

// Optional hooks (only used if requested via meta flags you allow)
const MODEL_TRANSLATE = "@cf/meta/m2m100-1.2b";
const MODEL_EMBED = "@cf/baai/bge-m3";

// -------------------------
// Limits
// -------------------------
const MAX_BODY_CHARS = 8_000;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 1_000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

// -------------------------
// Security headers (repo parity)
// -------------------------
function securityHeaders() {
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  h.set("Cache-Control", "no-store, no-transform");
  h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  h.set("X-Permitted-Cross-Domain-Policies", "none");
  h.set("X-DNS-Prefetch-Control", "off");
  h.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  h.set("Cross-Origin-Resource-Policy", "cross-origin");
  return h;
}

// -------------------------
// CORS
// -------------------------
function isAllowedOrigin(origin) {
  return !!origin && origin !== "null" && ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(origin) {
  const h = new Headers();

  if (isAllowedOrigin(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  }

  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set(
    "Access-Control-Allow-Headers",
    [
      "content-type",
      "accept",
      "x-ops-asset-id",
      "x-ops-src-sha512-b64",
      "cf-turnstile-response",
      // repo parity: UI language hints
      "x-gabo-lang-hint",
      "x-gabo-lang-list",
      "x-gabo-voice-language",
    ].join(", ")
  );

  h.set(
    "Access-Control-Expose-Headers",
    [
      "x-gabo-stt-iso2",
      "x-gabo-voice-timeout-sec",
      "x-gabo-tts-iso2",
      "x-gabo-lang-iso2",
      "x-gabo-model",
      "x-gabo-translated",
      "x-gabo-embeddings",
      "x-gabo-asset-verified",
    ].join(", ")
  );

  h.set("Access-Control-Max-Age", "86400");
  return h;
}

// -------------------------
// Response helpers
// -------------------------
function json(status, obj, extra) {
  const h = new Headers(extra || {});
  h.set("content-type", "application/json; charset=utf-8");
  securityHeaders().forEach((v, k) => h.set(k, v));
  return new Response(JSON.stringify(obj), { status, headers: h });
}

function sse(stream, extra) {
  const h = new Headers(extra || {});
  h.set("content-type", "text/event-stream; charset=utf-8");
  h.set("cache-control", "no-cache, no-transform");
  // repo parity: SSE proxy buffering hint
  h.set("x-accel-buffering", "no");
  securityHeaders().forEach((v, k) => h.set(k, v));
  return new Response(stream, { status: 200, headers: h });
}

// -------------------------
// Clean / scan / sanitize
// -------------------------
function safeTextOnly(s) {
  s = String(s || "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue;
    const ok = c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160;
    if (ok) out += s[i];
  }
  return out.trim();
}

function stripDangerousMarkup(text) {
  let t = String(text || "");
  t = t.replace(/\u0000/g, "");
  t = t.replace(/\r\n?/g, "\n");

  // Remove script/style blocks
  t = t.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");

  // Remove high-risk tags
  t = t.replace(/<\s*(iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, "");
  t = t.replace(/<\s*\/\s*(iframe|object|embed|link|meta|base|form)\s*>/gi, "");

  // Remove dangerous schemes
  t = t.replace(/\bjavascript\s*:/gi, "");
  t = t.replace(/\bvbscript\s*:/gi, "");
  t = t.replace(/\bdata\s*:\s*text\/html\b/gi, "");

  // Remove inline handlers (best-effort)
  t = t.replace(/\bon\w+\s*=\s*["'][\s\S]*?["']/gi, "");
  t = t.replace(/\bon\w+\s*=\s*[^\s>]+/gi, "");

  if (t.length > MAX_MESSAGE_CHARS) t = t.slice(0, MAX_MESSAGE_CHARS);
  return t.trim();
}

function looksMalicious(text) {
  const t = String(text || "").toLowerCase();
  const bad = [
    "<script",
    "document.cookie",
    "localstorage.",
    "sessionstorage.",
    "onerror=",
    "onload=",
    "eval(",
    "new function",
    "javascript:",
    "vbscript:",
    "data:text/html",
    "base64,",
  ];
  for (const p of bad) if (t.includes(p)) return true;
  return false;
}

function sanitizeContent(text) {
  const cleaned = stripDangerousMarkup(safeTextOnly(text));
  return safeTextOnly(cleaned);
}

function normalizeMessages(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;

    let content = typeof m.content === "string" ? m.content : "";
    content = sanitizeContent(content);
    if (!content) continue;

    if (content.length > MAX_MESSAGE_CHARS) content = content.slice(0, MAX_MESSAGE_CHARS);

    if (looksMalicious(content)) {
      out.push({ role, content: "[REDACTED: blocked suspicious content]" });
      continue;
    }

    out.push({ role, content });
  }
  return out;
}

function lastUserText(messages) {
  return [...messages].reverse().find((m) => m.role === "user")?.content || "";
}

// -------------------------
// Language (multi-language) — repo-style: meta wins, then heuristic, then model
// -------------------------
function normalizeIso2(code) {
  const s = safeTextOnly(code || "").toLowerCase();
  if (!s) return "";
  const two = s.includes("-") ? s.split("-")[0] : s;
  return (two || "").slice(0, 2);
}

function hasRange(text, a, b) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= a && c <= b) return true;
  }
  return false;
}

function detectLangIso2Heuristic(text) {
  const t0 = String(text || "");
  if (!t0) return "";

  // Script-based quick wins
  if (hasRange(t0, 0x3040, 0x30ff)) return "ja";
  if (hasRange(t0, 0xac00, 0xd7af)) return "ko";
  if (hasRange(t0, 0x4e00, 0x9fff)) return "zh";
  if (hasRange(t0, 0x0400, 0x04ff)) return "ru";
  if (hasRange(t0, 0x0600, 0x06ff)) return "ar";
  if (hasRange(t0, 0x0590, 0x05ff)) return "he";
  if (hasRange(t0, 0x0370, 0x03ff)) return "el";
  if (hasRange(t0, 0x0900, 0x097f)) return "hi";
  if (hasRange(t0, 0x0e00, 0x0e7f)) return "th";

  const t = t0.toLowerCase();

  // Spanish
  if (/[ñáéíóúü¿¡]/i.test(t)) return "es";
  const esHits = ["hola","gracias","por favor","buenos","buenas","necesito","ayuda","quiero","donde","qué","cuánto","porque"]
    .filter((w) => t.includes(w)).length;
  if (esHits >= 2) return "es";

  // Portuguese
  if (/[ãõç]/i.test(t)) return "pt";
  const ptHits = ["olá","ola","obrigado","obrigada","por favor","você","vocês","não","nao","tudo bem"]
    .filter((w) => t.includes(w)).length;
  if (ptHits >= 2) return "pt";

  // French
  const frHits = ["bonjour","salut","merci","s'il","s’il","vous","au revoir","ça va","comment","aujourd"]
    .filter((w) => t.includes(w)).length;
  if (frHits >= 2 || /[àâçéèêëîïôûùüÿœ]/i.test(t)) return "fr";

  // German
  if (/[äöüß]/i.test(t)) return "de";
  const deHits = ["hallo","danke","bitte","und","ich","nicht","wie geht","heute"]
    .filter((w) => t.includes(w)).length;
  if (deHits >= 2) return "de";

  // Italian
  const itHits = ["ciao","grazie","per favore","come va","oggi","buongiorno","buonasera"]
    .filter((w) => t.includes(w)).length;
  if (itHits >= 2) return "it";

  // Indonesian
  const idHits = ["halo","terima kasih","tolong","selamat","bagaimana","hari ini"]
    .filter((w) => t.includes(w)).length;
  if (idHits >= 2) return "id";

  return "";
}

async function detectLangIso2ViaModel(env, text) {
  const sample = sanitizeContent(String(text || "")).slice(0, 240);
  if (sample.length < 8) return "und";

  try {
    const out = await env.AI.run(MODEL_CHAT_FAST, {
      stream: false,
      max_tokens: 6,
      messages: [
        { role: "system", content: "Return ONLY the ISO 639-1 language code (two letters). If unsure, return 'und'. No extra text." },
        { role: "user", content: `Text:\n${sample}` },
      ],
    });

    const raw = String(out?.response || out?.result?.response || out?.text || out || "").trim().toLowerCase();
    const m = raw.match(/\b([a-z]{2}|und)\b/);
    return m ? m[1] : "und";
  } catch {
    return "und";
  }
}

async function detectLangIso2(env, messages, metaSafe) {
  // 1) meta wins (if valid)
  const metaLang = normalizeIso2(metaSafe?.lang_iso2 || "");
  if (metaLang && metaLang !== "und" && metaLang !== "auto") return metaLang;

  // 2) heuristic
  const lastUser = lastUserText(messages);
  const heur = detectLangIso2Heuristic(lastUser);
  if (heur) return heur;

  // 3) model fallback
  const modelGuess = await detectLangIso2ViaModel(env, lastUser);
  if (modelGuess && modelGuess !== "und") return modelGuess;

  return "und";
}

// -------------------------
// Guard parsing + meta sanitize (minimal safe surface)
// -------------------------
function parseGuardResult(res) {
  const r = res?.response ?? res?.result?.response ?? res?.result ?? res;
  if (r && typeof r === "object" && typeof r.safe === "boolean") {
    return { safe: r.safe, categories: Array.isArray(r.categories) ? r.categories : [] };
  }
  if (typeof r === "string") {
    const lower = r.toLowerCase();
    if (lower.includes("unsafe")) return { safe: false, categories: [] };
    if (lower.includes("safe")) return { safe: true, categories: [] };
  }
  return { safe: false, categories: ["GUARD_UNPARSEABLE"] };
}

function sanitizeMeta(metaIn) {
  const meta = (metaIn && typeof metaIn === "object") ? metaIn : {};
  const out = {};

  const lang = normalizeIso2(meta.lang_iso2 || "");
  const spanishQuality = safeTextOnly(meta.spanish_quality || "");
  const model = safeTextOnly(meta.model || "");
  const translateTo = normalizeIso2(meta.translate_to || "");

  if (lang) out.lang_iso2 = lang;
  if (spanishQuality) out.spanish_quality = spanishQuality;
  if (model) out.model = model;
  if (translateTo) out.translate_to = translateTo;

  if (typeof meta.want_embeddings === "boolean") out.want_embeddings = meta.want_embeddings;

  return out;
}

// -------------------------
// Asset identity enforcement
// -------------------------
function expectedAssetIdForOrigin(origin) {
  return ORIGIN_ASSET_ID.get(origin) || "";
}

function verifyAssetIdentity(origin, request) {
  const got = safeTextOnly(request.headers.get("x-ops-asset-id") || "");
  const expected = expectedAssetIdForOrigin(origin);
  return { ok: !!expected && got === expected, got, expected };
}

// -------------------------
// Voice helpers (Whisper STT) — shared pattern
// -------------------------
async function runWhisper(env, audioU8) {
  try {
    return await env.AI.run(MODEL_STT, { audio: audioU8.buffer });
  } catch {
    return await env.AI.run(MODEL_STT, { audio: Array.from(audioU8) });
  }
}

function base64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 255;
  return u8;
}

// -------------------------
// Upstream call (env var routing)
// -------------------------
function upstreamBase(env) {
  const u = String(env?.UPSTREAM_URL || "").trim();
  if (!u) throw new Error("UPSTREAM_URL is not configured.");
  return u.replace(/\/$/, "");
}

async function callUpstream(env, payload) {
  const base = upstreamBase(env);
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      [HOP_HDR]: HOP_VAL,
    },
    body: JSON.stringify(payload),
  });
}

function forwardUpstreamHeaders(outHeaders, upstreamResp) {
  const pass = ["x-gabo-lang-iso2", "x-gabo-model", "x-gabo-translated", "x-gabo-embeddings"];
  for (const k of pass) {
    const v = upstreamResp.headers.get(k);
    if (v) outHeaders.set(k, v);
  }
}

// -------------------------
// Upstream stream -> SSE text deltas (NO payload mutation)
// -------------------------
function sseDataFrame(text) {
  // IMPORTANT: "data:" (NO trailing space). Payload must be unmodified.
  const s = String(text ?? "");
  const lines = s.split("\n");
  let out = "";
  for (const line of lines) out += "data:" + line + "\n";
  out += "\n";
  return out;
}

function extractJsonObjectsFromBuffer(buffer) {
  // Balanced-brace extractor (handles strings + escapes) for raw concatenated JSON objects.
  const out = [];
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];

    if (start === -1) {
      if (ch === "{") {
        start = i;
        depth = 1;
        inStr = false;
        esc = false;
      }
      continue;
    }

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }

    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      out.push(buffer.slice(start, i + 1));
      start = -1;
    }
  }

  const rest = (start === -1) ? "" : buffer.slice(start);
  return { chunks: out, rest };
}

function extractSSEBlocks(buffer) {
  const blocks = [];
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    blocks.push(buffer.slice(0, idx));
    buffer = buffer.slice(idx + 2);
  }
  return { blocks, rest: buffer };
}

function parseSSEBlockToData(block) {
  const lines = String(block || "").split("\n");
  const dataLines = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("data:")) dataLines.push(line.slice(5)); // DO NOT trim payload
  }
  return { data: dataLines.join("\n") };
}

function getDeltaFromObj(obj) {
  if (!obj) return "";
  if (typeof obj.response === "string") return obj.response;
  if (obj.result && typeof obj.result.response === "string") return obj.result.response;
  if (obj.response && obj.response.response && typeof obj.response.response === "string") return obj.response.response;
  return "";
}

function bridgeUpstreamToSSE(upstreamBody) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  if (!upstreamBody) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseDataFrame("")));
        controller.close();
      },
    });
  }

  return new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader();
      let buf = "";

      try {
        // hello comment (keeps some proxies happy)
        controller.enqueue(encoder.encode(": ok\n\n"));

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buf += decoder.decode(value, { stream: true });

          // Normalize CRLF + lone CR -> LF (repo parity)
          buf = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

          // 1) If Upstream is SSE, parse SSE blocks first
          const looksLikeSSE = /(^|\n)data:/.test(buf) && buf.includes("\n\n");
          if (looksLikeSSE) {
            const { blocks, rest } = extractSSEBlocks(buf);
            buf = rest;

            for (const block of blocks) {
              const { data } = parseSSEBlockToData(block);

              // End sentinel support
              const dataTrim = String(data || "").trim();
              if (dataTrim === "[DONE]") {
                controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
                controller.close();
                return;
              }

              // data may be JSON or plain text
              const d0 = dataTrim[0];
              if (d0 === "{" || d0 === "[") {
                try {
                  const obj = JSON.parse(dataTrim);
                  const delta = getDeltaFromObj(obj);
                  if (delta) controller.enqueue(encoder.encode(sseDataFrame(delta)));
                } catch {
                  if (data) controller.enqueue(encoder.encode(sseDataFrame(String(data))));
                }
              } else {
                if (data) controller.enqueue(encoder.encode(sseDataFrame(String(data))));
              }
            }
            continue;
          }

          // 2) Otherwise parse raw concatenated JSON objects
          if (buf.length > 1_000_000 && !buf.includes("{")) buf = buf.slice(-100_000);

          const { chunks, rest } = extractJsonObjectsFromBuffer(buf);
          buf = rest;

          for (const s of chunks) {
            let obj;
            try { obj = JSON.parse(s); } catch { continue; }
            const delta = getDeltaFromObj(obj);
            if (delta) controller.enqueue(encoder.encode(sseDataFrame(delta)));
          }
        }

        // flush any remaining decode tail
        const tail = decoder.decode();
        if (tail) buf += tail;

        controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
      } catch {
        controller.enqueue(encoder.encode("event: error\ndata: stream_error\n\n"));
      } finally {
        try { reader.releaseLock(); } catch {}
        try { controller.close(); } catch {}
      }
    },
  });
}

// -------------------------
// TTS
// -------------------------
async function ttsAny(env, text, langIso2) {
  const iso2 = normalizeIso2(langIso2 || "en") || "en";
  const preferred = iso2 === "es" ? TTS_ES : TTS_EN;

  try {
    const raw = await env.AI.run(preferred, { text, encoding: "mp3", container: "none" }, { returnRawResponse: true });
    const ct = raw?.headers?.get?.("content-type") || "";
    if (raw?.body && ct.toLowerCase().includes("audio")) return { body: raw.body, ct };
  } catch {}

  try {
    const out = await env.AI.run(preferred, { text, encoding: "mp3", container: "none" });
    const b64 = out?.audio || out?.result?.audio || out?.response?.audio || "";
    if (typeof b64 === "string" && b64.length > 16) return { body: base64ToBytes(b64), ct: "audio/mpeg" };
  } catch {}

  const out2 = await env.AI.run(TTS_FALLBACK, { prompt: text, lang: iso2 });
  const b64 = out2?.audio || out2?.result?.audio || "";
  if (typeof b64 === "string" && b64.length > 16) return { body: base64ToBytes(b64), ct: "audio/mpeg" };

  throw new Error("TTS failed");
}

// -------------------------
// Usage JSON for GET
// -------------------------
function usage(path) {
  if (path === "/api/chat") {
    return {
      ok: true,
      route: "/api/chat",
      method: "POST",
      required_headers: ["content-type", "accept", "x-ops-asset-id"],
      body_json: { messages: [{ role: "user", content: "Hello" }], meta: {} },
      allowed_origins: Array.from(ALLOWED_ORIGINS),
    };
  }
  if (path === "/api/tts") {
    return {
      ok: true,
      route: "/api/tts",
      method: "POST",
      required_headers: ["content-type", "accept", "x-ops-asset-id"],
      body_json: { text: "Hello", lang_iso2: "en" },
      allowed_origins: Array.from(ALLOWED_ORIGINS),
    };
  }
  if (path === "/api/voice") {
    return {
      ok: true,
      route: "/api/voice?mode=stt | /api/voice?mode=chat",
      method: "POST",
      required_headers: ["accept", "x-ops-asset-id"],
      body_binary: "audio/webm (or wav/mp3/etc) OR JSON {audio_b64|audio[]}",
      allowed_origins: Array.from(ALLOWED_ORIGINS),
    };
  }
  return { ok: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    const isChat = url.pathname === "/api/chat";
    const isVoice = url.pathname === "/api/voice";
    const isTts = url.pathname === "/api/tts";

    // Preflight
    if (request.method === "OPTIONS") {
      const h = corsHeaders(origin);
      securityHeaders().forEach((v, k) => h.set(k, v));
      return new Response(null, { status: 204, headers: h });
    }

    // Health
    if (url.pathname === "/" || url.pathname === "/health") {
      const h = corsHeaders(origin);
      securityHeaders().forEach((v, k) => h.set(k, v));
      return new Response("gateway: ok", { status: 200, headers: h });
    }

    // Helpful GET usage
    if (request.method === "GET" && (isChat || isVoice || isTts)) {
      const extra = corsHeaders(origin);
      return json(200, usage(url.pathname), extra);
    }

    // Only these routes exist
    if (!isChat && !isVoice && !isTts) {
      return json(404, { error: "Not found" }, corsHeaders(origin));
    }

    // POST only for real work
    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed" }, corsHeaders(origin));
    }

    // Strict CORS for POST
    if (!isAllowedOrigin(origin)) {
      return json(
        403,
        { error: "Origin not allowed", saw_origin: origin || "(none)", allowed: Array.from(ALLOWED_ORIGINS) },
        corsHeaders(origin)
      );
    }

    // Must have AI
    if (!env?.AI || typeof env.AI.run !== "function") {
      return json(500, { error: "Missing AI binding (env.AI)" }, corsHeaders(origin));
    }

    // Enforce asset identity (Origin -> expected asset id)
    const assetCheck = verifyAssetIdentity(origin, request);
    if (!assetCheck.ok) {
      return json(
        403,
        {
          error: "Invalid asset identity",
          detail: "x-ops-asset-id must match the calling Origin.",
          origin,
          got_asset_id: assetCheck.got || "(none)",
          expected_asset_id: assetCheck.expected || "(missing mapping)",
        },
        corsHeaders(origin)
      );
    }

    // Base response headers for successful paths
    const baseExtra = corsHeaders(origin);
    baseExtra.set("x-gabo-asset-verified", "1");

    // -----------------------
    // /api/chat -> Guard -> Upstream -> SSE (TEXT DELTAS)
    // -----------------------
    if (isChat) {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) return json(415, { error: "content-type must be application/json" }, baseExtra);

      const raw = await request.text().catch(() => "");
      if (!raw || raw.length > MAX_BODY_CHARS) return json(413, { error: "Request too large" }, baseExtra);

      let body;
      try { body = JSON.parse(raw); } catch { return json(400, { error: "Invalid JSON" }, baseExtra); }

      const messages = normalizeMessages(body.messages);
      if (!messages.length) return json(400, { error: "messages[] required" }, baseExtra);

      const metaSafe = sanitizeMeta(body.meta);

      // Detect language (multi-language)
      const langIso2 = await detectLangIso2(env, messages, metaSafe);
      if (!metaSafe.lang_iso2 || metaSafe.lang_iso2 === "auto" || metaSafe.lang_iso2 === "und") {
        metaSafe.lang_iso2 = langIso2;
      }

      // Guard at edge
      let guardRes;
      try { guardRes = await env.AI.run(MODEL_GUARD, { messages }); }
      catch { return json(502, { error: "Safety check unavailable" }, baseExtra); }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) return json(403, { error: "Blocked by safety filter", categories: verdict.categories }, baseExtra);

      // Call Upstream
      let upstreamResp;
      try { upstreamResp = await callUpstream(env, { messages, meta: metaSafe }); }
      catch (e) { return json(502, { error: "Upstream unreachable", detail: String(e?.message || e) }, baseExtra); }

      if (!upstreamResp.ok) {
        const t = await upstreamResp.text().catch(() => "");
        return json(502, { error: "Upstream error", status: upstreamResp.status, detail: t.slice(0, 2000) }, baseExtra);
      }

      const extra = new Headers(baseExtra);
      forwardUpstreamHeaders(extra, upstreamResp);

      return sse(bridgeUpstreamToSSE(upstreamResp.body), extra);
    }

    // -----------------------
    // /api/tts -> audio
    // -----------------------
    if (isTts) {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) return json(415, { error: "content-type must be application/json" }, baseExtra);

      const raw = await request.text().catch(() => "");
      if (!raw || raw.length > MAX_BODY_CHARS) return json(413, { error: "Request too large" }, baseExtra);

      let body;
      try { body = JSON.parse(raw); } catch { return json(400, { error: "Invalid JSON" }, baseExtra); }

      const text = sanitizeContent(body?.text || "");
      if (!text) return json(400, { error: "text required" }, baseExtra);
      if (looksMalicious(text)) return json(403, { error: "Blocked by security sanitizer" }, baseExtra);

      const langIso2 = normalizeIso2(body?.lang_iso2 || "en") || "en";

      const extra = new Headers(baseExtra);
      extra.set("x-gabo-tts-iso2", langIso2);

      try {
        const out = await ttsAny(env, text, langIso2);
        const h = new Headers(extra);
        h.set("content-type", out.ct || "audio/mpeg");
        securityHeaders().forEach((v, k) => h.set(k, v));
        return new Response(out.body, { status: 200, headers: h });
      } catch (e) {
        return json(502, { error: "TTS unavailable", detail: String(e?.message || e) }, extra);
      }
    }

    // -----------------------
    // /api/voice -> STT JSON (mode=stt) OR Guard -> Upstream -> SSE (TEXT DELTAS)
    // -----------------------
    if (isVoice) {
      const mode = String(url.searchParams.get("mode") || "stt").toLowerCase();
      const ct = (request.headers.get("content-type") || "").toLowerCase();

      let audioU8 = null;
      let priorMessages = [];
      let metaSafe = {};

      if (ct.includes("application/json")) {
        const raw = await request.text().catch(() => "");
        if (!raw || raw.length > MAX_BODY_CHARS) return json(413, { error: "Request too large" }, baseExtra);

        let body;
        try { body = JSON.parse(raw); } catch { return json(400, { error: "Invalid JSON" }, baseExtra); }

        priorMessages = normalizeMessages(body.messages);
        metaSafe = sanitizeMeta(body.meta);

        if (typeof body.audio_b64 === "string" && body.audio_b64.length) {
          const bytes = base64ToBytes(body.audio_b64);
          if (bytes.byteLength > MAX_AUDIO_BYTES) return json(413, { error: "Audio too large" }, baseExtra);
          audioU8 = bytes;
        } else if (Array.isArray(body.audio) && body.audio.length) {
          if (body.audio.length > MAX_AUDIO_BYTES) return json(413, { error: "Audio too large" }, baseExtra);
          const u8 = new Uint8Array(body.audio.length);
          for (let i = 0; i < body.audio.length; i++) u8[i] = Number(body.audio[i]) & 255;
          audioU8 = u8;
        } else {
          return json(400, { error: "Missing audio (audio_b64 or audio[])" }, baseExtra);
        }
      } else {
        const buf = await request.arrayBuffer().catch(() => null);
        if (!buf || buf.byteLength < 16) return json(400, { error: "Empty audio" }, baseExtra);
        if (buf.byteLength > MAX_AUDIO_BYTES) return json(413, { error: "Audio too large" }, baseExtra);
        audioU8 = new Uint8Array(buf);
      }

      // Whisper STT
      let sttOut;
      try { sttOut = await runWhisper(env, audioU8); }
      catch (e) { return json(502, { error: "Whisper unavailable", detail: String(e?.message || e) }, baseExtra); }

      const transcriptRaw = sttOut?.text || sttOut?.result?.text || sttOut?.response?.text || "";
      const transcript = sanitizeContent(transcriptRaw);
      if (!transcript) return json(400, { error: "No transcription produced" }, baseExtra);
      if (looksMalicious(transcript)) return json(403, { error: "Blocked by security sanitizer" }, baseExtra);

      // Detect STT language
      const langIso2 = await detectLangIso2(env, [{ role: "user", content: transcript }], metaSafe);

      const extra = new Headers(baseExtra);
      extra.set("x-gabo-stt-iso2", langIso2 || "und");
      extra.set("x-gabo-voice-timeout-sec", "120");

      if (mode === "stt") {
        return json(200, { transcript, lang_iso2: langIso2 || "und", voice_timeout_sec: 120 }, extra);
      }

      const messages = priorMessages.length
        ? [...priorMessages, { role: "user", content: transcript }]
        : [{ role: "user", content: transcript }];

      if (!metaSafe.lang_iso2 || metaSafe.lang_iso2 === "auto" || metaSafe.lang_iso2 === "und") {
        metaSafe.lang_iso2 = langIso2 || "und";
      }

      // Guard at edge
      let guardRes;
      try { guardRes = await env.AI.run(MODEL_GUARD, { messages }); }
      catch { return json(502, { error: "Safety check unavailable" }, extra); }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) return json(403, { error: "Blocked by safety filter", categories: verdict.categories }, extra);

      // Call Upstream
      let upstreamResp;
      try { upstreamResp = await callUpstream(env, { messages, meta: metaSafe }); }
      catch (e) { return json(502, { error: "Upstream unreachable", detail: String(e?.message || e) }, extra); }

      if (!upstreamResp.ok) {
        const t = await upstreamResp.text().catch(() => "");
        return json(502, { error: "Upstream error", status: upstreamResp.status, detail: t.slice(0, 2000) }, extra);
      }

      forwardUpstreamHeaders(extra, upstreamResp);
      return sse(bridgeUpstreamToSSE(upstreamResp.body), extra);
    }

    return json(500, { error: "Unhandled route" }, baseExtra);
  },
};
