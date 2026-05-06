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
    if (tabName === 'mappings') loadMappings();
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

// ===== Account Mappings =====

async function loadMappings() {
  const container = document.getElementById('mappingsTable');
  const countEl = document.getElementById('mappingsCount');
  try {
    const res = await fetch('/api/mappings');
    const { mappings } = await res.json();

    countEl.textContent = `${mappings.length} mapping${mappings.length === 1 ? '' : 's'}`;

    if (!mappings.length) {
      container.innerHTML = '<div class="p-6 text-center text-gray-500">No mappings yet. Add one below.</div>';
      return;
    }

    container.innerHTML = mappings.map(m => `
      <div class="p-4 flex items-center justify-between">
        <div class="flex-1 min-w-0">
          <div class="font-medium">${escapeHtml(m.name || 'Unnamed')}</div>
          <div class="text-xs text-gray-500 font-mono mt-1">
            <div>Teller acct: ${escapeHtml(m.tellerAccountId)} (${escapeHtml(m.tellerAccessTokenMasked || '—')})</div>
            <div>Actual acct: ${escapeHtml(m.actualAccountId)}</div>
          </div>
        </div>
        <button data-id="${m.id}" class="delete-mapping ml-4 px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200">
          Delete
        </button>
      </div>
    `).join('');

    container.querySelectorAll('.delete-mapping').forEach(btn => {
      btn.addEventListener('click', () => deleteMapping(btn.dataset.id));
    });
  } catch (error) {
    console.error('Error loading mappings:', error);
    container.innerHTML = '<div class="p-6 text-center text-red-500">Error loading mappings</div>';
  }
}

async function deleteMapping(id) {
  if (!confirm('Delete this mapping? Past synced transactions in Actual will not be removed.')) return;
  try {
    const res = await fetch(`/api/mappings/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    showToast('Mapping deleted', 'success');
    loadMappings();
  } catch (error) {
    showToast(`Failed: ${error.message}`, 'error');
  }
}

document.getElementById('addMappingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const payload = {
    name: fd.get('name'),
    tellerAccessToken: fd.get('tellerAccessToken'),
    tellerAccountId: fd.get('tellerAccountId'),
    actualAccountId: fd.get('actualAccountId'),
  };

  try {
    const res = await fetch('/api/mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to add');
    showToast('Mapping added', 'success');
    form.reset();
    loadMappings();
  } catch (error) {
    showToast(`Failed: ${error.message}`, 'error');
  }
});

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ===== Connect Another Bank (inline Teller Connect + account picker) =====

let _newBankToken = null;
let _newBankAccounts = [];
let _actualAccountsCache = null;

async function fetchActualAccounts() {
  if (_actualAccountsCache) return _actualAccountsCache;
  const res = await fetch('/api/actual/accounts');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load Actual accounts');
  _actualAccountsCache = data.accounts || [];
  return _actualAccountsCache;
}

async function fetchTellerAccountsForToken(accessToken) {
  const res = await fetch('/api/teller/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load Teller accounts');
  return data.accounts || [];
}

function renderNewBankAccountsPicker(tellerAccounts, actualAccounts, existingMappings) {
  const list = document.getElementById('newBankAccountsList');
  const existingPairs = new Set(
    (existingMappings || []).map(m => `${m.tellerAccountId}|${m.actualAccountId}`)
  );

  const actualOptions = actualAccounts
    .filter(a => !a.closed)
    .map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}${a.offbudget ? ' (off-budget)' : ''}</option>`)
    .join('');

  if (tellerAccounts.length === 0) {
    list.innerHTML = '<div class="text-sm text-gray-500">No accounts returned from Teller for this token.</div>';
    return;
  }

  list.innerHTML = tellerAccounts.map(t => {
    const subtitle = [t.institution, t.type, t.subtype, t.last_four ? `••${t.last_four}` : null]
      .filter(Boolean).join(' · ');
    return `
      <div class="border rounded-md p-3 grid grid-cols-1 md:grid-cols-12 gap-2 items-center" data-teller-id="${escapeHtml(t.id)}">
        <div class="md:col-span-5">
          <div class="font-medium">${escapeHtml(t.name || t.id)}</div>
          <div class="text-xs text-gray-500">${escapeHtml(subtitle)}</div>
          <div class="text-xs font-mono text-gray-400 mt-1">${escapeHtml(t.id)}</div>
        </div>
        <div class="md:col-span-2">
          <input type="text" class="map-name w-full px-2 py-1 border border-gray-300 rounded text-sm"
            placeholder="display name" value="${escapeHtml(t.name || '')}">
        </div>
        <div class="md:col-span-5">
          <select class="map-actual w-full px-2 py-1 border border-gray-300 rounded text-sm">
            <option value="">— skip —</option>
            ${actualOptions}
          </select>
        </div>
      </div>
    `;
  }).join('');
}

function showNewBankPanel(institutionName) {
  const panel = document.getElementById('newBankAccountsPanel');
  const title = document.getElementById('newBankAccountsTitle');
  panel.classList.remove('hidden');
  title.textContent = institutionName ? `Map accounts from ${institutionName}` : 'Map accounts';
}

function hideNewBankPanel() {
  const panel = document.getElementById('newBankAccountsPanel');
  panel.classList.add('hidden');
  document.getElementById('newBankAccountsList').innerHTML = '';
  _newBankToken = null;
  _newBankAccounts = [];
}

async function handleConnectAnotherBank() {
  if (!window.TellerConnect || !window.TELLER_CONFIG?.applicationId) {
    showToast('Teller Connect not loaded. Refresh the page.', 'error');
    return;
  }
  if (!window.TELLER_CONFIG.applicationId.startsWith('app_')) {
    showToast('Teller App ID is not configured. Set it under /setup first.', 'error');
    return;
  }

  // Pre-warm Actual accounts so the dropdown is populated quickly
  let actualAccounts = [];
  try { actualAccounts = await fetchActualAccounts(); }
  catch (e) {
    showToast(`Could not load Actual accounts: ${e.message}`, 'error');
    return;
  }

  const tc = window.TellerConnect.setup({
    applicationId: window.TELLER_CONFIG.applicationId,
    environment: window.TELLER_CONFIG.environment || 'sandbox',
    selectAccount: 'multiple',
    onSuccess: async (enrollment) => {
      try {
        _newBankToken = enrollment.accessToken;
        const tellerAccounts = await fetchTellerAccountsForToken(_newBankToken);
        _newBankAccounts = tellerAccounts;

        const existing = await fetch('/api/mappings').then(r => r.json()).then(d => d.mappings || []);
        showNewBankPanel(tellerAccounts[0]?.institution);
        renderNewBankAccountsPicker(tellerAccounts, actualAccounts, existing);
      } catch (err) {
        showToast(`Failed to load accounts: ${err.message}`, 'error');
      }
    },
    onFailure: (err) => {
      console.error('Teller Connect failed:', err);
    },
  });
  tc.open();
}

async function handleSaveNewBankMappings() {
  if (!_newBankToken || _newBankAccounts.length === 0) {
    showToast('No bank connection to save.', 'error');
    return;
  }
  const rows = document.querySelectorAll('#newBankAccountsList [data-teller-id]');
  const toCreate = [];
  rows.forEach(row => {
    const tellerAccountId = row.dataset.tellerId;
    const actualAccountId = row.querySelector('.map-actual').value;
    const name = row.querySelector('.map-name').value || '';
    if (actualAccountId) {
      toCreate.push({ tellerAccountId, actualAccountId, name, tellerAccessToken: _newBankToken });
    }
  });

  if (toCreate.length === 0) {
    showToast('No accounts selected. Pick at least one Actual account.', 'error');
    return;
  }

  let created = 0;
  let failed = 0;
  for (const m of toCreate) {
    try {
      const res = await fetch('/api/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      created++;
    } catch (err) {
      console.error('Failed to save mapping:', m, err);
      failed++;
    }
  }

  if (created > 0) showToast(`Added ${created} mapping${created === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}`, failed ? 'error' : 'success');
  else showToast(`Failed to save mappings`, 'error');

  hideNewBankPanel();
  loadMappings();
}

document.getElementById('connectAnotherBankBtn')?.addEventListener('click', handleConnectAnotherBank);
document.getElementById('newBankCancelBtn')?.addEventListener('click', hideNewBankPanel);
document.getElementById('newBankSaveBtn')?.addEventListener('click', handleSaveNewBankMappings);

// Initial load
loadDashboard();