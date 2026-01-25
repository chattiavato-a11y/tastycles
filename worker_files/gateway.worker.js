const DEFAULT_ALLOWED_ORIGINS = [];
const DEFAULT_REQUIRED_HEADERS = ["Accept", "X-Ops-Asset-Id"];
const MAX_BODY_BYTES = 250000;

const SECURITY_PATTERNS = [
  { id: "script-tag", pattern: /<\s*script[^>]*>[\s\S]*?<\s*\/\s*script>/gi },
  { id: "event-handler", pattern: /on\w+\s*=\s*"[^"]*"/gi },
  { id: "javascript-proto", pattern: /javascript:/gi },
  { id: "data-proto", pattern: /data:text\/html/gi },
  { id: "sql-comment", pattern: /(--|\/\*|\*\/)/g },
  { id: "cmd-chain", pattern: /(;|&&|\|\|)/g },
  { id: "template-injection", pattern: /\{\{.*?\}\}/g },
];

const normalizeAllowedOrigins = (raw) => {
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
};

const normalizeRequiredHeaders = (raw) => {
  if (!raw) return DEFAULT_REQUIRED_HEADERS;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
};

const buildCorsHeaders = (origin, allowedOrigins) => {
  const headers = new Headers();
  if (origin && allowedOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, X-Ops-Asset-Id"
  );
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
};

const applySecurityHeaders = (headers) => {
  if (!headers.has("Content-Security-Policy")) {
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    );
  }
  headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload"
  );
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
};

const ensureRequiredHeaders = (request, requiredHeaders) =>
  requiredHeaders.every((header) => request.headers.has(header));

const getRequiredHeadersForRequest = (request, requiredHeaders) => {
  const { pathname, searchParams } = new URL(request.url);
  if (pathname === "/api/voice" && searchParams.get("mode") === "stt") {
    return ["Accept", "X-Ops-Asset-Id"];
  }
  return requiredHeaders;
};

const isVoiceSttRequest = (request) => {
  const { pathname, searchParams } = new URL(request.url);
  return pathname === "/api/voice" && searchParams.get("mode") === "stt";
};

const sanitizeString = (value, findings) => {
  let sanitized = value.replace(/[\u0000-\u001F\u007F]/g, "");
  SECURITY_PATTERNS.forEach(({ id, pattern }) => {
    if (pattern.test(sanitized)) {
      findings.add(id);
      sanitized = sanitized.replace(pattern, "[redacted]");
    }
  });
  return sanitized.trim();
};

const sanitizeValue = (value, findings) => {
  if (typeof value === "string") {
    return sanitizeString(value, findings);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, findings));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).reduce((acc, [key, entry]) => {
      acc[key] = sanitizeValue(entry, findings);
      return acc;
    }, {});
  }
  return value;
};

const buildGeoContext = (request) => {
  const cf = request.cf || {};
  const country = cf.country || request.headers.get("CF-IPCountry") || "";
  return {
    country,
    region: cf.region || "",
    city: cf.city || "",
    timezone: cf.timezone || "",
    continent: cf.continent || "",
  };
};

const enrichPayload = (payload, request, findings, requestId) => {
  const meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {};
  const sanitizedMeta = sanitizeValue(meta, findings);
  const geo = buildGeoContext(request);
  const acceptLanguage = request.headers.get("Accept-Language") || "";
  return {
    ...payload,
    meta: {
      ...sanitizedMeta,
      gateway: {
        requestId,
        receivedAt: new Date().toISOString(),
        userAgent: request.headers.get("User-Agent") || "",
        ip: request.headers.get("CF-Connecting-IP") || "",
        acceptLanguage,
        geo,
        sanitized: findings.size > 0,
        findings: Array.from(findings),
      },
    },
  };
};

const buildTargetUrl = (requestUrl, enlaceUrl) => {
  const incoming = new URL(requestUrl);
  return new URL(`${incoming.pathname}${incoming.search}`, enlaceUrl);
};

export default {
  async fetch(request, env) {
    const allowedOrigins = normalizeAllowedOrigins(env.ALLOWED_ORIGINS);
    const requiredHeaders = normalizeRequiredHeaders(env.REQUIRED_HEADERS);
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = buildCorsHeaders(origin, allowedOrigins);
    const isVoiceStt = isVoiceSttRequest(request);

    if (request.method === "OPTIONS") {
      applySecurityHeaders(corsHeaders);
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (new URL(request.url).pathname === "/health") {
      const healthHeaders = new Headers(corsHeaders);
      healthHeaders.set("Content-Type", "application/json");
      applySecurityHeaders(healthHeaders);
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: healthHeaders,
      });
    }

    if (!env.ENLACE_URL) {
      const errorHeaders = new Headers(corsHeaders);
      applySecurityHeaders(errorHeaders);
      return new Response("ENLACE_URL is not configured.", {
        status: 500,
        headers: errorHeaders,
      });
    }

    if (request.method !== "POST") {
      const errorHeaders = new Headers(corsHeaders);
      applySecurityHeaders(errorHeaders);
      return new Response("Method Not Allowed", {
        status: 405,
        headers: errorHeaders,
      });
    }

    const requestRequiredHeaders = getRequiredHeadersForRequest(
      request,
      requiredHeaders
    );
    if (!ensureRequiredHeaders(request, requestRequiredHeaders)) {
      const errorHeaders = new Headers(corsHeaders);
      applySecurityHeaders(errorHeaders);
      return new Response("Missing required headers.", {
        status: 400,
        headers: errorHeaders,
      });
    }

    const contentType = request.headers.get("Content-Type") || "";
    const isJson = contentType.includes("application/json");
    if (!isJson && !isVoiceStt) {
      const errorHeaders = new Headers(corsHeaders);
      applySecurityHeaders(errorHeaders);
      return new Response("Unsupported content type.", {
        status: 415,
        headers: errorHeaders,
      });
    }

    const requestId = crypto.randomUUID();
    let upstreamResponse;
    const targetUrl = buildTargetUrl(request.url, env.ENLACE_URL);

    if (isVoiceStt && !isJson) {
      const rawBody = await request.arrayBuffer();
      if (rawBody.byteLength > MAX_BODY_BYTES) {
        const errorHeaders = new Headers(corsHeaders);
        applySecurityHeaders(errorHeaders);
        return new Response("Payload too large.", {
          status: 413,
          headers: errorHeaders,
        });
      }

      upstreamResponse = await fetch(targetUrl.toString(), {
        method: "POST",
        headers: {
          "Content-Type": contentType || "application/octet-stream",
          Accept: request.headers.get("Accept") || "application/json",
        },
        body: rawBody,
      });
    } else {
      const rawBody = await request.text();
      if (rawBody.length > MAX_BODY_BYTES) {
        const errorHeaders = new Headers(corsHeaders);
        applySecurityHeaders(errorHeaders);
        return new Response("Payload too large.", {
          status: 413,
          headers: errorHeaders,
        });
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (error) {
        const errorHeaders = new Headers(corsHeaders);
        applySecurityHeaders(errorHeaders);
        return new Response("Invalid JSON payload.", {
          status: 400,
          headers: errorHeaders,
        });
      }

      const findings = new Set();
      const sanitizedPayload = sanitizeValue(payload, findings);
      const forwardedPayload = enrichPayload(
        sanitizedPayload,
        request,
        findings,
        requestId
      );

      upstreamResponse = await fetch(targetUrl.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: request.headers.get("Accept") || "application/json",
        },
        body: JSON.stringify(forwardedPayload),
      });
    }

    const responseHeaders = new Headers(upstreamResponse.headers);
    corsHeaders.forEach((value, key) => responseHeaders.set(key, value));
    responseHeaders.set("X-Gateway-Request-Id", requestId);
    applySecurityHeaders(responseHeaders);

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
};
