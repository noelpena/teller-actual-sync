// Bank connection flow using Plaid Link.
//
// 1. If Plaid credentials are missing, collect and save them (client ID + secret + env).
// 2. Fetch a link_token server-side, open Plaid Link.
// 3. onSuccess: exchange the public_token server-side (stores the Item), then
//    show the accounts straight from Link's metadata — no polling needed.

const PLAID_ENV = window.PLAID_CONFIG?.env || "sandbox";
const HAS_CREDENTIALS = window.PLAID_CONFIG?.hasCredentials === true;

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
  const clientId = document.getElementById('clientId').value.trim();
  const secret = document.getElementById('secret').value.trim();
  const env = document.getElementById('env').value;
  const daysRequested = document.getElementById('daysRequested').value;

  if (!clientId || !secret) {
    showStatus('Please fill in client ID and secret', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const res = await fetch('/api/setup/save-plaid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, secret, env, daysRequested }),
    });
    const result = await res.json();
    if (!res.ok || !result.success) throw new Error(result.error || 'Failed to save');

    // Verify the credentials actually work (creating a link token is free)
    const testRes = await fetch('/api/test/plaid', { method: 'POST' });
    const test = await testRes.json();
    if (!test.success) throw new Error(`Saved, but Plaid rejected the credentials: ${test.error}`);

    showStatus('✅ Credentials saved! Reloading...', 'success');
    setTimeout(() => window.location.reload(), 800);
  } catch (error) {
    showStatus('❌ ' + error.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Save & Continue';
  }
});

/* ---------------- Step 2: launch Plaid Link ---------------- */

async function fetchLinkToken() {
  const res = await fetch('/api/plaid/link-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Link token request failed (${res.status})`);
  return data.linkToken;
}

async function launchLink() {
  const btn = document.getElementById('connectBtn');
  btn.disabled = true;
  btn.textContent = 'Preparing...';
  hideStatus();

  try {
    if (!window.Plaid) throw new Error('Plaid Link script failed to load. Refresh the page.');

    const linkToken = await fetchLinkToken();
    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: (publicToken, metadata) => handleLinked(publicToken, metadata),
      onExit: (err) => {
        if (err) {
          console.error('Link exited with error:', err);
          showStatus(`❌ ${err.display_message || err.error_message || 'Connection flow failed. Please try again.'}`, 'error');
        }
        btn.disabled = false;
        btn.textContent = 'Connect Bank Account';
      },
    });
    handler.open();
    btn.textContent = 'Connect Bank Account';
  } catch (error) {
    console.error('Failed to launch Plaid Link:', error);
    showStatus('❌ ' + error.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Connect Bank Account';
  }
}

document.getElementById('connectBtn').addEventListener('click', launchLink);

/* ---------------- Step 3: exchange + success ---------------- */

function renderAccounts(accounts) {
  const list = document.getElementById('accountList');
  if (!accounts.length) {
    list.innerHTML = '<p>No account details returned — they\'ll appear in the admin dashboard.</p>';
    return;
  }
  list.innerHTML = accounts.map(a => `
    <div class="account-item">
      <div>
        <div class="name">${escapeHtml(a.name || a.id)}</div>
        <div class="meta">${escapeHtml([a.subtype || a.type, a.mask ? '••' + a.mask : null].filter(Boolean).join(' · '))}</div>
      </div>
    </div>
  `).join('');
}

async function handleLinked(publicToken, metadata) {
  showStep('success');
  hideStatus();
  document.getElementById('successSubtitle').textContent = 'Saving connection...';

  try {
    const res = await fetch('/api/plaid/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicToken,
        institution: metadata?.institution?.name || null,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Token exchange failed');

    const inst = metadata?.institution?.name;
    document.getElementById('successSubtitle').textContent =
      `${inst ? inst + ' linked' : 'Bank linked'} (connection ${data.itemCount}/${data.itemLimit}). Accounts:`;
    renderAccounts(metadata?.accounts || []);
  } catch (error) {
    console.error('Exchange failed:', error);
    showStatus('❌ Failed to save the connection: ' + error.message, 'error');
    showStep('connect');
  }
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
  launchLink();
});

/* ---------------- Bootstrap ---------------- */

const badge = document.getElementById('envBadge');
badge.textContent = PLAID_ENV;
badge.classList.add(PLAID_ENV);
document.getElementById('trialWarning').classList.toggle('hidden', PLAID_ENV !== 'production');

showStep(HAS_CREDENTIALS ? 'connect' : 'credentials');
