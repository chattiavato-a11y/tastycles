#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = process.cwd();
const ALLOWED_EXT = new Set([".js", ".json", ".html", ".css", ".txt", ".xml", ".md"]);
const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

const suspicious = [
  { id: "obfuscated_eval", re: /(?:window\s*\[\s*["']eval["']\s*\]|\beval\s*\()/i, severity: "high" },
  { id: "new_function", re: /\bnew\s+Function\s*\(/i, severity: "high" },
  { id: "data_html_uri", re: /data\s*:\s*text\/html/i, severity: "medium" },
  { id: "script_injection", re: /<\s*script\b/i, severity: "medium" },
  { id: "base64_blob", re: /[A-Za-z0-9+/]{800,}={0,2}/, severity: "low" },
];

const findings = [];
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = relative(ROOT, abs).replaceAll("\\", "/");
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (IGNORE_DIRS.has(entry)) continue;
      walk(abs);
      continue;
    }
    if (!ALLOWED_EXT.has(extname(entry).toLowerCase())) continue;
    files.push(rel);
  }
}

function ensureConfigIntegrity() {
  const cfgPath = "worker_files/worker.config.json";
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

  if (cfg.workerEndpointAssetId !== cfg.gatewayEndpointAssetId) {
    findings.push({ file: cfgPath, id: "endpoint_asset_mismatch", severity: "high", message: "workerEndpointAssetId and gatewayEndpointAssetId differ." });
  }

  const map = cfg.asset_identity?.origin_to_asset_id || {};
  for (const origin of cfg.allowedOrigins || []) {
    if (!map[origin]) {
      findings.push({ file: cfgPath, id: "origin_missing_asset", severity: "high", message: `Allowed origin missing asset identity mapping: ${origin}` });
    }
  }

  const handshake = cfg.actions_handshake;
  if (!handshake || typeof handshake !== "object") {
    findings.push({ file: cfgPath, id: "actions_handshake_missing", severity: "high", message: "actions_handshake configuration block is missing." });
    return;
  }

  const required = ["ready", "path", "header_name", "algorithm", "secret_name"];
  for (const k of required) {
    if (!String(handshake[k] ?? "").trim()) {
      findings.push({ file: cfgPath, id: "actions_handshake_incomplete", severity: "high", message: `actions_handshake.${k} is required.` });
    }
  }

  if (String(handshake.algorithm || "") !== "shared-secret-header") {
    findings.push({ file: cfgPath, id: "actions_handshake_algorithm_invalid", severity: "high", message: "actions_handshake.algorithm must be shared-secret-header to match gateway worker." });
  }

  if (String(handshake.path || "") !== "/__repo/handshake") {
    findings.push({ file: cfgPath, id: "actions_handshake_path_mismatch", severity: "high", message: "actions_handshake.path must be /__repo/handshake to match gateway worker." });
  }

  if (String(handshake.header_name || "").toLowerCase() !== "x-gabo-repo-id") {
    findings.push({ file: cfgPath, id: "actions_handshake_header_mismatch", severity: "high", message: "actions_handshake.header_name must be x-gabo-repo-id to match gateway worker." });
  }
}

walk(ROOT);
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const rule of suspicious) {
    if (rule.re.test(content)) {
      findings.push({ file, id: rule.id, severity: rule.severity, message: `Matched suspicious pattern: ${rule.id}` });
    }
  }
}

ensureConfigIntegrity();

const grouped = findings.filter((f) => !(
  f.id === "script_injection" && (f.file.endsWith("index.html") || f.file.endsWith("tinyml.guard.js"))
));

const high = grouped.filter((f) => f.severity === "high");

if (grouped.length) {
  console.log("Security/integrity findings:");
  for (const f of grouped) {
    console.log(`- [${f.severity}] ${f.file} :: ${f.id} :: ${f.message}`);
  }
} else {
  console.log("No suspicious findings.");
}

if (high.length) {
  console.error(`Blocking due to ${high.length} high-severity finding(s).`);
  process.exit(1);
}

console.log("Security integrity check completed.");
