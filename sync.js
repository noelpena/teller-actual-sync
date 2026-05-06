import dotenv from "dotenv";
import * as actual from "@actual-app/api";
import fs from "fs";
import path from "path";
import https from "https";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Generate a stable id for a new mapping
function newMappingId() {
  return "m_" + crypto.randomBytes(6).toString("hex");
}

// Load config from file or env vars; auto-migrate legacy single-account configs
function loadConfig() {
  const configPath = path.join(__dirname, "config", "config.json");

  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      console.log("📄 Loaded config from config.json");
    } catch (error) {
      console.warn("⚠️  Failed to parse config.json, using env vars");
    }
  }

  // Build mappings from new schema OR migrate from legacy single-account config
  let mappings = Array.isArray(fileConfig.mappings) ? fileConfig.mappings.slice() : [];

  // Legacy single-account: synthesize one mapping if mappings empty but legacy fields present
  const legacyTellerToken = fileConfig.teller?.accessToken || process.env.TELLER_ACCESS_TOKEN;
  const legacyTellerAccount = fileConfig.teller?.accountId || process.env.TELLER_ACCOUNT_ID;
  const legacyActualAccount = fileConfig.actual?.accountId || process.env.ACTUAL_ACCOUNT_ID;

  if (mappings.length === 0 && legacyTellerToken && legacyTellerAccount && legacyActualAccount) {
    mappings.push({
      id: newMappingId(),
      name: "Default",
      tellerAccessToken: legacyTellerToken,
      tellerAccountId: legacyTellerAccount,
      actualAccountId: legacyActualAccount,
    });
    console.log("🔁 Migrated legacy single-account config to one mapping");
  }

  // Ensure every mapping has an id
  mappings = mappings.map((m) => ({ id: m.id || newMappingId(), ...m }));

  return {
    teller: {
      appId: fileConfig.teller?.appId || process.env.APP_ID,
      env: fileConfig.teller?.env || fileConfig.teller?.environment || process.env.ENV || "sandbox",
      certPath: fileConfig.teller?.certPath || process.env.CERT,
      certKeyPath: fileConfig.teller?.certKeyPath || process.env.CERT_KEY,
      // Legacy fields preserved for read-back / save-back round trips
      accessToken: legacyTellerToken,
      accountId: legacyTellerAccount,
    },
    actual: {
      dataDir: fileConfig.actual?.dataDir || process.env.ACTUAL_DATA_DIR || "/app/actual-data",
      serverURL: fileConfig.actual?.serverURL || process.env.ACTUAL_SERVER_URL,
      password: fileConfig.actual?.password || process.env.ACTUAL_PASSWORD,
      syncId: fileConfig.actual?.syncId || process.env.ACTUAL_SYNC_ID,
      accountId: legacyActualAccount,
    },
    mappings,
    sync: {
      daysToSync: fileConfig.sync?.daysToSync || parseInt(process.env.DAYS_TO_SYNC || "7"),
      cronSchedule: fileConfig.sync?.cronSchedule || process.env.CRON_SCHEDULE || "0 8 * * *",
    },
  };
}

// Persist mappings (and only mappings) to config.json, preserving everything else
function saveMappings(mappings) {
  const configDir = path.join(__dirname, "config");
  const configPath = path.join(configDir, "config.json");
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  let existing = {};
  if (fs.existsSync(configPath)) {
    try { existing = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch (_) {}
  }

  const cleaned = mappings.map((m) => ({
    id: m.id || newMappingId(),
    name: m.name || "Unnamed",
    tellerAccessToken: m.tellerAccessToken,
    tellerAccountId: m.tellerAccountId,
    actualAccountId: m.actualAccountId,
    disabled: !!m.disabled,
    needsReconnect: !!m.needsReconnect,
    pendingReconcile: !!m.pendingReconcile,
    // Sync state — preserved across saves
    lastSyncAt: m.lastSyncAt || null,
    lastSyncStatus: m.lastSyncStatus || null,    // 'success' | 'error' | 'auth_error' | 'skipped'
    lastSyncStats: m.lastSyncStats || null,
    lastError: m.lastError || null,
    lastReconcileAt: m.lastReconcileAt || null,
    lastReconcileDelta: m.lastReconcileDelta == null ? null : m.lastReconcileDelta,
  }));

  const next = { ...existing, mappings: cleaned };

  // If legacy single-account fields still exist, drop them — mappings is the source of truth now
  if (next.teller) {
    delete next.teller.accessToken;
    delete next.teller.accountId;
    delete next.teller.userId;
  }
  if (next.actual) {
    delete next.actual.accountId;
  }

  fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
  return cleaned;
}

// Update sync state for a single mapping (atomic read-modify-write of config.json)
function updateMappingState(mappingId, patch) {
  const config = loadConfig();
  const mappings = config.mappings.slice();
  const idx = mappings.findIndex(m => m.id === mappingId);
  if (idx === -1) return null;
  mappings[idx] = { ...mappings[idx], ...patch };
  saveMappings(mappings);
  return mappings[idx];
}

// Get transaction start date
function getTransactionStartDate(daysAgo) {
  const today = new Date();
  const startDate = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  const year = startDate.getFullYear();
  const month = `0${startDate.getMonth() + 1}`.slice(-2);
  const day = `0${startDate.getDate()}`.slice(-2);
  return `${year}-${month}-${day}`;
}

// Build an HTTPS agent for Teller (mTLS) if certs are available + env != sandbox
function buildTellerAgent(tellerConfig) {
  const { env, certPath, certKeyPath } = tellerConfig;
  if (env === "sandbox") return undefined;
  if (!certPath || !certKeyPath) return undefined;
  if (!fs.existsSync(certPath) || !fs.existsSync(certKeyPath)) {
    console.warn(`⚠️  Certificate files not found: ${certPath}, ${certKeyPath}`);
    return undefined;
  }
  return new https.Agent({
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(certKeyPath),
  });
}

// Custom error type so callers can detect "Teller said this token is no good, reconnect"
class TellerAuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "TellerAuthError";
    this.statusCode = statusCode;
  }
}

// Fetch the ledger balance from Teller for a single mapping. Returns a Number (in dollars) or null.
function fetchTellerBalance({ mapping, tellerConfig }) {
  const agent = buildTellerAgent(tellerConfig);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.teller.io",
      path: `/accounts/${mapping.tellerAccountId}/balances`,
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${mapping.tellerAccessToken}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      agent,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new TellerAuthError(
            `Teller balance auth error ${res.statusCode}`, res.statusCode
          ));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Teller balance API ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          // Teller returns ledger as a string. Prefer ledger (posted) over available (post-pending).
          const v = parseFloat(parsed.ledger ?? parsed.available);
          resolve(Number.isFinite(v) ? v : null);
        } catch (err) {
          reject(new Error(`Failed to parse Teller balance response: ${err.message}`));
        }
      });
    });

    req.on("error", (err) => reject(new Error(`Teller balance request failed: ${err.message}`)));
    req.end();
  });
}

// Fetch transactions from Teller for a single mapping
function fetchTellerTransactions({ mapping, tellerConfig, startDate }) {
  const agent = buildTellerAgent(tellerConfig);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.teller.io",
      path: `/accounts/${mapping.tellerAccountId}/transactions?start_date=${startDate}`,
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${mapping.tellerAccessToken}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      agent,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (err) { reject(new Error(`Failed to parse Teller response: ${err.message}`)); }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new TellerAuthError(
            `Teller auth error ${res.statusCode}: token may be expired or revoked. Reconnect this bank.`,
            res.statusCode
          ));
        } else {
          reject(new Error(`Teller API error: ${res.statusCode} ${res.statusMessage}\nDetails: ${data}`));
        }
      });
    });

    req.on("error", (err) => reject(new Error(`Teller request failed: ${err.message}`)));
    req.end();
  });
}

// Transform Teller transactions to Actual format
function transformTransactions(transactions) {
  return transactions.map((txn) => {
    const amountInCents = Math.round(parseFloat(txn.amount) * 100);
    const payeeName = txn.details?.counterparty?.name || txn.description || "Unknown";
    const notes = txn.details?.category || "";

    return {
      date: txn.date,
      amount: amountInCents,
      payee_name: payeeName,
      notes: notes ? notes + " - Imported from Teller" : "Imported from Teller",
      cleared: txn.status === "posted",
    };
  });
}

// Initialize Actual Budget (download budget once, used across all mappings)
async function initActual(config) {
  try { await actual.shutdown(); } catch (_) {}

  await actual.init({
    dataDir: config.actual.dataDir,
    serverURL: config.actual.serverURL,
    password: config.actual.password,
  });

  if (!config.actual.syncId) {
    throw new Error("Missing Actual Budget sync ID (config.actual.syncId)");
  }
  await actual.downloadBudget(config.actual.syncId);
  console.log(`✅ Budget downloaded: syncId=${config.actual.syncId}`);
}

// Save sync log
function saveSyncLog(status, message, stats = {}) {
  const logDir = path.join(__dirname, "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, status, message, stats };
  const logFile = path.join(logDir, "sync.log");
  fs.appendFileSync(logFile, JSON.stringify(logEntry) + "\n");
  console.log(`[${timestamp}] ${status}: ${message}`, stats);
}

// Reconcile an account: query Actual's current balance, fetch Teller's balance, add adjustment for delta.
// Idempotent — only runs when mapping.pendingReconcile is true. Clears the flag on success.
async function maybeReconcile({ mapping, tellerConfig, oldestImportedDate }) {
  if (!mapping.pendingReconcile) return null;

  const label = mapping.name || mapping.id;
  console.log(`   [${label}] Auto-reconcile requested...`);

  let tellerBalance;
  try {
    tellerBalance = await fetchTellerBalance({ mapping, tellerConfig });
  } catch (err) {
    console.warn(`   [${label}] Could not fetch Teller balance for reconcile: ${err.message}`);
    return null; // leave pendingReconcile=true so it retries on next sync
  }
  if (tellerBalance == null) {
    console.warn(`   [${label}] Teller returned no balance; skipping reconcile this run`);
    return null;
  }
  const tellerCents = Math.round(tellerBalance * 100);

  // Sum existing Actual balance for this account.
  // Use the SDK's getAccountBalance if available; otherwise sum transactions.
  let actualCents;
  try {
    if (typeof actual.getAccountBalance === "function") {
      const bal = await actual.getAccountBalance(mapping.actualAccountId);
      actualCents = Math.round(Number(bal) * 100); // SDK returns cents in some versions, dollars in others
      // Heuristic: if value is suspiciously large vs Teller's, assume it was already in cents
      if (Math.abs(actualCents) > Math.abs(tellerCents) * 1000) {
        actualCents = Math.round(Number(bal));
      }
    } else {
      const txs = await actual.getTransactions(mapping.actualAccountId);
      actualCents = txs.reduce((s, t) => s + (t.amount || 0), 0);
    }
  } catch (err) {
    // Fallback: query transactions directly
    const txs = await actual.getTransactions(mapping.actualAccountId);
    actualCents = txs.reduce((s, t) => s + (t.amount || 0), 0);
  }

  const deltaCents = tellerCents - actualCents;

  if (deltaCents === 0) {
    console.log(`   [${label}] Already balanced ($${(tellerCents / 100).toFixed(2)}). Clearing reconcile flag.`);
    updateMappingState(mapping.id, {
      pendingReconcile: false,
      lastReconcileAt: new Date().toISOString(),
      lastReconcileDelta: 0,
    });
    return { delta: 0, tellerBalance, actualBalance: actualCents / 100 };
  }

  // Date the adjustment one day before the oldest imported transaction (or today if none).
  const baseDate = oldestImportedDate || new Date().toISOString().slice(0, 10);
  const dt = new Date(baseDate + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() - 1);
  const adjustmentDate = dt.toISOString().slice(0, 10);

  console.log(`   [${label}] Reconcile: Actual=${(actualCents / 100).toFixed(2)} Teller=${tellerBalance.toFixed(2)} Δ=${(deltaCents / 100).toFixed(2)}`);

  await actual.importTransactions(mapping.actualAccountId, [{
    date: adjustmentDate,
    amount: deltaCents,
    payee_name: "Starting Balance Adjustment",
    notes: `Auto-reconcile to bank balance ${tellerBalance.toFixed(2)} on ${new Date().toISOString().slice(0, 10)}`,
    cleared: true,
    imported_id: `auto-reconcile-${mapping.id}-${Date.now()}`,
  }]);

  updateMappingState(mapping.id, {
    pendingReconcile: false,
    lastReconcileAt: new Date().toISOString(),
    lastReconcileDelta: deltaCents,
  });

  return { delta: deltaCents, tellerBalance, actualBalance: actualCents / 100 };
}

// Sync a single mapping. Returns per-mapping stats.
async function syncOneMapping({ mapping, tellerConfig, startDate, backupDir }) {
  const label = mapping.name || mapping.id;
  console.log(`\n🏦 [${label}] Fetching transactions since ${startDate}...`);

  const rawTransactions = await fetchTellerTransactions({ mapping, tellerConfig, startDate });

  let result = { added: [], updated: [] };
  let transactions = [];
  let oldestImportedDate = null;

  if (rawTransactions && rawTransactions.length > 0) {
    transactions = transformTransactions(rawTransactions);
    oldestImportedDate = transactions.reduce(
      (min, t) => (min == null || t.date < min ? t.date : min),
      null
    );
    console.log(`   [${label}] Importing ${transactions.length} transactions to Actual account ${mapping.actualAccountId}`);
    result = await actual.importTransactions(mapping.actualAccountId, transactions);

    // Per-mapping backup
    const currentDate = new Date().toISOString().split("T")[0];
    const backupFile = path.join(backupDir, `transactions_${currentDate}_${mapping.id}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(transactions, null, 2));
  } else {
    console.log(`   [${label}] No transactions in window`);
  }

  // Auto-reconcile if requested (newly created accounts, or manually triggered)
  let reconcileResult = null;
  try {
    reconcileResult = await maybeReconcile({ mapping, tellerConfig, oldestImportedDate });
  } catch (err) {
    console.error(`   [${label}] Reconcile failed:`, err.message);
    // don't fail the sync — leave pendingReconcile true
  }

  return {
    mappingId: mapping.id,
    name: label,
    fetched: rawTransactions ? rawTransactions.length : 0,
    added: result.added.length,
    updated: result.updated.length,
    reconcile: reconcileResult,
  };
}

// Run a sync for a single mapping by id. Used by the per-mapping "Sync" button.
async function runSyncForMapping(mappingId) {
  const config = loadConfig();
  const mapping = (config.mappings || []).find(m => m.id === mappingId);
  if (!mapping) throw new Error(`Mapping not found: ${mappingId}`);
  if (!mapping.tellerAccessToken || !mapping.tellerAccountId || !mapping.actualAccountId) {
    throw new Error(`Mapping ${mappingId} is incomplete`);
  }

  let initOk = false;
  try {
    if (!config.actual.serverURL || !config.actual.password || !config.actual.syncId) {
      throw new Error("Missing Actual Budget configuration (serverURL/password/syncId)");
    }
    await initActual(config);
    initOk = true;

    const startDate = getTransactionStartDate(config.sync.daysToSync);
    const backupDir = path.join(__dirname, "transaction-data");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const stats = await syncOneMapping({ mapping, tellerConfig: config.teller, startDate, backupDir });

    updateMappingState(mappingId, {
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: "success",
      lastSyncStats: { fetched: stats.fetched, added: stats.added, updated: stats.updated },
      lastError: null,
      needsReconnect: false,
    });

    saveSyncLog("SUCCESS", `Mapping sync: ${mapping.name}`, { mappingId, ...stats });
    await actual.shutdown();
    return stats;
  } catch (error) {
    if (initOk) { try { await actual.shutdown(); } catch (_) {} }
    const isAuth = error?.name === "TellerAuthError";
    updateMappingState(mappingId, {
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: isAuth ? "auth_error" : "error",
      lastError: error?.message || String(error),
      needsReconnect: isAuth,
    });
    saveSyncLog("ERROR", `Mapping sync failed: ${mapping.name}: ${error?.message}`, { mappingId, isAuth });
    throw error;
  }
}

// Main sync — iterates all mappings, isolating failures per mapping
async function runSync() {
  console.log("🔄 Starting sync process...");

  let initOk = false;
  try {
    const config = loadConfig();

    if (config.mappings.length === 0) {
      throw new Error("No account mappings configured. Add at least one mapping in the admin UI.");
    }
    if (!config.actual.serverURL || !config.actual.password || !config.actual.syncId) {
      throw new Error("Missing Actual Budget configuration (serverURL/password/syncId)");
    }

    console.log(`✓ Found ${config.mappings.length} mapping(s)`);
    console.log(`  Days to sync: ${config.sync.daysToSync}`);

    await initActual(config);
    initOk = true;

    const startDate = getTransactionStartDate(config.sync.daysToSync);
    const backupDir = path.join(__dirname, "transaction-data");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    // Bucket mappings: valid / disabled / invalid
    const valid = [];
    const invalid = [];
    const disabled = [];
    for (const m of config.mappings) {
      if (m.disabled) {
        disabled.push({ mappingId: m.id, name: m.name });
        continue;
      }
      if (!m.tellerAccessToken || !m.tellerAccountId || !m.actualAccountId) {
        invalid.push({ mappingId: m.id, name: m.name, reason: "missing fields" });
        continue;
      }
      valid.push(m);
    }

    const perMapping = [];
    for (const mapping of valid) {
      try {
        const stats = await syncOneMapping({ mapping, tellerConfig: config.teller, startDate, backupDir });
        perMapping.push({ ok: true, ...stats });
        updateMappingState(mapping.id, {
          lastSyncAt: new Date().toISOString(),
          lastSyncStatus: "success",
          lastSyncStats: { fetched: stats.fetched, added: stats.added, updated: stats.updated },
          lastError: null,
          needsReconnect: false,
        });
      } catch (err) {
        const isAuth = err?.name === "TellerAuthError";
        const detail = {
          mappingId: mapping.id,
          name: mapping.name || mapping.id,
          message: err?.message || String(err),
          stack: err?.stack,
          isAuth,
        };
        console.error(`❌ [${detail.name}] sync failed:`, err);
        perMapping.push({ ok: false, ...detail });
        updateMappingState(mapping.id, {
          lastSyncAt: new Date().toISOString(),
          lastSyncStatus: isAuth ? "auth_error" : "error",
          lastError: detail.message,
          needsReconnect: isAuth,
        });
      }
    }

    const totals = perMapping.reduce(
      (acc, r) => ({
        fetched: acc.fetched + (r.fetched || 0),
        added: acc.added + (r.added || 0),
        updated: acc.updated + (r.updated || 0),
        succeeded: acc.succeeded + (r.ok ? 1 : 0),
        failed: acc.failed + (r.ok ? 0 : 1),
      }),
      { fetched: 0, added: 0, updated: 0, succeeded: 0, failed: 0 }
    );

    if (totals.failed === 0 && invalid.length === 0) {
      saveSyncLog("SUCCESS", "Sync completed for all mappings", { ...totals, disabled, perMapping });
    } else {
      saveSyncLog(
        totals.succeeded > 0 ? "PARTIAL" : "ERROR",
        `Completed with ${totals.failed} failed, ${invalid.length} invalid, ${disabled.length} disabled`,
        { ...totals, invalid, disabled, perMapping }
      );
    }

    console.log("\n📊 Sync summary:");
    console.log(`   Mappings: ${totals.succeeded}/${valid.length} succeeded, ${invalid.length} invalid, ${disabled.length} disabled`);
    console.log(`   Fetched: ${totals.fetched}, Added: ${totals.added}, Updated: ${totals.updated}`);

    await actual.shutdown();
  } catch (error) {
    if (initOk) { try { await actual.shutdown(); } catch (_) {} }
    const detail = {
      message: error?.message || String(error),
      stack: error?.stack,
      name: error?.name,
      cause: error?.cause ? String(error.cause) : undefined,
    };
    saveSyncLog("ERROR", detail.message, detail);
    console.error("❌ Sync failed (full detail):");
    console.error(error);
    if (error?.cause) console.error("Caused by:", error.cause);
    throw error;
  }
}

// Run if called directly
const isMainModule = process.argv[1] && (
  import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` ||
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
);

if (isMainModule) {
  runSync()
    .then(() => { console.log("\n✅ Sync script completed"); process.exit(0); })
    .catch((error) => { console.error("\n❌ Sync script failed:"); console.error(error); process.exit(1); });
}

export { runSync, runSyncForMapping, loadConfig, saveMappings, updateMappingState, newMappingId, TellerAuthError };
