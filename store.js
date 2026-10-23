// Shared read layer for bot + admin dashboard.
// Always reads live JSON from disk (EC2 is source of truth — these files
// are gitignored, so never rely on repo copies).
const fs = require("fs");
const path = require("path");

const contentDB = require("./content-db.js");

const DATA_DIR = __dirname;
const USERS_DB = path.join(DATA_DIR, "users_db.json");
const OPTED_IN = path.join(DATA_DIR, "opted_in_users.json");

function loadJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Same definition as teacher-bot.js isRegistered(): fully registered only
// once name + terms + (language or jobRole) are all present.
function isRegisteredUser(u) {
  return !!(u && u.fullName && u.agreedToTerms && (u.language || u.jobRole));
}

function maskId(id) {
  if (!id || typeof id !== "string") return "—";
  const local = id.split("@")[0] || id;
  if (local.length <= 4) return `…${local}`;
  return `…${local.slice(-4)}`;
}

// Dashboard grouping normalization: trim, collapse whitespace, Title Case.
// State variant additionally strips the word "state" so "Oyo State", "oyo"
// and "OYo" all group as "Oyo". City names (e.g. "Ibadan") are intentionally
// left as-is — no city→state dictionary (per product decision).
function toTitleCase(s) {
  return String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeState(v) {
  const s = String(v ?? "").trim().replace(/\bstate\b/gi, "").replace(/\s+/g, " ").trim();
  return s ? toTitleCase(s) : "";
}

function normalizeLabel(v) {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  return s ? toTitleCase(s) : "";
}

function summarizeProgress(user, topicId = "ai-tools") {
  const topic = contentDB.topics[topicId];
  const modules = (user.progress && user.progress[topicId] && user.progress[topicId].modules) || {};
  const ids = Object.keys(modules);
  let completed = 0;
  let slidesSeen = 0;
  const quizScores = {};
  for (const [mid, m] of Object.entries(modules)) {
    if (m && m.completed) completed++;
    if (m && Array.isArray(m.slides)) slidesSeen += m.slides.length;
    if (m && typeof m.quizScore === "number") quizScores[mid] = m.quizScore;
  }
  // Total modules come from the topic config; fall back to 3 for tolerance.
  const totalModules = topic?.modules?.length || 3;
  return { completed, totalModules, slidesSeen, quizScores };
}

function toRow(id, u, topicId = "ai-tools") {
  const prog = summarizeProgress(u || {}, topicId);
  const registered = isRegisteredUser(u);
  const hasAnyField =
    !!(u && (u.fullName || u.email || u.province || u.country || u.community || u.gender || u.age || u.language));
  const feedbackText = typeof (u && u.feedback) === "string"
    ? u.feedback
    : ((u && u.feedback && u.feedback.text) || "");
  return {
    id,
    maskedId: maskId(id),
    fullName: u.fullName || "",
    email: u.email || "",
    province: u.province || "",
    country: u.country || "",
    community: u.community || "",
    gender: u.gender || "",
    age: u.age || "",
    language: u.language || "",
    jobRole: u.jobRole || "",
    agreedToTerms: !!u.agreedToTerms,
    status: registered ? "registered" : hasAnyField ? "partial" : "new",
    modulesCompleted: prog.completed,
    totalModules: prog.totalModules,
    progressPct: prog.totalModules > 0 ? Math.round((prog.completed / prog.totalModules) * 100) : 0,
    quizScores: prog.quizScores,
    certificates: Array.isArray(u.certificateRequests) ? u.certificateRequests.length : 0,
    feedback: feedbackText,
    feedbackAt: (u && u.feedback && u.feedback.at) || null,
    inQuiz: !!(u.quizState && u.quizState.inQuiz),
    createdAt: u.createdAt || null,
    lastActive: u.lastActive || null,
  };
}

function getAllRows() {
  const db = loadJsonSafe(USERS_DB, {});
  const optedIn = new Set(loadJsonSafe(OPTED_IN, []));
  return Object.entries(db).map(([id, u]) => {
    const row = toRow(id, u || {});
    row.optedIn = optedIn.has(id);
    return row;
  });
}

function applyFilters(rows, f) {
  const q = (f.search || "").trim().toLowerCase();
  return rows.filter((r) => {
    if (f.status && r.status !== f.status) return false;
    if (f.province && normalizeState(r.province) !== normalizeState(f.province)) return false;
    if (f.country) {
      if (f.country === "__other__") {
        // "Other" bucket: any non-empty country that isn't Nigeria.
        const co = normalizeLabel(r.country);
        if (!co || co === "Nigeria") return false;
      } else if (normalizeLabel(r.country) !== normalizeLabel(f.country)) return false;
    }
    if (f.gender && (r.gender || "").toLowerCase() !== f.gender.toLowerCase()) return false;
    if (f.community && (r.community || "").toLowerCase() !== f.community.toLowerCase()) return false;
    if (f.optedIn === "yes" && !r.optedIn) return false;
    if (f.optedIn === "no" && r.optedIn) return false;
    if (q) {
      const hay = `${r.fullName} ${r.email} ${r.province} ${r.country} ${r.id} ${r.feedback || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const SORT_KEYS = new Set(["fullName", "province", "country", "createdAt", "lastActive", "modulesCompleted", "status"]);

function searchUsers(filters = {}) {
  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);
  const sort = SORT_KEYS.has(filters.sort) ? filters.sort : "lastActive";
  const order = filters.order === "asc" ? 1 : -1;

  let rows = applyFilters(getAllRows(), filters);
  const total = rows.length;
  rows.sort((a, b) => {
    const av = a[sort] ?? "";
    const bv = b[sort] ?? "";
    if (typeof av === "number" || typeof bv === "number") return ((av || 0) - (bv || 0)) * order;
    return String(av).localeCompare(String(bv)) * order;
  });
  rows = rows.slice(offset, offset + limit);
  // Authenticated admin view: id is needed for detail lookup.
  // UI displays maskedId; full ID only leaves the server over authed HTTPS.
  return { total, limit, offset, users: rows };
}

function getUserDetail(id, topicId = "ai-tools") {
  const db = loadJsonSafe(USERS_DB, {});
  const u = db[id];
  if (!u) return null;
  const optedIn = new Set(loadJsonSafe(OPTED_IN, []));
  const row = toRow(id, u, topicId);
  row.optedIn = optedIn.has(id);
  // Full progress detail for the drawer.
  const modules = (u.progress || {})[topicId]?.modules || {};
  row.modules = modules;
  row.quizState = u.quizState || null;
  row.certificateRequests = u.certificateRequests || [];
  return row;
}

function getStats() {
  const rows = getAllRows();
  const byProvince = {};
  const byCountry = {};
  const byGender = {};
  const byAge = {};
  const byCommunity = {};
  let registered = 0;
  let partial = 0;
  let completedAll = 0;
  let certsIssued = 0;
  let inQuiz = 0;
  // Per-course completion tracking
  const courseCompletion = {
    "ai-tools": { completed: 0, totalModules: 0, completedAll: 0, certificates: 0 },
    "lesson-planning": { completed: 0, totalModules: 0, completedAll: 0, certificates: 0 },
  };
  for (const r of rows) {
    if (r.status === "registered") registered++;
    else partial++;
    certsIssued += r.certificates;
    if (r.inQuiz) inQuiz++;
    if (r.modulesCompleted >= r.totalModules) completedAll++;
    // Grouped on NORMALIZED values so "oyo"/"OYo"/"Oyo State" merge.
    // Raw user input is preserved in rows/CSV; only aggregation is cleaned.
    const st = normalizeState(r.province);
    const co = normalizeLabel(r.country);
    const ge = normalizeLabel(r.gender);
    const ag = normalizeLabel(r.age);
    const cm = normalizeLabel(r.community);
    if (st) byProvince[st] = (byProvince[st] || 0) + 1;
    if (co) byCountry[co] = (byCountry[co] || 0) + 1;
    if (ge) byGender[ge] = (byGender[ge] || 0) + 1;
    if (ag) byAge[ag] = (byAge[ag] || 0) + 1;
    if (cm) byCommunity[cm] = (byCommunity[cm] || 0) + 1;
    // Per-course stats
    for (const topicId of ["ai-tools", "lesson-planning"]) {
      const prog = r.progress && r.progress[topicId];
      const total = prog?.totalModules || 0;
      const completed = prog?.completed || 0;
      if (total > 0) {
        courseCompletion[topicId].totalModules += total;
        courseCompletion[topicId].completed += completed;
        if (completed >= total) courseCompletion[topicId].completedAll += 1;
      }
      courseCompletion[topicId].certificates += r.certificates;
    }
  }
  const top = (obj) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
  return {
    total: rows.length,
    registered,
    partial,
    optedIn: rows.filter((r) => r.optedIn).length,
    completedAll,
    certsIssued,
    inQuiz,
    byProvince: top(byProvince),
    byCountry: top(byCountry),
    byGender: top(byGender),
    byAge: top(byAge),
    byCommunity: top(byCommunity),
    courseCompletion,
    generatedAt: new Date().toISOString(),
  };
}

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function usersToCsv(rows) {
  const header = [
    "maskedId", "fullName", "email", "province", "country", "community",
    "gender", "age", "language", "jobRole", "status", "optedIn",
    "modulesCompleted", "progressPct", "certificates", "feedback", "feedbackAt", "createdAt", "lastActive",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      header
        .map((k) => {
          let v = r[k];
          if ((k === "createdAt" || k === "lastActive") && typeof v === "number") {
            v = new Date(v).toISOString();
          }
          return csvEscape(v);
        })
        .join(",")
    );
  }
  return lines.join("\n");
}

module.exports = {
  getAllRows,
  searchUsers,
  getUserDetail,
  getStats,
  usersToCsv,
  applyFilters,
  isRegisteredUser,
  normalizeState,
  normalizeLabel,
};
