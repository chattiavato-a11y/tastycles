const form = document.getElementById("chat-form");
const input = document.getElementById("msgInput");
const sendBtn = document.getElementById("send-btn");
const micBtn = document.getElementById("micBtn");
const chatLog = document.getElementById("chat-log");
const honeypotField = document.getElementById("website-field");
const preHoneypotField = document.getElementById("contact-field");
const dynamicHoneypotFields = new Set();

const thinkingStatus = document.getElementById("thinking-status");
const voiceHelper = document.getElementById("voice-helper");
const cancelBtn = document.getElementById("cancel-btn");

const HONEYPOT_HEADER_NAME = "x-gabo-honeypot";
const HONEYPOT_PRE_HEADER_NAME = "x-gabo-honeypot-pre";

const HONEYPOT_DYNAMIC_ATTR = "data-gabo-honeypot";
const HONEYPOT_DYNAMIC_VALUE_ATTR = "data-gabo-honeypot-value";

const hideHoneypotField = (field) => {
  if (!field) return;
  field.setAttribute("aria-hidden", "true");
  field.setAttribute("tabindex", "-1");
  field.setAttribute("autocomplete", "off");
  field.style.position = "absolute";
  field.style.left = "-9999px";
  field.style.width = "1px";
  field.style.height = "1px";
  field.style.margin = "0";
  field.style.padding = "0";
  field.style.border = "0";
  field.style.opacity = "0";
  field.style.pointerEvents = "none";
  field.style.clipPath = "inset(50%)";
  field.style.overflow = "hidden";
  field.style.whiteSpace = "nowrap";
};

// -------------------------
// Canonical runtime config (single source of truth)
// -------------------------
const CANONICAL_CONFIG_URL = "worker_files/worker.config.json";
let CANONICAL_CONFIG = null;

let OPS_ASSET_BY_ORIGIN = {};
let OPS_ASSET_ID = "";

let workerEndpoint = "";
let gatewayEndpoint = "";
let allowedOrigins = [];

window.OPS_ASSET_BY_ORIGIN = OPS_ASSET_BY_ORIGIN;
window.OPS_ASSET_ID = OPS_ASSET_ID;

function safeTextOnly(s) {
  s = String(s || "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue;
    const ok = c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160;
    if (ok) out += s[i];
  }
  return out.trim();
}

function normalizeOrigin(value) {
  if (!value) return "";
  try {
    return new URL(String(value), window.location.origin).origin.toLowerCase();
  } catch {
    return String(value).trim().replace(/\/$/, "").toLowerCase();
  }
}

function normalizeHeaderName(name) {
  return safeTextOnly(name || "").toLowerCase();
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function deriveWorkerEndpoint(assistantEndpoint) {
  if (!assistantEndpoint) return "";
  try {
    const url = new URL(assistantEndpoint, window.location.origin);
    if (url.pathname.endsWith("/api/chat")) {
      url.pathname = url.pathname.replace(/\/api\/chat\/?$/, "");
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    console.warn("Unable to parse assistant endpoint.", error);
  }
  return "";
}

function applyCanonicalConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return;

  CANONICAL_CONFIG = cfg;
  window.GABO_CONFIG = cfg;

  const cfgWorker = safeTextOnly(cfg.workerEndpoint || "") || safeTextOnly(cfg.gatewayEndpoint || "");
  const cfgGateway = safeTextOnly(cfg.gatewayEndpoint || "") || cfgWorker;

  workerEndpoint = cfgWorker || workerEndpoint;
  gatewayEndpoint = cfgGateway || gatewayEndpoint;

  const cfgAllowed = asArray(cfg.allowedOrigins).filter(Boolean);
  if (cfgAllowed.length) allowedOrigins = cfgAllowed;

  // Asset identity mapping
  const headerName = normalizeHeaderName(cfg.asset_identity?.header_name || "x-ops-asset-id");
  const mapRaw = cfg.asset_identity?.origin_to_asset_id;
  OPS_ASSET_BY_ORIGIN = mapRaw && typeof mapRaw === "object" ? mapRaw : {};

  const here = normalizeOrigin(window.location.origin);
  OPS_ASSET_ID = safeTextOnly(OPS_ASSET_BY_ORIGIN[here] || OPS_ASSET_BY_ORIGIN[window.location.origin] || "");

  window.OPS_ASSET_BY_ORIGIN = OPS_ASSET_BY_ORIGIN;
  window.OPS_ASSET_ID = OPS_ASSET_ID;
  window.OPS_ASSET_HEADER_NAME = headerName;
}

async function loadCanonicalConfig() {
  // 1) Prefer WorkerClient (if present)
  let cfg = null;

  if (window.WorkerClient?.init && window.WorkerClient?.getConfig) {
    try {
      await window.WorkerClient.init();
      cfg = window.WorkerClient.getConfig();
    } catch (e) {
      console.warn("WorkerClient init failed; falling back to direct config fetch.", e);
    }
  }

  // 2) Fallback: fetch canonical config directly (same-origin file)
  if (!cfg) {
    try {
      const res = await fetch(CANONICAL_CONFIG_URL, { cache: "no-store" });
      if (res.ok) cfg = await res.json();
    } catch (e) {
      console.warn("Unable to fetch canonical config.", e);
    }
  }

  if (cfg && typeof cfg === "object") {
    // If WorkerClient exists but returned only assistantEndpoint, derive workerEndpoint
    if (!cfg.workerEndpoint && cfg.assistantEndpoint) {
      const derived = deriveWorkerEndpoint(cfg.assistantEndpoint);
      if (derived) cfg.workerEndpoint = derived;
    }
    applyCanonicalConfig(cfg);
  }

  // Final safety fallback (only if config missing)
  if (!workerEndpoint && !gatewayEndpoint) {
    // Keep UI usable, but it will fail closed later if endpoints aren’t set.
    workerEndpoint = "";
    gatewayEndpoint = "";
  }
}

// -------------------------
// i18n
// -------------------------
const TRANSLATIONS = {
  en: {
    welcome: "Welcome",
    startConversation: "Start a conversation",
    introCopy:
      "Chat in any language — spoken or written. Gabo auto-detects your language and replies in kind.",
    greeting: "Hello",
    farewell: "Goodbye",
    gaboIntro:
      "Chat in any language — spoken or written. Gabo auto-detects your language and replies in kind.",
  },
  es: {
    welcome: "Bienvenido",
    startConversation: "Inicia una conversación",
    introCopy:
      "Chatea en cualquier idioma — hablado o escrito. Gabo detecta tu idioma y responde en el mismo.",
    greeting: "Hola",
    farewell: "Adiós",
    gaboIntro:
      "Chatea en cualquier idioma — hablado o escrito. Gabo detecta tu idioma y responde en el mismo.",
  },
  fr: {
    welcome: "Bienvenue",
    startConversation: "Commencez une conversation",
    introCopy:
      "Discutez dans n’importe quelle langue — parlée ou écrite. Gabo détecte votre langue et répond en conséquence.",
    greeting: "Bonjour",
    farewell: "Au revoir",
    gaboIntro:
      "Discutez dans n’importe quelle langue — parlée ou écrite. Gabo détecte votre langue et répond en conséquence.",
  },
  pt: {
    welcome: "Bem-vindo",
    startConversation: "Inicie uma conversa",
    introCopy:
      "Converse em qualquer idioma — falado ou escrito. Gabo detecta seu idioma e responde da mesma forma.",
    greeting: "Olá",
    farewell: "Tchau",
    gaboIntro:
      "Converse em qualquer idioma — falado ou escrito. Gabo detecta seu idioma e responde da mesma forma.",
  },
  ar: {
    welcome: "مرحبًا",
    startConversation: "ابدأ محادثة",
    introCopy:
      "تحدث بأي لغة — منطوقة أو مكتوبة. يكتشف Gabo لغتك ويرد بالمثل.",
    greeting: "مرحبًا",
    farewell: "مع السلامة",
    gaboIntro:
      "تحدث بأي لغة — منطوقة أو مكتوبة. يكتشف Gabo لغتك ويرد بالمثل.",
  },
  ru: {
    welcome: "Добро пожаловать",
    startConversation: "Начните разговор",
    introCopy:
      "Общайтесь на любом языке — устном или письменном. Gabo определяет ваш язык и отвечает тем же.",
    greeting: "Здравствуйте",
    farewell: "До свидания",
    gaboIntro:
      "Общайтесь на любом языке — устном или письменном. Gabo определяет ваш язык и отвечает тем же.",
  },
  zh: {
    welcome: "欢迎",
    startConversation: "开始对话",
    introCopy: "用任何语言交流——口语或书面语。Gabo 会自动识别你的语言并以相同语言回复。",
    greeting: "你好",
    farewell: "再见",
    gaboIntro:
      "用任何语言交流——口语或书面语。Gabo 会自动识别你的语言并以相同语言回复。",
  },
  yue: {
    welcome: "歡迎",
    startConversation: "開始對話",
    introCopy: "用任何語言交流——口語或書面語。Gabo 會自動識別你嘅語言並用相同語言回覆。",
    greeting: "你好",
    farewell: "再見",
    gaboIntro:
      "用任何語言交流——口語或書面語。Gabo 會自動識別你嘅語言並用相同語言回覆。",
  },
  de: {
    welcome: "Willkommen",
    startConversation: "Starten Sie ein Gespräch",
    introCopy:
      "Chatten Sie in jeder Sprache — gesprochen oder geschrieben. Gabo erkennt Ihre Sprache und antwortet entsprechend.",
    greeting: "Hallo",
    farewell: "Auf Wiedersehen",
    gaboIntro:
      "Chatten Sie in jeder Sprache — gesprochen oder geschrieben. Gabo erkennt Ihre Sprache und antwortet entsprechend.",
  },
  sv: {
    welcome: "Välkommen",
    startConversation: "Starta en konversation",
    introCopy:
      "Chatta på vilket språk som helst — talat eller skrivet. Gabo identifierar ditt språk och svarar på samma sätt.",
    greeting: "Hej",
    farewell: "Hej då",
    gaboIntro:
      "Chatta på vilket språk som helst — talat eller skrivet. Gabo identifierar ditt språk och svarar på samma sätt.",
  },
  no: {
    welcome: "Velkommen",
    startConversation: "Start en samtale",
    introCopy:
      "Chat på hvilket som helst språk — muntlig eller skriftlig. Gabo oppdager språket ditt og svarer på samme måte.",
    greeting: "Hei",
    farewell: "Ha det",
    gaboIntro:
      "Chat på hvilket som helst språk — muntlig eller skriftlig. Gabo oppdager språket ditt og svarer på samme måte.",
  },
  fi: {
    welcome: "Tervetuloa",
    startConversation: "Aloita keskustelu",
    introCopy:
      "Keskustele millä tahansa kielellä — puhuttuna tai kirjoitettuna. Gabo tunnistaa kielesi ja vastaa samalla kielellä.",
    greeting: "Hei",
    farewell: "Näkemiin",
    gaboIntro:
      "Keskustele millä tahansa kielellä — puhuttuna tai kirjoitettuna. Gabo tunnistaa kielesi ja vastaa samalla kielellä.",
  },
  tl: {
    welcome: "Maligayang pagdating",
    startConversation: "Simulan ang usapan",
    introCopy:
      "Makipag-chat sa anumang wika — pasalita man o pasulat. Awtomatikong kinikilala ng Gabo ang iyong wika at sumasagot nang naaayon.",
    greeting: "Kamusta",
    farewell: "Paalam",
    gaboIntro:
      "Makipag-chat sa anumang wika — pasalita man o pasulat. Awtomatikong kinikilala ng Gabo ang iyong wika at sumasagot nang naaayon.",
  },
  ja: {
    welcome: "ようこそ",
    startConversation: "会話を始める",
    introCopy:
      "どの言語でも会話できます — 話し言葉でも書き言葉でも。Gabo が言語を自動判別し、同じ言語で返信します。",
    greeting: "こんにちは",
    farewell: "さようなら",
    gaboIntro:
      "どの言語でも会話できます — 話し言葉でも書き言葉でも。Gabo が言語を自動判別し、同じ言語で返信します。",
  },
};

const RTL_CHARACTERS = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
const getTextDirection = (text) => (RTL_CHARACTERS.test(text) ? "rtl" : "ltr");
const normalizeLocale = (value) => (value ? String(value).toLowerCase().split("-")[0] : "");

const getPreferredLocale = () => {
  const languages = Array.isArray(navigator.languages) ? navigator.languages.filter(Boolean) : [];
  const primary = navigator.language || languages[0] || "en";
  const normalized = normalizeLocale(primary);
  return TRANSLATIONS[normalized] ? normalized : "en";
};

let currentLocale = getPreferredLocale();
const t = (key) => TRANSLATIONS[currentLocale]?.[key] ?? TRANSLATIONS.en[key] ?? "";

const applyTranslations = () => {
  document.documentElement.lang = currentLocale;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    const value = t(key);
    if (value) el.textContent = value;
  });
  document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    const raw = el.getAttribute("data-i18n-attr") || "";
    raw.split(",").forEach((pair) => {
      const [attr, key] = pair.split(":").map((part) => part.trim());
      if (!attr || !key) return;
      const value = t(key);
      if (value) el.setAttribute(attr, value);
    });
  });
};

const INTRO_I18N_KEYS = ["welcome", "startConversation", "introCopy"];
const INTRO_ROTATION_LOCALES = ["es", "pt", "en", "fr", "de", "fr", "tl", "zh", "ja", "yue"];

const setIntroLocale = (locale) => {
  const pack = TRANSLATIONS[locale] ?? TRANSLATIONS.en;
  INTRO_I18N_KEYS.forEach((key) => {
    const value = pack[key];
    if (!value) return;
    document.querySelectorAll(`[data-i18n="${key}"]`).forEach((el) => {
      el.textContent = value;
      el.setAttribute("lang", locale);
      el.setAttribute("dir", getTextDirection(value));
    });
  });
};

const startIntroRotation = () => {
  if (!INTRO_ROTATION_LOCALES.length) return;
  const preferred = getPreferredLocale();
  let index = INTRO_ROTATION_LOCALES.indexOf(preferred);
  if (index < 0) index = 0;
  setIntroLocale(INTRO_ROTATION_LOCALES[index]);
  window.setInterval(() => {
    index = (index + 1) % INTRO_ROTATION_LOCALES.length;
    setIntroLocale(INTRO_ROTATION_LOCALES[index]);
  }, 30000);
};

// -------------------------
// UI gradient rotation
// -------------------------
const PAGE_GRADIENTS = [
  "linear-gradient(135deg, rgba(187, 247, 208, 0.68) 0%, rgba(134, 239, 172, 0.62) 45%, rgba(167, 243, 208, 0.58) 100%)",
  "linear-gradient(140deg, rgba(254, 240, 138, 0.62) 0%, rgba(252, 211, 77, 0.58) 40%, rgba(253, 186, 116, 0.55) 100%)",
  "linear-gradient(145deg, rgba(191, 219, 254, 0.62) 0%, rgba(165, 243, 252, 0.58) 45%, rgba(186, 230, 253, 0.54) 100%)",
  "linear-gradient(135deg, rgba(221, 214, 254, 0.6) 0%, rgba(196, 181, 253, 0.56) 50%, rgba(199, 210, 254, 0.52) 100%)",
];

const rotateBackgroundGradient = () => {
  const root = document.documentElement;
  if (!root) return;
  let gradientIndex = 0;
  root.style.setProperty("--page-gradient", PAGE_GRADIENTS[gradientIndex]);
  window.setInterval(() => {
    gradientIndex = (gradientIndex + 1) % PAGE_GRADIENTS.length;
    root.style.setProperty("--page-gradient", PAGE_GRADIENTS[gradientIndex]);
  }, 10000);
};

rotateBackgroundGradient();
applyTranslations();
startIntroRotation();
hideHoneypotField(honeypotField);
hideHoneypotField(preHoneypotField);

// -------------------------
// Streaming state + thinking UI
// -------------------------
let isStreaming = false;
let activeController = null;
let activeAssistantBubble = null;

const thinkingFrames = ["Thinking.", "Thinking..", "Thinking...", "Thinking...."];
let thinkingInterval = null;
let thinkingIndex = 0;
let activeThinkingBubble = null;

const setSecurityMessage = (text) => {
  if (!voiceHelper) return;
  voiceHelper.textContent = text || "";
};

const registerDynamicHoneypotField = (field) => {
  if (!field) return;
  dynamicHoneypotFields.add(field);
  field.addEventListener("input", updateSendState);
};

const installDynamicHoneypots = () => {
  const controls = document.querySelectorAll("input, textarea, button");
  controls.forEach((control, index) => {
    if (!control || !control.parentElement) return;

    const tag = String(control.tagName || "").toLowerCase();
    const type = String(control.getAttribute("type") || "").toLowerCase();
    if (control.matches(`[${HONEYPOT_DYNAMIC_ATTR}]`) || control.id === "website-field" || control.id === "contact-field") return;
    if (tag === "input" && ["hidden", "submit", "button", "image", "file", "checkbox", "radio", "range", "color"].includes(type)) return;

    const hp = document.createElement("input");
    hp.type = "text";
    hp.setAttribute(HONEYPOT_DYNAMIC_ATTR, "1");
    hp.setAttribute(HONEYPOT_DYNAMIC_VALUE_ATTR, `${tag}-${index}`);
    hp.className = "gabo-honeypot-field";
    hideHoneypotField(hp);

    control.parentElement.insertBefore(hp, control);
    registerDynamicHoneypotField(hp);
  });
};

const updateThinkingText = () => {
  const text = thinkingFrames[thinkingIndex % thinkingFrames.length];
  thinkingIndex += 1;
  if (thinkingStatus) thinkingStatus.textContent = text;
  if (activeThinkingBubble) activeThinkingBubble.textContent = text;
};

const startThinking = (bubble) => {
  activeThinkingBubble = bubble ?? activeThinkingBubble;
  thinkingIndex = 0;
  updateThinkingText();
  if (!thinkingInterval) thinkingInterval = setInterval(updateThinkingText, 500);
};

const stopThinking = () => {
  if (thinkingInterval) {
    clearInterval(thinkingInterval);
    thinkingInterval = null;
  }
  activeThinkingBubble = null;
  if (thinkingStatus) thinkingStatus.textContent = "Standing by.";
};

const updateSendState = () => {
  const hasText = input.value.trim().length > 0;
  const honeypotTripped = Boolean(honeypotField?.value?.trim() || preHoneypotField?.value?.trim());
  sendBtn.disabled = isStreaming || !hasText || honeypotTripped;
  if (input) input.readOnly = false;
  if (micBtn) micBtn.disabled = false;
};

const updateCancelState = () => {
  if (!cancelBtn) return;
  cancelBtn.hidden = !isStreaming;
  cancelBtn.disabled = !isStreaming;
};

const setStreamingState = (active) => {
  isStreaming = active;
  updateSendState();
  updateCancelState();
};

const cancelStream = () => {
  if (!activeController) return;
  activeController.abort();
  if (activeAssistantBubble) {
    activeAssistantBubble.textContent = "Request canceled.";
    activeAssistantBubble.setAttribute("dir", getTextDirection(activeAssistantBubble.textContent));
  }
  stopThinking();
  setStreamingState(false);
};

cancelBtn?.addEventListener("click", cancelStream);

// -------------------------
// Tiny-ML sanitizer
// -------------------------
const TINY_ML_PATTERNS = [
  { regex: /<\s*script\b/i, weight: 5 },
  { regex: /<\/?\s*iframe\b/i, weight: 4 },
  { regex: /javascript\s*:/i, weight: 4 },
  { regex: /\bon\w+\s*=\s*["']/i, weight: 4 },
  { regex: /\beval\s*\(/i, weight: 4 },
  { regex: /document\.(cookie|write)/i, weight: 3 },
  { regex: /localStorage|sessionStorage/i, weight: 2 },
  { regex: /\b(function|class|import|export|return|const|let|var)\b\s+[a-zA-Z_$]/i, weight: 1 },
  { regex: /[{};]{4,}/, weight: 1 },
];

const tinyMlRiskScore = (text) => {
  const sample = String(text || "");
  let score = 0;
  TINY_ML_PATTERNS.forEach(({ regex, weight }) => {
    if (regex.test(sample)) score += weight;
  });
  if (sample.length > 220) score += 1;
  return score;
};

const sanitizeUserInput = (text) => {
  let out = String(text || "");
  out = out.replace(/\u0000/g, "");
  out = out.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  out = out.replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, " ");
  out = out.replace(/<\s*(iframe|object|embed|style|form|svg|math)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ");
  out = out.replace(/<[^>]+>/g, " ");
  out = out.replace(/javascript\s*:/gi, "");
  out = out.replace(/\bon\w+\s*=\s*["'][\s\S]*?["']/gi, "");
  out = out.replace(/\bon\w+\s*=\s*[^\s>]+/gi, "");
  out = out.replace(/\b(function|class|import|export|return|const|let|var)\b\s+[a-zA-Z_$][\w$]*/gi, " ");
  out = out.replace(/\s+/g, " ").trim();
  return out;
};

const hasResidualMaliciousContent = (text) => {
  const checks = [
    /<\s*script\b/i,
    /javascript\s*:/i,
    /\bon\w+\s*=/i,
    /\beval\s*\(/i,
    /document\.(cookie|write)/i,
  ];
  return checks.some((re) => re.test(String(text || "")));
};

const tinyMlHoneypotRiskScore = (value) => {
  const sample = String(value || "").trim();
  if (!sample) return 0;
  let score = 0;
  const rules = [
    /https?:\/\//i,
    /@/,
    /\b(select|insert|union|drop|script|function|return|const|let|var)\b/i,
    /[{}<>;=()]/,
  ];
  rules.forEach((rule) => {
    if (rule.test(sample)) score += 2;
  });
  if (sample.length > 4) score += 2;
  return score;
};

const isHoneypotCompromised = () => {
  const postValue = String(honeypotField?.value || "").trim();
  const preValue = String(preHoneypotField?.value || "").trim();
  const postRisk = tinyMlHoneypotRiskScore(postValue);
  const preRisk = tinyMlHoneypotRiskScore(preValue);

  const dynamicValues = Array.from(dynamicHoneypotFields)
    .map((field) => ({
      key: String(field?.getAttribute(HONEYPOT_DYNAMIC_VALUE_ATTR) || "").trim(),
      value: String(field?.value || "").trim(),
    }))
    .filter(({ value }) => Boolean(value));

  const dynamicRisk = dynamicValues.reduce((sum, entry) => sum + tinyMlHoneypotRiskScore(entry.value), 0);

  return {
    blocked: Boolean(postValue || preValue || dynamicValues.length || postRisk >= 2 || preRisk >= 2 || dynamicRisk >= 2),
    postValue,
    preValue,
    postRisk,
    preRisk,
    dynamicValues,
    dynamicRisk,
  };
};

const sanitizeAndValidateMessage = (raw) => {
  const initialRisk = tinyMlRiskScore(raw);
  const sanitized = sanitizeUserInput(raw);
  const finalRisk = tinyMlRiskScore(sanitized);
  const integrityOk = !hasResidualMaliciousContent(sanitized) && finalRisk <= 2;
  return {
    sanitized,
    initialRisk,
    finalRisk,
    integrityOk,
    changed: sanitized !== String(raw || "").trim(),
  };
};

const tinyMlIntegrityDigest = async (text) => {
  const normalized = sanitizeUserInput(text || "");
  if (!normalized || !window.crypto?.subtle) return "";
  const bytes = new TextEncoder().encode(normalized);
  const hash = await crypto.subtle.digest("SHA-512", bytes);
  const u8 = new Uint8Array(hash);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
};

const TINY_ML_ENGINE = {
  score: tinyMlRiskScore,
  sanitize: sanitizeUserInput,
  hasResidual: hasResidualMaliciousContent,
  honeypotScore: tinyMlHoneypotRiskScore,
  integrity: tinyMlIntegrityDigest,
};
window.GABO_TINY_ML = TINY_ML_ENGINE;

// -------------------------
// Chat UI helpers
// -------------------------
const addMessage = (text, isUser) => {
  const row = document.createElement("div");
  row.className = `message-row${isUser ? " user" : ""}`;

  if (!isUser) {
    const avatar = document.createElement("div");
    avatar.className = "avatar assistant";
    avatar.textContent = "AI";
    row.appendChild(avatar);
  }

  const content = document.createElement("div");
  const bubble = document.createElement("div");
  bubble.className = `bubble ${isUser ? "user" : "assistant"}`;
  bubble.textContent = text;
  bubble.setAttribute("dir", getTextDirection(text));

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = isUser ? "You · just now" : "Gabo · just now";

  content.appendChild(bubble);
  content.appendChild(meta);

  row.appendChild(content);
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
};

// -------------------------
// Response metadata logging
// -------------------------
const buildResponseMeta = (headers) => {
  if (!headers) return "";
  const values = [
    { key: "x-gabo-lang-iso2", label: "lang" },
    { key: "x-gabo-model", label: "model" },
    { key: "x-gabo-stt-iso2", label: "stt" },
    { key: "x-gabo-voice-timeout-sec", label: "voice timeout" },
    { key: "x-gabo-tts-iso2", label: "tts" },
  ];
  const items = values
    .map(({ key, label }) => {
      const value = headers.get(key);
      return value ? `${label}: ${value}` : "";
    })
    .filter(Boolean);
  return items.join(" · ");
};

const logResponseMeta = (headers) => {
  const summary = buildResponseMeta(headers);
  if (!summary) return;
  console.info("Gabo response metadata:", summary);
};

// -------------------------
// Language + headers
// -------------------------
const DEFAULT_REQUEST_META = {
  reply_format: "paragraph",
  tone: "friendly",
  spanish_quality: "king",
  model_tier: "quality",
  language_mode: "auto",
};

const getLanguageMeta = () => {
  const languages = Array.isArray(navigator.languages) ? navigator.languages.filter(Boolean) : [];
  const primary = navigator.language || languages[0] || "";
  return {
    language_hint: primary,
    language_list: languages,
  };
};

let lastVoiceLanguage = "";

const getPreferredLanguage = () =>
  lastVoiceLanguage ||
  navigator.language ||
  (Array.isArray(navigator.languages) ? navigator.languages[0] : "") ||
  "";

const buildLanguageHeaders = (language) => {
  const languages = Array.isArray(navigator.languages) ? navigator.languages.filter(Boolean) : [];
  return {
    "x-gabo-lang-hint": language || "",
    "x-gabo-lang-list": languages.join(","),
  };
};

const getAssetHeaderName = () => normalizeHeaderName(window.OPS_ASSET_HEADER_NAME || CANONICAL_CONFIG?.asset_identity?.header_name || "x-ops-asset-id");

const buildSecurityHeaders = (language, integrityB64 = "") => {
  const assetHeaderName = getAssetHeaderName();
  const dynamicPayload = Array.from(dynamicHoneypotFields)
    .map((field) => ({
      key: String(field?.getAttribute(HONEYPOT_DYNAMIC_VALUE_ATTR) || "").trim(),
      value: String(field?.value || "").trim(),
    }))
    .filter(({ value }) => Boolean(value));

  const headers = {
    ...buildLanguageHeaders(language),
    [HONEYPOT_HEADER_NAME]: String(honeypotField?.value || "").trim(),
    [HONEYPOT_PRE_HEADER_NAME]: String(preHoneypotField?.value || "").trim(),
    "x-gabo-honeypot-dynamic": dynamicPayload.length ? JSON.stringify(dynamicPayload).slice(0, 1024) : "",
    "x-ops-src-sha512-b64": integrityB64,
  };

  // Always include asset id (fail-closed if missing)
  if (OPS_ASSET_ID) headers[assetHeaderName] = OPS_ASSET_ID;

  return headers;
};

// -------------------------
// Allowed origins check
// -------------------------
const isOriginAllowed = (origin, allowedList) => {
  const normalizedOrigin = normalizeOrigin(origin);
  return allowedList.some((allowedOrigin) => normalizeOrigin(allowedOrigin) === normalizedOrigin);
};

const warnIfOriginMissing = () => {
  if (!allowedOrigins.length) return;
  const originAllowed = isOriginAllowed(window.location.origin, allowedOrigins);
  if (!originAllowed) {
    console.warn(`Origin ${window.location.origin} is not listed in ${CANONICAL_CONFIG_URL}.`);
  }
};

const getActiveEndpoint = () => gatewayEndpoint || workerEndpoint;

// -------------------------
// SSE stream reader (data: frames)
// -------------------------
const streamWorkerResponse = async (response, bubble) => {
  if (!response.body) {
    bubble.textContent = "We couldn't connect to the assistant stream.";
    return bubble.textContent;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let hasChunk = false;

  const appendText = (text) => {
    if (!hasChunk) {
      stopThinking();
      bubble.textContent = "";
      hasChunk = true;
    }
    bubble.textContent += text;
    bubble.setAttribute("dir", getTextDirection(bubble.textContent));
    chatLog.scrollTop = chatLog.scrollHeight;
  };

  let fullText = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    parts.forEach((part) => {
      const lines = part.split("\n");
      const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5)); // DO NOT trim payload
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n");
      const trimmed = data.trim();
      if (trimmed === "[DONE]") return;
      if (data !== "") {
        fullText += data;
        appendText(data);
      }
    });
  }

  return fullText;
};

const stringifyWorkerValue = (value) => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch (error) {
    console.error(error);
  }
  return String(value);
};

const readWorkerError = async (response) => {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      const payload = await response.json();
      if (payload?.error) {
        const errorValue = stringifyWorkerValue(payload.error);
        const detailValue = stringifyWorkerValue(payload.detail);
        return detailValue ? `${errorValue}: ${detailValue}` : errorValue;
      }
      if (payload?.message) return stringifyWorkerValue(payload.message);
      return stringifyWorkerValue(payload);
    } catch (error) {
      console.error(error);
    }
  }
  return response.text();
};

// -------------------------
// Voice / Mic (Worker STT + TTS)
// -------------------------
let micStream = null;
let micRecorder = null;
let micChunks = [];
let micRecording = false;
let voiceReplyRequested = false;
let activeVoiceAudio = null;

function getSupportedMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function setMicUI(isOn) {
  const btn = micBtn;
  if (!btn) return;
  btn.classList.toggle("is-listening", isOn);
  btn.setAttribute("aria-pressed", isOn ? "true" : "false");
  if (voiceHelper) voiceHelper.textContent = isOn ? "Listening... click to stop." : "";
  if (input) input.placeholder = isOn ? "Listening..." : "Message in any language...";
}

async function playVoiceReply(text) {
  if (!text) return;
  if (!window.WorkerClient?.postTTS) throw new Error("Worker TTS module is not loaded.");

  if (activeVoiceAudio) {
    activeVoiceAudio.pause();
    activeVoiceAudio = null;
  }

  const voiceLanguage = getPreferredLanguage();
  const res = await window.WorkerClient.postTTS(
    { text, language: voiceLanguage || undefined },
    { extraHeaders: buildSecurityHeaders(voiceLanguage) }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`TTS failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  logResponseMeta(res.headers);
  const audioBlob = await res.blob();
  const audioUrl = URL.createObjectURL(audioBlob);
  const audio = new Audio(audioUrl);
  activeVoiceAudio = audio;

  audio.addEventListener("ended", () => {
    URL.revokeObjectURL(audioUrl);
    if (activeVoiceAudio === audio) activeVoiceAudio = null;
  });

  await audio.play();
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone not supported in this browser.");
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const mimeType = getSupportedMimeType();
  micChunks = [];
  micRecorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);

  micRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) micChunks.push(event.data);
  };

  micRecorder.start(250);
  micRecording = true;
  setMicUI(true);
}

async function stopMicAndTranscribe() {
  if (!micRecorder) return "";

  const stopped = new Promise((resolve) => {
    micRecorder.addEventListener("stop", resolve, { once: true });
  });

  if (micRecorder.state !== "inactive") {
    try {
      micRecorder.requestData();
    } catch {}
  }

  micRecorder.stop();
  await stopped;

  if (micChunks.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));

  try {
    micStream?.getTracks()?.forEach((track) => track.stop());
  } catch {}

  micStream = null;

  const blob = new Blob(micChunks, { type: micRecorder.mimeType || "audio/webm" });
  micRecorder = null;
  micChunks = [];
  micRecording = false;
  setMicUI(false);

  if (!blob || blob.size === 0) throw new Error("No audio captured. Please try again.");
  if (!window.WorkerClient?.postVoiceSTT) throw new Error("Worker voice module is not loaded.");

  const preferredLanguage = getPreferredLanguage();
  const res = await window.WorkerClient.postVoiceSTT(blob, { extraHeaders: buildSecurityHeaders(preferredLanguage) });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`STT failed (${res.status}): ${text.slice(0, 200)}`);
  }

  logResponseMeta(res.headers);

  const detectedLanguage = res.headers.get("x-gabo-stt-iso2");
  if (detectedLanguage) lastVoiceLanguage = detectedLanguage;
  else if (!lastVoiceLanguage && preferredLanguage) lastVoiceLanguage = preferredLanguage;

  const data = await res.json();
  const transcript = data?.transcript ? String(data.transcript) : "";
  if (!transcript) throw new Error("No transcript returned.");

  if (input) {
    input.value = transcript;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    voiceReplyRequested = true;
    if (form?.requestSubmit) form.requestSubmit();
    else form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  if (voiceHelper) voiceHelper.textContent = `Heard: “${transcript}”`;

  return transcript;
}

async function onMicClick() {
  try {
    if (!micRecording) {
      await startMic();
      setTimeout(async () => {
        if (micRecording) {
          try {
            await stopMicAndTranscribe();
          } catch (error) {
            console.error(error);
            voiceReplyRequested = false;
          }
        }
      }, 8000);
    } else {
      await stopMicAndTranscribe();
    }
  } catch (error) {
    micRecording = false;
    voiceReplyRequested = false;
    setMicUI(false);

    try {
      micStream?.getTracks()?.forEach((track) => track.stop());
    } catch {}

    micStream = null;
    micRecorder = null;
    micChunks = [];

    console.error("Mic error:", error);

    if (input) input.placeholder = error?.message ? String(error.message) : "Microphone error";
    if (voiceHelper) voiceHelper.textContent = "Microphone unavailable.";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = micBtn;
  if (!btn) return;
  const hasMediaSupport = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  btn.disabled = !hasMediaSupport;
  btn.title = hasMediaSupport ? "Voice reply (up to 8 seconds)" : "Microphone not supported on this device";
  if (!hasMediaSupport && voiceHelper) voiceHelper.textContent = "Microphone not supported in this browser.";
  btn.addEventListener("click", onMicClick);
});

// -------------------------
// Chat submit -> sanitize -> WorkerClient.postChat -> stream
// -------------------------
input.addEventListener("input", updateSendState);
honeypotField?.addEventListener("input", updateSendState);
preHoneypotField?.addEventListener("input", updateSendState);
installDynamicHoneypots();

input.addEventListener("focus", () => {
  chatLog.scrollTop = chatLog.scrollHeight;
});

const buildMessages = (message) => [{ role: "user", content: message }];

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const rawMessage = input.value.trim();
  if (!rawMessage || isStreaming) return;

  // Fail-closed if asset id is missing for this origin
  if (!OPS_ASSET_ID) {
    addMessage("Security configuration error: missing asset identity for this origin.", false);
    setSecurityMessage("Blocked: missing asset identity mapping.");
    return;
  }

  const honeypotCheck = isHoneypotCompromised();
  if (honeypotCheck.blocked) {
    console.warn("Blocked suspicious request: honeypot trap filled.", {
      preRisk: honeypotCheck.preRisk,
      postRisk: honeypotCheck.postRisk,
      dynamicRisk: honeypotCheck.dynamicRisk,
      dynamicCount: honeypotCheck.dynamicValues.length,
    });
    input.value = "";
    if (honeypotField) honeypotField.value = "";
    if (preHoneypotField) preHoneypotField.value = "";
    dynamicHoneypotFields.forEach((field) => {
      if (field) field.value = "";
    });
    updateSendState();
    setSecurityMessage("Security validation failed. Request blocked.");
    return;
  }

  const sanitizedResult = sanitizeAndValidateMessage(rawMessage);
  if (!sanitizedResult.sanitized || !sanitizedResult.integrityOk || sanitizedResult.initialRisk >= 8) {
    input.value = "";
    updateSendState();
    addMessage("Message blocked by security sanitizer.", false);
    return;
  }

  if (sanitizedResult.changed) {
    console.info("Sanitizer updated outgoing message.", {
      initialRisk: sanitizedResult.initialRisk,
      finalRisk: sanitizedResult.finalRisk,
    });
  }

  const message = sanitizedResult.sanitized;
  const integrityB64 = await TINY_ML_ENGINE.integrity(message);

  addMessage(message, true);
  input.value = "";
  updateSendState();
  input.blur();

  const assistantBubble = addMessage(thinkingFrames[0], false);
  activeAssistantBubble = assistantBubble;
  startThinking(assistantBubble);

  const endpoint = getActiveEndpoint();
  if (!endpoint) {
    assistantBubble.textContent = `The assistant endpoint is not configured. Please check ${CANONICAL_CONFIG_URL}.`;
    stopThinking();
    return;
  }

  warnIfOriginMissing();

  setStreamingState(true);
  const controller = new AbortController();
  activeController = controller;

  try {
    if (!window.WorkerClient?.postChat) throw new Error("Worker client module is not loaded.");

    const response = await window.WorkerClient.postChat(
      {
        messages: buildMessages(message),
        meta: {
          source: "gabo-ui",
          currentUrl: window.location.href,
          allowedOrigins,
          ...DEFAULT_REQUEST_META,
          ...getLanguageMeta(),
          voice_language: lastVoiceLanguage || undefined,
          security: {
            tiny_ml_risk: sanitizedResult.initialRisk,
            tiny_ml_risk_post_sanitize: sanitizedResult.finalRisk,
            integrity_check: sanitizedResult.integrityOk,
            integrity_sha512_b64: integrityB64 || undefined,
            honeypot_clear: true,
          },
          honeypot: "",
        },
      },
      {
        signal: controller.signal,
        extraHeaders: buildSecurityHeaders(getPreferredLanguage(), integrityB64),
      }
    );

    if (!response.ok) {
      const errorText = await readWorkerError(response);
      const statusLabel = response.status
        ? `Request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""}).`
        : "Request failed.";
      assistantBubble.textContent = errorText || statusLabel;
      stopThinking();
      return;
    }

    logResponseMeta(response.headers);

    const assistantText = await streamWorkerResponse(response, assistantBubble);
    if (voiceReplyRequested && assistantText) {
      try {
        await playVoiceReply(assistantText);
      } catch (error) {
        console.error("Voice reply failed:", error);
      }
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    assistantBubble.textContent =
      error?.message || "We couldn't reach the secure assistant. Please try again shortly.";
    console.error(error);
  } finally {
    activeController = null;
    activeAssistantBubble = null;
    setStreamingState(false);
    stopThinking();
    voiceReplyRequested = false;
  }
});

// -------------------------
// Init
// -------------------------
const initApp = async () => {
  await loadCanonicalConfig();

  // If config loaded but only assistantEndpoint exists, derive worker endpoint
  if (!workerEndpoint && CANONICAL_CONFIG?.assistantEndpoint) {
    const derived = deriveWorkerEndpoint(CANONICAL_CONFIG.assistantEndpoint);
    if (derived) workerEndpoint = derived;
  }
  if (!gatewayEndpoint) gatewayEndpoint = workerEndpoint;

  // Allowed origins defaults (fail-safe)
  if (!allowedOrigins.length && CANONICAL_CONFIG?.allowedOrigins) {
    allowedOrigins = asArray(CANONICAL_CONFIG.allowedOrigins).filter(Boolean);
  }

  warnIfOriginMissing();
  updateSendState();
  updateCancelState();
  stopThinking();

  if (!OPS_ASSET_ID) {
    setSecurityMessage("Security checks active, but asset identity mapping is missing for this origin.");
  } else {
    setSecurityMessage("Security checks active (gateway validation + asset identity).");
  }
};

initApp();
