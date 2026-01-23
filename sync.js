import dotenv from "dotenv";
import * as actual from "@actual-app/api";
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Load config from file or env vars
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

  // Merge with env vars (config.json takes priority, env vars as fallback)
  return {
    teller: {
      appId: fileConfig.teller?.appId || process.env.APP_ID,
      accessToken: fileConfig.teller?.accessToken || process.env.TELLER_ACCESS_TOKEN,
      accountId: fileConfig.teller?.accountId || process.env.TELLER_ACCOUNT_ID,
      env: fileConfig.teller?.env || fileConfig.teller?.environment || process.env.ENV || "sandbox",
      certPath: fileConfig.teller?.certPath || process.env.CERT,
      certKeyPath: fileConfig.teller?.certKeyPath || process.env.CERT_KEY,
    },
    actual: {
      dataDir: fileConfig.actual?.dataDir || process.env.ACTUAL_DATA_DIR || "/app/actual-data",
      serverURL: fileConfig.actual?.serverURL || process.env.ACTUAL_SERVER_URL,
      password: fileConfig.actual?.password || process.env.ACTUAL_PASSWORD,
      syncId: fileConfig.actual?.syncId || process.env.ACTUAL_SYNC_ID,
      accountId: fileConfig.actual?.accountId || process.env.ACTUAL_ACCOUNT_ID,
    },
    sync: {
      daysToSync: fileConfig.sync?.daysToSync || parseInt(process.env.DAYS_TO_SYNC || "7"),
      cronSchedule: fileConfig.sync?.cronSchedule || process.env.CRON_SCHEDULE || "0 8 * * *",
    },
  };
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

// Fetch transactions from Teller
async function fetchTellerTransactions(config, startDate) {
  const { accessToken, accountId, env, certPath, certKeyPath } = config.teller;

  console.log(`🔍 Environment: ${env}`);

  // Setup HTTPS agent with certificates if not in sandbox
  let agent;
  if (env !== "sandbox" && certPath && certKeyPath) {
    if (fs.existsSync(certPath) && fs.existsSync(certKeyPath)) {
      agent = new https.Agent({
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(certKeyPath),
      });
      console.log(`🔐 Using mTLS certificates for ${env} environment`);
    } else {
      console.warn(`⚠️  Certificate files not found: ${certPath}, ${certKeyPath}`);
    }
  }

  // Use https.request for certificate support
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.teller.io",
      path: `/accounts/${accountId}/transactions?start_date=${startDate}`,
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accessToken}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      agent: agent,
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Failed to parse response: ${err.message}`));
          }
        } else {
          reject(new Error(`Teller API error: ${res.statusCode} ${res.statusMessage}\nDetails: ${data}`));
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Request failed: ${err.message}`));
    });

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

// Initialize Actual Budget
async function initActual(config) {
  await actual.init({
    dataDir: config.actual.dataDir,
    serverURL: config.actual.serverURL,
    password: config.actual.password,
  });

  if (config.actual.syncId) {
    await actual.downloadBudget(config.actual.syncId);
  } else {
    await actual.downloadBudget();
  }
}

// Save sync log
function saveSyncLog(status, message, stats = {}) {
  const logDir = path.join(__dirname, "logs");
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    status,
    message,
    stats,
  };

  const logFile = path.join(logDir, "sync.log");
  const logLine = JSON.stringify(logEntry) + "\n";
  
  fs.appendFileSync(logFile, logLine);
  console.log(`[${timestamp}] ${status}: ${message}`, stats);
}

// Main sync function
async function runSync() {
  console.log("🔄 Starting sync process...");
  console.log("⚙️  Loading configuration...");
  
  try {
    const config = loadConfig();
    
    console.log("✓ Config loaded:");
    console.log(`  - Teller Access Token: ${config.teller.accessToken ? '✓ Set' : '✗ Missing'}`);
    console.log(`  - Teller Account ID: ${config.teller.accountId ? '✓ Set' : '✗ Missing'}`);
    console.log(`  - Actual Server URL: ${config.actual.serverURL || '✗ Missing'}`);
    console.log(`  - Actual Account ID: ${config.actual.accountId || '✗ Missing'}`);
    console.log(`  - Days to Sync: ${config.sync.daysToSync}`);

    // Validate config
    if (!config.teller.accessToken || !config.teller.accountId) {
      throw new Error("Missing Teller configuration (accessToken, accountId)");
    }
    if (!config.actual.serverURL || !config.actual.password) {
      throw new Error("Missing Actual Budget configuration");
    }
    if (!config.actual.accountId) {
      throw new Error("Missing Actual Budget account ID - check ACTUAL_ACCOUNT_ID in .env");
    }

    // Initialize Actual
    console.log("📊 Connecting to Actual Budget...");
    await initActual(config);

    // Fetch transactions from Teller
    const startDate = getTransactionStartDate(config.sync.daysToSync);
    console.log(`🏦 Fetching transactions from Teller (since ${startDate})...`);

    const rawTransactions = await fetchTellerTransactions(config, startDate);

    if (!rawTransactions || rawTransactions.length === 0) {
      saveSyncLog("SUCCESS", "No new transactions to import", { count: 0 });
      await actual.shutdown();
      return;
    }

    // Transform and import
    console.log(`💾 Importing ${rawTransactions.length} transactions...`);
    const transactions = transformTransactions(rawTransactions);
    
    const result = await actual.importTransactions(config.actual.accountId, transactions);

    // Save backup
    const backupDir = path.join(__dirname, "transaction-data");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const currentDate = new Date().toISOString().split("T")[0];
    const backupFile = path.join(backupDir, `transactions_${currentDate}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(transactions, null, 2));

    // Log success
    saveSyncLog("SUCCESS", "Sync completed", {
      fetched: rawTransactions.length,
      added: result.added.length,
      updated: result.updated.length,
    });

    console.log("✅ Sync completed successfully!");
    console.log(`   - Added: ${result.added.length}`);
    console.log(`   - Updated: ${result.updated.length}`);

    await actual.shutdown();
  } catch (error) {
    saveSyncLog("ERROR", error.message);
    console.error("❌ Sync failed:", error);
    process.exit(1);
  }
}

// Run if called directly
const isMainModule = process.argv[1] && (
  import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` ||
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
);

if (isMainModule) {
  runSync()
    .then(() => {
      console.log("\n✅ Sync script completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n❌ Sync script failed:");
      console.error(error);
      process.exit(1);
    });
}

export { runSync, loadConfig };