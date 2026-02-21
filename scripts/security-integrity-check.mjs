#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = process.cwd();

// Only scan these file types (keeps noise low)
const ALLOWED_EXT = new Set([".js", ".mjs", ".json", ".html", ".css", ".txt", ".xml", ".md"]);
const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

// Patterns that should almost never exist in this repo.
// NOTE: Some patterns will appear in defensive sanitizer code; those are allow-listed later.
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

    const ext = extname(entry).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    files.push(rel);
  }
}

function ensureConfigIntegrity() {
  const cfgPath = "worker_files/worker.config.json";
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch (e) {
    findings.push({
      file: cfgPath,
      id: "worker_config_invalid_json",
      severity: "high",
      message: "worker_files/worker.config.json is not valid JSON.",
    });
    return;
  }

  // Endpoint asset IDs should match (your contract expects parity)
  if (cfg.workerEndpointAssetId !== cfg.gatewayEndpointAssetId) {
    findings.push({
      file: cfgPath,
      id: "endpoint_asset_mismatch",
      severity: "high",
      message: "workerEndpointAssetId and gatewayEndpointAssetId differ.",
    });
  }

  // Every allowed origin must have an asset identity mapping
  const map = cfg.asset_identity?.origin_to_asset_id || {};
  for (const origin of cfg.allowedOrigins || []) {
    if (!map[origin]) {
      findings.push({
        file: cfgPath,
        id: "origin_missing_asset",
        severity: "high",
        message: `Allowed origin missing asset identity mapping: ${origin}`,
      });
    }
  }

  // Handshake contract presence + alignment
  const handshake = cfg.actions_handshake;
  if (!handshake || typeof handshake !== "object") {
    findings.push({
      file: cfgPath,
      id: "actions_handshake_missing",
      severity: "high",
      message: "actions_handshake configuration block is missing.",
    });
    return;
  }

  const required = ["ready", "path", "header_name", "algorithm", "secret_name"];
  for (const k of required) {
    // ready is boolean; allow false but require existence
    if (k === "ready") {
      if (typeof handshake.ready !== "boolean") {
        findings.push({
          file: cfgPath,
          id: "actions_handshake_ready_invalid",
          severity: "high",
          message: "actions_handshake.ready must be a boolean.",
        });
      }
      continue;
    }

    if (!String(handshake[k] ?? "").trim()) {
      findings.push({
        file: cfgPath,
        id: "actions_handshake_incomplete",
        severity: "high",
        message: `actions_handshake.${k} is required.`,
      });
    }
  }

  if (String(handshake.algorithm || "") !== "shared-secret-header") {
    findings.push({
      file: cfgPath,
      id: "actions_handshake_algorithm_invalid",
      severity: "high",
      message: "actions_handshake.algorithm must be shared-secret-header to match gateway worker.",
    });
  }

  if (String(handshake.path || "") !== "/__repo/handshake") {
    findings.push({
      file: cfgPath,
      id: "actions_handshake_path_mismatch",
      severity: "high",
      message: "actions_handshake.path must be /__repo/handshake to match gateway worker.",
    });
  }

  if (String(handshake.header_name || "").toLowerCase() !== "x-gabo-repo-id") {
    findings.push({
      file: cfgPath,
      id: "actions_handshake_header_mismatch",
      severity: "high",
      message: "actions_handshake.header_name must be x-gabo-repo-id to match gateway worker.",
    });
  }
}

function isAllowedFalsePositive(finding) {
  const file = String(finding.file || "");
  const id = String(finding.id || "");

  // Allow <script patterns inside the HTML template and in sanitizer libraries
  if (id === "script_injection") {
    if (file.endsWith("index.html")) return true;
    if (file.endsWith("worker_files/tinyml.guard.js")) return true;
    if (file.endsWith("worker_files/drastic-measures.gateway.js")) return true;
  }

  // Allow base64-ish regexes inside sanitizer libraries (they match their own patterns)
  if (id === "base64_blob") {
    if (file.endsWith("worker_files/tinyml.guard.js")) return true;
    if (file.endsWith("worker_files/drastic-measures.gateway.js")) return true;
    if (file.endsWith("worker_files/client.worker.js")) return true; // has sha512 helper
  }

  return false;
}

walk(ROOT);

for (const file of files) {
  let content = "";
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const rule of suspicious) {
    if (rule.re.test(content)) {
      findings.push({
        file,
        id: rule.id,
        severity: rule.severity,
        message: `Matched suspicious pattern: ${rule.id}`,
      });
    }
  }
}

ensureConfigIntegrity();

// Filter allow-listed false positives
const grouped = findings.filter((f) => !isAllowedFalsePositive(f));

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
