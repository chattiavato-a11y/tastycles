/**
 * worker_files/client.worker.js — Browser client for drastic-measures gateway
 *
 * Goals:
 * - Fetch + cache worker_files/worker.config.json (and optionally registry)
 * - Provide small, safe helpers for:
 *   - postChat()  -> SSE stream response
 *   - postVoiceSTT() -> /api/voice?mode=stt (binary audio)
 *   - postTTS()  -> /api/tts (json -> audio)
 * - Enforce:
 *   - Allowed endpoints (same-origin or allowlisted)
 *   - Asset identity header x-ops-asset-id (from config or window.OPS_ASSET_ID)
 *   - Optional integrity header x-ops-src-sha512-b64 (from app.js TinyML)
 *
 * NOTE:
 * - This file is designed to run under a strict CSP: script-src 'self'
 * - No eval, no dynamic script injection, no external deps.
 */

(() => {
  "use strict";

  // -------------------------
  // Safe helpers
  // -------------------------
  const safeText = (v) => String(v ?? "").trim();
  const normalizeOrigin = (v) => {
    try {
      return new URL(String(v), window.location.origin).origin.toLowerCase();
    } catch {
      return safeText(v).replace(/\/$/, "").toLowerCase();
    }
  };

  const toBaseUrl = (urlLike) => {
    try {
      const u = new URL(String(urlLike), window.location.origin);
      u.hash = "";
      u.search = "";
      return u.toString().replace(/\/$/, "");
    } catch {
      return safeText(urlLike).replace(/\/$/, "");
    }
  };

  const isObject = (x) => x && typeof x === "object" && !Array.isArray(x);
  const MAX_MESSAGES = 30;
  const MAX_MESSAGE_CHARS = 1000;

  // -------------------------
  // Default config (fallback)
  // -------------------------
  const DEFAULT_WORKER_ORIGIN = "https://drastic-measures.rulathemtodos.workers.dev";

  const DEFAULT_CONFIG = {
    app_name: "gabo",
    environment: "production",
    assetRegistry: "worker_files/worker.assets.json",
    workerScript: "worker_files/drastic-measures.gateway.js",
    workerEndpoint: DEFAULT_WORKER_ORIGIN,
    assistantEndpoint: `${DEFAULT_WORKER_ORIGIN}/api/chat`,
    voiceEndpoint: `${DEFAULT_WORKER_ORIGIN}/api/voice`,
    ttsEndpoint: `${DEFAULT_WORKER_ORIGIN}/api/tts`,
    gatewayEndpoint: DEFAULT_WORKER_ORIGIN,
    workerEndpointAssetId:
      "96dd27ea493d045ed9b46d72533e2ed2ec897668e2227dd3d79fff85ca2216a569c4bf622790c6fb0aab9f17b4e92d0f8e0fa040356bee68a9c3d50d5a60c945",
    gatewayEndpointAssetId:
      "96dd27ea493d045ed9b46d72533e2ed2ec897668e2227dd3d79fff85ca2216a569c4bf622790c6fb0aab9f17b4e92d0f8e0fa040356bee68a9c3d50d5a60c945",
    allowedOrigins: [
      "https://www.gabos.io",
      "https://gabos.io",
      "https://chattiavato-a11y.github.io",
      "https://drastic-measures.rulathemtodos.workers.dev",
    ],
    allowedOriginAssetIds: [
      "b91f605b23748de5cf02db0de2dd59117b31c709986a3c72837d0af8756473cf2779c206fc6ef80a57fdeddefa4ea11b972572f3a8edd9ed77900f9385e94bd6",
      "8cdeef86bd180277d5b080d571ad8e6dbad9595f408b58475faaa3161f07448fbf12799ee199e3ee257405b75de555055fd5f43e0ce75e0740c4dc11bf86d132",
      "b8f12ffa3559cee4ac71cb5f54eba1aed46394027f52e562d20be7a523db2a036f20c6e8fb0577c0a8d58f2fd198046230ebc0a73f4f1e71ff7c377d656f0756",
      "96dd27ea493d045ed9b46d72533e2ed2ec897668e2227dd3d79fff85ca2216a569c4bf622790c6fb0aab9f17b4e92d0f8e0fa040356bee68a9c3d50d5a60c945",
    ],
    asset_identity: {
      header_name: "x-ops-asset-id",
      origin_to_asset_id: {
        "https://www.gabos.io":
          "b91f605b23748de5cf02db0de2dd59117b31c709986a3c72837d0af8756473cf2779c206fc6ef80a57fdeddefa4ea11b972572f3a8edd9ed77900f9385e94bd6",
        "https://gabos.io":
          "8cdeef86bd180277d5b080d571ad8e6dbad9595f408b58475faaa3161f07448fbf12799ee199e3ee257405b75de555055fd5f43e0ce75e0740c4dc11bf86d132",
        "https://chattiavato-a11y.github.io":
          "b8f12ffa3559cee4ac71cb5f54eba1aed46394027f52e562d20be7a523db2a036f20c6e8fb0577c0a8d58f2fd198046230ebc0a73f4f1e71ff7c377d656f0756",
        "https://drastic-measures.rulathemtodos.workers.dev":
          "96dd27ea493d045ed9b46d72533e2ed2ec897668e2227dd3d79fff85ca2216a569c4bf622790c6fb0aab9f17b4e92d0f8e0fa040356bee68a9c3d50d5a60c945",
      },
    },
    requiredHeaders: ["Content-Type", "Accept", "X-Ops-Asset-Id"],
    headers: {
      hop_header_name: "x-gabo-hop",
      hop_header_value: "gateway",
      language_hints: {
        hint_header: "x-gabo-lang-hint",
        list_header: "x-gabo-lang-list",
        voice_language_header: "x-gabo-voice-language",
      },
      optional_integrity_header: "x-ops-src-sha512-b64",
    },
    routes: { chat: "/api/chat", voice: "/api/voice", tts: "/api/tts", health: "/health" },
    timeouts: { voice_timeout_sec: 120 },
    limits: { max_body_chars: 8000, max_messages: 30, max_message_chars: 1000, max_audio_bytes: 12582912 },
  };

  // -------------------------
  // Internal state
  // -------------------------
  const STATE = {
    loaded: false,
    config: { ...DEFAULT_CONFIG },
    registry: null,
    lastLoadAt: 0,
    lastError: "",
  };

  // -------------------------
  // Config + registry loading
  // -------------------------
  const CONFIG_URL = "worker_files/worker.config.json";
  const REGISTRY_URL_DEFAULT = "worker_files/worker.assets.json";

  const fetchJson = async (url, opts) => {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      ...(opts || {}),
      headers: { accept: "application/json", ...(opts?.headers || {}) },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Fetch failed (${res.status}) ${txt.slice(0, 180)}`);
    }
    return res.json();
  };

  const mergeConfig = (base, incoming) => {
    const out = { ...base };

    if (!isObject(incoming)) return out;

    // shallow merge for known keys
    const copyKeys = [
      "app_name",
      "environment",
      "assetRegistry",
      "workerScript",
      "workerEndpoint",
      "assistantEndpoint",
      "voiceEndpoint",
      "ttsEndpoint",
      "gatewayEndpoint",
      "workerEndpointAssetId",
      "gatewayEndpointAssetId",
    ];
    copyKeys.forEach((k) => {
      if (typeof incoming[k] === "string" && safeText(incoming[k])) out[k] = safeText(incoming[k]);
    });

    if (Array.isArray(incoming.allowedOrigins)) out.allowedOrigins = incoming.allowedOrigins.slice(0, 50).map(String);
    if (Array.isArray(incoming.allowedOriginAssetIds)) out.allowedOriginAssetIds = incoming.allowedOriginAssetIds.slice(0, 100).map(String);

    if (isObject(incoming.asset_identity)) {
      out.asset_identity = out.asset_identity || {};
      if (typeof incoming.asset_identity.header_name === "string") out.asset_identity.header_name = safeText(incoming.asset_identity.header_name);
      if (isObject(incoming.asset_identity.origin_to_asset_id)) {
        out.asset_identity.origin_to_asset_id = { ...incoming.asset_identity.origin_to_asset_id };
      }
    }

    if (Array.isArray(incoming.requiredHeaders)) out.requiredHeaders = incoming.requiredHeaders.slice(0, 30).map(String);

    if (isObject(incoming.headers)) out.headers = { ...out.headers, ...incoming.headers };
    if (isObject(incoming.routes)) out.routes = { ...out.routes, ...incoming.routes };
    if (isObject(incoming.timeouts)) out.timeouts = { ...out.timeouts, ...incoming.timeouts };
    if (isObject(incoming.limits)) out.limits = { ...out.limits, ...incoming.limits };

    // normalize endpoints
    out.workerEndpoint = toBaseUrl(out.workerEndpoint);
    out.gatewayEndpoint = toBaseUrl(out.gatewayEndpoint);
    out.assistantEndpoint = safeText(out.assistantEndpoint);
    out.voiceEndpoint = safeText(out.voiceEndpoint);
    out.ttsEndpoint = safeText(out.ttsEndpoint);

    // ensure assistant/voice/tts endpoints align to base if missing
    const baseUrl = out.gatewayEndpoint || out.workerEndpoint || DEFAULT_WORKER_ORIGIN;
    if (!out.assistantEndpoint) out.assistantEndpoint = `${baseUrl}${out.routes.chat || "/api/chat"}`;
    if (!out.voiceEndpoint) out.voiceEndpoint = `${baseUrl}${out.routes.voice || "/api/voice"}`;
    if (!out.ttsEndpoint) out.ttsEndpoint = `${baseUrl}${out.routes.tts || "/api/tts"}`;

    return out;
  };

  const isAllowedEndpointOrigin = (targetUrl, config) => {
    try {
      const u = new URL(String(targetUrl), window.location.origin);
      const targetOrigin = u.origin.toLowerCase();
      const currentOrigin = normalizeOrigin(window.location.origin);
      if (targetOrigin === currentOrigin) return true;
      const allowed = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [];
      return allowed.some((o) => normalizeOrigin(o) === targetOrigin);
    } catch {
      return false;
    }
  };

  const deriveAssetIdForCurrentOrigin = (config) => {
    // Highest priority: window.OPS_ASSET_ID (already computed by app.js) if present
    const w = window;
    const pre = safeText(w.OPS_ASSET_ID || "");
    if (pre) return pre;

    // Otherwise use mapping in config
    const map = config?.asset_identity?.origin_to_asset_id || {};
    const key = normalizeOrigin(window.location.origin);
    for (const origin in map) {
      if (normalizeOrigin(origin) === key) return safeText(map[origin]);
    }
    return "";
  };

  const init = async () => {
    if (STATE.loaded) return;

    try {
      const cfg = await fetchJson(CONFIG_URL);
      STATE.config = mergeConfig(DEFAULT_CONFIG, cfg);

      // Optional: fetch registry (best-effort)
      const regPath = safeText(STATE.config.assetRegistry) || REGISTRY_URL_DEFAULT;
      try {
        STATE.registry = await fetchJson(regPath);
      } catch (e) {
        // registry is optional for runtime; don't fail init
        STATE.registry = null;
      }

      STATE.loaded = true;
      STATE.lastLoadAt = Date.now();
      STATE.lastError = "";
    } catch (e) {
      STATE.loaded = true; // prevent loops; app can still work with defaults
      STATE.lastLoadAt = Date.now();
      STATE.lastError = String(e?.message || e);
      STATE.config = { ...DEFAULT_CONFIG };
      STATE.registry = null;
      console.warn("WorkerClient init fallback:", STATE.lastError);
    }
  };

  const getConfig = () => ({ ...STATE.config });

  // -------------------------
  // Request header builder
  // -------------------------
  const buildBaseHeaders = (extra, config) => {
    const h = new Headers();

    // Required baseline
    h.set("accept", "text/event-stream");
    h.set("content-type", "application/json");

    // Asset identity: x-ops-asset-id
    const headerName = safeText(config?.asset_identity?.header_name || "x-ops-asset-id").toLowerCase();
    const assetId = deriveAssetIdForCurrentOrigin(config);
    if (assetId) h.set(headerName, assetId);


    // Merge caller-provided headers (case-insensitive merge)
    if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra)) {
        if (!k) continue;
        const key = String(k).trim();
        if (!key) continue;
        h.set(key, String(v ?? ""));
      }
    }

    return h;
  };

  const applyOptionalIntegrityHeader = (headers, config) => {
    const fromHeader = safeText(headers.get("x-ops-src-sha512-b64") || "");
    if (fromHeader) return;

    const windowCandidate = safeText(window.OPS_SRC_SHA512_B64 || window.__OPS_SRC_SHA512_B64__ || "");
    if (!windowCandidate) return;

    const integrityHeader = safeText(config?.headers?.optional_integrity_header || "x-ops-src-sha512-b64").toLowerCase();
    headers.set(integrityHeader, windowCandidate);
  };

  // -------------------------
  // Gateway input hardening (bypass TinyML in app.js)
  // -------------------------
  const sanitizeTextForGateway = (value) => {
    let text = String(value ?? "");
    text = text.replace(/\u0000/g, "");
    text = text.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
    text = text.replace(/\r\n?/g, "\n");

    text = text.replace(/```[\s\S]*?```/g, " ");
    text = text.replace(/~~~[\s\S]*?~~~/g, " ");
    text = text.replace(/`[^`]{1,250}`/g, " ");

    text = text.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ");
    text = text.replace(/<\s*(iframe|object|embed|link|meta|base|form|svg|math)\b[^>]*>/gi, " ");
    text = text.replace(/<\s*\/\s*(iframe|object|embed|link|meta|base|form|svg|math)\s*>/gi, " ");
    text = text.replace(/<[^>]+>/g, " ");

    text = text.replace(/\bjavascript\s*:/gi, "");
    text = text.replace(/\bvbscript\s*:/gi, "");
    text = text.replace(/\bdata\s*:\s*text\/html\b/gi, "");
    text = text.replace(/\bon\w+\s*=\s*["'][\s\S]*?["']/gi, " ");
    text = text.replace(/\bon\w+\s*=\s*[^\s>]+/gi, " ");

    text = text
      .split("\n")
      .map((line) => {
        const sample = line.trim();
        if (!sample) return "";
        const codeLike = /[{};=<>]/.test(sample) && /\b(function|class|import|export|return|const|let|var|async|await)\b/i.test(sample);
        return codeLike ? "" : sample;
      })
      .join(" ");

    text = text.replace(/\s+/g, " ").trim();
    if (text.length > MAX_MESSAGE_CHARS) text = text.slice(0, MAX_MESSAGE_CHARS);
    return text;
  };

  const sanitizeChatPayload = (payload) => {
    const body = isObject(payload) ? { ...payload } : {};
    const list = Array.isArray(body.messages) ? body.messages : [];
    const cleanedMessages = [];

    for (const item of list.slice(-MAX_MESSAGES)) {
      if (!isObject(item)) continue;
      const role = safeText(item.role || "").toLowerCase();
      if (role !== "user" && role !== "assistant") continue;

      const content = sanitizeTextForGateway(item.content);
      if (!content) continue;
      cleanedMessages.push({ role, content });
    }

    body.messages = cleanedMessages;
    body.meta = isObject(body.meta) ? { ...body.meta, tiny_ml_bypassed: true, gateway_sanitized: true } : { tiny_ml_bypassed: true, gateway_sanitized: true };
    return body;
  };

  // -------------------------
  // API calls
  // -------------------------
  const postChat = async (payload, opts) => {
    await init();
    const config = STATE.config;
    const endpoint = safeText(config.assistantEndpoint) || `${config.gatewayEndpoint}${config.routes.chat || "/api/chat"}`;

    if (!isAllowedEndpointOrigin(endpoint, config)) {
      return new Response(JSON.stringify({ error: "Endpoint origin not allowed" }), {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const signal = opts?.signal;
    const extraHeaders = opts?.extraHeaders || {};

    const headers = buildBaseHeaders(extraHeaders, config);
    applyOptionalIntegrityHeader(headers, config);

    // enforce request size limits (best-effort)
    const bodyText = JSON.stringify(sanitizeChatPayload(payload));
    const maxChars = Number(config?.limits?.max_body_chars || 8000);
    if (bodyText.length > maxChars) {
      return new Response(JSON.stringify({ error: "Request too large" }), {
        status: 413,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return fetch(endpoint, {
      method: "POST",
      headers,
      body: bodyText,
      signal,
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
    });
  };

  const postVoiceSTT = async (audioBlob, opts) => {
    await init();
    const config = STATE.config;
    const base = safeText(config.voiceEndpoint) || `${config.gatewayEndpoint}${config.routes.voice || "/api/voice"}`;
    const endpoint = `${base}?mode=stt`;

    if (!isAllowedEndpointOrigin(endpoint, config)) {
      return new Response(JSON.stringify({ error: "Endpoint origin not allowed" }), {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const signal = opts?.signal;
    const extraHeaders = opts?.extraHeaders || {};
    const headers = new Headers();

    // Asset identity header (same as chat)
    const headerName = safeText(config?.asset_identity?.header_name || "x-ops-asset-id").toLowerCase();
    const assetId = deriveAssetIdForCurrentOrigin(config);
    if (assetId) headers.set(headerName, assetId);


    // Accept JSON response
    headers.set("accept", "application/json");

    // Merge extra headers
    if (extraHeaders && typeof extraHeaders === "object") {
      for (const [k, v] of Object.entries(extraHeaders)) headers.set(String(k), String(v ?? ""));
    }
    applyOptionalIntegrityHeader(headers, config);

    // Size hint check (best-effort)
    const maxBytes = Number(config?.limits?.max_audio_bytes || 12 * 1024 * 1024);
    if (audioBlob && audioBlob.size > maxBytes) {
      return new Response(JSON.stringify({ error: "Audio too large" }), {
        status: 413,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return fetch(endpoint, {
      method: "POST",
      headers,
      body: audioBlob,
      signal,
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
    });
  };

  const postTTS = async (input, opts) => {
    await init();
    const config = STATE.config;
    const endpoint = safeText(config.ttsEndpoint) || `${config.gatewayEndpoint}${config.routes.tts || "/api/tts"}`;

    if (!isAllowedEndpointOrigin(endpoint, config)) {
      return new Response(JSON.stringify({ error: "Endpoint origin not allowed" }), {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const signal = opts?.signal;
    const extraHeaders = opts?.extraHeaders || {};

    const text = safeText(input?.text || "");
    const lang = safeText(input?.language || input?.lang_iso2 || "");

    const payload = { text, lang_iso2: lang || "en" };
    const bodyText = JSON.stringify(payload);

    const headers = new Headers();
    headers.set("accept", "audio/mpeg");
    headers.set("content-type", "application/json");

    // Asset identity
    const headerName = safeText(config?.asset_identity?.header_name || "x-ops-asset-id").toLowerCase();
    const assetId = deriveAssetIdForCurrentOrigin(config);
    if (assetId) headers.set(headerName, assetId);


    // Merge extras
    if (extraHeaders && typeof extraHeaders === "object") {
      for (const [k, v] of Object.entries(extraHeaders)) headers.set(String(k), String(v ?? ""));
    }
    applyOptionalIntegrityHeader(headers, config);

    return fetch(endpoint, {
      method: "POST",
      headers,
      body: bodyText,
      signal,
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
    });
  };

  // -------------------------
  // Expose API
  // -------------------------
  const WorkerClient = {
    init,
    getConfig,
    getRegistry: () => STATE.registry,
    getLastError: () => safeText(STATE.lastError),
    postChat,
    postVoiceSTT,
    postTTS,
  };

  // Attach
  window.WorkerClient = WorkerClient;
})();
