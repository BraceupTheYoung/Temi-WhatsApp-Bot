const chatgptModule = require("./content/module1-chatgpt");
const magicschoolModule = require("./content/module2-magicschool");
const eduaideModule = require("./content/module3-eduaide");

const contentDB = {
  welcome: {
    text: "Welcome to the AI for Teachers Chatbot!\n\nI'm Témí, your AI learning assistant developed by the Brace Up The Young Foundation. I'm here to guide you step by step on how to use AI to improve your teaching, save time, and engage your students better.\n\nYou'll learn at your own pace and earn your certificate upon completion!\n\nDrop a 👍 to get started!",
    media: {
      filename: "welcome.jpeg"
    }
  },

  menuHelp: {
    helpText: "Need help? I'm *Témí*! Here are some commands you can use:\n\n*Menu* - View the main menu\n*Help* - Show this help message\n*Reset* - Start over\n\nJust reply with a number or keyword to navigate!",
    greeting: "Welcome back! Great to see you again, Teacher!"
  },

  registration: {
    fullName: { prompt: "What is your full name?" },
    terms: {
      prompt: "Before we go any further, let's get some legal stuff out the way.\n\nFirstly, by continuing, you will be agreeing to our Terms and Conditions and Privacy Policy.\n\n📄 Read our full Terms & Conditions here: https://docs.google.com/document/d/13_Lul7V44IND2KBkUnEOrbHoE2Yxc0Imxulf909pQxU/edit?usp=sharing\n\nAlso, would you mind opting in so we can contact you in the future?",
      buttons: ["Yes", "No"]
    },
    email: {
      prompt: "Please enter your email address."
    },
    province: {
      prompt: "Please enter your state"
    },
    country: {
      prompt: "Please enter your country"
    },
    community: {
      prompt: "Which of these best describes your community?",
      buttons: ["Rural", "Urban", "Township"]
    },
    gender: {
      prompt: "What gender do you identify as?",
      buttons: ["Female", "Male", "Prefer not to say"]
    },
    age: {
      prompt: "Which age range do you fall into?",
      options: ["18-24", "25-34", "35-44", "45-54", "55+"]
    },
    language: {
      prompt: "What Language do you speak?",
      // NOTE: stored as a preference only — lesson content and audio are
      // currently available in English. Do not treat selection as full
      // translation support unless translated content actually exists.
      options: ["English", "Yoruba", "Igbo", "Hausa", "French", "Arabic", "Spanish", "Portuguese", "German", "Russian", "Swahili", "Malay", "Italian"]
    }
  },

  mainMenu: {
    text: "Welcome! I'm *Témí* — Learn AI. Teach Better.\n\nWhat would you like to do?\n\nReply with a number or keyword."
  },

  topics: {
    "ai-tools": {
      title: "AI Tools for Teachers",
      intro: "Welcome to the AI Tools for Teachers course! You'll learn about 3 powerful AI tools:\n\n1. ChatGPT - The world's most popular AI assistant\n2. Magic School AI - Built specifically for teachers\n3. Edu Aide - Your personal teaching assistant\n\nEach module has step-by-step lessons with text and a quiz. Let's get started!",
      modules: [
        chatgptModule,
        magicschoolModule,
        eduaideModule
      ]
    }
  },

  completion: {
    congratulations: "🎉🎉🎉 CONGRATULATIONS, TEACHER! 🎉🎉🎉\n\n*Témí* says: You just completed the full AI Tools for Teachers course!\n\nThis is a huge achievement. You have worked through 3 powerful AI tools, completed hands-on practice exercises, and passed all 3 quizzes. You should be incredibly proud of yourself! 🌟\n\nLet's look at everything you have accomplished 👇\n\n✅ Tool 1 — ChatGPT\n✅ Tool 2 — Magic School AI\n✅ Tool 3 — Edu Aide\n\nYou are now equipped with the knowledge and practical skills to use AI confidently, responsibly, and effectively in your classroom every single day. 💪\n\n─────────────────────────────────\n🏆 YOUR CERTIFICATE AWAITS!\n─────────────────────────────────\n\nTo receive your Certificate of Completion, please reply with:\n\n1. Your FULL NAME (as you want it on the certificate)\n2. Your EMAIL ADDRESS (where we will send your certificate)\n\nExample: *John Smith, john@email.com*\n\nYour official certificate will be prepared and sent to you manually! 📧\n\nReply *CERTIFICATE* to get your certificate steps again ♻️\nReply *MENU* to go back to the main menu 🏠\nReply *SHARE* to get a message you can share with your colleagues 📲",

    certificate: "🎓 *CERTIFICATE REQUEST RECEIVED!*\n\nThank you! We have received your name and email. 🎉\n\nYour Certificate of Completion for the *AI Tools for Teachers Programme* will be prepared and sent to you manually.\n\nYou will receive your certificate via email soon!\n\n─────────────────────────────────\n\n*Témí* says: Congratulations on your achievement! 🎉\n\nReply *SHARE* to get a message to share with colleagues.\nReply *MENU* to go back to the main menu.",

    share: "Here is a message you can copy and share with your fellow teachers right now! 👇\n\n─────────────────────────────────\n\n📲 COPY AND SHARE THIS MESSAGE:\n\n\"Hey Teacher! 👋\n\nI just discovered *Témí* — the AI for Teachers Training on WhatsApp — and it completely changed how I think about using technology in my classroom!\n\n*Témí* says: 'Learn AI. Teach Better.'\n\nI learned how to use powerful AI tools like ChatGPT, Magic School AI, and Edu Aide — all specifically for teaching.\n\nI now know how to:\n✅ Plan lessons in minutes instead of hours\n✅ Create quizzes and assessments instantly\n✅ Write personalised student feedback at scale\n✅ Support diverse learners in my classroom\n✅ Use AI responsibly and ethically\n\nThe best part? It's FREE and you can do it right here on WhatsApp, at your own pace!\n\nType 'Hi' to start your journey with *Témí*! 🚀\n\nTrust me — your teaching will never be the same again. 💛\"\n\n─────────────────────────────────\n\nFeel free to send this to your school WhatsApp group, your department colleagues, or any teacher you know who would benefit! 🎓\n\nThe more teachers we empower, the better our students' futures become. 💛\n\nReply *CERTIFICATE* to get your certificate 🏆\nReply *MENU* to go back to the main menu 🏠"
  },

  mainMenuOptions: [
    { id: "ai-tools", label: "AI Tools for Teachers", description: "Learn ChatGPT, Magic School AI & Edu Aide" },
    { id: "continue", label: "Continue", description: "Pick up where you stopped" }
  ]
};

const getWelcome = () => contentDB.welcome;
const getRegistration = () => contentDB.registration;
const getMainMenu = () => {
  const menu = {
    text: "I'm *Témí* — Learn AI. Teach Better.\n\nWhat would you like to do?\n\n",
    options: contentDB.mainMenuOptions
  };
  menu.options.forEach((opt, idx) => {
    menu.text += `${idx + 1}. ${opt.label}\n   ${opt.description}\n\n`;
  });
  return menu;
};
const getMenuHelp = () => contentDB.menuHelp;
const getTopic = (topicId) => contentDB.topics[topicId];
const getCompletion = () => contentDB.completion;

const getQuickResponse = (input) => {
  const lower = input.toLowerCase();
  if (lower.includes("tools list")) {
    return "Here are some AI tools for teachers:\n\n1. ChatGPT - For lesson planning and content creation\n2. Magic School AI - 60+ teacher-specific tools\n3. Edu Aide - Personalised feedback and reports\n4. Canva - For creating visual materials\n5. Google Gemini - For research and brainstorming\n6. Microsoft Copilot - For productivity tasks\n7. Gamma - For presentations\n8. Diffit - For differentiating content\n9. Quizizz AI - For creating quizzes\n10. Google NotebookLM - For research";
  }
  if (lower.includes("prompt template")) {
    return "Here's a prompt template you can use:\n\n'I am a [subject] teacher for [grade level]. I need help creating [type of content] about [topic]. The learning objective is [objective]. Can you provide [specific request]?'\n\nExample:\n'Act as an experienced Nigerian primary school teacher. Write a 40-minute lesson plan for Primary 5 on fractions. Include 3 learning objectives, activities, and 5 quiz questions. Use simple language.'";
  }
  if (lower.includes("certificate")) {
    return "📝 *Certificate Request*\n\nTo get your Certificate of Completion, complete the course first, then reply *DONE* or *CERTIFICATE*.\n\nYou will be asked for your full name and email address to receive your certificate manually.";
  }
  return null;
};

module.exports = {
  contentDB,
  getWelcome,
  getRegistration,
  getMainMenu,
  getMenuHelp,
  getTopic,
  getCompletion,
  getQuickResponse
};
