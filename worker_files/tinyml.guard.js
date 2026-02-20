// -------------------------
// TinyML (server-side parity with worker_files/tinyml.guard.js)
// -------------------------
const TINYML_VERSION = "tinyml-guard-v1";
const TINYML_LIMITS = {
  maxInputChars: 4_000,
  maxLineChars: 600,
  maxLines: 120,
};

const TINYML_PATTERNS = [
  { id: "script_tag", re: /<\s*script\b/i, w: 8 },
  { id: "style_tag", re: /<\s*style\b/i, w: 5 },
  { id: "iframe_tag", re: /<\s*iframe\b/i, w: 7 },
  { id: "object_embed", re: /<\s*(object|embed)\b/i, w: 7 },
  { id: "svg_mathml", re: /<\s*(svg|math)\b/i, w: 6 },
  { id: "event_handler", re: /\bon\w+\s*=/i, w: 6 },
  { id: "js_scheme", re: /\bjavascript\s*:/i, w: 7 },
  { id: "vb_scheme", re: /\bvbscript\s*:/i, w: 7 },
  { id: "data_html", re: /\bdata\s*:\s*text\/html\b/i, w: 7 },

  { id: "document_cookie", re: /\bdocument\.cookie\b/i, w: 7 },
  { id: "document_write", re: /\bdocument\.write\b/i, w: 6 },
  { id: "local_storage", re: /\blocalStorage\b/i, w: 4 },
  { id: "session_storage", re: /\bsessionStorage\b/i, w: 4 },

  { id: "eval", re: /\beval\s*\(/i, w: 7 },
  { id: "new_function", re: /\bnew\s+Function\b/i, w: 7 },
  { id: "settimeout_string", re: /\bsetTimeout\s*\(\s*["'`]/i, w: 6 },
  { id: "setinterval_string", re: /\bsetInterval\s*\(\s*["'`]/i, w: 6 },

  { id: "sql_union", re: /\bunion\s+select\b/i, w: 4 },
  { id: "sql_drop", re: /\bdrop\s+table\b/i, w: 4 },
  { id: "sql_or_1", re: /\bor\s+1\s*=\s*1\b/i, w: 4 },

  { id: "many_braces", re: /[{}[\]]{6,}/, w: 3 },
  { id: "many_semi", re: /;{4,}/, w: 3 },
  { id: "arrow_fn", re: /=>/i, w: 2 },
  { id: "import_export", re: /\b(import|export)\b/i, w: 2 },
  { id: "fn_class_tokens", re: /\b(function|class|const|let|var|return)\b/i, w: 2 },

  { id: "base64_blob", re: /\b[A-Za-z0-9+/]{200,}={0,2}\b/, w: 3 },
];

function tinyClampText(text) {
  let t = typeof text === "string" ? text : text == null ? "" : String(text);
  t = t.replace(/\u0000/g, "");
  t = t.replace(/\r\n?/g, "\n");
  if (t.length > TINYML_LIMITS.maxInputChars) t = t.slice(0, TINYML_LIMITS.maxInputChars);
  return t;
}

function tinyCollapseWhitespace(text) {
  const t = typeof text === "string" ? text : text == null ? "" : String(text);
  return t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function tinySplitLines(text) {
  const lines = (typeof text === "string" ? text : "").split("\n").slice(0, TINYML_LIMITS.maxLines);
  return lines.map((l) => (l.length > TINYML_LIMITS.maxLineChars ? l.slice(0, TINYML_LIMITS.maxLineChars) : l));
}

function tinyLineCodeDensity(line) {
  const s = typeof line === "string" ? line : "";
  if (!s) return 0;
  const punct = (s.match(/[{}[\];=<>$]/g) || []).length;
  const words = (s.match(/[A-Za-z_]{2,}/g) || []).length;
  const hasQuotes = /["'`]/.test(s);
  let score = punct / Math.max(1, s.length);
  if (words >= 6 && punct >= 6) score += 0.06;
  if (hasQuotes && punct >= 6) score += 0.04;
  return score;
}

function tinyStripDangerousMarkup(text) {
  let t = tinyClampText(text);

  t = t.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ");
  t = t.replace(/<\s*(iframe|object|embed|link|meta|base|form|svg|math)\b[^>]*>/gi, " ");
  t = t.replace(/<\s*\/\s*(iframe|object|embed|link|meta|base|form|svg|math)\s*>/gi, " ");

  t = t.replace(/\bon\w+\s*=\s*["'][\s\S]*?["']/gi, " ");
  t = t.replace(/\bon\w+\s*=\s*[^\s>]+/gi, " ");

  t = t.replace(/\bjavascript\s*:/gi, "");
  t = t.replace(/\bvbscript\s*:/gi, "");
  t = t.replace(/\bdata\s*:\s*text\/html\b/gi, "");

  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");

  return tinyCollapseWhitespace(t);
}

function tinyStripCodeBlocks(text) {
  let t = typeof text === "string" ? text : text == null ? "" : String(text);

  t = t.replace(/```[\s\S]*?```/g, " [REMOVED_CODE_BLOCK] ");
  t = t.replace(/~~~[\s\S]*?~~~/g, " [REMOVED_CODE_BLOCK] ");
  t = t.replace(/`[^`]{1,200}`/g, " [REMOVED_INLINE_CODE] ");

  t = t.replace(/<\s*pre\b[^>]*>[\s\S]*?<\s*\/\s*pre\s*>/gi, " [REMOVED_CODE_BLOCK] ");
  t = t.replace(/<\s*code\b[^>]*>[\s\S]*?<\s*\/\s*code\s*>/gi, " [REMOVED_CODE_BLOCK] ");

  const lines = tinySplitLines(t);
  const kept = [];
  for (const line of lines) {
    const dens = tinyLineCodeDensity(line);
    kept.push(dens >= 0.12 ? " [REMOVED_CODE_LINE] " : line);
  }

  return tinyCollapseWhitespace(kept.join("\n"));
}

function tinyScoreRisk(text) {
  const sample = typeof text === "string" ? text : text == null ? "" : String(text);
  let score = 0;
  const hits = [];

  for (const p of TINYML_PATTERNS) {
    if (p.re.test(sample)) {
      score += p.w;
      hits.push(p.id);
    }
  }

  if (sample.length > 600) score += 1;
  if (sample.length > 1200) score += 1;

  const punct = (sample.match(/[{}[\];=<>$]/g) || []).length;
  if (punct >= 18) score += 2;

  return { score, hits };
}

function tinyHasResidualMalicious(text) {
  const s = typeof text === "string" ? text : text == null ? "" : String(text);
  const checks = [
    /<\s*script\b/i,
    /\bon\w+\s*=/i,
    /\bjavascript\s*:/i,
    /\bdata\s*:\s*text\/html\b/i,
    /\beval\s*\(/i,
    /\bnew\s+Function\b/i,
    /\bdocument\.(cookie|write)\b/i,
    /<[^>]+>/,
  ];
  return checks.some((re) => re.test(s));
}

function tinySanitize(text) {
  return tinyStripCodeBlocks(tinyStripDangerousMarkup(tinyClampText(text)));
}

function tinyEvaluate(text, mode) {
  const m = String(mode || "strict").toLowerCase() === "clean" ? "clean" : "strict";

  const clamped = tinyClampText(text);
  const sanitized = tinySanitize(clamped);

  const before = tinyScoreRisk(clamped);
  const after = tinyScoreRisk(sanitized);
  const residual = tinyHasResidualMalicious(sanitized);

  const highRisk = after.score >= 9 || before.score >= 12;
  const blocked =
    residual ||
    highRisk ||
    (m === "strict" && (after.hits.includes("fn_class_tokens") || after.hits.includes("import_export")) && after.score >= 6);

  return {
    ok: !blocked,
    version: TINYML_VERSION,
    mode: m,
    sanitized,
    risk: {
      before_score: before.score,
      before_hits: before.hits,
      after_score: after.score,
      after_hits: after.hits,
      residual_malicious: residual,
    },
    decision: blocked ? "block" : "allow",
    reason: blocked
      ? residual
        ? "residual_malicious_content"
        : highRisk
          ? "risk_score_too_high"
          : "code_like_payload_blocked"
      : "sanitized_ok",
  };
}

async function sha512Base64(text) {
  const t = typeof text === "string" ? text : text == null ? "" : String(text);
  if (!t || !crypto?.subtle) return "";
  const bytes = new TextEncoder().encode(t);
  const hash = await crypto.subtle.digest("SHA-512", bytes);
  const u8 = new Uint8Array(hash);

  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function timingSafeEq(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x.length !== y.length) return false;
  let out = 0;
  for (let i = 0; i < x.length; i++) out |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return out === 0;
}
