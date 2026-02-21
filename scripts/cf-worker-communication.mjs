#!/usr/bin/env node
import { readFileSync } from "node:fs";

const DEFAULT_CONFIG_PATH = "worker_files/worker.config.json";

const TINY_ML_PATTERNS = [
  /<\s*script\b/i,
  /<\/?\s*(iframe|object|embed|svg|math|style|link|meta|base|form)\b/i,
  /javascript\s*:/i,
  /\b(vbscript|data\s*:\s*text\/html)\b/i,
  /\bon\w+\s*=/i,
  /\b(eval|Function|setTimeout\s*\(\s*["'`]|setInterval\s*\(\s*["'`])\b/i,
  /document\.(cookie|write)/i,
  /\b(import|export|class|function|return|const|let|var|async|await)\b/i,
  /```[\s\S]*?```|~~~[\s\S]*?~~~/,
];

const toSafeString = (value) => String(value ?? "").trim();

const tinyMlRiskScore = (text) => {
  const sample = String(text || "");
  let score = 0;
  TINY_ML_PATTERNS.forEach((pattern) => {
    if (pattern.test(sample)) score += 2;
  });
  if (sample.length > 2000) score += 1;
  return score;
};

const sanitizeText = (text) => {
  let out = String(text || "");
  out = out.replace(/\u0000/g, "");
  out = out.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  out = out.replace(/```[\s\S]*?```/g, " [removed_code_block] ");
  out = out.replace(/~~~[\s\S]*?~~~/g, " [removed_code_block] ");
  out = out.replace(/`[^`]{1,400}`/g, " [removed_inline_code] ");
  out = out.replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, " ");
  out = out.replace(/<\s*(iframe|object|embed|style|form|svg|math|link|meta|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ");
  out = out.replace(/<[^>]+>/g, " ");
  out = out.replace(/javascript\s*:/gi, "");
  out = out.replace(/vbscript\s*:/gi, "");
  out = out.replace(/data\s*:\s*text\/html/gi, "");
  out = out.replace(/\bon\w+\s*=\s*["'][\s\S]*?["']/gi, "");
  out = out.replace(/\bon\w+\s*=\s*[^\s>]+/gi, "");
  out = out.replace(/\s+/g, " ").trim();
  return out;
};

const sanitizeJsonLike = (value) => {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeJsonLike(entry));
  if (value && typeof value === "object") {
    const out = {};
    Object.entries(value).forEach(([key, entry]) => {
      out[sanitizeText(key)] = sanitizeJsonLike(entry);
    });
    return out;
  }
  return value;
};

const sanitizeHeaders = (headers) => {
  const out = {};
  Object.entries(headers || {}).forEach(([key, value]) => {
    const cleanKey = String(key || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!cleanKey) return;
    out[cleanKey] = sanitizeText(value);
  });
  return out;
};

const sanitizeBodyPayload = (body) => {
  if (body === undefined || body === null) return undefined;
  const raw = String(body);
  try {
    const parsed = JSON.parse(raw);
    const cleaned = sanitizeJsonLike(parsed);
    const serialized = JSON.stringify(cleaned);
    if (tinyMlRiskScore(serialized) >= 6) throw new Error("Tiny-ML blocked high-risk payload after sanitization.");
    return serialized;
  } catch {
    const cleanedText = sanitizeText(raw);
    if (tinyMlRiskScore(cleanedText) >= 6) throw new Error("Tiny-ML blocked high-risk raw payload.");
    return cleanedText;
  }
};

const normalizeRoutePath = (value, fallback) => {
  const raw = toSafeString(value || fallback || "");
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
};

const parseJsonFile = (path) => JSON.parse(readFileSync(path, "utf8"));

const createWorkerCommunication = ({ configPath = DEFAULT_CONFIG_PATH } = {}) => {
  const config = parseJsonFile(configPath);
  const endpoint = toSafeString(config.gatewayEndpoint || config.workerEndpoint).replace(/\/$/, "");

  if (!endpoint) {
    throw new Error(`Missing gatewayEndpoint/workerEndpoint in ${configPath}`);
  }

  const routes = {
    chat: normalizeRoutePath(config.routes?.chat, "/api/chat"),
    voice: normalizeRoutePath(config.routes?.voice, "/api/voice"),
    tts: normalizeRoutePath(config.routes?.tts, "/api/tts"),
    health: normalizeRoutePath(config.routes?.health, "/health"),
    handshake: normalizeRoutePath(config.actions_handshake?.path, "/__repo/handshake"),
  };

  const urlFor = (action) => {
    const path = routes[action];
    if (!path) throw new Error(`Unsupported action: ${action}`);
    return `${endpoint}${path}`;
  };

  const send = async (action, { method = "POST", headers = {}, body } = {}) => {
    const url = urlFor(action);
    const safeHeaders = sanitizeHeaders(headers);
    const safeBody = sanitizeBodyPayload(body);

    const response = await fetch(url, {
      method,
      headers: safeHeaders,
      body: safeBody,
    });
    return { url, response };
  };

  const handshake = async () => {
    const hs = config.actions_handshake || {};

    if (!hs.ready) {
      return {
        skipped: true,
        reason: "actions_handshake.ready is false",
      };
    }

    const algorithm = String(hs.algorithm || "shared-secret-header");
    if (algorithm !== "shared-secret-header") {
      throw new Error(`Unsupported handshake algorithm: ${algorithm}`);
    }

    const secretName = String(hs.secret_name || "DRASTIC_MEASURES");
    const secret = process.env[secretName];
    if (!secret) {
      throw new Error(`Missing required secret env: ${secretName}`);
    }

    const headerName = String(hs.header_name || "x-gabo-repo-id").trim().toLowerCase();
    const payload = sanitizeJsonLike({
      ok: true,
      from: "github-actions",
      workflow: process.env.GITHUB_WORKFLOW || "local",
      run_id: process.env.GITHUB_RUN_ID || "local",
      repo: process.env.GITHUB_REPOSITORY || "local",
    });

    const { url, response } = await send("handshake", {
      method: "POST",
      headers: {
        "x-gabo-repo-id": secret,
        "content-type": "application/json",
        "accept": "application/json",
        [headerName]: secret,
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text().catch(() => "");
    return { url, response, text };
  };

  return {
    config,
    endpoint,
    routes,
    urlFor,
    send,
    handshake,
  };
};

const parseArgs = (argv) => {
  const args = {
    action: "health",
    configPath: DEFAULT_CONFIG_PATH,
    body: "",
    method: "",
    headers: {},
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--action") {
      args.action = toSafeString(argv[i + 1] || args.action);
      i += 1;
    } else if (token === "--config") {
      args.configPath = toSafeString(argv[i + 1] || args.configPath);
      i += 1;
    } else if (token === "--method") {
      args.method = toSafeString(argv[i + 1] || "");
      i += 1;
    } else if (token === "--body") {
      args.body = String(argv[i + 1] || "");
      i += 1;
    } else if (token === "--header") {
      const raw = String(argv[i + 1] || "");
      const sep = raw.indexOf(":");
      if (sep > 0) {
        const key = raw.slice(0, sep).trim();
        const value = raw.slice(sep + 1).trim();
        if (key) args.headers[key] = value;
      }
      i += 1;
    }
  }

  return args;
};

const maybeJson = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return JSON.stringify(sanitizeJsonLike(JSON.parse(raw)));
  } catch {
    return sanitizeText(raw);
  }
};

const runCli = async () => {
  const args = parseArgs(process.argv.slice(2));
  const workerComm = createWorkerCommunication({ configPath: args.configPath });

  if (args.action === "handshake") {
    const result = await workerComm.handshake();
    if (result.skipped) {
      console.log(`Handshake skipped: ${result.reason}`);
      process.exit(0);
    }

    console.log(JSON.stringify({ action: "handshake", url: result.url, status: result.response.status, ok: result.response.ok, body: result.text.slice(0, 1000) }, null, 2));
    if (!result.response.ok) process.exit(1);
    return;
  }

  const defaultMethod = args.action === "health" ? "GET" : "POST";
  const method = args.method || defaultMethod;

  const body = method === "GET" || !args.body ? undefined : maybeJson(args.body);
  const headers = sanitizeHeaders({ ...args.headers });

  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }

  const { url, response } = await workerComm.send(args.action, { method, headers, body });
  const text = await response.text().catch(() => "");

  console.log(JSON.stringify({ action: args.action, method, url, status: response.status, ok: response.ok, body: text.slice(0, 1000) }, null, 2));
  if (!response.ok) process.exit(1);
};

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runCli().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}

export { createWorkerCommunication, DEFAULT_CONFIG_PATH };
