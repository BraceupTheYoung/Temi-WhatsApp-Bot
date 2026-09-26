const qrcode = require("qrcode-terminal");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { contentDB, getTopic, getWelcome, getMainMenu, getRegistration, getMenuHelp, getQuickResponse, getCompletion } = require("./content-db.js");
const { generateCertificatePDF } = require("./certificate.js");

const ADMIN_NUMBER = process.env.ADMIN_NUMBER;
const MEDIA_DIR = path.join(__dirname, "media");

// NOTE: version pin REMOVED (2026-09-22) — the pinned 2.3000.1047079153 HTML
// shell still fetches (200) but its JS bundles no longer boot window.Debug,
// so initialize() crashes with "Cannot read properties of undefined (reading
// 'VERSION')". Stability > pinning: let whatsapp-web.js use its default
// (live) version. To re-pin later, uncomment the webVersion/webVersionCache
// lines below AND first verify checkPinnedVersion() reports a healthy page.
// const PINNED_WWEB_VERSION = "2.3000.1047079153-alpha";
const PINNED_WWEB_VERSION = null; // null = use default live version

// Startup diagnostic: fetches the pin URL and logs what it actually returns
// (status, length, first 200 chars). Fire-and-forget — never blocks boot.
const checkPinnedVersion = async (version) => {
  if (!version) {
    console.log("ℹ️ No WA Web version pinned — using whatsapp-web.js default (live) version.");
    return;
  }
  const url = `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${version}.html`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    console.log(`📌 Pin check ${version}: status=${res.status} len=${text.length}`);
    console.log(`📌 Pin check head200: ${JSON.stringify(text.substring(0, 200))}`);
    if (!res.ok || !/whatsapp-web/i.test(text.substring(0, 500))) {
      console.error("📌 Pin check FAILED — pinned HTML looks wrong, NOT using pin.");
    }
  } catch (e) {
    console.error("📌 Pin check fetch failed:", e?.message || e);
  }
};
checkPinnedVersion(PINNED_WWEB_VERSION);

// @lid → @c.us resolution for media sends. Fresh sessions surface inbound
// senders as 1234@lid, and media upload addressed at the @lid fails with the
// wwebjs-step:addsend memoize/id error while text still goes through.
// getContact() resolves the underlying chat ID — always logged so the
// conversion is visible, cached per sender, fallback to message.from.
const lidToChatCache = new Map();
const resolveChatId = async (message) => {
  const from = message.from;
  if (!/@lid$/.test(from || "")) return from;
  if (lidToChatCache.has(from)) {
    const cached = lidToChatCache.get(from);
    console.log(`🔍 ID resolve (cached): message.from=${from} chatId=${cached}`);
    return cached;
  }
  try {
    const contact = await message.getContact();
    const serialized = contact?.id?._serialized;
    console.log(`🔍 ID resolve: message.from=${from} contact.id=${serialized} isWAContact=${contact?.isWAContact}`);
    if (serialized && serialized !== from) {
      lidToChatCache.set(from, serialized);
      return serialized;
    }
  } catch (e) {
    console.log(`🔍 ID resolve failed for ${from}, falling back to message.from:`, e?.message || e);
  }
  return from;
};

// Central media sender. Cascade:
//  1. 2s settle delay (fresh WA Web pages race media upload)
//  2. chat.sendMessage primary (store's own chat record)
//  3. client.sendMessage(resolved @c.us) fallback
// NOTE: MessageMedia has NO id field ({mimetype,data,filename,filesize} only
// per MessageMedia.js) — the memoize/id throw comes from WA's own page-side
// getters, so stamping media.id would be a no-op and is NOT done here.
const sendMedia = async (message, media, options = {}) => {
  console.log(`📤 Media send: file=${media?.filename} type=${media?.mimetype} b64len=${media?.data?.length || 0} caption=${(options.caption || "").length} chars`);
  await new Promise((r) => setTimeout(r, 2000));
  const chatId = await resolveChatId(message);
  try {
    const chat = await message.getChat();
    console.log(`📤 Media via chat.sendMessage (chat=${chat?.id?._serialized || chatId})`);
    return await chat.sendMessage(media, options);
  } catch (e1) {
    console.log(`📤 chat.sendMessage failed (${String(e1?.message || e1).split("\n")[0]}), fallback client.sendMessage(${chatId})`);
    return await client.sendMessage(chatId, media, options);
  }
};

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: "session2",
  }),
  takeoverOnConflict: true,
  restartOnAuthFail: true,
  qrMaxRetries: 0,
  authTimeoutMs: 0,
  // ...(PINNED_WWEB_VERSION
  //   ? {
  //       webVersion: PINNED_WWEB_VERSION,
  //       webVersionCache: {
  //         type: "remote",
  //         remotePath:
  //           "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html",
  //         strict: false, // false = fall back to live version instead of crashing
  //       },
  //     }
  //   : {}),
  puppeteer: {
    headless: true,
    timeout: 120000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-blink-features=AutomationControlled",
    ],
  },
});

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
  COMPLETED: "completed"
};

const REG_FIELDS = ["fullName", "terms", "email_input", "province", "community", "gender", "age", "language", "jobRole"];

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

const getUserProgressSummary = (userId) => {
  const user = usersDB[userId];
  if (!user || !user.progress || !user.progress["ai-tools"]) {
    return null;
  }
  
  const progress = user.progress["ai-tools"];
  const modules = progress.modules;
  
  const topic = getTopic("ai-tools");
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

const handleNewUser = async (message) => {
  const userId = message.from;
  const state = getUserState(userId);
  state.stage = STAGES.WELCOME;
  
  const welcome = getWelcome();
  let welcomeText = welcome.text;
  
  // Original behavior: image with caption attached (as before).
  // NOTE: media goes via client.sendMessage (no quoted msg) — message.reply
  // with media serializes the quoted message and trips the
  // wwebjs-step:addsend memoize/id error on mismatched WA Web versions.
  if (welcome.media) {
    try {
      const mediaPath = path.join(MEDIA_DIR, welcome.media.filename);
      if (fs.existsSync(mediaPath)) {
        let media = MessageMedia.fromFilePath(mediaPath);
        if (!media?.data) {
          const b64 = fs.readFileSync(mediaPath).toString("base64");
          media = new MessageMedia("image/jpeg", b64, welcome.media.filename);
        }
        await sendMedia(message, media, { caption: welcomeText });
        return;
      } else {
        console.log(`Welcome media missing at ${mediaPath}, sending text only`);
      }
    } catch (e) {
      console.log("Welcome media send failed, sending text only:", e?.message || e);
      console.log("STACK:", e?.stack?.split("\n").slice(0, 6).join("\n"));
    }
  }
  
  await message.reply(welcomeText);
};

const shouldShowWelcomeBack = (userId) => {
  const user = usersDB[userId];
  if (!user || !user.lastActive) return false;
  
  const daysSinceActive = (Date.now() - user.lastActive) / (1000 * 60 * 60 * 24);
  return daysSinceActive >= SHOULD_WELCOME_BACK_DAYS && user.progress && user.progress["ai-tools"];
};

const handleWelcome = async (message) => {
  const userId = message.from;
  const msg = message.body.toLowerCase();
  const state = getUserState(userId);
  
  if (shouldShowWelcomeBack(userId)) {
    const summary = getUserProgressSummary(userId);
    if (summary && summary.currentModuleName) {
      const { currentModuleName, currentSlideIndex, completedModules, totalModules } = summary;
      const totalSlides = summary.totalSlides || 8;
      
      let welcomeBackMsg = `👋 *Welcome back, Teacher!*\n\n`;
      welcomeBackMsg += `You were on *${currentModuleName}*, Step ${currentSlideIndex + 1} of ${totalSlides}\n`;
      welcomeBackMsg += `Progress: ${completedModules}/${totalModules} modules completed\n\n`;
      welcomeBackMsg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      welcomeBackMsg += `Reply *CONTINUE* to pick up where you left off.\n`;
      welcomeBackMsg += `Reply *START* to begin fresh.\n`;
      welcomeBackMsg += `Reply *MENU* to go to main menu.`;
      
      state.stage = STAGES.WELCOME;
      await message.reply(welcomeBackMsg);
      return;
    }
  }
  
  if (msg.includes("continue") || msg.includes("welcome back") || msg.includes("pick up")) {
    state.stage = STAGES.REGISTRATION;
    state.regField = "fullName";
    
    const reg = getRegistration();
    await message.reply(reg.fullName.prompt);
    return;
  }
  
  if (msg.includes("hello temi") || msg.includes("hello") || msg.includes("start") || msg === "hi" || msg === "hello" || msg === "1" || msg.includes("lets go") || msg.includes("begin") || msg === "continue") {
    const summary = getUserProgressSummary(userId);
    if (summary && summary.currentModuleIndex < summary.moduleNames.length) {
      state.stage = STAGES.TOPIC_INTRO;
      state.currentTopic = "ai-tools";
      
      const topic = getTopic("ai-tools");
      const module = topic.modules[summary.currentModuleIndex];
      state.currentModule = module;
      state.currentSlide = summary.currentSlideIndex;

      const slideText = module.slides[summary.currentSlideIndex]?.text;
      const preview = (Array.isArray(slideText) ? slideText[0] : slideText)?.substring(0, 100) || "Continuing...";
      await message.reply(`📚 *${module.title}*\n\nStep ${summary.currentSlideIndex + 1}: ${preview}\n\nReply *NEXT* to continue or *MENU* to go back.`);
      state.stage = STAGES.LEARNING;
      return;
    }
  }
  
  if (msg === "menu" || msg === "help") {
    const menuHelp = getMenuHelp();
    await message.reply(menuHelp.helpText);
    return;
  }
  
  state.stage = STAGES.REGISTRATION;
  state.regField = "fullName";
  
  const reg = getRegistration();
  await message.reply(reg.fullName.prompt);
};

const handleRegistration = async (message) => {
  const userId = message.from;
  const msg = message.body.trim();
  const state = getUserState(userId);
  const reg = getRegistration();
  
  if (!usersDB[userId]) {
    usersDB[userId] = { createdAt: Date.now(), progress: {} };
  }
  
  switch (state.regField) {
    case "fullName":
      usersDB[userId].fullName = msg;
      state.regField = "terms";
      await message.reply(formatOptions(reg.terms));
      break;
      
    case "terms":
      if (msg.toLowerCase() === "yes" || msg === "1") {
        usersDB[userId].agreedToTerms = true;
        state.regField = "email_input";
        await message.reply(reg.email.prompt);
      } else {
        await message.reply("You need to agree to the Terms and Conditions to continue.\n\nPlease reply *1* to agree and continue.");
      }
      break;
      
    case "email_input":
      usersDB[userId].email = msg;
      state.regField = "province";
      await message.reply(formatOptions(reg.province));
      break;
      
    case "province":
      if (msg.trim().length > 0) {
        usersDB[userId].province = msg.trim();
        state.regField = "community";
        await message.reply(formatOptions(reg.community));
      } else {
        await message.reply("Please enter your state.");
      }
      break;
      
    case "community":
      const communityIdx = parseInt(msg) - 1;
      if (communityIdx >= 0 && communityIdx < reg.community.buttons.length) {
        usersDB[userId].community = reg.community.buttons[communityIdx];
        state.regField = "gender";
        await message.reply(formatOptions(reg.gender));
      } else {
        await message.reply("Please enter a valid number from the list.");
      }
      break;
      
    case "gender":
      const genderIdx = parseInt(msg) - 1;
      if (genderIdx >= 0 && genderIdx < reg.gender.buttons.length) {
        usersDB[userId].gender = reg.gender.buttons[genderIdx];
        state.regField = "age";
        await message.reply(formatOptions(reg.age));
      } else {
        await message.reply("Please enter a valid number from the list.");
      }
      break;
      
    case "age":
      const ageIdx = parseInt(msg) - 1;
      if (ageIdx >= 0 && ageIdx < reg.age.options.length) {
        usersDB[userId].age = reg.age.options[ageIdx];
        state.regField = "language";
        await message.reply(formatOptions(reg.language));
      } else {
        await message.reply("Please enter a valid number from the list.");
      }
      break;
      
    case "language":
      const langIdx = parseInt(msg) - 1;
      if (langIdx >= 0 && langIdx < reg.language.options.length) {
        usersDB[userId].language = reg.language.options[langIdx];
        usersDB[userId].jobRole = "Teacher";
        state.stage = STAGES.MAIN_MENU;
        optedInUsers.add(userId);
        saveData();
        
        const menuHelp = getMenuHelp();
        await message.reply(menuHelp.greeting);
        
        const mainMenu = getMainMenu();
        await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
      } else {
        await message.reply("Please enter a valid number from the list.");
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

const handleMainMenu = async (message) => {
  const userId = message.from;
  const msg = message.body.toLowerCase();
  const state = getUserState(userId);
  const mainMenu = getMainMenu();
  
  if (msg === "menu") {
    await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
    return;
  }
  
  if (msg === "help") {
    const menuHelp = getMenuHelp();
    await message.reply(menuHelp.helpText);
    return;
  }
  
  // Handle quick responses (TOOLS LIST, PROMPT TEMPLATES, etc.)
  const quickResponse = getQuickResponse(msg);
  if (quickResponse) {
    await message.reply(quickResponse);
    await message.reply("\n" + formatMenu(mainMenu, usersDB[userId]?.name));
    return;
  }
  
  // Option 2 - My Progress / Continue Learning
  if (msg === "2" || msg.includes("continue") || msg.includes("progress") || msg.includes("my progress")) {
    const summary = getUserProgressSummary(userId);
    const mainMenu = getMainMenu();
    
    if (summary && summary.completedModules > 0) {
      const { currentModuleIndex, currentSlideIndex, moduleNames, completedModules, totalModules, currentModuleName } = summary;
      const totalSlides = summary.totalSlides || 8;
      
      let progressMsg = `📚 *YOUR PROGRESS*\n\n`;
      progressMsg += `You're on *${currentModuleName}*, Step ${currentSlideIndex + 1} of ${totalSlides}\n`;
      progressMsg += `Modules completed: ${completedModules}/${totalModules}\n\n`;
      progressMsg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      progressMsg += `1. Continue from where you left off\n`;
      progressMsg += `2. Start over (restart current module)\n`;
      progressMsg += `3. Main Menu`;
      
      await message.reply(progressMsg);
      state.stage = STAGES.TOOLS_LIST_SELECTION;
      return;
    } else {
      await message.reply(`📚 *MY PROGRESS*\n\nYou haven't started yet.\n\nReply *1* to begin learning!\nReply *MENU* to go back to main menu.`);
      state.stage = STAGES.TOPIC_INTRO;
      return;
    }
  }
  
  // Option 2 alt - Tools List (for admins/supervisors)
  if (msg.includes("tools list") || msg.includes("skip") || msg === "admin tools") {
    const topic = getTopic("ai-tools");
    const modulesList = topic.modules.map((m, idx) => `${idx + 1}. ${m.title}`).join("\n");
    await message.reply(`Which module would you like to access?\n\n${modulesList}\n\nReply with a number (1-3) to select a module.\nReply *MENU* to go back to main menu.`);
    state.stage = STAGES.TOOLS_LIST;
    return;
  }
  
  const choice = parseInt(msg);
  if (!isNaN(choice) && choice >= 1 && choice <= mainMenu.options.length) {
    const topicId = mainMenu.options[choice - 1].id;
    state.currentTopic = topicId;
    state.stage = STAGES.TOPIC_INTRO;
    
    console.log("Selected topic:", topicId);
    
    const topic = getTopic(topicId);
    if (!topic) {
      await message.reply("Error: Topic not found. Please try again.");
      state.stage = STAGES.MAIN_MENU;
      await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
      return;
    }
    
    let introText = topic.intro || "Welcome to this topic!";
    introText = introText.replace("{name}", usersDB[userId].name || "Learner");
    
    const introMediaPath = path.join(MEDIA_DIR, "tools list  intro.jpeg");
    if (fs.existsSync(introMediaPath)) {
      const introMedia = MessageMedia.fromFilePath(introMediaPath);
      await sendMedia(message, introMedia, { caption: introText + "\n\nReply with *1* to start or *2* to go back." });
    } else {
      await message.reply(introText + "\n\nReply with *1* to start or *2* to go back.");
    }
  } else {
    await message.reply("Please select a valid option (1-" + mainMenu.options.length + ").\n\n" + formatMenu(mainMenu, usersDB[userId]?.name));
  }
};

const handleToolsList = async (message) => {
  const userId = message.from;
  const msg = message.body.toLowerCase().trim();
  const state = getUserState(userId);
  const mainMenu = getMainMenu();
  const topic = getTopic("ai-tools");
  
  if (msg === "menu") {
    state.stage = STAGES.MAIN_MENU;
    await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
    return;
  }
  
  const choice = parseInt(msg);
  if (!isNaN(choice) && choice >= 1 && choice <= topic.modules.length) {
    const module = topic.modules[choice - 1];
    state.currentTopic = "ai-tools";
    state.currentModule = module;
    
    await message.reply(`You selected: ${module.title}\n\nReply *1* to go to Step 1\nReply *2* to go to Quiz\nReply *MENU* to go back to main menu`);
    state.stage = STAGES.TOOLS_LIST_SELECTION;
    return;
  }
  
  await message.reply(`Please reply with a number (1-${topic.modules.length}) to select a module.\nReply *MENU* to go back to main menu.`);
};

const handleToolsListSelection = async (message) => {
  const userId = message.from;
  const msg = message.body.toLowerCase().trim();
  const state = getUserState(userId);
  const mainMenu = getMainMenu();
  const topic = getTopic("ai-tools");
  
  if (msg === "menu" || msg === "3") {
    state.stage = STAGES.MAIN_MENU;
    await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
    return;
  }
  
  // Option 1: Continue from where left off
  if (msg === "1" || msg.includes("continue")) {
    const summary = getUserProgressSummary(userId);
    if (summary && summary.currentModuleIndex < topic.modules.length) {
      const module = topic.modules[summary.currentModuleIndex];
      state.currentTopic = "ai-tools";
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
      await message.reply("Starting fresh...");
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
      await message.reply(`🔄 Restarting ${state.currentModule.title}...\n\nReply *NEXT* to continue through the slides.`);
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
    const firstQ = state.currentModule.questions[0];
    await message.reply(formatQuiz({
      q: firstQ.q,
      options: firstQ.options,
      total: state.currentModule.questions.length
    }, 1));
    return;
  }
  
  await message.reply(`Please reply with a valid option.\nReply *MENU* to go back to main menu.`);
};

const handleTopicIntro = async (message) => {
  const userId = message.from;
  const userInput = message.body.toLowerCase().trim();
  const state = getUserState(userId);
  
  console.log("handleTopicIntro - currentTopic:", state.currentTopic);
  console.log("handleTopicIntro - userInput:", userInput);
  
  const topic = getTopic(state.currentTopic);
  
  if (!topic) {
    console.log("ERROR: Topic is null for", state.currentTopic);
    state.stage = STAGES.MAIN_MENU;
    const mainMenu = getMainMenu();
    await message.reply("Something went wrong. Returning to menu.\n\n" + formatMenu(mainMenu, usersDB[userId]?.name));
    return;
  }
  
  console.log("Topic found:", topic.title, "Modules:", topic.modules?.length);
  
  if (userInput === "menu" || userInput === "back to main menu" || userInput === "2") {
    state.stage = STAGES.MAIN_MENU;
    const mainMenu = getMainMenu();
    await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
    return;
  }
  
  // Handle quick responses (only for specific keywords, not numbers)
  if (!isNaN(parseInt(userInput))) {
    // It's a number, skip quick response check
  } else {
    const quickResponse = getQuickResponse(userInput);
    if (quickResponse) {
      await message.reply(quickResponse);
      await message.reply("\nReply with *1* to start or *2* to go back.");
      return;
    }
  }
  
  if (userInput === "1" || userInput.includes("let's go") || userInput.includes("start") || userInput.includes("go")) {
    if (!topic.modules || topic.modules.length === 0) {
      await message.reply("No content available for this topic yet. Returning to menu.");
      state.stage = STAGES.MAIN_MENU;
      const mainMenu = getMainMenu();
      await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
      return;
    }
    
    const firstModule = topic.modules[0];
    console.log("First module:", firstModule.id, "Slides:", firstModule.slides?.length);
    
    if (!firstModule.slides || firstModule.slides.length === 0) {
      await message.reply("No slides found for this module. Returning to menu.");
      state.stage = STAGES.MAIN_MENU;
      const mainMenu = getMainMenu();
      await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
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
    await message.reply("Please reply with *1* to start or *2* to go back.");
  }
};

const sendSlide = async (message, state, slide) => {
  const userId = message.from;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Returns false if the WhatsApp page died mid-send (needs re-init).
  // Media goes via client.sendMessage (no quote) to avoid the
  // wwebjs-step:addsend memoize/id error; text stays on message.reply.
  const safeReply = async (content, options) => {
    try {
      const isMedia = content && content.mimetype && content.data;
      if (isMedia) {
        await sendMedia(message, content, options || {});
      } else {
        await message.reply(content, undefined, options);
      }
      await sleep(600); // pace sends — hammering WA Web back-to-back kills the page
      return true;
    } catch (e) {
      const msg = String(e?.message || e || "");
      console.error("Reply failed:", msg.split("\n")[0]);
      if (
        msg.includes("Execution context was destroyed") ||
        msg.includes("Protocol error") ||
        msg.includes("Target closed") ||
        msg.includes("Session closed")
      ) {
        console.error("⚠️ WhatsApp page died mid-send. It usually auto-reloads — next message will retry. If it stays dead, restart the bot.");
        isReady = false;
        try {
          await destroyClient();
          startClient();
        } catch (err) {
          console.error("Re-init after dead page failed:", err?.message || err);
        }
      }
      return false;
    }
  };

  const textChunks = Array.isArray(slide.text) ? slide.text : [slide.text];

  for (const chunk of textChunks) {
    let text = chunk.replace("{name}", usersDB[userId].name || "Learner");
    const ok = await safeReply(text);
    if (!ok) return; // page dead — stop, don't pile on more sends
  }

  if (slide.audio) {
    try {
      const audioPath = path.join(MEDIA_DIR, slide.audio);
      if (fs.existsSync(audioPath)) {
        const media = await MessageMedia.fromFilePath(audioPath);
        await safeReply(media);
      }
    } catch (e) {
      console.error("Error sending audio:", String(e?.message || e).split("\n")[0]);
    }
  } else if (slide.media) {
    try {
      const mediaPath = path.join(MEDIA_DIR, slide.media.filename);
      if (fs.existsSync(mediaPath)) {
        const media = await MessageMedia.fromFilePath(mediaPath);
        await safeReply(media, { caption: textChunks[textChunks.length - 1] });
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
  const userInput = message.body.toLowerCase().trim();
  const state = getUserState(userId);
  const topic = getTopic(state.currentTopic);
  const module = state.currentModule;
  
  if (userInput === "menu" || userInput === "back to main menu") {
    state.stage = STAGES.MAIN_MENU;
    const mainMenu = getMainMenu();
    await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
    return;
  }
  
  const quickResponse = getQuickResponse(userInput);
  if (quickResponse) {
    await message.reply(quickResponse);
    await message.reply("\nWhat would you like to do next?\n\nReply *NEXT* to continue or *MENU* to go back to the menu.");
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
    const firstQ = module.questions[0];
    await message.reply(formatQuiz({
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
    await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
  }
};

const handleQuiz = async (message) => {
  const userId = message.from;
  const userInput = message.body.trim();
  const state = getUserState(userId);
  const module = state.currentModule;
  
  if (userInput.toLowerCase() === "menu") {
    state.stage = STAGES.MAIN_MENU;
    const mainMenu = getMainMenu();
    await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
    return;
  }
  
  const answer = parseInt(userInput);
  const maxAnswer = module.questions[state.currentQuizQuestion]?.options?.length || 4;
  
  if (isNaN(answer) || answer < 1 || answer > maxAnswer) {
    await message.reply(`Please enter a valid number (1-${maxAnswer}).`);
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
  
  await message.reply(responseText);
  
  state.currentQuizQuestion++;
  
  if (state.currentQuizQuestion < module.questions.length) {
    await message.reply("\n━━━━━━━━━━━━━━━━━━━━");
    const nextQ = module.questions[state.currentQuizQuestion];
    await message.reply(formatQuiz({
      q: nextQ.q,
      options: nextQ.options,
      total: module.questions.length
    }, state.currentQuizQuestion + 1));
  } else {
    const correct = correctSoFar;
    const total = totalQuestions;
    const percentage = Math.round((correct / total) * 100);
    
    let finalMessage = `━━━━━━━━━━━━━━━━━━━━\n`;
    finalMessage += `*QUIZ COMPLETE!*\n\n`;
    finalMessage += `Final Score: ${correct}/${total} (${percentage}%)\n\n`;
    
    if (percentage === 100) {
      finalMessage += `🎉 PERFECT SCORE! *Témí* says you're a star, Teacher! Amazing work! 🌟`;
    } else if (percentage >= 80) {
      finalMessage += `Excellent work, Teacher! *Témí* says you've really mastered this material! 🎉`;
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
        let completionMedia = MessageMedia.fromFilePath(mediaPath);
        if (!completionMedia?.data) {
          const b64 = fs.readFileSync(mediaPath).toString("base64");
          completionMedia = new MessageMedia("image/jpeg", b64, completionFile);
        }
        await sendMedia(message, completionMedia, { caption: finalMessage });
      } else {
        console.log(`Completion media missing at ${mediaPath}, sending text only`);
        await message.reply(finalMessage);
      }
    } catch (e) {
      console.log("Completion media send failed, sending text only:", e?.message || e);
      try {
        await message.reply(finalMessage);
      } catch {}
    }

    state.stage = STAGES.COMPLETED;
  }
};

const handleCompleted = async (message) => {
  const userId = message.from;
  const userInput = message.body.toLowerCase().trim();
  const state = getUserState(userId);
  const mainMenu = getMainMenu();
  const completion = getCompletion();

  const sendCertificateNow = async (certName) => {
    try {
      await message.reply(`⏳ Generating your certificate for *${certName}*...`);
      const { filePath, certId } = await generateCertificatePDF(certName);
      const media = MessageMedia.fromFilePath(filePath);
      await sendMedia(message, media, {
        caption: `🎓 *YOUR CERTIFICATE IS READY!*\n\nCongratulations *${certName}!* 🎉\n\nYou completed the *AI Tools for Teachers* course.\nCertificate ID: ${certId}\n\n*Témí* says: Learn AI. Teach Better. 💛`
      });
      if (!usersDB[userId].certificateRequests) {
        usersDB[userId].certificateRequests = [];
      }
      usersDB[userId].certificateRequests.push({
        name: certName,
        email: usersDB[userId].email || "",
        certId,
        file: filePath,
        date: new Date().toISOString()
      });
      saveData();
      state.awaitingCertConfirm = false;
      state.stage = STAGES.COMPLETED;
      await message.reply(`Reply *MENU* for main menu 🏠\nReply *SHARE* to share with colleagues 📲`);
    } catch (e) {
      console.error("Certificate generation failed:", e);
      state.awaitingCertConfirm = false;
      state.stage = STAGES.COMPLETED;
      await message.reply(`✅ *Certificate Request Saved!*\n\nName: ${certName}\n\nSorry, auto-generation failed — we will send it manually soon! 📧`);
    }
  };

  // SINGLE certificate flow: user typed DONE after Module 3 and is now
  // confirming the name. Confirm with YES or reply with correct FULL NAME.
  // No email is ever asked — cert auto-generates and delivers in chat.
  if (state.awaitingCertConfirm) {
    const input = message.body.trim();

    if (/^(menu|2|back)$/i.test(input) || input.toLowerCase().includes("back")) {
      state.awaitingCertConfirm = false;
      state.stage = STAGES.MAIN_MENU;
      await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
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
      await message.reply(`Please reply with your FULL NAME as you want it on the certificate.\n\nExample: *John Smith*`);
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
      await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
      return;
    }
    
    const currentModuleIndex = currentTopic.modules.findIndex(m => m.id === state.currentModule?.id);
    const nextModule = currentTopic.modules[currentModuleIndex + 1];
    
    if (nextModule) {
      state.currentModule = nextModule;
      state.currentSlide = 0;
      state.stage = STAGES.LEARNING;
      state.quizAnswers = [];
      
      await sendSlide(message, state, nextModule.slides[0]);
    } else {
      // Full course already completed (incl. after certificate delivery) —
      // single message, no old manual cert flow.
      await message.reply(`You have completed the full course! Reply *MENU* for main menu or *SHARE* to share with colleagues`);
    }
    return;
  }
  
  // Handle "done" / "certificate" — explicit DONE only, and only after
  // ALL modules are complete. Never auto-generates. Asks for name
  // confirmation first; cert generates on YES / name reply (see above).
  if (userInput === "done" || userInput === "certificate" || userInput === "cert") {
    const topicId = state.currentTopic || "ai-tools";
    const topic = getTopic(topicId);
    const topicModules = topic?.modules || [];
    const progModules = usersDB[userId]?.progress[topicId]?.modules || {};
    const allModulesDone = topicModules.length > 0 && topicModules.every((m) => progModules[m.id]?.completed);

    if (!allModulesDone) {
      const doneCount = topicModules.filter((m) => progModules[m.id]?.completed).length;
      const totalCount = topicModules.length || 3;
      await message.reply(`📚 *Not quite yet!*\n\nYou've completed ${doneCount}/${totalCount} modules.\n\nFinish all ${totalCount} modules first, then reply *DONE* to get your certificate.\n\nReply *NEXT TOOL* to continue ➡️\nReply *MENU* for main menu 🏠`);
      return;
    }

    const moduleId = state.currentModule?.id;
    const quizScore = usersDB[userId]?.progress[topicId]?.modules[moduleId]?.quizScore || 0;
    
    if (quizScore < 4) {
      await message.reply(`📝 *Quiz Retake Required*\n\nYour quiz score was ${quizScore}/5. You need a score of *4 or higher* to get your certificate.\n\n━━━━━━━━━━━━━━━━━━━━\n\nReply *RETAKE* to try the quiz again.\nReply *MENU* to go back to the main menu.`);
      return;
    }
    
    // Reuse name from registration — no email asked, cert auto-delivers in chat
    const savedName = usersDB[userId]?.fullName || "";
    state.awaitingCertConfirm = true;
    state.stage = STAGES.COMPLETED;
    if (savedName) {
      await message.reply(`📝 *Almost done!*\n\nWe have your name as: *${savedName}*\n\nReply *YES* to print your certificate with this name,\nor reply with your correct FULL NAME (e.g. *John Smith*).`);
    } else {
      await message.reply(`📝 *Certificate Request*\n\nPlease reply with your FULL NAME as you want it on the certificate.\n\nExample: *John Smith*`);
    }
    return;
  }
  
  // Handle retake quiz
  if (userInput === "retake" || userInput === "retry") {
    if (state.currentModule) {
      state.currentQuizQuestion = 0;
      state.quizAnswers = [];
      state.stage = STAGES.QUIZ;
      const firstQ = state.currentModule.questions[0];
      await message.reply(`📝 *Retaking Quiz for ${state.currentModule.title}*\n\n`);
      await message.reply(formatQuiz({
        q: firstQ.q,
        options: firstQ.options,
        total: state.currentModule.questions.length
      }, 1));
      return;
    }
  }
  
  // Handle "share" - get shareable message
  if (userInput === "share") {
    await message.reply(completion.share);
    return;
  }
  
  // Handle menu / back
  if (userInput === "menu" || userInput === "2" || userInput.includes("back")) {
    state.stage = STAGES.MAIN_MENU;
    await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
    return;
  }
  
  // Default - show available options
  await message.reply("Reply *NEXT TOOL* to continue to the next tool ➡️\nReply *DONE* to see your certificate 🎓\nReply *SHARE* to share with colleagues 📲\nReply *MENU* to go back to the main menu 🏠");
};

client.on("qr", (qr) => {
  console.log("\n📱 Scan this QR code with your WhatsApp phone:");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log("🔐 Authenticated! Waiting for WhatsApp Web to load (ready)...");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Authentication failed:", msg);
});

client.on("message_create", async (message) => {
  // Diagnostic disabled: was tripling logs. Re-enable only when debugging.
  return;
  // try {
  //   console.log(`[diag message_create] from=${message.from} fromMe=${message.fromMe} isGroup=${message.isGroup} body="${(message.body || "").slice(0, 80)}"`);
  // } catch {}
});

client.on("ready", async () => {
  if (isReady) return;
  isReady = true;
  try {
    loadingHistory = [];
    healthFailStreak = 0;
    attachPageGuards();
  } catch {}
  console.log("✅ *Témí* Bot is ready!");
  try {
    console.log(`   • WA Web version: ${await client.getWWebVersion()}`);
    const info = client.info;
    console.log(`   • Logged in as: ${info?.pushname || "?"} (${info?.wid?.user || "?"})`);
  } catch {}
  console.log("📚 Pre-loaded content:");
  console.log(`   • Topics: ${Object.keys(contentDB.topics).length}`);
  console.log(`   • AI Tools modules: ${contentDB.topics["ai-tools"]?.modules?.length || 0}`);
  console.log(`   • Registered users: ${Object.keys(usersDB).length}`);
  console.log("💬 Now text the bot number from another phone. Watch for 'Message from' logs here.");
});

// Guards against the exact failure in your log: one user tap arriving as
// 3–4 duplicate events (multi-instance / WA re-emit) all running sendSlide
// concurrently and killing the page.
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

client.on("message", async (message) => {
  try {
    if (message.from === "status@broadcast" || message.fromMe) return;
    if (message.isGroup) return;

    // Dedupe identical deliveries of the same WhatsApp message
    const msgId = message.id?._serialized || message.id?.id;
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

    // Serialize work per user so rapid taps queue instead of colliding
    try { lastInboundAt = Date.now(); } catch {}
    await enqueueForUser(userId, async () => {
      await handleIncomingMessage(message);
    });
  } catch (error) {
    console.error("Error handling message:", error?.message || error);
  }
});

const handleIncomingMessage = async (message) => {
  try {
    const userId = message.from;
    const userInput = message.body.trim().toLowerCase();
    const state = getUserState(userId);

    // Legacy migration: old CERT_REQUEST stage removed — route to COMPLETED.
    if (state.stage === "CERT_REQUEST") {
      state.stage = STAGES.COMPLETED;
    }

    updateLastActive(userId);
    
    console.log(`\n[${new Date().toISOString()}] Message from ${userId}: "${message.body}"`);
    console.log(`   Current stage: ${state.stage}`);
    console.log(`   Current topic: ${state.currentTopic}`);
    
    if (userInput === "menu") {
      state.stage = STAGES.MAIN_MENU;
      const mainMenu = getMainMenu();
      await message.reply(formatMenu(mainMenu, usersDB[userId]?.name));
      return;
    }
    
    if (userInput === "help") {
      const menuHelp = getMenuHelp();
      await message.reply(menuHelp.helpText);
      return;
    }
    
    if (userInput === "continue" && state.stage !== STAGES.WELCOME && state.stage !== STAGES.NEW && usersDB[userId]?.progress) {
      const summary = getUserProgressSummary(userId);
      const topic = getTopic("ai-tools");
      if (summary && topic) {
        const module = topic.modules[summary.currentModuleIndex];
        if (module) {
          state.currentTopic = "ai-tools";
          state.currentModule = module;
          state.currentSlide = summary.currentSlideIndex;
          state.stage = STAGES.LEARNING;
          state.quizAnswers = [];
          
          await message.reply(`📚 *${module.title}* — Step ${summary.currentSlideIndex + 1}\n\n`);
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
        // A brand-new sender should get onboarded on ANY first message,
        // not just the exact phrase "hello temi". The old code silently
        // dropped everything else, which looked like "normal text, no reply".
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
        
      default:
        console.log("Unknown stage:", state.stage);
    }
    
  } catch (error) {
    console.error("Error handling message:", error);
    console.error("Stack:", error.stack);
    try {
      await message.reply("Sorry, I encountered an error. Please try again.");
    } catch (e) {
      console.error("Failed to send error message:", e);
    }
  }
};

let isShuttingDown = false;

client.on("disconnected", (reason) => {
  console.log("⚠️ Client disconnected:", reason);
  if (isShuttingDown || isReinitializing) return;
  reinitialize(`client disconnected (${reason})`);
});

process.on("SIGINT", () => {
  isShuttingDown = true;
  console.log("\n👋 Shutting down gracefully...");
  saveData();
  client.destroy();
  process.exit(0);
});

if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  console.log("📁 Created media directory:", MEDIA_DIR);
  console.log("   Place your images and audio files here!");
}



loadData();

let initRetries = 0;
const MAX_INIT_RETRIES = 5;
let isReady = false;
let isInitializing = false;

// Destroy any leaked browser before re-initializing. Without this, a
// failed initialize() keeps the userDataDir lock and every retry dies with
// "The browser is already running for ... session2\session".
const destroyClient = async () => {
  try {
    await client.destroy();
  } catch {}
  isInitializing = false;
  // Give Chrome time to release the profile lock
  await new Promise((r) => setTimeout(r, 2000));
};

const startClient = () => {
  if (isReady || isInitializing) {
    console.log("ℹ️ Already ready/initializing, skipping duplicate initialize.");
    return;
  }
  isInitializing = true;
  client.initialize().then(() => {
    isInitializing = false;
  }).catch(async (err) => {
    isInitializing = false;
    if (isReady) return; // late failure after success — ignore
    console.error("❌ Client.initialize() failed:", err?.message || err);
    await destroyClient();
    initRetries++;
    if (initRetries <= MAX_INIT_RETRIES) {
      const delay = 5000 * initRetries;
      console.log(`🔄 Retrying initialize (${initRetries}/${MAX_INIT_RETRIES}) in ${delay / 1000}s...`);
      setTimeout(startClient, delay);
    } else {
      console.error("💥 Max retries reached. Fixes to try:");
      console.error("   1. taskkill /F /IM chrome.exe  (kill zombie Chrome holding the lock)");
      console.error("   2. Delete session2/session/Default/Singleton* lock files");
      console.error("   3. If QR/auth is corrupt: back up then delete session2/ and re-scan");
      console.error("   4. Use Node 20/22 LTS (you are on Node 25, which puppeteer 24 does not officially support)");
      process.exit(1);
    }
  });
};

client.on("loading_screen", (percent, message) => {
  console.log(`⏳ Loading WhatsApp Web: ${percent}% - ${message}`);
  try { recordLoading(percent); } catch {}
});

client.on("change_state", (state) => {
  console.log("🔄 Connection state:", state);
  lastStateChangeAt = Date.now();
});

// ---- Session watchdog + Puppeteer page-crash guards ----
// Covers the 95%→99%→95% loading loop and mid-session silent death:
// - loading stall / loop while !isReady  → reinit (5 min budget)
// - dead page while ready (getState probe fails) → reinit (no manual restart)
// - pupPage close/error, browser disconnect, navigate-away → reinit
const WATCHDOG_INTERVAL_MS = 60 * 1000;
const STALL_BUDGET_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20 * 1000;
let lastInboundAt = 0;
let lastLoadingAt = 0;
let lastStateChangeAt = 0;
let loadingHistory = []; // { t, percent }
let healthFailStreak = 0;
let isReinitializing = false;
let pageGuardsAttachedTo = null;

const reinitialize = async (reason) => {
  if (isShuttingDown || isReinitializing) return;
  isReinitializing = true;
  console.error(`🔄 Reinitializing client (${reason})...`);
  isReady = false;
  initRetries = 0;
  try {
    await destroyClient();
  } catch (e) {
    console.error("Reinit destroy failed:", e?.message || e);
  }
  isReinitializing = false;
  startClient();
};

const attachPageGuards = () => {
  try {
    const page = client.pupPage;
    if (page && pageGuardsAttachedTo !== page) {
      pageGuardsAttachedTo = page;
      page.on("close", () => reinitialize("WhatsApp page closed"));
      page.on("error", (e) => reinitialize(`WhatsApp page error (${e?.message || e})`));
      page.on("framenavigated", (frame) => {
        try {
          if (frame && typeof frame.parentFrame === "function" && !frame.parentFrame()) {
            const url = frame.url();
            if (url && !url.includes("web.whatsapp.com")) {
              reinitialize(`navigated away unexpectedly (${url})`);
            }
          }
        } catch {}
      });
      console.log("🛡️ Page crash guards attached.");
    }
    const browser = client.pupBrowser;
    if (browser && !browser.__temiGuard) {
      browser.__temiGuard = true;
      browser.on("disconnected", () => reinitialize("puppeteer browser disconnected"));
    }
  } catch {}
};

const recordLoading = (percent) => {
  const now = Date.now();
  lastLoadingAt = now;
  loadingHistory.push({ t: now, percent });
  // keep last 10 min only
  loadingHistory = loadingHistory.filter((e) => now - e.t < 10 * 60 * 1000);
};

const isLoadingLoop = () => {
  const now = Date.now();
  const recent = loadingHistory.filter((e) => now - e.t < STALL_BUDGET_MS);
  // loop signature: many high-90s events, never reaching ready
  if (recent.length < 8) return false;
  const high = recent.filter((e) => e.percent >= 90).length;
  return high >= 8;
};

setInterval(async () => {
  if (isShuttingDown || isReinitializing || isInitializing) return;
  const now = Date.now();
  try {
    attachPageGuards();
  } catch {}

  if (!isReady) {
    // pre-ready: stall or 95↔99 loop
    if (lastLoadingAt && now - lastLoadingAt > STALL_BUDGET_MS) {
      await reinitialize("no loading progress for 5 min");
      return;
    }
    if (isLoadingLoop()) {
      await reinitialize("loading loop detected (95%↔99% without ready)");
      return;
    }
    return;
  }

  // ready: probe the page — silent death shows up here first
  try {
    const state = await Promise.race([
      client.getState(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("getState timeout")), PROBE_TIMEOUT_MS)),
    ]);
    if (state === "CONNECTED" || state === "OPENING" || state === "PAIRING") {
      healthFailStreak = 0;
      return;
    }
    console.log(`⚠️ Watchdog: unexpected state "${state}"`);
    healthFailStreak++;
  } catch (e) {
    const msg = String(e?.message || e || "");
    console.error("⚠️ Watchdog probe failed:", msg.split("\n")[0]);
    const fatal = /Target closed|Session closed|Protocol error|Execution context was destroyed|getState timeout/i.test(msg);
    healthFailStreak++;
    if (fatal) {
      await reinitialize(`health probe fatal (${msg.split("\n")[0]})`);
      return;
    }
  }

  // >5 min of consecutive probe failures (or no successful traffic while
  // inbound arrived) → the bot is "not responding" → reinit without restart
  const inboundWaiting = lastInboundAt > 0 && now - lastInboundAt < 10 * 60 * 1000;
  if (healthFailStreak >= 5 || (healthFailStreak >= 3 && inboundWaiting)) {
    healthFailStreak = 0;
    await reinitialize("not responding for 5+ min (probe failures)");
  }
}, WATCHDOG_INTERVAL_MS);

process.on("unhandledRejection", (reason) => {
  const msg = String(reason?.message || reason || "");
  // This is the exact crash you hit: page reloaded mid-inject. Only retry
  // if we never became ready — otherwise we'd spawn a duplicate session
  // (multiple "Bot is ready!" + duplicate replies).
  if ((msg.includes("Execution context was destroyed") || msg.includes("Protocol error")) && !isReady) {
    console.error("⚠️ Transient inject race (page reloaded mid-inject), retrying in 5s...");
    setTimeout(async () => {
      await destroyClient();
      startClient();
    }, 5000);
    return;
  }
  console.error("Unhandled Rejection:", reason);
});

startClient();

console.log("🚀 Starting *Témí* — Learn AI. Teach Better...");
console.log("⏳ Please wait while WhatsApp Web loads...");
