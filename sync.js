import dotenv from "dotenv";
import * as actual from "@actual-app/api";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { PlaidApiError, transactionsSyncAll } from "./plaid.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Generate a stable id for a new mapping
function newMappingId() {
  return "m_" + crypto.randomBytes(6).toString("hex");
}

// Resolve the Actual data directory. Inside Docker the app lives at /app, so
// the local default (<repo>/actual-data) IS /app/actual-data. Configs written
// by older versions hardcoded the Docker path — when that path doesn't exist
// (e.g. running `npm run dev` on Windows/macOS), fall back to the local dir.
function resolveDataDir(configured) {
  const localDefault = path.join(__dirname, "actual-data");
  const dir = configured || process.env.ACTUAL_DATA_DIR || localDefault;
  if (dir === "/app/actual-data" && !fs.existsSync(dir)) return localDefault;
  return dir;
}

// Load config from file or env vars.
// - plaid: API credentials + environment
// - items: one entry per Plaid Item (bank connection); holds the access token
//   and the per-Item /transactions/sync cursor
// - mappings: one entry per (Plaid account → Actual account) pair
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

  if (fileConfig.teller || fileConfig.quiltt) {
    console.warn(
      "⚠️  Legacy Teller/Quiltt config detected — this version uses Plaid. " +
      "Reconnect your banks via the /connect page. Old mappings will be skipped."
    );
  }

  let mappings = Array.isArray(fileConfig.mappings) ? fileConfig.mappings.slice() : [];
  // Ensure every mapping has an id (defensive — saveMappings always writes ids)
  mappings = mappings.map((m) => ({ ...m, id: m.id || newMappingId() }));

  return {
    plaid: {
      clientId: fileConfig.plaid?.clientId || process.env.PLAID_CLIENT_ID,
      secret: fileConfig.plaid?.secret || process.env.PLAID_SECRET,
      env: fileConfig.plaid?.env || process.env.PLAID_ENV || "sandbox",
      daysRequested: fileConfig.plaid?.daysRequested || parseInt(process.env.PLAID_DAYS_REQUESTED || "90"),
    },
    items: Array.isArray(fileConfig.items) ? fileConfig.items.slice() : [],
    actual: {
      dataDir: resolveDataDir(fileConfig.actual?.dataDir),
      serverURL: fileConfig.actual?.serverURL || process.env.ACTUAL_SERVER_URL,
      password: fileConfig.actual?.password || process.env.ACTUAL_PASSWORD,
      syncId: fileConfig.actual?.syncId || process.env.ACTUAL_SYNC_ID,
    },
    mappings,
    sync: {
      cronSchedule: fileConfig.sync?.cronSchedule || process.env.CRON_SCHEDULE || "0 8 * * *",
    },
  };
}

// Low-level read-modify-write of config.json preserving unknown keys
function patchConfigFile(patchFn) {
  const configDir = path.join(__dirname, "config");
  const configPath = path.join(configDir, "config.json");
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  let existing = {};
  if (fs.existsSync(configPath)) {
    try { existing = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch (_) {}
  }

  const next = patchFn(existing);
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
  return next;
}

// Persist mappings (and only mappings), preserving everything else
function saveMappings(mappings) {
  const cleaned = mappings.map((m) => ({
    id: m.id || newMappingId(),
    name: m.name || "Unnamed",
    itemId: m.itemId || null,
    plaidAccountId: m.plaidAccountId,
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

  patchConfigFile((existing) => ({ ...existing, mappings: cleaned }));
  return cleaned;
}

// Persist Plaid Items (access tokens + sync cursors), preserving everything else
function saveItems(items) {
  const cleaned = items.map((it) => ({
    itemId: it.itemId,
    accessToken: it.accessToken,
    institution: it.institution || null,
    cursor: it.cursor || null,
    needsReconnect: !!it.needsReconnect,
    createdAt: it.createdAt || null,
    lastSyncedAt: it.lastSyncedAt || null,
    lastError: it.lastError || null,
  }));
  patchConfigFile((existing) => ({ ...existing, items: cleaned }));
  return cleaned;
}

// Persist Plaid settings (clientId/secret/env/daysRequested). Pass only keys to change.
function savePlaidConfig(patch) {
  let saved;
  patchConfigFile((existing) => {
    const plaid = { ...existing.plaid };
    for (const key of ["clientId", "secret", "env", "daysRequested"]) {
      if (patch[key] !== undefined && patch[key] !== null && patch[key] !== "") {
        plaid[key] = patch[key];
      }
    }
    saved = plaid;
    return { ...existing, plaid };
  });
  return saved;
}

// Update state for a single mapping (atomic read-modify-write)
function updateMappingState(mappingId, patch) {
  const config = loadConfig();
  const mappings = config.mappings.slice();
  const idx = mappings.findIndex(m => m.id === mappingId);
  if (idx === -1) return null;
  mappings[idx] = { ...mappings[idx], ...patch };
  saveMappings(mappings);
  return mappings[idx];
}

// Update state for a single Item (atomic read-modify-write)
function updateItemState(itemId, patch) {
  const config = loadConfig();
  const items = config.items.slice();
  const idx = items.findIndex(it => it.itemId === itemId);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...patch };
  saveItems(items);
  return items[idx];
}

// Transform Plaid transactions to Actual format.
//
// SIGN FLIP: Plaid amounts are positive for money moving OUT of the account
// (a purchase is +12.34); Actual uses negative for outflows. Negate.
//
// Plaid transaction_ids are stable → imported_id gives exact dedup, which also
// makes cursor replays after a failed run idempotent.
function transformTransactions(transactions) {
  return transactions.map((txn) => ({
    date: txn.date,
    amount: Math.round(-Number(txn.amount) * 100),
    payee_name: txn.merchant_name || txn.name || "Unknown",
    imported_id: txn.transaction_id,
    notes: txn.personal_finance_category?.primary
      ? txn.personal_finance_category.primary.replaceAll("_", " ").toLowerCase()
      : "",
    cleared: !txn.pending,
  }));
}

// Bank balance for reconcile, normalized to Actual's sign convention.
// Plaid reports credit/loan balances POSITIVE when money is owed; Actual
// represents owed balances as negative. Depository/investment pass through.
function normalizedBankBalance(plaidAccount) {
  const v = plaidAccount?.balances?.current ?? plaidAccount?.balances?.available;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return (plaidAccount.type === "credit" || plaidAccount.type === "loan") ? -n : n;
}

// Initialize Actual Budget (download budget once, used across all items)
async function initActual(config) {
  try { await actual.shutdown(); } catch (_) {}

  if (!fs.existsSync(config.actual.dataDir)) {
    fs.mkdirSync(config.actual.dataDir, { recursive: true });
  }

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

// Delete transactions from an Actual account whose imported_id is in removedIds.
// Plaid's removed[] covers reversed pendings and pending→posted swaps (the
// posted version arrives separately in added[] with a new transaction_id).
async function deleteRemovedTransactions(actualAccountId, removedIds) {
  if (removedIds.size === 0) return 0;
  const existing = await actual.getTransactions(actualAccountId);
  let deleted = 0;
  for (const tx of existing) {
    if (tx.imported_id && removedIds.has(tx.imported_id)) {
      await actual.deleteTransaction(tx.id);
      deleted++;
    }
  }
  return deleted;
}

// Reconcile an account: compare Actual's balance to the bank's, add an adjustment.
// Idempotent — only runs when mapping.pendingReconcile is true. Clears the flag on success.
async function maybeReconcile({ mapping, plaidAccount, oldestImportedDate }) {
  if (!mapping.pendingReconcile) return null;

  const label = mapping.name || mapping.id;
  console.log(`   [${label}] Auto-reconcile requested...`);

  const bankBalance = normalizedBankBalance(plaidAccount);
  if (bankBalance == null) {
    console.warn(`   [${label}] No bank balance available; skipping reconcile this run`);
    return null; // leave pendingReconcile=true so it retries on next sync
  }
  const bankCents = Math.round(bankBalance * 100);

  // Sum existing Actual balance for this account.
  let actualCents;
  try {
    if (typeof actual.getAccountBalance === "function") {
      const bal = await actual.getAccountBalance(mapping.actualAccountId);
      actualCents = Math.round(Number(bal) * 100); // SDK returns cents in some versions, dollars in others
      // Heuristic: if value is suspiciously large vs the bank's, assume it was already in cents
      if (Math.abs(actualCents) > Math.abs(bankCents) * 1000) {
        actualCents = Math.round(Number(bal));
      }
    } else {
      const txs = await actual.getTransactions(mapping.actualAccountId);
      actualCents = txs.reduce((s, t) => s + (t.amount || 0), 0);
    }
  } catch (err) {
    const txs = await actual.getTransactions(mapping.actualAccountId);
    actualCents = txs.reduce((s, t) => s + (t.amount || 0), 0);
  }

  const deltaCents = bankCents - actualCents;

  if (deltaCents === 0) {
    console.log(`   [${label}] Already balanced ($${(bankCents / 100).toFixed(2)}). Clearing reconcile flag.`);
    updateMappingState(mapping.id, {
      pendingReconcile: false,
      lastReconcileAt: new Date().toISOString(),
      lastReconcileDelta: 0,
    });
    return { delta: 0, bankBalance, actualBalance: actualCents / 100 };
  }

  // Date the adjustment one day before the oldest imported transaction (or today if none).
  const baseDate = oldestImportedDate || new Date().toISOString().slice(0, 10);
  const dt = new Date(baseDate + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() - 1);
  const adjustmentDate = dt.toISOString().slice(0, 10);

  console.log(`   [${label}] Reconcile: Actual=${(actualCents / 100).toFixed(2)} Bank=${bankBalance.toFixed(2)} Δ=${(deltaCents / 100).toFixed(2)}`);

  await actual.importTransactions(mapping.actualAccountId, [{
    date: adjustmentDate,
    amount: deltaCents,
    payee_name: "Starting Balance Adjustment",
    notes: `Auto-reconcile to bank balance ${bankBalance.toFixed(2)} on ${new Date().toISOString().slice(0, 10)}`,
    cleared: true,
    imported_id: `auto-reconcile-${mapping.id}-${Date.now()}`,
  }]);

  updateMappingState(mapping.id, {
    pendingReconcile: false,
    lastReconcileAt: new Date().toISOString(),
    lastReconcileDelta: deltaCents,
  });

  return { delta: deltaCents, bankBalance, actualBalance: actualCents / 100 };
}

// Sync one Plaid Item: pull the cursor delta, route transactions to this Item's
// mappings by account_id, import, handle removals, reconcile.
//
// The cursor is per-Item and shared by all its accounts, so this ALWAYS processes
// every mapping on the Item — syncing just one account would silently drop the
// others' transactions while advancing the shared cursor.
//
// Returns { perMapping: [stats], nextCursor, updateStatus, imported }.
async function syncOneItem({ item, mappings, plaidConfig, backupDir }) {
  const label = item.institution || item.itemId;
  console.log(`\n🏦 [${label}] Syncing from cursor ${item.cursor ? item.cursor.slice(0, 12) + "…" : "(start)"}`);

  const { added, modified, removed, nextCursor, accounts, updateStatus } =
    await transactionsSyncAll(plaidConfig, item.accessToken, item.cursor);

  // First sync right after linking: Plaid may still be preparing history.
  const isEmpty = added.length + modified.length + removed.length === 0;
  if (updateStatus === "TRANSACTIONS_UPDATE_STATUS_NOT_READY" && isEmpty) {
    console.log(`   [${label}] Initial transaction pull not ready yet — will retry next sync`);
    return { perMapping: [], nextCursor: null, updateStatus, imported: false };
  }

  const accountById = new Map(accounts.map(a => [a.account_id, a]));

  // Route updates to mappings by Plaid account_id
  const upsertsByAccount = new Map();
  for (const txn of [...added, ...modified]) {
    if (!upsertsByAccount.has(txn.account_id)) upsertsByAccount.set(txn.account_id, []);
    upsertsByAccount.get(txn.account_id).push(txn);
  }
  const removedByAccount = new Map();
  for (const r of removed) {
    if (!removedByAccount.has(r.account_id)) removedByAccount.set(r.account_id, new Set());
    removedByAccount.get(r.account_id).add(r.transaction_id);
  }

  const perMapping = [];
  for (const mapping of mappings) {
    const mLabel = mapping.name || mapping.id;
    const rawUpserts = upsertsByAccount.get(mapping.plaidAccountId) || [];
    const removedIds = removedByAccount.get(mapping.plaidAccountId) || new Set();

    let result = { added: [], updated: [] };
    let oldestImportedDate = null;

    if (rawUpserts.length > 0) {
      const transactions = transformTransactions(rawUpserts);
      oldestImportedDate = transactions.reduce(
        (min, t) => (min == null || t.date < min ? t.date : min),
        null
      );
      console.log(`   [${mLabel}] Importing ${transactions.length} transactions to Actual account ${mapping.actualAccountId}`);
      result = await actual.importTransactions(mapping.actualAccountId, transactions);

      // Per-mapping backup
      const currentDate = new Date().toISOString().split("T")[0];
      const backupFile = path.join(backupDir, `transactions_${currentDate}_${mapping.id}.json`);
      fs.writeFileSync(backupFile, JSON.stringify(transactions, null, 2));
    } else {
      console.log(`   [${mLabel}] No new transactions`);
    }

    const deleted = await deleteRemovedTransactions(mapping.actualAccountId, removedIds);
    if (deleted > 0) console.log(`   [${mLabel}] Deleted ${deleted} removed/reversed transaction(s)`);

    // Auto-reconcile if requested (uses the balance that came back with the sync)
    let reconcileResult = null;
    try {
      reconcileResult = await maybeReconcile({
        mapping,
        plaidAccount: accountById.get(mapping.plaidAccountId),
        oldestImportedDate,
      });
    } catch (err) {
      console.error(`   [${mLabel}] Reconcile failed:`, err.message);
      // don't fail the sync — leave pendingReconcile true
    }

    perMapping.push({
      mappingId: mapping.id,
      name: mLabel,
      fetched: rawUpserts.length,
      added: result.added.length,
      updated: result.updated.length,
      deleted,
      reconcile: reconcileResult,
    });
  }

  return { perMapping, nextCursor, updateStatus, imported: true };
}

// Group active mappings by their Item. Returns [{ item, mappings }] plus buckets
// of skipped mappings for reporting.
function planItemSyncs(config) {
  const itemsById = new Map(config.items.map(it => [it.itemId, it]));
  const byItem = new Map();
  const invalid = [];
  const disabled = [];

  for (const m of config.mappings) {
    if (m.disabled) {
      disabled.push({ mappingId: m.id, name: m.name });
      continue;
    }
    if (!m.plaidAccountId || !m.actualAccountId || !m.itemId || !itemsById.has(m.itemId)) {
      invalid.push({ mappingId: m.id, name: m.name, reason: "missing fields or unknown item (legacy mapping?)" });
      continue;
    }
    if (!byItem.has(m.itemId)) byItem.set(m.itemId, []);
    byItem.get(m.itemId).push(m);
  }

  const plans = [...byItem.entries()].map(([itemId, mappings]) => ({
    item: itemsById.get(itemId),
    mappings,
  }));
  return { plans, invalid, disabled };
}

// Shared per-item runner: syncs, persists cursor + item/mapping state, logs.
// Returns { ok, perMapping } — never throws for item-level failures.
async function runItemSync({ item, mappings, plaidConfig, backupDir }) {
  try {
    const { perMapping, nextCursor, imported } =
      await syncOneItem({ item, mappings, plaidConfig, backupDir });

    // Persist the cursor ONLY after every mapping's import succeeded —
    // a failed run re-fetches the same window and dedups by imported_id.
    if (imported && nextCursor) {
      updateItemState(item.itemId, {
        cursor: nextCursor,
        lastSyncedAt: new Date().toISOString(),
        needsReconnect: false,
        lastError: null,
      });
    }

    for (const stats of perMapping) {
      updateMappingState(stats.mappingId, {
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: "success",
        lastSyncStats: { fetched: stats.fetched, added: stats.added, updated: stats.updated, deleted: stats.deleted },
        lastError: null,
        needsReconnect: false,
      });
    }

    return { ok: true, perMapping };
  } catch (err) {
    const isAuth = err instanceof PlaidApiError && err.needsReconnect;
    const message = err?.message || String(err);
    console.error(`❌ [${item.institution || item.itemId}] sync failed:`, err);

    updateItemState(item.itemId, {
      needsReconnect: isAuth,
      lastError: message,
    });
    for (const m of mappings) {
      updateMappingState(m.id, {
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: isAuth ? "auth_error" : "error",
        lastError: message,
        needsReconnect: isAuth,
      });
    }

    return {
      ok: false,
      isAuth,
      message,
      perMapping: mappings.map(m => ({ mappingId: m.id, name: m.name || m.id, message, isAuth })),
    };
  }
}

// Sync the Item that contains the given mapping. Used by the per-mapping "Sync"
// button — the whole Item syncs (shared cursor), stats returned for the mapping.
async function runSyncForMapping(mappingId) {
  const config = loadConfig();
  const mapping = (config.mappings || []).find(m => m.id === mappingId);
  if (!mapping) throw new Error(`Mapping not found: ${mappingId}`);

  const { plans } = planItemSyncs(config);
  const plan = plans.find(p => p.mappings.some(m => m.id === mappingId));
  if (!plan) throw new Error(`Mapping ${mappingId} is incomplete, disabled, or its bank Item is missing`);

  if (!config.actual.serverURL || !config.actual.password || !config.actual.syncId) {
    throw new Error("Missing Actual Budget configuration (serverURL/password/syncId)");
  }

  let initOk = false;
  try {
    await initActual(config);
    initOk = true;

    const backupDir = path.join(__dirname, "transaction-data");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const result = await runItemSync({ ...plan, plaidConfig: config.plaid, backupDir });
    await actual.shutdown();

    if (!result.ok) {
      const err = new Error(result.message);
      err.needsReconnect = result.isAuth;
      throw err;
    }

    const stats = result.perMapping.find(s => s.mappingId === mappingId)
      || { mappingId, fetched: 0, added: 0, updated: 0, deleted: 0 };
    saveSyncLog("SUCCESS", `Mapping sync: ${mapping.name}`, { mappingId, ...stats });
    return stats;
  } catch (error) {
    if (initOk) { try { await actual.shutdown(); } catch (_) {} }
    saveSyncLog("ERROR", `Mapping sync failed: ${mapping.name}: ${error?.message}`, { mappingId });
    throw error;
  }
}

// Main sync — iterates all Items, isolating failures per Item
async function runSync() {
  console.log("🔄 Starting sync process...");

  let initOk = false;
  try {
    const config = loadConfig();

    if (!config.plaid.clientId || !config.plaid.secret) {
      throw new Error("Missing Plaid configuration (clientId/secret). Configure it via /connect first.");
    }
    if (!config.actual.serverURL || !config.actual.password || !config.actual.syncId) {
      throw new Error("Missing Actual Budget configuration (serverURL/password/syncId)");
    }

    const { plans, invalid, disabled } = planItemSyncs(config);
    if (plans.length === 0) {
      throw new Error("No active account mappings configured. Add at least one mapping in the admin UI.");
    }

    console.log(`✓ Syncing ${plans.length} bank connection(s), ${plans.reduce((n, p) => n + p.mappings.length, 0)} mapping(s)`);

    await initActual(config);
    initOk = true;

    const backupDir = path.join(__dirname, "transaction-data");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const perMapping = [];
    for (const plan of plans) {
      const result = await runItemSync({ ...plan, plaidConfig: config.plaid, backupDir });
      perMapping.push(...result.perMapping.map(s => ({ ok: result.ok, ...s })));
    }

    const totals = perMapping.reduce(
      (acc, r) => ({
        fetched: acc.fetched + (r.fetched || 0),
        added: acc.added + (r.added || 0),
        updated: acc.updated + (r.updated || 0),
        deleted: acc.deleted + (r.deleted || 0),
        succeeded: acc.succeeded + (r.ok ? 1 : 0),
        failed: acc.failed + (r.ok ? 0 : 1),
      }),
      { fetched: 0, added: 0, updated: 0, deleted: 0, succeeded: 0, failed: 0 }
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
    console.log(`   Mappings: ${totals.succeeded}/${perMapping.length} succeeded, ${invalid.length} invalid, ${disabled.length} disabled`);
    console.log(`   Fetched: ${totals.fetched}, Added: ${totals.added}, Updated: ${totals.updated}, Deleted: ${totals.deleted}`);

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

export {
  runSync,
  runSyncForMapping,
  loadConfig,
  saveMappings,
  saveItems,
  savePlaidConfig,
  updateMappingState,
  updateItemState,
  newMappingId,
};
