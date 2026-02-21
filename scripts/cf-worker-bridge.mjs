#!/usr/bin/env node
import { readFileSync } from "node:fs";

const DEFAULT_CONFIG_PATH = "worker_files/worker.config.json";

const toSafeString = (value) => String(value ?? "").trim();

const normalizeRoutePath = (value, fallback) => {
  const raw = toSafeString(value || fallback || "");
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
};

const parseJsonFile = (path) => JSON.parse(readFileSync(path, "utf8"));

const createBridge = ({ configPath = DEFAULT_CONFIG_PATH } = {}) => {
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

  return {
    config,
    endpoint,
    routes,
    urlFor(action) {
      const path = routes[action];
      if (!path) throw new Error(`Unsupported action: ${action}`);
      return `${endpoint}${path}`;
    },
    async send(action, { method = "POST", headers = {}, body } = {}) {
      const url = this.urlFor(action);
      const response = await fetch(url, {
        method,
        headers,
        body,
      });
      return { url, response };
    },
  };
};

const parseArgs = (argv) => {
  const args = { action: "health", configPath: DEFAULT_CONFIG_PATH, body: "", method: "", headers: {} };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--action") args.action = toSafeString(argv[i + 1] || args.action), i += 1;
    else if (token === "--config") args.configPath = toSafeString(argv[i + 1] || args.configPath), i += 1;
    else if (token === "--method") args.method = toSafeString(argv[i + 1] || ""), i += 1;
    else if (token === "--body") args.body = String(argv[i + 1] || ""), i += 1;
    else if (token === "--header") {
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
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw;
  }
};

const runCli = async () => {
  const args = parseArgs(process.argv.slice(2));
  const bridge = createBridge({ configPath: args.configPath });

  const defaultMethod = args.action === "health" ? "GET" : "POST";
  const method = args.method || defaultMethod;

  const body = method === "GET" || !args.body ? undefined : maybeJson(args.body);
  const headers = { ...args.headers };

  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }

  const { url, response } = await bridge.send(args.action, { method, headers, body });
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

export { createBridge, DEFAULT_CONFIG_PATH };
