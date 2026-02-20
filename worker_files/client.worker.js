/* worker_files/client.worker.js
 *
 * Browser client for drastic-measures gateway.
 * Exposes:
 *   window.WorkerClient.init({ configUrl?, timeoutMs?, cache? })
 *   window.WorkerClient.getConfig()
 *   window.WorkerClient.getAssetId()
 *   window.WorkerClient.postChat(payload, { signal?, extraHeaders?, timeoutMs? })
 *   window.WorkerClient.postVoiceSTT(blob|arrayBuffer|uint8, { mode?, signal?, extraHeaders?, timeoutMs? })
 *   window.WorkerClient.postTTS({ text, language|lang_iso2 }, { signal?, extraHeaders?, timeoutMs? })
 *
 * Design goals:
 * - No inline/eval; CSP-friendly.
 * - Deterministic header building (x-ops-asset-id).
 * - Defensive config normalization + origin/asset mapping.
 * - Timeouts via AbortController.
 */

(function (global) {
  "use strict";

  const VERSION = "worker-client-v2.1";

  const DEFAULTS = {
    configUrl: "worker_files/worker.config.json",
    cache: "no-store",
    timeoutMs: 120000,
  };

  // Internal state
  let _cfg = null;
  let _assetId = "";
  let _origin = "";
  let _inited = false;

  // -------------------------
  // Small utils
  // -------------------------
  function toStr(x) {
    return typeof x === "string" ? x : x == null ? "" : String(x);
  }

  function safeText(x, maxLen) {
    let s = toStr(x).replace(/\u0000/g, "");
    s = s.replace(/\r\n?/g, "\n");
    s = s.trim();
    const lim = Number(maxLen || 0);
    if (lim > 0 && s.length > lim) s = s.slice(0, lim);
    return s;
  }

  function normalizeIso2(code) {
    const s = safeText(code, 16).toLowerCase();
    if (!s) return "";
    const two = s.includes("-") ? s.split("-")[0] : s;
    return safeText(two, 2);
  }

  function normalizeOrigin(value) {
    const v = toStr(value).trim();
    if (!v) return "";
    try {
      // Force origin parsing; supports full URL input.
      return new URL(v).origin.toLowerCase();
    } catch {
      // If caller passed just an origin-ish string.
      return v.replace(/\/$/, "").toLowerCase();
    }
  }

  function deriveWorkerEndpointFromAssistant(assistantEndpoint) {
    const a = toStr(assistantEndpoint).trim();
    if (!a) return "";
    try {
      const url = new URL(a, global.location && global.location.href ? global.location.href : "https://example.com/");
      if (/\/api\/chat\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/api\/chat\/?$/, "");
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      return "";
    }
  }

  async function fetchJson(url, cacheMode) {
    const res = await fetch(url, {
      method: "GET",
      mode: "cors",
      cache: cacheMode || DEFAULTS.cache,
      redirect: "follow",
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Config fetch failed (${res.status}): ${t.slice(0, 200)}`);
    }
    return await res.json();
  }

  function shallowCopy(obj) {
    if (!obj || typeof obj !== "object") return obj;
    return Array.isArray(obj) ? obj.slice() : Object.assign({}, obj);
  }

  // -------------------------
  // Asset identity
  // -------------------------
  function pickAssetIdForOrigin(cfg, origin) {
    const o = normalizeOrigin(origin);
    const map = cfg && cfg.asset_identity && cfg.asset_identity.origin_to_asset_id
      ? cfg.asset_identity.origin_to_asset_id
      : null;

    if (map && typeof map === "object") {
      // Exact match first
      if (map[o]) return safeText(map[o], 512);

      // Some people store with trailing slash; normalize lightly
      const o2 = o.replace(/\/$/, "");
      if (map[o2]) return safeText(map[o2], 512);
    }
    return "";
  }

  function buildHeaders(base, extra) {
    const h = new Headers();

    // base may be object or Headers
    if (base) {
      if (base instanceof Headers) {
        base.forEach((v, k) => h.set(k, v));
      } else if (typeof base === "object") {
        for (const [k, v] of Object.entries(base)) h.set(String(k), String(v));
      }
    }

    // extra merge (caller overrides)
    if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra)) {
        if (!k) continue;
        if (v == null) continue;
        h.set(String(k), String(v));
      }
    }

    return h;
  }

  function withTimeout(signal, ms) {
    const timeoutMs = Number(ms || 0);
    if (!timeoutMs || timeoutMs <= 0) return { signal: signal || null, cancel: null };

    const controller = new AbortController();

    function forwardAbort() {
      try { controller.abort(); } catch {}
    }

    if (signal) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }

    const t = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, timeoutMs);

    return { signal: controller.signal, cancel: () => clearTimeout(t) };
  }

  // Optional integrity helper (for request payloads; header is optional)
  async function sha512Base64(text) {
    const t = toStr(text);
    const subtle = global.crypto && global.crypto.subtle ? global.crypto.subtle : null;
    if (!t || !subtle) return "";
    const bytes = new TextEncoder().encode(t);
    const hash = await subtle.digest("SHA-512", bytes);
    const u8 = new Uint8Array(hash);

    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
    }
    return global.btoa(bin);
  }

  function getOptionalIntegrityHeaderName(cfg) {
    return safeText(cfg && cfg.headers && cfg.headers.optional_integrity_header ? cfg.headers.optional_integrity_header : "", 80);
  }

  // -------------------------
  // init + config normalization
  // -------------------------
  async function init(opts) {
    if (_inited) return;

    const options = opts && typeof opts === "object" ? opts : {};
    const configUrl = safeText(options.configUrl || DEFAULTS.configUrl, 260);
    const cacheMode = safeText(options.cache || DEFAULTS.cache, 40);

    const baseHref = global.location && global.location.href ? global.location.href : "https://example.com/";
    const abs = new URL(configUrl, baseHref).toString();

    const cfg0 = await fetchJson(abs, cacheMode);

    const workerEndpoint =
      safeText(cfg0.workerEndpoint, 600) ||
      deriveWorkerEndpointFromAssistant(cfg0.assistantEndpoint) ||
      safeText(cfg0.gatewayEndpoint, 600) ||
      "";

    const gatewayEndpoint = safeText(cfg0.gatewayEndpoint, 600) || workerEndpoint || "";

    const assistantEndpoint =
      safeText(cfg0.assistantEndpoint, 700) ||
      (workerEndpoint ? `${workerEndpoint.replace(/\/$/, "")}/api/chat` : "");

    const voiceEndpoint =
      safeText(cfg0.voiceEndpoint, 700) ||
      (workerEndpoint ? `${workerEndpoint.replace(/\/$/, "")}/api/voice` : "");

    const ttsEndpoint =
      safeText(cfg0.ttsEndpoint, 700) ||
      (workerEndpoint ? `${workerEndpoint.replace(/\/$/, "")}/api/tts` : "");

    const allowedOrigins = Array.isArray(cfg0.allowedOrigins) ? cfg0.allowedOrigins.map(normalizeOrigin).filter(Boolean) : [];

    const requiredHeaders = Array.isArray(cfg0.requiredHeaders)
      ? cfg0.requiredHeaders.map((x) => safeText(x, 80)).filter(Boolean)
      : ["Content-Type", "Accept", "X-Ops-Asset-Id"];

    _origin = normalizeOrigin(global.location && global.location.origin ? global.location.origin : "");
    _cfg = {
      ...cfg0,
      workerEndpoint,
      gatewayEndpoint,
      assistantEndpoint,
      voiceEndpoint,
      ttsEndpoint,
      allowedOrigins,
      requiredHeaders,
    };

    _assetId = pickAssetIdForOrigin(_cfg, _origin);
    _inited = true;
  }

  function ensureInited() {
    if (_inited) return Promise.resolve();
    return init();
  }

  function getConfig() {
    return _cfg ? JSON.parse(JSON.stringify(_cfg)) : null;
  }

  function getAssetId() {
    return _assetId || "";
  }

  // -------------------------
  // Requests
  // -------------------------
  async function postChat(payload, opts) {
    await ensureInited();
    if (!_cfg || !_cfg.assistantEndpoint) throw new Error("assistantEndpoint not configured.");

    const options = opts && typeof opts === "object" ? opts : {};
    const timeoutMs = Number(options.timeoutMs || DEFAULTS.timeoutMs) || DEFAULTS.timeoutMs;
    const { signal, cancel } = withTimeout(options.signal, timeoutMs);

    const bodyObj = payload && typeof payload === "object" ? payload : {};
    const bodyJson = JSON.stringify(bodyObj);

    const base = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };

    // Required identity header
    if (_assetId) base["x-ops-asset-id"] = _assetId;

    // Optional integrity header (caller may also override in extraHeaders)
    const integHeader = getOptionalIntegrityHeaderName(_cfg);
    if (integHeader && !options.extraHeaders?.[integHeader]) {
      // best-effort (safe if crypto.subtle unavailable -> "")
      const b64 = await sha512Base64(bodyJson);
      if (b64) base[integHeader] = b64;
    }

    const headers = buildHeaders(base, options.extraHeaders);

    try {
      return await fetch(_cfg.assistantEndpoint, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        redirect: "follow",
        signal: signal || undefined,
        headers,
        body: bodyJson,
      });
    } finally {
      if (cancel) cancel();
    }
  }

  async function postVoiceSTT(input, opts) {
    await ensureInited();
    if (!_cfg || !_cfg.voiceEndpoint) throw new Error("voiceEndpoint not configured.");

    const options = opts && typeof opts === "object" ? opts : {};
    const timeoutMs = Number(options.timeoutMs || DEFAULTS.timeoutMs) || DEFAULTS.timeoutMs;
    const { signal, cancel } = withTimeout(options.signal, timeoutMs);

    const mode = safeText(options.mode || "stt", 12).toLowerCase();
    const endpoint = mode === "chat"
      ? `${_cfg.voiceEndpoint}${_cfg.voiceEndpoint.includes("?") ? "&" : "?"}mode=chat`
      : `${_cfg.voiceEndpoint}${_cfg.voiceEndpoint.includes("?") ? "&" : "?"}mode=stt`;

    let body = null;
    let contentType = "";

    // Blob
    if (input && typeof global.Blob !== "undefined" && input instanceof Blob) {
      body = input;
      contentType = safeText(input.type || "", 120);
    }
    // ArrayBuffer
    else if (input && typeof input === "object" && input instanceof ArrayBuffer) {
      body = input;
      contentType = "application/octet-stream";
    }
    // Uint8Array (or other TypedArray views)
    else if (input && typeof input === "object" && (input instanceof Uint8Array || ArrayBuffer.isView(input))) {
      const u8 = input instanceof Uint8Array ? input : new Uint8Array(input.buffer);
      body = u8;
      contentType = "application/octet-stream";
    } else {
      throw new Error("postVoiceSTT expects a Blob, ArrayBuffer, or Uint8Array.");
    }

    const base = {
      accept: "application/json",
    };
    if (_assetId) base["x-ops-asset-id"] = _assetId;
    // Only set content-type when we actually know it; browser sets it for Blob automatically in many cases
    if (contentType && !(body instanceof Blob)) base["content-type"] = contentType;

    const headers = buildHeaders(base, options.extraHeaders);

    try {
      return await fetch(endpoint, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        redirect: "follow",
        signal: signal || undefined,
        headers,
        body,
      });
    } finally {
      if (cancel) cancel();
    }
  }

  async function postTTS(input, opts) {
    await ensureInited();
    if (!_cfg || !_cfg.ttsEndpoint) throw new Error("ttsEndpoint not configured.");

    const options = opts && typeof opts === "object" ? opts : {};
    const timeoutMs = Number(options.timeoutMs || DEFAULTS.timeoutMs) || DEFAULTS.timeoutMs;
    const { signal, cancel } = withTimeout(options.signal, timeoutMs);

    const obj = input && typeof input === "object" ? input : {};
    const text = safeText(obj.text, 8000);
    const lang = normalizeIso2(obj.lang_iso2 || obj.language || "en") || "en";
    if (!text) throw new Error("postTTS requires { text }.");

    const bodyJson = JSON.stringify({ text, lang_iso2: lang });

    const base = {
      "content-type": "application/json",
      accept: "audio/mpeg, audio/*;q=0.9, */*;q=0.8",
    };
    if (_assetId) base["x-ops-asset-id"] = _assetId;

    // Optional integrity header (best-effort)
    const integHeader = getOptionalIntegrityHeaderName(_cfg);
    if (integHeader && !options.extraHeaders?.[integHeader]) {
      const b64 = await sha512Base64(bodyJson);
      if (b64) base[integHeader] = b64;
    }

    const headers = buildHeaders(base, options.extraHeaders);

    try {
      return await fetch(_cfg.ttsEndpoint, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        redirect: "follow",
        signal: signal || undefined,
        headers,
        body: bodyJson,
      });
    } finally {
      if (cancel) cancel();
    }
  }

  // -------------------------
  // Export
  // -------------------------
  global.WorkerClient = {
    VERSION,
    init,
    getConfig,
    getAssetId,
    postChat,
    postVoiceSTT,
    postTTS,
  };
})(typeof window !== "undefined" ? window : globalThis);
