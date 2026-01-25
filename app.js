const form = document.getElementById("chat-form");
const input = document.getElementById("msgInput");
const sendBtn = document.getElementById("send-btn");
const chatLog = document.getElementById("chat-log");
// --- OPS Asset Identity (Origin -> AssetId) ---
const OPS_ASSET_BY_ORIGIN = {
  "https://www.chattia.io": "asset_01J7Y2D4XABCD3EFGHJKMNPRTB",
  "https://chattia.io": "asset_01J7Y2D4XABCD3EFGHJKMNPRTC",
  "https://chattiavato-a11y.github.io": "asset_01J7Y2D4XABCD3EFGHJKMNPRTD",
  "https://enlace.grabem-holdem-nuts-right.workers.dev":
    "asset_01J7Y2D4XABCD3EFGHJKMNPRTA",
};
const OPS_ASSET_ID = OPS_ASSET_BY_ORIGIN[window.location.origin] || "";
window.OPS_ASSET_BY_ORIGIN = OPS_ASSET_BY_ORIGIN;
window.OPS_ASSET_ID = OPS_ASSET_ID;

const defaultConfig = {
  assetRegistry: "worker_files/worker.assets.json",
  workerEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev",
  assistantEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev/api/chat",
  voiceEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev/api/voice",
  ttsEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev/api/tts",
  gatewayEndpoint: "",
  workerEndpointAssetId: "asset_01J7Y2D4XABCD3EFGHJKMNPRTA",
  gatewayEndpointAssetId: "",

  allowedOrigins: [
    "https://www.chattia.io",
    "https://chattia.io",
    "https://chattiavato-a11y.github.io",
    "https://enlace.grabem-holdem-nuts-right.workers.dev",
  ],

  allowedOriginAssetIds: [
    "asset_01J7Y2D4XABCD3EFGHJKMNPRTB",
    "asset_01J7Y2D4XABCD3EFGHJKMNPRTC",
    "asset_01J7Y2D4XABCD3EFGHJKMNPRTD",
    "asset_01J7Y2D4XABCD3EFGHJKMNPRTA",
  ],

};

const TRANSLATIONS = {
  en: {
    welcome: "Welcome",
    startConversation: "Start a conversation",
    introCopy:
      "Chat in any language — spoken or written. Chattia auto-detects your language and replies in kind.",
    greeting: "Hello",
    farewell: "Goodbye",
    chattiaIntro:
      "Chat in any language — spoken or written. Chattia auto-detects your language and replies in kind.",
  },
  es: {
    welcome: "Bienvenido",
    startConversation: "Inicia una conversación",
    introCopy:
      "Chatea en cualquier idioma — hablado o escrito. Chattia detecta tu idioma y responde en el mismo.",
    greeting: "Hola",
    farewell: "Adiós",
    chattiaIntro:
      "Chatea en cualquier idioma — hablado o escrito. Chattia detecta tu idioma y responde en el mismo.",
  },
  fr: {
    welcome: "Bienvenue",
    startConversation: "Commencez une conversation",
    introCopy:
      "Discutez dans n’importe quelle langue — parlée ou écrite. Chattia détecte votre langue et répond en conséquence.",
    greeting: "Bonjour",
    farewell: "Au revoir",
    chattiaIntro:
      "Discutez dans n’importe quelle langue — parlée ou écrite. Chattia détecte votre langue et répond en conséquence.",
  },
  pt: {
    welcome: "Bem-vindo",
    startConversation: "Inicie uma conversa",
    introCopy:
      "Converse em qualquer idioma — falado ou escrito. Chattia detecta seu idioma e responde da mesma forma.",
    greeting: "Olá",
    farewell: "Tchau",
    chattiaIntro:
      "Converse em qualquer idioma — falado ou escrito. Chattia detecta seu idioma e responde da mesma forma.",
  },
  ar: {
    welcome: "مرحبًا",
    startConversation: "ابدأ محادثة",
    introCopy:
      "تحدث بأي لغة — منطوقة أو مكتوبة. يكتشف Chattia لغتك ويرد بالمثل.",
    greeting: "مرحبًا",
    farewell: "مع السلامة",
    chattiaIntro:
      "تحدث بأي لغة — منطوقة أو مكتوبة. يكتشف Chattia لغتك ويرد بالمثل.",
  },
  ru: {
    welcome: "Добро пожаловать",
    startConversation: "Начните разговор",
    introCopy:
      "Общайтесь на любом языке — устном или письменном. Chattia определяет ваш язык и отвечает тем же.",
    greeting: "Здравствуйте",
    farewell: "До свидания",
    chattiaIntro:
      "Общайтесь на любом языке — устном или письменном. Chattia определяет ваш язык и отвечает тем же.",
  },
  zh: {
    welcome: "欢迎",
    startConversation: "开始对话",
    introCopy: "用任何语言交流——口语或书面语。Chattia 会自动识别你的语言并以相同语言回复。",
    greeting: "你好",
    farewell: "再见",
    chattiaIntro:
      "用任何语言交流——口语或书面语。Chattia 会自动识别你的语言并以相同语言回复。",
  },
  yue: {
    welcome: "歡迎",
    startConversation: "開始對話",
    introCopy: "用任何語言交流——口語或書面語。Chattia 會自動識別你嘅語言並用相同語言回覆。",
    greeting: "你好",
    farewell: "再見",
    chattiaIntro:
      "用任何語言交流——口語或書面語。Chattia 會自動識別你嘅語言並用相同語言回覆。",
  },
  de: {
    welcome: "Willkommen",
    startConversation: "Starten Sie ein Gespräch",
    introCopy:
      "Chatten Sie in jeder Sprache — gesprochen oder geschrieben. Chattia erkennt Ihre Sprache und antwortet entsprechend.",
    greeting: "Hallo",
    farewell: "Auf Wiedersehen",
    chattiaIntro:
      "Chatten Sie in jeder Sprache — gesprochen oder geschrieben. Chattia erkennt Ihre Sprache und antwortet entsprechend.",
  },
  sv: {
    welcome: "Välkommen",
    startConversation: "Starta en konversation",
    introCopy:
      "Chatta på vilket språk som helst — talat eller skrivet. Chattia identifierar ditt språk och svarar på samma sätt.",
    greeting: "Hej",
    farewell: "Hej då",
    chattiaIntro:
      "Chatta på vilket språk som helst — talat eller skrivet. Chattia identifierar ditt språk och svarar på samma sätt.",
  },
  no: {
    welcome: "Velkommen",
    startConversation: "Start en samtale",
    introCopy:
      "Chat på hvilket som helst språk — muntlig eller skriftlig. Chattia oppdager språket ditt og svarer på samme måte.",
    greeting: "Hei",
    farewell: "Ha det",
    chattiaIntro:
      "Chat på hvilket som helst språk — muntlig eller skriftlig. Chattia oppdager språket ditt og svarer på samme måte.",
  },
  fi: {
    welcome: "Tervetuloa",
    startConversation: "Aloita keskustelu",
    introCopy:
      "Keskustele millä tahansa kielellä — puhuttuna tai kirjoitettuna. Chattia tunnistaa kielesi ja vastaa samalla kielellä.",
    greeting: "Hei",
    farewell: "Näkemiin",
    chattiaIntro:
      "Keskustele millä tahansa kielellä — puhuttuna tai kirjoitettuna. Chattia tunnistaa kielesi ja vastaa samalla kielellä.",
  },
};

let workerEndpoint = defaultConfig.workerEndpoint;
let gatewayEndpoint = defaultConfig.gatewayEndpoint;
let allowedOrigins = [...defaultConfig.allowedOrigins];
let isStreaming = false;
let activeController = null;
let activeAssistantBubble = null;
const DEFAULT_REQUEST_META = {
  reply_format: "paragraph",
  tone: "friendly",
  spanish_quality: "king",
  model_tier: "quality",
  language_mode: "auto",
};

const RTL_CHARACTERS = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;

const getTextDirection = (text) =>
  RTL_CHARACTERS.test(text) ? "rtl" : "ltr";

const normalizeLocale = (value) =>
  value ? String(value).toLowerCase().split("-")[0] : "";

const getPreferredLocale = () => {
  const languages = Array.isArray(navigator.languages)
    ? navigator.languages.filter(Boolean)
    : [];
  const primary = navigator.language || languages[0] || "en";
  const normalized = normalizeLocale(primary);
  return TRANSLATIONS[normalized] ? normalized : "en";
};

let currentLocale = getPreferredLocale();

const t = (key) =>
  TRANSLATIONS[currentLocale]?.[key] ?? TRANSLATIONS.en[key] ?? "";

const applyTranslations = () => {
  document.documentElement.lang = currentLocale;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    const value = t(key);
    if (value) {
      el.textContent = value;
    }
  });
  document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    const raw = el.getAttribute("data-i18n-attr") || "";
    raw.split(",").forEach((pair) => {
      const [attr, key] = pair.split(":").map((part) => part.trim());
      if (!attr || !key) return;
      const value = t(key);
      if (value) {
        el.setAttribute(attr, value);
      }
    });
  });
};

const PAGE_GRADIENTS = [
  "linear-gradient(135deg, rgba(187, 247, 208, 0.68) 0%, rgba(134, 239, 172, 0.62) 45%, rgba(167, 243, 208, 0.58) 100%)",
  "linear-gradient(140deg, rgba(254, 240, 138, 0.62) 0%, rgba(252, 211, 77, 0.58) 40%, rgba(253, 186, 116, 0.55) 100%)",
  "linear-gradient(145deg, rgba(191, 219, 254, 0.62) 0%, rgba(165, 243, 252, 0.58) 45%, rgba(186, 230, 253, 0.54) 100%)",
  "linear-gradient(135deg, rgba(221, 214, 254, 0.6) 0%, rgba(196, 181, 253, 0.56) 50%, rgba(199, 210, 254, 0.52) 100%)",
];

const deriveWorkerEndpoint = (assistantEndpoint) => {
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
};

const normalizeOrigin = (value) => {
  if (!value) return "";
  try {
    return new URL(String(value), window.location.origin).origin.toLowerCase();
  } catch (error) {
    return String(value).trim().replace(/\/$/, "").toLowerCase();
  }
};

const isOriginAllowed = (origin, allowedList) => {
  const normalizedOrigin = normalizeOrigin(origin);
  return allowedList.some(
    (allowedOrigin) => normalizeOrigin(allowedOrigin) === normalizedOrigin
  );
};

const originStatus = document.getElementById("origin-status");
const endpointStatus = document.getElementById("endpoint-status");
const thinkingStatus = document.getElementById("thinking-status");
const voiceHelper = document.getElementById("voice-helper");
const cancelBtn = document.getElementById("cancel-btn");
const thinkingFrames = ["Thinking.", "Thinking..", "Thinking...", "Thinking...."];
let thinkingInterval = null;
let thinkingIndex = 0;
let activeThinkingBubble = null;
const setStatusLine = (element, text, isWarning = false) => {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("warning", isWarning);
};

const buildResponseMeta = (headers) => {
  if (!headers) return "";
  const values = [
    { key: "x-chattia-lang-iso2", label: "lang" },
    { key: "x-chattia-model", label: "model" },
    { key: "x-chattia-stt-iso2", label: "stt" },
    { key: "x-chattia-voice-timeout-sec", label: "voice timeout" },
    { key: "x-chattia-tts-iso2", label: "tts" },
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
  console.info("Chattia response metadata:", summary);
};

const updateSendState = () => {
  sendBtn.disabled = isStreaming || input.value.trim().length === 0;
};

const updateThinkingText = () => {
  const text = thinkingFrames[thinkingIndex % thinkingFrames.length];
  thinkingIndex += 1;
  if (thinkingStatus) {
    thinkingStatus.textContent = text;
  }
  if (activeThinkingBubble) {
    activeThinkingBubble.textContent = text;
  }
};

const startThinking = (bubble) => {
  activeThinkingBubble = bubble ?? activeThinkingBubble;
  thinkingIndex = 0;
  updateThinkingText();
  if (!thinkingInterval) {
    thinkingInterval = setInterval(updateThinkingText, 500);
  }
};

const stopThinking = () => {
  if (thinkingInterval) {
    clearInterval(thinkingInterval);
    thinkingInterval = null;
  }
  activeThinkingBubble = null;
  if (thinkingStatus) {
    thinkingStatus.textContent = "Standing by.";
  }
};

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

input.addEventListener("input", updateSendState);
input.addEventListener("focus", () => {
  chatLog.scrollTop = chatLog.scrollHeight;
});

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
  meta.textContent = isUser ? "You · just now" : "Chattia · just now";

  content.appendChild(bubble);
  content.appendChild(meta);

  row.appendChild(content);
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
};

// ===== Voice / Mic (Enlace STT) =====

let micStream = null;
let micRecorder = null;
let micChunks = [];
let micRecording = false;
let voiceReplyRequested = false;
let activeVoiceAudio = null;
let lastVoiceLanguage = "";

function getSupportedMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return "";
}

function setMicUI(isOn) {
  const btn = document.getElementById("micBtn");
  if (!btn) return;
  btn.classList.toggle("is-listening", isOn);
  btn.setAttribute("aria-pressed", isOn ? "true" : "false");
  if (voiceHelper) {
    voiceHelper.textContent = isOn ? "Listening... click to stop." : "";
  }
  if (input) {
    input.placeholder = isOn ? "Listening..." : "Message in any language...";
  }
}

async function playVoiceReply(text) {
  if (!text) return;
  if (!window.EnlaceRepo?.postTTS) {
    throw new Error("Enlace TTS module is not loaded.");
  }
  if (activeVoiceAudio) {
    activeVoiceAudio.pause();
    activeVoiceAudio = null;
  }
  const voiceLanguage = getPreferredLanguage();
  const res = await window.EnlaceRepo.postTTS(
    { text, language: voiceLanguage || undefined },
    {
      extraHeaders: buildLanguageHeaders(voiceLanguage),
    }
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
    if (activeVoiceAudio === audio) {
      activeVoiceAudio = null;
    }
  });
  await audio.play();
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone not supported in this browser.");
  }
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
  if (micChunks.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  try {
    micStream?.getTracks()?.forEach((track) => track.stop());
  } catch {}
  micStream = null;

  const blob = new Blob(micChunks, { type: micRecorder.mimeType || "audio/webm" });
  micRecorder = null;
  micChunks = [];
  micRecording = false;
  setMicUI(false);

  if (!blob || blob.size === 0) {
    throw new Error("No audio captured. Please try again.");
  }

  if (!window.EnlaceRepo?.postVoiceSTT) {
    throw new Error("Enlace voice module is not loaded.");
  }
  const preferredLanguage = getPreferredLanguage();
  const res = await window.EnlaceRepo.postVoiceSTT(blob, {
    extraHeaders: buildLanguageHeaders(preferredLanguage),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`STT failed (${res.status}): ${text.slice(0, 200)}`);
  }

  logResponseMeta(res.headers);
  const detectedLanguage = res.headers.get("x-chattia-stt-iso2");
  if (detectedLanguage) {
    lastVoiceLanguage = detectedLanguage;
  } else if (!lastVoiceLanguage && preferredLanguage) {
    lastVoiceLanguage = preferredLanguage;
  }
  const data = await res.json();
  const transcript = data?.transcript ? String(data.transcript) : "";
  if (!transcript) throw new Error("No transcript returned.");

  if (input) {
    input.value = transcript;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    voiceReplyRequested = true;
    if (form?.requestSubmit) {
      form.requestSubmit();
    } else {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
  }
  if (voiceHelper) {
    voiceHelper.textContent = `Heard: “${transcript}”`;
  }

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

    if (input) {
      input.placeholder =
        error?.message ? String(error.message) : "Microphone error";
    }
    if (voiceHelper) {
      voiceHelper.textContent = "Microphone unavailable.";
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("micBtn");
  if (!btn) return;
  const hasMediaSupport = Boolean(
    navigator.mediaDevices?.getUserMedia && window.MediaRecorder
  );
  btn.disabled = !hasMediaSupport;
  btn.title = hasMediaSupport
    ? "Voice reply (up to 8 seconds)"
    : "Microphone not supported on this device";
  if (!hasMediaSupport && voiceHelper) {
    voiceHelper.textContent = "Microphone not supported in this browser.";
  }
  btn.addEventListener("click", onMicClick);
});


const setStreamingState = (active) => {
  isStreaming = active;
  updateSendState();
};

cancelBtn?.addEventListener("click", cancelStream);

const loadRegistryConfig = async () => {
  if (!window.EnlaceRepo?.init) return;
  try {
    await window.EnlaceRepo.init();
    const data = window.EnlaceRepo.getConfig();
    if (data.workerEndpoint) {
      workerEndpoint = data.workerEndpoint;
    } else if (data.assistantEndpoint) {
      const derivedEndpoint = deriveWorkerEndpoint(data.assistantEndpoint);
      if (derivedEndpoint) {
        workerEndpoint = derivedEndpoint;
      }
    }
    if (Array.isArray(data.allowedOrigins) && data.allowedOrigins.length > 0) {
      allowedOrigins = data.allowedOrigins;
    }
  } catch (error) {
    console.warn("Unable to load worker registry config.", error);
  }
};

const getActiveEndpoint = () => gatewayEndpoint || workerEndpoint;
const buildMessages = (message) => [
  {
    role: "user",
    content: message,
  },
];

const getLanguageMeta = () => {
  const languages = Array.isArray(navigator.languages)
    ? navigator.languages.filter(Boolean)
    : [];
  const primary = navigator.language || languages[0] || "";
  return {
    language_hint: primary,
    language_list: languages,
  };
};

const getPreferredLanguage = () =>
  lastVoiceLanguage ||
  navigator.language ||
  (Array.isArray(navigator.languages) ? navigator.languages[0] : "") ||
  "";

const buildLanguageHeaders = (language) => {
  const languages = Array.isArray(navigator.languages)
    ? navigator.languages.filter(Boolean)
    : [];
  return {
    "x-chattia-lang-hint": language || "",
    "x-chattia-lang-list": languages.join(","),
  };
};

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
        .map((line) => line.replace(/^data:\s?/, ""));
      const data = dataLines.join("\n").trim();
      if (data && data !== "[DONE]") {
        fullText += data;
        appendText(data);
      }
    });
  }
  return fullText.trim();
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
      if (payload?.message) {
        return stringifyWorkerValue(payload.message);
      }
      return stringifyWorkerValue(payload);
    } catch (error) {
      console.error(error);
    }
  }
  return response.text();
};

const warnIfOriginMissing = () => {
  const originAllowed = isOriginAllowed(window.location.origin, allowedOrigins);
  if (!originAllowed) {
    console.warn(
      `Origin ${window.location.origin} is not listed in worker_files/worker.config.json.`
    );
  }
  setStatusLine(
    originStatus,
    originAllowed
      ? `Origin: ${window.location.origin}`
      : `Origin: ${window.location.origin} (not listed)`,
    !originAllowed
  );
};

const updateEndpointStatus = () => {
  const activeEndpoint = getActiveEndpoint();
  const isConfigured = Boolean(activeEndpoint);
  setStatusLine(
    endpointStatus,
    isConfigured
      ? `Endpoint: ${activeEndpoint}${gatewayEndpoint ? " (gateway)" : ""}`
      : "Endpoint: not configured",
    !isConfigured
  );
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || isStreaming) return;

  addMessage(message, true);
  input.value = "";
  updateSendState();
  input.blur();

  const assistantBubble = addMessage(thinkingFrames[0], false);
  startThinking(assistantBubble);

  const endpoint = getActiveEndpoint();
  if (!endpoint) {
    assistantBubble.textContent =
      "The assistant endpoint is not configured. Please check worker_files/worker.config.json.";
    stopThinking();
    return;
  }

  warnIfOriginMissing();
  setStreamingState(true);
  const controller = new AbortController();
  activeController = controller;

  try {
    try {
      if (!window.EnlaceRepo?.postChat) {
        throw new Error("Enlace repo module is not loaded.");
      }
    } catch (error) {
      assistantBubble.textContent = String(error?.message || error);
      stopThinking();
      return;
    }

    const response = await window.EnlaceRepo.postChat(
      {
        messages: buildMessages(message),
        meta: {
          source: "chattia-ui",
          currentUrl: window.location.href,
          allowedOrigins,
          ...DEFAULT_REQUEST_META,
          ...getLanguageMeta(),
          voice_language: lastVoiceLanguage || undefined,
        },
      },
      { signal: controller.signal }
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
    if (error.name === "AbortError") {
      return;
    }
    assistantBubble.textContent =
      error?.message ||
      "We couldn't reach the secure assistant. Please try again shortly.";
    console.error(error);
  } finally {
    activeController = null;
    activeAssistantBubble = null;
    setStreamingState(false);
    stopThinking();
    voiceReplyRequested = false;
  }
});

const init = async () => {
  await loadRegistryConfig();
  warnIfOriginMissing();
  updateEndpointStatus();
  updateSendState();
  stopThinking();
};

init();
