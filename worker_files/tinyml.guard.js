/* worker_files/tinyml.guard.js
 *
 * TinyML Guard (client-side) for CF Worker transit:
 * - Cleans + normalizes text
 * - Scans + scores risk (tiny “ML” heuristic classifier)
 * - Removes malicious markup + code blocks
 * - Optionally blocks “programming/code-like” payloads (STRICT)
 * - Produces SHA-512 base64 integrity digest for transit header
 *
 * Exposes:
 *   window.GABO_TINY_ML.evaluate(text, { mode })
 *   window.GABO_TINY_ML.digest(text)
 *   window.GABO_TINY_ML.headers({ assetId, languageHint, languageList, integrityB64 })
 *
 * Modes:
 *   - "strict"  : remove code blocks + block code-like payloads if still present
 *   - "clean"   : remove code blocks + allow if safe after sanitization
 *
 * Header names match your stack:
 *   x-ops-asset-id
 *   x-ops-src-sha512-b64
 *   x-gabo-lang-hint
 *   x-gabo-lang-list
 */

(function (global) {
  "use strict";

  const VERSION = "tinyml-guard-v1";

  // -------------------------
  // Limits (client-side)
  // -------------------------
  const LIMITS = {
    maxInputChars: 4_000,
    maxLineChars: 600,
    maxLines: 120,
  };

  // -------------------------
  // Risk patterns (weighted)
  // -------------------------
  const PATTERNS = [
    // XSS / HTML injection
    { id: "script_tag", re: /<\s*script\b/i, w: 8 },
    { id: "style_tag", re: /<\s*style\b/i, w: 5 },
    { id: "iframe_tag", re: /<\s*iframe\b/i, w: 7 },
    { id: "object_embed", re: /<\s*(object|embed)\b/i, w: 7 },
    { id: "svg_mathml", re: /<\s*(svg|math)\b/i, w: 6 },
    { id: "event_handler", re: /\bon\w+\s*=/i, w: 6 },
    { id: "js_scheme", re: /\bjavascript\s*:/i, w: 7 },
    { id: "vb_scheme", re: /\bvbscript\s*:/i, w: 7 },
    { id: "data_html", re: /\bdata\s*:\s*text\/html\b/i, w: 7 },

    // DOM exfil / browser attack surface
    { id: "document_cookie", re: /\bdocument\.cookie\b/i, w: 7 },
    { id: "document_write", re: /\bdocument\.write\b/i, w: 6 },
    { id: "local_storage", re: /\blocalStorage\b/i, w: 4 },
    { id: "session_storage", re: /\bsessionStorage\b/i, w: 4 },

    // Dangerous JS primitives
    { id: "eval", re: /\beval\s*\(/i, w: 7 },
    { id: "new_function", re: /\bnew\s+Function\b/i, w: 7 },
    { id: "settimeout_string", re: /\bsetTimeout\s*\(\s*["'`]/i, w: 6 },
    { id: "setinterval_string", re: /\bsetInterval\s*\(\s*["'`]/i, w: 6 },

    // SQL-ish injection signals (lightweight)
    { id: "sql_union", re: /\bunion\s+select\b/i, w: 4 },
    { id: "sql_drop", re: /\bdrop\s+table\b/i, w: 4 },
    { id: "sql_or_1", re: /\bor\s+1\s*=\s*1\b/i, w: 4 },

    // Code-like density
    { id: "many_braces", re: /[{}[\]]{6,}/, w: 3 },
    { id: "many_semi", re: /;{4,}/, w: 3 },
    { id: "arrow_fn", re: /=>/i, w: 2 },
    { id: "import_export", re: /\b(import|export)\b/i, w: 2 },
    { id: "fn_class_tokens", re: /\b(function|class|const|let|var|return)\b/i, w: 2 },

    // Base64 dumps / encoded payload hints
    { id: "base64_blob", re: /\b[A-Za-z0-9+/]{200,}={0,2}\b/, w: 3 },
  ];

  // -------------------------
  // Helpers
  // -------------------------
  function toStr(x) {
    return typeof x === "string" ? x : x == null ? "" : String(x);
  }

  function clampText(text) {
    let t = toStr(text);
    // Drop nulls + normalize newlines early
    t = t.replace(/\u0000/g, "");
    t = t.replace(/\r\n?/g, "\n");
    if (t.length > LIMITS.maxInputChars) t = t.slice(0, LIMITS.maxInputChars);
    return t;
  }

  function collapseWhitespace(text) {
    return toStr(text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function splitLines(text) {
    const lines = toStr(text).split("\n").slice(0, LIMITS.maxLines);
    return lines.map((l) => (l.length > LIMITS.maxLineChars ? l.slice(0, LIMITS.maxLineChars) : l));
  }

  function lineCodeDensity(line) {
    const s = toStr(line);
    if (!s) return 0;
    // Count code-ish punctuation
    const punct = (s.match(/[{}[\];=<>$]/g) || []).length;
    const words = (s.match(/[A-Za-z_]{2,}/g) || []).length;
    const hasQuotes = /["'`]/.test(s);
    // Higher when punctuation dominates
    let score = punct / Math.max(1, s.length);
    if (words >= 6 && punct >= 6) score += 0.06;
    if (hasQuotes && punct >= 6) score += 0.04;
    return score;
  }

  function stripDangerousMarkup(text) {
    let t = clampText(text);

    // Remove script/style blocks
    t = t.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ");

    // Remove dangerous tags (self-closing/open)
    t = t.replace(/<\s*(iframe|object|embed|link|meta|base|form|svg|math)\b[^>]*>/gi, " ");
    t = t.replace(/<\s*\/\s*(iframe|object|embed|link|meta|base|form|svg|math)\s*>/gi, " ");

    // Remove inline handlers
    t = t.replace(/\bon\w+\s*=\s*["'][\s\S]*?["']/gi, " ");
    t = t.replace(/\bon\w+\s*=\s*[^\s>]+/gi, " ");

    // Remove JS/VB/data-html schemes
    t = t.replace(/\bjavascript\s*:/gi, "");
    t = t.replace(/\bvbscript\s*:/gi, "");
    t = t.replace(/\bdata\s*:\s*text\/html\b/gi, "");

    // Remove any remaining tags (keep text content)
    t = t.replace(/<[^>]+>/g, " ");

    // Remove control chars except tab/newline
    t = t.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");

    return collapseWhitespace(t);
  }

  function stripCodeBlocks(text) {
    let t = toStr(text);

    // Remove fenced code blocks ```...``` and ~~~...~~~
    t = t.replace(/```[\s\S]*?```/g, " [REMOVED_CODE_BLOCK] ");
    t = t.replace(/~~~[\s\S]*?~~~/g, " [REMOVED_CODE_BLOCK] ");

    // Remove inline code `...`
    t = t.replace(/`[^`]{1,200}`/g, " [REMOVED_INLINE_CODE] ");

    // Remove <pre><code> blocks (if any survived)
    t = t.replace(/<\s*pre\b[^>]*>[\s\S]*?<\s*\/\s*pre\s*>/gi, " [REMOVED_CODE_BLOCK] ");
    t = t.replace(/<\s*code\b[^>]*>[\s\S]*?<\s*\/\s*code\s*>/gi, " [REMOVED_CODE_BLOCK] ");

    // Remove lines that are very code-dense
    const lines = splitLines(t);
    const kept = [];
    for (const line of lines) {
      const dens = lineCodeDensity(line);
      if (dens >= 0.12) {
        kept.push(" [REMOVED_CODE_LINE] ");
      } else {
        kept.push(line);
      }
    }

    return collapseWhitespace(kept.join("\n"));
  }

  function scoreRisk(text) {
    const sample = toStr(text);
    let score = 0;
    const hits = [];

    for (const p of PATTERNS) {
      if (p.re.test(sample)) {
        score += p.w;
        hits.push(p.id);
      }
    }

    // Length-based bump (very long input can hide payloads)
    if (sample.length > 600) score += 1;
    if (sample.length > 1200) score += 1;

    // Punctuation density bump
    const punct = (sample.match(/[{}[\];=<>$]/g) || []).length;
    if (punct >= 18) score += 2;

    return { score, hits };
  }

  function hasResidualMalicious(text) {
    const s = toStr(text);
    const checks = [
      /<\s*script\b/i,
      /\bon\w+\s*=/i,
      /\bjavascript\s*:/i,
      /\bdata\s*:\s*text\/html\b/i,
      /\beval\s*\(/i,
      /\bnew\s+Function\b/i,
      /\bdocument\.(cookie|write)\b/i,
      /<[^>]+>/, // any remaining tag-looking markup
    ];
    return checks.some((re) => re.test(s));
  }

  // -------------------------
  // Integrity digest (SHA-512 base64)
  // -------------------------
  async function sha512Base64(text) {
    const t = toStr(text);
    if (!t || !global.crypto || !global.crypto.subtle) return "";
    try {
      const bytes = new TextEncoder().encode(t);
      const hash = await global.crypto.subtle.digest("SHA-512", bytes);
      const u8 = new Uint8Array(hash);

      // Convert to base64 (no btoa on large arrays directly)
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < u8.length; i += chunk) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
      }
      return btoa(bin);
    } catch {
      return "";
    }
  }

  // -------------------------
  // Public API
  // -------------------------
  async function evaluate(rawText, opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const mode = (options.mode || "strict").toLowerCase(); // "strict" | "clean"

    // 1) Clamp and normalize
    const clamped = clampText(rawText);

    // 2) Strip dangerous markup
    const noMarkup = stripDangerousMarkup(clamped);

    // 3) Strip code blocks/lines (per your requirement)
    const noCode = stripCodeBlocks(noMarkup);

    // 4) Score risk BEFORE and AFTER
    const before = scoreRisk(clamped);
    const after = scoreRisk(noCode);

    // 5) Residual malicious checks
    const residual = hasResidualMalicious(noCode);

    // 6) Policy decision
    // Thresholds tuned for chat transit:
    // - Block if obvious malicious (residual or high score)
    // - In strict mode, block if still “code-ish” after cleaning (score too high)
    const highRisk = after.score >= 9 || before.score >= 12;
    const blocked =
      residual ||
      highRisk ||
      (mode === "strict" && (after.hits.includes("fn_class_tokens") || after.hits.includes("import_export")) && after.score >= 6);

    // 7) Integrity digest of sanitized content (what you actually send)
    const integrityB64 = await sha512Base64(noCode);

    return {
      ok: !blocked,
      version: VERSION,
      mode,
      input_chars: clamped.length,
      sanitized: noCode,
      integrity_sha512_b64: integrityB64,
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

  async function digest(text) {
    const cleaned = stripCodeBlocks(stripDangerousMarkup(clampText(text)));
    return sha512Base64(cleaned);
  }

  function headers(input) {
    const cfg = input && typeof input === "object" ? input : {};
    const assetId = toStr(cfg.assetId).trim();
    const languageHint = toStr(cfg.languageHint).trim();
    const languageList = Array.isArray(cfg.languageList) ? cfg.languageList.filter(Boolean).join(",") : toStr(cfg.languageList).trim();
    const integrityB64 = toStr(cfg.integrityB64).trim();

    const h = {};
    if (assetId) h["x-ops-asset-id"] = assetId;
    if (integrityB64) h["x-ops-src-sha512-b64"] = integrityB64;

    // Optional language hints (your gateway already supports these)
    if (languageHint) h["x-gabo-lang-hint"] = languageHint;
    if (languageList) h["x-gabo-lang-list"] = languageList;

    return h;
  }

  // Attach to window for your existing app.js usage pattern
  global.GABO_TINY_ML = {
    VERSION,
    evaluate,
    digest,
    headers,

    // Expose core utilities if you want them elsewhere
    _internal: {
      clampText,
      stripDangerousMarkup,
      stripCodeBlocks,
      scoreRisk,
      hasResidualMalicious,
      sha512Base64,
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
