/**
 * drastic-measures.gateway.js — CORS FAILSAFE + repo-aligned config loader
 * Author: Gabriel Anangono
 *
 * Key additions:
 * - Hard fallback allowedOrigins + origin_to_asset_id if env.ORIGIN_ASSET_ID_JSON missing/bad
 * - OPTIONS always returns CORS for allowed origins
 * - Adds x-gabo-cors-debug header on preflight so you can confirm the Worker handled it
 */

const REPO_SECRET_HEADER = "x-gabo-repo-id";
const REPO_HANDSHAKE_PATH = "/__repo/handshake";

const HONEYPOT_HDR = "x-gabo-honeypot";
const HONEYPOT_PRE_HDR = "x-gabo-honeypot-pre";
const HONEYPOT_FIELDS = ["contact", "website", "contact-field", "website-field", "hp", "honeypot", "trap"];

const AUTHOR_NAME = "Gabriel Anangono";

// INTERNAL models
const MODEL_GUARD = "@cf/meta/llama-guard-3-8b";
const MODEL_CHAT_FAST = "@cf/meta/llama-3.2-3b-instruct";
const MODEL_STT_TURBO = "@cf/openai/whisper-large-v3-turbo";
const MODEL_STT_FALLBACK = "@cf/openai/whisper";
const TTS_EN = "@cf/deepgram/aura-2-en";
const TTS_ES = "@cf/deepgram/aura-2-es";
const TTS_FALLBACK = "@cf/myshell-ai/melotts";

// -------------------------
// HARD FALLBACK (matches your worker.config.json)
// -------------------------
const FALLBACK_ALLOWED_ORIGINS = new Set([
  "https://www.gabos.io",
  "https://gabos.io",
  "https://chattiavato-a11y.github.io",
  "https://drastic-measures.rulathemtodos.workers.dev",
]);

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

const FALLBACK_CORS_ALLOW_HEADERS = [
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

const FALLBACK_CORS_EXPOSE_HEADERS = [
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

const FALLBACK = {
  routes: { chat: "/api/chat", voice: "/api/voice", tts: "/api/tts", health: "/health" },
  limits: { max_body_chars: 8000, max_messages: 30, max_message_chars: 1000, max_audio_bytes: 12582912 },
  timeouts: { voice_timeout_sec: 120 },
  assetHeader: "x-ops-asset-id",
  integrityHeader: "x-ops-src-sha512-b64",
  hopHeaderName: "x-gabo-hop",
  hopHeaderValue: "gateway",
  allowedOrigins: FALLBACK_ALLOWED_ORIGINS,
  originToAsset: FALLBACK_ORIGIN_TO_ASSET,
  cors: {
    allow_methods: "GET, POST, OPTIONS",
    allow_headers: FALLBACK_CORS_ALLOW_HEADERS,
    expose_headers: FALLBACK_CORS_EXPOSE_HEADERS,
    max_age_sec: 86400,
  },
};

// -------------------------
// small utils
// -------------------------
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

function timingSafeEq(a, b) {
  const x = toStr(a);
  const y = toStr(b);
  if (x.length !== y.length) return false;
  let out = 0;
  for (let i = 0; i < x.length; i++) out |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return out === 0;
}

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
// Config: env config OR fallback
// -------------------------
let _CFG = null;

function readEnvConfig(env) {
  const v = env?.ORIGIN_ASSET_ID_JSON;
  if (!v) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(String(v)); } catch { return null; }
}

function buildCfg(env) {
  if (_CFG) return _CFG;

  const raw = readEnvConfig(env);
  if (!raw || typeof raw !== "object") {
    _CFG = { ...FALLBACK, _cfg_source: "fallback" };
    return _CFG;
  }

  const allowedOriginsArr = Array.isArray(raw.allowedOrigins)
    ? raw.allowedOrigins
    : Array.isArray(raw.allowed_origins)
      ? raw.allowed_origins
      : [];
  const allowedOrigins = new Set(
    (allowedOriginsArr.length ? allowedOriginsArr : Array.from(FALLBACK.allowedOrigins))
      .map(normalizeOrigin).filter(Boolean)
  );

  const originToAssetRaw = raw?.asset_identity?.origin_to_asset_id && typeof raw.asset_identity.origin_to_asset_id === "object"
    ? raw.asset_identity.origin_to_asset_id
    : raw?.origin_to_asset_id && typeof raw.origin_to_asset_id === "object"
      ? raw.origin_to_asset_id
      : {};
  const originToAsset = { ...FALLBACK.originToAsset };
  for (const [k, v] of Object.entries(originToAssetRaw)) {
    const o = normalizeOrigin(k);
    const id = safeTextOnly(v);
    if (o && id) originToAsset[o] = id;
  }

  const routes = {
    chat: normalizeRoutePath(raw?.routes?.chat, FALLBACK.routes.chat),
    voice: normalizeRoutePath(raw?.routes?.voice, FALLBACK.routes.voice),
    tts: normalizeRoutePath(raw?.routes?.tts, FALLBACK.routes.tts),
    health: normalizeRoutePath(raw?.routes?.health, FALLBACK.routes.health),
  };

  const cfg = {
    ...FALLBACK,
    _cfg_source: "env",
    routes,
    allowedOrigins,
    originToAsset,
    assetHeader: safeTextOnly(raw?.asset_identity?.header_name || FALLBACK.assetHeader).toLowerCase(),
    integrityHeader: safeTextOnly(raw?.headers?.optional_integrity_header || FALLBACK.integrityHeader).toLowerCase(),
    hopHeaderName: safeTextOnly(raw?.headers?.hop_header_name || FALLBACK.hopHeaderName).toLowerCase(),
    hopHeaderValue: safeTextOnly(raw?.headers?.hop_header_value || FALLBACK.hopHeaderValue),
    limits: {
      max_body_chars: Number(raw?.limits?.max_body_chars || FALLBACK.limits.max_body_chars),
      max_messages: Number(raw?.limits?.max_messages || FALLBACK.limits.max_messages),
      max_message_chars: Number(raw?.limits?.max_message_chars || FALLBACK.limits.max_message_chars),
      max_audio_bytes: Number(raw?.limits?.max_audio_bytes || FALLBACK.limits.max_audio_bytes),
    },
    timeouts: { voice_timeout_sec: Number(raw?.timeouts?.voice_timeout_sec || FALLBACK.timeouts.voice_timeout_sec) },
    cors: {
      allow_methods: safeTextOnly(raw?.cors?.allow_methods || FALLBACK.cors.allow_methods),
      allow_headers: Array.isArray(raw?.cors?.allow_headers) ? raw.cors.allow_headers.map((h) => safeTextOnly(h).toLowerCase()).filter(Boolean) : FALLBACK.cors.allow_headers,
      expose_headers: Array.isArray(raw?.cors?.expose_headers) ? raw.cors.expose_headers.map((h) => safeTextOnly(h).toLowerCase()).filter(Boolean) : FALLBACK.cors.expose_headers,
      max_age_sec: Number(raw?.cors?.max_age_sec || FALLBACK.cors.max_age_sec),
    },
  };

  // If env config accidentally empties allowlist, keep fallback
  if (!cfg.allowedOrigins.size) cfg.allowedOrigins = FALLBACK.allowedOrigins;

  _CFG = cfg;
  return _CFG;
}

// -------------------------
// CORS (preflight + response)
// -------------------------
function originAllowed(cfg, origin) {
  const o = normalizeOrigin(origin);
  return !!o && o !== "null" && cfg.allowedOrigins.has(o);
}

function corsPreflight(cfg, req, origin) {
  const h = new Headers();
  const o = normalizeOrigin(origin);
  const allowed = originAllowed(cfg, o);

  h.set("Access-Control-Allow-Origin", allowed && o ? o : "*");
  h.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");

  h.set("Access-Control-Allow-Methods", cfg.cors.allow_methods);

  const reqHdrs = req.headers.get("Access-Control-Request-Headers");
  if (reqHdrs && String(reqHdrs).trim()) {
    const requested = String(reqHdrs)
      .split(",")
      .map((x) => safeTextOnly(x).toLowerCase())
      .filter(Boolean);
    const merged = Array.from(new Set([...cfg.cors.allow_headers, ...requested]));
    h.set("Access-Control-Allow-Headers", merged.join(", "));
  } else h.set("Access-Control-Allow-Headers", cfg.cors.allow_headers.join(", "));

  h.set("Access-Control-Max-Age", String(cfg.cors.max_age_sec));
  h.set("Access-Control-Expose-Headers", cfg.cors.expose_headers.join(", "));

  // Debug: visible in DevTools preflight response headers
  h.set("x-gabo-cors-debug", `worker_ok;${allowed ? "origin_allowed" : "origin_denied"};cfg=${cfg._cfg_source}`);

  return h;
}

function corsResponse(cfg, origin) {
  const h = new Headers();
  const o = normalizeOrigin(origin);
  const allowed = originAllowed(cfg, o);
  h.set("Access-Control-Allow-Origin", allowed && o ? o : "*");
  h.set("Vary", "Origin");
  h.set("Access-Control-Expose-Headers", cfg.cors.expose_headers.join(", "));
  h.set("x-gabo-cors-debug", `worker_ok;${allowed ? "origin_allowed" : "origin_denied"};cfg=${cfg._cfg_source}`);
  return h;
}

function json(cfg, origin, status, obj, extra) {
  const h = new Headers(extra || {});
  corsResponse(cfg, origin).forEach((v, k) => h.set(k, v));
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(obj), { status, headers: h });
}

// -------------------------
// Asset verify
// -------------------------
function verifyAsset(cfg, origin, req) {
  const o = normalizeOrigin(origin);
  const got =
    safeTextOnly(req.headers.get(cfg.assetHeader) || "") ||
    safeTextOnly(req.headers.get("x-ops-asset-id") || "");
  const expected = safeTextOnly(cfg.originToAsset[o] || "");
  return { ok: !!expected && got === expected, got, expected, origin: o };
}

// -------------------------
// MAIN
// -------------------------
export default {
  async fetch(request, env) {
    const cfg = buildCfg(env);
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    // OPTIONS preflight (this is what your browser is failing on)
    if (request.method === "OPTIONS") {
      const h = corsPreflight(cfg, request, origin);
      return new Response(null, { status: 204, headers: h });
    }

    // quick health
    if (url.pathname === "/" || url.pathname === cfg.routes.health) {
      return json(cfg, origin, 200, { ok: true, worker: "drastic-measures", cfg: cfg._cfg_source });
    }

    // block if origin not allowed (but still returns CORS debug so browser can read it if allowed)
    if (!originAllowed(cfg, origin)) {
      return json(cfg, origin, 403, { error: "Origin not allowed", saw_origin: origin || "(none)", allowed: Array.from(cfg.allowedOrigins) });
    }

    // honeypot block
    if (honeypotTriggeredFromHeaders(request)) {
      return json(cfg, origin, 403, { error: "Blocked (honeypot)", reason: "honeypot_header" });
    }

    // asset enforcement
    const asset = verifyAsset(cfg, origin, request);
    if (!asset.ok) {
      return json(cfg, origin, 403, { error: "Invalid asset identity", origin: asset.origin, got_asset_id: asset.got || "(none)", expected_asset_id: asset.expected || "(missing)" });
    }

    // Minimal: if you still have your full chat/tts/voice logic, keep it below.
    // For now we return usage on GET /api/chat:
    if (request.method === "GET" && url.pathname === cfg.routes.chat) {
      return json(cfg, origin, 200, { ok: true, route: cfg.routes.chat, note: "CORS preflight should be fixed now." });
    }

    // If your deployed worker is different, paste/merge your full handlers here.
    return json(cfg, origin, 501, { error: "Replace this block with your full chat/voice/tts handlers (or paste your current worker and I’ll merge them cleanly)." });
  },
};
