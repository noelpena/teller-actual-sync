import dotenv from "dotenv";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import cors from "cors";
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import * as actual from "@actual-app/api";
import cron from "node-cron";
import multer from "multer";
import { runSync, loadConfig } from "./sync.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_ID = process.env.APP_ID;
const ENV = process.env.ENV || "sandbox";
const CERT = process.env.CERT;
const CERT_KEY = process.env.CERT_KEY;
const PORT = process.env.PORT || 8001;

if (!APP_ID) {
  console.error("Error: APP_ID is required");
  process.exit(1);
}
if (["development", "production"].includes(ENV) && (!CERT || !CERT_KEY)) {
  console.error(`Error: CERT and CERT_KEY are required when ENV=${ENV}`);
  process.exit(1);
}

const staticDir = path.join(__dirname, "static");
const certsDir = path.join(__dirname, "certs");

// Setup multer for file uploads
const upload = multer({
  dest: certsDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

// Ensure certs directory exists
if (!fs.existsSync(certsDir)) {
  fs.mkdirSync(certsDir, { recursive: true });
}

const app = express();
app.use(cors(), express.json({ limit: '50mb' }));

async function initActual() {
  await actual.init({
    dataDir: process.env.ACTUAL_DATA_DIR,
    serverURL: process.env.ACTUAL_SERVER_URL,
    password: process.env.ACTUAL_PASSWORD,
  });

  if (process.env.ACTUAL_SYNC_ID) {
    await actual.downloadBudget(process.env.ACTUAL_SYNC_ID);
  } else {
    await actual.downloadBudget();
  }
  console.log("✅ Connected to Actual Budget");
}

// Setup cron job for daily sync
function setupCronJob() {
  const config = loadConfig();
  const cronSchedule = config.sync?.cronSchedule || process.env.CRON_SCHEDULE || "0 2 * * *"; // Default: 2 AM daily
  
  console.log(`⏰ Scheduled sync job: ${cronSchedule}`);
  console.log(`📋 Using config from: ${fs.existsSync(path.join(__dirname, "config", "config.json")) ? "config.json + env vars" : "env vars only"}`);
  
  cron.schedule(cronSchedule, async () => {
    console.log("\n🔄 Running scheduled sync...");
    try {
      await runSync();
    } catch (error) {
      console.error("❌ Scheduled sync failed:", error);
    }
  });
}

app.use(
  "/api",
  createProxyMiddleware({
    target: "https://api.teller.io",
    changeOrigin: true,
    pathRewrite: { "^/api": "" },
    agent:
      CERT && CERT_KEY
        ? new https.Agent({
            cert: fs.readFileSync(CERT),
            key: fs.readFileSync(CERT_KEY),
          })
        : undefined,
    onProxyReq: (proxyReq, req) => {
      const rawAuth = req.headers["authorization"];
      if (rawAuth) {
        const token = rawAuth.trim();
        const basic = Buffer.from(`${token}:`).toString("base64");
        proxyReq.setHeader("authorization", `Basic ${basic}`);
      }
    },
  })
);

app.get("/", (req, res) => {
  const htmlPath = path.join(staticDir, "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  html = html.replace("{{ app_id }}", APP_ID);
  html = html.replace("{{ environment }}", ENV);
  res.type("html").send(html);
});

app.get("/ping", (req, res) => {
  res.json({ message: "pong", timestamp: new Date().toISOString() });
});

// Manual sync trigger endpoint
app.post("/manual-sync", async (req, res) => {
  try {
    console.log("🔄 Manual sync triggered via API...");
    await runSync();
    res.json({ success: true, message: "Sync completed successfully" });
  } catch (error) {
    console.error("❌ Manual sync failed:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get sync logs
app.get("/sync-logs", (req, res) => {
  try {
    const logFile = path.join(__dirname, "logs", "sync.log");
    
    if (!fs.existsSync(logFile)) {
      return res.json({ logs: [] });
    }
    
    const logs = fs.readFileSync(logFile, "utf8")
      .split("\n")
      .filter(line => line.trim())
      .map(line => JSON.parse(line))
      .reverse()
      .slice(0, 50); // Last 50 logs
    
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy endpoint for manual UI-triggered imports
app.post("/import-transactions", async (req, res) => {
  try {
    const accountId = process.env.ACTUAL_ACCOUNT_ID || "d34d071e-6adf-425e-940b-d1c53e6de7dc";
    const rawTransactions = req.body;

    if (!rawTransactions || !Array.isArray(rawTransactions)) {
      return res.status(400).json({ error: "Missing or invalid 'transactions' array" });
    }

    const transactions = transformTransactions(rawTransactions);

    // Save backup
    const backupDir = path.join(__dirname, "transaction-data");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const currentDate = getCurrentDate();
    const filePath = path.join(backupDir, `transactions_${currentDate}.json`);
    fs.writeFileSync(filePath, JSON.stringify(transactions, null, 2));

    const result = await actual.importTransactions(accountId, transactions);

    res.json({
      message: "Transactions imported successfully",
      imported: result.added.length,
      updated: result.updated.length,
    });
  } catch (err) {
    console.error("❌ Error importing transactions:", err);
    res.status(500).json({ error: err.message });
  }
});

function transformTransactions(transactions) {
  return transactions.map(txn => {
    const amountInCents = Math.round(parseFloat(txn.amount) * 100);
    const payeeName = txn.details?.counterparty?.name || txn.description || "Unknown";
    const notes = txn.details?.category || "";
    
    return {
      date: txn.date,
      amount: amountInCents,
      payee_name: payeeName,
      notes: notes ? notes + " - Imported from Teller" : "Imported from Teller",
      cleared: txn.status === "posted"
    };
  });
}

function getCurrentDate() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Admin routes
app.get("/admin", (req, res) => {
  const adminPath = path.join(staticDir, "admin.html");
  if (!fs.existsSync(adminPath)) {
    return res.status(404).send("Admin page not found. Make sure admin.html exists in static/ folder.");
  }
  res.sendFile(adminPath);
});

// Certificate upload endpoint
app.post("/admin/api/certificates/upload", upload.fields([
  { name: 'certificate', maxCount: 1 },
  { name: 'privateKey', maxCount: 1 }
]), (req, res) => {
  try {
    const certPath = path.join(certsDir, "certificate.pem");
    const keyPath = path.join(certsDir, "private_key.pem");

    // Move uploaded files to proper locations with proper names
    if (req.files['certificate']) {
      const uploadedCert = req.files['certificate'][0];
      fs.renameSync(uploadedCert.path, certPath);
      console.log(`✓ Certificate uploaded: ${certPath}`);
    }

    if (req.files['privateKey']) {
      const uploadedKey = req.files['privateKey'][0];
      fs.renameSync(uploadedKey.path, keyPath);
      console.log(`✓ Private key uploaded: ${keyPath}`);
    }

    res.json({
      success: true,
      message: "Certificates uploaded successfully",
      certificatePath: req.files['certificate'] ? certPath : undefined,
      privateKeyPath: req.files['privateKey'] ? keyPath : undefined
    });
  } catch (error) {
    console.error("Error uploading certificates:", error);
    res.status(500).json({ error: error.message });
  }
});

// Check certificate status endpoint
app.get("/admin/api/certificates/status", (req, res) => {
  try {
    const certPath = path.join(certsDir, "certificate.pem");
    const keyPath = path.join(certsDir, "private_key.pem");

    res.json({
      certificateExists: fs.existsSync(certPath),
      keyExists: fs.existsSync(keyPath),
      certificatePath: certPath,
      privateKeyPath: keyPath
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/admin/api/config", (req, res) => {
  try {
    const config = loadConfig();
    // Return actual config values (mask sensitive data for display)
    const safeConfig = {
      APP_ID: process.env.APP_ID || "",
      ENV: config.teller?.env || process.env.ENV || "sandbox",
      TELLER_ACCESS_TOKEN: config.teller?.accessToken ? config.teller.accessToken.substring(0, 10) + "***" : "",
      TELLER_ACCOUNT_ID: config.teller?.accountId || "",
      ACTUAL_SERVER_URL: config.actual?.serverURL || "",
      ACTUAL_PASSWORD: config.actual?.password ? "***" : "",
      ACTUAL_SYNC_ID: config.actual?.syncId || "",
      ACTUAL_ACCOUNT_ID: config.actual?.accountId || "",
      DAYS_TO_SYNC: config.sync?.daysToSync || 7,
      CRON_SCHEDULE: config.sync?.cronSchedule || "0 8 * * *",
    };
    res.json(safeConfig);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/admin/api/config", (req, res) => {
  try {
    const configDir = path.join(__dirname, "config");
    const configPath = path.join(configDir, "config.json");

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Load existing config to preserve sensitive fields if not provided
    let existingConfig = {};
    if (fs.existsSync(configPath)) {
      try {
        existingConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch (e) {
        console.warn("Could not parse existing config, creating new one");
      }
    }

    // Check if certificates exist to auto-configure paths
    const certPath = path.join(certsDir, "certificate.pem");
    const keyPath = path.join(certsDir, "private_key.pem");
    const certsExist = fs.existsSync(certPath) && fs.existsSync(keyPath);

    const newConfig = {
      teller: {
        accessToken: req.body.TELLER_ACCESS_TOKEN || existingConfig.teller?.accessToken,
        accountId: req.body.TELLER_ACCOUNT_ID,
        env: req.body.ENV || existingConfig.teller?.env,
        // Auto-set certificate paths if certificates exist, otherwise preserve existing
        certPath: certsExist ? certPath : existingConfig.teller?.certPath,
        certKeyPath: certsExist ? keyPath : existingConfig.teller?.certKeyPath,
      },
      actual: {
        dataDir: process.env.ACTUAL_DATA_DIR || "/app/actual-data",
        serverURL: req.body.ACTUAL_SERVER_URL,
        password: req.body.ACTUAL_PASSWORD || existingConfig.actual?.password,
        syncId: req.body.ACTUAL_SYNC_ID,
        accountId: req.body.ACTUAL_ACCOUNT_ID,
      },
      sync: {
        daysToSync: parseInt(req.body.DAYS_TO_SYNC) || 7,
        cronSchedule: req.body.CRON_SCHEDULE || "0 2 * * *",
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));

    res.json({ success: true, message: "Configuration saved. Restart container to apply changes." });
  } catch (error) {
    console.error("Error saving config:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/admin/api/logs", (req, res) => {
  try {
    const logFile = path.join(__dirname, "logs", "sync.log");
    
    if (!fs.existsSync(logFile)) {
      return res.json({ logs: [] });
    }
    
    const logs = fs.readFileSync(logFile, "utf8")
      .split("\n")
      .filter(line => line.trim())
      .map(line => JSON.parse(line))
      .reverse()
      .slice(0, 50);
    
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use("/static", express.static(staticDir));

app.listen(PORT, async () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
  console.log(`   Environment: ${ENV}`);
  console.log(`   App ID: ${APP_ID}`);
  
  await initActual();
  
  // Setup automated sync
  setupCronJob();
  
  console.log("\n✨ Ready! Server is running with automated sync enabled.");
  console.log("📝 Manual sync: POST http://localhost:8001/manual-sync");
  console.log("📊 View logs: GET http://localhost:8001/sync-logs\n");
});