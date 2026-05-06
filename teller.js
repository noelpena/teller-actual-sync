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
import { runSync, runSyncForMapping, loadConfig, saveMappings, updateMappingState, newMappingId, persistLegacyMigrationIfNeeded } from "./sync.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load config early to get APP_ID
let config = {};
try {
  // One-shot: persist legacy → mappings migration so subsequent reads are stable
  try { persistLegacyMigrationIfNeeded(); } catch (e) { console.warn("Legacy migration skipped:", e?.message); }
  config = loadConfig();
} catch (e) {
  console.warn("⚠️  Could not load config.json, using env vars only");
}

const APP_ID = config.teller?.appId || process.env.APP_ID;
const ENV = config.teller?.env || config.teller?.environment || process.env.ENV || "sandbox";
const CERT = config.teller?.certPath || process.env.CERT;
const CERT_KEY = config.teller?.certKeyPath || process.env.CERT_KEY;
const PORT = process.env.PORT || 8001;

// APP_ID is not required at startup - will be checked when accessing /connect
if (["development", "production"].includes(ENV) && (!CERT || !CERT_KEY)) {
  console.warn(`⚠️  Warning: CERT and CERT_KEY should be configured when ENV=${ENV}`);
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

// Helper function to check configuration completeness
function checkConfigStatus() {
  const config = loadConfig();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Actual server-level config (shared across all mappings)
  const hasActualServerConfig = Boolean(
    config.actual?.serverURL &&
    config.actual?.password &&
    config.actual?.syncId &&
    !config.actual.serverURL.includes('your-actual-server') &&
    !config.actual.password.includes('your_actual_password') &&
    config.actual.syncId.match(UUID_RE)
  );

  // At least one fully-formed mapping
  const validMappings = (config.mappings || []).filter(m =>
    m.tellerAccessToken && m.tellerAccessToken.startsWith('token_') &&
    m.tellerAccountId && m.tellerAccountId.startsWith('acc_') &&
    m.actualAccountId && UUID_RE.test(m.actualAccountId)
  );

  const hasTellerConfig = validMappings.length > 0;
  const hasActualConfig = hasActualServerConfig;

  return {
    hasTellerConfig,
    hasActualConfig,
    isComplete: hasTellerConfig && hasActualConfig,
    mappingCount: (config.mappings || []).length,
    validMappingCount: validMappings.length
  };
}

async function initActual() {
  // Load config to get Actual Budget settings
  const config = loadConfig();

  const dataDir = config.actual?.dataDir || process.env.ACTUAL_DATA_DIR || "/app/actual-data";
  const serverURL = config.actual?.serverURL || process.env.ACTUAL_SERVER_URL;
  const password = config.actual?.password || process.env.ACTUAL_PASSWORD;
  const syncId = config.actual?.syncId || process.env.ACTUAL_SYNC_ID;

  if (!serverURL || !password) {
    throw new Error("Actual Budget serverURL and password are required");
  }

  await actual.init({
    dataDir,
    serverURL,
    password,
  });

  // Only download budget if syncId is provided
  if (syncId) {
    await actual.downloadBudget(syncId);
    console.log("✅ Connected to Actual Budget and downloaded budget");
  } else {
    console.log("✅ Connected to Actual Budget (no budget downloaded - syncId not configured)");
  }
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

// ===== CUSTOM API ROUTES (must be defined BEFORE proxy middleware) =====

// Save App ID and certificates (combined endpoint for initial setup)
app.post("/api/setup/save-app-id-and-certs", upload.fields([
  { name: 'certificate', maxCount: 1 },
  { name: 'privateKey', maxCount: 1 }
]), (req, res) => {
  try {
    const { appId } = req.body;

    if (!appId) {
      return res.status(400).json({
        error: "App ID is required"
      });
    }

    const configDir = path.join(__dirname, "config");
    const configPath = path.join(configDir, "config.json");

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Handle certificate uploads
    const certPath = path.join(certsDir, "certificate.pem");
    const keyPath = path.join(certsDir, "private_key.pem");

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

    // Load existing config to preserve other sections
    let existingConfig = {};
    if (fs.existsSync(configPath)) {
      try {
        existingConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch (e) {
        console.warn("Could not parse existing config, creating new one");
      }
    }

    // Check if certificates were uploaded
    const certsExist = fs.existsSync(certPath) && fs.existsSync(keyPath);

    // Preserve the environment field name from existing config
    const envField = existingConfig.teller?.environment ? 'environment' : 'env';

    // Merge with existing config, ensuring all sections exist with placeholders
    const newConfig = {
      teller: {
        appId,
        accessToken: existingConfig.teller?.accessToken || "your_teller_access_token_here",
        accountId: existingConfig.teller?.accountId || "your_teller_account_id_here",
        [envField]: existingConfig.teller?.[envField] || "development",
        certPath: certsExist ? certPath : existingConfig.teller?.certPath || "",
        certKeyPath: certsExist ? keyPath : existingConfig.teller?.certKeyPath || "",
      },
      actual: existingConfig.actual || {
        dataDir: "/app/actual-data",
        serverURL: "http://your-actual-server:5006",
        password: "your_actual_password",
        syncId: "your_budget_sync_id",
        accountId: "your_actual_account_id_here"
      },
      sync: existingConfig.sync || {
        daysToSync: 7,
        cronSchedule: "0 8 * * *"
      }
    };

    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
    console.log("✅ App ID and certificates saved to config.json");

    res.json({
      success: true,
      message: "Configuration saved successfully"
    });
  } catch (error) {
    console.error("Error saving configuration:", error);
    res.status(500).json({ error: error.message });
  }
});

// Save App ID only (legacy endpoint, kept for backwards compatibility)
app.post("/api/setup/save-app-id", (req, res) => {
  try {
    const { appId } = req.body;

    if (!appId) {
      return res.status(400).json({
        error: "App ID is required"
      });
    }

    const configDir = path.join(__dirname, "config");
    const configPath = path.join(configDir, "config.json");

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Load existing config to preserve other sections
    let existingConfig = {};
    if (fs.existsSync(configPath)) {
      try {
        existingConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch (e) {
        console.warn("Could not parse existing config, creating new one");
      }
    }

    // Preserve the environment field name from existing config
    const envField = existingConfig.teller?.environment ? 'environment' : 'env';

    // Merge with existing config
    const newConfig = {
      ...existingConfig,
      teller: {
        ...existingConfig.teller,
        appId,
        [envField]: existingConfig.teller?.[envField] || "development"
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
    console.log("✅ App ID saved to config.json");

    res.json({
      success: true,
      message: "App ID saved successfully"
    });
  } catch (error) {
    console.error("Error saving App ID:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get config status endpoint
app.get("/api/config/status", (req, res) => {
  try {
    const status = checkConfigStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Account mappings API =====
// Each mapping = one Teller account paired with one Actual account.
// A token from a single Teller Connect flow can be reused across multiple mappings
// at the same institution.

app.get("/api/mappings", (req, res) => {
  try {
    const config = loadConfig();
    // Mask access tokens in response
    const safe = (config.mappings || []).map(m => ({
      id: m.id,
      name: m.name || "",
      tellerAccountId: m.tellerAccountId,
      actualAccountId: m.actualAccountId,
      tellerAccessTokenMasked: m.tellerAccessToken
        ? `${m.tellerAccessToken.substring(0, 10)}...`
        : null,
      disabled: !!m.disabled,
      needsReconnect: !!m.needsReconnect,
      pendingReconcile: !!m.pendingReconcile,
      lastSyncAt: m.lastSyncAt || null,
      lastSyncStatus: m.lastSyncStatus || null,
      lastSyncStats: m.lastSyncStats || null,
      lastError: m.lastError || null,
      lastReconcileAt: m.lastReconcileAt || null,
      lastReconcileDelta: m.lastReconcileDelta == null ? null : m.lastReconcileDelta,
    }));
    res.json({ mappings: safe });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Edit a mapping (name, actualAccountId, disabled). For tellerAccountId/token rotation,
// use the dedicated POST /api/mappings/rotate-token endpoint instead.
app.patch("/api/mappings/:id", (req, res) => {
  try {
    const id = req.params.id;
    const { name, actualAccountId, disabled } = req.body;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const config = loadConfig();
    const mappings = config.mappings.slice();
    const idx = mappings.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: "Mapping not found" });

    const patch = {};
    if (name !== undefined) patch.name = String(name);
    if (typeof disabled === "boolean") patch.disabled = disabled;
    if (actualAccountId !== undefined) {
      if (!UUID_RE.test(actualAccountId)) {
        return res.status(400).json({ error: "actualAccountId must be a UUID" });
      }
      patch.actualAccountId = actualAccountId;
    }

    mappings[idx] = { ...mappings[idx], ...patch };
    saveMappings(mappings);
    res.json({ success: true, mapping: { id: mappings[idx].id, ...patch } });
  } catch (error) {
    console.error("Error patching mapping:", error);
    res.status(500).json({ error: error.message });
  }
});

// Trigger reconcile on next sync (and immediately run it)
app.post("/api/mappings/:id/reconcile", async (req, res) => {
  try {
    updateMappingState(req.params.id, { pendingReconcile: true });
    const stats = await runSyncForMapping(req.params.id);
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error?.message || String(error),
    });
  }
});

// Trigger a sync for a single mapping
app.post("/api/mappings/:id/sync", async (req, res) => {
  try {
    const stats = await runSyncForMapping(req.params.id);
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error?.message || String(error),
      isAuth: error?.name === "TellerAuthError",
    });
  }
});

// Rotate the access token across all mappings for a given Teller account ID set.
// Used after re-running Teller Connect for a bank that was previously authorized:
// - body.newAccessToken: the freshly minted token
// - body.tellerAccountIds: list of acc_ ids that this token covers
// All existing mappings whose tellerAccountId is in that list get their token replaced
// and have needsReconnect cleared.
app.post("/api/mappings/rotate-token", (req, res) => {
  try {
    const { newAccessToken, tellerAccountIds } = req.body;
    if (!newAccessToken || !newAccessToken.startsWith("token_")) {
      return res.status(400).json({ error: "Missing/invalid newAccessToken" });
    }
    if (!Array.isArray(tellerAccountIds) || tellerAccountIds.length === 0) {
      return res.status(400).json({ error: "Missing tellerAccountIds[]" });
    }

    const config = loadConfig();
    const idSet = new Set(tellerAccountIds);
    let rotated = 0;
    const mappings = config.mappings.map(m => {
      if (idSet.has(m.tellerAccountId)) {
        rotated++;
        return { ...m, tellerAccessToken: newAccessToken, needsReconnect: false, lastError: null };
      }
      return m;
    });
    saveMappings(mappings);
    res.json({ success: true, rotated });
  } catch (error) {
    console.error("Error rotating token:", error);
    res.status(500).json({ error: error.message });
  }
});

// Create or update a mapping. If body.id is set and matches an existing mapping, update.
// Otherwise create a new one.
app.post("/api/mappings", (req, res) => {
  try {
    const { id, name, tellerAccessToken, tellerAccountId, actualAccountId, pendingReconcile } = req.body;

    if (!tellerAccessToken || !tellerAccountId || !actualAccountId) {
      return res.status(400).json({
        error: "Missing required fields: tellerAccessToken, tellerAccountId, actualAccountId"
      });
    }
    if (!tellerAccessToken.startsWith("token_")) {
      return res.status(400).json({ error: "tellerAccessToken must start with 'token_'" });
    }
    if (!tellerAccountId.startsWith("acc_")) {
      return res.status(400).json({ error: "tellerAccountId must start with 'acc_'" });
    }
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(actualAccountId)) {
      return res.status(400).json({ error: "actualAccountId must be a UUID" });
    }

    const config = loadConfig();
    const mappings = config.mappings.slice();

    if (id) {
      const idx = mappings.findIndex(m => m.id === id);
      if (idx === -1) return res.status(404).json({ error: "Mapping not found" });
      mappings[idx] = {
        ...mappings[idx],
        name: name || mappings[idx].name,
        tellerAccessToken,
        tellerAccountId,
        actualAccountId,
        ...(typeof pendingReconcile === "boolean" ? { pendingReconcile } : {}),
      };
    } else {
      // Prevent duplicate (same tellerAccountId + actualAccountId)
      const dup = mappings.find(m =>
        m.tellerAccountId === tellerAccountId && m.actualAccountId === actualAccountId
      );
      if (dup) {
        return res.status(409).json({ error: "Mapping already exists", id: dup.id });
      }
      mappings.push({
        id: newMappingId(),
        name: name || "Unnamed",
        tellerAccessToken,
        tellerAccountId,
        actualAccountId,
        pendingReconcile: !!pendingReconcile,
      });
    }

    saveMappings(mappings);
    res.json({ success: true, count: mappings.length });
  } catch (error) {
    console.error("Error saving mapping:", error);
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/mappings/:id", (req, res) => {
  try {
    const id = req.params.id;
    const config = loadConfig();
    const before = config.mappings.length;
    const mappings = config.mappings.filter(m => m.id !== id);
    if (mappings.length === before) {
      return res.status(404).json({ error: "Mapping not found" });
    }
    saveMappings(mappings);
    res.json({ success: true, removed: id, remaining: mappings.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save Teller credentials (called after Teller Connect completes)
app.post("/api/setup/save-teller", (req, res) => {
  try {
    const { accessToken, accountId, userId } = req.body;

    console.log("📥 Received Teller credentials:", {
      accessToken: accessToken ? `${accessToken.substring(0, 10)}...` : 'missing',
      accountId: accountId || 'missing',
      userId: userId || 'missing'
    });

    if (!accessToken || !accountId) {
      return res.status(400).json({
        error: "Missing required fields: accessToken and accountId"
      });
    }

    const configDir = path.join(__dirname, "config");
    const configPath = path.join(configDir, "config.json");

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Load existing config to preserve other sections
    let existingConfig = {};
    if (fs.existsSync(configPath)) {
      try {
        existingConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
        console.log("📄 Loaded existing config from file");
      } catch (e) {
        console.warn("⚠️  Could not parse existing config, creating new one");
      }
    }

    // Check if certificates exist to auto-configure paths
    const certPath = path.join(certsDir, "certificate.pem");
    const keyPath = path.join(certsDir, "private_key.pem");
    const certsExist = fs.existsSync(certPath) && fs.existsSync(keyPath);

    // Preserve the environment field name from existing config (supports both 'env' and 'environment')
    const envField = existingConfig.teller?.environment ? 'environment' : 'env';
    const envValue = existingConfig.teller?.environment || existingConfig.teller?.env || ENV;

    // Merge with existing config
    const newConfig = {
      ...existingConfig,
      teller: {
        ...existingConfig.teller,
        appId: existingConfig.teller?.appId || APP_ID, // Preserve APP_ID in config
        accessToken,
        accountId,
        userId: userId || existingConfig.teller?.userId,
        [envField]: envValue,
        certPath: certsExist ? certPath : existingConfig.teller?.certPath,
        certKeyPath: certsExist ? keyPath : existingConfig.teller?.certKeyPath,
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
    console.log("✅ Teller credentials saved to config.json");
    console.log("📝 Config path:", configPath);

    res.json({
      success: true,
      message: "Teller credentials saved successfully",
      redirectTo: "/setup"
    });
  } catch (error) {
    console.error("❌ Error saving Teller credentials:", error);
    res.status(500).json({ error: error.message });
  }
});

// Save Actual Budget configuration
app.post("/api/setup/save-actual", (req, res) => {
  try {
    const { serverURL, password, syncId, accountId, daysToSync, cronSchedule } = req.body;

    if (!serverURL || !password || !syncId || !accountId) {
      return res.status(400).json({
        error: "Missing required fields: serverURL, password, syncId, accountId"
      });
    }

    const configDir = path.join(__dirname, "config");
    const configPath = path.join(configDir, "config.json");

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Load existing config to preserve Teller section
    let existingConfig = {};
    if (fs.existsSync(configPath)) {
      try {
        existingConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch (e) {
        console.warn("Could not parse existing config, creating new one");
      }
    }

    // Merge with existing config
    const newConfig = {
      ...existingConfig,
      actual: {
        dataDir: process.env.ACTUAL_DATA_DIR || "/app/actual-data",
        serverURL,
        password,
        syncId,
        accountId,
      },
      sync: {
        daysToSync: parseInt(daysToSync) || 7,
        cronSchedule: cronSchedule || "0 8 * * *",
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
    console.log("✅ Actual Budget configuration saved to config.json");

    res.json({
      success: true,
      message: "Configuration saved successfully",
      redirectTo: "/admin"
    });
  } catch (error) {
    console.error("Error saving Actual Budget configuration:", error);
    res.status(500).json({ error: error.message });
  }
});

// Test Teller API connection
app.post("/api/test/teller", async (req, res) => {
  try {
    // Load config from file to get the real credentials
    const config = loadConfig();

    const accessToken = config.teller?.accessToken;
    const accountId = config.teller?.accountId;

    if (!accessToken || !accountId) {
      return res.status(400).json({
        error: "Teller configuration incomplete. Missing accessToken or accountId."
      });
    }

    // Build agent options
    const certPath = path.join(certsDir, "certificate.pem");
    const keyPath = path.join(certsDir, "private_key.pem");
    const certsExist = fs.existsSync(certPath) && fs.existsSync(keyPath);

    const agentOptions = certsExist
      ? {
          cert: fs.readFileSync(certPath),
          key: fs.readFileSync(keyPath),
        }
      : {};

    const agent = new https.Agent(agentOptions);

    // Test API call to get account details
    const response = await new Promise((resolve, reject) => {
      const auth = Buffer.from(`${accessToken}:`).toString("base64");

      const options = {
        hostname: "api.teller.io",
        path: `/accounts/${accountId}`,
        method: "GET",
        headers: {
          Authorization: `Basic ${auth}`,
        },
        agent,
      };

      const request = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            resolve({ success: true, data: JSON.parse(data) });
          } else {
            reject(new Error(`API returned status ${res.statusCode}: ${data}`));
          }
        });
      });

      request.on("error", reject);
      request.end();
    });

    res.json({
      success: true,
      message: "Successfully connected to Teller API",
      accountName: response.data.name || "Unknown",
      institution: response.data.institution?.name || "Unknown"
    });
  } catch (error) {
    console.error("Teller API test failed:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to connect to Teller API"
    });
  }
});

// Test Actual Budget connection
app.post("/api/test/actual", async (req, res) => {
  let actualInitialized = false;
  const tempDataDir = path.join(__dirname, "actual-data", "temp-test-" + Date.now());

  try {
    // Load config from file to get the real password
    const config = loadConfig();

    const serverURL = req.body.serverURL || config.actual?.serverURL;
    const password = config.actual?.password; // Always use password from config
    const syncId = req.body.syncId || config.actual?.syncId;

    if (!serverURL || !password) {
      return res.status(400).json({
        error: "Actual Budget configuration incomplete. Missing serverURL or password."
      });
    }

    // Create a temporary Actual instance for testing
    if (!fs.existsSync(tempDataDir)) {
      fs.mkdirSync(tempDataDir, { recursive: true });
    }

    console.log(`🧪 Testing Actual Budget connection to ${serverURL}...`);

    await actual.init({
      dataDir: tempDataDir,
      serverURL,
      password,
    });
    actualInitialized = true;

    console.log("✅ Actual Budget initialized successfully");

    // Try to download budget if syncId provided (optional for test)
    if (syncId) {
      try {
        console.log(`📥 Testing budget download with syncId: ${syncId}...`);
        await actual.downloadBudget(syncId);
        console.log("✅ Budget downloaded successfully");
      } catch (downloadError) {
        console.warn("⚠️  Budget download failed during test (this is OK if budget doesn't exist yet):", downloadError.message);
        // Don't fail the test if budget download fails - just warn
        // The connection itself worked if we got here
      }
    }

    await actual.shutdown();
    actualInitialized = false;

    // Clean up temp directory
    try {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn("⚠️  Failed to clean up temp directory:", cleanupError.message);
    }

    res.json({
      success: true,
      message: "Successfully connected to Actual Budget",
    });
  } catch (error) {
    console.error("❌ Actual Budget test failed:", error);

    // Shutdown if initialized
    if (actualInitialized) {
      try {
        await actual.shutdown();
      } catch (shutdownError) {
        console.error("⚠️  Error during shutdown:", shutdownError.message);
      }
    }

    // Clean up temp directory on error
    if (fs.existsSync(tempDataDir)) {
      try {
        fs.rmSync(tempDataDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn("⚠️  Failed to clean up temp directory:", cleanupError.message);
      }
    }

    res.status(500).json({
      success: false,
      error: error.message || "Failed to connect to Actual Budget"
    });
  }
});

// ===== TELLER API PROXY (catches remaining /api/* requests) =====
// Custom middleware to add dynamic HTTPS agent with certificates
app.use("/api", (req, res, next) => {
  // Load certificates dynamically from config
  const config = loadConfig();
  const certPath = config.teller?.certPath || CERT;
  const keyPath = config.teller?.certKeyPath || CERT_KEY;

  let agent = undefined;
  if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    agent = new https.Agent({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    });
  }

  // Create proxy middleware with the current agent
  const proxy = createProxyMiddleware({
    target: "https://api.teller.io",
    changeOrigin: true,
    pathRewrite: { "^/api": "" },
    agent: agent,
    onProxyReq: (proxyReq, proxyReqReq) => {
      const rawAuth = proxyReqReq.headers["authorization"];
      if (rawAuth) {
        const token = rawAuth.trim();
        const basic = Buffer.from(`${token}:`).toString("base64");
        proxyReq.setHeader("authorization", `Basic ${basic}`);
      }
    },
  });

  proxy(req, res, next);
});

// ===== PAGE ROUTES =====

// Smart routing for root path
app.get("/", (req, res) => {
  const status = checkConfigStatus();

  // Redirect based on configuration completeness
  if (!status.hasTellerConfig) {
    return res.redirect("/connect");
  }

  if (!status.hasActualConfig) {
    return res.redirect("/setup");
  }

  // Configuration is complete, show admin dashboard
  return res.redirect("/admin");
});

// Teller Connect page
app.get("/connect", (req, res) => {
  // Reload config to get latest APP_ID (in case it was just saved)
  const currentConfig = loadConfig();
  const currentAppId = currentConfig.teller?.appId || APP_ID;

  // Check if certificates exist for development environment
  const certPath = path.join(certsDir, "certificate.pem");
  const keyPath = path.join(certsDir, "private_key.pem");
  const certsExist = fs.existsSync(certPath) && fs.existsSync(keyPath);
  const currentEnv = currentConfig.teller?.environment || currentConfig.teller?.env || "development";
  const needsCerts = currentEnv === "development" && !certsExist;

  // If APP_ID is not configured or certificates are missing for development, show setup form
  if (!currentAppId || !currentAppId.startsWith('app_') || needsCerts) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Teller Setup - Configuration Required</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
            padding: 40px;
            max-width: 600px;
            width: 100%;
          }
          h1 { color: #667eea; margin-bottom: 10px; font-size: 1.8rem; }
          p { color: #666; margin-bottom: 20px; line-height: 1.6; }
          .form-group { margin-bottom: 20px; }
          label { display: block; font-weight: 600; margin-bottom: 8px; color: #444; }
          input[type="text"], input[type="file"], select {
            width: 100%;
            padding: 12px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 1rem;
            transition: border-color 0.2s;
          }
          input:focus, select:focus { outline: none; border-color: #667eea; }
          .help-text { font-size: 0.85rem; color: #999; margin-top: 5px; }
          .help-text a { color: #667eea; text-decoration: none; }
          .help-text a:hover { text-decoration: underline; }
          .info-box {
            background: #e8f4fd;
            border-left: 4px solid #2196F3;
            padding: 12px 16px;
            margin-bottom: 20px;
            border-radius: 4px;
          }
          .info-box strong { display: block; margin-bottom: 5px; color: #1976D2; }
          .info-box p { margin: 0; font-size: 0.9rem; color: #555; }
          .cert-section {
            background: #f9f9f9;
            border: 2px dashed #ddd;
            border-radius: 8px;
            padding: 20px;
            margin-top: 10px;
          }
          .cert-section.hidden { display: none; }
          .file-input-wrapper {
            position: relative;
            overflow: hidden;
            display: inline-block;
            width: 100%;
          }
          .file-input-wrapper input[type=file] {
            position: absolute;
            left: -9999px;
          }
          .file-input-label {
            display: block;
            padding: 12px;
            background: white;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            cursor: pointer;
            text-align: center;
            transition: all 0.2s;
          }
          .file-input-label:hover {
            border-color: #667eea;
            background: #f9f9ff;
          }
          .file-selected {
            color: #667eea;
            font-weight: 600;
          }
          .btn {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s;
          }
          .btn:hover { transform: translateY(-2px); }
          .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
          .status-message {
            padding: 12px;
            border-radius: 8px;
            margin-top: 15px;
            display: none;
          }
          .status-message.success { background: #d4edda; color: #155724; }
          .status-message.error { background: #f8d7da; color: #721c24; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🏦 Teller Setup</h1>
          <p>Configure your Teller connection before linking your bank account.</p>

          <form id="appIdForm" enctype="multipart/form-data">
            <div class="form-group">
              <label for="appId">Teller Application ID</label>
              <input
                type="text"
                id="appId"
                name="appId"
                placeholder="app_xxxxxxxxxxxxxxxxxx"
                value="${currentAppId && currentAppId.startsWith('app_') ? currentAppId : ''}"
                ${currentAppId && currentAppId.startsWith('app_') ? 'readonly' : 'required'}
                autocomplete="off"
              >
              <div class="help-text">
                Don't have one? <a href="https://teller.io/dashboard" target="_blank">Get it from Teller Dashboard</a>
              </div>
            </div>

            <div class="info-box">
              <strong>🔐 mTLS Certificates Required</strong>
              <p>Teller requires client certificates for API authentication. Download your certificate.pem and private_key.pem from the <a href="https://teller.io/dashboard/certificates" target="_blank">Teller Dashboard</a>.</p>
            </div>

            <div class="cert-section">
              <div class="form-group">
                <label for="certificate">Certificate File (certificate.pem)</label>
                <div class="file-input-wrapper">
                  <input type="file" id="certificate" name="certificate" accept=".pem" required />
                  <label for="certificate" class="file-input-label" id="certLabel">
                    📄 Choose certificate.pem file
                  </label>
                </div>
              </div>

              <div class="form-group">
                <label for="privateKey">Private Key File (private_key.pem)</label>
                <div class="file-input-wrapper">
                  <input type="file" id="privateKey" name="privateKey" accept=".pem" required />
                  <label for="privateKey" class="file-input-label" id="keyLabel">
                    🔑 Choose private_key.pem file
                  </label>
                </div>
              </div>
            </div>

            <button type="submit" class="btn" id="submitBtn">Continue to Bank Connection</button>
          </form>

          <div id="statusMessage" class="status-message"></div>
        </div>

        <script>
          // File input labels
          document.getElementById('certificate').addEventListener('change', function(e) {
            const label = document.getElementById('certLabel');
            if (e.target.files.length > 0) {
              label.textContent = '✅ ' + e.target.files[0].name;
              label.classList.add('file-selected');
            } else {
              label.textContent = '📄 Choose certificate.pem file';
              label.classList.remove('file-selected');
            }
          });

          document.getElementById('privateKey').addEventListener('change', function(e) {
            const label = document.getElementById('keyLabel');
            if (e.target.files.length > 0) {
              label.textContent = '✅ ' + e.target.files[0].name;
              label.classList.add('file-selected');
            } else {
              label.textContent = '🔑 Choose private_key.pem file';
              label.classList.remove('file-selected');
            }
          });

          document.getElementById('appIdForm').addEventListener('submit', async (e) => {
            e.preventDefault();

            const appId = document.getElementById('appId').value.trim();
            const certificate = document.getElementById('certificate').files[0];
            const privateKey = document.getElementById('privateKey').files[0];
            const btn = document.getElementById('submitBtn');
            const statusMsg = document.getElementById('statusMessage');

            if (!appId) {
              showStatus('Please enter your App ID', 'error');
              return;
            }

            if (!certificate || !privateKey) {
              showStatus('Please upload both certificate files', 'error');
              return;
            }

            btn.disabled = true;
            btn.textContent = 'Uploading certificates...';

            try {
              const formData = new FormData();
              formData.append('appId', appId);
              formData.append('certificate', certificate);
              formData.append('privateKey', privateKey);

              const response = await fetch('/api/setup/save-app-id-and-certs', {
                method: 'POST',
                body: formData
              });

              const result = await response.json();

              if (result.success) {
                showStatus('✅ Configuration saved! Reloading...', 'success');
                setTimeout(() => {
                  window.location.reload();
                }, 1000);
              } else {
                showStatus('❌ ' + (result.error || 'Failed to save'), 'error');
                btn.disabled = false;
                btn.textContent = 'Continue to Bank Connection';
              }
            } catch (error) {
              showStatus('❌ Error: ' + error.message, 'error');
              btn.disabled = false;
              btn.textContent = 'Continue to Bank Connection';
            }
          });

          function showStatus(message, type) {
            const statusMsg = document.getElementById('statusMessage');
            statusMsg.textContent = message;
            statusMsg.className = 'status-message ' + type;
            statusMsg.style.display = 'block';
          }
        </script>
      </body>
      </html>
    `);
  }

  // APP_ID is configured, show normal connect page
  const htmlPath = path.join(staticDir, "connect.html");
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send("Connect page not found. Make sure connect.html exists in static/ folder.");
  }
  let html = fs.readFileSync(htmlPath, "utf8");
  html = html.replace("{{ app_id }}", currentAppId);
  html = html.replace("{{ environment }}", currentConfig.teller?.environment || currentConfig.teller?.env || ENV);
  res.type("html").send(html);
});

// Setup wizard page
app.get("/setup", (req, res) => {
  const htmlPath = path.join(staticDir, "setup.html");
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send("Setup page not found. Make sure setup.html exists in static/ folder.");
  }
  res.sendFile(htmlPath);
});

app.get("/ping", (req, res) => {
  res.json({ message: "pong", timestamp: new Date().toISOString() });
});

// Manual sync trigger endpoint
app.post("/manual-sync", async (req, res) => {
  try {
    // Check if configuration is complete before attempting sync
    const status = checkConfigStatus();
    if (!status.isComplete) {
      return res.status(400).json({
        success: false,
        error: "Configuration incomplete. Please complete the setup wizard first.",
        hasTellerConfig: status.hasTellerConfig,
        hasActualConfig: status.hasActualConfig
      });
    }

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
  // Template TELLER_CONFIG so admin.js can launch Teller Connect inline
  const currentConfig = loadConfig();
  const currentAppId = currentConfig.teller?.appId || APP_ID || "";
  const currentEnv = currentConfig.teller?.environment || currentConfig.teller?.env || ENV || "sandbox";
  let html = fs.readFileSync(adminPath, "utf8");
  html = html.replace("{{ app_id }}", currentAppId);
  html = html.replace("{{ environment }}", currentEnv);
  res.type("html").send(html);
});

// Helper: ensure Actual SDK is initialized + budget downloaded.
// Used by both list (GET) and create (POST) endpoints. Idempotent — safe to call repeatedly.
async function ensureActualReady() {
  const config = loadConfig();
  if (!config.actual.serverURL || !config.actual.password || !config.actual.syncId) {
    throw new Error("Actual Budget is not configured (serverURL/password/syncId)");
  }
  try {
    await actual.init({
      dataDir: config.actual.dataDir,
      serverURL: config.actual.serverURL,
      password: config.actual.password,
    });
    await actual.downloadBudget(config.actual.syncId);
  } catch (e) {
    if (!String(e?.message || "").toLowerCase().includes("already")) throw e;
  }
}

// Create a new account in Actual (called from the Connect Another Bank flow)
app.post("/api/actual/accounts", async (req, res) => {
  try {
    const { name, offbudget, initialBalance } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    const balance = Number.isFinite(Number(initialBalance)) ? Number(initialBalance) : 0;

    await ensureActualReady();
    // Actual SDK signature: createAccount({ name, offbudget }, initialBalanceCents)
    const id = await actual.createAccount(
      { name: name.trim(), offbudget: !!offbudget },
      Math.round(balance * 100)
    );
    res.json({ success: true, id });
  } catch (error) {
    console.error("Error creating Actual account:", error);
    res.status(500).json({ error: error?.message || String(error) });
  }
});

// List accounts in the Actual budget (for mapping dropdowns)
app.get("/api/actual/accounts", async (req, res) => {
  try {
    await ensureActualReady();
    const accounts = await actual.getAccounts();
    res.json({
      accounts: accounts.map(a => ({
        id: a.id,
        name: a.name,
        offbudget: !!a.offbudget,
        closed: !!a.closed,
      })),
    });
  } catch (error) {
    console.error("Error listing Actual accounts:", error);
    res.status(500).json({ error: error.message });
  }
});

// List Teller accounts under a given access token (server-side, with mTLS)
app.post("/api/teller/accounts", async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken || !accessToken.startsWith("token_")) {
      return res.status(400).json({ error: "Missing or invalid accessToken" });
    }
    const config = loadConfig();
    const tellerEnv = config.teller.env;
    const certPath = config.teller.certPath;
    const certKeyPath = config.teller.certKeyPath;

    let agent;
    if (tellerEnv !== "sandbox" && certPath && certKeyPath) {
      if (fs.existsSync(certPath) && fs.existsSync(certKeyPath)) {
        agent = new https.Agent({
          cert: fs.readFileSync(certPath),
          key: fs.readFileSync(certKeyPath),
        });
      }
    }

    const data = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: "api.teller.io",
        path: "/accounts",
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accessToken}:`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        agent,
      }, (resp) => {
        let body = "";
        resp.on("data", c => body += c);
        resp.on("end", () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`Teller API ${resp.statusCode}: ${body}`));
          }
        });
      });
      r.on("error", reject);
      r.end();
    });

    res.json({
      accounts: (data || []).map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        last_four: a.last_four,
        institution: a.institution?.name || a.institution?.id || null,
      })),
    });
  } catch (error) {
    console.error("Error listing Teller accounts:", error);
    res.status(500).json({ error: error.message });
  }
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
      APP_ID: config.teller?.appId || process.env.APP_ID || "",
      ENV: config.teller?.env || config.teller?.environment || process.env.ENV || "sandbox",
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

    // Preserve the environment field name from existing config
    const envField = existingConfig.teller?.environment ? 'environment' : 'env';
    const envValue = req.body.ENV || existingConfig.teller?.env || existingConfig.teller?.environment;

    const newConfig = {
      teller: {
        appId: req.body.APP_ID || existingConfig.teller?.appId,
        accessToken: req.body.TELLER_ACCESS_TOKEN || existingConfig.teller?.accessToken,
        accountId: req.body.TELLER_ACCOUNT_ID,
        [envField]: envValue,
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

  // Only initialize Actual Budget if configuration is complete and valid
  const status = checkConfigStatus();
  if (status.hasActualConfig) {
    try {
      await initActual();
    } catch (error) {
      console.error("⚠️  Failed to initialize Actual Budget:", error.message);
      console.error("   Please verify your Actual Budget configuration in the setup wizard");
    }
  } else {
    console.log("ℹ️  Actual Budget not configured yet - skipping initialization");
    console.log("   Complete setup at: http://localhost:${PORT}/setup");
  }

  // Setup automated sync only if fully configured
  if (status.isComplete) {
    setupCronJob();
    console.log("\n✨ Ready! Server is running with automated sync enabled.");
  } else {
    console.log("\n✨ Ready! Complete the setup wizard to enable automated sync.");
  }

  console.log("📝 Manual sync: POST http://localhost:8001/manual-sync");
  console.log("📊 View logs: GET http://localhost:8001/sync-logs\n");
});