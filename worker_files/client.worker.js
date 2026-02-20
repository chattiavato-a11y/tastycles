/* worker_files/client.worker.js
 *
 * Browser client for drastic-measures gateway.
 * Exposes:
 *   window.WorkerClient.init()
 *   window.WorkerClient.getConfig()
 *   window.WorkerClient.postChat(payload, { signal, extraHeaders })
 *   window.WorkerClient.postVoiceSTT(blobOrArrayBufferOrUint8, { signal, extraHeaders })
 *   window.WorkerClient.postTTS({ text, language|lang_iso2 }, { signal, extraHeaders })
 */

(function (global) {
  "use strict";

  const VERSION = "worker-client-v2";

  const DEFAULTS = {
    configUrl: "worker_files/worker.config.json",
    cache: "no-store",
    timeoutMs: 120000,
  };

  let _cfg = null;
  let _assetId = "";
  let _inited = false;

  function toStr(x) {
    return typeof x === "string" ? x : x == null ? "" : String(x);
  }

  function normalizeIso2(code) {
    const s = toStr(code).trim().toLowerCase();
    if (!s) return "";
    const two = s.includes("-") ? s.split("-")[0] : s;
    return (two || "").slice(0, 2);
  }

  function normalizeOrigin(value) {
    if (!value) return "";
    try {
      return new URL(String(value), global.location?.origin || "https://example.com").origin.toLowerCase();
    } catch {
      return String(value).trim().replace(/\/$/, "").toLowerCase();
    }
  }

  function deriveWorkerEndpoint(assistantEndpoint) {
    if (!assistantEndpoint) return "";
    try {
      const url = new URL(assistantEndpoint, global.location?.origin || "https://example.com");
      if (url.pathname.endsWith("/api/chat")) {
        url.pathname = url.pathname.replace(/\/api\/chat\/?$/, "");
      }
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      return "";
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
    return res.json();
  }

  async function init(opts) {
    if (_inited) return;

    const options = opts && typeof opts === "object" ? opts : {};
    const configUrl = toStr(options.configUrl || DEFAULTS.configUrl);

    const abs = new URL(configUrl, global.location?.href || "https://example.com/").toString();
    const cfg = await fetchJson(abs);

    // Normalize minimal fields
    const assistantEndpoint = cfg.assistantEndpoint || cfg.workerEndpoint ? `${cfg.workerEndpoint}/api/chat` : "";
    const voiceEndpoint = cfg.voiceEndpoint || (cfg.workerEndpoint ? `${cfg.workerEndpoint}/api/voice` : "");
    const ttsEndpoint = cfg.ttsEndpoint || (cfg.workerEndpoint ? `${cfg.workerEndpoint}/api/tts` : "");
    const workerEndpoint = cfg.workerEndpoint || deriveWorkerEndpoint(cfg.assistantEndpoint) || "";
    const gatewayEndpoint = cfg.gatewayEndpoint || workerEndpoint || "";

    _cfg = {
      ...cfg,
      workerEndpoint,
      gatewayEndpoint,
      assistantEndpoint: cfg.assistantEndpoint || assistantEndpoint,
      voiceEndpoint,
      ttsEndpoint,
      allowedOrigins: Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins.slice() : [],
      requiredHeaders: Array.isArray(cfg.requiredHeaders) ? cfg.requiredHeaders.slice() : ["Content-Type", "Accept", "X-Ops-Asset-Id"],
    };

    const origin = global.location?.origin || "";
    const id = getAssetIdForOrigin(_cfg, origin);
    _assetId = id.assetId || "";

    _inited = true;
  }

  function getConfig() {
    return _cfg ? { ..._cfg } : null;
  }

  function buildHeaders(base, extra) {
    const h = new Headers(base || {});
    const ex = extra && typeof extra === "object" ? extra : {};
    Object.keys(ex).forEach((k) => {
      const v = ex[k];
      if (v == null) return;
      h.set(k, String(v));
    });
    return h;
  }

  function withTimeout(signal, ms) {
    if (!ms || ms <= 0) return { signal, cancel: null };
    const controller = new AbortController();

    const onAbort = () => {
      try { controller.abort(); } catch {}
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const t = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, ms);

    return {
      signal: controller.signal,
      cancel: () => clearTimeout(t),
    };
  }

  async function postChat(payload, opts) {
    if (!_inited) await init();
    if (!_cfg?.assistantEndpoint) throw new Error("assistantEndpoint not configured.");

    const options = opts && typeof opts === "object" ? opts : {};
    const timeoutMs = Number(options.timeoutMs || DEFAULTS.timeoutMs) || DEFAULTS.timeoutMs;
    const { signal, cancel } = withTimeout(options.signal, timeoutMs);

    const base = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };

    // Required identity header
    if (_assetId) base["x-ops-asset-id"] = _assetId;

    const headers = buildHeaders(base, options.extraHeaders);

    try {
      return await fetch(_cfg.assistantEndpoint, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        redirect: "follow",
        signal,
        headers,
        body: JSON.stringify(payload || {}),
      });
    } finally {
      if (cancel) cancel();
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

    const base = { accept: "application/json" };
    if (_assetId) base["x-ops-asset-id"] = _assetId;
    if (contentType) base["content-type"] = contentType;

    const headers = buildHeaders(base, options.extraHeaders);

    try {
      return await fetch(endpoint, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        redirect: "follow",
        signal,
        headers,
        body,
      });
    } finally {
      if (cancel) cancel();
    }
  }

  async function postTTS(input, opts) {
    if (!_inited) await init();
    if (!_cfg?.ttsEndpoint) throw new Error("ttsEndpoint not configured.");

    const options = opts && typeof opts === "object" ? opts : {};
    const timeoutMs = Number(options.timeoutMs || DEFAULTS.timeoutMs) || DEFAULTS.timeoutMs;
    const { signal, cancel } = withTimeout(options.signal, timeoutMs);

    const obj = input && typeof input === "object" ? input : {};
    const text = toStr(obj.text).trim();
    const lang = normalizeIso2(obj.lang_iso2 || obj.language || "en") || "en";

    const base = {
      "content-type": "application/json",
      accept: "audio/mpeg, audio/*;q=0.9, */*;q=0.8",
    };
    if (_assetId) base["x-ops-asset-id"] = _assetId;

    const headers = buildHeaders(base, options.extraHeaders);


    // Merge extras
    if (extraHeaders && typeof extraHeaders === "object") {
      for (const [k, v] of Object.entries(extraHeaders)) headers.set(String(k), String(v ?? ""));
    }
  }

  global.WorkerClient = {
    VERSION,
    init,
    getConfig,
    postChat,
    postVoiceSTT,
    postTTS,
  };
})(typeof window !== "undefined" ? window : globalThis);
