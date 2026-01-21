Teller → Actual Budget Sync
Automated Docker container that syncs bank transactions from Teller to Actual Budget. Perfect for homelabbers running CasaOS or any Docker environment.

Features
🔄 Automated Daily Sync - Runs on schedule via cron (default: 2 AM daily)
🏠 Self-Hosted - Runs entirely on your homelab
🐳 Docker Ready - Easy deployment with Docker Compose
📊 Logging - Track sync history and status
🔒 Secure - All credentials stay on your local network
🎯 Manual Sync - Trigger sync anytime via API endpoint
Quick Start
1. Prerequisites
Docker & Docker Compose installed
Teller account with API access token
Actual Budget server running (self-hosted or cloud)
Your bank account connected to Teller
2. Clone & Configure
bash
# Clone the repository
git clone <your-repo-url>
cd teller-actual-sync

# Copy example environment file
cp .env.example .env

# Edit .env with your credentials
nano .env
3. Get Required IDs
Teller Access Token & Account ID:

Log into Teller Connect in the web UI (http://localhost:8001)
Connect your bank account
Copy the Access Token and Account ID from the status bar
Actual Budget Info:

Open your Actual Budget server
Go to Settings → Show Advanced Settings → Sync ID (copy this)
In the account list, click on the account you want to sync
The account ID is in the URL: /accounts/{ACCOUNT_ID}
4. Run with Docker Compose
bash
# Build and start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Check sync logs
docker-compose exec teller-actual-sync cat logs/sync.log
5. Test Manual Sync
bash
# Trigger a manual sync
curl -X POST http://localhost:8001/manual-sync

# View sync logs via API
curl http://localhost:8001/sync-logs
Configuration
Environment Variables
Variable	Description	Default	Required
APP_ID	Teller Application ID	-	✅
TELLER_ACCESS_TOKEN	Teller access token	-	✅
TELLER_ACCOUNT_ID	Teller account ID to sync	-	✅
ACTUAL_SERVER_URL	Actual Budget server URL	-	✅
ACTUAL_PASSWORD	Actual Budget password	-	✅
ACTUAL_SYNC_ID	Budget sync ID	-	✅
ACTUAL_ACCOUNT_ID	Actual account ID	-	✅
DAYS_TO_SYNC	Days of transactions to fetch	7	❌
CRON_SCHEDULE	Cron schedule for auto-sync	0 2 * * *	❌
TZ	Timezone	America/New_York	❌
Cron Schedule Examples
0 2 * * * - Daily at 2 AM
0 */6 * * * - Every 6 hours
0 8,20 * * * - Twice daily at 8 AM and 8 PM
0 0 * * 1 - Weekly on Monday at midnight
CasaOS Installation
Option 1: Docker Compose (Recommended)
Open CasaOS
Go to App Store → Custom Install
Upload the docker-compose.yml file
Fill in environment variables
Click Install
Option 2: Manual Docker Command
bash
docker run -d \
  --name teller-actual-sync \
  --restart unless-stopped \
  -p 8001:8001 \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/transaction-data:/app/transaction-data \
  -v $(pwd)/actual-data:/app/actual-data \
  -e APP_ID=your_app_id \
  -e TELLER_ACCESS_TOKEN=your_token \
  -e TELLER_ACCOUNT_ID=your_account_id \
  -e ACTUAL_SERVER_URL=http://your-actual:5006 \
  -e ACTUAL_PASSWORD=your_password \
  -e ACTUAL_SYNC_ID=your_sync_id \
  -e ACTUAL_ACCOUNT_ID=your_actual_account_id \
  teller-actual-sync
API Endpoints
GET / - Teller Connect web interface
POST /manual-sync - Trigger manual sync
GET /sync-logs - View recent sync logs (last 50)
GET /ping - Health check
Troubleshooting
Sync not running
bash
# Check if container is running
docker ps

# Check logs for errors
docker-compose logs -f

# Verify cron schedule
docker-compose exec teller-actual-sync cat /etc/crontabs/root
Transactions not importing
Verify Teller access token is valid
Check Actual Budget server is accessible from container
Confirm ACTUAL_ACCOUNT_ID matches the account in Actual Budget
Review sync logs: curl http://localhost:8001/sync-logs
Connection errors
bash
# Test Actual Budget connection
docker-compose exec teller-actual-sync wget -O- http://your-actual-server:5006

# Test Teller API
docker-compose exec teller-actual-sync wget -O- --header="Authorization: Bearer your_token" https://api.teller.io/accounts
File Structure
.
├── teller.js              # Main server with cron
├── sync.js                # Standalone sync script
├── Dockerfile             # Container definition
├── docker-compose.yml     # Docker Compose config
├── package.json           # Node dependencies
├── .env                   # Your configuration (create this)
├── config/                # Volume: persistent config
├── logs/                  # Volume: sync logs
├── transaction-data/      # Volume: transaction backups
└── actual-data/           # Volume: Actual Budget cache
Next Steps (Phase 2)
🎨 Admin UI for configuration management
📊 Sync status dashboard
🔔 Email/webhook notifications
🏦 Multi-account support
📝 Transaction categorization rules
Contributing
This project is designed for the Actual Budget homelab community. Contributions welcome!

License
MIT License - Feel free to use and modify for personal use.

