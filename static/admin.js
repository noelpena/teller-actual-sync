// Tab switching
document.querySelectorAll('.tab-button').forEach(button => {
  button.addEventListener('click', () => {
    const tabName = button.dataset.tab;
    
    // Update button states
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.classList.remove('active', 'text-blue-600', 'border-blue-600');
      btn.classList.add('text-gray-500', 'border-transparent');
    });
    button.classList.add('active', 'text-blue-600', 'border-blue-600');
    button.classList.remove('text-gray-500', 'border-transparent');
    
    // Show/hide tabs
    document.querySelectorAll('.tab-content').forEach(tab => {
      tab.classList.add('hidden');
    });
    document.getElementById(`${tabName}-tab`).classList.remove('hidden');
    
    // Load data for the tab
    if (tabName === 'dashboard') loadDashboard();
    if (tabName === 'config') loadConfig();
    if (tabName === 'logs') loadLogs();
  });
});

// Toast notification
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toastMessage');
  
  toastMessage.textContent = message;
  toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg text-white ${
    type === 'success' ? 'bg-green-600' : 'bg-red-600'
  }`;
  toast.classList.remove('hidden');
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}

// Load Dashboard
async function loadDashboard() {
  try {
    // Load last sync status
    const logsRes = await fetch('/admin/api/logs');
    const { logs } = await logsRes.json();

    if (logs && logs.length > 0) {
      const lastLog = logs[0];
      document.getElementById('lastSyncTime').textContent = new Date(lastLog.timestamp).toLocaleString();
      document.getElementById('lastSyncStatus').textContent = lastLog.status;
      document.getElementById('lastSyncStatus').className = `text-lg font-semibold ${
        lastLog.status === 'SUCCESS' ? 'status-success' : 'status-error'
      }`;

      const count = lastLog.stats?.added || 0;
      document.getElementById('lastSyncCount').textContent = count;
    } else {
      document.getElementById('lastSyncTime').textContent = 'Never';
      document.getElementById('lastSyncStatus').textContent = 'N/A';
      document.getElementById('lastSyncCount').textContent = '0';
    }

    // Load current config
    const configRes = await fetch('/admin/api/config');
    const config = await configRes.json();

    document.getElementById('configEnv').textContent = config.ENV || 'sandbox';
    document.getElementById('configTellerAccount').textContent = config.TELLER_ACCOUNT_ID || 'Not set';
    document.getElementById('configActualServer').textContent = config.ACTUAL_SERVER_URL || 'Not set';
    document.getElementById('configDaysToSync').textContent = config.DAYS_TO_SYNC || '7';
    document.getElementById('configCronSchedule').textContent = config.CRON_SCHEDULE || '0 2 * * *';

    // Load setup status
    await loadSetupStatus();

  } catch (error) {
    console.error('Error loading dashboard:', error);
    showToast('Error loading dashboard', 'error');
  }
}

// Load setup status and check configuration completeness
async function loadSetupStatus() {
  try {
    const statusRes = await fetch('/api/config/status');
    const status = await statusRes.json();

    // Update Teller status
    const tellerIcon = document.getElementById('tellerStatusIcon');
    const tellerText = document.getElementById('tellerStatusText');
    const tellerCard = document.getElementById('tellerStatusCard');

    if (status.hasTellerConfig) {
      tellerIcon.textContent = '✅';
      tellerText.textContent = 'Connected and configured';
      tellerCard.classList.remove('border-yellow-300', 'bg-yellow-50');
      tellerCard.classList.add('border-green-300', 'bg-green-50');
    } else {
      tellerIcon.textContent = '⚠️';
      tellerText.textContent = 'Not configured - Connect your bank account';
      tellerCard.classList.remove('border-green-300', 'bg-green-50');
      tellerCard.classList.add('border-yellow-300', 'bg-yellow-50');
    }

    // Update Actual Budget status
    const actualIcon = document.getElementById('actualStatusIcon');
    const actualText = document.getElementById('actualStatusText');
    const actualCard = document.getElementById('actualStatusCard');

    if (status.hasActualConfig) {
      actualIcon.textContent = '✅';
      actualText.textContent = 'Connected and configured';
      actualCard.classList.remove('border-yellow-300', 'bg-yellow-50');
      actualCard.classList.add('border-green-300', 'bg-green-50');
    } else {
      actualIcon.textContent = '⚠️';
      actualText.textContent = 'Not configured - Set up Actual Budget connection';
      actualCard.classList.remove('border-green-300', 'bg-green-50');
      actualCard.classList.add('border-yellow-300', 'bg-yellow-50');
    }

  } catch (error) {
    console.error('Error loading setup status:', error);
  }
}

// Test Teller connection
async function testTellerConnection() {
  const btn = document.getElementById('testTellerBtn');
  const originalText = btn.textContent;

  try {
    btn.textContent = 'Testing...';
    btn.disabled = true;

    // Check if config exists first
    const statusRes = await fetch('/api/config/status');
    const status = await statusRes.json();

    if (!status.hasTellerConfig) {
      showToast('Teller not configured. Please connect your bank account first.', 'error');
      return;
    }

    // Call the backend test endpoint (it will load config from file)
    const testRes = await fetch('/api/test/teller', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}) // Backend will load all config from file
    });

    const result = await testRes.json();

    if (result.success) {
      showToast(`✅ Connected to ${result.institution} - ${result.accountName}`, 'success');
    } else {
      showToast(`❌ Connection failed: ${result.error}`, 'error');
    }

  } catch (error) {
    console.error('Error testing Teller connection:', error);
    showToast(`❌ Failed to test connection: ${error.message}`, 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// Test Actual Budget connection
async function testActualConnection() {
  const btn = document.getElementById('testActualBtn');
  const originalText = btn.textContent;

  try {
    btn.textContent = 'Testing...';
    btn.disabled = true;

    // Check if config exists first
    const statusRes = await fetch('/api/config/status');
    const status = await statusRes.json();

    if (!status.hasActualConfig) {
      showToast('Actual Budget not configured. Please complete setup first.', 'error');
      return;
    }

    // Call the backend test endpoint (it will load config from file)
    const testRes = await fetch('/api/test/actual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}) // Backend will load all config from file
    });

    const result = await testRes.json();

    if (result.success) {
      showToast('✅ Successfully connected to Actual Budget!', 'success');
    } else {
      showToast(`❌ Connection failed: ${result.error}`, 'error');
    }

  } catch (error) {
    console.error('Error testing Actual Budget connection:', error);
    showToast(`❌ Failed to test connection: ${error.message}`, 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// Track which sensitive fields have been modified
const modifiedFields = new Set();

// Load Config Form
async function loadConfig() {
  try {
    const res = await fetch('/admin/api/config');
    const config = await res.json();

    const form = document.getElementById('configForm');

    // Clear modification tracking
    modifiedFields.clear();

    Object.keys(config).forEach(key => {
      const input = form.querySelector(`[name="${key}"]`);
      if (input && config[key]) {
        input.value = config[key];

        // Add change listener for password fields to track modifications
        if (input.type === 'password') {
          input.addEventListener('input', () => {
            modifiedFields.add(key);
          }, { once: false });
        }
      }
    });

    // Set cron preset
    const cronInput = form.querySelector('[name="CRON_SCHEDULE"]');
    const cronPreset = document.getElementById('cronPreset');
    if (cronInput.value) {
      const matchingOption = Array.from(cronPreset.options).find(opt => opt.value === cronInput.value);
      if (matchingOption) {
        cronPreset.value = cronInput.value;
      } else {
        cronPreset.value = 'custom';
      }
    }

    // Check certificate status
    await checkCertificateStatus();

  } catch (error) {
    console.error('Error loading config:', error);
    showToast('Error loading configuration', 'error');
  }
}

// Check if certificates exist
async function checkCertificateStatus() {
  try {
    const res = await fetch('/admin/api/certificates/status');
    const status = await res.json();

    const certStatus = document.getElementById('certFileStatus');
    const keyStatus = document.getElementById('certKeyFileStatus');

    if (status.certificateExists) {
      certStatus.textContent = '✓ Certificate uploaded';
      certStatus.className = 'mt-1 text-xs text-green-600';
    } else {
      certStatus.textContent = 'No certificate uploaded';
      certStatus.className = 'mt-1 text-xs text-gray-500';
    }

    if (status.keyExists) {
      keyStatus.textContent = '✓ Private key uploaded';
      keyStatus.className = 'mt-1 text-xs text-green-600';
    } else {
      keyStatus.textContent = 'No private key uploaded';
      keyStatus.className = 'mt-1 text-xs text-gray-500';
    }
  } catch (error) {
    console.error('Error checking certificate status:', error);
  }
}

// Cron preset handler
document.getElementById('cronPreset').addEventListener('change', (e) => {
  const cronInput = document.querySelector('[name="CRON_SCHEDULE"]');
  if (e.target.value !== 'custom') {
    cronInput.value = e.target.value;
    cronInput.disabled = true;
  } else {
    cronInput.disabled = false;
    cronInput.focus();
  }
});

// Save Configuration
document.getElementById('configForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  try {
    // First, upload certificate files if selected
    const certFile = document.getElementById('certFile').files[0];
    const certKeyFile = document.getElementById('certKeyFile').files[0];

    if (certFile || certKeyFile) {
      const certFormData = new FormData();
      if (certFile) certFormData.append('certificate', certFile);
      if (certKeyFile) certFormData.append('privateKey', certKeyFile);

      const certRes = await fetch('/admin/api/certificates/upload', {
        method: 'POST',
        body: certFormData
      });

      if (!certRes.ok) {
        throw new Error('Failed to upload certificates');
      }

      showToast('Certificates uploaded successfully', 'success');
    }

    // Then save the configuration
    const formData = new FormData(e.target);
    const config = Object.fromEntries(formData.entries());

    // Remove password fields that haven't been modified (they contain masked values)
    const passwordFields = ['TELLER_ACCESS_TOKEN', 'ACTUAL_PASSWORD'];
    passwordFields.forEach(field => {
      if (!modifiedFields.has(field)) {
        delete config[field];
      }
    });

    const res = await fetch('/admin/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });

    if (res.ok) {
      showToast('Configuration saved! Restart container for changes to take effect.', 'success');
      setTimeout(() => {
        loadDashboard();
        loadConfig(); // Reload to show updated certificate status
      }, 1000);
    } else {
      throw new Error('Failed to save configuration');
    }
  } catch (error) {
    console.error('Error saving config:', error);
    showToast('Error saving configuration: ' + error.message, 'error');
  }
});

// Cancel config changes
document.getElementById('cancelConfigBtn').addEventListener('click', () => {
  loadConfig();
  showToast('Changes discarded', 'success');
});

// Load Logs
async function loadLogs() {
  try {
    const res = await fetch('/admin/api/logs');
    const { logs } = await res.json();
    
    const container = document.getElementById('logsContainer');
    
    if (!logs || logs.length === 0) {
      container.innerHTML = '<div class="p-6 text-center text-gray-500">No sync logs yet</div>';
      return;
    }
    
    container.innerHTML = logs.map(log => {
      const date = new Date(log.timestamp);
      const statusClass = log.status === 'SUCCESS' ? 'text-green-600 bg-green-50' : 'text-red-600 bg-red-50';
      
      return `
        <div class="p-4 hover:bg-gray-50">
          <div class="flex items-center justify-between">
            <div class="flex-1">
              <div class="flex items-center space-x-3">
                <span class="px-2 py-1 text-xs font-medium rounded ${statusClass}">
                  ${log.status}
                </span>
                <span class="text-sm text-gray-900">${log.message}</span>
              </div>
              <div class="mt-1 text-xs text-gray-500">
                ${date.toLocaleString()}
              </div>
            </div>
            ${log.stats ? `
              <div class="text-sm text-gray-600">
                ${log.stats.added || 0} added, ${log.stats.updated || 0} updated
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
    
  } catch (error) {
    console.error('Error loading logs:', error);
    document.getElementById('logsContainer').innerHTML = 
      '<div class="p-6 text-center text-red-500">Error loading logs</div>';
  }
}

// Manual Sync
document.getElementById('syncNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncNowBtn');
  const originalText = btn.textContent;
  
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner inline-block"></div><span class="ml-2">Syncing...</span>';
  
  try {
    const res = await fetch('/manual-sync', { method: 'POST' });
    const data = await res.json();
    
    if (data.success) {
      showToast('Sync completed successfully!', 'success');
      setTimeout(() => {
        loadDashboard();
        loadLogs();
      }, 500);
    } else {
      throw new Error(data.error || 'Sync failed');
    }
  } catch (error) {
    console.error('Sync error:', error);
    showToast(`Sync failed: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// Test connection button event listeners
document.getElementById('testTellerBtn').addEventListener('click', testTellerConnection);
document.getElementById('testActualBtn').addEventListener('click', testActualConnection);

// Initial load
loadDashboard();