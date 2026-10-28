// Témí admin dashboard client (vanilla JS, no build step).
const state = { offset: 0, limit: 50, sort: "lastActive", order: "desc", total: 0 };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (ts) => (!ts ? "—" : new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));

async function api(path, opts) {
  const res = await fetch(path, { credentials: "same-origin", ...(opts || {}) });
  if (res.status === 401) { showLogin(); throw new Error("auth"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

function showLogin() {
  $("loginView").classList.remove("hidden");
  $("dashView").classList.add("hidden");
  $("logoutBtn").classList.add("hidden");
}
function showDash() {
  $("loginView").classList.add("hidden");
  $("dashView").classList.remove("hidden");
  $("logoutBtn").classList.remove("hidden");
}

async function boot() {
  try {
    const s = await api("/api/admin/status");
    if (!s.configured) {
      $("loginView").classList.remove("hidden");
      $("loginErr").textContent = "Dashboard not configured on server (ADMIN_USER / ADMIN_PASS_HASH missing).";
      return;
    }
    if (s.loggedIn) { showDash(); await loadAll(); }
    else showLogin();
  } catch { showLogin(); }
}

async function doLogin() {
  $("loginErr").textContent = "";
  try {
    await api("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("username").value, password: $("password").value }),
    });
    $("password").value = "";
    showDash();
    await loadAll();
  } catch (e) {
    if (e.message !== "auth") $("loginErr").textContent = e.message;
  }
}

function filters() {
  const countrySel = $("fCountry") ? $("fCountry").value : "";
  // "Other" = anything non-empty that isn't Nigeria (normalized compare).
  const country = countrySel === "Other" ? "__other__" : countrySel;
  return {
    search: $("fSearch").value.trim(),
    status: $("fStatus").value,
    gender: $("fGender").value,
    community: $("fCommunity").value,
    province: $("fProvince").value.trim(),
    country,
    sort: state.sort, order: state.order,
    limit: state.limit, offset: state.offset,
  };
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== "" && v != null)).toString();

async function loadStats() {
  const s = await api("/api/admin/stats");
  const courseCards = (s.courses && s.courses.length)
    ? s.courses.map((c) => [c.completedAll, `${c.shortTitle} completed`])
    : [[s.completedAll, "AI Tools completed"]];
  $("statCards").innerHTML = [
    [s.total, "Total users"], [s.registered, "Registered"], [s.partial, "Partial"],
    ...courseCards,
    [s.completedBoth ?? 0, "Completed both courses"],
    [s.certsIssued, "Certificates"], [s.optedIn, "Opted in"],
  ].map(([n, l]) => `<div class="card"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("");
  const bd = (title, arr) => (arr || []).length ? `<div style="margin-bottom:10px"><b style="font-size:13px">${esc(title)}</b><div class="breakdown">${arr.map((x) => `<span>${esc(x.name)} · ${x.count}</span>`).join("")}</div></div>` : "";
  const pillsEl = $("breakdownPills");
  if (pillsEl) {
    pillsEl.innerHTML =
      bd("Country", s.byCountry) + bd("State", s.byProvince) + bd("Gender", s.byGender) + bd("Age", s.byAge) + bd("Community", s.byCommunity);
  } else {
    // Fallback for older admin.html without the pills container.
    $("breakdowns").innerHTML = `<b style="font-size:13px;color:#075e54">BREAKDOWNS</b><div style="margin-top:8px">` +
      bd("Country", s.byCountry) + bd("State", s.byProvince) + bd("Gender", s.byGender) + bd("Age", s.byAge) + bd("Community", s.byCommunity) + "</div>";
  }
  drawBreakdownCharts(s);
}

// Clean, professional palette (cycled when slices exceed it).
const CHART_PALETTE = ["#075e54", "#25d366", "#34b7f1", "#f7c948", "#e67e22", "#8e44ad", "#e53935", "#607d8b", "#00bfa5", "#7986cb"];
const breakdownCharts = {};
function drawPie(canvasId, arr) {
  const canvas = $(canvasId);
  if (!canvas) return;
  if (breakdownCharts[canvasId]) { try { breakdownCharts[canvasId].destroy(); } catch {} delete breakdownCharts[canvasId]; }
  const data = arr || [];
  if (!data.length || typeof window.Chart === "undefined") {
    if (typeof window.Chart === "undefined" && data.length) return; // pills remain as fallback
    return;
  }
  const colors = data.map((_, i) => CHART_PALETTE[i % CHART_PALETTE.length]);
  breakdownCharts[canvasId] = new window.Chart(canvas, {
    type: "pie",
    data: { labels: data.map((x) => x.name), datasets: [{ data: data.map((x) => x.count), backgroundColor: colors, borderColor: "#fff", borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } } },
  });
}
function drawBreakdownCharts(s) {
  if (typeof window.Chart === "undefined") return; // offline CDN: pills still render
  drawPie("chCountry", s.byCountry);
  drawPie("chProvince", s.byProvince);
  drawPie("chGender", s.byGender);
  drawPie("chAge", s.byAge);
  drawPie("chCommunity", s.byCommunity);
}

// Compact per-course indicator for the users table.
function courseProgressHtml(u) {
  const courses = u.courses && Object.keys(u.courses).length ? Object.values(u.courses) : null;
  if (!courses) {
    return `<div class="course-prog"><div class="cp-head"><b>AI Tools</b><span>${u.modulesCompleted}/${u.totalModules}</span></div><div class="bar"><i style="width:${u.progressPct}%"></i></div></div>`;
  }
  return courses.map((c) => `
    <div class="course-prog" title="${esc(c.title)}">
      <div class="cp-head"><b>${esc(c.shortTitle)}</b><span>${c.completed}/${c.totalModules}</span></div>
      <div class="bar"><i style="width:${c.progressPct}%"></i></div>
    </div>`).join("");
}

async function loadUsers() {
  const data = await api("/api/admin/users?" + qs(filters()));
  state.total = data.total;
  const fbPreview = (f) => {
    const t = String(f || "").trim();
    if (!t) return "—";
    return t.length > 80 ? t.slice(0, 80) + "…" : t;
  };
  $("rows").innerHTML = data.users.map((u) => `
    <tr>
      <td><b>${esc(u.fullName || "(no name)")}</b><br><span style="color:#667781;font-size:12px">${esc(u.maskedId)}</span></td>
      <td>${esc(u.email || "—")}<br><span style="color:#667781;font-size:12px">${esc(u.language || "")}</span></td>
      <td>${esc(u.province || "—")}<br><span style="color:#667781;font-size:12px">${esc(u.community || "")}</span></td>
      <td>${esc(u.country || "—")}</td>
      <td><span class="pill ${u.status === "registered" ? "reg" : "part"}">${esc(u.status)}</span></td>
      <td>${courseProgressHtml(u)}</td>
      <td style="max-width:220px" title="${esc(u.feedback || "")}">${esc(fbPreview(u.feedback))}</td>
      <td style="white-space:nowrap">${fmtDate(u.lastActive)}</td>
      <td><button class="btn btn-ghost" onclick="openDetail('${encodeURIComponent(u.id)}')">View</button></td>
    </tr>`).join("") || `<tr><td colspan="9" style="text-align:center;color:#667781;padding:24px">No users match these filters.</td></tr>`;
  const pages = Math.max(1, Math.ceil(data.total / state.limit));
  const cur = Math.floor(state.offset / state.limit) + 1;
  $("pageInfo").textContent = `${data.total} users · page ${cur}/${pages}`;
  $("prevBtn").disabled = state.offset <= 0;
  $("nextBtn").disabled = state.offset + state.limit >= data.total;
}

async function loadAll() { await Promise.all([loadStats(), loadUsers()]); }

// Per-course module detail for the drawer.
function courseDetailHtml(u) {
  const courses = u.courses && Object.keys(u.courses).length ? Object.values(u.courses) : null;
  if (!courses) {
    const mods = Object.entries(u.modules || {}).map(([mid, m]) =>
      `<div>• <b>${esc(mid)}</b> — slides: ${(m.slides || []).length}, completed: ${m.completed ? "✅" : "⬜"}${m.quizScore != null ? `, quiz: ${m.quizScore}` : ""}</div>`).join("") || "<div>—</div>";
    return `<b style="font-size:13px">MODULES (${u.modulesCompleted}/${u.totalModules})</b><div style="font-size:13px;margin:6px 0 12px">${mods}</div>`;
  }
  return `<b style="font-size:13px">COURSE PROGRESS</b>` + courses.map((c) => {
    const mods = Object.entries(c.modules || {}).map(([mid, m]) => {
      const bits = [`slides: ${(m.slides || []).length}`, m.completed ? "✅ completed" : "⬜ not completed"];
      if (m.quizScore != null) bits.push(`quiz: ${m.quizScore}`);
      return `<div class="course-mod">• <b>${esc(m.title || mid)}</b> <span>${bits.join(" · ")}</span></div>`;
    }).join("") || `<div class="course-mod muted">No progress yet.</div>`;
    return `<div class="course-detail">
      <div class="course-detail-head"><b>${esc(c.shortTitle)}</b><span>${c.completed}/${c.totalModules} modules</span></div>
      <div class="bar"><i style="width:${c.progressPct}%"></i></div>
      <div class="course-mods">${mods}</div>
    </div>`;
  }).join("");
}

async function openDetail(encId) {
  const u = await api("/api/admin/users/" + encId);
  const certs = (u.certificateRequests || []).map((c) => `<div>• ${esc(c.name)} (${esc(c.certId || "")}) — ${esc(c.date || "")}</div>`).join("") || "<div>—</div>";
  $("modalBody").innerHTML = `
    <h3>${esc(u.fullName || "(no name)")}</h3>
    <div class="meta">${esc(u.maskedId)} · ${esc(u.status)} · last active ${fmtDate(u.lastActive)}</div>
    <div class="kv">
      <b>Email</b><span>${esc(u.email || "—")}</span>
      <b>State</b><span>${esc(u.province || "—")}</span>
      <b>Country</b><span>${esc(u.country || "—")}</span>
      <b>Community</b><span>${esc(u.community || "—")}</span>
      <b>Gender / Age</b><span>${esc(u.gender || "—")} · ${esc(u.age || "—")}</span>
      <b>Language / Role</b><span>${esc(u.language || "—")} · ${esc(u.jobRole || "—")}</span>
      <b>Opted in</b><span>${u.optedIn ? "Yes" : "No"}</span>
      <b>Registered</b><span>${fmtDate(u.createdAt)}</span>
      <b>Feedback</b><span>${esc(u.feedback || "—")}${u.feedbackAt ? ` <span style="color:#667781;font-size:12px">(${esc(new Date(u.feedbackAt).toLocaleString())})</span>` : ""}</span>
    </div>
    ${courseDetailHtml(u)}
    <b style="font-size:13px">CERTIFICATES (${u.certificates})</b><div style="font-size:13px;margin:6px 0 12px">${certs}</div>
    <button class="btn btn-ghost" onclick="closeModal()" style="width:100%">Close</button>`;
  $("modalBg").classList.add("show");
}
function closeModal() { $("modalBg").classList.remove("show"); }

$("loginBtn").onclick = doLogin;
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("logoutBtn").onclick = async () => { await api("/api/admin/logout", { method: "POST" }).catch(() => {}); showLogin(); };
$("applyBtn").onclick = () => { state.offset = 0; loadUsers(); };
$("exportBtn").onclick = () => { window.location = "/api/admin/export.csv?all=1&" + qs({ ...filters(), limit: undefined, offset: undefined }); };
$("prevBtn").onclick = () => { state.offset = Math.max(0, state.offset - state.limit); loadUsers(); };
$("nextBtn").onclick = () => { state.offset += state.limit; loadUsers(); };
$("modalBg").onclick = (e) => { if (e.target.id === "modalBg") closeModal(); };
document.querySelectorAll("th[data-sort]").forEach((th) => {
  th.onclick = () => {
    const k = th.dataset.sort;
    if (state.sort === k) state.order = state.order === "asc" ? "desc" : "asc";
    else { state.sort = k; state.order = "desc"; }
    loadUsers();
  };
});
window.openDetail = openDetail; window.closeModal = closeModal;
boot();
