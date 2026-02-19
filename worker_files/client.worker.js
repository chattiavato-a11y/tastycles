/**
 * worker_files/client.worker.js — WorkerClient (browser-side)
 *
 * Goals:
 * - Load canonical config from same-origin JSON (worker_files/worker.config.json)
 * - Enforce safe endpoint selection (https only, consistent origins)
 * - Attach required security headers (x-ops-asset-id, accept, content-type)
 * - Provide API helpers used by app.js:
 *     - WorkerClient.init()
 *     - WorkerClient.getConfig()
 *     - WorkerClient.postChat(payload, opts)
 *     - WorkerClient.postVoiceSTT(audioBlob, opts)
 *     - WorkerClient.postTTS(payload, opts)
 *
 * Optional (best-effort):
 * - If worker_files/registry.worker.config.json exists, verify SHA-512(hex)
 *   of worker_files/worker.config.json before trusting it.
 *
 * CSP-safe:
 * - No eval/new Function/inline script injection
 * - No dynamic script loading
 */

(() => {
  "use strict";

  // -------------------------
  // Paths (same-origin)
  // -------------------------
  const CONFIG_URL_PRIMARY = "worker_files/worker.config.json";
  const CONFIG_URL_FALLBACK = "worker.config.json"; // optional fallback if you keep a root copy
  const CONFIG_REGISTRY_RECORD_URL = "worker_files/registry.worker.config.json"; // optional (if present)

  // -------------------------
  // Limits (defensive)
  // -------------------------
  const MAX_JSON_BYTES = 250_000;
  const MAX_TEXT_BYTES = 800_000;

  // -------------------------
  // Internal state
  // -------------------------
  let _inited = false;
  let _config = null;

  // -------------------------
  // Tiny helpers
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

  function normalizeOrigin(value) {
    try {
      return new URL(String(value), window.location.href).origin.toLowerCase();
    } catch {
      return String(value || "")
        .trim()
        .replace(/\/$/, "")
        .toLowerCase();
    }
  }

  function isHttpsUrl(u) {
    try {
      const url = new URL(String(u), window.location.href);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function normalizeIso2(code) {
    const s = safeTextOnly(code || "").toLowerCase();
    if (!s) return "";
    const two = s.includes("-") ? s.split("-")[0] : s;
    return (two || "").slice(0, 2);
  }

  async function fetchTextSameOrigin(path, maxBytes) {
    const url = new URL(path, window.location.href).toString();
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
    });
    if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${path}`);
    const text = await res.text();
    if (text.length > (maxBytes || MAX_TEXT_BYTES)) throw new Error(`Response too large for ${path}`);
    return text;
  }

  function parseJsonStrict(text, label) {
    const raw = String(text || "");
    if (!raw) throw new Error(`Empty JSON (${label})`);
    if (raw.length > MAX_JSON_BYTES) throw new Error(`JSON too large (${label})`);
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON (${label})`);
    }
    if (!obj || typeof obj !== "object") throw new Error(`Bad JSON object (${label})`);
    return obj;
  }

  async function sha512Hex(text) {
    if (!window.crypto?.subtle) return "";
    const bytes = new TextEncoder().encode(String(text || ""));
    const digest = await crypto.subtle.digest("SHA-512", bytes);
    const u8 = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < u8.length; i++) {
      const b = u8[i].toString(16).padStart(2, "0");
      hex += b;
    }
    return hex;
  }

  function headersFrom(extra) {
    const h = new Headers();
    if (extra && typeof extra === "object") {
      Object.keys(extra).forEach((k) => {
        const key = String(k || "").trim();
        const val = String(extra[k] ?? "").trim();
        if (key && val) h.set(key, val);
      });
    }
    return h;
  }

  function mustString(x, label) {
    const v = safeTextOnly(x || "");
    if (!v) throw new Error(`${label} missing`);
    return v;
  }

  // -------------------------
  // Config validation / normalization
  // -------------------------
  function normalizeConfig(raw) {
    const cfg = raw && typeof raw === "object" ? raw : {};

    const workerEndpoint = safeTextOnly(cfg.workerEndpoint || "");
    const assistantEndpoint = safeTextOnly(cfg.assistantEndpoint || "");
    const voiceEndpoint = safeTextOnly(cfg.voiceEndpoint || "");
    const ttsEndpoint = safeTextOnly(cfg.ttsEndpoint || "");
    const gatewayEndpoint = safeTextOnly(cfg.gatewayEndpoint || "");

    const allowedOrigins = Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins.map(normalizeOrigin) : [];
    const requiredHeaders = Array.isArray(cfg.requiredHeaders)
      ? cfg.requiredHeaders.map((h) => safeTextOnly(h)).filter(Boolean)
      : [];

    const assetIdentity = cfg.asset_identity && typeof cfg.asset_identity === "object" ? cfg.asset_identity : {};
    const headerName = safeTextOnly(assetIdentity.header_name || "x-ops-asset-id").toLowerCase();

    const mapIn = assetIdentity.origin_to_asset_id && typeof assetIdentity.origin_to_asset_id === "object"
      ? assetIdentity.origin_to_asset_id
      : {};

    const originToAssetId = {};
    Object.keys(mapIn).forEach((k) => {
      const o = normalizeOrigin(k);
      const v = safeTextOnly(mapIn[k]);
      if (o && v) originToAssetId[o] = v;
    });

    // Prefer gatewayEndpoint if present, else derive from assistantEndpoint/workerEndpoint.
    let base = gatewayEndpoint || workerEndpoint || "";
    if (!base && assistantEndpoint) {
      try {
        const u = new URL(assistantEndpoint, window.location.href);
        base = u.origin;
      } catch {}
    }
    base = String(base || "").replace(/\/$/, "");

    // Ensure endpoints are https
    const finalWorker = workerEndpoint || base;
    const finalAssistant = assistantEndpoint || (base ? `${base}/api/chat` : "");
    const finalVoice = voiceEndpoint || (base ? `${base}/api/voice` : "");
    const finalTts = ttsEndpoint || (base ? `${base}/api/tts` : "");
    const finalGateway = gatewayEndpoint || base || finalWorker;

    // Hard checks (fail closed)
    if (!isHttpsUrl(finalGateway)) throw new Error("gatewayEndpoint must be https");
    if (!isHttpsUrl(finalAssistant)) throw new Error("assistantEndpoint must be https");
    if (!isHttpsUrl(finalVoice)) throw new Error("voiceEndpoint must be https");
    if (!isHttpsUrl(finalTts)) throw new Error("ttsEndpoint must be https");

    // Lock endpoints to same origin (prevents config swapping to a random host)
    const gwOrigin = normalizeOrigin(finalGateway);
    const aOrigin = normalizeOrigin(finalAssistant);
    const vOrigin = normalizeOrigin(finalVoice);
    const tOrigin = normalizeOrigin(finalTts);
    if (aOrigin !== gwOrigin || vOrigin !== gwOrigin || tOrigin !== gwOrigin) {
      throw new Error("Endpoints must share the same origin as gatewayEndpoint");
    }

    // Validate allowed origin list contains current origin (warn only; gateway enforces anyway)
    const currentOrigin = normalizeOrigin(window.location.origin);
    const originAllowed = allowedOrigins.includes(currentOrigin);

    return {
      workerEndpoint: finalWorker,
      gatewayEndpoint: finalGateway,
      assistantEndpoint: finalAssistant,
      voiceEndpoint: finalVoice,
      ttsEndpoint: finalTts,
      allowedOrigins,
      requiredHeaders,
      asset_identity: {
        header_name: headerName,
        origin_to_asset_id: originToAssetId,
      },
      _runtime: {
        currentOrigin,
        originAllowed,
      },
    };
  }

  async function maybeVerifyConfigIntegrity(configText) {
    // Best-effort: only if registry record exists and crypto is available.
    try {
      const regText = await fetchTextSameOrigin(CONFIG_REGISTRY_RECORD_URL, MAX_JSON_BYTES);
      const reg = parseJsonStrict(regText, "registry.worker.config.json");
      const expected = safeTextOnly(reg?.integrity?.sha512 || "");
      if (!expected || expected.length !== 128) return; // no strict record
      const got = await sha512Hex(configText);
      if (!got) return; // no crypto support
      if (got !== expected) throw new Error("worker.config.json integrity check failed (sha512 mismatch)");
    } catch (e) {
      // If the registry record is missing, skip silently.
      // If it exists but mismatches, we throw (fail closed).
      const msg = String(e?.message || e);
      if (msg.includes("Fetch failed (404)") || msg.includes("Fetch failed (403)")) return;
      if (msg.includes("integrity check failed")) throw e;
      // Other parse errors: skip (best-effort)
      return;
    }
  }

  // -------------------------
  // Public API
  // -------------------------
  async function init() {
    if (_inited && _config) return;

    // Try primary config location first
    let configText = "";
    try {
      configText = await fetchTextSameOrigin(CONFIG_URL_PRIMARY, MAX_JSON_BYTES);
    } catch {
      // fallback
      configText = await fetchTextSameOrigin(CONFIG_URL_FALLBACK, MAX_JSON_BYTES);
    }

    // Optional integrity verify (if registry record exists)
    await maybeVerifyConfigIntegrity(configText);

    const raw = parseJsonStrict(configText, "worker.config.json");
    _config = normalizeConfig(raw);
    _inited = true;
  }

  function getConfig() {
    return _config ? { ..._config } : {};
  }

  function getAssetIdForCurrentOrigin() {
    const cfg = _config;
    if (!cfg) return "";
    const currentOrigin = normalizeOrigin(window.location.origin);
    const map = cfg.asset_identity?.origin_to_asset_id || {};
    return safeTextOnly(map[currentOrigin] || "");
  }

  function buildRequiredHeaders(extraHeaders) {
    const cfg = _config || {};
    const currentOrigin = normalizeOrigin(window.location.origin);

    const base = headersFrom(extraHeaders);

    // Required by gateway
    const assetHeader = safeTextOnly(cfg.asset_identity?.header_name || "x-ops-asset-id").toLowerCase();
    const assetId = getAssetIdForCurrentOrigin();
    if (assetId) base.set(assetHeader, assetId);

    // Optional forward hint (gateway reads Origin naturally, but this can help in edge cases)
    if (!base.has("x-gabo-origin")) base.set("x-gabo-origin", currentOrigin);

    return base;
  }

  async function postChat(payload, opts) {
    await init();
    const cfg = _config;

    const url = mustString(cfg.assistantEndpoint, "assistantEndpoint");
    const h = buildRequiredHeaders(opts?.extraHeaders);

    h.set("content-type", "application/json");
    h.set("accept", "text/event-stream");

    return fetch(url, {
      method: "POST",
      headers: h,
      body: JSON.stringify(payload || {}),
      signal: opts?.signal,
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
    });
  }

  async function postVoiceSTT(audioBlob, opts) {
    await init();
    const cfg = _config;

    const base = mustString(cfg.voiceEndpoint, "voiceEndpoint");
    const url = `${String(base).replace(/\/$/, "")}?mode=stt`;

    const h = buildRequiredHeaders(opts?.extraHeaders);
    h.set("accept", "application/json");

    // If browser sets the content-type for Blob automatically, we keep it.
    // If Blob has a known type, set it explicitly.
    const ct = safeTextOnly(audioBlob?.type || "");
    if (ct) h.set("content-type", ct);

    return fetch(url, {
      method: "POST",
      headers: h,
      body: audioBlob,
      signal: opts?.signal,
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
    });
  }

  async function postTTS(payload, opts) {
    await init();
    const cfg = _config;

    const url = mustString(cfg.ttsEndpoint, "ttsEndpoint");
    const h = buildRequiredHeaders(opts?.extraHeaders);

    h.set("content-type", "application/json");
    h.set("accept", "audio/mpeg,application/octet-stream;q=0.9,*/*;q=0.1");

    const text = safeTextOnly(payload?.text || "");
    const lang = normalizeIso2(payload?.language || payload?.lang_iso2 || "");

    const body = {
      text,
      lang_iso2: lang || undefined,
    };

    return fetch(url, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: opts?.signal,
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
    });
  }

  // -------------------------
  // Expose
  // -------------------------
  window.WorkerClient = Object.freeze({
    init,
    getConfig,
    postChat,
    postVoiceSTT,
    postTTS,
  });
})();
