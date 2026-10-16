// Webhook fixture test (mocked Graph API — no network, no Meta credentials).
// Run: npm test   (or: node test-webhook-fixture.js)
// Self-isolates: chdir to a temp sandbox BEFORE loading teacher-bot so the
// real users_db.json / opted_in_users.json are never touched.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "temi-webhook-test-"));
process.chdir(sandbox);

process.env.META_PHONE_ID = "1234567890";
process.env.META_ACCESS_TOKEN = "test-token";
process.env.META_VERIFY_TOKEN = "test-verify-secret";
process.env.BOT_PORT = "3999";

const graphCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("graph.facebook.com")) {
    let body = null;
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
    graphCalls.push({ url: u, body, auth: (opts.headers || {}).Authorization });
    if (u.endsWith("/media")) {
      return { ok: true, status: 200, json: async () => ({ id: "test-media-id" }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.test" }] }) };
  }
  return realFetch(url, opts);
};

const bot = require(path.join(__dirname, "teacher-bot.js"));

const textPayload = (from, bodyText, id = "wamid.text1") => ({
  entry: [{
    changes: [{
      value: {
        messages: [{ from, id, timestamp: "1760486400", type: "text", text: { body: bodyText } }],
      },
    }],
  }],
});

(async () => {
  // 1) Payload-shape: text extraction
  let items = bot.extractInboundMessages(textPayload("2348012345678", "hello temi"));
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].from, "2348012345678");
  assert.strictEqual(items[0].body, "hello temi");

  // 2) Payload-shape: interactive button reply -> text
  items = bot.extractInboundMessages({
    entry: [{ changes: [{ value: { messages: [{
      from: "2348012345678", id: "wamid.btn1", type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "1", title: "Yes" } },
    }] } }] }],
  });
  assert.strictEqual(items[0].body, "Yes");

  // 3) Payload-shape: interactive list reply -> text
  items = bot.extractInboundMessages({
    entry: [{ changes: [{ value: { messages: [{
      from: "2348012345678", id: "wamid.list1", type: "interactive",
      interactive: { type: "list_reply", list_reply: { id: "row2", title: "Magic School AI" } },
    }] } }] }],
  });
  assert.strictEqual(items[0].body, "Magic School AI");

  // 4) Payload-shape: status-only receipt -> no inbound
  items = bot.extractInboundMessages({
    entry: [{ changes: [{ value: { statuses: [{ id: "wamid.x", status: "delivered" }] } }] }],
  });
  assert.strictEqual(items.length, 0);

  // 5) Verify handshake: correct token -> challenge, wrong token -> 403
  const app = bot.createWebhookApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ port, path: p }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    }).on("error", reject);
  });
  const ok = await get("/webhook?hub.mode=subscribe&hub.verify_token=test-verify-secret&hub.challenge=CHALLENGE123");
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body, "CHALLENGE123");
  const bad = await get("/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHALLENGE123");
  assert.strictEqual(bad.status, 403);

  // 6) Full roundtrip: "hello temi" from a cold user -> welcome image+caption
  //    via upload-for-ID (POST /media) then image send (POST /messages).
  const post = (payload) => new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ port, path: "/webhook", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
  const status = await post(textPayload("2348099999999", "hello temi", "wamid.e2e1"));
  assert.strictEqual(status, 200);

  // Welcome image send uses "chunk" pacing (2-4s) — poll for the Graph call.
  const deadline = Date.now() + 15000;
  let imageSend = null;
  while (Date.now() < deadline) {
    imageSend = graphCalls.find((c) => c.body && c.body.type === "image");
    if (imageSend) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(imageSend, "expected an image send via Graph API");
  assert.strictEqual(imageSend.body.messaging_product, "whatsapp");
  assert.strictEqual(imageSend.body.to, "2348099999999");
  assert.strictEqual(imageSend.body.image.id, "test-media-id");
  assert.ok((imageSend.body.image.caption || "").includes("Welcome"),
    "welcome caption should travel with the image");
  const upload = graphCalls.find((c) => c.url.endsWith("/media"));
  assert.ok(upload, "expected an upload-for-ID call (POST /media)");
  assert.strictEqual(imageSend.auth, "Bearer test-token");

  // 7) Dedupe: same Meta message ID retried -> handled once (no 2nd send chain).
  const sendsBefore = graphCalls.filter((c) => c.body && c.body.type === "image").length;
  await post(textPayload("2348099999999", "hello temi", "wamid.e2e1")); // same id
  await new Promise((r) => setTimeout(r, 1000));
  const sendsAfter = graphCalls.filter((c) => c.body && c.body.type === "image").length;
  assert.strictEqual(sendsAfter, sendsBefore, "duplicate delivery must not re-send");

  // 8) Trigger normalization: punctuation/emoji/whitespace variants match,
  //    bare words and extra-word sentences do not.
  const triggerYes = ["hello temi", "Hello Temi", "hello temi!", "Hello, Temi", "hello temi 🙏", "  HELLO   TEMI  "];
  const triggerNo = ["hello", "temi", "hello temi please explain AI", "", "hello tem", "hi"];
  for (const t of triggerYes) assert.ok(bot.isTriggerPhrase(t), `should match trigger: ${JSON.stringify(t)}`);
  for (const t of triggerNo) assert.ok(!bot.isTriggerPhrase(t), `should NOT match trigger: ${JSON.stringify(t)}`);

  server.close();
  console.log("✅ webhook fixture: all assertions passed");
  process.exit(0);
})().catch((e) => {
  console.error("❌ webhook fixture FAILED:", e);
  process.exit(1);
});
