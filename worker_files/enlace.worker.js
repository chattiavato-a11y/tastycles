(() => {
  const DEFAULT_CONFIG = {
    assetRegistry: "worker_files/worker.assets.json",
    workerEndpoint: "https://drastic-measures.grabem-holdem-nuts-right.workers.dev",
    workerEndpointAssetId:
      "96dd27ea493d045ed9b46d72533e2ed2ec897668e2227dd3d79fff85ca2216a569c4bf622790c6fb0aab9f17b4e92d0f8e0fa040356bee68a9c3d50d5a60c945",
    allowedOrigins: [
      "https://www.gabo.io",
      "https://gabo.io",
      "https://drastic-measures.grabem-holdem-nuts-right.workers.dev",
    ],
    allowedOriginAssetIds: [
      "b91f605b23748de5cf02db0de2dd59117b31c709986a3c72837d0af8756473cf2779c206fc6ef80a57fdeddefa4ea11b972572f3a8edd9ed77900f9385e94bd6",
      "8cdeef86bd180277d5b080d571ad8e6dbad9595f408b58475faaa3161f07448fbf12799ee199e3ee257405b75de555055fd5f43e0ce75e0740c4dc11bf86d132",
      "96dd27ea493d045ed9b46d72533e2ed2ec897668e2227dd3d79fff85ca2216a569c4bf622790c6fb0aab9f17b4e92d0f8e0fa040356bee68a9c3d50d5a60c945",
    ],
  };

  const resolveConfigUrl = () => {
    const scriptUrl = document.currentScript?.src;
    if (scriptUrl) {
      return new URL("worker.config.json", scriptUrl).toString();
    }
    return new URL("worker_files/worker.config.json", window.location.href).toString();
  };

  const CONFIG_URL = resolveConfigUrl();
  let config = { ...DEFAULT_CONFIG };
  let originToAssetId = new Map();
  let assetRegistryEntries = [];
  let configPromise = null;

  const normalizeOrigin = (value) => {
    if (!value) return "";
    try {
      return new URL(String(value), window.location.origin).origin.toLowerCase();
    } catch (error) {
      return String(value).trim().replace(/\/$/, "").toLowerCase();
    }
  };

  const findAssetIdForOrigin = (origin) => {
    if (!origin) return "";
    const normalizedOrigin = normalizeOrigin(origin);
    const match = assetRegistryEntries.find((entry) => {
      const sourceOrigin = normalizeOrigin(entry?.source?.origin_url);
      const servingOrigin = normalizeOrigin(entry?.serving?.primary_url);
      const fallbackOrigin = normalizeOrigin(entry?.serving?.fallback_url);
      return (
        normalizedOrigin &&
        (normalizedOrigin === sourceOrigin ||
          normalizedOrigin === servingOrigin ||
          normalizedOrigin === fallbackOrigin)
      );
    });
    return match?.asset_id || "";
  };

  const rebuildOriginMap = () => {
    originToAssetId = new Map();
    config.allowedOrigins.forEach((origin, index) => {
      const assetId =
        findAssetIdForOrigin(origin) || config.allowedOriginAssetIds[index] || "";
      const normalizedOrigin = normalizeOrigin(origin);
      if (normalizedOrigin && assetId) {
        originToAssetId.set(normalizedOrigin, assetId);
      }
    });
  };

  const getAssetIdForOrigin = (origin = window.location.origin) =>
    originToAssetId.get(normalizeOrigin(origin)) ||
    findAssetIdForOrigin(origin) ||
    "";

  const getOverrideAssetId = (origin = window.location.origin) => {
    const directOverride = window.OPS_ASSET_ID;
    if (directOverride) return directOverride;
    const mapping = window.OPS_ASSET_BY_ORIGIN;
    if (mapping && typeof mapping === "object") {
      const normalizedOrigin = normalizeOrigin(origin);
      if (normalizedOrigin && mapping[normalizedOrigin]) {
        return mapping[normalizedOrigin];
      }
    }
    return "";
  };

  const loadAssetRegistry = async (registryUrl) => {
    const response = await fetch(registryUrl, { cache: "no-store" });
    if (!response.ok) return [];
    const registry = await response.json();
    if (Array.isArray(registry.assets)) return registry.assets;
    if (Array.isArray(registry)) return registry;
    return [];
  };

  const resolveAssetUrl = (assets, assetId) => {
    if (!assetId) return "";
    const asset = assets.find((entry) => entry.asset_id === assetId);
    return asset?.serving?.primary_url || asset?.source?.origin_url || "";
  };

  const loadConfig = async () => {
    try {
      const response = await fetch(CONFIG_URL, { cache: "no-store" });
      if (!response.ok) {
        rebuildOriginMap();
        return;
      }
      const data = await response.json();
      config = {
        ...config,
        ...data,
        allowedOrigins: Array.isArray(data.allowedOrigins)
          ? data.allowedOrigins
          : config.allowedOrigins,
        allowedOriginAssetIds: Array.isArray(data.allowedOriginAssetIds)
          ? data.allowedOriginAssetIds
          : config.allowedOriginAssetIds,
      };

      if (data.workerEndpointAssetId) {
        const registryUrl = data.assetRegistry || config.assetRegistry;
        const assets = await loadAssetRegistry(registryUrl);
        assetRegistryEntries = assets;
        const resolved = resolveAssetUrl(assets, data.workerEndpointAssetId);
        if (resolved) {
          config.workerEndpoint = resolved;
        }
      }

      if (!config.workerEndpoint && data.assistantEndpoint) {
        try {
          const assistantUrl = new URL(
            data.assistantEndpoint,
            window.location.origin
          );
          if (assistantUrl.pathname.endsWith("/api/chat")) {
            assistantUrl.pathname = assistantUrl.pathname.replace(
              /\/api\/chat\/?$/,
              ""
            );
          }
          assistantUrl.search = "";
          assistantUrl.hash = "";
          config.workerEndpoint = assistantUrl.toString().replace(/\/$/, "");
        } catch (error) {
          console.warn("Unable to parse assistant endpoint.", error);
        }
      }
    } catch (error) {
      console.warn("Unable to load Enlace repo config.", error);
    } finally {
      rebuildOriginMap();
    }
  };

  const init = async () => {
    if (!configPromise) {
      configPromise = loadConfig();
    }
    await configPromise;
  };

  const getEndpoint = () => config.workerEndpoint;
  const getConfig = () => ({ ...config });

  const buildHeaders = ({ accept, contentType, extraHeaders } = {}) => {
    const assetId = getOverrideAssetId() || getAssetIdForOrigin();
    if (!assetId) {
      throw new Error(
        `Origin not registered: ${window.location.origin}. Add it to worker.config.json allowedOrigins + allowedOriginAssetIds.`
      );
    }
    const headers = new Headers();
    if (accept) headers.set("Accept", accept);
    if (contentType) headers.set("Content-Type", contentType);
    headers.set("X-Ops-Asset-Id", assetId);
    if (extraHeaders) {
      Object.entries(extraHeaders).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          headers.set(key, value);
        }
      });
    }
    return headers;
  };

  const postChat = async (payload, options = {}) => {
    await init();
    const endpoint = getEndpoint();
    if (!endpoint) throw new Error("Worker endpoint not configured.");
    return fetch(`${endpoint}/api/chat`, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: buildHeaders({
        accept: "text/event-stream",
        contentType: "application/json",
        extraHeaders: options.extraHeaders,
      }),
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  };

  const postVoiceSTT = async (blob, options = {}) => {
    await init();
    const endpoint = getEndpoint();
    if (!endpoint) throw new Error("Worker endpoint not configured.");
    return fetch(`${endpoint}/api/voice?mode=stt`, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: buildHeaders({
        accept: "application/json",
        contentType: blob?.type || "audio/webm",
        extraHeaders: options.extraHeaders,
      }),
      body: blob,
      signal: options.signal,
    });
  };

  const postVoiceStream = async (payload, options = {}) => {
    await init();
    const endpoint = getEndpoint();
    if (!endpoint) throw new Error("Worker endpoint not configured.");
    return fetch(`${endpoint}/api/voice`, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: buildHeaders({
        accept: "text/event-stream",
        contentType: "application/json",
        extraHeaders: options.extraHeaders,
      }),
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  };

  const postTTS = async (payload, options = {}) => {
    await init();
    const endpoint = getEndpoint();
    if (!endpoint) throw new Error("Worker endpoint not configured.");
    return fetch(`${endpoint}/api/tts`, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: buildHeaders({
        accept: "audio/mpeg",
        contentType: "application/json",
        extraHeaders: options.extraHeaders,
      }),
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  };

  window.EnlaceRepo = {
    init,
    getConfig,
    getEndpoint,
    buildHeaders,
    postChat,
    postVoiceSTT,
    postVoiceStream,
    postTTS,
  };
})();
