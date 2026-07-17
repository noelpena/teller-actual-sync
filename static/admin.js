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
    if (tabName === 'mappings') { loadItems(); loadMappings(); }
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

// Environment pill in the navbar
(function initEnvPill() {
  const pill = document.getElementById('envPill');
  const env = window.PLAID_CONFIG?.env || 'sandbox';
  pill.textContent = env;
  pill.className = `ml-2 px-2 py-1 text-xs rounded ${
    env === 'production' ? 'bg-green-100 text-green-800' : 'bg-sky-100 text-sky-800'
  }`;
})();

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

    // Load current config + status
    const [configRes, statusRes] = await Promise.all([
      fetch('/admin/api/config'),
      fetch('/api/config/status'),
    ]);
    const config = await configRes.json();
    const status = await statusRes.json();

    document.getElementById('configPlaidEnv').textContent = config.PLAID_ENV || 'sandbox';
    document.getElementById('configItemCount').textContent =
      status.plaidEnv === 'production'
        ? `${status.itemCount} / ${status.itemLimit} (Trial plan limit)`
        : `${status.itemCount}`;
    document.getElementById('configActualServer').textContent = config.ACTUAL_SERVER_URL || 'Not set';
    document.getElementById('configDaysRequested').textContent = `${config.PLAID_DAYS_REQUESTED || 90} days`;
    document.getElementById('configCronSchedule').textContent = config.CRON_SCHEDULE || '0 2 * * *';

    renderSetupStatus(status);
  } catch (error) {
    console.error('Error loading dashboard:', error);
    showToast('Error loading dashboard', 'error');
  }
}

// Setup status cards
function renderSetupStatus(status) {
  const plaidIcon = document.getElementById('plaidStatusIcon');
  const plaidText = document.getElementById('plaidStatusText');
  const plaidCard = document.getElementById('plaidStatusCard');

  if (status.hasPlaidConfig) {
    plaidIcon.textContent = '✅';
    plaidText.textContent = `Connected — ${status.itemCount} bank(s), ${status.validMappingCount} mapped account${status.validMappingCount === 1 ? '' : 's'}`;
    plaidCard.classList.remove('border-yellow-300', 'bg-yellow-50');
    plaidCard.classList.add('border-green-300', 'bg-green-50');
  } else {
    plaidIcon.textContent = '⚠️';
    if (!status.hasPlaidCredentials) {
      plaidText.textContent = 'Not configured - add your Plaid client ID and secret';
    } else if (status.itemCount === 0) {
      plaidText.textContent = 'Credentials saved - connect your first bank account';
    } else {
      plaidText.textContent = 'Bank connected - map accounts in the Account Mappings tab';
    }
    plaidCard.classList.remove('border-green-300', 'bg-green-50');
    plaidCard.classList.add('border-yellow-300', 'bg-yellow-50');
  }

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
}

// Test Plaid connection
async function testPlaidConnection() {
  const btn = document.getElementById('testPlaidBtn');
  const originalText = btn.textContent;

  try {
    btn.textContent = 'Testing...';
    btn.disabled = true;

    const testRes = await fetch('/api/test/plaid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    const result = await testRes.json();

    if (result.success) {
      showToast(`✅ Connected to Plaid (${result.env}) — ${result.itemCount} bank connection(s)`, 'success');
    } else {
      showToast(`❌ Connection failed: ${result.error}`, 'error');
    }

  } catch (error) {
    console.error('Error testing Plaid connection:', error);
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

  } catch (error) {
    console.error('Error loading config:', error);
    showToast('Error loading configuration', 'error');
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
    const formData = new FormData(e.target);
    const config = Object.fromEntries(formData.entries());

    // Remove password fields that haven't been modified (they contain masked values)
    const passwordFields = ['PLAID_SECRET', 'ACTUAL_PASSWORD'];
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
        loadConfig();
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
                ${log.stats.added || 0} added, ${log.stats.updated || 0} updated${log.stats.deleted ? `, ${log.stats.deleted} deleted` : ''}
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
document.getElementById('testPlaidBtn').addEventListener('click', testPlaidConnection);
document.getElementById('testActualBtn').addEventListener('click', testActualConnection);

// ===== Plaid Link helpers =====

// Fetch a link token; pass itemId for update mode (repairing a broken Item)
async function fetchLinkToken(itemId) {
  const res = await fetch('/api/plaid/link-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(itemId ? { itemId } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Link token request failed (${res.status})`);
  return data.linkToken;
}

// Repair a broken Item via Link update mode. The Item keeps its access_token —
// the onSuccess public_token must NOT be exchanged.
async function repairItem(itemId, btn) {
  const original = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    if (!window.Plaid) throw new Error('Plaid Link script not loaded. Refresh the page.');
    const linkToken = await fetchLinkToken(itemId);
    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: async () => {
        try {
          await fetch(`/api/plaid/items/${encodeURIComponent(itemId)}/reconnected`, { method: 'POST' });
        } catch (_) { /* flag clears on next successful sync anyway */ }
        showToast('Connection repaired!', 'success');
        loadItems();
        loadMappings();
      },
      onExit: (err) => {
        if (err) showToast(`Repair failed: ${err.display_message || err.error_message || 'try again'}`, 'error');
      },
    });
    handler.open();
  } catch (error) {
    showToast(`Repair failed: ${error.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

// ===== Bank Connections (Items) =====

async function loadItems() {
  const container = document.getElementById('itemsTable');
  const countEl = document.getElementById('itemsCount');
  try {
    const res = await fetch('/api/plaid/items');
    const { items, itemCount, itemLimit } = await res.json();

    const env = window.PLAID_CONFIG?.env || 'sandbox';
    countEl.textContent = env === 'production'
      ? `${itemCount} / ${itemLimit} connections used`
      : `${itemCount} connection${itemCount === 1 ? '' : 's'} (sandbox)`;

    if (!items.length) {
      container.innerHTML = '<div class="p-6 text-center text-gray-500">No banks connected yet.</div>';
      return;
    }

    container.innerHTML = items.map(it => {
      const badge = it.needsReconnect
        ? '<span class="px-2 py-0.5 text-xs rounded bg-orange-100 text-orange-800">Needs reconnect</span>'
        : (it.lastError
          ? '<span class="px-2 py-0.5 text-xs rounded bg-red-100 text-red-800">Error</span>'
          : '<span class="px-2 py-0.5 text-xs rounded bg-green-100 text-green-800">OK</span>');
      const errLine = it.lastError
        ? `<div class="text-xs text-red-600 mt-1">${escapeHtml(it.lastError).slice(0, 200)}</div>`
        : '';
      return `
        <div class="p-4">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <div class="font-medium">${escapeHtml(it.institution || 'Unknown institution')}</div>
                ${badge}
              </div>
              <div class="text-xs text-gray-500 font-mono mt-1">
                ${escapeHtml(it.itemId)} · ${it.mappingCount} mapping${it.mappingCount === 1 ? '' : 's'} · last sync ${relativeTime(it.lastSyncedAt)}
              </div>
              ${errLine}
            </div>
            <div class="flex flex-col gap-1 shrink-0">
              ${it.needsReconnect ? `<button data-id="${escapeHtml(it.itemId)}" class="repair-item px-3 py-1 text-xs bg-orange-100 text-orange-800 rounded hover:bg-orange-200">Repair</button>` : ''}
              <button data-id="${escapeHtml(it.itemId)}" class="remove-item px-3 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200">Remove</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.repair-item').forEach(btn => {
      btn.addEventListener('click', () => repairItem(btn.dataset.id, btn));
    });
    container.querySelectorAll('.remove-item').forEach(btn => {
      btn.addEventListener('click', () => removeItem(btn.dataset.id));
    });
  } catch (error) {
    console.error('Error loading items:', error);
    container.innerHTML = '<div class="p-6 text-center text-red-500">Error loading connections</div>';
  }
}

async function removeItem(itemId) {
  const env = window.PLAID_CONFIG?.env || 'sandbox';
  const warning = env === 'production'
    ? 'Remove this bank connection?\n\n⚠️ On the Trial plan this does NOT free up a connection slot — the 10-connection limit counts every connection ever made.\n\nIts mappings will be disabled.'
    : 'Remove this bank connection? Its mappings will be disabled.';
  if (!confirm(warning)) return;

  try {
    const res = await fetch(`/api/plaid/items/${encodeURIComponent(itemId)}/remove`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Remove failed');
    showToast(`Connection removed (${data.mappingsDisabled} mapping(s) disabled)`, 'success');
    loadItems();
    loadMappings();
  } catch (error) {
    showToast(`Failed: ${error.message}`, 'error');
  }
}

// ===== Account Mappings =====

function statusBadge(m) {
  const badges = [];
  if (m.disabled) badges.push('<span class="px-2 py-0.5 text-xs rounded bg-gray-200 text-gray-700">Disabled</span>');
  else if (m.needsReconnect) badges.push('<span class="px-2 py-0.5 text-xs rounded bg-orange-100 text-orange-800">Needs reconnect</span>');
  else if (m.lastSyncStatus === 'success') badges.push('<span class="px-2 py-0.5 text-xs rounded bg-green-100 text-green-800">OK</span>');
  else if (m.lastSyncStatus === 'error') badges.push('<span class="px-2 py-0.5 text-xs rounded bg-red-100 text-red-800">Error</span>');
  else if (m.lastSyncStatus === 'auth_error') badges.push('<span class="px-2 py-0.5 text-xs rounded bg-orange-100 text-orange-800">Auth error</span>');
  else badges.push('<span class="px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-600">Never synced</span>');

  if (m.pendingReconcile) badges.push('<span class="px-2 py-0.5 text-xs rounded bg-purple-100 text-purple-800">Reconcile pending</span>');
  return badges.join(' ');
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
        ? `${m.lastSyncStats.added} added, ${m.lastSyncStats.updated} updated${m.lastSyncStats.deleted ? `, ${m.lastSyncStats.deleted} deleted` : ''}`
        : '—';
      const errLine = m.lastError
        ? `<div class="text-xs text-red-600 mt-1">${escapeHtml(m.lastError).slice(0, 200)}</div>`
        : '';
      const repairBtn = m.needsReconnect && m.itemId
        ? `<button data-item="${escapeHtml(m.itemId)}" class="repair-mapping px-3 py-1 text-xs bg-orange-100 text-orange-800 rounded hover:bg-orange-200">Repair</button>`
        : '';
      return `
        <div class="p-4" data-mapping-id="${m.id}">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <div class="font-medium">${escapeHtml(m.name || 'Unnamed')}</div>
                ${m.institution ? `<span class="text-xs text-gray-500">${escapeHtml(m.institution)}</span>` : ''}
                ${statusBadge(m)}
              </div>
              <div class="text-xs text-gray-500 font-mono mt-1 space-y-0.5">
                <div>Plaid acct: ${escapeHtml(m.plaidAccountId)}</div>
                <div>Actual acct: ${escapeHtml(m.actualAccountId)}</div>
                <div class="text-gray-400">Last sync: ${relativeTime(m.lastSyncAt)} · ${escapeHtml(stats)}</div>
              </div>
              ${errLine}
            </div>
            <div class="flex flex-col gap-1 shrink-0">
              ${repairBtn}
              <button data-id="${m.id}" class="sync-mapping px-3 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">Sync</button>
              <button data-id="${m.id}" class="reconcile-mapping px-3 py-1 text-xs bg-purple-100 text-purple-800 rounded hover:bg-purple-200">Reconcile</button>
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
    container.querySelectorAll('.reconcile-mapping').forEach(btn => {
      btn.addEventListener('click', () => reconcileSingleMapping(btn.dataset.id, btn));
    });
    container.querySelectorAll('.toggle-mapping').forEach(btn => {
      btn.addEventListener('click', () => toggleMapping(btn.dataset.id, btn.dataset.disabled === '1'));
    });
    container.querySelectorAll('.repair-mapping').forEach(btn => {
      btn.addEventListener('click', () => repairItem(btn.dataset.item, btn));
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

async function reconcileSingleMapping(id, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch(`/api/mappings/${id}/reconcile`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Reconcile failed');
    const r = data.stats?.reconcile;
    if (r && r.delta != null) {
      showToast(`Reconciled: Δ ${(r.delta / 100).toFixed(2)} (bank ${r.bankBalance.toFixed(2)})`, 'success');
    } else {
      showToast('Reconcile completed (already balanced or no delta)', 'success');
    }
  } catch (error) {
    showToast(`Reconcile failed: ${error.message}`, 'error');
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
            Plaid account: ${escapeHtml(mapping.plaidAccountId)} (read-only — to change, delete and re-create the mapping)
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
    itemId: fd.get('itemId'),
    plaidAccountId: fd.get('plaidAccountId'),
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

// ===== Connect Another Bank (Plaid Link + account picker) =====

let _actualAccountsCache = null;

// Stringify whatever a server might send back as an "error" field
function errorMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data.error === 'string') return data.error;
  if (data.error && typeof data.error === 'object') {
    try { return JSON.stringify(data.error); } catch (_) { return String(data.error); }
  }
  return fallback;
}

async function safeJson(res) {
  try { return await res.json(); } catch (_) { return {}; }
}

async function fetchActualAccounts() {
  if (_actualAccountsCache) return _actualAccountsCache;
  const res = await fetch('/api/actual/accounts');
  const data = await safeJson(res);
  if (!res.ok) {
    const msg = errorMessage(data, `HTTP ${res.status}`);
    console.error('fetchActualAccounts failed:', res.status, data);
    throw new Error(msg);
  }
  _actualAccountsCache = data.accounts || [];
  return _actualAccountsCache;
}

async function fetchPlaidAccounts() {
  const res = await fetch('/api/plaid/accounts');
  const data = await safeJson(res);
  if (!res.ok) {
    const msg = errorMessage(data, `HTTP ${res.status}`);
    console.error('fetchPlaidAccounts failed:', res.status, data);
    throw new Error(msg);
  }
  return data.accounts || [];
}

// Smart default: investments and loans go off-budget in Actual; everything else on-budget.
function suggestOffBudget(plaidAccount) {
  const t = (plaidAccount?.type || '').toLowerCase();
  return t === 'investment' || t === 'loan';
}

function renderNewBankAccountsPicker(plaidAccounts, actualAccounts, existingMappings) {
  const list = document.getElementById('newBankAccountsList');

  const mappedIds = new Set((existingMappings || []).map(m => m.plaidAccountId));

  const actualOptions = actualAccounts
    .filter(a => !a.closed)
    .map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}${a.offbudget ? ' (off-budget)' : ''}</option>`)
    .join('');

  const unmapped = plaidAccounts.filter(a => !mappedIds.has(a.plaidAccountId));
  const alreadyMapped = plaidAccounts.filter(a => mappedIds.has(a.plaidAccountId));

  if (unmapped.length === 0) {
    list.innerHTML = `
      <div class="text-sm text-gray-500">
        ${plaidAccounts.length === 0
          ? 'No accounts found.'
          : 'All accounts on this connection are already mapped.'}
      </div>`;
    return;
  }

  const mappedRows = alreadyMapped.map(a => `
    <div class="border rounded-md p-3 bg-gray-50 text-sm text-gray-500">
      ${escapeHtml(a.name || a.plaidAccountId)} — already mapped
    </div>
  `);

  const newRows = unmapped.map(a => {
    const subtitle = [a.institution, a.subtype || a.type, a.mask ? '••' + a.mask : null].filter(Boolean).join(' · ');
    const offBudgetDefault = suggestOffBudget(a);
    return `
      <div class="border rounded-md p-3" data-plaid-id="${escapeHtml(a.plaidAccountId)}" data-item-id="${escapeHtml(a.itemId || '')}">
        <div class="flex items-start justify-between gap-3 mb-2">
          <div class="flex-1 min-w-0">
            <div class="font-medium">${escapeHtml(a.name || a.plaidAccountId)}</div>
            <div class="text-xs text-gray-500">${escapeHtml(subtitle)}</div>
            <div class="text-xs font-mono text-gray-400 mt-1">${escapeHtml(a.plaidAccountId)}</div>
          </div>
          <select class="row-mode shrink-0 px-2 py-1 border border-gray-300 rounded text-sm">
            <option value="create" selected>Create new Actual account</option>
            <option value="existing">Use existing Actual account</option>
            <option value="skip">Skip</option>
          </select>
        </div>

        <div class="mode-create grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
          <div class="md:col-span-7">
            <label class="block text-xs text-gray-600 mb-1">New Actual account name</label>
            <input type="text" class="create-name w-full px-2 py-1 border border-gray-300 rounded text-sm"
              value="${escapeHtml(a.name || '')}">
          </div>
          <div class="md:col-span-5">
            <label class="block text-xs text-gray-600 mb-1">Type</label>
            <label class="text-sm flex items-center gap-2">
              <input type="checkbox" class="create-offbudget" ${offBudgetDefault ? 'checked' : ''}>
              Off-budget account
            </label>
            <p class="text-xs text-gray-400 mt-1">Off-budget = investments, loans. Leave unchecked for checking, savings, credit cards.</p>
          </div>
        </div>

        <div class="mode-existing hidden">
          <label class="block text-xs text-gray-600 mb-1">Actual Budget account</label>
          <select class="map-actual w-full px-2 py-1 border border-gray-300 rounded text-sm">
            <option value="">— pick one —</option>
            ${actualOptions}
          </select>
          <input type="text" class="map-name hidden" value="${escapeHtml(a.name || '')}">
        </div>
      </div>
    `;
  });

  list.innerHTML = [
    ...newRows,
    ...mappedRows,
  ].join('');

  // Wire up mode toggles
  list.querySelectorAll('[data-plaid-id]').forEach(row => {
    const sel = row.querySelector('.row-mode');
    if (!sel) return;
    const createBlock = row.querySelector('.mode-create');
    const existingBlock = row.querySelector('.mode-existing');
    sel.addEventListener('change', () => {
      const mode = sel.value;
      createBlock.classList.toggle('hidden', mode !== 'create');
      existingBlock.classList.toggle('hidden', mode !== 'existing');
      row.dataset.mode = mode;
    });
    row.dataset.mode = 'create';
  });
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
}

// Show the account picker for a set of Plaid accounts
async function openAccountPicker(plaidAccounts) {
  let actualAccounts = [];
  try { actualAccounts = await fetchActualAccounts(); }
  catch (e) {
    showToast(`Could not load Actual accounts: ${e.message}. Configure Actual Budget first.`, 'error');
    return;
  }

  const existing = await fetch('/api/mappings').then(r => r.json()).then(d => d.mappings || []);
  showNewBankPanel(plaidAccounts[0]?.institution);
  renderNewBankAccountsPicker(plaidAccounts, actualAccounts, existing);
}

async function handleConnectAnotherBank() {
  const btn = document.getElementById('connectAnotherBankBtn');
  btn.disabled = true;
  try {
    if (!window.Plaid) throw new Error('Plaid Link script not loaded. Refresh the page.');
    const linkToken = await fetchLinkToken();
    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: async (publicToken, metadata) => {
        try {
          const res = await fetch('/api/plaid/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              publicToken,
              institution: metadata?.institution?.name || null,
            }),
          });
          const data = await safeJson(res);
          if (!res.ok || !data.success) throw new Error(errorMessage(data, 'Token exchange failed'));

          showToast(`Bank connected! (connection ${data.itemCount}/${data.itemLimit})`, 'success');
          loadItems();

          // Picker: pull this item's accounts (with types/balances) from the server
          const accounts = await fetchPlaidAccounts();
          await openAccountPicker(accounts.filter(a => a.itemId === data.itemId));
        } catch (err) {
          showToast(`Failed to save connection: ${err.message}`, 'error');
        }
      },
      onExit: (err) => {
        if (err) showToast(`Connection flow failed: ${err.display_message || err.error_message || 'try again'}`, 'error');
      },
    });
    handler.open();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// Map accounts from already-connected banks (no new Link flow)
async function handleMapExistingAccounts() {
  const btn = document.getElementById('mapExistingAccountsBtn');
  btn.disabled = true;
  try {
    const accounts = await fetchPlaidAccounts();
    await openAccountPicker(accounts);
  } catch (error) {
    showToast(`Could not load Plaid accounts: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function handleSaveNewBankMappings() {
  const rows = document.querySelectorAll('#newBankAccountsList [data-plaid-id]');
  const plans = [];

  rows.forEach(row => {
    const plaidAccountId = row.dataset.plaidId;
    const itemId = row.dataset.itemId || undefined;
    const mode = row.dataset.mode || 'create';
    if (mode === 'skip') return;

    if (mode === 'create') {
      const name = (row.querySelector('.create-name')?.value || '').trim();
      const offbudget = !!row.querySelector('.create-offbudget')?.checked;
      if (!name) return;
      plans.push({ plaidAccountId, itemId, mode: 'create', name, offbudget });
    } else if (mode === 'existing') {
      const actualAccountId = row.querySelector('.map-actual')?.value;
      const name = (row.querySelector('.map-name')?.value || '').trim();
      if (!actualAccountId) return;
      plans.push({ plaidAccountId, itemId, mode: 'existing', name, actualAccountId });
    }
  });

  if (plans.length === 0) {
    showToast('Nothing to save. Pick at least one account.', 'error');
    return;
  }

  setSaveBusy(true);
  let created = 0, accountsCreated = 0, failed = 0;

  try {
    // For each plan: ensure we have an Actual account ID, then create the mapping.
    // For newly-created accounts, mark pendingReconcile so the next sync auto-balances
    // against the bank's reported balance.
    for (const p of plans) {
      try {
        let actualAccountId = p.actualAccountId;
        let needsReconcile = false;
        if (p.mode === 'create') {
          const aRes = await fetch('/api/actual/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: p.name, offbudget: p.offbudget, initialBalance: 0 }),
          });
          const aData = await aRes.json();
          if (!aRes.ok || !aData.id) throw new Error(aData.error || 'Actual account creation failed');
          actualAccountId = aData.id;
          accountsCreated++;
          needsReconcile = true;
        }

        const mRes = await fetch('/api/mappings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: p.name,
            itemId: p.itemId,
            plaidAccountId: p.plaidAccountId,
            actualAccountId,
            pendingReconcile: needsReconcile,
          }),
        });
        const mData = await mRes.json();
        if (!mRes.ok) throw new Error(mData.error || 'Mapping save failed');
        created++;
      } catch (err) {
        console.error('Failed to add mapping for', p.plaidAccountId, err);
        failed++;
      }
    }
  } finally {
    setSaveBusy(false);
  }

  const parts = [];
  if (accountsCreated) parts.push(`created ${accountsCreated} Actual account${accountsCreated === 1 ? '' : 's'}`);
  if (created) parts.push(`added ${created} mapping${created === 1 ? '' : 's'}`);
  if (failed) parts.push(`${failed} failed`);
  showToast(parts.join(', ') || 'No changes', failed ? 'error' : 'success');

  // Refresh the Actual accounts cache so subsequent dropdowns reflect new accounts
  _actualAccountsCache = null;

  hideNewBankPanel();
  loadMappings();
}

function setSaveBusy(busy) {
  const btn = document.getElementById('newBankSaveBtn');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? 'Saving…' : 'Save selected mappings';
}

document.getElementById('connectAnotherBankBtn')?.addEventListener('click', handleConnectAnotherBank);
document.getElementById('mapExistingAccountsBtn')?.addEventListener('click', handleMapExistingAccounts);
document.getElementById('newBankCancelBtn')?.addEventListener('click', hideNewBankPanel);
document.getElementById('newBankSaveBtn')?.addEventListener('click', handleSaveNewBankMappings);

// Initial load
loadDashboard();
