// Bank connection flow using the Quiltt Connector.
//
// 1. If Quiltt credentials (API secret + Connector ID) are missing, collect and save them.
// 2. Issue a session token server-side, authenticate the Connector, open the modal.
// 3. On success, poll for the new connection's accounts and hand off to setup/admin.

const CONNECTOR_ID = window.QUILTT_CONFIG?.connectorId;
const HAS_CREDENTIALS = window.QUILTT_CONFIG?.hasCredentials === true;

const steps = {
  credentials: document.getElementById('credentials-step'),
  connect: document.getElementById('connect-step'),
  success: document.getElementById('success-step'),
};

function showStep(name) {
  Object.entries(steps).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
  });
}

function showStatus(message, type) {
  const el = document.getElementById('statusMessage');
  el.textContent = message;
  el.className = 'status-message ' + type;
  el.style.display = 'block';
}

function hideStatus() {
  document.getElementById('statusMessage').style.display = 'none';
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------------- Step 1: credentials ---------------- */

document.getElementById('credentialsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('credentialsBtn');
  const apiSecret = document.getElementById('apiSecret').value.trim();
  const connectorId = document.getElementById('connectorId').value.trim();

  if (!apiSecret || !connectorId) {
    showStatus('Please fill in both fields', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const res = await fetch('/api/setup/save-quiltt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiSecret, connectorId }),
    });
    const result = await res.json();
    if (!res.ok || !result.success) throw new Error(result.error || 'Failed to save');

    // Verify the secret actually works before proceeding
    const testRes = await fetch('/api/test/quiltt', { method: 'POST' });
    const test = await testRes.json();
    if (!test.success) throw new Error(`Saved, but Quiltt rejected the API secret: ${test.error}`);

    showStatus('✅ Credentials saved! Reloading...', 'success');
    setTimeout(() => window.location.reload(), 800);
  } catch (error) {
    showStatus('❌ ' + error.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Save & Continue';
  }
});

/* ---------------- Step 2: launch Connector ---------------- */

async function fetchSessionToken() {
  const res = await fetch('/api/quiltt/session', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Session request failed (${res.status})`);
  return data;
}

async function launchConnector() {
  const btn = document.getElementById('connectBtn');
  btn.disabled = true;
  btn.textContent = 'Preparing...';
  hideStatus();

  try {
    if (!window.Quiltt) throw new Error('Quiltt Connector script failed to load. Refresh the page.');
    if (!CONNECTOR_ID) throw new Error('Connector ID is not configured.');

    const session = await fetchSessionToken();
    window.Quiltt.authenticate(session.token);

    const connector = window.Quiltt.connect(CONNECTOR_ID, {
      onExitSuccess: (metadata) => handleConnected(metadata),
      onExitError: (metadata) => {
        console.error('Connector error:', metadata);
        showStatus('❌ Something went wrong in the connection flow. Please try again.', 'error');
        btn.disabled = false;
        btn.textContent = 'Connect Bank Account';
      },
      onExitAbort: () => {
        btn.disabled = false;
        btn.textContent = 'Connect Bank Account';
      },
    });
    connector.open();
    btn.textContent = 'Connect Bank Account';
  } catch (error) {
    console.error('Failed to launch Connector:', error);
    showStatus('❌ ' + error.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Connect Bank Account';
  }
}

document.getElementById('connectBtn').addEventListener('click', launchConnector);

/* ---------------- Step 3: connection success ---------------- */

function formatBalance(balance) {
  if (balance == null) return '';
  return Number(balance).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function renderAccounts(accounts) {
  const list = document.getElementById('accountList');
  if (!accounts.length) {
    list.innerHTML = '<p>Accounts are still syncing — they\'ll appear in the admin dashboard shortly.</p>';
    return;
  }
  list.innerHTML = accounts.map(a => `
    <div class="account-item">
      <div>
        <div class="name">${escapeHtml(a.name || a.id)}</div>
        <div class="meta">${escapeHtml([a.institution, a.kind].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="balance">${formatBalance(a.balance)}</div>
    </div>
  `).join('');
}

// Quiltt syncs the connection in the background right after the Connector flow;
// accounts can take a few seconds to appear in the API. Poll briefly.
async function pollAccountsForConnection(connectionId, attempts = 10, delayMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch('/api/quiltt/accounts');
      const data = await res.json();
      if (res.ok) {
        const matched = connectionId
          ? (data.accounts || []).filter(a => a.connectionId === connectionId)
          : (data.accounts || []);
        if (matched.length > 0) return matched;
      }
    } catch (_) { /* transient — retry */ }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return [];
}

async function handleConnected(metadata) {
  console.log('Connected:', metadata);
  showStep('success');
  hideStatus();

  const accounts = await pollAccountsForConnection(metadata?.connectionId);
  renderAccounts(accounts);
}

document.getElementById('continueBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/config/status');
    const status = await res.json();
    window.location.href = status.hasActualConfig ? '/admin' : '/setup';
  } catch (_) {
    window.location.href = '/setup';
  }
});

document.getElementById('connectAnotherBtn').addEventListener('click', () => {
  showStep('connect');
  launchConnector();
});

/* ---------------- Bootstrap ---------------- */

showStep(HAS_CREDENTIALS ? 'connect' : 'credentials');
