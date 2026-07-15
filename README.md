# Quiltt → Actual Budget Sync

Automated bank transaction sync from [Quiltt](https://quiltt.io) to [Actual Budget](https://actualbudget.org). Self-hosted, Docker-ready, with a web UI for setup and administration. Perfect for homelabbers running CasaOS or any Docker environment.

> **⚠️ v2.0 — Teller replaced with Quiltt.** Teller's API service has been discontinued, so this project migrated to Quiltt as its bank data aggregator. Quiltt routes through Plaid, MX, Finicity and Akoya under the hood, requires **no mTLS certificates**, and normalizes data across providers. Existing Teller configs cannot be migrated automatically — you'll need to reconnect your banks through the `/connect` page. See [Migrating from Teller](#-migrating-from-teller-v1x).

## ✨ Features

- 🏦 **Bank connections via Quiltt Connector** — connect any institution supported by Plaid/MX/Finicity through one widget
- 🔁 **Automated scheduled sync** — cron-based, defaults to daily
- 🧩 **Account mappings** — pair any number of bank accounts with Actual Budget accounts
- ⚖️ **Auto-reconcile** — align Actual balances with the bank's reported balance
- 🆔 **Stable transaction IDs** — Quiltt IDs are used as `imported_id` for reliable dedup
- 🔧 **Web setup wizard + admin dashboard** — no manual config file editing needed
- 🐳 **Docker & CasaOS ready**
- 🔐 **No certificates** — plain API-key auth; secrets never leave your server

## 🚀 Quick Start (5 Minutes)

### Prerequisites

- Docker & Docker Compose
- A running [Actual Budget server](https://actualbudget.org/docs/install/)
- A free [Quiltt Dashboard](https://dashboard.quiltt.dev) account

### Step 1: Get Quiltt Credentials

1. Sign up at the [Quiltt Dashboard](https://dashboard.quiltt.dev)
2. Inside your Environment, copy your **API Key secret**
3. Create a **Connector** (enable the aggregation provider(s) you want) and copy its **Connector ID**

> **Sandbox first:** Quiltt Environments come in Sandbox and Production flavors. Use a Sandbox environment with the Mock provider to test the full flow before connecting real banks. Production connections are billed per Quiltt's pricing — check [quiltt.io/pricing](https://www.quiltt.io/) before going live.

### Step 2: Run the Container

```bash
# Pull the Docker image
docker compose up -d

# Or build locally
git clone https://github.com/noelpena/teller-actual-sync.git
cd teller-actual-sync
docker compose up -d --build
```

### Step 3: Complete Setup in Your Browser

1. Open `http://localhost:8001` — you'll be redirected to the setup flow
2. **`/connect`**: enter your Quiltt API secret + Connector ID, then connect your bank through the Quiltt Connector
3. **`/setup`**: enter your Actual Budget server URL, password, and budget Sync ID
4. **`/admin` → Account Mappings**: pair each bank account with an Actual account (create new ones on the fly)
5. Hit **Sync Now** — done 🎉

## 📚 Detailed Setup Guide

### How Authentication Works

Quiltt uses two credential scopes — both handled automatically by this app:

| Credential | Where it's used | Notes |
|---|---|---|
| API Key secret | Server-side only | Stored in `config/config.json`, never sent to the browser |
| Session token | Browser (Connector widget) | Short-lived (24h), issued server-side per launch |
| Profile ID | Server-side GraphQL | Auto-created on first connect; all bank connections live under this single "household" profile |

The sync itself authenticates server-to-server with `Basic profileId:apiSecret` — no token rotation, no expiry, no rate limits.

### Finding Your Actual Budget Sync ID

1. Open Actual Budget
2. Settings → **Show Advanced Settings**
3. Copy the **Sync ID**

Bank-to-Actual account pairing happens in the admin UI, so you don't need to hunt for Actual account IDs manually.

## 🐳 Docker Deployment

### Using Docker Compose (Recommended)

See [docker-compose.yml](docker-compose.yml). Volumes persist config, logs, transaction backups, and Actual's data cache:

```yaml
volumes:
  - ./config:/app/config
  - ./logs:/app/logs
  - ./transaction-data:/app/transaction-data
  - ./actual-data:/app/actual-data
```

### Using Docker Run

```bash
docker run -d \
  --name quiltt-actual-sync \
  -p 8001:8001 \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/transaction-data:/app/transaction-data \
  -v $(pwd)/actual-data:/app/actual-data \
  -e TZ=America/New_York \
  noelpena/teller-actual-sync:latest
```

## 🔧 Configuration

### How Configuration Works

Everything is stored in `config/config.json` (created by the setup wizard). Environment variables act as fallbacks when a config value is missing:

| Env var | config.json equivalent |
|---|---|
| `QUILTT_API_SECRET` | `quiltt.apiSecret` |
| `QUILTT_CONNECTOR_ID` | `quiltt.connectorId` |
| `QUILTT_PROFILE_ID` | `quiltt.profileId` (auto-managed) |
| `ACTUAL_SERVER_URL` | `actual.serverURL` |
| `ACTUAL_PASSWORD` | `actual.password` |
| `ACTUAL_SYNC_ID` | `actual.syncId` |
| `DAYS_TO_SYNC` | `sync.daysToSync` |
| `CRON_SCHEDULE` | `sync.cronSchedule` |

See [config/config.json.example](config/config.json.example) for the full schema, including account mappings.

### Cron Schedule Examples

| Schedule | Expression |
|---|---|
| Daily at 2 AM | `0 2 * * *` |
| Every 6 hours | `0 */6 * * *` |
| Twice daily (8 AM, 8 PM) | `0 8,20 * * *` |
| Weekly (Monday midnight) | `0 0 * * 1` |

## 📊 Admin Dashboard

Open `http://localhost:8001/admin`:

- **Dashboard** — sync status, setup health, current config at a glance
- **Configuration** — edit Quiltt/Actual credentials and sync settings
- **Account Mappings** — connect banks, pair accounts, per-mapping sync/reconcile/repair
- **Sync Logs** — last 50 sync runs with per-mapping stats

When a bank connection breaks (expired login, MFA change), the affected mappings show **Needs reconnect** with a **Repair** button that launches Quiltt's reconnect flow.

## 🔌 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/manual-sync` | Run a full sync across all mappings |
| `GET` | `/sync-logs` | Recent sync logs (JSON) |
| `GET` | `/ping` | Health check |
| `GET` | `/api/config/status` | Configuration completeness |
| `POST` | `/api/quiltt/session` | Issue a Connector session token |
| `GET` | `/api/quiltt/accounts` | List Quiltt accounts (+ connection status, balance) |
| `POST` | `/api/test/quiltt` | Verify Quiltt credentials |
| `POST` | `/api/test/actual` | Verify Actual Budget connection |
| `GET/POST/PATCH/DELETE` | `/api/mappings[...]` | Manage account mappings |
| `POST` | `/api/mappings/:id/sync` | Sync one mapping |
| `POST` | `/api/mappings/:id/reconcile` | Reconcile one mapping to the bank balance |

### Example: Trigger Manual Sync

```bash
curl -X POST http://localhost:8001/manual-sync
```

## 🏠 CasaOS Installation

Import [docker-compose.yml](docker-compose.yml) through CasaOS's **Install a customized app** — the `x-casaos` metadata auto-configures the web UI port and icon.

## 🔄 Migrating from Teller (v1.x)

Teller account IDs and access tokens have no Quiltt equivalent, so mappings can't be carried over — but your Actual accounts and history are untouched:

1. Update to the v2 image and restart
2. Go to `/connect`, enter Quiltt credentials, and reconnect each bank
3. In **Account Mappings**, map each bank account to its **existing** Actual account (pick "Use existing Actual account" — don't create duplicates)
4. Old Teller mappings are ignored by the sync; delete them from the mappings list when ready

Duplicate protection: transactions are imported with Quiltt's stable IDs and matched against existing entries by Actual's fuzzy dedup (same amount/date), so re-mapping to the same Actual account won't double-import recent history in most cases. Consider setting **Days to Sync** low (e.g. 3) for the first Quiltt sync.

## 🔍 Troubleshooting

### Setup wizard shows "Configuration incomplete"

Check `/api/config/status`. You need: Quiltt credentials + at least one valid mapping + Actual server config.

### Quiltt test fails with 401

Your API Key secret is wrong or belongs to a different environment than your Connector. Both must come from the same Quiltt Environment.

### Session token rate limit (429)

Quiltt limits session tokens to 10/hour per profile. Sessions are only used to open the Connector widget — wait an hour or revoke unused tokens. Syncs are unaffected (they use Basic auth).

### Accounts don't appear right after connecting

Quiltt syncs new connections in the background; accounts can take ~10-30 seconds to appear. The UI polls automatically — use **Map Unmapped Accounts** if you closed the picker too early.

### Mapping shows "Needs reconnect"

The bank link broke upstream (changed password, expired MFA). Click **Repair** on the mapping to relaunch the Connector's reconnect flow.

### Actual Budget connection fails

- Verify the server URL is reachable **from inside the container** (use container-network hostnames, not `localhost`)
- Confirm the password and Sync ID

### View detailed logs

```bash
# Container logs
docker logs -f quiltt-actual-sync

# Sync logs (JSON format)
cat logs/sync.log

# Via API
curl http://localhost:8001/sync-logs
```

## 📁 File Structure

```
.
├── server.js           # Express server: web UI, admin API, cron scheduler
├── sync.js             # Sync engine: fetch → transform → import → reconcile
├── quiltt.js           # Quiltt API client (GraphQL + sessions)
├── static/             # Web UI (connect, setup wizard, admin dashboard)
├── config/             # config.json (created by setup wizard)
├── logs/               # sync.log
├── transaction-data/   # Per-sync JSON backups
└── actual-data/        # Actual Budget local data cache
```

## 🛠️ How It Works

### Architecture Overview

```
┌─────────────┐   Connector widget    ┌────────────┐
│   Browser   │──────────────────────▶│   Quiltt   │──▶ Plaid / MX / Finicity / Akoya
└──────┬──────┘                       └─────┬──────┘
       │ session token                      │ GraphQL (Basic auth)
┌──────▼──────────────────────────────┐     │
│  quiltt-actual-sync (this app)      │◀────┘
│  • issues session tokens            │
│  • fetches transactions & balances  │     ┌───────────────┐
│  • transforms & imports             │────▶│ Actual Budget │
│  • cron scheduler                   │     └───────────────┘
└─────────────────────────────────────┘
```

### Sync Process

1. Load config + mappings
2. Init Actual SDK, download budget
3. For each enabled mapping:
   - Query Quiltt GraphQL for transactions since `daysToSync` ago (cursor-paginated)
   - Check the connection status — flag **Needs reconnect** if the bank link broke
   - Transform to Actual's format (`imported_id` = Quiltt transaction ID, `cleared` = POSTED)
   - Import via `importTransactions` (dedup by imported_id + fuzzy matching)
   - Optionally reconcile the balance
4. Persist per-mapping stats, write sync log, shut down the SDK

### Data Conventions

- **Amounts**: Quiltt normalizes signs across providers — positive = money in, negative = money out. Matches Actual directly, no flipping.
- **Balances**: liability accounts (credit cards, loans) report negative balances when money is owed — also matching Actual's convention, which makes reconcile accurate for credit cards.

## 🔐 Security Best Practices

- Keep your Quiltt **API Key secret** server-side — it's stored in `config/config.json`; never expose that volume publicly
- Run behind a reverse proxy with auth (the admin UI has no built-in login)
- Use HTTPS if exposing beyond your LAN
- Bind the port to localhost or your LAN interface: `127.0.0.1:8001:8001`

## 🤝 Contributing

### Development Setup

```bash
# Clone repository
git clone https://github.com/noelpena/teller-actual-sync.git
cd teller-actual-sync

# Install dependencies
npm install

# Run locally (requires config/config.json or env vars)
npm run dev

# Build Docker image
docker build -t quiltt-actual-sync .
```

## 📄 License

MIT

## 🙏 Acknowledgments

- [Actual Budget](https://actualbudget.org) — the excellent open-source budgeting app
- [Quiltt](https://quiltt.io) — unified open-banking API
- Originally built on [Teller](https://teller.io) (v1.x), migrated after Teller's API discontinuation

## 📞 Support

Open an issue on GitHub.
