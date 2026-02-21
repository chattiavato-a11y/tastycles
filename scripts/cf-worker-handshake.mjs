#!/usr/bin/env node
import { createBridge, DEFAULT_CONFIG_PATH } from "./cf-worker-bridge.mjs";

const bridge = createBridge({ configPath: DEFAULT_CONFIG_PATH });
const hs = bridge.config.actions_handshake || {};

if (!hs.ready) {
  console.log("Handshake skipped: actions_handshake.ready is false.");
  process.exit(0);
}

const algorithm = String(hs.algorithm || "shared-secret-header");
if (algorithm !== "shared-secret-header") {
  console.error(`Unsupported handshake algorithm: ${algorithm}`);
  process.exit(1);
}

const secretName = String(hs.secret_name || "DRASTIC_MEASURES");
const secret = process.env[secretName];
if (!secret) {
  console.error(`Missing required secret env: ${secretName}`);
  process.exit(1);
}

const headerName = String(hs.header_name || "x-gabo-repo-id").trim().toLowerCase();

const payload = {
  source: "github-actions",
  workflow: process.env.GITHUB_WORKFLOW || "local",
  run_id: process.env.GITHUB_RUN_ID || "local",
  repo: process.env.GITHUB_REPOSITORY || "local",
};

const { url, response } = await bridge.send("handshake", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    [headerName]: secret,
  },
  body: JSON.stringify(payload),
});

if (!response.ok) {
  const text = await response.text().catch(() => "");
  console.error(`Handshake failed (${response.status}) ${text.slice(0, 240)}`);
  process.exit(1);
}

console.log(`Handshake success: ${url}`);
