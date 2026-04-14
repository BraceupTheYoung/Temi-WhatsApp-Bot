const express = require("express");
const path = require("path");

let onRegistrationComplete = null; // Callback set by teacher-bot.js

function createRegistrationServer(port = 3000) {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // Serve the registration form
  app.get("/register/:userId", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "register.html"));
  });

  // Handle form submission
  app.post("/register/:userId", async (req, res) => {
    try {
      const userId = decodeURIComponent(req.params.userId);
      const formData = req.body;

      // Validate required fields
      const required = ["firstName", "lastName", "gender", "age", "province", "community", "language", "jobRole"];
      const missing = required.filter(f => !formData[f]);

      if (missing.length > 0) {
        return res.status(400).json({
          message: `Missing required fields: ${missing.join(", ")}`
        });
      }

      // Call the registration callback
      if (onRegistrationComplete) {
        await onRegistrationComplete(userId, formData);
      }

      res.json({ success: true, message: "Registration complete!" });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ message: "Server error. Please try again." });
    }
  });

  const server = app.listen(port, () => {
    console.log(`📋 Registration form server running on port ${port}`);
  });

  return server;
}

function setRegistrationCallback(callback) {
  onRegistrationComplete = callback;
}

module.exports = { createRegistrationServer, setRegistrationCallback };
