# Témí — AI for Teachers (WhatsApp bot)

Témí is a WhatsApp training bot for teachers, run by the Brace Up The Young Foundation. It delivers two self-paced courses, quizzes, and in-chat PDF certificates. Outbound messaging uses the **official Meta WhatsApp Cloud API** (Graph API); inbound messages arrive through a webhook. There is no browser / whatsapp-web.js session.

## Features

- Onboarding: welcome, Terms & Conditions, name, email, state, country, community, gender, age and language.
- Two courses: **AI Tools for Teachers** (ChatGPT, Magic School AI, Edu Aide) and **Using AI to Write Lesson Plans & Notes** (3 modules).
- Slides with optional audio, per-module quizzes with feedback and pass marks, progress resume (`CONTINUE`), and skip/retake handling.
- Automatic certificate generation (PDF) delivered in chat after name confirmation.
- Feedback prompt with Google Form link and in-chat feedback capture.
- Admin dashboard with registration stats, user search and CSV export.
- Dedupe of retried webhook deliveries, per-user and global serial send queues, and pacing tuned to avoid Meta error `131056`.

## Requirements

- Node.js 22 (see `Dockerfile`) and npm.
- A Meta Business app with WhatsApp Cloud API access: phone number ID, access token, verify token, and a public HTTPS webhook URL.

## Setup

```bash
npm install
cp .env.example .env      # fill in the values described below
```

Configure the webhook in Meta dashboard → WhatsApp → Configuration:

- Callback URL: `https://your-domain:3001/webhook`
- Verify token: the same string as `META_VERIFY_TOKEN`
- Subscribe to the `messages` field.
- Optionally set `META_APP_SECRET` to enable `X-Hub-Signature-256` validation on inbound POSTs.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `META_PHONE_ID` | Cloud API phone number ID (required) | — |
| `META_ACCESS_TOKEN` | Graph API bearer token (required) | — |
| `META_VERIFY_TOKEN` | Secret used for the webhook handshake | — |
| `META_APP_SECRET` | Enables webhook signature validation when set | — |
| `META_GRAPH_VERSION` | Graph API version | `v22.0` |
| `BOT_PORT` | Webhook / health HTTP port | `3001` |
| `ADMIN_ENABLED` | Set to `0` to disable the admin dashboard | `1` |
| `PORT` | Admin dashboard port (bound to `127.0.0.1`) | `3000` |
| `ADMIN_USER`, `ADMIN_PASS_HASH` | Dashboard login. Generate hash with `npm run admin:hash -- "your-password"` | — |
| `SESSION_SECRET` | Long random string for admin sessions | — |
| `NODE_ENV` | `production` sets secure admin cookies | — |

`OPENAI_API_KEY` and `ADMIN_NUMBER` in `.env.example` are legacy placeholders; the bot core does not use them.

## Run

```bash
npm start          # starts webhook server (+ admin dashboard unless disabled)
npm run admin      # admin dashboard only (useful for local inspection)
```

Endpoints:

- `GET /health` — health check (reports whether Meta credentials are configured).
- `GET /webhook` — Meta verification handshake.
- `POST /webhook` — inbound messages; returns 200 immediately, handling is async.
- `http://localhost:3000/admin` — dashboard (localhost only; reach it over SSH tunnel: `ssh -L 3000:localhost:3000 <host>`).

Docker:

```bash
docker build -t temi-bot .
docker run --env-file .env -p 3001:3001 temi-bot
```

## Content

- `content-db.js` registers topics, registration prompts, menus and completion copy.
- Each `content/*.js` module exports `{ id, title, slides: [...], questions: [...] }`. A slide has `text` (array of bubbles), optional `audio`, `delivery` (`text` | `audio` | `both`) and optional `media`.
- Media assets live in `media/` (`welcome.jpeg`, `tools list  intro.jpeg`, `*-step*.mp3`, `module*-complete.jpeg`, `certificate-template.pdf`). Missing media falls back to text where possible.
- `certificate.js` renders the PDF from `media/certificate-template.pdf`; generated files are written to `certificates/`.
- Registration state lives in `users_db.json` and `opted_in_users.json` (back these up before deployments).

## Tests

```bash
npm test
```

This runs the syntax check plus `test-webhook-fixture.js`, which mocks the Graph API and exercises onboarding, registration, terms, menus, quiz batching, certificate/feedback merging, and the webhook routes without touching real user data or requiring credentials.

## Messaging cost and pacing

Outbound sends go through a global serial queue. Delays: **0.5–1 s** for a new reply and **1.2–1.5 s** between bubbles of the same logical message (constants at the top of `teacher-bot.js`). The spacing keeps per-recipient bursts below Meta's rate limit while feeling responsive on the Cloud API.

Messages are batched aggressively: quiz feedback + next question, final quiz feedback + completion card, Terms link + buttons, certificate hints + feedback prompt, and acknowledgements + main menu each travel in one payload. An instrumented full journey (both courses, all quizzes passed, two certificates) sends **~152 billable service messages**, about **$1.02 per teacher** at Meta's Nigeria service rate of **$0.0067/message** (effective 1 Oct 2026; rates change, verify in the Meta dashboard). Each phone number gets 1,000 free service messages per month, so the first few teachers per month are free.

## License

ISC
