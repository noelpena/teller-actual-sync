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

function statusBadge(m) {
  if (m.disabled) return '<span class="px-2 py-0.5 text-xs rounded bg-gray-200 text-gray-700">Disabled</span>';
  if (m.needsReconnect) return '<span class="px-2 py-0.5 text-xs rounded bg-orange-100 text-orange-800">Needs reconnect</span>';
  if (m.lastSyncStatus === 'success') return '<span class="px-2 py-0.5 text-xs rounded bg-green-100 text-green-800">OK</span>';
  if (m.lastSyncStatus === 'error') return '<span class="px-2 py-0.5 text-xs rounded bg-red-100 text-red-800">Error</span>';
  if (m.lastSyncStatus === 'auth_error') return '<span class="px-2 py-0.5 text-xs rounded bg-orange-100 text-orange-800">Auth error</span>';
  return '<span class="px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-600">Never synced</span>';
}

function relativeTime(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago';
  return Math.floor(ms / 86_400_000) + 'd ago';
}

async function loadMappings() {
  const container = document.getElementById('mappingsTable');
  const countEl = document.getElementById('mappingsCount');
  try {
    const [mRes, aRes] = await Promise.all([
      fetch('/api/mappings'),
      fetch('/api/actual/accounts').catch(() => null),
    ]);
    const { mappings } = await mRes.json();
    const actualAccounts = aRes && aRes.ok ? (await aRes.json()).accounts : [];

    countEl.textContent = `${mappings.length} mapping${mappings.length === 1 ? '' : 's'}`;

    if (!mappings.length) {
      container.innerHTML = '<div class="p-6 text-center text-gray-500">No mappings yet. Connect a bank above.</div>';
      return;
    }

    container.innerHTML = mappings.map(m => {
      const stats = m.lastSyncStats
        ? `${m.lastSyncStats.added} added, ${m.lastSyncStats.updated} updated`
        : '—';
      const errLine = m.lastError
        ? `<div class="text-xs text-red-600 mt-1">${escapeHtml(m.lastError).slice(0, 200)}</div>`
        : '';
      return `
        <div class="p-4" data-mapping-id="${m.id}">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <div class="font-medium">${escapeHtml(m.name || 'Unnamed')}</div>
                ${statusBadge(m)}
              </div>
              <div class="text-xs text-gray-500 font-mono mt-1 space-y-0.5">
                <div>Teller acct: ${escapeHtml(m.tellerAccountId)} (${escapeHtml(m.tellerAccessTokenMasked || '—')})</div>
                <div>Actual acct: ${escapeHtml(m.actualAccountId)}</div>
                <div class="text-gray-400">Last sync: ${relativeTime(m.lastSyncAt)} · ${escapeHtml(stats)}</div>
              </div>
              ${errLine}
            </div>
            <div class="flex flex-col gap-1 shrink-0">
              <button data-id="${m.id}" class="sync-mapping px-3 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">Sync</button>
              <button data-id="${m.id}" class="edit-mapping px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200">Edit</button>
              <button data-id="${m.id}" data-disabled="${m.disabled ? '1' : '0'}" class="toggle-mapping px-3 py-1 text-xs ${m.disabled ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-yellow-100 text-yellow-800 hover:bg-yellow-200'} rounded">${m.disabled ? 'Enable' : 'Disable'}</button>
              <button data-id="${m.id}" class="delete-mapping px-3 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200">Delete</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.delete-mapping').forEach(btn => {
      btn.addEventListener('click', () => deleteMapping(btn.dataset.id));
    });
    container.querySelectorAll('.sync-mapping').forEach(btn => {
      btn.addEventListener('click', () => syncSingleMapping(btn.dataset.id, btn));
    });
    container.querySelectorAll('.toggle-mapping').forEach(btn => {
      btn.addEventListener('click', () => toggleMapping(btn.dataset.id, btn.dataset.disabled === '1'));
    });
    container.querySelectorAll('.edit-mapping').forEach(btn => {
      const m = mappings.find(x => x.id === btn.dataset.id);
      btn.addEventListener('click', () => openEditMapping(m, actualAccounts));
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

async function syncSingleMapping(id, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch(`/api/mappings/${id}/sync`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Sync failed');
    showToast(`Sync OK: ${data.stats.added} added, ${data.stats.updated} updated`, 'success');
  } catch (error) {
    showToast(`Sync failed: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
    loadMappings();
  }
}

async function toggleMapping(id, isDisabled) {
  try {
    const res = await fetch(`/api/mappings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: !isDisabled }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');
    showToast(isDisabled ? 'Mapping enabled' : 'Mapping disabled', 'success');
    loadMappings();
  } catch (error) {
    showToast(`Failed: ${error.message}`, 'error');
  }
}

function openEditMapping(mapping, actualAccounts) {
  const actualOptions = (actualAccounts || [])
    .filter(a => !a.closed)
    .map(a => `<option value="${escapeHtml(a.id)}" ${a.id === mapping.actualAccountId ? 'selected' : ''}>${escapeHtml(a.name)}${a.offbudget ? ' (off-budget)' : ''}</option>`)
    .join('');
  const html = `
    <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" id="editMappingModal">
      <div class="bg-white rounded-lg shadow-lg p-6 w-full max-w-md">
        <h3 class="text-lg font-semibold mb-4">Edit mapping</h3>
        <form id="editMappingForm" class="space-y-3">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Display name</label>
            <input type="text" name="name" value="${escapeHtml(mapping.name || '')}" required
              class="w-full px-3 py-2 border border-gray-300 rounded-md">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Actual Budget account</label>
            <select name="actualAccountId" class="w-full px-3 py-2 border border-gray-300 rounded-md">
              ${actualOptions}
            </select>
          </div>
          <div class="text-xs text-gray-500 font-mono pt-1">
            Teller account: ${escapeHtml(mapping.tellerAccountId)} (read-only — to change, delete and re-create the mapping)
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button type="button" id="editMappingCancel" class="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded">Cancel</button>
            <button type="submit" class="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">Save</button>
          </div>
        </form>
      </div>
    </div>
  `;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper.firstElementChild);

  const close = () => document.getElementById('editMappingModal')?.remove();
  document.getElementById('editMappingCancel').addEventListener('click', close);
  document.getElementById('editMappingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await fetch(`/api/mappings/${mapping.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: fd.get('name'),
          actualAccountId: fd.get('actualAccountId'),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      showToast('Mapping updated', 'success');
      close();
      loadMappings();
    } catch (error) {
      showToast(`Failed: ${error.message}`, 'error');
    }
  });
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

  const byTellerAccountId = new Map();
  (existingMappings || []).forEach(m => byTellerAccountId.set(m.tellerAccountId, m));

  const actualOptions = actualAccounts
    .filter(a => !a.closed)
    .map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}${a.offbudget ? ' (off-budget)' : ''}</option>`)
    .join('');

  if (tellerAccounts.length === 0) {
    list.innerHTML = '<div class="text-sm text-gray-500">No accounts returned from Teller for this token.</div>';
    return;
  }

  // Split: rows that already have a mapping (token rotation) vs new
  const rotationRows = [];
  const newRows = [];

  tellerAccounts.forEach(t => {
    const subtitle = [t.institution, t.type, t.subtype, t.last_four ? `••${t.last_four}` : null]
      .filter(Boolean).join(' · ');
    const existing = byTellerAccountId.get(t.id);

    if (existing) {
      rotationRows.push(`
        <div class="border rounded-md p-3 bg-blue-50" data-teller-id="${escapeHtml(t.id)}" data-action="rotate">
          <div class="flex items-start justify-between gap-2">
            <div class="flex-1">
              <div class="font-medium">${escapeHtml(t.name || t.id)} <span class="text-xs text-blue-700">(token will be rotated)</span></div>
              <div class="text-xs text-gray-500">${escapeHtml(subtitle)}</div>
              <div class="text-xs font-mono text-gray-400 mt-1">Mapped to: ${escapeHtml(existing.name)} (Actual ${escapeHtml(existing.actualAccountId.slice(0, 8))}…)</div>
            </div>
            <label class="text-xs flex items-center gap-1">
              <input type="checkbox" class="rotate-include" checked> rotate
            </label>
          </div>
        </div>
      `);
    } else {
      newRows.push(`
        <div class="border rounded-md p-3 grid grid-cols-1 md:grid-cols-12 gap-2 items-center" data-teller-id="${escapeHtml(t.id)}" data-action="create">
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
      `);
    }
  });

  list.innerHTML = [
    rotationRows.length ? `<div class="text-xs font-semibold text-blue-700 uppercase tracking-wide">Existing mappings — token rotation</div>` : '',
    ...rotationRows,
    newRows.length ? `<div class="text-xs font-semibold text-gray-700 uppercase tracking-wide pt-2">New accounts to add</div>` : '',
    ...newRows,
  ].filter(Boolean).join('');
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
  const toRotate = [];

  rows.forEach(row => {
    const tellerAccountId = row.dataset.tellerId;
    const action = row.dataset.action;
    if (action === 'rotate') {
      const cb = row.querySelector('.rotate-include');
      if (cb && cb.checked) toRotate.push(tellerAccountId);
    } else {
      const actualAccountId = row.querySelector('.map-actual').value;
      const name = row.querySelector('.map-name').value || '';
      if (actualAccountId) {
        toCreate.push({ tellerAccountId, actualAccountId, name, tellerAccessToken: _newBankToken });
      }
    }
  });

  if (toCreate.length === 0 && toRotate.length === 0) {
    showToast('Nothing to save. Pick at least one account or rotation.', 'error');
    return;
  }

  let rotated = 0;
  let created = 0;
  let failed = 0;

  // Rotate first so existing mappings come back online before any new ones
  if (toRotate.length > 0) {
    try {
      const res = await fetch('/api/mappings/rotate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newAccessToken: _newBankToken, tellerAccountIds: toRotate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Rotation failed');
      rotated = data.rotated;
    } catch (err) {
      console.error('Rotation failed:', err);
      failed += toRotate.length;
    }
  }

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

  const parts = [];
  if (rotated) parts.push(`rotated ${rotated} token${rotated === 1 ? '' : 's'}`);
  if (created) parts.push(`added ${created} mapping${created === 1 ? '' : 's'}`);
  if (failed) parts.push(`${failed} failed`);
  showToast(parts.join(', ') || 'No changes', failed ? 'error' : 'success');

  hideNewBankPanel();
  loadMappings();
}

document.getElementById('connectAnotherBankBtn')?.addEventListener('click', handleConnectAnotherBank);
document.getElementById('newBankCancelBtn')?.addEventListener('click', hideNewBankPanel);
document.getElementById('newBankSaveBtn')?.addEventListener('click', handleSaveNewBankMappings);

// Initial load
loadDashboard();