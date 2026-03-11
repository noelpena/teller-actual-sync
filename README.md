# Teller → Actual Budget Sync

Automated Docker container that syncs bank transactions from Teller to Actual Budget. Perfect for homelabbers running CasaOS or any Docker environment.

## ✨ Features

- **🎯 Guided Setup Wizard** - No manual configuration needed!
- **🔄 Automated Daily Sync** - Runs on schedule via cron (customizable)
- **🏠 Self-Hosted** - Runs entirely on your homelab
- **🐳 Docker Ready** - Easy deployment with Docker Compose
- **📊 Admin Dashboard** - Monitor sync status and configure settings
- **🔒 Secure** - All credentials stay on your local network
- **⚡ Manual Sync** - Trigger sync anytime via dashboard or API

---

## 🚀 Quick Start (5 Minutes)

### Prerequisites

- **Docker & Docker Compose** installed
- **Teller account** (sign up at [teller.io](https://teller.io))
- **Teller mTLS certificates** (download from [Teller Dashboard](https://teller.io/dashboard/certificates))
- **Actual Budget server** running (self-hosted or cloud)

### Step 1: Get Teller Credentials

1. Visit [Teller Dashboard](https://teller.io/dashboard)
2. Create a new application (or use existing)
3. Copy your **Application ID** (starts with `app_`)
4. Download your **mTLS certificates**:
   - Go to **Certificates** section
   - Download `certificate.pem`
   - Download `private_key.pem`

### Step 2: Run the Container

```bash
# Pull the Docker image
docker pull noelpena/teller-actual-sync:latest

# Or build locally
git clone https://github.com/noelpena/teller-actual-sync.git
cd teller-actual-sync
docker-compose up -d
```

Start the container:

```bash
docker-compose up -d
```

### Step 3: Complete Setup in Your Browser

1. **Open the app**: Visit `http://<your-server-ip>:8001`
2. **Enter Teller credentials**:
   - Paste your Application ID
   - Upload your `certificate.pem` file
   - Upload your `private_key.pem` file
3. **Connect your bank**: Authenticate with your bank through Teller Connect
4. **Configure Actual Budget**: Enter your Actual Budget server details
5. **Done!** The sync will start automatically

That's it! The guided wizard handles everything - no manual token copying or config file editing.

---

## 📚 Detailed Setup Guide

### Getting Teller API Credentials

#### Application ID (Required for all modes)

1. Visit [Teller Dashboard](https://teller.io/dashboard)
2. Create a new application or select existing
3. Copy your **Application ID** (starts with `app_`)
4. You'll enter this during the setup wizard

#### mTLS Certificates (Required for Development & Production)

Teller requires client certificates for API authentication. The setup wizard will guide you through uploading these.

**To download your certificates:**

1. Visit [Teller Dashboard - Certificates](https://teller.io/dashboard/certificates)
2. Download **Certificate** (`certificate.pem`)
3. Download **Private Key** (`private_key.pem`)
4. Keep these files secure - you'll upload them during setup

**Certificate Requirements by Environment:**
- **Sandbox**: No certificates needed (test mode only)
- **Development**: Certificates required (connects to real banks in test mode)
- **Production**: Certificates required (connects to real banks in live mode)

**Note**: The default environment is `development`, so certificates are required for initial setup.

[Learn more about Teller authentication](https://teller.io/docs/api/authentication)

### Finding Your Actual Budget IDs

#### Sync ID
1. Open Actual Budget
2. Go to **Settings** (gear icon)
3. Click **"Show Advanced Settings"**
4. Copy the **Sync ID**

#### Account ID
1. Open the account you want to sync in Actual Budget
2. Look at the browser URL bar
3. Copy the ID after `/accounts/`
   - Example: `https://actual.yourdomain.com/accounts/abc123-def456-ghi789`
   - Your Account ID is: `abc123-def456-ghi789`

---

## 🐳 Docker Deployment

### Using Docker Compose (Recommended)

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  teller-actual-sync:
    image: noelpena/teller-actual-sync:latest
    # Or build locally:
    # build: .
    container_name: teller-actual-sync
    restart: always
    ports:
      - "8001:8001"
    environment:
      - TZ=${TZ:-America/New_York}
    volumes:
      - ./config:/app/config
      - ./logs:/app/logs
      - ./transaction-data:/app/transaction-data
      - ./actual-data:/app/actual-data
      - ./certs:/app/certs
```

Start:

```bash
docker-compose up -d
```

**Note**: No manual configuration is needed! The guided setup wizard handles everything:
- Teller Application ID and mTLS certificate upload
- Bank connection via Teller Connect
- Actual Budget configuration
- Sync schedule settings

All settings are saved to `config/config.json` automatically.

### Using Docker Run

```bash
docker run -d \
  --name teller-actual-sync \
  --restart always \
  -p 8001:8001 \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/transaction-data:/app/transaction-data \
  -v $(pwd)/actual-data:/app/actual-data \
  -v $(pwd)/certs:/app/certs \
  -e TZ=America/New_York \
  noelpena/teller-actual-sync:latest
```

Then visit `http://<your-server-ip>:8001` to complete setup through the guided wizard.

---

## 🔧 Configuration

### How Configuration Works

All configuration is stored in **`config/config.json`**, which is created and managed automatically by the setup wizard. You should not need to edit this file manually.

Example `config.json` structure:

```json
{
  "teller": {
    "appId": "app_xxxxxxxxxxxxx",
    "accessToken": "token_xxxxxxxxxxxxx",
    "accountId": "acc_xxxxxxxxxxxxx",
    "env": "development",
    "certPath": "/app/certs/certificate.pem",
    "certKeyPath": "/app/certs/private_key.pem"
  },
  "actual": {
    "dataDir": "/app/actual-data",
    "serverURL": "http://your-actual-server:5006",
    "password": "your_password",
    "syncId": "your-budget-sync-id",
    "accountId": "your-account-id"
  },
  "sync": {
    "daysToSync": 7,
    "cronSchedule": "0 8 * * *"
  }
}
```

### Docker Compose Environment Variables

The only environment variable you may want to set in `docker-compose.yml` is your timezone:

| Variable | Description | Default |
|----------|-------------|---------|
| `TZ` | Timezone for cron scheduling | `America/New_York` |

All other settings (Teller credentials, Actual Budget config, sync schedule) are managed through `config/config.json` via the setup wizard or admin dashboard.

### Cron Schedule Examples

- `0 8 * * *` - Daily at 8 AM (default)
- `0 */6 * * *` - Every 6 hours
- `0 8,20 * * *` - Twice daily (8 AM and 8 PM)
- `*/30 * * * *` - Every 30 minutes
- `0 0 * * 1` - Weekly on Monday at midnight

[Test your cron expression](https://crontab.guru/)

---

## 📊 Admin Dashboard

Access the admin dashboard at `http://<your-server-ip>:8001/admin`

### Dashboard Features

- **Setup Status**: See if Teller and Actual Budget are connected
- **Sync Status**: View last sync time, status, and transaction count
- **Manual Sync**: Trigger immediate sync
- **Configuration**: Edit all settings without restarting
- **Sync Logs**: View detailed sync history
- **Connection Testing**: Test Teller and Actual Budget connections

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Smart redirect to setup or admin |
| `GET` | `/connect` | Teller setup (APP_ID + certs or Connect) |
| `GET` | `/setup` | Actual Budget setup wizard |
| `GET` | `/admin` | Admin dashboard |
| `POST` | `/manual-sync` | Trigger immediate sync |
| `GET` | `/sync-logs` | Get last 50 sync logs (JSON) |
| `GET` | `/ping` | Health check |
| `GET` | `/api/config/status` | Check configuration completeness |
| `POST` | `/api/setup/save-app-id-and-certs` | Save APP_ID and upload certificates |
| `POST` | `/api/setup/save-teller` | Save Teller credentials (auto-called) |
| `POST` | `/api/setup/save-actual` | Save Actual Budget config |
| `POST` | `/api/test/teller` | Test Teller API connection |
| `POST` | `/api/test/actual` | Test Actual Budget connection |
| `POST` | `/admin/api/certificates/upload` | Upload certificates from admin panel |
| `GET` | `/admin/api/certificates/status` | Check certificate upload status |

### Example: Trigger Manual Sync

```bash
curl -X POST http://localhost:8001/manual-sync
```

Response:
```json
{
  "success": true,
  "message": "Sync completed successfully"
}
```

---

## 🏠 CasaOS Installation

### Method 1: Docker Compose (Recommended)

1. Open **CasaOS**
2. Go to **App Store** → **Custom Install**
3. Select **Docker Compose**
4. Paste the `docker-compose.yml` content
5. Click **Install**
6. Access via **My Apps** or visit `http://your-casaos-ip:8001`

### Method 2: Import from Docker Hub

1. Open **CasaOS App Store**
2. Click **Custom Install**
3. Select **Docker Image**
4. Enter: `noelpena/teller-actual-sync:latest`
5. Configure:
   - Port: `8001`
   - Volumes: Add the 5 volumes listed in docker-compose
6. Click **Install**

---

## 🔍 Troubleshooting

### Container won't start

```bash
# Check logs
docker-compose logs -f

# Common issues:
# - Port 8001 already in use
# - Volume permission issues
```

### Setup wizard shows "Configuration incomplete"

1. Clear browser cache
2. Delete `config/config.json` and restart:
   ```bash
   rm config/config.json
   docker-compose restart
   ```
3. Visit `http://localhost:8001` and complete setup again

### Certificate upload fails on /connect page

**Common issues:**
- Wrong file format - must be `.pem` files
- Files too large - should be under 10MB
- Corrupted certificate files - re-download from Teller Dashboard

**To verify certificates are uploaded:**
1. Check `certs/` directory for `certificate.pem` and `private_key.pem`
2. Check `config/config.json` contains `certPath` and `certKeyPath`

### Teller connection fails with "Missing certificate" error

This means certificates weren't properly uploaded or aren't being loaded:

1. **Re-upload certificates**: Visit `/connect` and upload both files again
2. **Check certificate location**:
   ```bash
   ls -la certs/
   # Should show: certificate.pem and private_key.pem
   ```
3. **Restart container** to reload certificates:
   ```bash
   docker-compose restart
   ```
4. **Verify config**:
   ```bash
   cat config/config.json
   # Should have "certPath" and "certKeyPath" fields
   ```

### Actual Budget connection fails

1. Verify server URL is accessible from the container
2. Check firewall rules
3. Test connection from container:
   ```bash
   docker-compose exec teller-actual-sync wget -O- http://your-actual-server:5006
   ```
4. Verify password is correct
5. Confirm Sync ID and Account ID are correct UUIDs

### Transactions not syncing

1. Check sync logs in admin dashboard
2. Verify account IDs match:
   - Teller Account ID (from bank connection)
   - Actual Budget Account ID (from URL)
3. Check `DAYS_TO_SYNC` setting (default: 7 days)
4. Trigger manual sync and watch for errors

### View detailed logs

```bash
# Container logs
docker-compose logs -f teller-actual-sync

# Sync logs (JSON format)
cat logs/sync.log

# Via API
curl http://localhost:8001/sync-logs | jq
```

---

## 📁 File Structure

```
teller-actual-sync/
├── teller.js              # Main Express server with routing
├── sync.js                # Standalone sync script
├── Dockerfile             # Container definition
├── docker-compose.yml     # Docker Compose configuration
├── package.json           # Node.js dependencies
├── static/                # Web UI files
│   ├── connect.html       # Teller Connect UI
│   ├── connect.js         # Teller Connect logic
│   ├── connect.css        # Teller Connect styles
│   ├── setup.html         # Actual Budget setup wizard
│   ├── setup.js           # Setup wizard logic
│   ├── setup.css          # Setup wizard styles
│   ├── admin.html         # Admin dashboard
│   └── admin.js           # Admin dashboard logic
├── config/                # 📂 Volume: Persistent configuration
│   └── config.json        # Auto-generated by setup wizard
├── logs/                  # 📂 Volume: Sync logs
│   └── sync.log           # JSON-formatted sync history
├── transaction-data/      # 📂 Volume: Transaction backups
│   └── transactions_*.json
├── actual-data/           # 📂 Volume: Actual Budget cache
└── certs/                 # 📂 Volume: mTLS certificates
    ├── certificate.pem
    └── private_key.pem
```

---

## 🛠️ How It Works

### Architecture Overview

```
┌──────────────┐         ┌──────────────────┐         ┌────────────────┐
│              │  OAuth  │                  │  Sync   │                │
│  Your Bank   │◄────────│  Teller API      │◄────────│  This App      │
│              │         │                  │         │                │
└──────────────┘         └──────────────────┘         └────────────────┘
                                                              │
                                                              │ Import
                                                              ▼
                                                       ┌────────────────┐
                                                       │                │
                                                       │ Actual Budget  │
                                                       │                │
                                                       └────────────────┘
```

### Sync Process

1. **Scheduled Trigger**: Cron job runs at configured time (default: daily at 8 AM)
2. **Fetch from Teller**: Retrieves last N days of transactions (default: 7)
3. **Transform Data**: Converts Teller format to Actual Budget format
4. **Import to Actual**: Uses Actual Budget API to import transactions
5. **Logging**: Records sync results (added, updated, skipped)
6. **Backup**: Saves transaction data to `transaction-data/` directory

### Data Flow

```
Teller Transaction Format:
{
  "amount": "-12.50",
  "date": "2025-01-20",
  "description": "Coffee Shop",
  "status": "posted",
  "details": {
    "counterparty": {
      "name": "Starbucks"
    }
  }
}

↓ Transform ↓

Actual Budget Format:
{
  "amount": -1250,  // cents
  "date": "2025-01-20",
  "payee_name": "Starbucks",
  "notes": "Imported from Teller",
  "cleared": true
}
```

---

## 🔐 Security Best Practices

1. **Use HTTPS**: If exposing outside your network, use a reverse proxy with SSL
2. **Network Isolation**: Keep on internal network, don't expose to internet
3. **Certificates**: Store mTLS certificates securely, never commit to git
4. **Passwords**: Use strong passwords for Actual Budget
5. **Backups**: Regularly backup your `config/` directory
6. **Updates**: Keep the Docker image updated

### Recommended Docker Compose Security

```yaml
services:
  teller-actual-sync:
    # ... other config ...
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
```

---

## 🎯 Use Cases

- **Homelab Enthusiasts**: Perfect for self-hosted budget management
- **Privacy-Focused Users**: All data stays on your infrastructure
- **Budget Automation**: Set it and forget it transaction imports
- **Multiple Accounts**: Configure multiple instances for different banks
- **Development**: Use development mode to import transactions for free

---

## 🚧 Roadmap

### Completed ✅
- ✅ Automated Teller token capture
- ✅ Guided setup wizard
- ✅ Admin dashboard
- ✅ Connection testing
- ✅ Config file management
- ✅ Docker Hub publishing

### Planned 🔜
- 🔜 Multi-account support (sync multiple banks)
- 🔜 Email/webhook notifications for sync failures
- 🔜 Transaction categorization rules
- 🔜 Sync frequency per account
- 🔜 Web-based log viewer with filtering
- 🔜 Account balance reconciliation

---

## 🤝 Contributing

Contributions are welcome! This project is designed for the Actual Budget homelab community.

### Development Setup

```bash
# Clone repository
git clone https://github.com/noelpena/teller-actual-sync.git
cd teller-actual-sync

# Install dependencies
npm install

# Run locally (requires .env or config.json)
node teller.js

# Build Docker image
docker build -t teller-actual-sync:dev .
```

### Submitting Changes

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

---

## 📄 License

MIT License - Feel free to use and modify for personal use.

---

## 🙏 Acknowledgments

- **[Teller](https://teller.io)** - Banking API platform
- **[Actual Budget](https://actualbudget.com)** - Open-source budgeting software
- **CasaOS Community** - For homelab inspiration

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/noelpena/teller-actual-sync/issues)

---

**Made with ❤️ for the self-hosted community**
