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

// Pre-seed partial registration records so the email-step tests can jump
// straight to the email prompt (terms agreed + name already on file).
fs.writeFileSync(path.join(sandbox, "users_db.json"), JSON.stringify({
  "555000000001": { createdAt: Date.now(), progress: {}, agreedToTerms: true, fullName: "Email Tester One" },
  "555000000002": { createdAt: Date.now(), progress: {}, agreedToTerms: true, fullName: "Email Tester Two" },
  "555000000030": {
    createdAt: Date.now(), progress: {}, agreedToTerms: true, fullName: "Menu Tester",
    language: "English", jobRole: "Teacher",
  },
}, null, 2));

process.env.META_PHONE_ID = "1234567890";
process.env.META_ACCESS_TOKEN = "test-token";
process.env.META_VERIFY_TOKEN = "test-verify-secret";
process.env.BOT_PORT = "3999";

const graphCalls = [];
let failNextInteractive = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("graph.facebook.com")) {
    let body = null;
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
    graphCalls.push({ url: u, body, auth: (opts.headers || {}).Authorization });
    if (failNextInteractive && body && body.type === "interactive") {
      failNextInteractive = false;
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 100, error_subcode: 33, message: "simulated interactive failure" } }),
      };
    }
    if (u.endsWith("/media")) {
      return { ok: true, status: 200, json: async () => ({ id: "test-media-id" }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.test" }] }) };
  }
  return realFetch(url, opts);
};

const bot = require(path.join(__dirname, "teacher-bot.js"));

// Keep the fixture fast: pacing delays still run, but always at their minimum.
Math.random = () => 0;

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

  // 2) Payload-shape: interactive button reply -> id wins over title
  items = bot.extractInboundMessages({
    entry: [{ changes: [{ value: { messages: [{
      from: "2348012345678", id: "wamid.btn1", type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "terms_agree", title: "Yes, I agree" } },
    }] } }] }],
  });
  assert.strictEqual(items[0].body, "terms_agree");

  // 3) Payload-shape: interactive list reply -> id wins over title
  items = bot.extractInboundMessages({
    entry: [{ changes: [{ value: { messages: [{
      from: "2348012345678", id: "wamid.list1", type: "interactive",
      interactive: { type: "list_reply", list_reply: { id: "ai-tools", title: "AI Tools for Teachers" } },
    }] } }] }],
  });
  assert.strictEqual(items[0].body, "ai-tools");

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

  // ---------------------------------------------------------------------
  // Registration flow: email validation + terms agreement
  // ---------------------------------------------------------------------
  const readUsers = () => JSON.parse(fs.readFileSync(path.join(sandbox, "users_db.json"), "utf8"));
  const readOptedIn = () => JSON.parse(fs.readFileSync(path.join(sandbox, "opted_in_users.json"), "utf8"));
  const lastBodyTo = (id) => {
    const sends = graphCalls.filter((c) => c.body && c.body.to === id &&
      (c.body.type === "text" || c.body.type === "interactive"));
    if (!sends.length) return null;
    const b = sends[sends.length - 1].body;
    return b.type === "text" ? b.text.body : (b.interactive?.body?.text || null);
  };
  const lastInteractiveTo = (id) => {
    const sends = graphCalls.filter((c) => c.body && c.body.to === id && c.body.type === "interactive");
    return sends.length ? sends[sends.length - 1].body : null;
  };
  const interactiveSendsTo = (id) =>
    graphCalls.filter((c) => c.body && c.body.to === id && c.body.type === "interactive")
      .map((c) => c.body);
  let saySeq = 0;
  const say = (id, body, rawType = "text") =>
    bot.handleIncomingMessage({ from: id, body, rawType, id: `wamid.test-${id}-${++saySeq}` });
  const goEmail = (id) => {
    const st = bot.getUserState(id);
    st.stage = bot.STAGES.REGISTRATION;
    st.regField = "email_input";
    st.welcomeStep = null;
  };
  const goTerms = (id) => {
    const st = bot.getUserState(id);
    st.stage = bot.STAGES.WELCOME;
    st.welcomeStep = "await_terms";
    st.regField = null;
  };

  // 9) Email validation (unit): shape + allowlist.
  for (const e of ["name@gmail.com", "name@yahoo.com", " NAME@GMAIL.COM ", "a.b+tag@gmail.com"]) {
    assert.ok(bot.isValidEmail(e), `should accept ${JSON.stringify(e)}`);
  }
  for (const e of ["Fajekobj", "abc@", "@gmail.com", "gmail.com", "a@@gmail.com", "a@outlook.com", "name@gmail", "name @gmail.com"]) {
    assert.ok(!bot.isValidEmail(e), `should reject ${JSON.stringify(e)}`);
  }
  assert.strictEqual(bot.normalizeEmail(" NAME@GMAIL.COM "), "name@gmail.com");

  // 10) Terms: "1" and "Yes" agree -> full-name prompt; no opt-in write.
  for (const [id, reply] of [["555000000010", "1"], ["555000000011", "Yes!"]]) {
    goTerms(id);
    await say(id, reply);
    assert.strictEqual(bot.getUserState(id).stage, bot.STAGES.REGISTRATION, `${reply} should advance`);
    assert.strictEqual(bot.getUserState(id).regField, "fullName", `${reply} should ask for name`);
    assert.match(lastBodyTo(id) || "", /What is your full name\?/);
    const u = readUsers()[id];
    assert.ok(u && u.agreedToTerms === true, "terms agreement should be stored");
    assert.ok(!u.fullName, "name must not be stored yet");
    assert.ok(!readOptedIn().includes(id), "registration must not write opted_in_users.json");
  }

  // 11) Terms: "2" / "no" decline and "maybe" retry -> stay, store nothing.
  const decl = "555000000012";
  goTerms(decl);
  for (const reply of ["2", "no"]) {
    await say(decl, reply);
    assert.strictEqual(bot.getUserState(decl).welcomeStep, "await_terms");
    assert.match(lastBodyTo(decl) || "", /No problem\. You need to agree to the Terms and Conditions/);
    assert.ok(!(decl in readUsers()), "decline must not create a profile");
  }
  await say(decl, "maybe");
  assert.strictEqual(lastBodyTo(decl), "Please reply with 1 to agree or 2 to decline.");
  assert.strictEqual(bot.getUserState(decl).welcomeStep, "await_terms");
  assert.ok(!(decl in readUsers()), "invalid reply must not create a profile");

  // 12) Email step: invalid text/voice note -> retry and stay; valid -> advance.
  const mailA = "555000000001";
  goEmail(mailA);
  for (const bad of ["Fajekobj", "abc@", "@gmail.com", "a@outlook.com"]) {
    await say(mailA, bad);
    assert.strictEqual(lastBodyTo(mailA),
      "That doesn't look like a valid email. Please enter a Gmail or Yahoo address, for example name@gmail.com.");
    assert.strictEqual(bot.getUserState(mailA).regField, "email_input", `${bad} must not advance`);
    assert.ok(!readUsers()[mailA].email, `${bad} must not be saved`);
  }
  await say(mailA, "", "audio");
  assert.strictEqual(lastBodyTo(mailA),
    "That doesn't look like a valid email. Please enter a Gmail or Yahoo address, for example name@gmail.com.");
  assert.strictEqual(bot.getUserState(mailA).regField, "email_input");
  assert.ok(!readUsers()[mailA].email);

  await say(mailA, "  NAME@GMAIL.COM  ");
  assert.strictEqual(bot.getUserState(mailA).regField, "province");
  assert.strictEqual(readUsers()[mailA].email, "name@gmail.com");
  assert.match(lastBodyTo(mailA) || "", /Please enter your state/);

  const mailB = "555000000002";
  goEmail(mailB);
  await say(mailB, "teacher@yahoo.com");
  assert.strictEqual(bot.getUserState(mailB).regField, "province");
  assert.strictEqual(readUsers()[mailB].email, "teacher@yahoo.com");

  // 13) Full path: hello temi -> terms CTA + buttons -> 1 -> name -> email.
  const flow = "555000000020";
  await say(flow, "hello temi");
  assert.strictEqual(bot.getUserState(flow).welcomeStep, "await_ack");
  await say(flow, "ok");
  assert.strictEqual(bot.getUserState(flow).welcomeStep, "await_terms");
  assert.match(lastBodyTo(flow) || "", /Do you agree to our Terms and Conditions and Privacy Policy\?/);
  const termsUrl = (require(path.join(__dirname, "content-db.js"))
    .getRegistration().terms.prompt.match(/https?:\/\/\S+/) || [])[0];
  assert.ok(termsUrl, "terms URL exists in content");
  const flowTermsSends = interactiveSendsTo(flow);
  assert.strictEqual(flowTermsSends.length, 2, "terms step sends CTA then buttons");
  const flowCta = flowTermsSends[0];
  assert.strictEqual(flowCta.interactive.type, "cta_url");
  assert.match(flowCta.interactive.body.text, /Before we go any further/);
  assert.ok(!/https?:\/\//.test(flowCta.interactive.body.text), "CTA body must not contain a raw URL");
  assert.deepStrictEqual(flowCta.interactive.action, {
    name: "cta_url",
    parameters: { display_text: "Read Terms", url: termsUrl },
  });
  const flowTerms = flowTermsSends[1];
  assert.strictEqual(flowTerms.interactive.type, "button");
  assert.strictEqual(flowTerms.interactive.body.text,
    "Do you agree to our Terms and Conditions and Privacy Policy?");
  assert.deepStrictEqual(
    flowTerms?.interactive?.action?.buttons?.map((b) => b.reply.title),
    ["Yes, I agree", "No, I do not agree"]
  );
  await say(flow, "1");
  assert.strictEqual(bot.getUserState(flow).regField, "fullName");
  await say(flow, "Flow Teacher");
  assert.strictEqual(bot.getUserState(flow).regField, "email_input");
  assert.match(lastBodyTo(flow) || "", /Please enter your email address/);
  await say(flow, "not-an-email");
  assert.strictEqual(bot.getUserState(flow).regField, "email_input");
  assert.match(lastBodyTo(flow) || "", /That doesn't look like a valid email/);
  await say(flow, "flow@gmail.com");
  assert.strictEqual(bot.getUserState(flow).regField, "province");
  assert.strictEqual(readUsers()[flow].email, "flow@gmail.com");

  // ---------------------------------------------------------------------
  // Interactive messages (Group A): helpers, terms buttons, id guard
  // ---------------------------------------------------------------------

  // 14) Helper payload shapes + limits. Titles/descriptions truncate;
  //     oversized bodies/labels/row counts/button counts throw.
  const helperTo = "555000000098";
  await bot.sendButtonsTo(helperTo, {
    body: "Pick one",
    buttons: [
      { id: "a", title: "A".repeat(30) },
      { id: "b", title: "B" },
    ],
  });
  const buttonPayload = graphCalls[graphCalls.length - 1].body;
  assert.strictEqual(buttonPayload.type, "interactive");
  assert.strictEqual(buttonPayload.interactive.type, "button");
  assert.strictEqual(buttonPayload.interactive.body.text, "Pick one");
  assert.deepStrictEqual(buttonPayload.interactive.action.buttons, [
    { type: "reply", reply: { id: "a", title: "A".repeat(20) } },
    { type: "reply", reply: { id: "b", title: "B" } },
  ]);

  await bot.sendListTo(helperTo, {
    body: "Choose a course",
    buttonLabel: "Choose",
    sections: [{
      title: "Courses",
      rows: [{ id: "ai-tools", title: "T".repeat(30), description: "D".repeat(90) }],
    }],
  });
  const listPayload = graphCalls[graphCalls.length - 1].body;
  assert.strictEqual(listPayload.type, "interactive");
  assert.strictEqual(listPayload.interactive.type, "list");
  assert.strictEqual(listPayload.interactive.action.button, "Choose");
  const listRow = listPayload.interactive.action.sections[0].rows[0];
  assert.strictEqual(listRow.title.length, 24, "row title truncates to 24");
  assert.strictEqual(listRow.description.length, 72, "row description truncates to 72");

  await bot.sendCtaUrlTo(helperTo, {
    body: "Read the terms",
    displayText: "Read Terms",
    url: "https://example.com/terms",
  });
  const ctaPayload = graphCalls[graphCalls.length - 1].body;
  assert.deepStrictEqual(ctaPayload.interactive, {
    type: "cta_url",
    body: { text: "Read the terms" },
    action: {
      name: "cta_url",
      parameters: { display_text: "Read Terms", url: "https://example.com/terms" },
    },
  });

  await assert.rejects(
    () => bot.sendButtonsTo(helperTo, {
      body: "x".repeat(1025),
      buttons: [{ id: "a", title: "A" }],
    }),
    /1024/
  );
  await assert.rejects(
    () => bot.sendButtonsTo(helperTo, {
      body: "Pick",
      buttons: [1, 2, 3, 4].map((n) => ({ id: `b${n}`, title: `B${n}` })),
    }),
    /3-button/
  );
  await assert.rejects(
    () => bot.sendListTo(helperTo, {
      body: "Pick",
      buttonLabel: "Choose",
      sections: [{ rows: Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `R${i}` })) }],
    }),
    /10-row/
  );
  await assert.rejects(
    () => bot.sendListTo(helperTo, {
      body: "Pick",
      buttonLabel: "B".repeat(21),
      sections: [{ rows: [{ id: "a", title: "A" }] }],
    }),
    /20/
  );

  // 15) Terms buttons: interactive ids agree/decline; typed replies unchanged.
  const agreeTap = "555000000013";
  goTerms(agreeTap);
  await say(agreeTap, "terms_agree", "interactive");
  assert.strictEqual(bot.getUserState(agreeTap).regField, "fullName");
  assert.strictEqual(readUsers()[agreeTap].agreedToTerms, true);
  assert.match(lastBodyTo(agreeTap) || "", /What is your full name\?/);

  const declineTap = "555000000014";
  goTerms(declineTap);
  await say(declineTap, "terms_decline", "interactive");
  assert.strictEqual(bot.getUserState(declineTap).welcomeStep, "await_terms");
  assert.match(lastBodyTo(declineTap) || "", /No problem\. You need to agree to the Terms and Conditions/);
  assert.ok(!(declineTap in readUsers()), "decline tap must not create a profile");

  // Graph failure on the terms CTA falls back to the single numbered text
  // prompt (URL + options), and no buttons message is sent.
  const termsFallback = "555000000015";
  const termsState = bot.getUserState(termsFallback);
  termsState.stage = bot.STAGES.WELCOME;
  termsState.welcomeStep = "await_ack";
  termsState.regField = null;
  const fallbackStart = graphCalls.length;
  failNextInteractive = true;
  await say(termsFallback, "ok");
  assert.strictEqual(bot.getUserState(termsFallback).welcomeStep, "await_terms");
  const fallbackSends = graphCalls.slice(fallbackStart)
    .filter((c) => c.body && c.body.to === termsFallback);
  assert.strictEqual(fallbackSends.length, 2, "CTA attempt + text fallback only");
  assert.strictEqual(fallbackSends[0].body.interactive.type, "cta_url");
  assert.strictEqual(fallbackSends[1].body.type, "text");
  assert.match(lastBodyTo(termsFallback) || "", /https?:\/\//);
  assert.match(lastBodyTo(termsFallback) || "", /1\. Yes, I agree\n2\. No, I do not agree/);

  // 15b) Feedback CTA payload and its text fallback.
  const feedbackUrl = "https://docs.google.com/forms/d/e/1FAIpQLSdHsEaQ5hfFb0xscOIRSOS60hkn1tjnz7KCCnfFDlJo6LYMEg/viewform?usp=send_form";
  const feedbackTo = "555000000016";
  await bot.sendFeedbackPrompt({ from: feedbackTo });
  const feedbackCta = lastInteractiveTo(feedbackTo);
  assert.strictEqual(feedbackCta.interactive.type, "cta_url");
  assert.strictEqual(feedbackCta.interactive.action.parameters.display_text, "Give Feedback");
  assert.ok(feedbackCta.interactive.action.parameters.display_text.length <= 20);
  assert.strictEqual(feedbackCta.interactive.action.parameters.url, feedbackUrl);
  assert.match(feedbackCta.interactive.body.text, /how was your experience\?/);
  assert.match(feedbackCta.interactive.body.text, /Or type \*SKIP\* to skip\.$/);
  assert.ok(feedbackCta.interactive.body.text.length <= bot.LIMITS.BODY);

  const feedbackFallbackTo = "555000000017";
  failNextInteractive = true;
  await bot.sendFeedbackPrompt({ from: feedbackFallbackTo });
  const feedbackFallbackSends = graphCalls
    .filter((c) => c.body && c.body.to === feedbackFallbackTo);
  assert.strictEqual(feedbackFallbackSends.length, 2, "failed CTA attempt + text fallback");
  assert.strictEqual(feedbackFallbackSends[0].body.interactive.type, "cta_url");
  assert.strictEqual(feedbackFallbackSends[1].body.type, "text", "no CTA delivered on failure");
  assert.match(lastBodyTo(feedbackFallbackTo) || "", /https:\/\/docs\.google\.com\/forms/);
  assert.match(lastBodyTo(feedbackFallbackTo) || "", /SKIP/);

  // 16) Guard: unknown id, valid id at wrong stage, cold tap stays silent.
  const menuUser = "555000000030";
  const menuState = bot.getUserState(menuUser);
  menuState.stage = bot.STAGES.MAIN_MENU;

  await say(menuUser, "bogus", "interactive");
  assert.strictEqual(
    lastBodyTo(menuUser),
    "Sorry, I didn't recognise that option. Please choose one from the list or type your answer."
  );
  assert.strictEqual(bot.getUserState(menuUser).stage, bot.STAGES.MAIN_MENU);

  await say(menuUser, "quiz", "interactive");
  assert.strictEqual(
    lastBodyTo(menuUser),
    "That option has expired, please choose from the latest menu."
  );
  assert.strictEqual(bot.getUserState(menuUser).stage, bot.STAGES.MAIN_MENU);

  menuState.stage = bot.STAGES.AWAITING_FEEDBACK;
  await say(menuUser, "terms_agree", "interactive");
  assert.strictEqual(
    lastBodyTo(menuUser),
    "That option has expired, please choose from the latest menu."
  );
  assert.strictEqual(bot.getUserState(menuUser).stage, bot.STAGES.AWAITING_FEEDBACK);
  assert.ok(!readUsers()[menuUser].feedback, "wrong-stage tap must not store feedback");
  menuState.stage = bot.STAGES.MAIN_MENU;

  const coldTap = "555000000099";
  const coldSendsBefore = graphCalls.filter((c) => c.body && c.body.to === coldTap).length;
  await say(coldTap, "terms_agree", "interactive");
  assert.strictEqual(
    graphCalls.filter((c) => c.body && c.body.to === coldTap).length,
    coldSendsBefore,
    "cold interactive tap must not send anything"
  );
  assert.ok(!(coldTap in readUsers()), "cold tap must not create a profile");

  // ---------------------------------------------------------------------
  // Interactive messages (Group B): main menu, id taps, quiz intro
  // ---------------------------------------------------------------------

  // 17) Main menu: typed MENU sends 2 reply buttons (not a numbered list).
  menuState.stage = bot.STAGES.MAIN_MENU;
  await say(menuUser, "menu");
  const menuPayload = lastInteractiveTo(menuUser);
  assert.ok(menuPayload, "typed MENU should send an interactive menu");
  assert.strictEqual(menuPayload.interactive.type, "button");
  assert.strictEqual(
    menuPayload.interactive.body.text,
    "I'm *Témí* — Learn AI. Teach Better.\n\nWhat would you like to do?"
  );
  assert.deepStrictEqual(menuPayload.interactive.action.buttons, [
    { type: "reply", reply: { id: "ai-tools", title: "AI Tools Course" } },
    { type: "reply", reply: { id: "lesson-planning", title: "Lesson Planning" } },
    { type: "reply", reply: { id: "continue", title: "Continue" } },
  ]);

  // Tapping an option id maps back to the same handler as typing its number.
  await say(menuUser, "ai-tools", "interactive");
  assert.strictEqual(bot.getUserState(menuUser).stage, bot.STAGES.TOPIC_INTRO);
  assert.strictEqual(bot.getUserState(menuUser).currentTopic, "ai-tools");

  // 18) 4+ menu options switch to a list payload.
  await bot.sendMenuTo("555000000097", {
    intro: "Pick a track",
    options: [
      { id: "a", label: "Alpha", description: "First" },
      { id: "b", label: "Beta", description: "Second" },
      { id: "c", label: "Gamma", description: "Third" },
      { id: "d", label: "Delta", description: "Fourth" },
    ],
  });
  const menuListPayload = graphCalls[graphCalls.length - 1].body;
  assert.strictEqual(menuListPayload.interactive.type, "list");
  assert.strictEqual(menuListPayload.interactive.body.text, "Pick a track");
  assert.deepStrictEqual(
    menuListPayload.interactive.action.sections[0].rows.map((r) => r.id),
    ["a", "b", "c", "d"]
  );

  // 19) Quiz-intro slide sends two buttons and a clean "Ready?" body.
  const contentDB = require(path.join(__dirname, "content-db.js"));
  const module1 = contentDB.getTopic("ai-tools").modules[0];
  const quizIntro = module1.slides.find((s) => {
    const text = Array.isArray(s.text) ? s.text.join("\n") : String(s.text || "");
    return /Quiz, Teacher!/.test(text);
  });
  assert.ok(quizIntro, "ChatGPT quiz-intro slide exists");

  const quizUser = "555000000031";
  const quizState = bot.getUserState(quizUser);
  quizState.stage = bot.STAGES.LEARNING;
  quizState.currentTopic = "ai-tools";
  quizState.currentModule = module1;
  quizState.currentSlide = module1.slides.indexOf(quizIntro);
  await bot.sendSlide({ from: quizUser }, quizState, quizIntro);

  const quizPayload = lastInteractiveTo(quizUser);
  assert.ok(quizPayload, "quiz intro should send an interactive payload");
  assert.strictEqual(quizPayload.interactive.type, "button");
  assert.strictEqual(
    quizPayload.interactive.body.text,
    "🎯 Time for your ChatGPT Quiz, Teacher!\n\nYou have 7 questions to answer. Each question will appear one at a time with immediate feedback.\n\nReady for your quiz?"
  );
  assert.deepStrictEqual(quizPayload.interactive.action.buttons, [
    { type: "reply", reply: { id: "quiz", title: "Take The Quiz" } },
    { type: "reply", reply: { id: "menu", title: "Back To Main Menu" } },
  ]);

  // If the buttons send fails, the original slide text (with typed QUIZ/MENU
  // instructions) is delivered unchanged.
  failNextInteractive = true;
  await bot.sendSlide({ from: quizUser }, quizState, quizIntro);
  const quizTexts = graphCalls
    .filter((c) => c.body && c.body.to === quizUser && c.body.type === "text")
    .map((c) => c.body.text.body);
  const quizFallback = quizTexts[quizTexts.length - 1] || "";
  assert.match(quizFallback, /Reply \*QUIZ\* to start your quiz!/);
  assert.match(quizFallback, /Reply \*MENU\* to go back to the main menu\./);

  // 20) Typed QUIZ and MENU still work alongside the buttons.
  const typedUser = "555000000030";
  const typedState = bot.getUserState(typedUser);
  typedState.stage = bot.STAGES.LEARNING;
  typedState.currentTopic = "ai-tools";
  typedState.currentModule = module1;

  await say(typedUser, "quiz");
  assert.strictEqual(bot.getUserState(typedUser).stage, bot.STAGES.QUIZ);
  assert.match(lastBodyTo(typedUser) || "", /Question 1\//);

  typedState.stage = bot.STAGES.LEARNING;
  typedState.currentModule = module1;
  await say(typedUser, "menu");
  assert.strictEqual(bot.getUserState(typedUser).stage, bot.STAGES.MAIN_MENU);
  const typedMenuPayload = lastInteractiveTo(typedUser);
  assert.ok(typedMenuPayload, "typed MENU from learning should send the interactive menu");
  assert.strictEqual(typedMenuPayload.interactive.type, "button");

  // 21) Lesson-planning quiz answers match the committed fixture JSON.
  //     Each answer index must point at the exact source option TEXT.
  const quizFixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixture-lessonplanning-quiz-answers.json"), "utf8")
  );
  assert.strictEqual(quizFixture.length, 21, "fixture should cover all 21 questions");
  const lpMod1 = contentDB.getTopic("lesson-planning").modules[0];
  const lpMod2 = contentDB.getTopic("lesson-planning").modules[1];
  const lpMod3 = contentDB.getTopic("lesson-planning").modules[2];
  const lpModules = { m1: lpMod1, m2: lpMod2, m3: lpMod3 };
  for (const row of quizFixture) {
    const mod = lpModules[row.module];
    assert.ok(mod, `fixture module ${row.module} should exist`);
    const index = Number(row.question.replace(/^Q/, "")) - 1;
    const question = mod.questions[index];
    assert.ok(question, `${row.module} ${row.question} should exist`);
    assert.deepStrictEqual(question.options, row.options,
      `${row.module} ${row.question} options should match the source`);
    assert.strictEqual(question.answer, row.answer,
      `${row.module} ${row.question} answer index should match the fixture`);
    assert.strictEqual(question.options[question.answer - 1], row.options[row.answer - 1],
      `${row.module} ${row.question} answer should point at the source option text`);
  }

  server.close();
  console.log("✅ webhook fixture: all assertions passed");
  process.exit(0);
})().catch((e) => {
  console.error("❌ webhook fixture FAILED:", e);
  process.exit(1);
});
