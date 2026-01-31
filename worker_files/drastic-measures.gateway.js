/**
 * src/index.js — drastic-measures — GATEWAY (Brain via Service Binding)
 *
 * Author: Gabriel Anangono
 *
 * + ASSET-ID ENFORCED (Origin -> AssetID)
 * + Clean/scan/sanitize BEFORE Guard + Brain
 * + Guard at Edge
 * + Calls Brain ONLY via service binding (env.BRAIN)
 * + Forwards Brain headers (x-gabo-*)
 * + Converts Brain streaming (raw JSON OR SSE) -> SSE text deltas (UI-friendly)
 *
 * Voice:
 * - /api/voice?mode=stt  -> JSON transcript
 * - /api/voice?mode=chat -> STT then Guard -> Brain -> SSE
 *
 * IMPORTANT (STT):
 * - whisper-large-v3-turbo requires: { audio: "<base64 string>" }
 * - fallback whisper supports array/binary (used only when turbo fails and audio is small)
 */

// -------------------------
// Allowed Origins + Asset IDs (Origin -> AssetID)
// -------------------------
const ORIGIN_ASSET_ID = new Map([
  // gabos.io
  [
    "https://www.gabos.io",
    "b91f605b23748de5cf02db0de2dd59117b31c709986a3c72837d0af8756473cf2779c206fc6ef80a57fdeddefa4ea11b972572f3a8edd9ed77900f9385e94bd6",
  ],

  // GitHub Pages host
  [
    "https://chattiavato-a11y.github.io",
    "b8f12ffa3559cee4ac71cb5f54eba1aed46394027f52e562d20be7a523db2a036f20c6e8fb0577c0a8d58f2fd198046230ebc0a73f4f1e71ff7c377d656f0756",
  ],

  // Worker domain (optional UI host)
  [
    "https://drastic-measures.rulathemtodos.workers.dev",
    "96dd27ea493d045ed9b46d72533e2ed2ec897668e2227dd3d79fff85ca2216a569c4bf622790c6fb0aab9f17b4e92d0f8e0fa040356bee68a9c3d50d5a60c945",
  ],
]);

const ALLOWED_ORIGINS = new Set(Array.from(ORIGIN_ASSET_ID.keys()));

// -------------------------
// Hop header parity (MUST match Brain)
// -------------------------
const HOP_HDR = "x-gabo-hop";
const HOP_VAL = "gateway";

// -------------------------
// Identity + disclosure policy
// -------------------------
const AUTHOR_NAME = "Gabriel Anangono";

// If asked about exact model identifiers/config, we do NOT disclose.
function wantsModelDisclosure(text) {
  const t = String(text || "").toLowerCase();
  const needles = [
    "what model",
    "which model",
    "model are you",
    "model do you use",
    "what llm",
    "which llm",
    "what ai model",
    "which ai model",
    "what models are used",
    "tell me the model",
    "@cf/",
    "llama-",
    "gpt-",
    "gemini",
    "claude",
    "mistral",
    "whisper-",
    "deepgram",
    "bge-",
  ];
  return needles.some((n) => t.includes(n));
}

function wantsAuthorDisclosure(text) {
  const t = String(text || "").toLowerCase();
  const needles = [
    "who created you",
    "who made you",
    "who built you",
    "who is your author",
    "who is the author",
    "who is your creator",
    "creator",
    "author",
    "desarrollador",
    "creador",
    "quién te creó",
    "quien te creo",
    "quién te hizo",
    "hecho por",
    "creado por",
  ];
  return needles.some((n) => t.includes(n));
}

// Redact internal model IDs if they ever appear (defense in depth).
function redactInternalModelIds(text) {
  let t = String(text || "");
  t = t.replace(/@cf\/[a-z0-9._-]+\/[a-z0-9._-]+/gi, "[model withheld]");
  t = t.replace(/\/ai\/run\/@cf\/[a-z0-9._-]+\/[a-z0-9._-]+/gi, "/ai/run/[model withheld]");
  return t;
}

function stripAuthorUnlessAllowed(text, allowAuthor) {
  let t = String(text || "");
  if (allowAuthor) return t;
  const re = new RegExp(AUTHOR_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  t = t.replace(re, "").replace(/\s{2,}/g, " ").trim();
  return t;
}

function postProcessOutgoingText(text, allowAuthor) {
  let t = String(text || "");
  t = redactInternalModelIds(t);
  t = stripAuthorUnlessAllowed(t, allowAuthor);
  return t;
}

// -------------------------
// Models (INTERNAL; never disclose identifiers in chat responses)
// -------------------------
const MODEL_GUARD = "@cf/meta/llama-guard-3-8b";

const MODEL_STT_TURBO = "@cf/openai/whisper-large-v3-turbo";
const MODEL_STT_FALLBACK = "@cf/openai/whisper";

const TTS_EN = "@cf/deepgram/aura-2-en";
const TTS_ES = "@cf/deepgram/aura-2-es";
const TTS_FALLBACK = "@cf/myshell-ai/melotts";

const MODEL_CHAT_FAST = "@cf/meta/llama-3.2-3b-instruct";

// Optional hooks (kept for parity)
const MODEL_TRANSLATE = "@cf/meta/m2m100-1.2b";
const MODEL_EMBED = "@cf/baai/bge-m3";

// -------------------------
// Limits
// -------------------------
const MAX_BODY_CHARS = 8_000;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 1_000;

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_VOICE_JSON_AUDIO_B64_CHARS = 2_500_000; // safety cap for JSON audio_b64

// -------------------------
// Security headers
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
  h.set("x-accel-buffering", "no");
  securityHeaders().forEach((v, k) => h.set(k, v));
  return new Response(stream, { status: 200, headers: h });
}

function sseDataFrame(text) {
  const s = String(text ?? "");
  const lines = s.split("\n");
  let out = "";
  for (const line of lines) out += "data:" + line + "\n";
  out += "\n";
  return out;
}

function oneShotSSE(messageText) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": ok\n\n"));
      controller.enqueue(encoder.encode(sseDataFrame(messageText)));
      controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
      controller.close();
    },
  });
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

  t = t.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  t = t.replace(/<\s*(iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, "");
  t = t.replace(/<\s*\/\s*(iframe|object|embed|link|meta|base|form)\s*>/gi, "");

  t = t.replace(/\bjavascript\s*:/gi, "");
  t = t.replace(/\bvbscript\s*:/gi, "");
  t = t.replace(/\bdata\s*:\s*text\/html\b/gi, "");

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
// Language detect (heuristic + model fallback)
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

  if (/[ñáéíóúü¿¡]/i.test(t)) return "es";
  const esHits = [
    "hola","gracias","por favor","buenos","buenas","necesito","ayuda","quiero","donde","qué","cuánto","porque",
  ].filter((w) => t.includes(w)).length;
  if (esHits >= 2) return "es";

  if (/[ãõç]/i.test(t)) return "pt";
  const ptHits = ["olá","ola","obrigado","obrigada","por favor","você","vocês","não","nao","tudo bem"]
    .filter((w) => t.includes(w)).length;
  if (ptHits >= 2) return "pt";

  const frHits = ["bonjour","salut","merci","s'il","s’il","vous","au revoir","ça va","comment","aujourd"]
    .filter((w) => t.includes(w)).length;
  if (frHits >= 2 || /[àâçéèêëîïôûùüÿœ]/i.test(t)) return "fr";

  if (/[äöüß]/i.test(t)) return "de";
  const deHits = ["hallo","danke","bitte","und","ich","nicht","wie geht","heute"]
    .filter((w) => t.includes(w)).length;
  if (deHits >= 2) return "de";

  const itHits = ["ciao","grazie","per favore","come va","oggi","buongiorno","buonasera"]
    .filter((w) => t.includes(w)).length;
  if (itHits >= 2) return "it";

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
  const metaLang = normalizeIso2(metaSafe?.lang_iso2 || "");
  if (metaLang && metaLang !== "und" && metaLang !== "auto") return metaLang;

  const lastUser = lastUserText(messages);
  const heur = detectLangIso2Heuristic(lastUser);
  if (heur) return heur;

  const modelGuess = await detectLangIso2ViaModel(env, lastUser);
  if (modelGuess && modelGuess !== "und") return modelGuess;

  return "und";
}

// -------------------------
// Guard parsing + meta sanitize
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
  const meta = metaIn && typeof metaIn === "object" ? metaIn : {};
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
// Base64 helpers
// -------------------------
function bytesToBase64(u8) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < u8.length; i += chunk) {
    const sub = u8.subarray(i, i + chunk);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 255;
  return u8;
}

// -------------------------
// Voice STT (FIXED)
// -------------------------
async function runSTT(env, audioU8, audioB64Maybe) {
  const audio_b64 =
    (typeof audioB64Maybe === "string" && audioB64Maybe.length >= 16)
      ? audioB64Maybe
      : bytesToBase64(audioU8);

  // Primary: turbo wants base64 string
  try {
    return await env.AI.run(MODEL_STT_TURBO, { audio: audio_b64 });
  } catch (eTurbo) {
    // Fallback: whisper supports array/binary; only for small payloads
    try {
      if (audioU8.byteLength <= 1_500_000) {
        return await env.AI.run(MODEL_STT_FALLBACK, { audio: Array.from(audioU8) });
      }
    } catch (eFallback) {
      const msg = String(eFallback?.message || eFallback || eTurbo?.message || eTurbo);
      throw new Error(msg);
    }

    const msg = String(eTurbo?.message || eTurbo);
    throw new Error(msg);
  }
}

// -------------------------
// Brain call (SERVICE BINDING) — FIXED (forward Origin + asset id)
// -------------------------
function requireBrain(env) {
  if (!env?.BRAIN || typeof env.BRAIN.fetch !== "function") {
    throw new Error("Missing service binding (env.BRAIN). If your binding is named 'brain', change code to env.brain.");
  }
  return env.BRAIN;
}

async function callBrainChat(env, payload, origin, assetId) {
  const brain = requireBrain(env);

  // Brain enforces Origin allowlist + asset-id. Service binding calls don't include Origin by default.
  const safeOrigin = String(origin || "").trim() || "https://drastic-measures.rulathemtodos.workers.dev";
  const safeAssetId = String(assetId || "").trim();

  return brain.fetch("https://brain/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      [HOP_HDR]: HOP_VAL,

      // Forward identity so Brain doesn't see "(none)"
      Origin: safeOrigin,
      "x-ops-asset-id": safeAssetId,
    },
    body: JSON.stringify(payload),
  });
}

function forwardBrainHeaders(outHeaders, brainResp) {
  const pass = ["x-gabo-lang-iso2", "x-gabo-model", "x-gabo-translated", "x-gabo-embeddings"];
  for (const k of pass) {
    const v = brainResp.headers.get(k);
    if (v) outHeaders.set(k, v);
  }
}

// -------------------------
// Brain stream -> SSE text deltas
// -------------------------
function extractJsonObjectsFromBuffer(buffer) {
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
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
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
    if (line.startsWith("data:")) dataLines.push(line.slice(5));
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

function bridgeBrainToSSE(brainBody, allowAuthor) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  if (!brainBody) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseDataFrame("")));
        controller.close();
      },
    });
  }

  return new ReadableStream({
    async start(controller) {
      const reader = brainBody.getReader();
      let buf = "";

      try {
        controller.enqueue(encoder.encode(": ok\n\n"));

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buf += decoder.decode(value, { stream: true });
          buf = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

          const looksLikeSSE = /(^|\n)data:/.test(buf) && buf.includes("\n\n");
          if (looksLikeSSE) {
            const { blocks, rest } = extractSSEBlocks(buf);
            buf = rest;

            for (const block of blocks) {
              const { data } = parseSSEBlockToData(block);
              const dataTrim = String(data || "").trim();

              if (dataTrim === "[DONE]") {
                controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
                controller.close();
                return;
              }

              const d0 = dataTrim[0];
              if (d0 === "{" || d0 === "[") {
                try {
                  const obj = JSON.parse(dataTrim);
                  const delta = getDeltaFromObj(obj);
                  const out = postProcessOutgoingText(delta, allowAuthor);
                  if (out) controller.enqueue(encoder.encode(sseDataFrame(out)));
                } catch {
                  const out = postProcessOutgoingText(String(data || ""), allowAuthor);
                  if (out) controller.enqueue(encoder.encode(sseDataFrame(out)));
                }
              } else {
                const out = postProcessOutgoingText(String(data || ""), allowAuthor);
                if (out) controller.enqueue(encoder.encode(sseDataFrame(out)));
              }
            }
            continue;
          }

          if (buf.length > 1_000_000 && !buf.includes("{")) buf = buf.slice(-100_000);

          const { chunks, rest } = extractJsonObjectsFromBuffer(buf);
          buf = rest;

          for (const s of chunks) {
            let obj;
            try { obj = JSON.parse(s); } catch { continue; }
            const delta = getDeltaFromObj(obj);
            const out = postProcessOutgoingText(delta, allowAuthor);
            if (out) controller.enqueue(encoder.encode(sseDataFrame(out)));
          }
        }

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
      brain_call: "service_binding: env.BRAIN",
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
      body_binary: "audio/webm (or wav/mp3/etc) OR multipart/form-data(audio=file) OR small JSON {audio_b64|audio[]}",
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

    if (!isChat && !isVoice && !isTts) {
      return json(404, { error: "Not found" }, corsHeaders(origin));
    }

    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed" }, corsHeaders(origin));
    }

    if (!isAllowedOrigin(origin)) {
      return json(
        403,
        { error: "Origin not allowed", saw_origin: origin || "(none)", allowed: Array.from(ALLOWED_ORIGINS) },
        corsHeaders(origin)
      );
    }

    if (!env?.AI || typeof env.AI.run !== "function") {
      return json(500, { error: "Missing AI binding (env.AI)" }, corsHeaders(origin));
    }

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

    const baseExtra = corsHeaders(origin);
    baseExtra.set("x-gabo-asset-verified", "1");

    // -----------------------
    // /api/chat
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

      const lastUser = lastUserText(messages);
      const allowAuthor = wantsAuthorDisclosure(lastUser);

      // Model non-disclosure rule
      if (wantsModelDisclosure(lastUser)) {
        const msg =
          `I can’t disclose the specific model identifiers or configuration.\n`
          + `This assistant was created by ${AUTHOR_NAME}.\n`
          + `It uses a mix of AI systems from multiple providers (for example, companies like Meta and Google), but exact model IDs are intentionally withheld.`;
        return sse(oneShotSSE(msg), baseExtra);
      }

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

      // Call Brain (FIXED: forward Origin + asset-id)
      let brainResp;
      try { brainResp = await callBrainChat(env, { messages, meta: metaSafe }, origin, assetCheck.got); }
      catch (e) { return json(502, { error: "Brain unreachable", detail: String(e?.message || e) }, baseExtra); }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return json(502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, baseExtra);
      }

      const extra = new Headers(baseExtra);
      forwardBrainHeaders(extra, brainResp);

      return sse(bridgeBrainToSSE(brainResp.body, allowAuthor), extra);
    }

    // -----------------------
    // /api/tts
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
    // /api/voice
    // -----------------------
    if (isVoice) {
      const mode = String(url.searchParams.get("mode") || "stt").toLowerCase();
      const ct = (request.headers.get("content-type") || "").toLowerCase();

      let audioU8 = null;
      let audioB64 = "";
      let priorMessages = [];
      let metaSafe = {};

      // JSON (small only)
      if (ct.includes("application/json")) {
        const raw = await request.text().catch(() => "");
        if (!raw) return json(400, { error: "Empty JSON body" }, baseExtra);

        let body;
        try { body = JSON.parse(raw); } catch { return json(400, { error: "Invalid JSON" }, baseExtra); }

        priorMessages = normalizeMessages(body.messages);
        metaSafe = sanitizeMeta(body.meta);

        if (typeof body.audio_b64 === "string" && body.audio_b64.length) {
          if (body.audio_b64.length > MAX_VOICE_JSON_AUDIO_B64_CHARS) {
            return json(413, { error: "audio_b64 too large; send binary audio instead" }, baseExtra);
          }
          audioB64 = body.audio_b64;
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
      }
      // multipart/form-data
      else if (ct.includes("multipart/form-data")) {
        let fd;
        try { fd = await request.formData(); }
        catch { return json(400, { error: "Invalid multipart/form-data" }, baseExtra); }

        const file = fd.get("audio") || fd.get("file") || fd.get("blob");
        if (!file || typeof file === "string") {
          return json(400, { error: "Missing audio file field (expected: audio|file|blob)" }, baseExtra);
        }

        const ab = await file.arrayBuffer().catch(() => null);
        if (!ab || ab.byteLength < 16) return json(400, { error: "Empty audio" }, baseExtra);
        if (ab.byteLength > MAX_AUDIO_BYTES) return json(413, { error: "Audio too large" }, baseExtra);
        audioU8 = new Uint8Array(ab);
      }
      // raw binary
      else {
        const buf = await request.arrayBuffer().catch(() => null);
        if (!buf || buf.byteLength < 16) return json(400, { error: "Empty audio" }, baseExtra);
        if (buf.byteLength > MAX_AUDIO_BYTES) return json(413, { error: "Audio too large" }, baseExtra);
        audioU8 = new Uint8Array(buf);
      }

      // STT
      let sttOut;
      try {
        sttOut = await runSTT(env, audioU8, audioB64);
      } catch (e) {
        return json(502, { error: "Whisper unavailable", detail: String(e?.message || e) }, baseExtra);
      }

      const transcriptRaw = sttOut?.text || sttOut?.result?.text || sttOut?.response?.text || "";
      const transcript = sanitizeContent(transcriptRaw);
      if (!transcript) return json(400, { error: "No transcription produced" }, baseExtra);
      if (looksMalicious(transcript)) return json(403, { error: "Blocked by security sanitizer" }, baseExtra);

      const allowAuthor = wantsAuthorDisclosure(transcript);

      // If user tries to get model IDs via voice, block disclosure
      if (wantsModelDisclosure(transcript)) {
        const msg =
          `I can’t disclose the specific model identifiers or configuration.\n`
          + `This assistant was created by ${AUTHOR_NAME}.\n`
          + `It uses a mix of AI systems from multiple providers (for example, companies like Meta and Google), but exact model IDs are intentionally withheld.`;
        const extraSse = new Headers(baseExtra);
        extraSse.set("x-gabo-voice-timeout-sec", "120");
        return sse(oneShotSSE(msg), extraSse);
      }

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

      // Guard
      let guardRes;
      try { guardRes = await env.AI.run(MODEL_GUARD, { messages }); }
      catch { return json(502, { error: "Safety check unavailable" }, extra); }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) return json(403, { error: "Blocked by safety filter", categories: verdict.categories }, extra);

      // Brain (FIXED: forward Origin + asset-id)
      let brainResp;
      try { brainResp = await callBrainChat(env, { messages, meta: metaSafe }, origin, assetCheck.got); }
      catch (e) { return json(502, { error: "Brain unreachable", detail: String(e?.message || e) }, extra); }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return json(502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, extra);
      }

      forwardBrainHeaders(extra, brainResp);
      return sse(bridgeBrainToSSE(brainResp.body, allowAuthor), extra);
    }

    return json(500, { error: "Unhandled route" }, baseExtra);
  },
};
