/**
 * worker_files/client.worker.js — Repo UI → CF Gateway (drastic-measures)
 *
 * What this does:
 * - Loads worker.config.json (works from GitHub Pages subpaths like /tastycles/)
 * - Resolves endpoints (chat/voice/tts)
 * - Computes correct x-ops-asset-id for the CURRENT PAGE Origin
 * - Sends requests to the Worker with required headers
 * - Streams SSE safely (NO trimming, keeps payload intact)
 */

/* -------------------------
   0) Config loading (path-safe)
------------------------- */

const CONFIG_REL_PATH = "worker_files/worker.config.json";

let _cfgCache = null;
let _cfgCacheAt = 0;
const CFG_CACHE_TTL_MS = 60_000; // client-side cache only (safe)

/** Resolve config URL relative to the current page (supports GH Pages subpaths). */
function resolveConfigUrl() {
  return new URL(CONFIG_REL_PATH, document.baseURI).toString();
}

async function loadWorkerConfig(force = false) {
  const now = Date.now();
  if (!force && _cfgCache && now - _cfgCacheAt < CFG_CACHE_TTL_MS) return _cfgCache;

  const url = resolveConfigUrl();
  const resp = await fetch(url, { method: "GET", cache: "no-store" });
  if (!resp.ok) throw new Error(`worker.config.json fetch failed: ${resp.status}`);

  const cfg = await resp.json();
  _cfgCache = normalizeConfig(cfg);
  _cfgCacheAt = now;
  return _cfgCache;
}

function normalizeConfig(cfg) {
  const c = (cfg && typeof cfg === "object") ? cfg : {};
  const workerEndpoint = String(c.workerEndpoint || "").trim().replace(/\/$/, "");
  const assistantEndpoint = String(c.assistantEndpoint || "").trim();
  const voiceEndpoint = String(c.voiceEndpoint || "").trim();
  const ttsEndpoint = String(c.ttsEndpoint || "").trim();

  const out = {
    ...c,
    workerEndpoint,
    assistantEndpoint: assistantEndpoint || (workerEndpoint ? `${workerEndpoint}/api/chat` : ""),
    voiceEndpoint: voiceEndpoint || (workerEndpoint ? `${workerEndpoint}/api/voice` : ""),
    ttsEndpoint: ttsEndpoint || (workerEndpoint ? `${workerEndpoint}/api/tts` : ""),
    gatewayEndpoint: String(c.gatewayEndpoint || workerEndpoint || "").trim().replace(/\/$/, ""),
    requiredHeaders: Array.isArray(c.requiredHeaders) ? c.requiredHeaders : ["Content-Type", "Accept", "X-Ops-Asset-Id"],
    allowedOrigins: Array.isArray(c.allowedOrigins) ? c.allowedOrigins : [],
    allowedOriginAssetIds: Array.isArray(c.allowedOriginAssetIds) ? c.allowedOriginAssetIds : [],
  };

  if (!out.workerEndpoint) throw new Error("workerEndpoint missing in worker.config.json");
  if (!out.assistantEndpoint) throw new Error("assistantEndpoint could not be resolved");
  if (!out.voiceEndpoint) throw new Error("voiceEndpoint could not be resolved");
  if (!out.ttsEndpoint) throw new Error("ttsEndpoint could not be resolved");

  return out;
}

/* -------------------------
   1) Asset-ID (Origin → AssetId)
------------------------- */

function pageOrigin() {
  // Browser origin NEVER includes path; exactly what Worker checks.
  return String(window.location.origin || "").trim();
}

function resolveAssetIdForOrigin(cfg, origin) {
  const o = String(origin || "").trim();
  const origins = cfg.allowedOrigins || [];
  const ids = cfg.allowedOriginAssetIds || [];

  // strict positional mapping: origins[i] -> ids[i]
  for (let i = 0; i < origins.length; i++) {
    if (String(origins[i]).trim() === o) {
      const id = String(ids[i] || "").trim();
      return id;
    }
  }
  return "";
}

function buildHeaders(cfg, acceptValue, contentTypeValue) {
  const origin = pageOrigin();
  const assetId = resolveAssetIdForOrigin(cfg, origin);

  if (!assetId) {
    throw new Error(
      `No asset id mapping for Origin: ${origin}. Update worker.config.json allowedOrigins/allowedOriginAssetIds.`
    );
  }

  const h = new Headers();
  if (contentTypeValue) h.set("content-type", contentTypeValue);
  if (acceptValue) h.set("accept", acceptValue);

  // required by Worker
  h.set("x-ops-asset-id", assetId);

  return h;
}

/* -------------------------
   2) SSE parsing (payload-preserving)
------------------------- */

function splitSSEBlocks(buffer) {
  const blocks = [];
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    blocks.push(buffer.slice(0, idx));
    buffer = buffer.slice(idx + 2);
  }
  return { blocks, rest: buffer };
}

function parseSSEBlock(block) {
  const lines = String(block || "").split("\n");
  let event = "";
  const dataLines = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5)); // DO NOT trim payload
    // ignore ":" comments and other fields
  }

  return { event, data: dataLines.join("\n") };
}

async function streamSSEFromResponse(resp, onData) {
  const reader = resp.body?.getReader?.();
  if (!reader) throw new Error("Response body is not a readable stream");

  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      // normalize CRLF / CR → LF (matches gateway behavior)
      buf = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      const { blocks, rest } = splitSSEBlocks(buf);
      buf = rest;

      for (const b of blocks) {
        const { event, data } = parseSSEBlock(b);

        const dataTrim = String(data || "").trim();
        if (event === "done" || dataTrim === "[DONE]") return;

        if (event === "error") {
          throw new Error(dataTrim || "stream_error");
        }

        if (data !== "") onData(data); // keep payload exactly as provided
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

/* -------------------------
   3) Public API (Chat / Voice / TTS)
------------------------- */

/**
 * Chat (POST /api/chat)
 * @param {{messages:Array, meta?:Object, onDelta:(t:string)=>void, signal?:AbortSignal}} args
 */
export async function postChat(args) {
  const { messages, meta = {}, onDelta, signal } = args || {};
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("messages[] required");
  if (typeof onDelta !== "function") throw new Error("onDelta callback required");

  const cfg = await loadWorkerConfig(false);

  const headers = buildHeaders(cfg, "text/event-stream", "application/json; charset=utf-8");
  const body = JSON.stringify({ messages, meta });

  const resp = await fetch(cfg.assistantEndpoint, {
    method: "POST",
    headers,
    body,
    signal,
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`chat failed: ${resp.status} ${t.slice(0, 1200)}`);
  }

  await streamSSEFromResponse(resp, onDelta);
  return true;
}

/**
 * Voice STT (POST /api/voice?mode=stt)
 * Accepts Blob (recommended) or ArrayBuffer/Uint8Array
 * @param {{audio:Blob|ArrayBuffer|Uint8Array, signal?:AbortSignal}} args
 */
export async function postVoiceSTT(args) {
  const { audio, signal } = args || {};
  if (!audio) throw new Error("audio required");

  const cfg = await loadWorkerConfig(false);

  // For binary: DO NOT set content-type manually; browser will set if Blob has type.
  const headers = buildHeaders(cfg, "application/json", null);

  let body;
  if (audio instanceof Blob) body = audio;
  else if (audio instanceof Uint8Array) body = audio.buffer;
  else if (audio instanceof ArrayBuffer) body = audio;
  else throw new Error("audio must be Blob | ArrayBuffer | Uint8Array");

  const url = `${cfg.voiceEndpoint}?mode=stt`;
  const resp = await fetch(url, { method: "POST", headers, body, signal });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`voice stt failed: ${resp.status} ${t.slice(0, 1200)}`);
  }

  return resp.json();
}

/**
 * Voice Chat (POST /api/voice?mode=chat) — streams SSE deltas
 * @param {{audio:Blob|ArrayBuffer|Uint8Array, messages?:Array, meta?:Object, onDelta:(t:string)=>void, signal?:AbortSignal}} args
 */
export async function postVoiceChat(args) {
  const { audio, messages = [], meta = {}, onDelta, signal } = args || {};
  if (!audio) throw new Error("audio required");
  if (typeof onDelta !== "function") throw new Error("onDelta callback required");

  const cfg = await loadWorkerConfig(false);

  // Use JSON wrapper when you need to include prior messages/meta (most UIs do).
  const headers = buildHeaders(cfg, "text/event-stream", "application/json; charset=utf-8");

  // Prefer audio_b64 only if you already have it. Otherwise convert to bytes array (keeps serverless).
  let audioBytes;
  if (audio instanceof Blob) {
    const ab = await audio.arrayBuffer();
    audioBytes = Array.from(new Uint8Array(ab));
  } else if (audio instanceof Uint8Array) {
    audioBytes = Array.from(audio);
  } else if (audio instanceof ArrayBuffer) {
    audioBytes = Array.from(new Uint8Array(audio));
  } else {
    throw new Error("audio must be Blob | ArrayBuffer | Uint8Array");
  }

  const body = JSON.stringify({ messages, meta, audio: audioBytes });

  const url = `${cfg.voiceEndpoint}?mode=chat`;
  const resp = await fetch(url, { method: "POST", headers, body, signal });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`voice chat failed: ${resp.status} ${t.slice(0, 1200)}`);
  }

  await streamSSEFromResponse(resp, onDelta);
  return true;
}

/**
 * TTS (POST /api/tts) — returns { blob, contentType }
 * @param {{text:string, lang_iso2?:string, signal?:AbortSignal}} args
 */
export async function postTTS(args) {
  const { text, lang_iso2 = "en", signal } = args || {};
  const t = String(text || "").trim();
  if (!t) throw new Error("text required");

  const cfg = await loadWorkerConfig(false);

  const headers = buildHeaders(cfg, "audio/*", "application/json; charset=utf-8");
  const body = JSON.stringify({ text: t, lang_iso2 });

  const resp = await fetch(cfg.ttsEndpoint, { method: "POST", headers, body, signal });

  if (!resp.ok) {
    const e = await resp.text().catch(() => "");
    throw new Error(`tts failed: ${resp.status} ${e.slice(0, 1200)}`);
  }

  const ct = resp.headers.get("content-type") || "audio/mpeg";
  const blob = await resp.blob();
  return { blob, contentType: ct };
}

/* Optional: expose config getter for debugging/UI */
export async function getWorkerConfig(force = false) {
  return loadWorkerConfig(!!force);
}
