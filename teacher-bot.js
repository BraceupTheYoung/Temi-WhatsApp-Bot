const qrcode = require("qrcode-terminal");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { contentDB, getTopic, getWelcome, getMainMenu, getRegistration, getMenuHelp, getQuickResponse, getCompletion } = require("./content-db.js");

const ADMIN_NUMBER = process.env.ADMIN_NUMBER;
const MEDIA_DIR = path.join(__dirname, "media");

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: "session2",
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
    timeout: 60000,
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
      startedAt: null
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
  
  if (welcome.media) {
    try {
      const mediaPath = path.join(MEDIA_DIR, welcome.media.filename);
      if (fs.existsSync(mediaPath)) {
        const media = await MessageMedia.fromFilePath(mediaPath);
        await message.reply(media, undefined, { caption: welcomeText });
        return;
      }
    } catch (e) {
      console.log("Media not found, sending text only");
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
      
      await message.reply(`📚 *${module.title}*\n\nStep ${summary.currentSlideIndex + 1}: ${module.slides[summary.currentSlideIndex]?.text?.substring(0, 100) || "Continuing..."}\n\nReply *NEXT* to continue or *MENU* to go back.`);
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
      const introMedia = await MessageMedia.fromFilePath(introMediaPath);
      await message.reply(introMedia, undefined, { caption: introText + "\n\nReply with *1* to start or *2* to go back." });
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
  
  const textChunks = Array.isArray(slide.text) ? slide.text : [slide.text];
  
  for (const chunk of textChunks) {
    let text = chunk.replace("{name}", usersDB[userId].name || "Learner");
    await message.reply(text);
  }
  
  if (slide.audio) {
    try {
      const audioPath = path.join(MEDIA_DIR, slide.audio);
      if (fs.existsSync(audioPath)) {
        const media = await MessageMedia.fromFilePath(audioPath);
        await message.reply(media);
      }
    } catch (e) {
      console.error("Error sending audio:", e);
    }
  } else if (slide.media) {
    try {
      const mediaPath = path.join(MEDIA_DIR, slide.media.filename);
      if (fs.existsSync(mediaPath)) {
        const media = await MessageMedia.fromFilePath(mediaPath);
        await message.reply(media, undefined, { caption: textChunks[textChunks.length - 1] });
      }
    } catch (e) {
      console.error("Error sending media:", e);
    }
  }
  
  if (slide.buttons) {
    await message.reply("What would you like to do next?\n\nReply with *1* to continue or *2* to go back.");
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
    finalMessage += `Reply *NEXT TOOL* to continue to the next AI tool.\n`;
    finalMessage += `Reply *DONE* to see your certificate.\n`;
    finalMessage += `Reply *MENU* to go back to the main menu.`;
    
    await message.reply(finalMessage);
    updateUserProgress(userId, state.currentTopic, module.id, null, true);
    
    if (!usersDB[userId].progress[state.currentTopic].modules[module.id]) {
      usersDB[userId].progress[state.currentTopic].modules[module.id] = {};
    }
    usersDB[userId].progress[state.currentTopic].modules[module.id].quizScore = correct;
    saveData();
    
    state.stage = STAGES.COMPLETED;
  }
};

const handleCompleted = async (message) => {
  const userId = message.from;
  const userInput = message.body.toLowerCase().trim();
  const state = getUserState(userId);
  const mainMenu = getMainMenu();
  const completion = getCompletion();
  
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
      // No more modules - show final congratulations
      await message.reply(completion.congratulations);
    }
    return;
  }
  
  // Handle "done" / "certificate" - request certificate details
  if (userInput === "done" || userInput === "certificate" || userInput === "cert") {
    const moduleId = state.currentModule?.id;
    const quizScore = usersDB[userId]?.progress[state.currentTopic]?.modules[moduleId]?.quizScore || 0;
    
    if (quizScore < 4) {
      await message.reply(`📝 *Quiz Retake Required*\n\nYour quiz score was ${quizScore}/5. You need a score of *4 or higher* to get your certificate.\n\n━━━━━━━━━━━━━━━━━━━━\n\nReply *RETAKE* to try the quiz again.\nReply *MENU* to go back to the main menu.`);
      return;
    }
    
    // Ask for certificate details (name, email)
    state.stage = "CERT_REQUEST";
    await message.reply(`📝 *Certificate Request*\n\nTo prepare your Certificate of Completion, please reply with:\n\n1. Your FULL NAME (as you want it on the certificate)\n2. Your EMAIL ADDRESS (where we will send your certificate)\n\nExample: *John Smith, john@email.com*`);
    return;
  }
  
  // Handle certificate request - store name and email
  if (state.stage === "CERT_REQUEST") {
    const input = message.body.trim();
    const certParts = input.split(/,|and|;/).map(s => s.trim());
    
    if (certParts.length >= 2) {
      const certName = certParts[0];
      const certEmail = certParts[1];
      
      if (!usersDB[userId].certificateRequests) {
        usersDB[userId].certificateRequests = [];
      }
      usersDB[userId].certificateRequests.push({
        name: certName,
        email: certEmail,
        date: new Date().toISOString()
      });
      saveData();
      
      // Reset stage to COMPLETED so user can continue course
      state.stage = STAGES.COMPLETED;
      
      await message.reply(`✅ *Certificate Request Confirmed!*\n\nName: ${certName}\nEmail: ${certEmail}\n\nYour certificate will be prepared and sent to you manually! 📧\n\n─────────────────────────────────\n\nReply *NEXT TOOL* to continue to the next module ➡️\nReply *MENU* to go back to the main menu 🏠`);
    } else {
      await message.reply(`Please provide both your name and email in the format: *Name, email@example.com*\n\nExample: *John Smith, john@email.com*`);
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

client.on("ready", () => {
  console.log("✅ *Témí* Bot is ready!");
  console.log("📚 Pre-loaded content:");
  console.log(`   • Topics: ${Object.keys(contentDB.topics).length}`);
  console.log(`   • AI Tools modules: ${contentDB.topics["ai-tools"]?.modules?.length || 0}`);
  console.log(`   • Registered users: ${Object.keys(usersDB).length}`);
});

client.on("message", async (message) => {
  try {
    if (message.from === "status@broadcast" || message.fromMe) return;
    if (message.isGroup) return;
    
    const userId = message.from;
    const userInput = message.body.trim().toLowerCase();
    const state = getUserState(userId);
    
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
        if (userInput === "hello temi") {
          await handleNewUser(message);
        }
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
});

client.on("auth_failure", (msg) => {
  console.error("❌ Authentication failed:", msg);
  console.log("Retrying in 3 seconds...");
  setTimeout(() => {
    client.initialize();
  }, 3000);
});

client.on("disconnected", (reason) => {
  console.log("⚠️ Client disconnected:", reason);
  console.log("Reconnecting in 3 seconds...");
  setTimeout(() => {
    client.initialize();
  }, 3000);
});

process.on("SIGINT", () => {
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
client.initialize();

console.log("🚀 Starting *Témí* — Learn AI. Teach Better...");
console.log("⏳ Please wait while WhatsApp Web loads...");
