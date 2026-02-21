/**
 * worker_files/drastic-measures.gateway.js — drastic-measures — GATEWAY (Brain via Service Binding)
 *
 * GOAL:
 * - Fix CORS preflight (OPTIONS) reliably (no more missing Access-Control-Allow-Origin)
 * - Stay aligned with repo worker_files/worker.config.json contract
 * - Enforce Origin allowlist + per-origin asset identity (x-ops-asset-id)
 * - Repo ⇄ Worker handshake: POST /__repo/handshake with header x-gabo-repo-id matching env.DRASTIC_MEASURES
 * - TinyML sanitize/scan/block before Brain
 * - Escalate to Brain via service binding env.BRAIN (SSE bridge)
 *
 * Required bindings:
 * - env.AI (Cloudflare AI binding)
 * - env.BRAIN (Service binding to Brain Worker)
 *
 * Optional env vars:
 * - ORIGIN_ASSET_ID_JSON  (JSON; can be full worker.config.json OR just origin_to_asset_id map)
 * - DRASTIC_MEASURES      (repo handshake secret)
 *
 * Endpoints:
 * - GET  /health and GET /api/health
 * - OPTIONS * (preflight)
 * - POST /api/chat  -> SSE
 * - POST /api/voice -> STT JSON or chat SSE (mode=stt|chat)
 * - POST /api/tts   -> audio/mpeg
 * - POST /__repo/handshake -> JSON
 */

/* -------------------------
 * HARD FALLBACK (never empty)
 * ------------------------- */
const FALLBACK_ALLOWED_ORIGINS = [
  "https://www.gabos.io",
  "https://gabos.io",
  "https://chattiavato-a11y.github.io",
  "https://drastic-measures.rulathemtodos.workers.dev",
];

const FALLBACK_ORIGIN_TO_ASSET = {
  "https://www.gabos.io":
    "b91f605b23748de5cf02db0de2dd59117b31c709986a3c72837d0af8756473cf2779c206fc6ef80a57fdeddefa4ea11b972572f3a8edd9ed77900f9385e94bd6",
  "https://gabos.io":
    "8cdeef86bd180277d5b080d571ad8e6dbad9595f408b58475faaa3161f07448fbf12799ee199e3ee257405b75de555055fd5f43e0ce75e0740c4dc11bf86d132",
  "https://chattiavato-a11y.github.io":
    "b8f12ffa3559cee4ac71cb5f54eba1aed46394027f52e562d20be7a523db2a036f20c6e8fb0577c0a8d58f2fd198046230ebc0a73f4f1e71ff7c377d656f0756",
  "https://drastic-measures.rulathemtodos.workers.dev":
    "96dd27ea493d045ed9b46d72533e2ed2ec897668e2227dd3d79fff85ca2216a569c4bf622790c6fb0aab9f17b4e92d0f8e0fa040356bee68a9c3d50d5a60c945",
};

/* -------------------------
 * Contract constants
 * ------------------------- */
const REPO_SECRET_HEADER = "x-gabo-repo-id";
const REPO_HANDSHAKE_PATH = "/__repo/handshake";

const DEFAULT_ROUTES = {
  chat: "/api/chat",
  voice: "/api/voice",
  tts: "/api/tts",
  health: "/health",
};

const ASSET_HDR_DEFAULT = "x-ops-asset-id";
const INTEGRITY_HDR_DEFAULT = "x-ops-src-sha512-b64";

const HOP_HDR_DEFAULT = "x-gabo-hop";
const HOP_VAL_DEFAULT = "gateway";

const HONEYPOT_HDR = "x-gabo-honeypot";
const HONEYPOT_PRE_HDR = "x-gabo-honeypot-pre";
const HONEYPOT_FIELDS = ["contact", "website", "contact-field", "website-field", "hp", "honeypot", "trap"];

const AUTHOR_NAME = "Gabriel Anangono";

/* -------------------------
 * INTERNAL models (never disclose identifiers)
 * ------------------------- */
const MODEL_GUARD = "@cf/meta/llama-guard-3-8b";
const MODEL_CHAT_FAST = "@cf/meta/llama-3.2-3b-instruct";

const MODEL_STT_TURBO = "@cf/openai/whisper-large-v3-turbo";
const MODEL_STT_FALLBACK = "@cf/openai/whisper";

const TTS_EN = "@cf/deepgram/aura-2-en";
const TTS_ES = "@cf/deepgram/aura-2-es";
const TTS_FALLBACK = "@cf/myshell-ai/melotts";

/* -------------------------
 * Limits
 * ------------------------- */
const MAX_BODY_CHARS_DEFAULT = 8000;
const MAX_MESSAGES_DEFAULT = 30;
const MAX_MESSAGE_CHARS_DEFAULT = 1000;

const MAX_AUDIO_BYTES_DEFAULT = 12 * 1024 * 1024;
const MAX_VOICE_JSON_AUDIO_B64_CHARS_DEFAULT = 2_500_000;

/* -------------------------
 * Utils
 * ------------------------- */
function toStr(x) {
  return typeof x === "string" ? x : x == null ? "" : String(x);
}

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
  try {
    return new URL(v).origin.toLowerCase();
  } catch {
    return v.replace(/\/$/, "").toLowerCase();
  }
}

function normalizeIso2(code) {
  const s = safeTextOnly(code || "").toLowerCase();
  if (!s) return "";
  const two = s.includes("-") ? s.split("-")[0] : s;
  return (two || "").slice(0, 2);
}

function normalizeRoutePath(value, fallback) {
  const raw = safeTextOnly(value || fallback || "");
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function isNonEmpty(value) {
  return safeTextOnly(value).length > 0;
}

function timingSafeEq(a, b) {
  const x = toStr(a);
  const y = toStr(b);
  if (x.length !== y.length) return false;
  let out = 0;
  for (let i = 0; i < x.length; i++) out |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return out === 0;
}

/* -------------------------
 * Config loader (env.ORIGIN_ASSET_ID_JSON)
 * Accepts:
 *  A) full worker.config.json
 *  B) plain origin_to_asset_id map
 * Always prevents empty allowlist.
 * ------------------------- */
let _CFG = null;

function parseEnvJson(env) {
  const v = env?.ORIGIN_ASSET_ID_JSON;
  if (!v) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

function buildCfg(env) {
  if (_CFG) return _CFG;

  const raw = parseEnvJson(env);

  // Wrap if user stored plain map
  const cfg0 =
    raw && typeof raw === "object" && !raw.asset_identity && !raw.allowedOrigins
      ? { asset_identity: { header_name: ASSET_HDR_DEFAULT, origin_to_asset_id: raw } }
      : raw && typeof raw === "object"
        ? raw
        : {};

  const routes = {
    chat: normalizeRoutePath(cfg0?.routes?.chat, DEFAULT_ROUTES.chat),
    voice: normalizeRoutePath(cfg0?.routes?.voice, DEFAULT_ROUTES.voice),
    tts: normalizeRoutePath(cfg0?.routes?.tts, DEFAULT_ROUTES.tts),
    health: normalizeRoutePath(cfg0?.routes?.health, DEFAULT_ROUTES.health),
    api_health: "/api/health", // alias (your browser hit this)
  };

  const assetHeader = safeTextOnly(cfg0?.asset_identity?.header_name || ASSET_HDR_DEFAULT).toLowerCase();
  const integrityHeader = safeTextOnly(cfg0?.headers?.optional_integrity_header || INTEGRITY_HDR_DEFAULT).toLowerCase();
  const hopHeaderName = safeTextOnly(cfg0?.headers?.hop_header_name || HOP_HDR_DEFAULT).toLowerCase();
  const hopHeaderValue = safeTextOnly(cfg0?.headers?.hop_header_value || HOP_VAL_DEFAULT);

  // Map: env map overlays fallback map
  const originToAsset = { ...FALLBACK_ORIGIN_TO_ASSET };
  const map = cfg0?.asset_identity?.origin_to_asset_id && typeof cfg0.asset_identity.origin_to_asset_id === "object"
    ? cfg0.asset_identity.origin_to_asset_id
    : {};
  for (const [k, v] of Object.entries(map)) {
    const o = normalizeOrigin(k);
    const id = safeTextOnly(v);
    if (o && id) originToAsset[o] = id;
  }

  // Allowed origins: config.allowedOrigins OR keys(originToAsset) OR fallback list
  let allowedList = Array.isArray(cfg0.allowedOrigins) ? cfg0.allowedOrigins : [];
  if (!allowedList.length) allowedList = Object.keys(originToAsset);
  if (!allowedList.length) allowedList = FALLBACK_ALLOWED_ORIGINS;

  const allowedOrigins = new Set(allowedList.map(normalizeOrigin).filter(Boolean));

  // If still empty (should never happen), force fallback
  if (!allowedOrigins.size) {
    for (const o of FALLBACK_ALLOWED_ORIGINS) allowedOrigins.add(normalizeOrigin(o));
  }

  const corsAllowHeaders = Array.isArray(cfg0?.cors?.allow_headers)
    ? cfg0.cors.allow_headers.map((h) => safeTextOnly(h).toLowerCase()).filter(Boolean)
    : [
        "content-type",
        "accept",
        "x-ops-asset-id",
        "x-ops-src-sha512-b64",
        "x-gabo-origin",
        "x-gabo-lang-hint",
        "x-gabo-lang-list",
        "x-gabo-voice-language",
        "x-gabo-tinyml-mode",
        "x-gabo-honeypot",
        "x-gabo-honeypot-pre",
      ];

  const corsExposeHeaders = Array.isArray(cfg0?.cors?.expose_headers)
    ? cfg0.cors.expose_headers.map((h) => safeTextOnly(h).toLowerCase()).filter(Boolean)
    : [
        "x-gabo-stt-iso2",
        "x-gabo-voice-timeout-sec",
        "x-gabo-tts-iso2",
        "x-gabo-lang-iso2",
        "x-gabo-model",
        "x-gabo-translated",
        "x-gabo-embeddings",
        "x-gabo-asset-verified",
        "x-gabo-cors-debug",
      ];

  const limits = {
    max_body_chars: Number(cfg0?.limits?.max_body_chars || MAX_BODY_CHARS_DEFAULT),
    max_messages: Number(cfg0?.limits?.max_messages || MAX_MESSAGES_DEFAULT),
    max_message_chars: Number(cfg0?.limits?.max_message_chars || MAX_MESSAGE_CHARS_DEFAULT),
    max_audio_bytes: Number(cfg0?.limits?.max_audio_bytes || MAX_AUDIO_BYTES_DEFAULT),
    max_voice_json_audio_b64_chars: Number(cfg0?.limits?.max_voice_json_audio_b64_chars || MAX_VOICE_JSON_AUDIO_B64_CHARS_DEFAULT),
  };

  const voiceTimeoutSec = Number(cfg0?.timeouts?.voice_timeout_sec || 120);

  _CFG = {
    cfg_source: raw ? "env" : "fallback",
    routes,
    assetHeader,
    integrityHeader,
    hopHeaderName,
    hopHeaderValue,
    allowedOrigins,
    originToAsset,
    cors: {
      allow_methods: safeTextOnly(cfg0?.cors?.allow_methods || "GET, POST, OPTIONS"),
      allow_headers: corsAllowHeaders,
      expose_headers: corsExposeHeaders,
      max_age_sec: Number(cfg0?.cors?.max_age_sec || 86400),
    },
    limits,
    voiceTimeoutSec,
  };

  return _CFG;
}

/* -------------------------
 * Security headers
 * (API-safe baseline; CSP here is intentionally minimal since API endpoints return JSON/SSE/audio)
 * ------------------------- */
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
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  return h;
}

/* -------------------------
 * CORS (THE FIX)
 * - OPTIONS always handled
 * - For allowed origins, always returns Access-Control-Allow-Origin
 * - Echoes Access-Control-Request-Headers to avoid mismatch failures
 * - Adds x-gabo-cors-debug for visibility
 * ------------------------- */
function isAllowedOrigin(cfg, origin) {
  const o = normalizeOrigin(origin);
  return !!o && o !== "null" && cfg.allowedOrigins.has(o);
}

function corsPreflightHeaders(cfg, request, origin) {
  const h = new Headers();
  const o = normalizeOrigin(origin);
  const allowed = isAllowedOrigin(cfg, o);

  if (allowed) {
    h.set("Access-Control-Allow-Origin", o);
    h.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  }

  h.set("Access-Control-Allow-Methods", cfg.cors.allow_methods);

  const reqHdrs = request.headers.get("Access-Control-Request-Headers");
  if (reqHdrs && String(reqHdrs).trim()) h.set("Access-Control-Allow-Headers", String(reqHdrs));
  else h.set("Access-Control-Allow-Headers", cfg.cors.allow_headers.join(", "));

  h.set("Access-Control-Max-Age", String(cfg.cors.max_age_sec));
  h.set("Access-Control-Expose-Headers", cfg.cors.expose_headers.join(", "));

  h.set("x-gabo-cors-debug", `ok;origin_${allowed ? "allowed" : "denied"};cfg=${cfg.cfg_source};n=${cfg.allowedOrigins.size}`);
  return h;
}

function corsResponseHeaders(cfg, origin) {
  const h = new Headers();
  const o = normalizeOrigin(origin);
  const allowed = isAllowedOrigin(cfg, o);

  if (allowed) {
    h.set("Access-Control-Allow-Origin", o);
    h.set("Vary", "Origin");
  }

  h.set("Access-Control-Expose-Headers", cfg.cors.expose_headers.join(", "));
  h.set("x-gabo-cors-debug", `ok;origin_${allowed ? "allowed" : "denied"};cfg=${cfg.cfg_source};n=${cfg.allowedOrigins.size}`);
  return h;
}

function respondJson(cfg, origin, status, obj, extra) {
  const h = new Headers(extra || {});
  corsResponseHeaders(cfg, origin).forEach((v, k) => h.set(k, v));
  securityHeaders().forEach((v, k) => h.set(k, v));
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(obj), { status, headers: h });
}

function respondSSE(cfg, origin, stream, extra) {
  const h = new Headers(extra || {});
  corsResponseHeaders(cfg, origin).forEach((v, k) => h.set(k, v));
  securityHeaders().forEach((v, k) => h.set(k, v));
  h.set("content-type", "text/event-stream; charset=utf-8");
  h.set("cache-control", "no-cache, no-transform");
  h.set("x-accel-buffering", "no");
  return new Response(stream, { status: 200, headers: h });
}

function respondBytes(cfg, origin, bytesOrStream, contentType, extra) {
  const h = new Headers(extra || {});
  corsResponseHeaders(cfg, origin).forEach((v, k) => h.set(k, v));
  securityHeaders().forEach((v, k) => h.set(k, v));
  h.set("content-type", contentType || "application/octet-stream");
  return new Response(bytesOrStream, { status: 200, headers: h });
}

/* -------------------------
 * Asset identity enforcement
 * ------------------------- */
function verifyAssetIdentity(cfg, origin, request) {
  const o = normalizeOrigin(origin);
  const got =
    safeTextOnly(request.headers.get(cfg.assetHeader) || "") ||
    safeTextOnly(request.headers.get("x-ops-asset-id") || "") ||
    safeTextOnly(request.headers.get("X-Ops-Asset-Id") || "");
  const expected = safeTextOnly(cfg.originToAsset[o] || "");
  return { ok: !!expected && got === expected, got, expected, origin: o };
}

/* -------------------------
 * Repo handshake verification
 * ------------------------- */
function verifyRepoSecret(request, env) {
  const expected = String(env?.DRASTIC_MEASURES || "");
  const got = String(request.headers.get(REPO_SECRET_HEADER) || "");
  if (!expected) return { ok: false, reason: "missing_worker_secret" };
  if (!got) return { ok: false, reason: "missing_header" };
  return timingSafeEq(got, expected) ? { ok: true } : { ok: false, reason: "bad_secret" };
}

/* -------------------------
 * Integrity (optional)
 * If header present, verify SHA-512(base64) of raw body matches.
 * ------------------------- */
async function sha512Base64(text) {
  const t = toStr(text);
  if (!t || !crypto?.subtle) return "";
  const bytes = new TextEncoder().encode(t);
  const hash = await crypto.subtle.digest("SHA-512", bytes);
  const u8 = new Uint8Array(hash);

  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) bin += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(bin);
}

/* -------------------------
 * TinyML Guard (edge sanitizer + block)
 * - removes markup, strips code blocks
 * - blocks code-like payloads in strict mode
 * ------------------------- */
const TINYML_LIMITS = { maxInputChars: 4000, maxLineChars: 600, maxLines: 120 };

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
  { id: "sql_union", re: /\bunion\s+select\b/i, w: 4 },
  { id: "sql_drop", re: /\bdrop\s+table\b/i, w: 4 },
  { id: "sql_or_1", re: /\bor\s+1\s*=\s*1\b/i, w: 4 },
  { id: "many_braces", re: /[{}[\]]{6,}/, w: 3 },
  { id: "many_semi", re: /;{4,}/, w: 3 },
  { id: "import_export", re: /\b(import|export)\b/i, w: 2 },
  { id: "fn_class_tokens", re: /\b(function|class|const|let|var|return|async|await)\b/i, w: 2 },
  { id: "base64_blob", re: /\b[A-Za-z0-9+/]{200,}={0,2}\b/, w: 3 },
];

function tinyClampText(text) {
  let t = toStr(text);
  t = t.replace(/\u0000/g, "");
  t = t.replace(/\r\n?/g, "\n");
  if (t.length > TINYML_LIMITS.maxInputChars) t = t.slice(0, TINYML_LIMITS.maxInputChars);
  return t;
}

function tinyCollapseWhitespace(text) {
  const t = toStr(text);
  return t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function tinySplitLines(text) {
  const lines = toStr(text).split("\n").slice(0, TINYML_LIMITS.maxLines);
  return lines.map((l) => (l.length > TINYML_LIMITS.maxLineChars ? l.slice(0, TINYML_LIMITS.maxLineChars) : l));
}

function tinyLineCodeDensity(line) {
  const s = toStr(line);
  if (!s) return 0;
  const punct = (s.match(/[{}[\];=<>$]/g) || []).length;
  const words = (s.match(/[A-Za-z_]{2,}/g) || []).length;
  const hasQuotes = /["'`]/.test(s);
  let score = punct / Math.max(1, s.length);
  if (words >= 6 && punct >= 6) score += 0.06;
  if (hasQuotes && punct >= 6) score += 0.04;
  return score;
}

function tinyStripDangerousMarkup(text) {
  let t = tinyClampText(text);
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
  return tinyCollapseWhitespace(t);
}

function tinyStripCodeBlocks(text) {
  let t = toStr(text);
  t = t.replace(/```[\s\S]*?```/g, " [REMOVED_CODE_BLOCK] ");
  t = t.replace(/~~~[\s\S]*?~~~/g, " [REMOVED_CODE_BLOCK] ");
  t = t.replace(/`[^`]{1,200}`/g, " [REMOVED_INLINE_CODE] ");
  t = t.replace(/<\s*pre\b[^>]*>[\s\S]*?<\s*\/\s*pre\s*>/gi, " [REMOVED_CODE_BLOCK] ");
  t = t.replace(/<\s*code\b[^>]*>[\s\S]*?<\s*\/\s*code\s*>/gi, " [REMOVED_CODE_BLOCK] ");

  const kept = [];
  for (const line of tinySplitLines(t)) kept.push(tinyLineCodeDensity(line) >= 0.12 ? " [REMOVED_CODE_LINE] " : line);
  return tinyCollapseWhitespace(kept.join("\n"));
}

function tinyScoreRisk(text) {
  const sample = toStr(text);
  let score = 0;
  const hits = [];
  for (const p of TINYML_PATTERNS) {
    if (p.re.test(sample)) {
      score += p.w;
      hits.push(p.id);
    }
  }
  if (sample.length > 600) score += 1;
  if (sample.length > 1200) score += 1;
  const punct = (sample.match(/[{}[\];=<>$]/g) || []).length;
  if (punct >= 18) score += 2;
  return { score, hits };
}

function tinyHasResidualMalicious(text) {
  const s = toStr(text);
  const checks = [
    /<\s*script\b/i,
    /\bon\w+\s*=/i,
    /\bjavascript\s*:/i,
    /\bdata\s*:\s*text\/html\b/i,
    /\beval\s*\(/i,
    /\bnew\s+Function\b/i,
    /\bdocument\.(cookie|write)\b/i,
    /<[^>]+>/,
  ];
  return checks.some((re) => re.test(s));
}

function tinySanitize(text) {
  return tinyStripCodeBlocks(tinyStripDangerousMarkup(tinyClampText(text)));
}

function tinyEvaluate(text, mode) {
  const m = String(mode || "strict").toLowerCase() === "clean" ? "clean" : "strict";
  const clamped = tinyClampText(text);
  const sanitized = tinySanitize(clamped);
  const before = tinyScoreRisk(clamped);
  const after = tinyScoreRisk(sanitized);
  const residual = tinyHasResidualMalicious(sanitized);

  const highRisk = after.score >= 9 || before.score >= 12;
  const blocked =
    residual ||
    highRisk ||
    (m === "strict" &&
      (after.hits.includes("fn_class_tokens") || after.hits.includes("import_export")) &&
      after.score >= 6);

  return {
    ok: !blocked,
    mode: m,
    sanitized,
    risk: { before_score: before.score, before_hits: before.hits, after_score: after.score, after_hits: after.hits, residual_malicious: residual },
    reason: blocked
      ? residual
        ? "residual_malicious_content"
        : highRisk
          ? "risk_score_too_high"
          : "code_like_payload_blocked"
      : "sanitized_ok",
  };
}

/* -------------------------
 * Model/author disclosure rules
 * ------------------------- */
function wantsModelDisclosure(text) {
  const t = toStr(text).toLowerCase();
  const needles = [
    "what model","which model","model are you","model do you use","what llm","which llm","what ai model","which ai model",
    "tell me the model","@cf/","llama-","gpt-","gemini","claude","mistral","whisper-","deepgram","bge-",
  ];
  return needles.some((n) => t.includes(n));
}

function wantsAuthorDisclosure(text) {
  const t = toStr(text).toLowerCase();
  const needles = [
    "who created you","who made you","who built you","who is your author","who is the author","who is your creator",
    "creator","author","desarrollador","creador","quién te creó","quien te creo","quién te hizo","hecho por","creado por",
  ];
  return needles.some((n) => t.includes(n));
}

function redactInternalModelIds(text) {
  let t = toStr(text);
  t = t.replace(/@cf\/[a-z0-9._-]+\/[a-z0-9._-]+/gi, "[model withheld]");
  t = t.replace(/\/ai\/run\/@cf\/[a-z0-9._-]+\/[a-z0-9._-]+/gi, "/ai/run/[model withheld]");
  return t;
}

function stripAuthorUnlessAllowed(text, allowAuthor) {
  let t = toStr(text);
  if (allowAuthor) return t;
  const re = new RegExp(AUTHOR_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  t = t.replace(re, "").replace(/\s{2,}/g, " ").trim();
  return t;
}

function postProcessOutgoingText(text, allowAuthor) {
  let t = toStr(text);
  t = redactInternalModelIds(t);
  t = stripAuthorUnlessAllowed(t, allowAuthor);
  return t;
}

/* -------------------------
 * Honeypot detection
 * ------------------------- */
function honeypotTriggeredFromHeaders(req) {
  return isNonEmpty(req.headers.get(HONEYPOT_HDR)) || isNonEmpty(req.headers.get(HONEYPOT_PRE_HDR));
}

function honeypotTriggeredFromObject(obj) {
  if (!obj || typeof obj !== "object") return false;
  for (const k of HONEYPOT_FIELDS) {
    if (k in obj && isNonEmpty(obj[k])) return true;
  }
  return false;
}

/* -------------------------
 * Message content coercion
 * - supports OpenAI-style content parts
 * - supports shorthand {message|prompt|input}
 * ------------------------- */
function coerceMessageContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    let out = "";
    for (const part of content) {
      if (typeof part === "string") {
        out += part + "\n";
        continue;
      }
      if (part && typeof part === "object") {
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

  return String(content || "");
}

function coerceBodyMessages(body) {
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body.messages)) return body.messages;
  if (body.messages && typeof body.messages === "object") return [body.messages];
  const s = body.message ?? body.prompt ?? body.input;
  if (typeof s === "string" && s.trim()) return [{ role: "user", content: s }];
  return null;
}

function lastUserText(messages) {
  return [...messages].reverse().find((m) => m.role === "user")?.content || "";
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
  // optional: tinyml_mode from meta
  if (meta.tinyml_mode) out.tinyml_mode = safeTextOnly(meta.tinyml_mode);
  return out;
}

function normalizeMessages(cfg, input, tinyMode) {
  if (!Array.isArray(input)) return { ok: false, messages: [], reason: "messages_not_array", tiny: null };

  const out = [];
  let worstTiny = null;

  const maxMessages = cfg.limits.max_messages;
  const maxChars = cfg.limits.max_message_chars;

  for (const m of input.slice(-maxMessages)) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;

    const raw = coerceMessageContent(m.content);
    const tiny = tinyEvaluate(raw, tinyMode);
    if (!tiny.ok) worstTiny = worstTiny || tiny;

    const cleaned = safeTextOnly(tiny.sanitized || "");
    if (!cleaned) continue;

    let content = cleaned;
    if (content.length > maxChars) content = content.slice(0, maxChars);

    out.push({ role, content });
  }

  if (worstTiny && worstTiny.ok === false && String(tinyMode || "strict").toLowerCase() !== "clean") {
    return { ok: false, messages: [], reason: worstTiny.reason || "tinyml_block", tiny: worstTiny };
  }

  return { ok: true, messages: out, reason: "ok", tiny: worstTiny };
}

/* -------------------------
 * Language detect (heuristic + model fallback)
 * ------------------------- */
function hasRange(text, a, b) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= a && c <= b) return true;
  }
  return false;
}

function detectLangIso2Heuristic(text) {
  const t0 = toStr(text || "");
  if (!t0) return "";

  if (hasRange(t0, 0x3040, 0x30ff)) return "ja";
  if (hasRange(t0, 0xac00, 0xd7af)) return "ko";
  if (hasRange(t0, 0x4e00, 0x9fff)) return "zh";
  if (hasRange(t0, 0x0400, 0x04ff)) return "ru";
  if (hasRange(t0, 0x0600, 0x06ff)) return "ar";
  if (hasRange(t0, 0x0590, 0x05ff)) return "he";

  const t = t0.toLowerCase();
  if (/[ñáéíóúü¿¡]/i.test(t)) return "es";
  if (/[ãõç]/i.test(t)) return "pt";
  if (/[àâçéèêëîïôûùüÿœ]/i.test(t)) return "fr";
  if (/[äöüß]/i.test(t)) return "de";
  return "";
}

async function detectLangIso2ViaModel(env, text) {
  const sample = safeTextOnly(toStr(text)).slice(0, 240);
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

    const raw = toStr(out?.response || out?.result?.response || out?.text || out).trim().toLowerCase();
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

/* -------------------------
 * Guard parsing
 * ------------------------- */
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

/* -------------------------
 * Brain call (service binding)
 * ------------------------- */
function requireBrain(env) {
  if (!env?.BRAIN || typeof env.BRAIN.fetch !== "function") {
    throw new Error("Missing service binding (env.BRAIN).");
  }
  return env.BRAIN;
}

async function callBrainChat(cfg, env, payload, origin, assetId) {
  const brain = requireBrain(env);
  const safeOrigin = toStr(origin).trim() || "https://drastic-measures.rulathemtodos.workers.dev";
  const safeAssetId = toStr(assetId).trim();

  return brain.fetch("https://brain/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      [cfg.hopHeaderName]: cfg.hopHeaderValue,
      Origin: safeOrigin,
      [cfg.assetHeader]: safeAssetId,
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

/* -------------------------
 * SSE bridge helpers
 * ------------------------- */
function sseDataFrame(text) {
  const s = toStr(text ?? "");
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
  const lines = toStr(block || "").split("\n");
  const dataLines = [];
  for (const line of lines) if (line && line.startsWith("data:")) dataLines.push(line.slice(5));
  return { data: dataLines.join("\n") };
}

function getDeltaFromObj(obj) {
  if (!obj) return "";
  if (typeof obj.response === "string") return obj.response;
  if (obj.result && typeof obj.result.response === "string") return obj.result.response;
  if (obj.response && obj.response.response && typeof obj.response.response === "string") return obj.response.response;
  return "";
}

function extractJsonObjectsFromBuffer(buffer) {
  const out = [];
  let start = -1, depth = 0, inStr = false, esc = false;

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

    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      out.push(buffer.slice(start, i + 1));
      start = -1;
    }
  }

  const rest = start === -1 ? "" : buffer.slice(start);
  return { chunks: out, rest };
}

function bridgeBrainToSSE(brainBody, allowAuthor) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  if (!brainBody) {
    return new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(sseDataFrame(""))); controller.close(); },
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
              const dataTrim = toStr(data || "").trim();

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
                  const out = postProcessOutgoingText(toStr(data || ""), allowAuthor);
                  if (out) controller.enqueue(encoder.encode(sseDataFrame(out)));
                }
              } else {
                const out = postProcessOutgoingText(toStr(data || ""), allowAuthor);
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

/* -------------------------
 * Base64 helpers for voice/tts
 * ------------------------- */
function bytesToBase64(u8) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < u8.length; i += chunk) binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(binary);
}

function base64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 255;
  return u8;
}

/* -------------------------
 * STT
 * ------------------------- */
async function runSTT(env, audioU8, audioB64Maybe) {
  const audio_b64 =
    typeof audioB64Maybe === "string" && audioB64Maybe.length >= 16
      ? audioB64Maybe
      : bytesToBase64(audioU8);

  try {
    return await env.AI.run(MODEL_STT_TURBO, { audio: audio_b64 });
  } catch (eTurbo) {
    try {
      if (audioU8.byteLength <= 1_500_000) return await env.AI.run(MODEL_STT_FALLBACK, { audio: Array.from(audioU8) });
    } catch (eFallback) {
      const msg = toStr(eFallback?.message || eFallback || eTurbo?.message || eTurbo);
      throw new Error(msg);
    }
    throw new Error(toStr(eTurbo?.message || eTurbo));
  }
}

/* -------------------------
 * TTS
 * ------------------------- */
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

/* -------------------------
 * MAIN WORKER
 * ------------------------- */
export default {
  async fetch(request, env) {
    const cfg = buildCfg(env);
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // ---- OPTIONS preflight (CORS fix)
    if (request.method === "OPTIONS") {
      const h = corsPreflightHeaders(cfg, request, origin);
      securityHeaders().forEach((v, k) => h.set(k, v));
      return new Response(null, { status: 204, headers: h });
    }

    // ---- Health
    if (url.pathname === "/" || url.pathname === cfg.routes.health || url.pathname === cfg.routes.api_health) {
      return respondJson(cfg, origin, 200, {
        ok: true,
        health: "gateway: ok",
        cfg_source: cfg.cfg_source,
        allowed_origins_count: cfg.allowedOrigins.size,
      });
    }

    // ---- Debug snapshot (GET /api/chat)
    if (request.method === "GET" && url.pathname === cfg.routes.chat) {
      return respondJson(cfg, origin, 200, {
        ok: true,
        routes: { ...cfg.routes, handshake: REPO_HANDSHAKE_PATH },
        allowed_origins: Array.from(cfg.allowedOrigins),
        asset_header: cfg.assetHeader,
        integrity_header: cfg.integrityHeader,
        handshake: { method: "POST", path: REPO_HANDSHAKE_PATH, header: REPO_SECRET_HEADER, secret_env: "DRASTIC_MEASURES" },
        note: "If allowed_origins is empty, CORS fails. This build prevents empty allowlist.",
      });
    }

    // ---- Handshake
    if (url.pathname === REPO_HANDSHAKE_PATH) {
      if (request.method !== "POST") return respondJson(cfg, origin, 405, { ok: false, error: "method_not_allowed" });
      const check = verifyRepoSecret(request, env);
      if (!check.ok) return respondJson(cfg, origin, 403, { ok: false, error: "repo_auth_failed", reason: check.reason });
      return respondJson(cfg, origin, 200, {
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

    if (!isChat && !isVoice && !isTts) {
      return respondJson(cfg, origin, 404, { error: "Not found" });
    }

    if (request.method !== "POST") {
      return respondJson(cfg, origin, 405, { error: "Method not allowed" });
    }

    // ---- Origin allowlist
    if (!isAllowedOrigin(cfg, origin)) {
      return respondJson(cfg, origin, 403, {
        error: "Origin not allowed",
        saw_origin: origin || "(none)",
        allowed: Array.from(cfg.allowedOrigins),
      });
    }

    // ---- Honeypot quick block
    if (honeypotTriggeredFromHeaders(request)) {
      return respondJson(cfg, origin, 403, { error: "Blocked (honeypot)", reason: "honeypot_header" });
    }

    // ---- AI binding required
    if (!env?.AI || typeof env.AI.run !== "function") {
      return respondJson(cfg, origin, 500, { error: "Missing AI binding (env.AI)" });
    }

    // ---- Asset identity required
    const assetCheck = verifyAssetIdentity(cfg, origin, request);
    if (!assetCheck.ok) {
      return respondJson(cfg, origin, 403, {
        error: "Invalid asset identity",
        detail: `${cfg.assetHeader} must match the calling Origin.`,
        origin: assetCheck.origin,
        got_asset_id: assetCheck.got || "(none)",
        expected_asset_id: assetCheck.expected || "(missing mapping)",
      });
    }

    // Common response header for verified identity
    const baseExtra = new Headers();
    baseExtra.set("x-gabo-asset-verified", "1");

    // TinyML mode (header wins)
    const tinyMode = safeTextOnly(request.headers.get("x-gabo-tinyml-mode") || "strict").toLowerCase();

    // -----------------------
    // /api/chat  (SSE)
    // -----------------------
    if (isChat) {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        return respondJson(cfg, origin, 415, { error: "content-type must be application/json" }, baseExtra);
      }

      const raw = await request.text().catch(() => "");
      if (!raw) return respondJson(cfg, origin, 400, { error: "Empty body" }, baseExtra);
      if (raw.length > cfg.limits.max_body_chars) return respondJson(cfg, origin, 413, { error: "Request too large" }, baseExtra);

      // Optional integrity verify (only if header present)
      const wantIntegrity = safeTextOnly(request.headers.get(cfg.integrityHeader) || "");
      if (wantIntegrity) {
        const got = await sha512Base64(raw);
        if (!got || !timingSafeEq(got, wantIntegrity)) {
          return respondJson(cfg, origin, 400, { error: "Integrity check failed", hint: "Remove x-ops-src-sha512-b64 or compute it from RAW JSON body." }, baseExtra);
        }
      }

      let body;
      try { body = JSON.parse(raw); }
      catch {
        return respondJson(cfg, origin, 400, { error: "Invalid JSON" }, baseExtra);
      }

      // Honeypot in body
      if (honeypotTriggeredFromObject(body)) {
        return respondJson(cfg, origin, 403, { error: "Blocked (honeypot)", reason: "honeypot_body" }, baseExtra);
      }

      const metaSafe = sanitizeMeta(body.meta);
      const msgInput = coerceBodyMessages(body);
      if (!msgInput) {
        return respondJson(cfg, origin, 400, { error: "messages[] required", hint: "Send {messages:[{role:'user',content:'hi'}]} OR {message:'hi'}" }, baseExtra);
      }

      // TinyML sanitize/normalize (may block)
      const norm = normalizeMessages(cfg, msgInput, metaSafe?.tinyml_mode || tinyMode);
      if (!norm.ok) {
        return respondJson(cfg, origin, 403, { error: "Blocked by TinyML", reason: norm.reason, tinyml: norm.tiny?.risk }, baseExtra);
      }

      const messages = norm.messages;
      if (!messages.length) {
        return respondJson(cfg, origin, 400, { error: "messages[] empty after sanitization" }, baseExtra);
      }

      const lastUser = lastUserText(messages);
      const allowAuthor = wantsAuthorDisclosure(lastUser);

      // Model non-disclosure
      if (wantsModelDisclosure(lastUser)) {
        const msg =
          `I can’t disclose the specific model identifiers or configuration.\n` +
          `This assistant was created by ${AUTHOR_NAME}.\n` +
          `It uses a mix of AI systems from multiple providers, but exact model IDs are intentionally withheld.`;
        return respondSSE(cfg, origin, oneShotSSE(msg), baseExtra);
      }

      // Language detect
      const langIso2 = await detectLangIso2(env, messages, metaSafe);
      if (!metaSafe.lang_iso2 || metaSafe.lang_iso2 === "auto" || metaSafe.lang_iso2 === "und") metaSafe.lang_iso2 = langIso2;

      // Guard at edge
      let guardRes;
      try { guardRes = await env.AI.run(MODEL_GUARD, { messages }); }
      catch { return respondJson(cfg, origin, 502, { error: "Safety check unavailable" }, baseExtra); }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) return respondJson(cfg, origin, 403, { error: "Blocked by safety filter", categories: verdict.categories }, baseExtra);

      // Call Brain
      let brainResp;
      try { brainResp = await callBrainChat(cfg, env, { messages, meta: metaSafe }, origin, assetCheck.got); }
      catch (e) { return respondJson(cfg, origin, 502, { error: "Brain unreachable", detail: toStr(e?.message || e) }, baseExtra); }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return respondJson(cfg, origin, 502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, baseExtra);
      }

      const extra = new Headers(baseExtra);
      forwardBrainHeaders(extra, brainResp);

      return respondSSE(cfg, origin, bridgeBrainToSSE(brainResp.body, allowAuthor), extra);
    }

    // -----------------------
    // /api/tts  (audio/mpeg)
    // -----------------------
    if (isTts) {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) return respondJson(cfg, origin, 415, { error: "content-type must be application/json" }, baseExtra);

      const raw = await request.text().catch(() => "");
      if (!raw || raw.length > cfg.limits.max_body_chars) return respondJson(cfg, origin, 413, { error: "Request too large" }, baseExtra);

      const wantIntegrity = safeTextOnly(request.headers.get(cfg.integrityHeader) || "");
      if (wantIntegrity) {
        const got = await sha512Base64(raw);
        if (!got || !timingSafeEq(got, wantIntegrity)) return respondJson(cfg, origin, 400, { error: "Integrity check failed" }, baseExtra);
      }

      let body;
      try { body = JSON.parse(raw); } catch { return respondJson(cfg, origin, 400, { error: "Invalid JSON" }, baseExtra); }

      if (honeypotTriggeredFromObject(body)) return respondJson(cfg, origin, 403, { error: "Blocked (honeypot)", reason: "honeypot_body" }, baseExtra);

      const inputText = body?.text || "";
      const tiny = tinyEvaluate(inputText, tinyMode);
      if (!tiny.ok && String(tinyMode || "strict").toLowerCase() !== "clean") {
        return respondJson(cfg, origin, 403, { error: "Blocked by TinyML", reason: tiny.reason, tinyml: tiny.risk }, baseExtra);
      }

      const text = safeTextOnly(tiny.sanitized || "");
      if (!text) return respondJson(cfg, origin, 400, { error: "text required" }, baseExtra);

      const langIso2 = normalizeIso2(body?.lang_iso2 || body?.language || "en") || "en";
      const extra = new Headers(baseExtra);
      extra.set("x-gabo-tts-iso2", langIso2);

      try {
        const out = await ttsAny(env, text, langIso2);
        return respondBytes(cfg, origin, out.body, out.ct || "audio/mpeg", extra);
      } catch (e) {
        return respondJson(cfg, origin, 502, { error: "TTS unavailable", detail: toStr(e?.message || e) }, extra);
      }
    }

    // -----------------------
    // /api/voice  (STT or chat)
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
        if (!raw) return respondJson(cfg, origin, 400, { error: "Empty JSON body" }, baseExtra);

        const wantIntegrity = safeTextOnly(request.headers.get(cfg.integrityHeader) || "");
        if (wantIntegrity) {
          const got = await sha512Base64(raw);
          if (!got || !timingSafeEq(got, wantIntegrity)) return respondJson(cfg, origin, 400, { error: "Integrity check failed" }, baseExtra);
        }

        let body;
        try { body = JSON.parse(raw); } catch { return respondJson(cfg, origin, 400, { error: "Invalid JSON" }, baseExtra); }

        if (honeypotTriggeredFromObject(body)) return respondJson(cfg, origin, 403, { error: "Blocked (honeypot)", reason: "honeypot_body" }, baseExtra);

        const msgInput = coerceBodyMessages(body);
        if (msgInput) {
          const norm = normalizeMessages(cfg, msgInput, tinyMode);
          if (norm.ok) priorMessages = norm.messages;
        }

        metaSafe = sanitizeMeta(body.meta);

        if (typeof body.audio_b64 === "string" && body.audio_b64.length) {
          if (body.audio_b64.length > cfg.limits.max_voice_json_audio_b64_chars) {
            return respondJson(cfg, origin, 413, { error: "audio_b64 too large; send binary audio instead" }, baseExtra);
          }
          audioB64 = body.audio_b64;
          const bytes = base64ToBytes(body.audio_b64);
          if (bytes.byteLength > cfg.limits.max_audio_bytes) return respondJson(cfg, origin, 413, { error: "Audio too large" }, baseExtra);
          audioU8 = bytes;
        } else if (Array.isArray(body.audio) && body.audio.length) {
          if (body.audio.length > cfg.limits.max_audio_bytes) return respondJson(cfg, origin, 413, { error: "Audio too large" }, baseExtra);
          const u8 = new Uint8Array(body.audio.length);
          for (let i = 0; i < body.audio.length; i++) u8[i] = Number(body.audio[i]) & 255;
          audioU8 = u8;
        } else {
          return respondJson(cfg, origin, 400, { error: "Missing audio (audio_b64 or audio[])" }, baseExtra);
        }
      } else if (ct.includes("multipart/form-data")) {
        let fd;
        try { fd = await request.formData(); }
        catch { return respondJson(cfg, origin, 400, { error: "Invalid multipart/form-data" }, baseExtra); }

        for (const k of HONEYPOT_FIELDS) {
          const v = fd.get(k);
          if (typeof v === "string" && isNonEmpty(v)) return respondJson(cfg, origin, 403, { error: "Blocked (honeypot)", reason: "honeypot_multipart" }, baseExtra);
        }

        const file = fd.get("audio") || fd.get("file") || fd.get("blob");
        if (!file || typeof file === "string") return respondJson(cfg, origin, 400, { error: "Missing audio file field (audio|file|blob)" }, baseExtra);

        const ab = await file.arrayBuffer().catch(() => null);
        if (!ab || ab.byteLength < 16) return respondJson(cfg, origin, 400, { error: "Empty audio" }, baseExtra);
        if (ab.byteLength > cfg.limits.max_audio_bytes) return respondJson(cfg, origin, 413, { error: "Audio too large" }, baseExtra);
        audioU8 = new Uint8Array(ab);
      } else {
        const buf = await request.arrayBuffer().catch(() => null);
        if (!buf || buf.byteLength < 16) return respondJson(cfg, origin, 400, { error: "Empty audio" }, baseExtra);
        if (buf.byteLength > cfg.limits.max_audio_bytes) return respondJson(cfg, origin, 413, { error: "Audio too large" }, baseExtra);
        audioU8 = new Uint8Array(buf);
      }

      let sttOut;
      try { sttOut = await runSTT(env, audioU8, audioB64); }
      catch (e) { return respondJson(cfg, origin, 502, { error: "Whisper unavailable", detail: toStr(e?.message || e) }, baseExtra); }

      const transcriptRaw = sttOut?.text || sttOut?.result?.text || sttOut?.response?.text || "";
      const tiny = tinyEvaluate(transcriptRaw, tinyMode);
      if (!tiny.ok && String(tinyMode || "strict").toLowerCase() !== "clean") {
        return respondJson(cfg, origin, 403, { error: "Blocked by TinyML", reason: tiny.reason, tinyml: tiny.risk }, baseExtra);
      }

      const transcript = safeTextOnly(tiny.sanitized || "");
      if (!transcript) return respondJson(cfg, origin, 400, { error: "No transcription produced" }, baseExtra);

      const allowAuthor = wantsAuthorDisclosure(transcript);

      if (wantsModelDisclosure(transcript)) {
        const msg =
          `I can’t disclose the specific model identifiers or configuration.\n` +
          `This assistant was created by ${AUTHOR_NAME}.\n` +
          `It uses a mix of AI systems from multiple providers, but exact model IDs are intentionally withheld.`;
        const extraSse = new Headers(baseExtra);
        extraSse.set("x-gabo-voice-timeout-sec", String(cfg.voiceTimeoutSec));
        return respondSSE(cfg, origin, oneShotSSE(msg), extraSse);
      }

      const langIso2 = await detectLangIso2(env, [{ role: "user", content: transcript }], metaSafe);

      const extra = new Headers(baseExtra);
      extra.set("x-gabo-stt-iso2", langIso2 || "und");
      extra.set("x-gabo-voice-timeout-sec", String(cfg.voiceTimeoutSec));

      if (mode === "stt") {
        return respondJson(cfg, origin, 200, { transcript, lang_iso2: langIso2 || "und", voice_timeout_sec: cfg.voiceTimeoutSec }, extra);
      }

      // mode=chat: build messages and call brain like /api/chat
      const messages = priorMessages.length
        ? [...priorMessages, { role: "user", content: transcript }]
        : [{ role: "user", content: transcript }];

      if (!metaSafe.lang_iso2 || metaSafe.lang_iso2 === "auto" || metaSafe.lang_iso2 === "und") metaSafe.lang_iso2 = langIso2 || "und";

      let guardRes;
      try { guardRes = await env.AI.run(MODEL_GUARD, { messages }); }
      catch { return respondJson(cfg, origin, 502, { error: "Safety check unavailable" }, extra); }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) return respondJson(cfg, origin, 403, { error: "Blocked by safety filter", categories: verdict.categories }, extra);

      let brainResp;
      try { brainResp = await callBrainChat(cfg, env, { messages, meta: metaSafe }, origin, assetCheck.got); }
      catch (e) { return respondJson(cfg, origin, 502, { error: "Brain unreachable", detail: toStr(e?.message || e) }, extra); }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return respondJson(cfg, origin, 502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, extra);
      }

      forwardBrainHeaders(extra, brainResp);
      return respondSSE(cfg, origin, bridgeBrainToSSE(brainResp.body, allowAuthor), extra);
    }

    // Should never reach
    return respondJson(cfg, origin, 500, { error: "Unhandled route" });
  },
};
