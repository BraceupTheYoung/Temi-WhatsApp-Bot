// Verifies the two most common "double ticks but no webhook" misconfigs.
// Run on EC2 (or locally) with the SAME credentials as the bot:
//
//   WABA_ID=123456789 META_ACCESS_TOKEN=<system-user-or-admin-token> \
//   META_APP_ID=<app-id> META_APP_ACCESS_TOKEN=<app-id|app-secret> \
//   node verify-meta-webhook.js
//
// Where to find each value:
//   WABA_ID ......... Meta App Dashboard → WhatsApp → API Setup → "WhatsApp Business Account ID"
//                     (NOT the phone-number ID — that is META_PHONE_ID in .env)
//   META_APP_ID ..... Meta App Dashboard → App settings → Basic → App ID
//   META_APP_ACCESS_TOKEN ... "<APP_ID>|<APP_SECRET>" (App Secret from Basic settings),
//                     or a token with apps_manage_metadata. The App Secret itself is
//                     never sent — only the pipe-joined app access token.
//   META_ACCESS_TOKEN  a System User token (or admin user token) with
//                     whatsapp_business_messaging + whatsapp_business_management.
//
// Graph version pinned to v22.0 to match teacher-bot.js META_GRAPH_VERSION.
require("dotenv").config();

const GRAPH = "https://graph.facebook.com/v22.0";
const WABA_ID = process.env.WABA_ID || "";
const USER_TOKEN = process.env.META_ACCESS_TOKEN || "";
const APP_ID = process.env.META_APP_ID || "";
const APP_TOKEN = process.env.META_APP_ACCESS_TOKEN || "";

const get = async (path, token) => {
  const res = await fetch(`${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
};

(async () => {
  let failures = 0;
  if (!WABA_ID || !USER_TOKEN) {
    console.error("❌ Set WABA_ID and META_ACCESS_TOKEN env vars. See header comments for where to find them.");
    process.exit(2);
  }

  // 1) WABA exists + token can read it
  console.log(`\n① GET /${WABA_ID}?fields=id,name`);
  const waba = await get(`/${WABA_ID}?fields=id,name`, USER_TOKEN);
  console.log(`   → HTTP ${waba.status}:`, JSON.stringify(waba.data).slice(0, 300));
  if (!waba.ok) {
    console.error("   ❌ Cannot read WABA — wrong WABA_ID or token lacks whatsapp_business_management.");
    failures++;
  } else {
    console.log(`   ✅ WABA readable: ${waba.data.name || waba.data.id}`);
  }

  // 2) Which apps are subscribed to this WABA?
  console.log(`\n② GET /${WABA_ID}/subscribed_apps`);
  const subs = await get(`/${WABA_ID}/subscribed_apps`, USER_TOKEN);
  console.log(`   → HTTP ${subs.status}:`, JSON.stringify(subs.data).slice(0, 500));
  const appIds = (subs.data?.data || []).map((a) => a.id);
  if (!subs.ok) {
    console.error("   ❌ subscribed_apps call failed — token needs whatsapp_business_management.");
    failures++;
  } else if (APP_ID && !appIds.includes(APP_ID)) {
    console.error(`   ❌ App ${APP_ID} is NOT subscribed to this WABA. Fix: Dashboard → WhatsApp → API Setup → add app, or POST /${WABA_ID}/subscribed_apps.`);
    failures++;
  } else if (appIds.length) {
    console.log(`   ✅ Subscribed app(s): ${appIds.join(", ")}`);
  } else {
    console.error("   ❌ No apps subscribed to this WABA — inbound messages have nowhere to go (double ticks, no webhook).");
    failures++;
  }

  // 3) Is the `messages` webhook field actually subscribed? (Verifying the
  //    Callback URL alone is NOT enough — this is the step most people skip.)
  if (APP_ID && APP_TOKEN) {
    console.log(`\n③ GET /${APP_ID}/subscriptions (needs app access token)`);
    const s = await get(`/${APP_ID}/subscriptions`, APP_TOKEN);
    console.log(`   → HTTP ${s.status}:`, JSON.stringify(s.data).slice(0, 800));
    const waSub = (s.data?.data || []).find((d) =>
      /whatsapp/i.test(d.object || "")
    );
    if (!s.ok) {
      console.error("   ❌ Cannot read subscriptions — META_APP_ACCESS_TOKEN should be '<APP_ID>|<APP_SECRET>'.");
      failures++;
    } else if (!waSub) {
      console.error("   ❌ No whatsapp subscription object found. Fix: Dashboard → App → Webhooks → WhatsApp Business Account → Subscribe.");
      failures++;
    } else if (!(waSub.fields || []).some((f) => String(f.name || f).toLowerCase() === "messages")) {
      console.error(`   ❌ whatsapp subscription exists but 'messages' field missing (has: ${JSON.stringify(waSub.fields)}). Fix: Edit Subscription → tick 'messages' → Save.`);
      failures++;
    } else {
      console.log("   ✅ 'messages' field is subscribed — Meta will POST inbound messages to your Callback URL.");
    }
  } else {
    console.log("\n③ SKIPPED — set META_APP_ID + META_APP_ACCESS_TOKEN to check the 'messages' field subscription.");
    console.log("   curl equivalent:");
    console.log(`   curl -s "${GRAPH}/${APP_ID || "{APP_ID}"}/subscriptions?access_token=${APP_TOKEN ? "<hidden>" : "{APP_ID}|{APP_SECRET}"}"`);
  }

  console.log(failures ? `\n❌ ${failures} problem(s) found — fix above, then re-run.` : "\n✅ All checks passed — if webhooks still don't arrive, the tunnel URL is stale (see tunnel check commands).");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("❌ script failed:", e?.message || e);
  process.exit(1);
});
