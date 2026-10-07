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
  return {
    search: $("fSearch").value.trim(),
    status: $("fStatus").value,
    gender: $("fGender").value,
    community: $("fCommunity").value,
    province: $("fProvince").value.trim(),
    sort: state.sort, order: state.order,
    limit: state.limit, offset: state.offset,
  };
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== "" && v != null)).toString();

async function loadStats() {
  const s = await api("/api/admin/stats");
  $("statCards").innerHTML = [
    [s.total, "Total users"], [s.registered, "Registered"], [s.partial, "Partial"],
    [s.completedAll, "Completed all"], [s.certsIssued, "Certificates"], [s.optedIn, "Opted in"],
  ].map(([n, l]) => `<div class="card"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("");
  const bd = (title, arr) => arr.length ? `<div style="margin-bottom:10px"><b style="font-size:13px">${esc(title)}</b><div class="breakdown">${arr.map((x) => `<span>${esc(x.name)} · ${x.count}</span>`).join("")}</div></div>` : "";
  $("breakdowns").innerHTML = `<b style="font-size:13px;color:#075e54">BREAKDOWNS</b><div style="margin-top:8px">` +
    bd("State", s.byProvince) + bd("Gender", s.byGender) + bd("Age", s.byAge) + bd("Community", s.byCommunity) + "</div>";
}

async function loadUsers() {
  const data = await api("/api/admin/users?" + qs(filters()));
  state.total = data.total;
  $("rows").innerHTML = data.users.map((u) => `
    <tr>
      <td><b>${esc(u.fullName || "(no name)")}</b><br><span style="color:#667781;font-size:12px">${esc(u.maskedId)}</span></td>
      <td>${esc(u.email || "—")}<br><span style="color:#667781;font-size:12px">${esc(u.language || "")}</span></td>
      <td>${esc(u.province || "—")}<br><span style="color:#667781;font-size:12px">${esc(u.community || "")}</span></td>
      <td><span class="pill ${u.status === "registered" ? "reg" : "part"}">${esc(u.status)}</span></td>
      <td>${u.modulesCompleted}/${u.totalModules}<div class="bar"><i style="width:${u.progressPct}%"></i></div></td>
      <td style="white-space:nowrap">${fmtDate(u.lastActive)}</td>
      <td><button class="btn btn-ghost" onclick="openDetail('${encodeURIComponent(u.id)}')">View</button></td>
    </tr>`).join("") || `<tr><td colspan="7" style="text-align:center;color:#667781;padding:24px">No users match these filters.</td></tr>`;
  const pages = Math.max(1, Math.ceil(data.total / state.limit));
  const cur = Math.floor(state.offset / state.limit) + 1;
  $("pageInfo").textContent = `${data.total} users · page ${cur}/${pages}`;
  $("prevBtn").disabled = state.offset <= 0;
  $("nextBtn").disabled = state.offset + state.limit >= data.total;
}

async function loadAll() { await Promise.all([loadStats(), loadUsers()]); }

async function openDetail(encId) {
  const u = await api("/api/admin/users/" + encId);
  const mods = Object.entries(u.modules || {}).map(([mid, m]) =>
    `<div>• <b>${esc(mid)}</b> — slides: ${(m.slides || []).length}, completed: ${m.completed ? "✅" : "⬜"}${m.quizScore != null ? `, quiz: ${m.quizScore}` : ""}</div>`).join("") || "<div>—</div>";
  const certs = (u.certificateRequests || []).map((c) => `<div>• ${esc(c.name)} (${esc(c.certId || "")}) — ${esc(c.date || "")}</div>`).join("") || "<div>—</div>";
  $("modalBody").innerHTML = `
    <h3>${esc(u.fullName || "(no name)")}</h3>
    <div class="meta">${esc(u.maskedId)} · ${esc(u.status)} · last active ${fmtDate(u.lastActive)}</div>
    <div class="kv">
      <b>Email</b><span>${esc(u.email || "—")}</span>
      <b>State / Country</b><span>${esc(u.province || "—")} ${esc(u.country ? "/ " + u.country : "")}</span>
      <b>Community</b><span>${esc(u.community || "—")}</span>
      <b>Gender / Age</b><span>${esc(u.gender || "—")} · ${esc(u.age || "—")}</span>
      <b>Language / Role</b><span>${esc(u.language || "—")} · ${esc(u.jobRole || "—")}</span>
      <b>Opted in</b><span>${u.optedIn ? "Yes" : "No"}</span>
      <b>Registered</b><span>${fmtDate(u.createdAt)}</span>
    </div>
    <b style="font-size:13px">MODULES (${u.modulesCompleted}/${u.totalModules})</b><div style="font-size:13px;margin:6px 0 12px">${mods}</div>
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
