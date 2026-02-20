/* worker_files/tinyml.guard.js
 *
 * TinyML Guard (browser + worker + Node-compatible)
 * - Sanitizes untrusted text and strips code-like content
 * - Heuristically risk-scores payloads and can block suspicious input
 * - Detects honeypot submissions (DOM ids + payload keys)
 * - Computes SHA-512 integrity (base64)
 * - Builds hardened chat payload + optional contextual headers
 */

(function (root, factory) {
  "use strict";
  try {
    const api = factory(root);
    root.TinyMLGuard = api;
    if (typeof module === "object" && typeof module.exports !== "undefined") module.exports = api;
  } catch (e) {
    try { console.error("TinyMLGuard init failed:", e); } catch {}
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  const TINYML_VERSION = "tinyml-guard-v2";

  const TINYML_LIMITS = {
    maxInputChars: 4_000,
    maxLineChars: 600,
    maxLines: 120,
  };

  const HONEYPOT_DEFAULTS = {
    dom_ids: ["contact-field", "website-field"],
    payload_keys: ["contact", "website", "hp", "honeypot", "trap"],
    max_chars_allowed: 0,
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

  function toStr(x) {
    return typeof x === "string" ? x : x == null ? "" : String(x);
  }

  function clampText(text) {
    let t = toStr(text);
    t = t.replace(/\u0000/g, "");
    t = t.replace(/\r\n?/g, "\n");
    if (t.length > TINYML_LIMITS.maxInputChars) t = t.slice(0, TINYML_LIMITS.maxInputChars);
    return t;
  }

  function collapseWhitespace(text) {
    return toStr(text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function splitLines(text) {
    const lines = toStr(text).split("\n").slice(0, TINYML_LIMITS.maxLines);
    return lines.map((l) => (l.length > TINYML_LIMITS.maxLineChars ? l.slice(0, TINYML_LIMITS.maxLineChars) : l));
  }

  function lineCodeDensity(line) {
    const s = toStr(line);
    if (!s) return 0;
    const punct = (s.match(/[{}[\];=<>$]/g) || []).length;
    const words = (s.match(/[A-Za-z_]{2,}/g) || []).length;
    const hasQuotes = /["'`]/.test(s);
    let score = punct / Math.max(1, s.length);
    if (words >= 6 && punct >= 6) score += 0.06;
    if (hasQuotes && punct >= 6) score += 0.04;
    return score;
  }

  function stripDangerousMarkup(text) {
    let t = clampText(text);
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
    return collapseWhitespace(t);
  }

  function stripCodeBlocks(text) {
    let t = toStr(text);
    t = t.replace(/```[\s\S]*?```/g, " [REMOVED_CODE_BLOCK] ");
    t = t.replace(/~~~[\s\S]*?~~~/g, " [REMOVED_CODE_BLOCK] ");
    t = t.replace(/`[^`]{1,200}`/g, " [REMOVED_INLINE_CODE] ");
    t = t.replace(/<\s*pre\b[^>]*>[\s\S]*?<\s*\/\s*pre\s*>/gi, " [REMOVED_CODE_BLOCK] ");
    t = t.replace(/<\s*code\b[^>]*>[\s\S]*?<\s*\/\s*code\s*>/gi, " [REMOVED_CODE_BLOCK] ");

    const kept = [];
    for (const line of splitLines(t)) kept.push(lineCodeDensity(line) >= 0.12 ? " [REMOVED_CODE_LINE] " : line);
    return collapseWhitespace(kept.join("\n"));
  }

  function sanitize(text) {
    return stripCodeBlocks(stripDangerousMarkup(clampText(text)));
  }

  function scoreRisk(text) {
    const sample = toStr(text);
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
    if ((sample.match(/[{}[\];=<>$]/g) || []).length >= 18) score += 2;
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
      /<[^>]+>/,
    ];
    return checks.some((re) => re.test(s));
  }

  function evaluate(text, mode) {
    const m = String(mode || "strict").toLowerCase() === "clean" ? "clean" : "strict";
    const clamped = clampText(text);
    const sanitized = sanitize(clamped);
    const before = scoreRisk(clamped);
    const after = scoreRisk(sanitized);
    const residual = hasResidualMalicious(sanitized);

    const highRisk = after.score >= 9 || before.score >= 12;
    const strictCodeLike =
      (after.hits.includes("fn_class_tokens") || after.hits.includes("import_export")) && after.score >= 6;
    const blocked = residual || highRisk || (m === "strict" && strictCodeLike);

    return {
      ok: !blocked,
      version: TINYML_VERSION,
      mode: m,
      original: clamped,
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

  function safeTrimValue(v) {
    return collapseWhitespace(clampText(v)).slice(0, 256);
  }

  function readHoneypotsFromDom(domIds) {
    const out = {};
    if (typeof document === "undefined" || !Array.isArray(domIds)) return out;
    for (const id of domIds) {
      if (!id) continue;
      try {
        const el = document.getElementById(String(id));
        if (!el) continue;
        const val = typeof el.value === "string" ? el.value : el.getAttribute("value") || "";
        out[id] = safeTrimValue(val);
      } catch {}
    }
    return out;
  }

  function readHoneypotsFromPayload(payload, keys) {
    const out = {};
    const p = payload && typeof payload === "object" ? payload : null;
    if (!p || !Array.isArray(keys)) return out;
    for (const k of keys) {
      if (!k) continue;
      if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = safeTrimValue(p[k]);
    }
    return out;
  }

  function honeypotIsTripped(honeypotMap, maxAllowedChars) {
    const maxChars = Number.isFinite(maxAllowedChars) ? maxAllowedChars : 0;
    for (const [k, v] of Object.entries(honeypotMap || {})) {
      const s = toStr(v);
      if (s && s.length > maxChars) return { tripped: true, key: String(k), value_preview: s.slice(0, 40) };
    }
    return { tripped: false, key: "", value_preview: "" };
  }

  function evaluateHoneypots(payload, opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const cfg = {
      dom_ids: Array.isArray(options.dom_ids) ? options.dom_ids : HONEYPOT_DEFAULTS.dom_ids,
      payload_keys: Array.isArray(options.payload_keys) ? options.payload_keys : HONEYPOT_DEFAULTS.payload_keys,
      max_chars_allowed:
        typeof options.max_chars_allowed === "number" ? options.max_chars_allowed : HONEYPOT_DEFAULTS.max_chars_allowed,
    };

    const combined = {
      ...readHoneypotsFromPayload(payload, cfg.payload_keys),
      ...readHoneypotsFromDom(cfg.dom_ids),
    };
    const verdict = honeypotIsTripped(combined, cfg.max_chars_allowed);

    return {
      ok: !verdict.tripped,
      tripped: verdict.tripped,
      version: TINYML_VERSION,
      policy: cfg,
      evidence: verdict.tripped ? { tripped_key: verdict.key, value_preview: verdict.value_preview } : null,
      values_seen: Object.keys(combined),
    };
  }

  function base64EncodeBytes(u8) {
    if (typeof btoa === "function") {
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < u8.length; i += chunk) {
        bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
      }
      return btoa(bin);
    }

    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    const full = u8.length - (u8.length % 3);
    for (let i = 0; i < full; i += 3) {
      const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
      out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
    }

    const rem = u8.length % 3;
    if (rem === 1) {
      const n = u8[full] << 16;
      out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + "==";
    } else if (rem === 2) {
      const n = (u8[full] << 16) | (u8[full + 1] << 8);
      out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + "=";
    }

    return out;
  }

  async function sha512Base64(text) {
    const t = toStr(text);
    if (!t) return "";
    const subtle = root.crypto && root.crypto.subtle ? root.crypto.subtle : null;
    if (!subtle || typeof subtle.digest !== "function") return "";

    const bytes = new TextEncoder().encode(t);
    const hash = await subtle.digest("SHA-512", bytes);
    return base64EncodeBytes(new Uint8Array(hash));
  }

  function timingSafeEq(a, b) {
    const x = toStr(a);
    const y = toStr(b);
    if (x.length !== y.length) return false;
    let out = 0;
    for (let i = 0; i < x.length; i++) out |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return out === 0;
  }

  function collectPageSignals() {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    const loc = typeof location !== "undefined" ? location : null;
    return {
      origin: loc && loc.origin ? String(loc.origin) : "",
      path: loc && loc.pathname ? String(loc.pathname) : "",
      lang: nav && nav.language ? String(nav.language) : "",
      tz: (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
      })(),
      ua: nav && nav.userAgent ? String(nav.userAgent).slice(0, 180) : "",
    };
  }

  function readRepoIdentityValue() {
    try {
      if (typeof root.__DRASTIC_MEASURES__ === "string" && root.__DRASTIC_MEASURES__) return root.__DRASTIC_MEASURES__;
      if (typeof root.DRASTIC_MEASURES === "string" && root.DRASTIC_MEASURES) return root.DRASTIC_MEASURES;
      if (typeof document !== "undefined") {
        const el = document.querySelector('meta[name="gabo-repo-id"]');
        const v = el && el.getAttribute("content");
        if (v) return String(v);
      }
    } catch {}
    return "";
  }

  function buildRepoIdentityHeader(headerName) {
    const name = toStr(headerName || "x-gabo-repo-id").trim().toLowerCase();
    const value = toStr(readRepoIdentityValue()).trim();
    if (!name || !value) return null;
    return { [name]: value };
  }

  function normalizeMessages(messages, mode) {
    const arr = Array.isArray(messages) ? messages : [];
    const out = [];

    for (const m of arr) {
      if (!m || typeof m !== "object") continue;
      const role = toStr(m.role).toLowerCase();
      if (role !== "user" && role !== "assistant" && role !== "system") continue;

      const verdict = evaluate(m.content, mode);
      if (!verdict.ok) {
        out.push({ role, content: "[BLOCKED: suspicious content removed]" });
        continue;
      }

      if (verdict.sanitized) out.push({ role, content: verdict.sanitized });
    }

    return out;
  }

  function sanitizeMeta(meta) {
    const m = meta && typeof meta === "object" ? meta : {};
    const out = {};
    const allowKeys = ["lang_iso2", "spanish_quality", "translate_to", "model", "want_embeddings", "tinyml_mode"];
    for (const k of allowKeys) {
      if (!(k in m)) continue;
      const v = m[k];
      out[k] = typeof v === "boolean" ? v : sanitize(v).slice(0, 120);
    }
    return out;
  }

  function stableStringify(value) {
    const seen = new WeakSet();
    return JSON.stringify(value, function (k, v) {
      if (!v || typeof v !== "object" || Array.isArray(v)) return v;
      if (seen.has(v)) return null;
      seen.add(v);
      const sorted = {};
      for (const key of Object.keys(v).sort()) sorted[key] = v[key];
      return sorted;
    });
  }

  async function buildSecureChatPayload(payload, opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const mode = options.mode || "strict";
    const includePageSignals = options.includePageSignals !== false;
    const wantIntegrity = options.wantIntegrity !== false;

    const hp = evaluateHoneypots(payload, options.honeypot || {});
    if (!hp.ok) {
      return {
        ok: false,
        version: TINYML_VERSION,
        mode: String(mode),
        reason: "honeypot_tripped",
        honeypot: hp,
        payload: null,
        integrity_sha512_b64: "",
        extraHeaders: {},
      };
    }

    const p = payload && typeof payload === "object" ? payload : {};
    const out = {
      messages: normalizeMessages(p.messages, mode),
      meta: sanitizeMeta(p.meta),
    };
    if (includePageSignals) out.page_signals = collectPageSignals();

    const stableJson = stableStringify(out);
    const integrityB64 = wantIntegrity ? await sha512Base64(stableJson) : "";
    const extraHeaders = {};
    if (integrityB64) extraHeaders["x-ops-src-sha512-b64"] = integrityB64;

    const repoHeader = buildRepoIdentityHeader(options.repoHeaderName || "x-gabo-repo-id");
    if (repoHeader) {
      const k = Object.keys(repoHeader)[0];
      extraHeaders[k] = repoHeader[k];
    }

    return {
      ok: out.messages.length > 0,
      version: TINYML_VERSION,
      mode: String(mode),
      reason: out.messages.length > 0 ? "ok" : "no_messages",
      honeypot: hp,
      payload: out,
      integrity_sha512_b64: integrityB64,
      extraHeaders,
    };
  }

  return {
    VERSION: TINYML_VERSION,
    LIMITS: { ...TINYML_LIMITS },
    HONEYPOT_DEFAULTS: { ...HONEYPOT_DEFAULTS },

    clampText,
    sanitize,
    scoreRisk,
    evaluate,

    readHoneypotsFromDom,
    readHoneypotsFromPayload,
    evaluateHoneypots,

    sha512Base64,
    timingSafeEq,

    collectPageSignals,
    readRepoIdentityValue,
    buildRepoIdentityHeader,

    normalizeMessages,
    sanitizeMeta,
    buildSecureChatPayload,
  };
});
