import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as actual from "@actual-app/api";
import cron from "node-cron";
import {
  runSync,
  runSyncForMapping,
  loadConfig,
  saveMappings,
  saveQuilttConfig,
  updateMappingState,
  newMappingId,
} from "./sync.js";
import {
  issueSessionToken,
  testApiSecret,
  fetchAccounts,
  connectionNeedsRepair,
} from "./quiltt.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8001;
const staticDir = path.join(__dirname, "static");

const app = express();
app.use(cors(), express.json({ limit: '50mb' }));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Helper function to check configuration completeness
function checkConfigStatus() {
  const config = loadConfig();

  // Quiltt credentials (API secret + Connector ID from the Quiltt Dashboard)
  const hasQuilttCredentials = Boolean(config.quiltt?.apiSecret && config.quiltt?.connectorId);
  const hasProfile = Boolean(config.quiltt?.profileId);

  // Actual server-level config (shared across all mappings)
  const hasActualConfig = Boolean(
    config.actual?.serverURL &&
    config.actual?.password &&
    config.actual?.syncId &&
    !config.actual.serverURL.includes('your-actual-server') &&
    !config.actual.password.includes('your_actual_password') &&
    config.actual.syncId.match(UUID_RE)
  );

  // At least one fully-formed mapping
  const validMappings = (config.mappings || []).filter(m =>
    m.quilttAccountId && m.quilttAccountId.startsWith('acct_') &&
    m.actualAccountId && UUID_RE.test(m.actualAccountId)
  );

  const hasQuilttConfig = hasQuilttCredentials && hasProfile && validMappings.length > 0;

  return {
    hasQuilttCredentials,
    hasProfile,
    hasQuilttConfig,
    hasActualConfig,
    isComplete: hasQuilttConfig && hasActualConfig,
    mappingCount: (config.mappings || []).length,
    validMappingCount: validMappings.length
  };
}

async function initActual() {
  const config = loadConfig();

  const { dataDir, serverURL, password, syncId } = config.actual;

  if (!serverURL || !password) {
    throw new Error("Actual Budget serverURL and password are required");
  }

  await actual.init({ dataDir, serverURL, password });

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

// Coerce any thrown value into a string message — SDK errors sometimes have non-string
// .message fields, which previously surfaced as "[object Object]" in the UI.
function errMsg(err) {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  if (err.message && typeof err.message === "object") {
    try { return JSON.stringify(err.message); } catch (_) { return String(err.message); }
  }
  try { return JSON.stringify(err); } catch (_) { return String(err); }
}

// ===== SETUP & STATUS API =====

// Save Quiltt credentials (API secret + Connector ID from the Quiltt Dashboard)
app.post("/api/setup/save-quiltt", (req, res) => {
  try {
    const { apiSecret, connectorId } = req.body;

    if (!apiSecret && !connectorId) {
      return res.status(400).json({ error: "Provide apiSecret and/or connectorId" });
    }

    const quiltt = saveQuilttConfig({ apiSecret, connectorId });
    console.log("✅ Quiltt credentials saved to config.json");

    res.json({
      success: true,
      message: "Quiltt configuration saved",
      connectorId: quiltt.connectorId || null,
    });
  } catch (error) {
    console.error("Error saving Quiltt configuration:", error);
    res.status(500).json({ error: errMsg(error) });
  }
});

// Get config status endpoint
app.get("/api/config/status", (req, res) => {
  try {
    const status = checkConfigStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// ===== QUILTT API =====

// Issue a Session token for launching the Quiltt Connector in the browser.
// First call creates the (single, household) Profile and persists its ID.
app.post("/api/quiltt/session", async (req, res) => {
  try {
    const config = loadConfig();
    if (!config.quiltt.apiSecret) {
      return res.status(400).json({ error: "Quiltt API secret is not configured" });
    }

    const session = await issueSessionToken({
      apiSecret: config.quiltt.apiSecret,
      profileId: config.quiltt.profileId,
    });

    // Persist the auto-created profile so every future session reuses it
    if (!config.quiltt.profileId && session.profileId) {
      saveQuilttConfig({ profileId: session.profileId });
      console.log(`✅ Quiltt profile created and saved: ${session.profileId}`);
    }

    res.json({
      token: session.token,
      profileId: session.profileId,
      expiresAt: session.expiresAt,
      connectorId: config.quiltt.connectorId || null,
    });
  } catch (error) {
    console.error("Error issuing Quiltt session:", error);
    res.status(500).json({ error: errMsg(error) });
  }
});

// List all Quiltt accounts on the profile (for mapping pickers)
app.get("/api/quiltt/accounts", async (req, res) => {
  try {
    const config = loadConfig();
    if (!config.quiltt.apiSecret || !config.quiltt.profileId) {
      return res.status(400).json({ error: "Quiltt is not configured yet. Connect a bank first." });
    }

    const accounts = await fetchAccounts({ quiltt: config.quiltt });
    res.json({
      accounts: accounts.map(a => ({
        ...a,
        needsRepair: connectionNeedsRepair(a.connectionStatus),
      })),
    });
  } catch (error) {
    console.error("Error listing Quiltt accounts:", error);
    res.status(500).json({ error: errMsg(error), isAuth: error?.name === "QuilttAuthError" });
  }
});

// Test Quiltt API connection
app.post("/api/test/quiltt", async (req, res) => {
  try {
    const config = loadConfig();
    if (!config.quiltt.apiSecret) {
      return res.status(400).json({ error: "Quiltt API secret is not configured" });
    }

    const result = await testApiSecret(config.quiltt.apiSecret);
    if (!result.ok) {
      return res.status(500).json({ success: false, error: result.error });
    }

    // If a profile exists, also verify profile-scoped GraphQL access
    let accountCount = null;
    if (config.quiltt.profileId) {
      const accounts = await fetchAccounts({ quiltt: config.quiltt });
      accountCount = accounts.length;
    }

    res.json({
      success: true,
      message: "Successfully connected to Quiltt API",
      profileId: config.quiltt.profileId || null,
      accountCount,
    });
  } catch (error) {
    console.error("Quiltt API test failed:", error);
    res.status(500).json({ success: false, error: errMsg(error) });
  }
});

// ===== Account mappings API =====
// Each mapping = one Quiltt account paired with one Actual account.

app.get("/api/mappings", (req, res) => {
  try {
    const config = loadConfig();
    const safe = (config.mappings || []).map(m => ({
      id: m.id,
      name: m.name || "",
      connectionId: m.connectionId || null,
      quilttAccountId: m.quilttAccountId,
      actualAccountId: m.actualAccountId,
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
    res.status(500).json({ error: errMsg(error) });
  }
});

// Edit a mapping (name, actualAccountId, disabled).
app.patch("/api/mappings/:id", (req, res) => {
  try {
    const id = req.params.id;
    const { name, actualAccountId, disabled } = req.body;

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
    res.status(500).json({ error: errMsg(error) });
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
      error: errMsg(error),
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
      error: errMsg(error),
      isAuth: error?.name === "QuilttAuthError",
    });
  }
});

// Clear the needsReconnect flag for all mappings on a connection.
// Called after a successful Connector reconnect flow.
app.post("/api/mappings/reconnected", (req, res) => {
  try {
    const { connectionId } = req.body;
    if (!connectionId || !connectionId.startsWith("conn_")) {
      return res.status(400).json({ error: "Missing/invalid connectionId" });
    }

    const config = loadConfig();
    let cleared = 0;
    const mappings = config.mappings.map(m => {
      if (m.connectionId === connectionId && m.needsReconnect) {
        cleared++;
        return { ...m, needsReconnect: false, lastError: null };
      }
      return m;
    });
    saveMappings(mappings);
    res.json({ success: true, cleared });
  } catch (error) {
    console.error("Error clearing reconnect flags:", error);
    res.status(500).json({ error: errMsg(error) });
  }
});

// Create or update a mapping. If body.id is set and matches an existing mapping, update.
// Otherwise create a new one.
app.post("/api/mappings", (req, res) => {
  try {
    const { id, name, connectionId, quilttAccountId, actualAccountId, pendingReconcile } = req.body;

    if (!quilttAccountId || !actualAccountId) {
      return res.status(400).json({
        error: "Missing required fields: quilttAccountId, actualAccountId"
      });
    }
    if (!quilttAccountId.startsWith("acct_")) {
      return res.status(400).json({ error: "quilttAccountId must start with 'acct_'" });
    }
    if (connectionId && !connectionId.startsWith("conn_")) {
      return res.status(400).json({ error: "connectionId must start with 'conn_'" });
    }
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
        connectionId: connectionId || mappings[idx].connectionId,
        quilttAccountId,
        actualAccountId,
        ...(typeof pendingReconcile === "boolean" ? { pendingReconcile } : {}),
      };
    } else {
      // Prevent duplicate (same quilttAccountId + actualAccountId)
      const dup = mappings.find(m =>
        m.quilttAccountId === quilttAccountId && m.actualAccountId === actualAccountId
      );
      if (dup) {
        return res.status(409).json({ error: "Mapping already exists", id: dup.id });
      }
      mappings.push({
        id: newMappingId(),
        name: name || "Unnamed",
        connectionId: connectionId || null,
        quilttAccountId,
        actualAccountId,
        pendingReconcile: !!pendingReconcile,
      });
    }

    saveMappings(mappings);
    res.json({ success: true, count: mappings.length });
  } catch (error) {
    console.error("Error saving mapping:", error);
    res.status(500).json({ error: errMsg(error) });
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
    res.status(500).json({ error: errMsg(error) });
  }
});

// ===== ACTUAL BUDGET API =====

// Save Actual Budget configuration
app.post("/api/setup/save-actual", (req, res) => {
  try {
    const { serverURL, password, syncId, daysToSync, cronSchedule } = req.body;

    if (!serverURL || !password || !syncId) {
      return res.status(400).json({
        error: "Missing required fields: serverURL, password, syncId"
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

    const newConfig = {
      ...existingConfig,
      actual: {
        dataDir: process.env.ACTUAL_DATA_DIR || "/app/actual-data",
        serverURL,
        password,
        syncId,
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
    res.status(500).json({ error: errMsg(error) });
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
    const password = req.body.password || config.actual?.password;
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
      error: errMsg(error) || "Failed to connect to Actual Budget"
    });
  }
});

// Helper: ensure Actual SDK is initialized + budget downloaded.
// Used by both list (GET) and create (POST) endpoints. Idempotent — safe to call repeatedly.
// runSync() shuts the SDK down at the end of every sync, so this often needs to re-init.
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
  } catch (e) {
    const msg = errMsg(e).toLowerCase();
    if (!msg.includes("already")) {
      console.error("actual.init failed:", e);
      throw new Error("Actual init failed: " + errMsg(e));
    }
  }
  try {
    await actual.downloadBudget(config.actual.syncId);
  } catch (e) {
    const msg = errMsg(e).toLowerCase();
    if (!msg.includes("already")) {
      console.error("actual.downloadBudget failed:", e);
      throw new Error("Actual downloadBudget failed: " + errMsg(e));
    }
  }
}

// Create a new account in Actual (called from the Connect a Bank flow)
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
    res.status(500).json({ error: errMsg(error) });
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
    res.status(500).json({ error: errMsg(error) });
  }
});

// ===== PAGE ROUTES =====

// Smart routing for root path
app.get("/", (req, res) => {
  const status = checkConfigStatus();

  // Redirect based on configuration completeness
  if (!status.hasQuilttConfig) {
    return res.redirect("/connect");
  }

  if (!status.hasActualConfig) {
    return res.redirect("/setup");
  }

  // Configuration is complete, show admin dashboard
  return res.redirect("/admin");
});

// Render an HTML file with Quiltt template values filled in
function renderWithQuilttConfig(htmlPath, res) {
  const config = loadConfig();
  let html = fs.readFileSync(htmlPath, "utf8");
  html = html.replaceAll("{{ connector_id }}", config.quiltt?.connectorId || "");
  html = html.replaceAll("{{ has_credentials }}", config.quiltt?.apiSecret && config.quiltt?.connectorId ? "true" : "false");
  res.type("html").send(html);
}

// Quiltt Connector page (bank connection flow)
app.get("/connect", (req, res) => {
  const htmlPath = path.join(staticDir, "connect.html");
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send("Connect page not found. Make sure connect.html exists in static/ folder.");
  }
  renderWithQuilttConfig(htmlPath, res);
});

// Setup wizard page (Actual Budget configuration)
app.get("/setup", (req, res) => {
  const htmlPath = path.join(staticDir, "setup.html");
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send("Setup page not found. Make sure setup.html exists in static/ folder.");
  }
  res.sendFile(htmlPath);
});

// Admin dashboard
app.get("/admin", (req, res) => {
  const adminPath = path.join(staticDir, "admin.html");
  if (!fs.existsSync(adminPath)) {
    return res.status(404).send("Admin page not found. Make sure admin.html exists in static/ folder.");
  }
  renderWithQuilttConfig(adminPath, res);
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
        hasQuilttConfig: status.hasQuilttConfig,
        hasActualConfig: status.hasActualConfig
      });
    }

    console.log("🔄 Manual sync triggered via API...");
    await runSync();
    res.json({ success: true, message: "Sync completed successfully" });
  } catch (error) {
    console.error("❌ Manual sync failed:", error);
    res.status(500).json({ success: false, error: errMsg(error) });
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
    res.status(500).json({ error: errMsg(error) });
  }
});

// ===== ADMIN API =====

app.get("/admin/api/config", (req, res) => {
  try {
    const config = loadConfig();
    // Return actual config values (mask sensitive data for display)
    const safeConfig = {
      QUILTT_API_SECRET: config.quiltt?.apiSecret ? config.quiltt.apiSecret.substring(0, 8) + "***" : "",
      QUILTT_CONNECTOR_ID: config.quiltt?.connectorId || "",
      QUILTT_PROFILE_ID: config.quiltt?.profileId || "",
      ACTUAL_SERVER_URL: config.actual?.serverURL || "",
      ACTUAL_PASSWORD: config.actual?.password ? "***" : "",
      ACTUAL_SYNC_ID: config.actual?.syncId || "",
      DAYS_TO_SYNC: config.sync?.daysToSync || 7,
      CRON_SCHEDULE: config.sync?.cronSchedule || "0 8 * * *",
    };
    res.json(safeConfig);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
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

    const newConfig = {
      ...existingConfig,
      quiltt: {
        ...existingConfig.quiltt,
        apiSecret: req.body.QUILTT_API_SECRET || existingConfig.quiltt?.apiSecret,
        connectorId: req.body.QUILTT_CONNECTOR_ID || existingConfig.quiltt?.connectorId,
        // profileId is managed by the app, not the form — always preserve
        profileId: existingConfig.quiltt?.profileId,
      },
      actual: {
        dataDir: process.env.ACTUAL_DATA_DIR || "/app/actual-data",
        serverURL: req.body.ACTUAL_SERVER_URL,
        password: req.body.ACTUAL_PASSWORD || existingConfig.actual?.password,
        syncId: req.body.ACTUAL_SYNC_ID,
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
    res.status(500).json({ error: errMsg(error) });
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
    res.status(500).json({ error: errMsg(error) });
  }
});

app.use("/static", express.static(staticDir));

app.listen(PORT, async () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);

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
    console.log(`   Complete setup at: http://localhost:${PORT}/setup`);
  }

  // Setup automated sync only if fully configured
  if (status.isComplete) {
    setupCronJob();
    console.log("\n✨ Ready! Server is running with automated sync enabled.");
  } else {
    console.log("\n✨ Ready! Complete the setup wizard to enable automated sync.");
  }

  console.log(`📝 Manual sync: POST http://localhost:${PORT}/manual-sync`);
  console.log(`📊 View logs: GET http://localhost:${PORT}/sync-logs\n`);
});
