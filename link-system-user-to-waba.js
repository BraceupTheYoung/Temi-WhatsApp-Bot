// Resolves the System-User ↔ WABA permissions loop:
//
//   Error #10 "Viewer cannot access the Paid Message Account"
//     → the System User is not assigned to the WABA.
//   Error #100 "Param user does not accept global user IDs"
//     → POST .../assigned_users needs the BUSINESS-SCOPED user ID
//       (from GET /{WABA_ID}/system_users), not the Global ID copied
//       from Business Settings.
//
// Usage (tokens passed via env, never hardcoded):
//
//   ADMIN_TOKEN='<business-admin-user-or-admin-system-user-token>' \
//   SYS_TOKEN='<system-user-permanent-token>' \
//   WABA_ID=1853127755570545 PHONE_ID=1359048810625942 \
//   TEST_TO=2348012345678 BUSINESS_ID='<optional-business-manager-id>' \
//   node link-system-user-to-waba.js
//
// ADMIN_TOKEN must belong to a Business Admin (a business-admin user token,
// or an admin System User token that ALREADY has WABA access). The System
// User's own token cannot grant itself access — that is why Error #10 and
// the failed self-fix happen.
// SYS_TOKEN needs whatsapp_business_messaging (+ _management) scopes.
// TEST_TO is only used for the final hello_world probe (E.164, no '+').
const GRAPH = "https://graph.facebook.com/v22.0";
const WABA_ID = process.env.WABA_ID || "";
const PHONE_ID = process.env.PHONE_ID || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const SYS_TOKEN = process.env.SYS_TOKEN || "";
const TEST_TO = process.env.TEST_TO || "";
let BUSINESS_ID = process.env.BUSINESS_ID || "";

const api = async (method, path, token, params) => {
  let url = `${GRAPH}${path}`;
  let body;
  if (params) {
    // Docs use form/query encoding for assigned_users (tasks as ['MANAGE']).
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      form.append(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
    }
    if (method === "GET") url += (path.includes("?") ? "&" : "?") + form.toString();
    else body = form;
  }
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && !data.error, data };
};

const fail = (msg) => {
  console.error(`❌ ${msg}`);
  process.exitCode = 1;
};

(async () => {
  if (!WABA_ID || !ADMIN_TOKEN || !SYS_TOKEN) {
    console.error("❌ Set WABA_ID, ADMIN_TOKEN and SYS_TOKEN env vars (see header).");
    process.exit(2);
  }

  // Step 1 — Resolve the usable (business-scoped / app-scoped) ID.
  // GET /me with the System User's own token returns its ID in token context,
  // which is the form .../assigned_users accepts.
  console.log("① GET /me with SYS_TOKEN (resolves usable user ID)");
  const me = await api("GET", "/me?fields=id,name", SYS_TOKEN);
  console.log(`   → HTTP ${me.status}:`, JSON.stringify(me.data).slice(0, 200));
  const meId = me.data?.id || "";
  if (meId) console.log(`   usable ID for 'user' param: ${meId}`);

  // Step 1b — Canonical source per Meta docs: system user IDs returned from
  // GET /{WABA_ID}/system_users (called with the ADMIN token).
  console.log(`\n② GET /${WABA_ID}/system_users with ADMIN_TOKEN`);
  const su = await api("GET", `/${WABA_ID}/system_users`, ADMIN_TOKEN);
  console.log(`   → HTTP ${su.status}:`, JSON.stringify(su.data).slice(0, 500));
  const candidates = (su.data?.data || []).map((u) => `${u.name || "?"}:${u.id}`);
  if (candidates.length) console.log(`   business-scoped system users: ${candidates.join(", ")}`);

  // Prefer the canonical ID; fall back to /me result.
  const targetName = (process.env.SYS_USER_NAME || "").toLowerCase();
  let userId = "";
  if (targetName) {
    const hit = (su.data?.data || []).find((u) => String(u.name || "").toLowerCase().includes(targetName));
    if (hit) userId = hit.id;
  }
  if (!userId && su.data?.data?.length === 1) userId = su.data.data[0].id;
  if (!userId) userId = meId;
  if (!userId) return fail("Could not resolve a usable user ID. Pass SYS_USER_NAME to disambiguate, or add BUSINESS_ID.");
  console.log(`\n→ Using user=${userId} for the assignment call.`);

  // Step 2 — Assign (admin token calls, NOT the system user's own token).
  console.log(`\n③ POST /${WABA_ID}/assigned_users {user, tasks:[MANAGE]}`);
  const assign = await api("POST", `/${WABA_ID}/assigned_users`, ADMIN_TOKEN, {
    user: userId,
    tasks: ["MANAGE"],
  });
  console.log(`   → HTTP ${assign.status}:`, JSON.stringify(assign.data).slice(0, 300));
  if (!assign.ok) {
    if (assign.data?.error?.code === 100) {
      return fail(`Still code 100: ${assign.data.error.message} — the 'user' value is still global-scoped. Use an ID from step ②.`);
    }
    return fail(`Assignment failed: ${assign.data?.error?.message || "unknown"}`);
  }
  console.log("   ✅ assigned_users success.");

  // Step 3 — Verify (needs the owning Business ID; discoverable via /me/businesses).
  if (!BUSINESS_ID) {
    const b = await api("GET", "/me/businesses?fields=id,name", ADMIN_TOKEN);
    BUSINESS_ID = b.data?.data?.[0]?.id || "";
    if (BUSINESS_ID) console.log(`\n   discovered BUSINESS_ID=${BUSINESS_ID} (${b.data?.data?.[0]?.name || "?"})`);
  }
  if (BUSINESS_ID) {
    console.log(`\n④ GET /${WABA_ID}/assigned_users?business=${BUSINESS_ID}`);
    const list = await api("GET", `/${WABA_ID}/assigned_users`, ADMIN_TOKEN, { business: BUSINESS_ID });
    console.log(`   → HTTP ${list.status}:`, JSON.stringify(list.data).slice(0, 500));
    if ((list.data?.data || []).some((u) => String(u.id) === String(userId))) {
      console.log("   ✅ System User is now assigned to the WABA.");
    }
  } else {
    console.log("\n④ SKIPPED verification list (no BUSINESS_ID) — proceed to probe send.");
  }

  // Step 4 — Probe: hello_world via the System User's permanent token.
  if (PHONE_ID && TEST_TO) {
    console.log(`\n⑤ POST /${PHONE_ID}/messages (hello_world → ${TEST_TO})`);
    const res = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SYS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: TEST_TO,
        type: "template",
        template: { name: "hello_world", language: { code: "en_US" } },
      }),
    });
    const data = await res.json().catch(() => ({}));
    console.log(`   → HTTP ${res.status}:`, JSON.stringify(data).slice(0, 300));
    if (res.ok && !data.error) console.log("   ✅ hello_world accepted by Meta — loop resolved.");
    else fail(`Probe failed: ${data?.error?.message || "unknown"}`);
  } else {
    console.log("\n⑤ SKIPPED probe send (set PHONE_ID + TEST_TO to test).");
  }
})().catch((e) => {
  console.error("❌ script failed:", e?.message || e);
  process.exitCode = 1;
});
