/**
 * worker_files/drastic-measures.gateway.js — drastic-measures — GATEWAY (Brain via Service Binding)
 *
 * Author: Gabriel Anangono
 *
 * FIXES:
 * - CORS preflight and ALL error responses include proper CORS headers (when origin is allowed).
 * - Loads config from env.ORIGIN_ASSET_ID_JSON (supports both string JSON and object JSON).
 *
 * Required:
 * - env.AI
 * - env.BRAIN (service binding)
 * - env.DRASTIC_MEASURES (secret)
 * - env.ORIGIN_ASSET_ID_JSON (full worker_files/worker.config.json pasted as JSON)
 */

// -------------------------
// Repo ↔ Worker handshake secret (ONE secret)
// -------------------------
const REPO_SECRET_HEADER = "x-gabo-repo-id";
const REPO_HANDSHAKE_PATH = "/__repo/handshake";

// -------------------------
// Hop header parity (MUST match Brain)
// -------------------------
const HOP_HDR_DEFAULT = "x-gabo-hop";
const HOP_VAL_DEFAULT = "gateway";

// -------------------------
// Honeypots (headers + form/json fields)
// -------------------------
const HONEYPOT_HDR = "x-gabo-honeypot";
const HONEYPOT_PRE_HDR = "x-gabo-honeypot-pre";
const HONEYPOT_FIELDS = ["contact", "website", "contact-field", "website-field", "hp", "honeypot", "trap"];

// -------------------------
// Identity + disclosure policy
// -------------------------
const AUTHOR_NAME = "Gabriel Anangono";

function wantsModelDisclosure(text) {
  const t = String(text || "").toLowerCase();
  const needles = [
    "what model","which model","model are you","model do you use","what llm","which llm","what ai model","which ai model",
    "tell me the model","@cf/","llama-","gpt-","gemini","claude","mistral","whisper-","deepgram","bge-",
  ];
  return needles.some((n) => t.includes(n));
}

function wantsAuthorDisclosure(text) {
  const t = String(text || "").toLowerCase();
  const needles = [
    "who created you","who made you","who built you","who is your author","who is the author","who is your creator",
    "creator","author","desarrollador","creador","quién te creó","quien te creo","quién te hizo","hecho por","creado por",
  ];
  return needles.some((n) => t.includes(n));
}

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
const MODEL_CHAT_FAST = "@cf/meta/llama-3.2-3b-instruct";

const MODEL_STT_TURBO = "@cf/openai/whisper-large-v3-turbo";
const MODEL_STT_FALLBACK = "@cf/openai/whisper";

const TTS_EN = "@cf/deepgram/aura-2-en";
const TTS_ES = "@cf/deepgram/aura-2-es";
const TTS_FALLBACK = "@cf/myshell-ai/melotts";
const MAX_VOICE_JSON_AUDIO_B64_CHARS = 16 * 1024 * 1024;

// -------------------------
// Config loader (env.ORIGIN_ASSET_ID_JSON is full worker.config.json)
// -------------------------
let _CFG = null;

function toStr(x) { return typeof x === "string" ? x : x == null ? "" : String(x); }

function safeTextOnly(s) {
  s = toStr(s);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue;
    const ok = c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160;
    if (ok) out += s[i];
  }
  return out.trim();
}

function normalizeOrigin(value) {
  const v = toStr(value).trim();
  if (!v) return "";
  try { return new URL(v).origin.toLowerCase(); }
  catch { return v.replace(/\/$/, "").toLowerCase(); }
}

function normalizeRoutePath(value, fallback) {
  const raw = safeTextOnly(value || fallback || "");
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function readConfigVar(env) {
  const v = env?.ORIGIN_ASSET_ID_JSON;
  if (!v) return null;
  // Cloudflare may supply JSON vars as object OR string.
  if (typeof v === "object") return v;
  try { return JSON.parse(String(v)); } catch { return null; }
}

function buildConfig(env) {
  if (_CFG) return _CFG;

  const rawCfg = readConfigVar(env);
  const cfg = (rawCfg && typeof rawCfg === "object") ? rawCfg : {};

  // Core pieces
  const routes = {
    chat: normalizeRoutePath(cfg?.routes?.chat, "/api/chat"),
    voice: normalizeRoutePath(cfg?.routes?.voice, "/api/voice"),
    tts: normalizeRoutePath(cfg?.routes?.tts, "/api/tts"),
    health: normalizeRoutePath(cfg?.routes?.health, "/health"),
    handshake: normalizeRoutePath(cfg?.actions_handshake?.path, REPO_HANDSHAKE_PATH),
  };

  const limits = {
    max_body_chars: Number(cfg?.limits?.max_body_chars || 8000),
    max_messages: Number(cfg?.limits?.max_messages || 30),
    max_message_chars: Number(cfg?.limits?.max_message_chars || 1000),
    max_audio_bytes: Number(cfg?.limits?.max_audio_bytes || (12 * 1024 * 1024)),
  };

  const timeouts = { voice_timeout_sec: Number(cfg?.timeouts?.voice_timeout_sec || 120) };

  const assetHeader = safeTextOnly(cfg?.asset_identity?.header_name || "x-ops-asset-id").toLowerCase();
  const integrityHeader = safeTextOnly(cfg?.headers?.optional_integrity_header || "x-ops-src-sha512-b64").toLowerCase();

  const hopHeaderName = safeTextOnly(cfg?.headers?.hop_header_name || HOP_HDR_DEFAULT).toLowerCase();
  const hopHeaderValue = safeTextOnly(cfg?.headers?.hop_header_value || HOP_VAL_DEFAULT);

  // Origin -> AssetId map
  const originAssetMap = {};
  const m = cfg?.asset_identity?.origin_to_asset_id && typeof cfg.asset_identity.origin_to_asset_id === "object"
    ? cfg.asset_identity.origin_to_asset_id
    : {};
  for (const [k, v] of Object.entries(m)) {
    const o = normalizeOrigin(k);
    const id = safeTextOnly(v);
    if (o && id) originAssetMap[o] = id;
  }

  // Allowed origins
  const allowedOriginsArr = Array.isArray(cfg?.allowedOrigins) && cfg.allowedOrigins.length
    ? cfg.allowedOrigins
    : Object.keys(originAssetMap);
  const allowedOrigins = new Set(allowedOriginsArr.map(normalizeOrigin).filter(Boolean));

  // CORS
  const cors = {
    allow_methods: safeTextOnly(cfg?.cors?.allow_methods || "GET, POST, OPTIONS"),
    allow_headers: Array.isArray(cfg?.cors?.allow_headers) ? cfg.cors.allow_headers.map((h) => safeTextOnly(h).toLowerCase()).filter(Boolean) : [],
    expose_headers: Array.isArray(cfg?.cors?.expose_headers) ? cfg.cors.expose_headers.map((h) => safeTextOnly(h).toLowerCase()).filter(Boolean) : [],
    max_age_sec: Number(cfg?.cors?.max_age_sec || 86400),
  };

  // Security headers (use repo config if present)
  const sec = cfg?.security_headers && typeof cfg.security_headers === "object" ? cfg.security_headers : {};

  _CFG = {
    routes,
    limits,
    timeouts,
    assetHeader,
    integrityHeader,
    hopHeaderName,
    hopHeaderValue,
    originAssetMap,
    allowedOrigins,
    cors,
    security_headers: sec,
  };

  return _CFG;
}

// -------------------------
// Security headers (API-safe, from config when present)
// -------------------------
function securityHeaders(cfg) {
  const h = new Headers();
  const sec = cfg?.security_headers || {};

  h.set("X-Content-Type-Options", sec.x_content_type_options || "nosniff");
  h.set("X-Frame-Options", sec.x_frame_options || "DENY");
  h.set("Referrer-Policy", sec.referrer_policy || "strict-origin-when-cross-origin");
  h.set("Strict-Transport-Security", sec.strict_transport_security || "max-age=31536000; includeSubDomains; preload");

  // API hardening
  h.set("Cache-Control", "no-store, no-transform");
  h.set("X-Permitted-Cross-Domain-Policies", "none");
  h.set("X-DNS-Prefetch-Control", "off");
  h.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");

  // Keep CSP strict for API responses
  h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");

  // Your repo config sets CORP same-site for pages; for API we keep cross-origin to allow worker_files fetches
  h.set("Cross-Origin-Resource-Policy", "cross-origin");
  h.set("Cross-Origin-Opener-Policy", "same-origin");

  return h;
}

// -------------------------
// CORS helpers (FIXED)
// - Preflight echoes request headers if present, else uses cfg.cors.allow_headers
// - For allowed origins, EVERY response includes Access-Control-Allow-Origin so browser can read errors
// -------------------------
function isAllowedOrigin(cfg, origin) {
  const o = normalizeOrigin(origin);
  if (!o || o === "null") return false;
  // Fail-open only when config is missing/empty to avoid CORS hard-lock during misconfiguration.
  if (!cfg.allowedOrigins || cfg.allowedOrigins.size === 0) return true;
  return cfg.allowedOrigins.has(o);
}

function corsHeadersForResponse(cfg, origin) {
  const h = new Headers();
  const o = normalizeOrigin(origin);
  if (isAllowedOrigin(cfg, o)) {
    h.set("Access-Control-Allow-Origin", o);
    h.set("Vary", "Origin");
  }
  if (cfg.cors.expose_headers.length) h.set("Access-Control-Expose-Headers", cfg.cors.expose_headers.join(", "));
  return h;
}

function corsHeadersForPreflight(cfg, request, origin) {
  const h = new Headers();
  const o = normalizeOrigin(origin);

  if (isAllowedOrigin(cfg, o)) {
    h.set("Access-Control-Allow-Origin", o);
    h.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  }

  h.set("Access-Control-Allow-Methods", cfg.cors.allow_methods || "GET, POST, OPTIONS");

  const reqHdrs = request.headers.get("Access-Control-Request-Headers");
  if (reqHdrs && String(reqHdrs).trim()) {
    // Echo requested headers to avoid preflight mismatch failures
    h.set("Access-Control-Allow-Headers", String(reqHdrs));
  } else if (cfg.cors.allow_headers.length) {
    h.set("Access-Control-Allow-Headers", cfg.cors.allow_headers.join(", "));
  }

  h.set("Access-Control-Max-Age", String(cfg.cors.max_age_sec || 86400));
  if (cfg.cors.expose_headers.length) h.set("Access-Control-Expose-Headers", cfg.cors.expose_headers.join(", "));
  return h;
}

// -------------------------
// Response helpers (ALWAYS include CORS+security when origin is allowed)
// -------------------------
function json(cfg, origin, status, obj, extra) {
  const h = new Headers(extra || {});
  corsHeadersForResponse(cfg, origin).forEach((v, k) => h.set(k, v));
  securityHeaders(cfg).forEach((v, k) => h.set(k, v));
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(obj), { status, headers: h });
}

function sse(cfg, origin, stream, extra) {
  const h = new Headers(extra || {});
  corsHeadersForResponse(cfg, origin).forEach((v, k) => h.set(k, v));
  securityHeaders(cfg).forEach((v, k) => h.set(k, v));
  h.set("content-type", "text/event-stream; charset=utf-8");
  h.set("cache-control", "no-cache, no-transform");
  h.set("x-accel-buffering", "no");
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
// TinyML Guard (edge sanitize + code-like blocker)
// -------------------------
const TINYML_PATTERNS = [
  { id: "script_tag", re: /<\s*script\b/i, w: 8 },
  { id: "style_tag", re: /<\s*style\b/i, w: 5 },
  { id: "iframe_tag", re: /<\s*iframe\b/i, w: 7 },
  { id: "object_embed", re: /<\s*(object|embed)\b/i, w: 7 },
  { id: "svg_mathml", re: /<\s*(svg|math)\b/i, w: 6 },
  { id: "event_handler", re: /\bon\w+\s*=/i, w: 6 },
  { id: "js_scheme", re: /\bjavascript\s*:/i, w: 7 },
  { id: "vb_scheme", re: /\bvbscript\s*:/i, w: 7 },
  { id: "data_html", re: /\bdata\s*:\s*text\/html\b/i, w: 7 },
  { id: "document_cookie", re: /\bdocument\.cookie\b/i, w: 7 },
  { id: "document_write", re: /\bdocument\.write\b/i, w: 6 },
  { id: "eval", re: /\beval\s*\(/i, w: 7 },
  { id: "new_function", re: /\bnew\s+Function\b/i, w: 7 },
  { id: "settimeout_string", re: /\bsetTimeout\s*\(\s*["'`]/i, w: 6 },
  { id: "setinterval_string", re: /\bsetInterval\s*\(\s*["'`]/i, w: 6 },
  { id: "import_export", re: /\b(import|export)\b/i, w: 2 },
  { id: "fn_tokens", re: /\b(function|class|const|let|var|return|async|await)\b/i, w: 2 },
  { id: "base64_blob", re: /\b[A-Za-z0-9+/]{200,}={0,2}\b/, w: 3 },
];

function clampText(text, maxChars) {
  let t = toStr(text);
  t = t.replace(/\u0000/g, "");
  t = t.replace(/\r\n?/g, "\n");
  const lim = Number(maxChars || 0);
  if (lim > 0 && t.length > lim) t = t.slice(0, lim);
  return t;
}

function collapseWhitespace(text) {
  return toStr(text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function stripDangerousMarkup(text) {
  let t = clampText(text, 4000);
  t = t.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ");
  t = t.replace(/<\s*(iframe|object|embed|link|meta|base|form|svg|math)\b[^>]*>/gi, " ");
  t = t.replace(/<\s*\/\s*(iframe|object|embed|link|meta|base|form|svg|math)\s*>/gi, " ");
  t = t.replace(/\bon\w+\s*=\s*["'][\s\S]*?["']/gi, " ");
  t = t.replace(/\bon\w+\s*=\s*[^\s>]+/gi, " ");
  t = t.replace(/\bjavascript\s*:/gi, "");
  t = t.replace(/\bvbscript\s*:/gi, "");
  t = t.replace(/\bdata\s*:\s*text\/html\b/gi, "");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  return collapseWhitespace(t);
}

function stripCodeBlocks(text) {
  let t = toStr(text);
  t = t.replace(/```[\s\S]*?```/g, " [REMOVED_CODE_BLOCK] ");
  t = t.replace(/~~~[\s\S]*?~~~/g, " [REMOVED_CODE_BLOCK] ");
  t = t.replace(/`[^`]{1,200}`/g, " [REMOVED_INLINE_CODE] ");
  t = t.replace(/<\s*pre\b[^>]*>[\s\S]*?<\s*\/\s*pre\s*>/gi, " [REMOVED_CODE_BLOCK] ");
  t = t.replace(/<\s*code\b[^>]*>[\s\S]*?<\s*\/\s*code\s*>/gi, " [REMOVED_CODE_BLOCK] ");
  return collapseWhitespace(t);
}

function tinySanitize(text) {
  return stripCodeBlocks(stripDangerousMarkup(clampText(text, 4000)));
}

function tinyScore(text) {
  const s = toStr(text);
  let score = 0;
  const hits = [];
  for (const p of TINYML_PATTERNS) {
    if (p.re.test(s)) { score += p.w; hits.push(p.id); }
  }
  if (s.length > 600) score += 1;
  if (s.length > 1200) score += 1;
  return { score, hits };
}

function tinyEvaluate(text, mode) {
  const m = String(mode || "strict").toLowerCase() === "clean" ? "clean" : "strict";
  const sanitized = tinySanitize(text);
  const before = tinyScore(text);
  const after = tinyScore(sanitized);
  const highRisk = after.score >= 9 || before.score >= 12;
  const strictCodeLike = (after.hits.includes("import_export") || after.hits.includes("fn_tokens")) && after.score >= 6;
  const blocked = highRisk || (m === "strict" && strictCodeLike);
  return { ok: !blocked, mode: m, sanitized, risk: { before, after }, reason: blocked ? "tinyml_block" : "ok" };
}

// -------------------------
// Crypto helpers (integrity)
// -------------------------
function base64EncodeBytes(u8) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) bin += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(bin);
}

async function sha512Base64(text) {
  const t = toStr(text);
  if (!t || !crypto?.subtle) return "";
  const bytes = new TextEncoder().encode(t);
  const hash = await crypto.subtle.digest("SHA-512", bytes);
  return base64EncodeBytes(new Uint8Array(hash));
}

function timingSafeEq(a, b) {
  const x = toStr(a);
  const y = toStr(b);
  if (x.length !== y.length) return false;
  let out = 0;
  for (let i = 0; i < x.length; i++) out |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return out === 0;
}

// -------------------------
// Honeypot detection
// -------------------------
function isNonEmpty(value) { return safeTextOnly(value).length > 0; }

function honeypotTriggeredFromHeaders(req) {
  return isNonEmpty(req.headers.get(HONEYPOT_HDR)) || isNonEmpty(req.headers.get(HONEYPOT_PRE_HDR));
}

function honeypotTriggeredFromObject(obj) {
  if (!obj || typeof obj !== "object") return false;
  for (const k of HONEYPOT_FIELDS) if (k in obj && isNonEmpty(obj[k])) return true;
  return false;
}

// -------------------------
// FIX: message content coercion (string OR content-parts)
// -------------------------
function coerceMessageContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    let out = "";
    for (const part of content) {
      if (typeof part === "string") out += part + "\n";
      else if (part && typeof part === "object") {
        if (typeof part.text === "string") out += part.text + "\n";
        else if (typeof part.content === "string") out += part.content + "\n";
        else if (typeof part.value === "string") out += part.value + "\n";
      }
      if (out.length > 2000) break;
    }
    return out.trim();
  }

  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    if (typeof content.value === "string") return content.value;
  }

  return toStr(content);
}

function coerceBodyMessages(body) {
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body.messages)) return body.messages;
  if (body.messages && typeof body.messages === "object") return [body.messages];
  const s = body.message ?? body.prompt ?? body.input;
  if (typeof s === "string" && s.trim()) return [{ role: "user", content: s }];
  return null;
}

function normalizeMessages(cfg, input, tinyMode) {
  if (!Array.isArray(input)) return { ok: false, messages: [], reason: "messages_not_array" };

  const out = [];
  let blocked = null;

  for (const m of input.slice(-cfg.limits.max_messages)) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;

    const raw = coerceMessageContent(m.content);
    const ev = tinyEvaluate(raw, tinyMode);
    if (!ev.ok) blocked = blocked || ev;

    const cleaned = safeTextOnly(ev.sanitized || "");
    if (!cleaned) continue;

    out.push({ role, content: cleaned.slice(0, cfg.limits.max_message_chars) });
  }

  if (blocked && String(tinyMode || "strict").toLowerCase() !== "clean") {
    return { ok: false, messages: [], reason: blocked.reason || "tinyml_block", tinyml: blocked.risk };
  }

  return { ok: true, messages: out };
}

function lastUserText(messages) {
  return [...messages].reverse().find((m) => m.role === "user")?.content || "";
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

function normalizeIso2(code) {
  const s = safeTextOnly(code || "").toLowerCase();
  if (!s) return "";
  const two = s.includes("-") ? s.split("-")[0] : s;
  return (two || "").slice(0, 2);
}

function sanitizeMeta(metaIn) {
  const meta = metaIn && typeof metaIn === "object" ? metaIn : {};
  const out = {};
  const lang = normalizeIso2(meta.lang_iso2 || "");
  if (lang) out.lang_iso2 = lang;
  if (meta.spanish_quality) out.spanish_quality = safeTextOnly(meta.spanish_quality).slice(0, 40);
  if (meta.model) out.model = safeTextOnly(meta.model).slice(0, 40);
  if (meta.translate_to) out.translate_to = safeTextOnly(meta.translate_to).slice(0, 8);
  if (typeof meta.want_embeddings === "boolean") out.want_embeddings = meta.want_embeddings;
  return out;
}

// -------------------------
// Asset identity enforcement
// -------------------------
function verifyAssetIdentity(cfg, origin, request) {
  const o = normalizeOrigin(origin);
  const got =
    safeTextOnly(request.headers.get(cfg.assetHeader) || "") ||
    safeTextOnly(request.headers.get("x-ops-asset-id") || "") ||
    safeTextOnly(request.headers.get("X-Ops-Asset-Id") || "");

  const expected = safeTextOnly(cfg.originAssetMap[o] || "");
  return { ok: !!expected && got === expected, got, expected };
}

// -------------------------
// Repo ↔ Worker handshake verification (ONE secret)
// -------------------------
function verifyRepoSecret(request, env) {
  const expected = String(env?.DRASTIC_MEASURES || "");
  const got = String(request.headers.get(REPO_SECRET_HEADER) || "");
  if (!expected) return { ok: false, reason: "missing_worker_secret" };
  if (!got) return { ok: false, reason: "missing_header" };
  const ok = timingSafeEq(got, expected);
  return ok ? { ok: true } : { ok: false, reason: "bad_secret" };
}

// -------------------------
// Brain call (SERVICE BINDING) — forwards Origin + x-ops-asset-id + hop header
// -------------------------
function requireBrain(env) {
  if (!env?.BRAIN || typeof env.BRAIN.fetch !== "function") throw new Error("Missing service binding (env.BRAIN).");
  return env.BRAIN;
}

async function callBrainChat(cfg, env, payload, origin, assetId) {
  const brain = requireBrain(env);
  const hopName = cfg.hopHeaderName || HOP_HDR_DEFAULT;
  const hopVal = cfg.hopHeaderValue || HOP_VAL_DEFAULT;

  return brain.fetch("https://brain/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      [hopName]: hopVal,
      Origin: origin,
      "x-ops-asset-id": assetId,
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
  for (const line of lines) if (line && line.startsWith("data:")) dataLines.push(line.slice(5));
  return { data: dataLines.join("\n") };
}

function extractJsonObjectsFromBuffer(buffer) {
  const out = [];
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];

    if (start === -1) {
      if (ch === "{") { start = i; depth = 1; inStr = false; esc = false; }
      continue;
    }

    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }

    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;

    if (depth === 0) {
      out.push(buffer.slice(start, i + 1));
      start = -1;
    }
  }

  const rest = start === -1 ? "" : buffer.slice(start);
  return { chunks: out, rest };
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
// Voice STT helpers
// -------------------------
function base64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 255;
  return u8;
}

async function runSTT(env, audioU8, audioB64Maybe) {
  const audio_b64 = (typeof audioB64Maybe === "string" && audioB64Maybe.length >= 16) ? audioB64Maybe : base64EncodeBytes(audioU8);

  try {
    return await env.AI.run(MODEL_STT_TURBO, { audio: audio_b64 });
  } catch (eTurbo) {
    try {
      if (audioU8.byteLength <= 1_500_000) return await env.AI.run(MODEL_STT_FALLBACK, { audio: Array.from(audioU8) });
    } catch (eFallback) {
      throw new Error(String(eFallback?.message || eFallback || eTurbo?.message || eTurbo));
    }
    throw new Error(String(eTurbo?.message || eTurbo));
  }
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
function usage(cfg, path) {
  if (path === cfg.routes.chat) {
    return {
      ok: true,
      route: cfg.routes.chat,
      method: "POST",
      required_headers: ["content-type", "accept", cfg.assetHeader],
      integrity_header_optional: cfg.integrityHeader,
      allowed_origins: Array.from(cfg.allowedOrigins),
    };
  }
  if (path === cfg.routes.tts) {
    return {
      ok: true,
      route: cfg.routes.tts,
      method: "POST",
      required_headers: ["content-type", "accept", cfg.assetHeader],
      body_json: { text: "Hello", lang_iso2: "en" },
    };
  }
  if (path === cfg.routes.voice) {
    return {
      ok: true,
      route: `${cfg.routes.voice}?mode=stt | ${cfg.routes.voice}?mode=chat`,
      method: "POST",
      required_headers: ["accept", cfg.assetHeader],
      body_binary: "audio/webm OR multipart(audio=file) OR JSON {audio_b64|audio[]}",
    };
  }
  return { ok: true };
}

// -------------------------
// MAIN WORKER
// -------------------------
export default {
  async fetch(request, env) {
    const cfg = buildConfig(env);
    const origin = request.headers.get("Origin") || "";

    // Preflight (FIXED)
    if (request.method === "OPTIONS") {
      const h = corsHeadersForPreflight(cfg, request, origin);
      securityHeaders(cfg).forEach((v, k) => h.set(k, v));
      return new Response(null, { status: 204, headers: h });
    }

    const url = new URL(request.url);

    // Health
    if (url.pathname === "/" || url.pathname === cfg.routes.health) {
      const h = corsHeadersForResponse(cfg, origin);
      securityHeaders(cfg).forEach((v, k) => h.set(k, v));
      return new Response("gateway: ok", { status: 200, headers: h });
    }

    // Repo ↔ Worker handshake (GitHub Actions only; NO Turnstile)
    if (url.pathname === REPO_HANDSHAKE_PATH || url.pathname === cfg.routes.handshake) {
      if (request.method !== "POST") return json(cfg, origin, 405, { ok: false, error: "method_not_allowed" });
      const check = verifyRepoSecret(request, env);
      if (!check.ok) return json(cfg, origin, 403, { ok: false, error: "repo_auth_failed", reason: check.reason });
      return json(cfg, origin, 200, {
        ok: true,
        match: "repo<->worker",
        worker: "drastic-measures",
        brain_binding: typeof env?.BRAIN?.fetch === "function" ? "present" : "missing",
        ai_binding: typeof env?.AI?.run === "function" ? "present" : "missing",
      });
    }

    const isChat = url.pathname === cfg.routes.chat;
    const isVoice = url.pathname === cfg.routes.voice;
    const isTts = url.pathname === cfg.routes.tts;

    // Helpful GET usage
    if (request.method === "GET" && (isChat || isVoice || isTts)) {
      return json(cfg, origin, 200, usage(cfg, url.pathname));
    }

    if (!isChat && !isVoice && !isTts) return json(cfg, origin, 404, { error: "Not found" });
    if (request.method !== "POST") return json(cfg, origin, 405, { error: "Method not allowed" });

    // Must be a known browser origin
    if (!isAllowedOrigin(cfg, origin)) {
      return json(cfg, origin, 403, { error: "Origin not allowed", saw_origin: origin || "(none)", allowed: Array.from(cfg.allowedOrigins) });
    }

    // Honeypot quick-block
    if (honeypotTriggeredFromHeaders(request)) {
      return json(cfg, origin, 403, { error: "Blocked (honeypot)", decision: "block", reason: "honeypot_header" });
    }

    if (!env?.AI || typeof env.AI.run !== "function") {
      return json(cfg, origin, 500, { error: "Missing AI binding (env.AI)" });
    }

    // Asset identity enforced
    const assetCheck = verifyAssetIdentity(cfg, origin, request);
    if (!assetCheck.ok) {
      return json(cfg, origin, 403, {
        error: "Invalid asset identity",
        detail: `${cfg.assetHeader} must match the calling Origin.`,
        origin,
        got_asset_id: assetCheck.got || "(none)",
        expected_asset_id: assetCheck.expected || "(missing mapping)",
      });
    }

    const baseExtra = new Headers();
    baseExtra.set("x-gabo-asset-verified", "1");

    // TinyML mode (optional)
    const tinyMode = safeTextOnly(request.headers.get("x-gabo-tinyml-mode") || "strict").toLowerCase();

    // -----------------------
    // /api/chat
    // -----------------------
    if (isChat) {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        return json(cfg, origin, 415, { error: "content-type must be application/json" }, baseExtra);
      }

      const raw = await request.text().catch(() => "");
      if (!raw) return json(cfg, origin, 400, { error: "Empty body" }, baseExtra);
      if (raw.length > cfg.limits.max_body_chars) return json(cfg, origin, 413, { error: "Request too large" }, baseExtra);

      // Optional integrity verify (if header present)
      const wantIntegrity = safeTextOnly(request.headers.get(cfg.integrityHeader) || "");
      if (wantIntegrity) {
        const got = await sha512Base64(raw);
        if (!got || !timingSafeEq(got, wantIntegrity)) {
          return json(cfg, origin, 400, { error: "Integrity check failed" }, baseExtra);
        }
      }

      let body;
      try { body = JSON.parse(raw); }
      catch { return json(cfg, origin, 400, { error: "Invalid JSON" }, baseExtra); }

      if (honeypotTriggeredFromObject(body)) {
        return json(cfg, origin, 403, { error: "Blocked (honeypot)", decision: "block", reason: "honeypot_body" }, baseExtra);
      }

      const metaSafe = sanitizeMeta(body.meta);
      const msgInput = coerceBodyMessages(body);
      if (!msgInput) {
        return json(cfg, origin, 400, { error: "messages[] required", hint: "Send {messages:[{role:'user',content:'hi'}]} OR {message:'hi'}" }, baseExtra);
      }

      const norm = normalizeMessages(cfg, msgInput, tinyMode);
      if (!norm.ok) {
        return json(cfg, origin, 403, { error: "Blocked by TinyML", decision: "block", reason: norm.reason, tinyml: norm.tinyml }, baseExtra);
      }

      const messages = norm.messages;
      if (!messages.length) return json(cfg, origin, 400, { error: "messages[] required (sanitized empty)" }, baseExtra);

      const lastUser = lastUserText(messages);
      const allowAuthor = wantsAuthorDisclosure(lastUser);

      if (wantsModelDisclosure(lastUser)) {
        const msg =
          `I can’t disclose the specific model identifiers or configuration.\n` +
          `This assistant was created by ${AUTHOR_NAME}.\n` +
          `It uses a mix of AI systems from multiple providers, but exact model IDs are intentionally withheld.`;
        return sse(cfg, origin, oneShotSSE(msg), baseExtra);
      }

      // Guard at edge
      let guardRes;
      try { guardRes = await env.AI.run(MODEL_GUARD, { messages }); }
      catch { return json(cfg, origin, 502, { error: "Safety check unavailable" }, baseExtra); }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) return json(cfg, origin, 403, { error: "Blocked by safety filter", categories: verdict.categories }, baseExtra);

      // Call Brain
      let brainResp;
      try { brainResp = await callBrainChat(cfg, env, { messages, meta: metaSafe }, origin, assetCheck.got); }
      catch (e) { return json(cfg, origin, 502, { error: "Brain unreachable", detail: String(e?.message || e) }, baseExtra); }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return json(cfg, origin, 502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, baseExtra);
      }

      const extra = new Headers(baseExtra);
      forwardBrainHeaders(extra, brainResp);
      return sse(cfg, origin, bridgeBrainToSSE(brainResp.body, allowAuthor), extra);
    }

    // -----------------------
    // /api/tts
    // -----------------------
    if (isTts) {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) return json(cfg, origin, 415, { error: "content-type must be application/json" }, baseExtra);

      const raw = await request.text().catch(() => "");
      if (!raw || raw.length > cfg.limits.max_body_chars) return json(cfg, origin, 413, { error: "Request too large" }, baseExtra);

      const wantIntegrity = safeTextOnly(request.headers.get(cfg.integrityHeader) || "");
      if (wantIntegrity) {
        const got = await sha512Base64(raw);
        if (!got || !timingSafeEq(got, wantIntegrity)) return json(cfg, origin, 400, { error: "Integrity check failed" }, baseExtra);
      }

      let body;
      try { body = JSON.parse(raw); } catch { return json(cfg, origin, 400, { error: "Invalid JSON" }, baseExtra); }

      if (honeypotTriggeredFromObject(body)) return json(cfg, origin, 403, { error: "Blocked (honeypot)" }, baseExtra);

      const ev = tinyEvaluate(body?.text || "", tinyMode);
      if (!ev.ok && tinyMode !== "clean") return json(cfg, origin, 403, { error: "Blocked by TinyML" }, baseExtra);

      const text = safeTextOnly(ev.sanitized || "");
      if (!text) return json(cfg, origin, 400, { error: "text required" }, baseExtra);

      const langIso2 = normalizeIso2(body?.lang_iso2 || "en") || "en";

      const extra = new Headers(baseExtra);
      extra.set("x-gabo-tts-iso2", langIso2);

      try {
        const out = await ttsAny(env, text, langIso2);
        const h = new Headers(extra);
        corsHeadersForResponse(cfg, origin).forEach((v, k) => h.set(k, v));
        securityHeaders(cfg).forEach((v, k) => h.set(k, v));
        h.set("content-type", out.ct || "audio/mpeg");
        return new Response(out.body, { status: 200, headers: h });
      } catch (e) {
        return json(cfg, origin, 502, { error: "TTS unavailable", detail: String(e?.message || e) }, extra);
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

      if (ct.includes("application/json")) {
        const raw = await request.text().catch(() => "");
        if (!raw) return json(cfg, origin, 400, { error: "Empty JSON body" }, baseExtra);

        const wantIntegrity = safeTextOnly(request.headers.get(cfg.integrityHeader) || "");
        if (wantIntegrity) {
          const got = await sha512Base64(raw);
          if (!got || !timingSafeEq(got, wantIntegrity)) return json(cfg, origin, 400, { error: "Integrity check failed" }, baseExtra);
        }

        let body;
        try { body = JSON.parse(raw); } catch { return json(cfg, origin, 400, { error: "Invalid JSON" }, baseExtra); }

        if (honeypotTriggeredFromObject(body)) return json(cfg, origin, 403, { error: "Blocked (honeypot)" }, baseExtra);

        const msgInput = coerceBodyMessages(body);
        if (msgInput) {
          const norm = normalizeMessages(cfg, msgInput, tinyMode);
          if (norm.ok) priorMessages = norm.messages;
        }

        metaSafe = sanitizeMeta(body.meta);

        if (typeof body.audio_b64 === "string" && body.audio_b64.length) {
          if (body.audio_b64.length > MAX_VOICE_JSON_AUDIO_B64_CHARS) return json(cfg, origin, 413, { error: "audio_b64 too large" }, baseExtra);
          audioB64 = body.audio_b64;
          const bytes = base64ToBytes(body.audio_b64);
          if (bytes.byteLength > cfg.limits.max_audio_bytes) return json(cfg, origin, 413, { error: "Audio too large" }, baseExtra);
          audioU8 = bytes;
        } else if (Array.isArray(body.audio) && body.audio.length) {
          if (body.audio.length > cfg.limits.max_audio_bytes) return json(cfg, origin, 413, { error: "Audio too large" }, baseExtra);
          const u8 = new Uint8Array(body.audio.length);
          for (let i = 0; i < body.audio.length; i++) u8[i] = Number(body.audio[i]) & 255;
          audioU8 = u8;
        } else {
          return json(cfg, origin, 400, { error: "Missing audio (audio_b64 or audio[])" }, baseExtra);
        }
      } else if (ct.includes("multipart/form-data")) {
        let fd;
        try { fd = await request.formData(); }
        catch { return json(cfg, origin, 400, { error: "Invalid multipart/form-data" }, baseExtra); }

        for (const k of HONEYPOT_FIELDS) {
          const v = fd.get(k);
          if (typeof v === "string" && isNonEmpty(v)) return json(cfg, origin, 403, { error: "Blocked (honeypot)" }, baseExtra);
        }

        const file = fd.get("audio") || fd.get("file") || fd.get("blob");
        if (!file || typeof file === "string") return json(cfg, origin, 400, { error: "Missing audio file field" }, baseExtra);

        const ab = await file.arrayBuffer().catch(() => null);
        if (!ab || ab.byteLength < 16) return json(cfg, origin, 400, { error: "Empty audio" }, baseExtra);
        if (ab.byteLength > cfg.limits.max_audio_bytes) return json(cfg, origin, 413, { error: "Audio too large" }, baseExtra);
        audioU8 = new Uint8Array(ab);
      } else {
        const buf = await request.arrayBuffer().catch(() => null);
        if (!buf || buf.byteLength < 16) return json(cfg, origin, 400, { error: "Empty audio" }, baseExtra);
        if (buf.byteLength > cfg.limits.max_audio_bytes) return json(cfg, origin, 413, { error: "Audio too large" }, baseExtra);
        audioU8 = new Uint8Array(buf);
      }

      let sttOut;
      try { sttOut = await runSTT(env, audioU8, audioB64); }
      catch (e) { return json(cfg, origin, 502, { error: "Whisper unavailable", detail: String(e?.message || e) }, baseExtra); }

      const transcriptRaw = sttOut?.text || sttOut?.result?.text || sttOut?.response?.text || "";
      const tEv = tinyEvaluate(transcriptRaw, tinyMode);
      if (!tEv.ok && tinyMode !== "clean") return json(cfg, origin, 403, { error: "Blocked by TinyML" }, baseExtra);

      const transcript = safeTextOnly(tEv.sanitized || "");
      if (!transcript) return json(cfg, origin, 400, { error: "No transcription produced" }, baseExtra);

      const extra = new Headers(baseExtra);
      extra.set("x-gabo-stt-iso2", metaSafe.lang_iso2 || "und");
      extra.set("x-gabo-voice-timeout-sec", String(cfg.timeouts.voice_timeout_sec || 120));

      if (mode === "stt") {
        return json(cfg, origin, 200, { transcript, lang_iso2: metaSafe.lang_iso2 || "und", voice_timeout_sec: cfg.timeouts.voice_timeout_sec || 120 }, extra);
      }

      const messages = priorMessages.length
        ? [...priorMessages, { role: "user", content: transcript }]
        : [{ role: "user", content: transcript }];

      let guardRes;
      try { guardRes = await env.AI.run(MODEL_GUARD, { messages }); }
      catch { return json(cfg, origin, 502, { error: "Safety check unavailable" }, extra); }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) return json(cfg, origin, 403, { error: "Blocked by safety filter", categories: verdict.categories }, extra);

      let brainResp;
      try { brainResp = await callBrainChat(cfg, env, { messages, meta: metaSafe }, origin, assetCheck.got); }
      catch (e) { return json(cfg, origin, 502, { error: "Brain unreachable", detail: String(e?.message || e) }, extra); }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return json(cfg, origin, 502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, extra);
      }

      forwardBrainHeaders(extra, brainResp);
      const allowAuthor = wantsAuthorDisclosure(transcript);
      return sse(cfg, origin, bridgeBrainToSSE(brainResp.body, allowAuthor), extra);
    }

    return json(cfg, origin, 500, { error: "Unhandled route" }, baseExtra);
  },
};
