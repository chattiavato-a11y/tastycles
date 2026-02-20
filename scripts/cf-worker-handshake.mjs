#!/usr/bin/env node
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync("worker_files/worker.config.json", "utf8"));
const hs = cfg.actions_handshake || {};

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

const path = String(hs.path || "/__repo/handshake");
const base = String(cfg.gatewayEndpoint || cfg.workerEndpoint || "").replace(/\/$/, "");
if (!base) {
  console.error("Missing gatewayEndpoint/workerEndpoint in worker.config.json");
  process.exit(1);
}

const headerName = String(hs.header_name || "x-gabo-repo-id").trim().toLowerCase();
const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
const body = JSON.stringify({
  source: "github-actions",
  workflow: process.env.GITHUB_WORKFLOW || "local",
  run_id: process.env.GITHUB_RUN_ID || "local",
  repo: process.env.GITHUB_REPOSITORY || "local",
});

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    [headerName]: secret,
  },
  body,
});

if (!res.ok) {
  const text = await res.text().catch(() => "");
  console.error(`Handshake failed (${res.status}) ${text.slice(0, 240)}`);
  process.exit(1);
}

console.log(`Handshake success: ${url}`);
