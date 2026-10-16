// Admin dashboard server — runs on the SAME EC2 process as the bot.
// Password login (session cookie) + read-only JSON API over live store.js data.
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const path = require("path");

const store = require("./store");

function isConfigured() {
  return !!(process.env.ADMIN_USER && (process.env.ADMIN_PASS_HASH || process.env.ADMIN_PASS));
}

async function verifyPassword(input) {
  if (process.env.ADMIN_PASS_HASH) {
    try {
      return await bcrypt.compare(String(input || ""), process.env.ADMIN_PASS_HASH);
    } catch {
      return false;
    }
  }
  // Plaintext fallback for first boot — logs a warning, admin should hash it.
  return String(input || "") === String(process.env.ADMIN_PASS || "");
}

function createAdminApp() {
  const app = express();

  app.set("trust proxy", 1); // correct IPs behind Nginx/Caddy on EC2
  app.use(helmet({ contentSecurityPolicy: false })); // no build-step CDN breakage
  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(path.join(__dirname, "public"), { index: false }));

  const secret = process.env.SESSION_SECRET;
  if (!secret) console.warn("⚠️ SESSION_SECRET not set — using ephemeral secret (sessions reset on restart).");
  app.use(
    session({
      name: "temi_admin",
      secret: secret || "dev-only-ephemeral-secret-change-me",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production", // HTTPS on EC2
        maxAge: 12 * 60 * 60 * 1000, // 12h
      },
    })
  );

  const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many login attempts. Try again in a minute." },
  });

  const requireAuth = (req, res, next) => {
    if (req.session && req.session.admin) return next();
    return res.status(401).json({ message: "Not authenticated." });
  };

  // Serve dashboard UI
  app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
  });

  app.get("/api/admin/status", (req, res) => {
    res.json({ configured: isConfigured(), loggedIn: !!(req.session && req.session.admin) });
  });

  app.post("/api/admin/login", loginLimiter, async (req, res) => {
    if (!isConfigured()) {
      return res.status(503).json({ message: "Dashboard not configured. Set ADMIN_USER + ADMIN_PASS_HASH on EC2." });
    }
    const { username, password } = req.body || {};
    const okUser = String(username || "") === String(process.env.ADMIN_USER);
    const okPass = await verifyPassword(password);
    if (okUser && okPass) {
      req.session.admin = true;
      req.session.username = process.env.ADMIN_USER;
      console.log(`🔑 Admin login OK user=${process.env.ADMIN_USER} ip=${req.ip} at=${new Date().toISOString()}`);
      return res.json({ success: true });
    }
    console.log(`🔑 Admin login FAIL user=${username} ip=${req.ip} at=${new Date().toISOString()}`);
    return res.status(401).json({ message: "Invalid username or password." });
  });

  app.post("/api/admin/logout", (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
  });

  app.get("/api/admin/me", requireAuth, (req, res) => {
    res.json({ username: req.session.username || "admin" });
  });

  app.get("/api/admin/stats", requireAuth, (req, res) => {
    try {
      res.json(store.getStats());
    } catch (e) {
      console.error("stats error:", e);
      res.status(500).json({ message: "Failed to load stats." });
    }
  });

  app.get("/api/admin/users", requireAuth, (req, res) => {
    try {
      res.json(store.searchUsers(req.query));
    } catch (e) {
      console.error("users error:", e);
      res.status(500).json({ message: "Failed to load users." });
    }
  });

  app.get("/api/admin/users/:id", requireAuth, (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id);
      const detail = store.getUserDetail(id);
      if (!detail) return res.status(404).json({ message: "User not found." });
      res.json(detail);
    } catch (e) {
      console.error("user detail error:", e);
      res.status(500).json({ message: "Failed to load user." });
    }
  });

  app.get("/api/admin/export.csv", requireAuth, (req, res) => {
    try {
      const { users } = store.searchUsers({ ...req.query, limit: 200, offset: 0 });
      // Export up to 5000 rows in pages (protects t3.small memory).
      let rows = users;
      if (String(req.query.all) === "1") {
        const out = [];
        for (let offset = 0; offset < 5000; offset += 200) {
          const page = store.searchUsers({ ...req.query, limit: 200, offset });
          out.push(...page.users);
          if (page.users.length < 200) break;
        }
        rows = out;
      }
      console.log(`📥 Admin CSV export rows=${rows.length} by=${req.session.username} ip=${req.ip}`);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="temi-users-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send("\uFEFF" + store.usersToCsv(rows)); // BOM for Excel
    } catch (e) {
      console.error("csv export error:", e);
      res.status(500).json({ message: "Failed to export CSV." });
    }
  });

  return app;
}

function startAdminServer(port) {
  const p = port || process.env.PORT || 3000;
  const app = createAdminApp();
  // Localhost-only: the dashboard must never be reachable from the public
  // internet. Reach it via SSH tunnel: ssh -L 3000:localhost:3000 <ec2-host>,
  // then open http://localhost:3000/admin (webhook server on 3001 is unaffected).
  const server = app.listen(p, "127.0.0.1", () => {
    console.log(`📊 Admin dashboard: http://localhost:${p}/admin`);
    if (!isConfigured()) {
      console.warn("⚠️ ADMIN_USER / ADMIN_PASS_HASH not set — /api/admin/* returns 503 until configured.");
      console.warn("   Generate hash: npm run admin:hash -- \"your-strong-password\"");
    }
    if (process.env.ADMIN_PASS && !process.env.ADMIN_PASS_HASH) {
      console.warn("⚠️ ADMIN_PASS plaintext in use — set ADMIN_PASS_HASH (bcrypt) and remove ADMIN_PASS.");
    }
  });
  return server;
}

module.exports = { createAdminApp, startAdminServer, isConfigured };
