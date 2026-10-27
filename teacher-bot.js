const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const { contentDB, getTopic, getWelcome, getMainMenu, getRegistration, getMenuHelp, getQuickResponse, getCompletion } = require("./content-db.js");
const { generateCertificatePDF } = require("./certificate.js");

const ADMIN_NUMBER = process.env.ADMIN_NUMBER;
const MEDIA_DIR = path.join(__dirname, "media");

// Feedback form URL (shown to users after completing the course).
const FEEDBACK_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSdHsEaQ5hfFb0xscOIRSOS60hkn1tjnz7KCCnfFDlJo6LYMEg/viewform?usp=send_form";

// ---- Registration input validation ----
// Easy to edit — add/remove allowed email domains here.
const ALLOWED_EMAIL_DOMAINS = ["gmail.com", "yahoo.com"];
const EMAIL_RETRY_MESSAGE =
  "That doesn't look like a valid email. Please enter a Gmail or Yahoo address, for example name@gmail.com.";

const normalizeEmail = (input) => String(input || "").trim().toLowerCase();

// Basic email shape (one "@", no spaces, non-empty local part) + allowlisted
// domain. Rejects "abc@", "@gmail.com", "a@@gmail.com", bare "gmail.com".
const isValidEmail = (input) => {
  const email = normalizeEmail(input);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return false;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return ALLOWED_EMAIL_DOMAINS.includes(domain);
};

// Terms reply parser: lowercase, strip punctuation, collapse whitespace.
const normalizeReply = (body) =>
  String(body || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").trim().replace(/\s+/g, " ");

const AGREE_REPLIES = ["1", "yes", "i agree", "agree", "yes i agree"];
const DECLINE_REPLIES = ["2", "no", "i do not agree", "no i do not agree"];
const TERMS_RETRY_MESSAGE = "Please reply with 1 to agree or 2 to decline.";
const TERMS_DECLINE_MESSAGE =
  "No problem. You need to agree to the Terms and Conditions to use Témí. Reply 1 whenever you're ready to continue.";

// ---- Meta Cloud API transport (replaces whatsapp-web.js) ----
// State machine, curriculum, and users_db.json logic below are untouched.
// Outbound goes through the Graph API; inbound arrives via webhook.
// Media uses upload-for-ID: local files in media/ are uploaded to Meta to
// get a media ID, then sent by ID. Nothing is re-registered on Meta.
const META_PHONE_ID = process.env.META_PHONE_ID || "";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";
// Optional: when set, POST /webhook bodies are authenticated via
// X-Hub-Signature-256 (HMAC-SHA256 of the raw body). Unset = off.
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v22.0";
const BOT_PORT = parseInt(process.env.BOT_PORT || "3001", 10);

const metaConfigured = () => !!(META_PHONE_ID && META_ACCESS_TOKEN);
if (!metaConfigured()) {
  console.warn("⚠️ META_PHONE_ID / META_ACCESS_TOKEN not set — outbound sends will fail until .env is configured.");
}

// ---- Human-like global message pacing (anti-burst) ----
// Lighter variant: 2-4s for consecutive chunks inside one logical payload
// (sendSlide elements), 3-8s for new interactions / topic intros / quiz
// transitions / certificates. All outbound goes through a GLOBAL serial
// queue layered on top of the existing per-user queue, so concurrent users
// can't fire simultaneously and trip API rate limits.
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const CHUNK_MIN_MS = 2000;
const CHUNK_MAX_MS = 4000;
const HUMAN_MIN_MS = 3000;
const HUMAN_MAX_MS = 8000;

const randomChunkDelay = () =>
  Math.floor(CHUNK_MIN_MS + Math.random() * (CHUNK_MAX_MS - CHUNK_MIN_MS));
const randomHumanDelay = () =>
  Math.floor(HUMAN_MIN_MS + Math.random() * (HUMAN_MAX_MS - HUMAN_MIN_MS));

// Human-like pacing delays are kept for UX (readable, unhurried delivery).
// Cloud API has no typing-indicator send, so this is a plain delay.
const humanPace = async (_message, ms) => {
  await delay(ms);
  return ms;
};

// Global serial send queue. Every outbound payload waits in line here;
// worker (the awaiting handler) pulls serially. Chained off a single
// promise so bursts across users collapse into spaced, sequential sends.
let globalSendChain = Promise.resolve();
const enqueueGlobalSend = (fn) => {
  const next = globalSendChain.catch(() => {}).then(fn);
  globalSendChain = next.catch(() => {});
  return next;
};

// ---- Graph API sender ----
const graphBase = () => `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_ID}`;
const graphHeaders = () => ({
  Authorization: `Bearer ${META_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
});

const mimeForFile = (filePath) => {
  const ext = String(filePath || "").toLowerCase().split(".").pop();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "ogg" || ext === "opus") return "audio/ogg";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "mp4") return "video/mp4";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
};

// Upload-for-ID cache: file path (+mtime) -> Meta media ID.
// Media IDs expire, so any send that fails with an ID error evicts the entry.
const mediaIdCache = new Map(); // filePath -> { id, mtimeMs }
const mediaIdForFilePath = async (filePath) => {
  const stat = fs.statSync(filePath);
  const cached = mediaIdCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.id;
  const mime = mimeForFile(filePath);
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buf], { type: mime }), path.basename(filePath));
  form.append("type", mime);
  const res = await fetch(`${graphBase()}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error(`media upload failed (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
  }
  mediaIdCache.set(filePath, { id: data.id, mtimeMs: stat.mtimeMs });
  return data.id;
};

const graphSend = async (payload, label) => {
  if (!metaConfigured()) throw new Error("META_PHONE_ID / META_ACCESS_TOKEN not configured");
  const res = await fetch(`${graphBase()}/messages`, {
    method: "POST",
    headers: graphHeaders(),
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errBody = data && data.error ? data.error : {};
    const code = errBody.code ?? data.code ?? res.status;
    const subcode = errBody.error_subcode ?? data.error_subcode ?? "-";
    console.error(`Graph ${label} failed: http=${res.status} code=${code} subcode=${subcode} msg=${String(errBody.message || "").slice(0, 200)}`);
    throw new Error(`${label} failed (http=${res.status} code=${code} subcode=${subcode}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
};

const sendTextTo = async (to, body) => {
  // WhatsApp text limit is 4096 chars — chunk defensively.
  const chunks = [];
  let rest = String(body || "");
  while (rest.length > 4000) {
    chunks.push(rest.slice(0, 4000));
    rest = rest.slice(4000);
  }
  chunks.push(rest);
  let out = null;
  for (const c of chunks) {
    out = await graphSend({ to, type: "text", text: { body: c, preview_url: true } }, "text send");
  }
  return out;
};

const sendImageTo = async (to, filePath, caption) => {
  const id = await mediaIdForFilePath(filePath);
  try {
    return await graphSend({ to, type: "image", image: { id, caption: caption || "" } }, "image send");
  } catch (e) {
    if (/media|id|expired|not found/i.test(String(e?.message || e))) mediaIdCache.delete(filePath);
    throw e;
  }
};

const sendAudioTo = async (to, filePath) => {
  const id = await mediaIdForFilePath(filePath);
  try {
    return await graphSend({ to, type: "audio", audio: { id } }, "audio send");
  } catch (e) {
    if (/media|id|expired|not found/i.test(String(e?.message || e))) mediaIdCache.delete(filePath);
    throw e;
  }
};

const sendVideoTo = async (to, filePath, caption) => {
  const id = await mediaIdForFilePath(filePath);
  try {
    return await graphSend({ to, type: "video", video: { id, caption: caption || "" } }, "video send");
  } catch (e) {
    if (/media|id|expired|not found/i.test(String(e?.message || e))) mediaIdCache.delete(filePath);
    throw e;
  }
};

const sendDocumentTo = async (to, filePath, caption, filename) => {
  const id = await mediaIdForFilePath(filePath);
  try {
    return await graphSend(
      { to, type: "document", document: { id, caption: caption || "", filename: filename || path.basename(filePath) } },
      "document send"
    );
  } catch (e) {
    if (/media|id|expired|not found/i.test(String(e?.message || e))) mediaIdCache.delete(filePath);
    throw e;
  }
};

const markAsRead = async (messageId) => {
  if (!metaConfigured() || !messageId) return;
  try {
    await fetch(`${graphBase()}/messages`, {
      method: "POST",
      headers: graphHeaders(),
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
    });
  } catch {}
};

// Central text sender: global-queue + randomized delay + Graph send.
// pace: "human" (3-8s, default) | "chunk" (2-4s, same-payload pieces).
// NOTE: uses bracket access to avoid matching the automated
// message.reply( -> pacedReply(message, migration below.
const pacedReply = async (message, content, pace = "human", _options) => {
  return enqueueGlobalSend(async () => {
    const waitMs = pace === "chunk" ? randomChunkDelay() : randomHumanDelay();
    console.log(`⏳ Pacing (${pace}): waiting ${(waitMs / 1000).toFixed(1)}s...`);
    await humanPace(message, waitMs);
    console.log(`📤 Text to ${message.from}: ${(String(content) || "").length} chars`);
    return await sendTextTo(message.from, content);
  });
};

// ---- WhatsApp Cloud API interactive messages ----
// Hard limits enforced here. Bodies/ids/labels over their limit throw a
// clear error so callers can fall back to the plain-text version; only
// button titles and list row titles/descriptions are truncated.
const LIMITS = {
  LIST_ROWS: 10,
  ROW_TITLE: 24,
  ROW_DESCRIPTION: 72,
  ROW_ID: 200,
  LIST_BUTTON_LABEL: 20,
  BODY: 1024,
  BUTTON_TITLE: 20,
  BUTTON_ID: 256,
  CTA_DISPLAY_TEXT: 20,
  MAX_BUTTONS: 3,
  HEADER_FOOTER: 60,
};

const cut = (value, max) => String(value || "").slice(0, max);
const requireText = (value, max, label) => {
  const text = String(value || "");
  if (!text.trim()) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters (got ${text.length})`);
  return text;
};
const interactiveHeader = (header) => {
  if (!header) return null;
  const text = typeof header === "string" ? header : header.text;
  return text ? { type: "text", text: requireText(text, LIMITS.HEADER_FOOTER, "interactive header") } : null;
};
const interactiveFooter = (footer) => {
  if (!footer) return null;
  const text = typeof footer === "string" ? footer : footer.text;
  return text ? { text: requireText(text, LIMITS.HEADER_FOOTER, "interactive footer") } : null;
};

// Same global queue, human pacing, and graphSend path as pacedReply.
const interactiveSend = (to, payload, label) =>
  enqueueGlobalSend(async () => {
    const waitMs = randomHumanDelay();
    console.log(`⏳ Pacing (human): waiting ${(waitMs / 1000).toFixed(1)}s...`);
    await humanPace({ from: to }, waitMs);
    console.log(`📤 ${label} to ${to}`);
    return await graphSend({ to, type: "interactive", interactive: payload }, label);
  });

const sendListTo = async (to, { body, buttonLabel, sections, header, footer } = {}) => {
  if (!to) throw new Error("list send: recipient is required");
  const bodyText = requireText(body, LIMITS.BODY, "list body");
  const button = requireText(buttonLabel, LIMITS.LIST_BUTTON_LABEL, "list button label");
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("list send: at least one section is required");
  }
  let rowCount = 0;
  const normalizedSections = sections.map((section, sIdx) => {
    if (!section || !Array.isArray(section.rows) || section.rows.length === 0) {
      throw new Error(`list send: section ${sIdx + 1} must contain at least one row`);
    }
    if (section.title) requireText(section.title, LIMITS.ROW_TITLE, `list section ${sIdx + 1} title`);
    return {
      ...(section.title ? { title: section.title } : {}),
      rows: section.rows.map((row, rIdx) => {
        if (!row || row.id == null || String(row.id).length === 0) {
          throw new Error(`list send: row ${rIdx + 1} missing id`);
        }
        const id = String(row.id);
        if (id.length > LIMITS.ROW_ID) {
          throw new Error(`list send: row ${rIdx + 1} id exceeds ${LIMITS.ROW_ID} characters`);
        }
        const title = cut(row.title, LIMITS.ROW_TITLE);
        if (!title.trim()) throw new Error(`list send: row ${rIdx + 1} missing title`);
        rowCount += 1;
        return {
          id,
          title,
          ...(row.description ? { description: cut(row.description, LIMITS.ROW_DESCRIPTION) } : {}),
        };
      }),
    };
  });
  if (rowCount > LIMITS.LIST_ROWS) {
    throw new Error(`list send: ${rowCount} rows exceeds the ${LIMITS.LIST_ROWS}-row limit`);
  }
  const headerObj = interactiveHeader(header);
  const footerObj = interactiveFooter(footer);
  return interactiveSend(to, {
    type: "list",
    ...(headerObj ? { header: headerObj } : {}),
    body: { text: bodyText },
    ...(footerObj ? { footer: footerObj } : {}),
    action: { button, sections: normalizedSections },
  }, "list send");
};

const sendButtonsTo = async (to, { body, buttons, header, footer } = {}) => {
  if (!to) throw new Error("buttons send: recipient is required");
  const bodyText = requireText(body, LIMITS.BODY, "buttons body");
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error("buttons send: at least one button is required");
  }
  if (buttons.length > LIMITS.MAX_BUTTONS) {
    throw new Error(`buttons send: ${buttons.length} buttons exceeds the ${LIMITS.MAX_BUTTONS}-button limit`);
  }
  const normalized = buttons.map((btn, idx) => {
    if (!btn || btn.id == null || String(btn.id).length === 0) {
      throw new Error(`buttons send: button ${idx + 1} missing id`);
    }
    const id = String(btn.id);
    if (id.length > LIMITS.BUTTON_ID) {
      throw new Error(`buttons send: button ${idx + 1} id exceeds ${LIMITS.BUTTON_ID} characters`);
    }
    const title = cut(btn.title, LIMITS.BUTTON_TITLE);
    if (!title.trim()) throw new Error(`buttons send: button ${idx + 1} missing title`);
    return { type: "reply", reply: { id, title } };
  });
  const headerObj = interactiveHeader(header);
  const footerObj = interactiveFooter(footer);
  return interactiveSend(to, {
    type: "button",
    ...(headerObj ? { header: headerObj } : {}),
    body: { text: bodyText },
    ...(footerObj ? { footer: footerObj } : {}),
    action: { buttons: normalized },
  }, "buttons send");
};

const sendCtaUrlTo = async (to, { body, displayText, url, header, footer } = {}) => {
  if (!to) throw new Error("cta_url send: recipient is required");
  const bodyText = requireText(body, LIMITS.BODY, "cta_url body");
  const display = requireText(displayText, LIMITS.CTA_DISPLAY_TEXT, "cta_url display text");
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    throw new Error("cta_url send: url must be a valid http(s) URL");
  }
  const headerObj = interactiveHeader(header);
  const footerObj = interactiveFooter(footer);
  return interactiveSend(to, {
    type: "cta_url",
    ...(headerObj ? { header: headerObj } : {}),
    body: { text: bodyText },
    ...(footerObj ? { footer: footerObj } : {}),
    action: { name: "cta_url", parameters: { display_text: display, url: String(url) } },
  }, "cta_url send");
};

// Interactive ids emitted by this bot. Unknown ids get a friendly retry;
// ids valid for a different stage get an "expired" notice. Typed text is
// untouched by this guard.
const KNOWN_INTERACTIVE_IDS = new Set([
  "ai-tools", "continue", "lesson-planning", "terms_agree", "terms_decline", "quiz", "menu",
]);
const isInteractiveIdAllowed = (id, state) => {
  if (id === "menu") return true;
  if (id === "ai-tools" || id === "continue" || id === "lesson-planning") return state.stage === STAGES.MAIN_MENU;
  if (id === "terms_agree" || id === "terms_decline") {
    return (state.stage === STAGES.WELCOME && state.welcomeStep === "await_terms") ||
      (state.stage === STAGES.REGISTRATION && state.regField === "terms");
  }
  if (id === "quiz") return state.stage === STAGES.LEARNING;
  return false;
};

// Central media sender (upload-for-ID). Accepts a legacy
// MessageMedia-like ({ filename, mimetype, data }), an absolute file path,
// or a bare filename relative to media/. Type is inferred from extension:
// image -> image+caption, audio -> audio, pdf -> document+caption.
// pace: "human" (3-8s, default) | "chunk" (2-4s, in-slide media).
const resolveMediaPath = (media) => {
  if (typeof media === "string") {
    if (path.isAbsolute(media) && fs.existsSync(media)) return media;
    const inMedia = path.join(MEDIA_DIR, media);
    if (fs.existsSync(inMedia)) return inMedia;
    if (fs.existsSync(media)) return media;
    return null;
  }
  if (media && typeof media === "object") {
    if (media.filePath && fs.existsSync(media.filePath)) return media.filePath;
    if (media.filename) {
      const inMedia = path.join(MEDIA_DIR, path.basename(media.filename));
      if (fs.existsSync(inMedia)) return inMedia;
    }
  }
  return null;
};

const sendMedia = async (message, media, options = {}, pace = "human") => {
  return enqueueGlobalSend(async () => {
    const waitMs = pace === "chunk" ? randomChunkDelay() : randomHumanDelay();
    const filePath = resolveMediaPath(media);
    const caption = options?.caption || "";
    console.log(`📤 Media send: file=${filePath || media?.filename || "?"} caption=${caption.length} chars (pacing ${pace} ${(waitMs / 1000).toFixed(1)}s)`);
    await humanPace(message, waitMs);
    if (!filePath) {
      console.log("📤 Media file not found, falling back to caption/text only");
      if (caption) return await sendTextTo(message.from, caption);
      throw new Error("media file not found and no caption fallback");
    }
    const mime = mimeForFile(filePath);
    if (mime.startsWith("image/")) return await sendImageTo(message.from, filePath, caption);
    if (mime.startsWith("audio/")) return await sendAudioTo(message.from, filePath);
    if (mime.startsWith("video/")) return await sendVideoTo(message.from, filePath, caption);
    return await sendDocumentTo(message.from, filePath, caption);
  });
};

// Thin shims used by the rewritten call sites below (same queue/pacing).
const sendImageFile = (message, filename, caption, pace = "human") =>
  sendMedia(message, filename, { caption: caption || "" }, pace);
const sendAudioFile = (message, filename, pace = "chunk") =>
  sendMedia(message, filename, {}, pace);
const sendDocumentFile = (message, filePath, caption, filename, pace = "human") =>
  sendMedia(message, { filePath, filename: filename || path.basename(filePath) }, { caption: caption || "" }, pace);
const STAGES = {
  NEW: "new",
  WELCOME: "welcome",
  REGISTRATION: "registration",
  MAIN_MENU: "main_menu",
  TOPIC_INTRO: "topic_intro",
  TOOLS_LIST: "tools_list",
  TOOLS_LIST_SELECTION: "tools_list_selection",
  LEARNING: "learning",
  QUIZ: "quiz",
  COMPLETED: "completed",
  AWAITING_FEEDBACK: "awaiting_feedback"
};

const REG_FIELDS = ["fullName", "terms", "email_input", "province", "country", "community", "gender", "age", "language", "jobRole"];

const userStates = new Map();
let optedInUsers = new Set();
let usersDB = {};

const loadData = () => {
  try {
    if (fs.existsSync("opted_in_users.json")) {
      optedInUsers = new Set(JSON.parse(fs.readFileSync("opted_in_users.json")));
    }
    if (fs.existsSync("users_db.json")) {
      usersDB = JSON.parse(fs.readFileSync("users_db.json"));
    }
  } catch (e) {
    console.error("Error loading data:", e);
  }
};

const saveData = () => {
  try {
    fs.writeFileSync("opted_in_users.json", JSON.stringify([...optedInUsers]));
    fs.writeFileSync("users_db.json", JSON.stringify(usersDB, null, 2));
  } catch (e) {
    console.error("Error saving data:", e);
  }
};

const updateLastActive = (userId) => {
  if (usersDB[userId]) {
    usersDB[userId].lastActive = Date.now();
    saveData();
  }
};

const getUserProgressSummary = (userId, topicId = "ai-tools") => {
  const user = usersDB[userId];
  if (!user || !user.progress || !user.progress[topicId]) {
    return null;
  }
  
  const progress = user.progress[topicId];
  const modules = progress.modules;
  
  const topic = getTopic(topicId);
  if (!topic) return null;
  
  let currentModuleIndex = 0;
  let currentSlideIndex = 0;
  let moduleNames = [];
  let completedModules = 0;
  let totalModules = topic.modules.length;
  let totalSlides = 0;
  
  for (let i = 0; i < topic.modules.length; i++) {
    const mod = topic.modules[i];
    moduleNames.push(mod.title);
    totalSlides = Math.max(totalSlides, mod.slides?.length || 0);
    if (modules[mod.id]?.completed) {
      completedModules++;
      currentModuleIndex = i + 1;
    }
  }
  
  const lastModule = topic.modules[currentModuleIndex];
  if (lastModule && modules[lastModule.id]) {
    const slides = modules[lastModule.id].slides || [];
    const maxSlide = Math.max(...slides.filter(s => s !== null && s !== undefined), 0);
    currentSlideIndex = maxSlide + 1;
  } else if (currentModuleIndex < topic.modules.length) {
    currentSlideIndex = 0;
  }
  
  if (currentModuleIndex >= topic.modules.length) {
    currentModuleIndex = topic.modules.length - 1;
  }
  
  return {
    currentModuleIndex: Math.min(currentModuleIndex, topic.modules.length - 1),
    currentSlideIndex,
    moduleNames,
    completedModules,
    totalModules,
    totalSlides,
    currentModuleName: moduleNames[currentModuleIndex] || "Unknown"
  };
};

const SHOULD_WELCOME_BACK_DAYS = 1;

const getUserState = (userId) => {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      stage: STAGES.NEW,
      data: {},
      regField: null,
      currentTopic: null,
      currentModule: null,
      currentSlide: 0,
      currentQuizQuestion: 0,
      quizAnswers: [],
      startedAt: null,
      awaitingCertConfirm: false
    });
  }
  return userStates.get(userId);
};

const updateUserProgress = (userId, topicId, moduleId, slideIndex, completed = false) => {
  const user = usersDB[userId];
  if (!user) return;
  
  if (!user.progress) user.progress = {};
  if (!user.progress[topicId]) user.progress[topicId] = { modules: {}, completed: false };
  
  if (moduleId) {
    if (!user.progress[topicId].modules[moduleId]) {
      user.progress[topicId].modules[moduleId] = { slides: [], completed: false };
    }
    if (slideIndex !== undefined) {
      if (!user.progress[topicId].modules[moduleId].slides.includes(slideIndex)) {
        user.progress[topicId].modules[moduleId].slides.push(slideIndex);
      }
    }
    if (completed) {
      user.progress[topicId].modules[moduleId].completed = true;
    }
  }
  
  if (completed) {
    user.progress[topicId].completed = true;
  }
  
  saveData();
};

const generateProgressBar = (completed, total) => {
  const filled = "🟩".repeat(completed);
  const empty = "🟥".repeat(total - completed);
  return `Topic Progress ${filled}${empty}`;
};

const formatMenu = (menu, userName) => {
  return menu.text;
};

const formatQuiz = (question, num) => {
  let text = `*Question ${num}/${question.total}*\n\n${question.q}\n\n`;
  question.options.forEach((opt, idx) => {
    text += `${idx + 1}. ${opt}\n`;
  });
  text += "\n*Reply with the number of your answer.*";
  return text;
};

// FIX 1 — strict trigger: ONLY the phrase "hello temi" may onboard a new
// user. Normalization: lowercase, trim, collapse whitespace, strip
// punctuation and emoji (anything not a letter/number/whitespace becomes a
// space). "hello temi!", "Hello, Temi", "hello temi 🙏" all match; extra
// words ("hello temi please explain AI") do NOT match.
const TRIGGER_PHRASE = "hello temi";
const isTriggerPhrase = (body) => {
  const normalized = String(body || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalized === TRIGGER_PHRASE;
};

// FIX 3 — a user counts as registered only once they COMPLETED registration
// (full name + terms + all remaining fields through language/jobRole, which
// are set together in the final step). Partial rows (e.g. name given but
// email missing) do NOT count — they continue registration one field at a
// time instead of being shown a progress card.
const isRegistered = (userId) => {
  const u = usersDB[userId];
  return !!(u && u.fullName && u.agreedToTerms && (u.language || u.jobRole));
};

// GLOBAL PERSONALIZATION — single source for the user's display name.
// Reads the current WhatsApp user's OWN registration record (fullName);
// falls back to the generic "Teacher" when unavailable. Never returns
// undefined, null, or an empty string. Every personalized message must
// go through this helper — never read .fullName/.name inline.
const getDisplayName = (userId) => {
  const n = usersDB[userId]?.fullName;
  return (typeof n === "string" && n.trim().length > 0) ? n.trim() : "Teacher";
};

// FIX 3 — returning-user progress card. Shows per-module ✅ / ⏳ / ⬜ lines,
// resuming slide or quiz position where applicable.
const buildReturningUserMessage = (userId) => {
  const user = usersDB[userId] || {};
  const name = getDisplayName(userId);
  const topicId = user.lastTopic || "ai-tools";
  const topic = getTopic(topicId);
  const progModules = (user.progress && user.progress[topicId] && user.progress[topicId].modules) || {};

  let lines = [];
  if (topic && topic.modules) {
    topic.modules.forEach((mod, idx) => {
      const prog = progModules[mod.id] || {};
      const shortTitle = mod.title.replace(/^Module \d+:\s*/i, "");
      if (prog.completed) {
        lines.push(`✅ Module ${idx + 1}: ${shortTitle} — Completed`);
      } else if (prog.slides && prog.slides.length > 0) {
        const slides = prog.slides.filter((s) => s !== null && s !== undefined);
        const step = slides.length > 0 ? Math.max(...slides) + 2 : 1;
        const total = mod.slides?.length || "?";
        lines.push(`⏳ Module ${idx + 1}: ${shortTitle} — In Progress (Step ${Math.min(step, total)} of ${total})`);
      } else if (user.quizState && user.quizState.inQuiz && user.quizState.moduleId === mod.id) {
        lines.push(`⏳ Module ${idx + 1}: ${shortTitle} — In Progress (Quiz, Q${(user.quizState.questionIndex || 0) + 1})`);
      } else {
        lines.push(`⬜ Module ${idx + 1}: ${shortTitle} — Not started`);
      }
    });
  }

  let msg = `Welcome back, ${name}! 👋\nHere's your progress:\n`;
  msg += lines.join("\n");
  msg += `\n\nReply CONTINUE to pick up where you left off\nReply MENU to see all modules`;
  return msg;
};

// A cold-session record exists but registration was never completed.
// Trigger must RESUME (never restart or duplicate) from the first gap.
const hasPartialRegistration = (userId) => {
  const u = usersDB[userId];
  return !!(u && !isRegistered(userId) && (u.agreedToTerms || u.fullName || u.email || u.province || u.country || u.community || u.gender || u.age || u.language));
};

// Resume an incomplete registration with exactly ONE prompt for the first
// missing step. Reads existing data only — never writes user input here,
// so nothing is duplicated or reset.
const resumePartialRegistration = async (message) => {
  const userId = message.from;
  const state = getUserState(userId);
  if (!usersDB[userId]) {
    usersDB[userId] = { createdAt: Date.now(), progress: {} };
  }
  const u = usersDB[userId];
  const reg = getRegistration();
  state.welcomeStep = null;
  // Greet returning partial users by the name already on file (never
  // before it is available — fullName missing means no greeting yet).
  const backPrefix = (typeof u.fullName === "string" && u.fullName.trim().length > 0)
    ? `Welcome back, ${u.fullName.trim()}! Let's continue where you left off.\n\n`
    : "";
  if (!u.agreedToTerms) {
    state.stage = STAGES.WELCOME;
    state.welcomeStep = "await_terms";
    await sendTermsPrompt(message, backPrefix);
    return;
  }
  state.stage = STAGES.REGISTRATION;
  if (!u.fullName) {
    state.regField = "fullName";
    await pacedReply(message, reg.fullName.prompt);
    return;
  }
  if (!u.email) {
    state.regField = "email_input";
    await pacedReply(message, backPrefix + reg.email.prompt);
    return;
  }
  if (!u.province) {
    state.regField = "province";
    await pacedReply(message, backPrefix + formatOptions(reg.province));
    return;
  }
  if (!u.country) {
    state.regField = "country";
    await pacedReply(message, backPrefix + formatOptions(reg.country));
    return;
  }
  if (!u.community) {
    state.regField = "community";
    await pacedReply(message, backPrefix + formatOptions(reg.community));
    return;
  }
  if (!u.gender) {
    state.regField = "gender";
    await pacedReply(message, backPrefix + formatOptions(reg.gender));
    return;
  }
  if (!u.age) {
    state.regField = "age";
    await pacedReply(message, backPrefix + formatOptions(reg.age));
    return;
  }
  state.regField = "language";
  await pacedReply(message, backPrefix + formatOptions(reg.language));
};

// FIX 3 — send the returning-user card and park in WELCOME awaiting
// their CONTINUE / MENU choice. Never touches registration.
const sendReturningUserMenu = async (message) => {
  const userId = message.from;
  const state = getUserState(userId);
  state.stage = STAGES.WELCOME;
  state.welcomeStep = "await_resume_choice";
  state.regField = null;
  await pacedReply(message, buildReturningUserMessage(userId));
};

// FIX 3 — pick up exactly where the user left off:
// quiz question > module slide > main menu > fresh start.
const resumeWhereLeftOff = async (message) => {
  const userId = message.from;
  const state = getUserState(userId);
  const user = usersDB[userId] || {};
  const topicId = user.lastTopic || user.quizState?.topicId ||
    Object.keys(user.progress || {})[0] || "ai-tools";
  const topic = getTopic(topicId);

  // 1) Mid-quiz → resume exact question
  const qs = usersDB[userId]?.quizState;
  if (qs && qs.inQuiz && topic) {
    const module = topic.modules.find((m) => m.id === qs.moduleId);
    if (module && module.questions && module.questions[qs.questionIndex]) {
      state.currentTopic = topicId;
      state.currentModule = module;
      state.currentQuizQuestion = qs.questionIndex;
      state.quizAnswers = [];
      state.stage = STAGES.QUIZ;
      const q = module.questions[qs.questionIndex];
      await pacedReply(message, `Welcome back, ${getDisplayName(userId)}! 👋\n\n📚 *${module.title}* — resuming Quiz at Question ${qs.questionIndex + 1} of ${module.questions.length}\n\n`);
      await pacedReply(message, formatQuiz({ q: q.q, options: q.options, total: module.questions.length }, qs.questionIndex + 1));
      return;
    }
  }

  // 2) Mid-module → resume exact slide
  const summary = getUserProgressSummary(userId, topicId);
  if (summary && topic) {
    const module = topic.modules[summary.currentModuleIndex];
    if (module && module.slides && module.slides[summary.currentSlideIndex]) {
      state.currentTopic = topicId;
      state.currentModule = module;
      state.currentSlide = summary.currentSlideIndex;
      state.stage = STAGES.LEARNING;
      state.quizAnswers = [];
      await pacedReply(message, `Welcome back, ${getDisplayName(userId)}! 👋\n\n📚 *${module.title}* — Step ${summary.currentSlideIndex + 1} of ${module.slides.length}\n\n`);
      await sendSlide(message, state, module.slides[state.currentSlide]);
      return;
    }
    // 3) Some modules done but none in progress → main menu
    if (summary.completedModules > 0) {
      state.stage = STAGES.MAIN_MENU;
      const mainMenu = getMainMenu();
      await sendMainMenu(message);
      return;
    }
  }

  // 4) Fresh (registered but never started) → main menu
  state.stage = STAGES.MAIN_MENU;
  const mainMenu = getMainMenu();
  await sendMainMenu(message);
};

const handleNewUser = async (message) => {
  const userId = message.from;
  const state = getUserState(userId);
  state.stage = STAGES.WELCOME;
  // FIX 2 sequencing: Step 1 = welcome image + caption ONLY.
  // Next message (any reply incl. 👍) advances to terms in handleWelcome.
  state.welcomeStep = "await_ack";
  state.regField = null;
  
  const welcome = getWelcome();
  let welcomeText = welcome.text;
  
  // Welcome image + caption together (upload-for-ID via Graph API).
  if (welcome.media) {
    try {
      const mediaPath = path.join(MEDIA_DIR, welcome.media.filename);
      if (fs.existsSync(mediaPath)) {
        await sendImageFile(message, mediaPath, welcomeText);
        return;
      } else {
        console.log(`Welcome media missing at ${mediaPath}, sending text only`);
      }
    } catch (e) {
      console.log("Welcome media send failed, sending text only:", e?.message || e);
      console.log("STACK:", e?.stack?.split("\n").slice(0, 6).join("\n"));
    }
  }
  
  await pacedReply(message, welcomeText);
};

const shouldShowWelcomeBack = (userId) => {
  const user = usersDB[userId];
  if (!user || !user.lastActive) return false;
  
  const daysSinceActive = (Date.now() - user.lastActive) / (1000 * 60 * 60 * 24);
  const topicId = user.lastTopic || Object.keys(user.progress || {})[0];
  return daysSinceActive >= SHOULD_WELCOME_BACK_DAYS && !!topicId && !!user.progress?.[topicId];
};

const handleWelcome = async (message) => {
  const userId = message.from;
  const msg = (message.body || "").toLowerCase().trim();
  const state = getUserState(userId);

  // FIX 3 — registered users never re-register. While parked on the
  // progress card, ONLY exact "continue" / "menu" / "hello temi" get a
  // reply. Any other text → silence (strict trigger: nothing else may
  // wake the bot; "hello temi" always re-shows the card as the way back).
  if (isRegistered(userId)) {
    if (msg === "continue") {
      await resumeWhereLeftOff(message);
      return;
    }
    if (msg === "menu") {
      state.stage = STAGES.MAIN_MENU;
      const mainMenu = getMainMenu();
      await sendMainMenu(message);
      return;
    }
    // Parked on the progress card: "hello temi" repeat refreshes it,
    // anything else unrecognised → silence, never a card re-send.
    if (isTriggerPhrase(message.body || "")) {
      await sendReturningUserMenu(message);
      return;
    }
    console.log(`🔇 Ignoring "${message.body || ""}" from parked returning user ${userId} — reply CONTINUE, MENU, or "hello temi".`);
    return;
  }

  // FIX 2 — strict one-at-a-time onboarding for new users.
  // Step 1 already sent (welcome image). Any reply → Step 2 (terms).
  const step = state.welcomeStep || "await_ack";

  if (step === "await_ack") {
    // Step 2: Terms & Conditions agreement. Wait for reply before Step 3.
    state.welcomeStep = "await_terms";
    await sendTermsPrompt(message);
    return;
  }

  if (step === "await_terms") {
    // Step 2 reply → Step 3: agree → ask full name (or resume at the first
    // missing field); decline → stay here and store nothing.
    const reply = normalizeReply(msg);
    const agreed = msg === "terms_agree" || AGREE_REPLIES.includes(reply);
    const declined = msg === "terms_decline" || DECLINE_REPLIES.includes(reply);
    if (agreed) {
      if (!usersDB[userId]) {
        usersDB[userId] = { createdAt: Date.now(), progress: {} };
      }
      usersDB[userId].agreedToTerms = true;
      saveData();
      state.stage = STAGES.REGISTRATION;
      state.welcomeStep = null;
      const reg = getRegistration();
      if (usersDB[userId].fullName) {
        // Resuming: name already on file — continue at email, no duplicate.
        state.regField = "email_input";
        await pacedReply(message, reg.email.prompt);
      } else {
        state.regField = "fullName";
        await pacedReply(message, reg.fullName.prompt);
      }
      return;
    }
    if (declined) {
      await pacedReply(message, TERMS_DECLINE_MESSAGE);
      return;
    }
    await pacedReply(message, TERMS_RETRY_MESSAGE);
    return;
  }

  if (step === "await_resume_choice") {
    // Parked card for a not-yet-registered record: same strict rule —
    // exact CONTINUE / MENU only, "hello temi" refreshes via the global
    // trigger check, anything else → silence.
    if (msg === "continue") {
      await resumeWhereLeftOff(message);
      return;
    }
    if (msg === "menu") {
      state.stage = STAGES.MAIN_MENU;
      const mainMenu = getMainMenu();
      await sendMainMenu(message);
      return;
    }
    console.log(`🔇 Ignoring "${message.body || ""}" from parked user ${userId} — reply CONTINUE, MENU, or "hello temi".`);
    return;
  }

  // Fallback: park on terms step (one message, then wait).
  state.welcomeStep = "await_terms";
  await sendTermsPrompt(message);
};

const handleRegistration = async (message) => {
  const userId = message.from;
  const msg = (message.body || "").trim();
  const state = getUserState(userId);
  const reg = getRegistration();

  // FIX 3 — fully registered users never re-register here.
  if (isRegistered(userId)) {
    await sendReturningUserMenu(message);
    return;
  }

  if (!usersDB[userId]) {
    usersDB[userId] = { createdAt: Date.now(), progress: {} };
  }

  // FIX 2 ordering guard: terms (Step 2) must precede full name (Step 3).
  // Legacy in-memory states may land here without agreeing — bounce them
  // back to the terms step instead of skipping ahead.
  if (!usersDB[userId].agreedToTerms && state.regField !== "terms") {
    state.stage = STAGES.WELCOME;
    state.welcomeStep = "await_terms";
    await sendTermsPrompt(message);
    return;
  }

  // Resume aid: unknown/null field → pick first missing field one at a time.
  if (!state.regField) {
    if (!usersDB[userId].fullName) state.regField = "fullName";
    else if (!usersDB[userId].email) state.regField = "email_input";
    else if (!usersDB[userId].province) state.regField = "province";
    else if (!usersDB[userId].country) state.regField = "country";
    else if (!usersDB[userId].community) state.regField = "community";
    else if (!usersDB[userId].gender) state.regField = "gender";
    else if (!usersDB[userId].age) state.regField = "age";
    else state.regField = "language";
  }
  
  switch (state.regField) {
    case "fullName":
      // FIX 2 — Step 3 reply → Step 4 (email). One message, then wait.
      // Personalization safety: never store a blank name (would render as
      // empty/undefined downstream) — re-ask instead.
      if (msg.trim().length === 0) {
        await pacedReply(message, reg.fullName.prompt);
        break;
      }
      usersDB[userId].fullName = msg.trim();
      state.regField = "email_input";
      await pacedReply(message, reg.email.prompt);
      break;
      
    case "terms":
      // Legacy fallback — terms now live in WELCOME (Step 2), but honour
      // any stale state pointing here.
      const termsReply = normalizeReply(msg);
      const termsAgreed = msg === "terms_agree" || AGREE_REPLIES.includes(termsReply);
      const termsDeclined = msg === "terms_decline" || DECLINE_REPLIES.includes(termsReply);
      if (termsAgreed) {
        usersDB[userId].agreedToTerms = true;
        state.regField = usersDB[userId].fullName ? "email_input" : "fullName";
        await pacedReply(message, usersDB[userId].fullName ? reg.email.prompt : reg.fullName.prompt);
      } else if (termsDeclined) {
        await pacedReply(message, TERMS_DECLINE_MESSAGE);
      } else {
        await pacedReply(message, TERMS_RETRY_MESSAGE);
      }
      break;
      
    case "email_input": {
      const email = normalizeEmail(msg);
      if (!isValidEmail(email)) {
        // Stay on this step; do not save the invalid value.
        state.regField = "email_input";
        await pacedReply(message, EMAIL_RETRY_MESSAGE);
        break;
      }
      usersDB[userId].email = email;
      state.regField = "province";
      await pacedReply(message, formatOptions(reg.province));
      break;
    }
      
    case "province":
      if (msg.trim().length > 0) {
        usersDB[userId].province = msg.trim();
        state.regField = "country";
        await pacedReply(message, formatOptions(reg.country));
      } else {
        await pacedReply(message, "Please enter your state.");
      }
      break;

    case "country":
      if (msg.trim().length > 0) {
        usersDB[userId].country = msg.trim();
        // Advance to the first still-missing field (later fields may
        // already be saved on pre-existing partial records — never
        // re-ask them).
        const u = usersDB[userId];
        const regNext = getRegistration();
        if (!u.community) {
          state.regField = "community";
          await pacedReply(message, formatOptions(regNext.community));
        } else if (!u.gender) {
          state.regField = "gender";
          await pacedReply(message, formatOptions(regNext.gender));
        } else if (!u.age) {
          state.regField = "age";
          await pacedReply(message, formatOptions(regNext.age));
        } else {
          state.regField = "language";
          await pacedReply(message, formatOptions(regNext.language));
        }
      } else {
        await pacedReply(message, "Please enter your country.");
      }
      break;
      
    case "community":
      const communityIdx = parseInt(msg) - 1;
      if (communityIdx >= 0 && communityIdx < reg.community.buttons.length) {
        usersDB[userId].community = reg.community.buttons[communityIdx];
        state.regField = "gender";
        await pacedReply(message, formatOptions(reg.gender));
      } else {
        await pacedReply(message, "Please enter a valid number from the list.");
      }
      break;
      
    case "gender":
      const genderIdx = parseInt(msg) - 1;
      if (genderIdx >= 0 && genderIdx < reg.gender.buttons.length) {
        usersDB[userId].gender = reg.gender.buttons[genderIdx];
        state.regField = "age";
        await pacedReply(message, formatOptions(reg.age));
      } else {
        await pacedReply(message, "Please enter a valid number from the list.");
      }
      break;
      
    case "age":
      const ageIdx = parseInt(msg) - 1;
      if (ageIdx >= 0 && ageIdx < reg.age.options.length) {
        usersDB[userId].age = reg.age.options[ageIdx];
        state.regField = "language";
        await pacedReply(message, formatOptions(reg.language));
      } else {
        await pacedReply(message, "Please enter a valid number from the list.");
      }
      break;
      
    case "language":
      const langIdx = parseInt(msg) - 1;
      if (langIdx >= 0 && langIdx < reg.language.options.length) {
        usersDB[userId].language = reg.language.options[langIdx];
        usersDB[userId].jobRole = "Teacher";
        state.stage = STAGES.MAIN_MENU;
        state.regField = null;
        saveData();

        // Greeting first, then the interactive main menu.
        await pacedReply(message, `You're all set, ${usersDB[userId].fullName}! 🎉`);
        await sendMainMenu(message);
      } else {
        await pacedReply(message, "Please enter a valid number from the list.");
      }
      break;
    default:
      // Unknown field — re-ask the first missing field (one message).
      if (!usersDB[userId].fullName) {
        state.regField = "fullName";
        await pacedReply(message, reg.fullName.prompt);
      } else {
        state.regField = "email_input";
        await pacedReply(message, reg.email.prompt);
      }
      break;
  }
  
  saveData();
};

const formatOptions = (field) => {
  let text = field.prompt + "\n\n";
  if (field.options) {
    field.options.forEach((opt, idx) => {
      text += `${idx + 1}. ${opt}\n`;
    });
  } else if (field.buttons) {
    field.buttons.forEach((opt, idx) => {
      text += `${idx + 1}. ${opt}\n`;
    });
  }
  return text;
};

// Terms agreement: reply buttons with a plain-text fallback. Typed 1/2 and
// yes/no still work through AGREE_REPLIES / DECLINE_REPLIES in handleWelcome.
const TERMS_BUTTONS = [
  { id: "terms_agree", title: "Yes, I agree" },
  { id: "terms_decline", title: "No, I do not agree" },
];
const sendTermsPrompt = async (message, prefix = "") => {
  const reg = getRegistration();
  const body = `${prefix}${reg.terms.prompt}`;
  try {
    return await sendButtonsTo(message.from, { body, buttons: TERMS_BUTTONS });
  } catch (e) {
    console.error("Terms buttons failed, falling back to text:", e?.message || e);
    return await pacedReply(message, `${prefix}${formatOptions(reg.terms)}`);
  }
};

// Main menu: <=3 options as reply buttons, 4+ as a list. Throws on payload
// limits so sendMainMenu can fall back to the numbered plain-text menu.
const sendMenuTo = async (to, { intro, options }) => {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error("menu send: at least one option is required");
  }
  if (options.length <= 3) {
    return await sendButtonsTo(to, {
      body: intro,
      buttons: options.map((opt) => ({
        id: opt.id,
        title: opt.buttonTitle || opt.label,
      })),
    });
  }
  return await sendListTo(to, {
    body: intro,
    buttonLabel: "Choose an option",
    sections: [{
      title: "Main menu",
      rows: options.map((opt) => ({
        id: opt.id,
        title: opt.label,
        description: opt.description,
      })),
    }],
  });
};

const sendMainMenu = async (message) => {
  const userId = message.from;
  const mainMenu = getMainMenu();
  try {
    return await sendMenuTo(userId, {
      intro: mainMenu.intro || formatMenu(mainMenu, usersDB[userId]?.name),
      options: mainMenu.options,
    });
  } catch (e) {
    console.error("Main menu interactive send failed, falling back to text:", e?.message || e);
    return await pacedReply(message, formatMenu(mainMenu, usersDB[userId]?.name));
  }
};

const handleMainMenu = async (message) => {
  const userId = message.from;
  const msg = (message.body || "").toLowerCase();
  const state = getUserState(userId);
  const mainMenu = getMainMenu();
  
  if (msg === "menu") {
    await sendMainMenu(message);
    return;
  }
  
  if (msg === "help") {
    const menuHelp = getMenuHelp();
    await pacedReply(message, menuHelp.helpText);
    return;
  }
  
  // Handle quick responses (TOOLS LIST, PROMPT TEMPLATES, etc.)
  const quickResponse = getQuickResponse(msg);
  if (quickResponse) {
    await pacedReply(message, quickResponse);
    await sendMainMenu(message);
    return;
  }
  
  // "continue" (word or Continue button) resumes where the user left off.
  if (msg === "continue") {
    await resumeWhereLeftOff(message);
    return;
  }

  // "progress" (word) opens My Progress; typed numbers follow the displayed
  // menu order below (1 = AI Tools, 2 = Lesson Planning, 3 = Continue).
  if (msg.includes("progress") || msg.includes("my progress")) {
    const summary = getUserProgressSummary(userId, usersDB[userId]?.lastTopic || "ai-tools");
    const mainMenu = getMainMenu();
    
    if (summary && summary.completedModules > 0) {
      const { currentModuleIndex, currentSlideIndex, moduleNames, completedModules, totalModules, currentModuleName } = summary;
      const totalSlides = summary.totalSlides || 8;
      
      let progressMsg = `📚 *YOUR PROGRESS, ${getDisplayName(userId)}*\n\n`;
      progressMsg += `You're on *${currentModuleName}*, Step ${currentSlideIndex + 1} of ${totalSlides}\n`;
      progressMsg += `Modules completed: ${completedModules}/${totalModules}\n\n`;
      progressMsg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      progressMsg += `1. Continue from where you left off\n`;
      progressMsg += `2. Start over (restart current module)\n`;
      progressMsg += `3. Main Menu`;
      
      await pacedReply(message, progressMsg);
      state.stage = STAGES.TOOLS_LIST_SELECTION;
      return;
    } else {
      await pacedReply(message, `📚 *MY PROGRESS*\n\nYou haven't started yet.\n\nReply *1* to begin learning!\nReply *MENU* to go back to main menu.`);
      state.stage = STAGES.TOPIC_INTRO;
      return;
    }
  }
  
  // Option 2 alt - Tools List (for admins/supervisors)
  if (msg.includes("tools list") || msg.includes("skip") || msg === "admin tools") {
    const topic = getTopic("ai-tools");
    const modulesList = topic.modules.map((m, idx) => `${idx + 1}. ${m.title}`).join("\n");
    await pacedReply(message, `Which module would you like to access?\n\n${modulesList}\n\nReply with a number (1-3) to select a module.\nReply *MENU* to go back to main menu.`);
    state.stage = STAGES.TOOLS_LIST;
    return;
  }
  
  // Interactive list/button ids map back to their menu position.
  const optionIndex = mainMenu.options.findIndex((opt) => opt.id === msg);
  const choice = optionIndex >= 0 ? optionIndex + 1 : parseInt(msg);
  if (!isNaN(choice) && choice >= 1 && choice <= mainMenu.options.length) {
    const selectedOption = mainMenu.options[choice - 1];
    // The Continue option resumes the user's last course instead of being
    // treated as a topic id (there is no "continue" topic in contentDB).
    if (selectedOption.id === "continue") {
      await resumeWhereLeftOff(message);
      return;
    }
    const topicId = selectedOption.id;
    state.currentTopic = topicId;
    if (usersDB[userId]) {
      usersDB[userId].lastTopic = topicId;
      saveData();
    }
    state.stage = STAGES.TOPIC_INTRO;
    
    console.log("Selected topic:", topicId);
    
    const topic = getTopic(topicId);
    if (!topic) {
      await pacedReply(message, "Error: Topic not found. Please try again.");
      state.stage = STAGES.MAIN_MENU;
      await sendMainMenu(message);
      return;
    }
    
    let introText = topic.intro || "Welcome to this topic!";
    introText = introText.replace("{name}", getDisplayName(userId));
    
    const introMediaPath = path.join(MEDIA_DIR, "tools list  intro.jpeg");
    if (fs.existsSync(introMediaPath)) {
      await sendImageFile(message, introMediaPath, introText + "\n\nReply with *1* to start or *2* to go back.");
    } else {
      await pacedReply(message, introText + "\n\nReply with *1* to start or *2* to go back.");
    }
  } else {
    await pacedReply(message, "Please select a valid option (1-" + mainMenu.options.length + ").");
    await sendMainMenu(message);
  }
};

const handleToolsList = async (message) => {
  const userId = message.from;
  const msg = (message.body || "").toLowerCase().trim();
  const state = getUserState(userId);
  const mainMenu = getMainMenu();
  const topic = getTopic("ai-tools");
  
  if (msg === "menu") {
    state.stage = STAGES.MAIN_MENU;
    await sendMainMenu(message);
    return;
  }
  
  const choice = parseInt(msg);
  if (!isNaN(choice) && choice >= 1 && choice <= topic.modules.length) {
    const module = topic.modules[choice - 1];
    state.currentTopic = "ai-tools";
    state.currentModule = module;
    
    await pacedReply(message, `You selected: ${module.title}\n\nReply *1* to go to Step 1\nReply *2* to go to Quiz\nReply *MENU* to go back to main menu`);
    state.stage = STAGES.TOOLS_LIST_SELECTION;
    return;
  }
  
  await pacedReply(message, `Please reply with a number (1-${topic.modules.length}) to select a module.\nReply *MENU* to go back to main menu.`);
};

const handleToolsListSelection = async (message) => {
  const userId = message.from;
  const msg = (message.body || "").toLowerCase().trim();
  const state = getUserState(userId);
  const mainMenu = getMainMenu();
  const topicId = usersDB[userId]?.lastTopic || "ai-tools";
  const topic = getTopic(topicId);
  
  if (msg === "menu" || msg === "3") {
    state.stage = STAGES.MAIN_MENU;
    await sendMainMenu(message);
    return;
  }
  
  // Option 1: Continue from where left off
  if (msg === "1" || msg.includes("continue")) {
    const summary = getUserProgressSummary(userId, topicId);
    if (summary && summary.currentModuleIndex < topic.modules.length) {
      const module = topic.modules[summary.currentModuleIndex];
      state.currentTopic = topicId;
      state.currentModule = module;
      state.currentSlide = summary.currentSlideIndex;
      state.stage = STAGES.LEARNING;
      state.quizAnswers = [];
      
      if (module.slides && module.slides[state.currentSlide]) {
        await sendSlide(message, state, module.slides[state.currentSlide]);
      } else {
        state.currentSlide = 0;
        await sendSlide(message, state, module.slides[0]);
      }
      return;
    } else {
      await pacedReply(message, "Starting fresh...");
      state.currentSlide = 0;
      state.stage = STAGES.LEARNING;
      state.quizAnswers = [];
      await sendSlide(message, state, state.currentModule.slides[0]);
      return;
    }
  }
  
  // Option 2: Start over (restart current module)
  if (msg === "2" || msg.includes("start over") || msg.includes("restart")) {
    if (state.currentModule) {
      state.currentSlide = 0;
      state.stage = STAGES.LEARNING;
      state.quizAnswers = [];
      await pacedReply(message, `🔄 Restarting ${state.currentModule.title}...\n\nReply *NEXT* to continue through the slides.`);
      await sendSlide(message, state, state.currentModule.slides[0]);
      return;
    }
  }
  
  // Go to Step 1 (direct)
  if (msg === "1" && state.currentModule) {
    state.currentSlide = 0;
    state.stage = STAGES.LEARNING;
    state.quizAnswers = [];
    await sendSlide(message, state, state.currentModule.slides[0]);
    return;
  }
  
  // Go to Quiz
  if (msg === "2" && state.currentModule) {
    state.currentQuizQuestion = 0;
    state.quizAnswers = [];
    state.stage = STAGES.QUIZ;
    // FIX 3 — persist quiz position for resume.
    if (usersDB[userId]) {
      usersDB[userId].quizState = { inQuiz: true, topicId: state.currentTopic || "ai-tools", moduleId: state.currentModule.id, questionIndex: 0 };
      saveData();
    }
    const firstQ = state.currentModule.questions[0];
    await pacedReply(message, formatQuiz({
      q: firstQ.q,
      options: firstQ.options,
      total: state.currentModule.questions.length
    }, 1));
    return;
  }
  
  await pacedReply(message, `Please reply with a valid option.\nReply *MENU* to go back to main menu.`);
};

const handleTopicIntro = async (message) => {
  const userId = message.from;
  const userInput = (message.body || "").toLowerCase().trim();
  const state = getUserState(userId);
  
  console.log("handleTopicIntro - currentTopic:", state.currentTopic);
  console.log("handleTopicIntro - userInput:", userInput);
  
  const topic = getTopic(state.currentTopic);
  
  if (!topic) {
    console.log("ERROR: Topic is null for", state.currentTopic);
    state.stage = STAGES.MAIN_MENU;
    await pacedReply(message, "Something went wrong. Returning to menu.");
    await sendMainMenu(message);
    return;
  }
  
  console.log("Topic found:", topic.title, "Modules:", topic.modules?.length);
  
  if (userInput === "menu" || userInput === "back to main menu" || userInput === "2") {
    state.stage = STAGES.MAIN_MENU;
    const mainMenu = getMainMenu();
    await sendMainMenu(message);
    return;
  }
  
  // Handle quick responses (only for specific keywords, not numbers)
  if (!isNaN(parseInt(userInput))) {
    // It's a number, skip quick response check
  } else {
    const quickResponse = getQuickResponse(userInput);
    if (quickResponse) {
      await pacedReply(message, quickResponse);
      await pacedReply(message, "\nReply with *1* to start or *2* to go back.");
      return;
    }
  }
  
  if (userInput === "1" || userInput.includes("let's go") || userInput.includes("start") || userInput.includes("go")) {
    if (!topic.modules || topic.modules.length === 0) {
      await pacedReply(message, "No content available for this topic yet. Returning to menu.");
      state.stage = STAGES.MAIN_MENU;
      const mainMenu = getMainMenu();
      await sendMainMenu(message);
      return;
    }
    
    const firstModule = topic.modules[0];
    console.log("First module:", firstModule.id, "Slides:", firstModule.slides?.length);
    
    if (!firstModule.slides || firstModule.slides.length === 0) {
      await pacedReply(message, "No slides found for this module. Returning to menu.");
      state.stage = STAGES.MAIN_MENU;
      const mainMenu = getMainMenu();
      await sendMainMenu(message);
      return;
    }
    
    state.currentModule = firstModule;
    state.currentSlide = 0;
    state.stage = STAGES.LEARNING;
    state.quizAnswers = [];
    
    console.log("Starting learning mode for module:", firstModule.id);
    await sendSlide(message, state, firstModule.slides[0]);
  } else {
    // Invalid input - ask again
    await pacedReply(message, "Please reply with *1* to start or *2* to go back.");
  }
};

// Quiz-intro slides end with typed instructions. Detect that exact shape so
// only the quiz intro becomes buttons; all other slides keep text/audio.
const isQuizIntroSlide = (slide) => {
  const text = Array.isArray(slide?.text) ? slide.text.join("\n") : String(slide?.text || "");
  return /Quiz, Teacher!/i.test(text) && /\*QUIZ\*/i.test(text);
};
const buildQuizPromptBody = (text) => {
  const cleaned = String(text || "")
    .split("\n")
    .filter((line) => !/^\s*Reply \*(?:QUIZ|MENU)\*/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `${cleaned}\n\nReady for your quiz?`;
};

const sendSlide = async (message, state, slide) => {
  const userId = message.from;

  // Returns false if a Graph send failed (caller stops the slide, no pile-on).
  // Same-payload chunks use "chunk" pacing (2-4s) via the global queue.
  const safeReply = async (content, options) => {
    try {
      const isMediaPath =
        typeof content === "string" &&
        (content.startsWith(MEDIA_DIR) || /\.(jpe?g|png|webp|mp3|ogg|opus|m4a|mp4|pdf)$/i.test(content)) &&
        fs.existsSync(content);
      const isMediaObj = content && typeof content === "object" && (content.filePath || content.filename);
      if (isMediaPath || isMediaObj) {
        await sendMedia(message, content, options || {}, "chunk");
      } else {
        await pacedReply(message, content, "chunk", options);
      }
      return true;
    } catch (e) {
      const msg = String(e?.message || e || "");
      console.error("Reply failed:", msg.split("\n")[0]);
      return false;
    }
  };

  // Per-step delivery config ("text" | "audio" | "both", default "both").
  // Text-only steps never attach audio; audio-only steps never show text.
  const delivery = slide.delivery || "both";
  const sendText = delivery !== "audio";
  let sendAudio = delivery !== "text";

  const textChunks = Array.isArray(slide.text) ? slide.text : [slide.text];
  const originalText = textChunks.join("\n\n").replace("{name}", getDisplayName(userId));

  if (sendText && isQuizIntroSlide(slide)) {
    try {
      await sendButtonsTo(userId, {
        body: buildQuizPromptBody(originalText),
        buttons: [
          { id: "quiz", title: "Take The Quiz" },
          { id: "menu", title: "Back To Main Menu" },
        ],
      });
    } catch (e) {
      console.error("Quiz prompt buttons failed, falling back to original text:", e?.message || e);
      const ok = await safeReply(originalText);
      if (!ok) return;
    }
  } else if (sendText) {
    for (const chunk of textChunks) {
      let text = chunk.replace("{name}", getDisplayName(userId));
      const ok = await safeReply(text);
      if (!ok) return; // page dead - stop, don't pile on more sends
    }
  }

  if (sendAudio && slide.audio) {
    try {
      const audioPath = path.join(MEDIA_DIR, slide.audio);
      if (fs.existsSync(audioPath)) {
        await sendAudioFile(message, audioPath);
      } else if (!sendText) {
        // Graceful fallback: audio-only step whose file is missing must
        // not strand the user with silence — deliver the text instead.
        console.log(`Audio missing for audio-only step (${slide.audio}), falling back to text`);
        for (const chunk of textChunks) {
          let text = chunk.replace("{name}", getDisplayName(userId));
          const ok = await safeReply(text);
          if (!ok) return;
        }
      }
    } catch (e) {
      console.error("Error sending audio:", String(e?.message || e).split("\n")[0]);
    }
  } else if (slide.media) {
    try {
      const mediaPath = path.join(MEDIA_DIR, slide.media.filename);
      if (fs.existsSync(mediaPath)) {
        await sendMedia(message, mediaPath, { caption: textChunks[textChunks.length - 1] }, "chunk");
      }
    } catch (e) {
      console.error("Error sending media:", String(e?.message || e).split("\n")[0]);
    }
  }

  if (slide.buttons) {
    await safeReply("What would you like to do next?\n\nReply with *1* to continue or *2* to go back.");
  }
};

const handleLearning = async (message) => {
  const userId = message.from;
  const userInput = (message.body || "").toLowerCase().trim();
  const state = getUserState(userId);
  const topic = getTopic(state.currentTopic);
  const module = state.currentModule;
  
  if (userInput === "menu" || userInput === "back to main menu") {
    state.stage = STAGES.MAIN_MENU;
    const mainMenu = getMainMenu();
    await sendMainMenu(message);
    return;
  }
  
  const quickResponse = getQuickResponse(userInput);
  if (quickResponse) {
    await pacedReply(message, quickResponse);
    await pacedReply(message, "\nWhat would you like to do next?\n\nReply *NEXT* to continue or *MENU* to go back to the menu.");
    return;
  }
  
  if (userInput === "next tool") {
    updateUserProgress(userId, state.currentTopic, module.id, null, true);
    state.stage = STAGES.COMPLETED;
    await handleCompleted(message);
    return;
  }
  
  if (userInput === "quiz") {
    state.currentQuizQuestion = 0;
    state.quizAnswers = [];
    state.stage = STAGES.QUIZ;
    // FIX 3 — persist quiz position so a returning user resumes the
    // exact question they left off.
    if (usersDB[userId] && module) {
      usersDB[userId].quizState = { inQuiz: true, topicId: state.currentTopic, moduleId: module.id, questionIndex: 0 };
      saveData();
    }
    const firstQ = module.questions[0];
    await pacedReply(message, formatQuiz({
      q: firstQ.q,
      options: firstQ.options,
      total: module.questions.length
    }, 1));
    return;
  }
  
  if (userInput === "next" || userInput === "1") {
    state.currentSlide++;
    
    if (state.currentSlide < module.slides.length) {
      await sendSlide(message, state, module.slides[state.currentSlide]);
      updateUserProgress(userId, state.currentTopic, module.id, state.currentSlide);
    } else {
      updateUserProgress(userId, state.currentTopic, module.id, null, true);
      state.stage = STAGES.COMPLETED;
      await handleCompleted(message);
    }
  } else if (userInput.includes("back")) {
    state.stage = STAGES.MAIN_MENU;
    const mainMenu = getMainMenu();
    await sendMainMenu(message);
  } else {
    const isLastSlide = state.currentSlide === module.slides.length - 1;
    if (isLastSlide) {
      await pacedReply(message, "Invalid input. Reply *QUIZ* to take the quiz or *MENU* to go back.");
    } else {
      await pacedReply(message, "Invalid input. Reply *NEXT* to continue or *MENU* to go back.");
    }
  }
};

const handleQuiz = async (message) => {
  const userId = message.from;
  const userInput = (message.body || "").trim();
  const state = getUserState(userId);
  const module = state.currentModule;
  
  if (userInput.toLowerCase() === "menu") {
    state.stage = STAGES.MAIN_MENU;
    const mainMenu = getMainMenu();
    await sendMainMenu(message);
    return;
  }
  
  const answer = parseInt(userInput);
  const maxAnswer = module.questions[state.currentQuizQuestion]?.options?.length || 4;
  
  if (isNaN(answer) || answer < 1 || answer > maxAnswer) {
    await pacedReply(message, `Please enter a valid number (1-${maxAnswer}).`);
    return;
  }
  
  const currentQ = module.questions[state.currentQuizQuestion];
  const isCorrect = answer === currentQ.answer;
  state.quizAnswers.push(isCorrect);
  
  const correctSoFar = state.quizAnswers.filter(a => a).length;
  const totalQuestions = module.questions.length;
  
  let feedback = isCorrect 
    ? ["Excellent, Témí says you got it correct!", "That's correct, nice job!", "Great job, you got it right!", "Well done, that's correct!", "That's right, good work!"]
    : ["Sorry, that was not the correct answer. Keep going!", "Not quite right.", "Almost there, but not correct."];
  
  const randomFeedback = feedback[Math.floor(Math.random() * feedback.length)];
  let responseText = randomFeedback + "\n";
  
  if (isCorrect) {
    responseText += `Score: ${correctSoFar}/${totalQuestions}`;
  } else {
    responseText += `The correct answer was: ${currentQ.options[currentQ.answer - 1]}\n`;
    responseText += `Score: ${correctSoFar}/${totalQuestions}`;
  }
  
  if (currentQ.explanation) {
    responseText += `\n\n${currentQ.explanation}`;
  }
  
  await pacedReply(message, responseText);
  
  state.currentQuizQuestion++;
  // FIX 3 — persist quiz position after every answer.
  if (usersDB[userId]) {
    if (state.currentQuizQuestion < module.questions.length) {
      usersDB[userId].quizState = { inQuiz: true, topicId: state.currentTopic, moduleId: module.id, questionIndex: state.currentQuizQuestion };
    } else {
      delete usersDB[userId].quizState;
    }
    saveData();
  }

  if (state.currentQuizQuestion < module.questions.length) {
    await pacedReply(message, "\n━━━━━━━━━━━━━━━━━━━━");
    const nextQ = module.questions[state.currentQuizQuestion];
    await pacedReply(message, formatQuiz({
      q: nextQ.q,
      options: nextQ.options,
      total: module.questions.length
    }, state.currentQuizQuestion + 1));
  } else {
    const correct = correctSoFar;
    const total = totalQuestions;
    const percentage = Math.round((correct / total) * 100);
    
    let finalMessage = `━━━━━━━━━━━━━━━━━━━━\n`;
    finalMessage += `*QUIZ COMPLETE, ${getDisplayName(userId)}!*\n\n`;
    finalMessage += `Final Score: ${correct}/${total} (${percentage}%)\n\n`;
    
    if (percentage === 100) {
      finalMessage += `🎉 PERFECT SCORE! *Témí* says you're a star, ${getDisplayName(userId)}! Amazing work! 🌟`;
    } else if (percentage >= 80) {
      finalMessage += `Excellent work, ${getDisplayName(userId)}! *Témí* says you've really mastered this material! 🎉`;
    } else if (percentage >= 60) {
      finalMessage += `Good job! You've shown solid understanding. Keep it up! 👍`;
    } else if (percentage >= 40) {
      finalMessage += `Not bad! Review the material and you'll do even better next time. 📚`;
    } else {
      finalMessage += `Keep studying! Every expert was once a beginner. *Témí* believes in you! 💪`;
    }
    
    finalMessage += `\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    // FIX 1: Module-specific completion prompts.
    // Final module (Edu Aide) shows DONE; Modules 1-2 show NEXT TOOL.
    const _quizTopic = getTopic(state.currentTopic || "ai-tools");
    const _quizModules = _quizTopic?.modules || [];
    const _isFinalModule = _quizModules.length > 0
      ? _quizModules[_quizModules.length - 1].id === module.id
      : module.id === "eduaide";
    if (_isFinalModule) {
      finalMessage += `Reply *DONE* to see your certificate.\n`;
      finalMessage += `Reply *MENU* to go back to the main menu.`;
    } else {
      finalMessage += `Reply *NEXT TOOL* to continue to the next AI tool.\n`;
      finalMessage += `Reply *MENU* to go back to the main menu.`;
    }
    
    updateUserProgress(userId, state.currentTopic, module.id, null, true);
    
    if (!usersDB[userId].progress[state.currentTopic].modules[module.id]) {
      usersDB[userId].progress[state.currentTopic].modules[module.id] = {};
    }
    usersDB[userId].progress[state.currentTopic].modules[module.id].quizScore = correct;
    saveData();

    // Module completion: ONE combined response — quiz result text as the
    // congratulations image caption (sent together, same moment).
    // Media goes via sendMedia (no quoted msg); text-only fallback if the
    // image file is missing or the send fails. No auto-certificate here —
    // cert only triggers on explicit DONE after all 3 modules (see below).
    const completionFiles = {
      chatgpt: "module1-complete.jpeg",
      magicschool: "module2-complete.jpeg",
      eduaide: "module3-complete.jpeg"
    };
    const completionFile = completionFiles[module.id];
    try {
      const mediaPath = completionFile ? path.join(MEDIA_DIR, completionFile) : null;
      if (mediaPath && fs.existsSync(mediaPath)) {
        await sendImageFile(message, mediaPath, finalMessage);
      } else {
        console.log(`Completion media missing at ${mediaPath}, sending text only`);
        await pacedReply(message, finalMessage);
      }
    } catch (e) {
      console.log("Completion media send failed, sending text only:", e?.message || e);
      try {
        await pacedReply(message, finalMessage);
      } catch {}
    }

    state.stage = STAGES.COMPLETED;
  }
};

const handleCompleted = async (message) => {
  const userId = message.from;
  const userInput = (message.body || "").toLowerCase().trim();
  const state = getUserState(userId);
  const mainMenu = getMainMenu();
  const completion = getCompletion();

  const sendCertificateNow = async (certName) => {
    const courseTopicId = state.currentTopic || usersDB[userId]?.lastTopic || "ai-tools";
    const courseTitle = getTopic(courseTopicId)?.title || "AI Tools for Teachers";
    try {
      await pacedReply(message, `⏳ Generating your certificate for *${certName}*...`);
      const { filePath, certId } = await generateCertificatePDF(certName, { course: courseTitle });
      await sendDocumentFile(message, filePath, `🎓 *YOUR CERTIFICATE IS READY!*\n\nCongratulations *${certName}!* 🎉\n\nYou completed the *${courseTitle}* course.\nCertificate ID: ${certId}\n\n*Témí* says: Learn AI. Teach Better. 💛`, `${certName}-certificate.pdf`);
      if (!usersDB[userId].certificateRequests) {
        usersDB[userId].certificateRequests = [];
      }
      usersDB[userId].certificateRequests.push({
        name: certName,
        email: usersDB[userId].email || "",
        topicId: courseTopicId,
        topicTitle: courseTitle,
        course: courseTitle,
        certId,
        file: filePath,
        date: new Date().toISOString()
      });
      saveData();
      state.awaitingCertConfirm = false;
      state.stage = STAGES.AWAITING_FEEDBACK;
      await pacedReply(message, `Reply *MENU* for main menu 🏠\nReply *SHARE* to share with colleagues 📲`);
      await pacedReply(message, `💬 *One last thing — how was your experience?*\n\nPlease type your feedback right here in the chat, OR fill out this quick form if you prefer:\n${FEEDBACK_FORM_URL}\n\nJust reply with your thoughts (or type *SKIP* to skip).`);
    } catch (e) {
      console.error("Certificate generation failed:", e);
      state.awaitingCertConfirm = false;
      state.stage = STAGES.AWAITING_FEEDBACK;
      await pacedReply(message, `✅ *Certificate Request Saved!*\n\nName: ${certName}\n\nSorry, auto-generation failed — we will send it manually soon! 📧`);
      await pacedReply(message, `💬 *One last thing — how was your experience?*\n\nPlease type your feedback right here in the chat, OR fill out this quick form if you prefer:\n${FEEDBACK_FORM_URL}\n\nJust reply with your thoughts (or type *SKIP* to skip).`);
    }
  };

const handleFeedback = async (message) => {
  const userId = message.from;
  const rawInput = (message.body || "").trim();
  const userInput = rawInput.toLowerCase();
  const state = getUserState(userId);
  const mainMenu = getMainMenu();
  const completion = getCompletion();

  // Honor commands instead of capturing them as feedback (skip-and-continue).
  if (userInput === "menu" || userInput === "2" || userInput.includes("back")) {
    state.stage = STAGES.MAIN_MENU;
    await sendMainMenu(message);
    return;
  }
  if (userInput === "share") {
    state.stage = STAGES.COMPLETED;
    await pacedReply(message, completion.share);
    return;
  }
  if (userInput === "skip" || userInput === "no" || userInput === "n") {
    state.stage = STAGES.MAIN_MENU;
    await pacedReply(message, `No problem — thank you for completing the course! 🙏`);
    await sendMainMenu(message);
    return;
  }
  if (userInput.length === 0) {
    await pacedReply(message, `Please type your feedback, or type *SKIP* to skip.\nYou can also use this form if you prefer:\n${FEEDBACK_FORM_URL}`);
    return;
  }
  // Capture the reply as feedback (truncate to protect JSON/CSV).
  if (!usersDB[userId]) {
    usersDB[userId] = { createdAt: Date.now(), progress: {} };
  }
  usersDB[userId].feedback = { text: rawInput.slice(0, 1000), at: new Date().toISOString() };
  saveData();
  state.stage = STAGES.MAIN_MENU;
  await pacedReply(message, `Thank you so much for your feedback! 🙏 It helps us make *Témí* better for teachers like you. 💛`);
  await sendMainMenu(message);
};

  // SINGLE certificate flow: user typed DONE after Module 3 and is now
  // confirming the name. Confirm with YES or reply with correct FULL NAME.
  // No email is ever asked — cert auto-generates and delivers in chat.
  if (state.awaitingCertConfirm) {
    const input = (message.body || "").trim();

    if (/^(menu|2|back)$/i.test(input) || input.toLowerCase().includes("back")) {
      state.awaitingCertConfirm = false;
      state.stage = STAGES.MAIN_MENU;
      await sendMainMenu(message);
      return;
    }

    // User confirmed saved name
    if (/^(yes|yeah|correct|ok|confirm)$/i.test(input) && usersDB[userId]?.fullName) {
      await sendCertificateNow(usersDB[userId].fullName);
      return;
    }

    const certName = input;

    if (certName.length >= 2 && !/^(done|certificate|cert|menu|retake|next tool|next|share)$/i.test(certName)) {
      await sendCertificateNow(certName);
    } else if (/^(next tool|next)$/i.test(certName)) {
      state.awaitingCertConfirm = false;
      // fall through to next-tool handling below
    } else {
      await pacedReply(message, `Please reply with your FULL NAME as you want it on the certificate.\n\nExample: *John Smith*`);
      return;
    }
    if (/^(next tool|next)$/i.test(certName)) {
      // handled by next-tool block below — do not return here
    } else {
      return;
    }
  }
  
  // Handle "next tool" or "next" - go to next module
  if (userInput === "next tool" || userInput === "next" || userInput === "finished" || userInput === "all done" || userInput === "completed" || userInput === "i am done" || userInput === "i have finished all tools") {
    const currentTopic = getTopic(state.currentTopic);
    if (!currentTopic || !currentTopic.modules) {
      state.stage = STAGES.MAIN_MENU;
      await sendMainMenu(message);
      return;
    }
    
    const currentModuleIndex = currentTopic.modules.findIndex(m => m.id === state.currentModule?.id);
    const nextModule = currentTopic.modules[currentModuleIndex + 1];
    
    if (nextModule) {
      state.currentModule = nextModule;
      state.currentSlide = 0;
      state.stage = STAGES.LEARNING;
      state.quizAnswers = [];
      // FIX 3 — leaving quiz context: clear stale quiz resume pointer.
      if (usersDB[userId]?.quizState) {
        delete usersDB[userId].quizState;
        saveData();
      }

      await sendSlide(message, state, nextModule.slides[0]);
    } else {
      // Full course already completed (incl. after certificate delivery) —
      // single message, no old manual cert flow.
      await pacedReply(message, `You have completed the full course! Reply *MENU* for main menu or *SHARE* to share with colleagues`);
    }
    return;
  }
  
  // Handle "done" / "certificate" — explicit DONE only, and only after
  // ALL modules are complete. Never auto-generates. Asks for name
  // confirmation first; cert generates on YES / name reply (see above).
  if (userInput === "done" || userInput === "certificate" || userInput === "cert") {
    const topicId = state.currentTopic || usersDB[userId]?.lastTopic || "ai-tools";
    const topic = getTopic(topicId);
    const topicModules = topic?.modules || [];
    const progModules = usersDB[userId]?.progress[topicId]?.modules || {};
    const allModulesDone = topicModules.length > 0 && topicModules.every((m) => progModules[m.id]?.completed);

    if (!allModulesDone) {
      const doneCount = topicModules.filter((m) => progModules[m.id]?.completed).length;
      const totalCount = topicModules.length || 3;
      await pacedReply(message, `📚 *Not quite yet!*\n\nYou've completed ${doneCount}/${totalCount} modules.\n\nFinish all ${totalCount} modules first, then reply *DONE* to get your certificate.\n\nReply *NEXT TOOL* to continue ➡️\nReply *MENU* for main menu 🏠`);
      return;
    }

    const topicPassMarks = { "ai-tools": 4, "lesson-planning": 5 };
    const passMark = topicPassMarks[topicId] || 4;
    const belowPass = topicModules.filter((m) => {
      const score = progModules[m.id]?.quizScore || 0;
      return score < passMark;
    });

    if (belowPass.length > 0) {
      const details = belowPass.map((m) => {
        const score = progModules[m.id]?.quizScore || 0;
        return `• ${m.title}: ${score}/${m.questions.length}`;
      }).join("\n");
      await pacedReply(message, `📝 *Quiz Retake Required*\n\nYou need at least *${passMark}* correct in every module before your certificate can be issued.\n\n${details}\n\n━━━━━━━━━━━━━━━━━━━━\n\nReply *RETAKE* to try the quiz again.\nReply *MENU* to go back to the main menu.`);
      return;
    }
    
    // Reuse name from registration — no email asked, cert auto-delivers in chat
    const savedName = usersDB[userId]?.fullName || "";
    state.awaitingCertConfirm = true;
    state.stage = STAGES.COMPLETED;
    if (savedName) {
      await pacedReply(message, `📝 *Almost done!*\n\nWe have your name as: *${savedName}*\n\nReply *YES* to print your certificate with this name,\nor reply with your correct FULL NAME (e.g. *John Smith*).`);
    } else {
      await pacedReply(message, `📝 *Certificate Request*\n\nPlease reply with your FULL NAME as you want it on the certificate.\n\nExample: *John Smith*`);
    }
    return;
  }
  
  // Handle retake quiz
  if (userInput === "retake" || userInput === "retry") {
    if (state.currentModule) {
      state.currentQuizQuestion = 0;
      state.quizAnswers = [];
      state.stage = STAGES.QUIZ;
      // FIX 3 — persist quiz position for resume.
      if (usersDB[userId]) {
        usersDB[userId].quizState = { inQuiz: true, topicId: state.currentTopic || "ai-tools", moduleId: state.currentModule.id, questionIndex: 0 };
        saveData();
      }
      const firstQ = state.currentModule.questions[0];
      await pacedReply(message, `📝 *Retaking Quiz for ${state.currentModule.title}*\n\n`);
      await pacedReply(message, formatQuiz({
        q: firstQ.q,
        options: firstQ.options,
        total: state.currentModule.questions.length
      }, 1));
      return;
    }
  }
  
  // Handle "share" - get shareable message
  if (userInput === "share") {
    await pacedReply(message, completion.share);
    return;
  }
  
  // Handle menu / back
  if (userInput === "menu" || userInput === "2" || userInput.includes("back")) {
    state.stage = STAGES.MAIN_MENU;
    await sendMainMenu(message);
    return;
  }
  
  // Default - show available options
  await pacedReply(message, "Reply *NEXT TOOL* to continue to the next tool ➡️\nReply *DONE* to see your certificate 🎓\nReply *SHARE* to share with colleagues 📲\nReply *MENU* to go back to the main menu 🏠");
};

// Dedupe: Meta may retry webhook deliveries — one user tap must never run
// sendSlide concurrently. Same guard as before, keyed on Meta message ID.
const seenMessageIds = new Set();
const userQueues = new Map();

const enqueueForUser = (userId, fn) => {
  const prev = userQueues.get(userId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  userQueues.set(userId, next.catch(() => {}));
  next.catch(() => {}).finally(() => {
    if (userQueues.get(userId)) {
      // tail settled — allow a fresh chain next time; drop the ref
      userQueues.delete(userId);
    }
  });
  return next;
};

// Inbound entry from the webhook route. Drops groups/status/self-echoes,
// dedupes Meta retries, then serializes work per user so rapid taps queue.
const handleWebhookMessage = async (message) => {
  try {
    if (!message || !message.from) return;

    // Dedupe identical deliveries of the same WhatsApp message
    const msgId = typeof message.id === "string" ? message.id : message.id?.id;
    if (msgId) {
      if (seenMessageIds.has(msgId)) {
        console.log(`⏭️ Ignoring duplicate delivery of ${msgId}`);
        return;
      }
      seenMessageIds.add(msgId);
      if (seenMessageIds.size > 1000) {
        const first = seenMessageIds.values().next().value;
        seenMessageIds.delete(first);
      }
    }

    const userId = message.from;

    // Observability for non-text inbound (voice notes, images, docs, stickers
    // arrive with no text body — intentionally silent for cold users).
    if (message.rawType && message.rawType !== "text" && message.rawType !== "interactive" && message.rawType !== "button") {
      console.log(`ℹ️ Non-text inbound: type=${message.rawType} from=${userId}`);
    }

    // Serialize work per user so rapid taps queue instead of colliding
    await enqueueForUser(userId, async () => {
      await handleIncomingMessage(message);
    });
  } catch (error) {
    console.error("Error handling message:", error?.message || error);
  }
};

const handleIncomingMessage = async (message) => {
  try {
    const userId = message.from;
    // Safe body read: stickers / voice notes / images may carry no text.
    const rawBody = message.body || "";
    const userInput = rawBody.trim().toLowerCase();
    const state = getUserState(userId);

    // Legacy migration: old CERT_REQUEST stage removed — route to COMPLETED.
    if (state.stage === "CERT_REQUEST") {
      state.stage = STAGES.COMPLETED;
    }

    updateLastActive(userId);

    console.log(`\n[${new Date().toISOString()}] Message from ${userId}: "${rawBody}"`);
    console.log(`   Current stage: ${state.stage}`);
    console.log(`   Current topic: ${state.currentTopic}`);

    // INBOUND MEDIA (minimal): voice notes, images, video, documents, and
    // stickers arrive with no usable text. Acknowledge with one friendly
    // reply instead of "Invalid input" — for cold users too, but WITHOUT
    // touching stage/state, so a cold user's media never starts a session
    // (only "hello temi" does). Full handling later: GET /{media-id} via
    // Graph with the bearer token, then download the bytes.
    const inboundType = message.rawType || "text";
    if (inboundType !== "text" && inboundType !== "interactive" && inboundType !== "button") {
      // Email step: voice notes/images get the same retry message as invalid
      // text and leave the user parked on the email prompt.
      if (state.stage === STAGES.REGISTRATION && state.regField === "email_input") {
        await pacedReply(message, EMAIL_RETRY_MESSAGE);
        return;
      }
      await pacedReply(message, "I can't read voice notes or files yet. Please type your answer.");
      return;
    }

    // STRICT TRIGGER (FIX 1): a cold user (stage NEW = no live session)
    // gets a reply ONLY for the exact phrase "hello temi" — whether or
    // not they are registered. Everything else (greetings, questions,
    // menu/help/commands) is met with total silence. Only the trigger
    // below may wake the bot.
    if (state.stage === STAGES.NEW && !isTriggerPhrase(rawBody)) {
      console.log(`🔇 Ignoring "${rawBody}" from cold user ${userId} — trigger is "hello temi" only.`);
      return;
    }

    // Interactive replies: unknown ids get a friendly retry; known ids that
    // belong to a different stage get an "expired" notice. The guard sits
    // after the cold-user gate, so a cold tap stays silent like typed text.
    if (message.rawType === "interactive") {
      const interactiveId = rawBody.trim();
      if (!KNOWN_INTERACTIVE_IDS.has(interactiveId)) {
        await pacedReply(message, "Sorry, I didn't recognise that option. Please choose one from the list or type your answer.");
        return;
      }
      if (!isInteractiveIdAllowed(interactiveId, state)) {
        await pacedReply(message, "That option has expired, please choose from the latest menu.");
        return;
      }
    }

    // FIX 3 — registered user typing the trigger again → progress card,
    // never a registration restart. Checked before any stage routing.
    if (isTriggerPhrase(rawBody) && isRegistered(userId)) {
      await sendReturningUserMenu(message);
      return;
    }

    // PARKED CARD (spec §4): a user waiting on the welcome-back progress
    // card may only use exact CONTINUE / MENU (trigger handled above).
    // Anything else — including help and other commands — stays silent.
    // handleWelcome enforces the same rule; this guard stops the global
    // menu/help blocks below from replying first.
    if (state.stage === STAGES.WELCOME && state.welcomeStep === "await_resume_choice") {
      if (userInput === "continue" || userInput === "menu") {
        await handleWelcome(message);
        return;
      }
      console.log(`🔇 Ignoring "${rawBody}" from parked user ${userId} — reply CONTINUE, MENU, or "hello temi".`);
      return;
    }

    if (userInput === "menu") {
      // FIX 3 — registered users get the menu, not registration.
      if (state.stage === STAGES.NEW || state.stage === STAGES.WELCOME) {
        if (isRegistered(userId)) {
          state.stage = STAGES.MAIN_MENU;
          const mainMenu = getMainMenu();
          await sendMainMenu(message);
          return;
        }
        // New users have no menu yet — silence except via trigger flow.
        if (!isTriggerPhrase(rawBody)) {
          console.log(`🔇 Ignoring "${rawBody}" from new user — trigger is "hello temi" only.`);
          return;
        }
      } else {
        state.stage = STAGES.MAIN_MENU;
        const mainMenu = getMainMenu();
        await sendMainMenu(message);
        return;
      }
    }
    
    if (userInput === "help") {
      const menuHelp = getMenuHelp();
      await pacedReply(message, menuHelp.helpText);
      return;
    }
    
    if (userInput === "continue" && state.stage !== STAGES.WELCOME && state.stage !== STAGES.NEW && usersDB[userId]?.progress) {
      // FIX 3 — CONTINUE resumes the user's last course, quiz first.
      const qs = usersDB[userId]?.quizState;
      const continueTopicId = usersDB[userId]?.lastTopic || qs?.topicId ||
        Object.keys(usersDB[userId]?.progress || {})[0] || "ai-tools";
      const topic = getTopic(continueTopicId);
      if (qs && qs.inQuiz && topic) {
        const qModule = topic.modules.find((m) => m.id === qs.moduleId);
        if (qModule && qModule.questions && qModule.questions[qs.questionIndex]) {
          state.currentTopic = continueTopicId;
          state.currentModule = qModule;
          state.currentQuizQuestion = qs.questionIndex;
          state.quizAnswers = [];
          state.stage = STAGES.QUIZ;
          const q = qModule.questions[qs.questionIndex];
          await pacedReply(message, `Welcome back, ${getDisplayName(userId)}! 👋\n\n📚 *${qModule.title}* — resuming Quiz at Question ${qs.questionIndex + 1} of ${qModule.questions.length}\n\n`);
          await pacedReply(message, formatQuiz({ q: q.q, options: q.options, total: qModule.questions.length }, qs.questionIndex + 1));
          return;
        }
      }
      const summary = getUserProgressSummary(userId, continueTopicId);
      if (summary && topic) {
        const module = topic.modules[summary.currentModuleIndex];
        if (module) {
          state.currentTopic = continueTopicId;
          state.currentModule = module;
          state.currentSlide = summary.currentSlideIndex;
          state.stage = STAGES.LEARNING;
          state.quizAnswers = [];
          
          await pacedReply(message, `Welcome back, ${getDisplayName(userId)}! 👋\n\n📚 *${module.title}* — Step ${summary.currentSlideIndex + 1}\n\n`);
          if (module.slides && module.slides[state.currentSlide]) {
            await sendSlide(message, state, module.slides[state.currentSlide]);
          } else {
            state.currentSlide = 0;
            await sendSlide(message, state, module.slides[0]);
          }
          return;
        }
      }
    }
    
    if (userInput === "/start" || userInput === "reset") {
      // FIX 1+3 — /start & reset must NOT onboard strangers or
      // re-register existing users. Registered → progress card.
      if (isRegistered(userId)) {
        await sendReturningUserMenu(message);
        return;
      }
      if (!isTriggerPhrase(rawBody)) {
        console.log(`🔇 Ignoring "${rawBody}" from new user — trigger is "hello temi" only.`);
        return;
      }
      if (!optedInUsers.has(userId)) {
        optedInUsers.add(userId);
        saveData();
      }
      state.stage = STAGES.WELCOME;
      await handleNewUser(message);
      return;
    }
    
    switch (state.stage) {
      case STAGES.NEW:
        // UNIVERSAL TRIGGER: ONLY exact "hello temi" (case-insensitive,
        // whitespace-normalized) wakes a cold session — new, returning,
        // partial, or post-restart. Anything else was already silenced by
        // the gate at the top of handleIncomingMessage.
        // - fully registered → exactly one welcome-back progress card.
        // - partial record → resume at the first missing step (one prompt,
        //   existing data preserved, never duplicated or reset).
        // - no record → fresh welcome.
        if (!isTriggerPhrase(rawBody)) {
          console.log(`🔇 Ignoring "${rawBody}" from new user ${userId} — trigger is "hello temi" only.`);
          break;
        }
        if (isRegistered(userId)) {
          await sendReturningUserMenu(message);
          break;
        }
        if (hasPartialRegistration(userId)) {
          await resumePartialRegistration(message);
          break;
        }
        await handleNewUser(message);
        break;
        
      case STAGES.WELCOME:
        await handleWelcome(message);
        break;
        
      case STAGES.REGISTRATION:
        await handleRegistration(message);
        break;
        
      case STAGES.MAIN_MENU:
        await handleMainMenu(message);
        break;
        
      case STAGES.TOPIC_INTRO:
        await handleTopicIntro(message);
        break;
        
      case STAGES.TOOLS_LIST:
        await handleToolsList(message);
        break;
        
      case STAGES.TOOLS_LIST_SELECTION:
        await handleToolsListSelection(message);
        break;
        
      case STAGES.LEARNING:
        await handleLearning(message);
        break;
        
      case STAGES.QUIZ:
        await handleQuiz(message);
        break;
        
      case STAGES.COMPLETED:
        await handleCompleted(message);
        break;

      case STAGES.AWAITING_FEEDBACK:
        await handleFeedback(message);
        break;
        
      default:
        console.log("Unknown stage:", state.stage);
    }
    
  } catch (error) {
    console.error("Error handling message:", error);
    console.error("Stack:", error.stack);
    try {
      await pacedReply(message, "Sorry, I encountered an error. Please try again.");
    } catch (e) {
      console.error("Failed to send error message:", e);
    }
  }
};

let isShuttingDown = false;

process.on("SIGINT", () => {
  isShuttingDown = true;
  console.log("\n👋 Shutting down gracefully...");
  saveData();
  process.exit(0);
});

if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  console.log("📁 Created media directory:", MEDIA_DIR);
  console.log("   Place your images and audio files here!");
}



loadData();

// ---- Webhook transport: verification + inbound ----
// Meta dashboard setup (one-time, you do this in the dashboard):
//   1. Invent any secret string -> META_VERIFY_TOKEN in .env (EC2).
//   2. WhatsApp > Configuration > Webhook > Edit: callback URL
//      https://your-domain:3001/webhook plus that verify token, Verify & Save.
//   3. Subscribe to the `messages` field.
// Inbound interactive button/list replies are mapped back to plain text so
// the state machine below sees exactly what it saw before.
const extractInboundMessages = (body) => {
  const out = [];
  try {
    const entries = (body && body.entry) || [];
    for (const entry of entries) {
      for (const change of entry?.changes || []) {
        const value = change?.value || {};
        for (const m of value?.messages || []) {
          if (m.fromMe) continue;
          // Normalize to digits: Meta wa_id is already digits-only; this only
          // strips a hypothetical "+" / spaces so lookups can't miss.
          const from = String(m.from || "").replace(/\D/g, "");
          if (!from) continue;
          let text = "";
          if (m.type === "text") {
            text = (m.text && m.text.body) || "";
          } else if (m.type === "interactive") {
            const r = m.interactive?.button_reply || m.interactive?.list_reply || {};
            // Prefer the id: it is the stable stage input; the title is display-only.
            text = r.id || r.title || "";
          } else if (m.type === "button") {
            text = m.button?.text || m.button?.payload || "";
          }
          out.push({ from, body: text || "", id: m.id, timestamp: m.timestamp, rawType: m.type });
        }
      }
    }
  } catch (e) {
    console.error("webhook parse failed:", e?.message || e);
  }
  return out;
};

const createWebhookApp = () => {
  const app = express();
  // Meta sends webhooks as application/json — this must come before routes.
  // The verify hook keeps the raw bytes so X-Hub-Signature-256 can be
  // checked against the exact payload Meta signed (parsed JSON would differ).
  app.use(express.json({ limit: "256kb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
  // Log malformed-JSON bodies instead of silently 400-ing (Express default
  // error handler would otherwise return HTML with zero pm2 log output).
  app.use((err, _req, res, next) => {
    if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
      console.error("⚠️ POST /webhook hit: JSON parse failed:", String(err?.message || err).slice(0, 200));
      return res.sendStatus(400);
    }
    return next(err);
  });

  app.get("/health", (_req, res) => res.json({ ok: true, meta: metaConfigured() }));

  // Verification handshake (Meta calls this once when you Save the webhook).
  app.get("/webhook", (req, res) => {
    console.log(`🔔 GET /webhook hit: mode=${req.query["hub.mode"]} challenge=${String(req.query["hub.challenge"] || "").slice(0, 20)}`);
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && META_VERIFY_TOKEN && token === META_VERIFY_TOKEN && challenge) {
      console.log("✅ Webhook verified by Meta.");
      return res.status(200).send(challenge);
    }
    console.warn("⚠️ Webhook verification failed (check META_VERIFY_TOKEN).");
    return res.sendStatus(403);
  });

  // Inbound messages + status receipts (always 200 fast, work continues async).
  app.post("/webhook", (req, res) => {
    // Optional authenticity check — only when META_APP_SECRET is set.
    // Meta signs every POST (including dashboard Test deliveries), so legit
    // traffic still passes. Rejects BEFORE the 200 + async work below.
    if (META_APP_SECRET) {
      let valid = false;
      try {
        const expected = `sha256=${crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody || "").digest("hex")}`;
        const received = req.headers["x-hub-signature-256"];
        valid = typeof received === "string" && received.length === expected.length &&
          crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
      } catch {
        valid = false;
      }
      if (!valid) {
        console.warn("⚠️ POST /webhook: X-Hub-Signature-256 mismatch — rejecting (check META_APP_SECRET).");
        return res.sendStatus(403);
      }
    }
    // FIRST LINE: log every hit before validation/parsing/handling so a
    // misconfigured tunnel or unsubscribed field is visible in pm2 logs
    // instead of looking like "Meta never called us".
    try {
      const keys = req.body ? Object.keys(req.body) : [];
      console.log(`🔔 POST /webhook hit: content-type=${req.headers["content-type"] || "?"} bodyKeys=[${keys.join(",")}] len=${JSON.stringify(req.body || {}).length}`);
    } catch (e) {
      console.log(`🔔 POST /webhook hit (unloggable body): ${e?.message || e}`);
    }
    res.sendStatus(200);
    try {
      const inbound = extractInboundMessages(req.body);
      if (!inbound.length) {
        console.log("ℹ️ POST /webhook: no inbound messages in payload (likely a status receipt: sent/delivered/read — expected, not an error).");
      }
      for (const item of inbound) {
        if (item.id) markAsRead(item.id);
        handleWebhookMessage({ from: item.from, body: item.body, id: item.id, rawType: item.rawType }).catch((e) =>
          console.error("webhook handle failed:", e?.message || e)
        );
      }
    } catch (e) {
      console.error("webhook POST failed:", e?.message || e);
    }
  });

  return app;
};

const startWebhookServer = () => {
  const app = createWebhookApp();
  app.listen(BOT_PORT, () => {
    console.log(`✅ *Témí* Bot is ready (Cloud API transport)!`);
    console.log(`   • Webhook: http://localhost:${BOT_PORT}/webhook`);
    console.log(`   • Health:  http://localhost:${BOT_PORT}/health`);
    console.log("📚 Pre-loaded content:");
    console.log(`   • Topics: ${Object.keys(contentDB.topics).length}`);
    console.log(`   • AI Tools modules: ${contentDB.topics["ai-tools"]?.modules?.length || 0}`);
    console.log(`   • Registered users: ${Object.keys(usersDB).length}`);
    if (!metaConfigured()) {
      console.warn("⚠️ Set META_PHONE_ID + META_ACCESS_TOKEN in .env, then restart.");
    }
    if (!META_VERIFY_TOKEN) {
      console.warn("⚠️ Set META_VERIFY_TOKEN in .env before verifying the webhook in Meta dashboard.");
    }
    if (META_APP_SECRET) {
      console.log("🔐 Webhook signature validation enabled (X-Hub-Signature-256).");
    } else {
      console.log("ℹ️ Webhook signature validation disabled (META_APP_SECRET not set).");
    }
  });
  return app;
};

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

if (require.main === module) {
  startWebhookServer();

  // Admin dashboard (same EC2 process, live JSON). Never crashes the bot.
  try {
    if (process.env.ADMIN_ENABLED !== "0") {
      const { startAdminServer } = require("./admin-server.js");
      startAdminServer();
    } else {
      console.log("📊 Admin dashboard disabled (ADMIN_ENABLED=0).");
    }
  } catch (e) {
    console.error("📊 Admin dashboard failed to start (bot unaffected):", e?.message || e);
  }

  console.log("🚀 Starting *Témí* — Learn AI. Teach Better...");
}

module.exports = {
  createWebhookApp,
  extractInboundMessages,
  handleWebhookMessage,
  handleIncomingMessage,
  getUserState,
  isTriggerPhrase,
  isRegistered,
  isValidEmail,
  normalizeEmail,
  sendListTo,
  sendButtonsTo,
  sendCtaUrlTo,
  sendMenuTo,
  sendMainMenu,
  sendSlide,
  LIMITS,
  STAGES,
};
