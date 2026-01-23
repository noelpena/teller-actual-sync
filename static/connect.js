const { applicationId: APPLICATION_ID, environment: ENVIRONMENT } = window.TELLER_CONFIG;
const BASE_URL = `${window.location.origin}/api`;
const BASE_URL2 = window.location.origin;

/* ---------------- Global State ---------------- */
let enrollmentData = null;

/* ---------------- Continue Button ---------------- */
function showContinueButton(enrollment) {
  enrollmentData = enrollment;
  const container = document.getElementById('continue-setup-container');
  if (container) {
    container.classList.remove('hidden');
  }
}

async function handleContinueToSetup() {
  if (!enrollmentData) {
    alert('No enrollment data available. Please connect your bank account first.');
    return;
  }

  const btn = document.getElementById('continue-setup-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    console.log('📤 Manual save: Fetching accounts...');
    const accountsResponse = await fetch(`${BASE_URL}/accounts`, {
      headers: {
        'Authorization': enrollmentData.accessToken
      }
    });

    const accounts = await accountsResponse.json();
    console.log('📋 Accounts:', accounts);

    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts found');
    }

    const accountId = accounts[0].id;

    console.log('📤 Manual save: Sending to backend...');
    const response = await fetch(`${BASE_URL2}/api/setup/save-teller`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: enrollmentData.accessToken,
        accountId: accountId,
        userId: enrollmentData.user.id
      })
    });

    const result = await response.json();

    if (result.success) {
      console.log('✅ Manual save successful');
      alert('Bank account connected successfully! Redirecting to setup wizard...');
      window.location.href = result.redirectTo || '/setup';
    } else {
      throw new Error(result.error || 'Failed to save');
    }
  } catch (error) {
    console.error('❌ Manual save failed:', error);
    alert(`Failed to save: ${error.message}. Please try again.`);
    btn.disabled = false;
    btn.textContent = 'Continue to Setup →';
  }
}

/* ---------------- Store ---------------- */
class TellerStore {
  constructor() {
    this.keys = { enrollment: 'teller:enrollment', user: 'teller:user' };
  }
  getUser() { return this.get(this.keys.user); }
  getEnrollment() { return this.get(this.keys.enrollment); }
  putUser(user) { this.put(this.keys.user, user); }
  putEnrollment(enrollment) { this.put(this.keys.enrollment, enrollment); }
  clear() { localStorage.clear(); }
  get(key) {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }
  put(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
}

const GetTransactionStartDate = () => {
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const year = thirtyDaysAgo.getFullYear();
  const month = `0${thirtyDaysAgo.getMonth() + 1}`.slice(-2);
  const day = `0${thirtyDaysAgo.getDate()}`.slice(-2);
  return `${year}-${month}-${day}`;
};

const transactionStartDate = GetTransactionStartDate();

/* ---------------- Client ---------------- */
class Client {
  constructor() {
    this.baseURL = BASE_URL;
    this.accessToken = null;
  }

  normalizeUrl(url) {
    if (!url) return null;
    if (url.startsWith('https://api.teller.io')) {
      return url.replace('https://api.teller.io', this.baseURL);
    }
    if (url.startsWith('/')) {
      return `${this.baseURL}${url}`;
    }
    return url;
  }

  padZero(num) {
    return num.toString().padStart(2, '0');
  }

  async request(method, url, body = null, extraHeaders = {}) {
    const finalUrl = this.normalizeUrl(url);

    // Outgoing
    consoleLogWire({ direction: 'out', method, url: finalUrl, payload: body });

    const res = await fetch(finalUrl, {
      method,
      headers: {
        'Authorization': this.accessToken,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : null,
    });

    let data;
    try { data = await res.json(); } catch { data = await res.text(); }

    // Incoming
    consoleLogWire({ direction: 'in', method, url: finalUrl, status: res.status, payload: data });

    if (!res.ok) throw new Error(`${method} ${finalUrl} -> ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  listAccounts() { return this.request('GET', '/accounts'); }
  getDetails(account) { return this.request('GET', `/accounts/${account.id}/details`); }
  async getBalances(account) { 
    const balances = await this.request('GET', `/accounts/${account.id}/balances`); 
    const pong = await fetch(`${BASE_URL2}/ping`, {
      "method":"GET",
      // body: body ? JSON.stringify(body) : null,
    });

    let data;
    try { data = await pong.json(); } catch { data = await pong.text(); }

    console.log(data)
    return balances;  
  }
   async getTransactions(account) {
    const transactions = await this.request('GET', `/accounts/${account.id}/transactions?start_date=${transactionStartDate}`);
  
    const res = await fetch(`${BASE_URL2}/import-transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // 👈 REQUIRED
      body:  JSON.stringify(transactions), // already JSON.stringify'd
    });

    let data;
    try { data = await res.json(); } catch { data = await res.text(); }

    console.log(data)

    return transactions;
  }

  listPayees(account) { return this.request('GET', `/accounts/${account.id}/payees`); }
  createPayee(account, payee) { return this.request('POST', `/accounts/${account.id}/payees`, payee); }
  createPayment(account, payment) { return this.request('POST', `/accounts/${account.id}/payments`, payment); }
  discoverSchemes(account) { return this.request('OPTIONS', `/accounts/${account.id}/payments`); }
}

/* ---------------- Templates ---------------- */
class LogTemplate {
  constructor(t) { this.t = t; }
  render(r) {
    const n = this.t.content.cloneNode(true);
    n.querySelector('.resource').textContent = r.name;
    n.querySelector('.timestamp').textContent = new Date().toLocaleString();
    n.querySelector('.http').textContent = `${r.method} ${r.path}`;
    return n;
  }
}
class AccountTemplate {
  constructor(t) { this.t = t; }
  render(account, cb) {
    const n = this.t.content.cloneNode(true);
    n.querySelector('.title').textContent = [account.name, account.last_four].join(', ');
    n.querySelector('.institution').textContent = account.institution.id;
    n.querySelector('.type').textContent = account.type;
    n.querySelector('.subtype').textContent = account.subtype;

    const detailsBtn = n.querySelector('.details');
    const balancesBtn = n.querySelector('.balances');
    const txBtn = n.querySelector('.transactions');
    const payeesBtn = n.querySelector('.payees');
    const newPayeeBtn = n.querySelector('.create-payee');

    detailsBtn.onclick = () => cb.onDetails(account);
    balancesBtn.onclick = () => cb.onBalances(account);
    txBtn.onclick = () => cb.onTransactions(account);

    if (account.links && account.links.payments) {
      payeesBtn.onclick = () => cb.onPayees(account);
      newPayeeBtn.onclick = () => cb.onCreatePayee(account);
    } else {
      payeesBtn.setAttribute('disabled', true);
      newPayeeBtn.setAttribute('disabled', true);
    }
    return n;
  }
}
class DetailTemplate { constructor(t) { this.t = t; } render(d) { const n = this.t.content.cloneNode(true); n.querySelector('.number').textContent = d.account_number; n.querySelector('.ach').textContent = d.routing_numbers.ach; return n; } }
class BalanceTemplate { constructor(t) { this.t = t; } render(b) { const n = this.t.content.cloneNode(true); n.querySelector('.available').textContent = `${b.available}$`; n.querySelector('.ledger').textContent = `${b.ledger}$`; return n; } }
class TransactionTemplate { constructor(t) { this.t = t; } render(tr) { const n = this.t.content.cloneNode(true); n.querySelector('.description').textContent = tr.description; n.querySelector('.date').textContent = tr.date; n.querySelector('.amount').textContent = `${tr.amount}$`; return n; } }
class PayeeModalTemplate { constructor(t) { this.t = t; } render(nm, em) { const n = this.t.content.cloneNode(true); n.querySelector('#payee-name').value = nm; n.querySelector('#payee-email').value = em; return n; } }
class PayeeTemplate { constructor(t) { this.t = t; } render(payee, cb) { const n = this.t.content.cloneNode(true); n.querySelector('.name').textContent = payee.name; n.querySelector('.address').textContent = payee.address; n.querySelector('.create-payment').onclick = cb; return n; } }
class PaymentModalTemplate { constructor(t) { this.t = t; } render(memo, amt) { const n = this.t.content.cloneNode(true); n.querySelector('#payment-memo').value = memo; n.querySelector('#payment-amount').value = amt; return n; } }
class PaymentTemplate { constructor(t) { this.t = t; } render(payment, payee) { const n = this.t.content.cloneNode(true); n.querySelector('.name').textContent = payee.name; n.querySelector('.amount').textContent = `${payment.amount}$`; return n; } }

/* ---------------- Spinner ---------------- */
class Spinner {
  constructor(p){ this.parent=p; this.node=document.createElement('div'); this.node.classList.add('spinner'); }
  show() {
      // clear existing contents
      while (this.parent.firstChild) {
        this.parent.removeChild(this.parent.firstChild);
      }
      // then show spinner
      this.parent.appendChild(this.node);
    } 
    hide(){ if(this.node.parentNode) this.parent.removeChild(this.node); }
}

/* ---------------- Handlers ---------------- */
class EnrollmentHandler {
  constructor(client, containers, templates) {
    this.client = client;
    this.containers = containers;
    this.templates = templates;
  }

  onEnrollment(enrollment) {
    this.client.accessToken = enrollment.accessToken;
    const c = this.containers.accounts;
    const t = this.templates.account;
    const s = new Spinner(c);
    s.show();
    this.client.listAccounts()
      .then(accs => { accs.forEach(a => c.appendChild(t.render(a, this))); })
      .finally(() => s.hide());
  }

  onDetails(account) {
    const c = this.containers.logs;
    const t = this.templates.detail;
    const s = new Spinner(c);
    s.show();
    this.client.getDetails(account)
      .then(d => {
        c.prepend(t.render(d));
        c.prepend(this.templates.log.render({ method:'GET', name:'Details', path:`/accounts/${account.id}/details` }));
      })
      .finally(() => s.hide());
  }

  onBalances(account) {
    const c = this.containers.logs;
    const t = this.templates.balance;
    const s = new Spinner(c);
    s.show();
    this.client.getBalances(account)
      .then(b => {
        c.prepend(t.render(b));
        c.prepend(this.templates.log.render({ method:'GET', name:'Balances', path:`/accounts/${account.id}/balances` }));
      })
      .finally(() => s.hide());
  }

  onTransactions(account) {
    const c = this.containers.logs;
    const t = this.templates.transaction;
    const s = new Spinner(c);
    s.show();
    this.client.getTransactions(account)
      .then(txs => {
        txs.reverse().forEach(tx => c.prepend(t.render(tx)));
        c.prepend(this.templates.log.render({ method:'GET', name:'Transactions', path:`/accounts/${account.id}/transactions` }));
      })
      .finally(() => s.hide());
  }

  onPayees(account) {
    const c = this.containers.logs;
    const t = this.templates.payee;
    const s = new Spinner(c);
    s.show();
    this.client.listPayees(account)
      .then(payees => {
        payees.forEach(payee => {
          const cb = () => this.onCreatePayment(account, payee);
          c.prepend(t.render(payee, cb));
        });
        c.prepend(this.templates.log.render({ method:'GET', name:'Payees', path:`/accounts/${account.id}/payees` }));
      })
      .finally(() => s.hide());
  }

  onCreatePayee(account) {
    const c = this.containers.logs;
    const root = this.containers.root;
    const mt = this.templates.payeeModal;
    const s = new Spinner(c);
    const p = generatePerson();
    const m = mt.render(p.name, p.email);
    root.append(m);

    const close = () => { const el = document.getElementById('payee-modal'); if (el) el.remove(); };
    document.getElementById('submit-payee').onclick = () => {
      const name = document.getElementById('payee-name').value;
      const email = document.getElementById('payee-email').value;
      close();
      s.show();
      const payee = { scheme:'zelle', address:email, name, type:'person' };
      this.client.createPayee(account, payee)
        .then(resp => this.onPayeeResponse(account, payee, resp))
        .finally(() => s.hide());
    };
    document.getElementById('payee-modal').onclick = () => close();
    document.getElementById('payee-modal-content').onclick = e => e.stopPropagation();
  }

  onCreatePayment(account, payee) {
    const c = this.containers.logs;
    const root = this.containers.root;
    const mt = this.templates.paymentModal;
    const s = new Spinner(c);
    const m = mt.render('Teller test', `${Math.ceil(Math.random() * 100)}.00`);
    root.append(m);

    const close = () => { const el = document.getElementById('payment-modal'); if (el) el.remove(); };
    document.getElementById('submit-payment').onclick = () => {
      const memo = document.getElementById('payment-memo').value;
      const amount = document.getElementById('payment-amount').value;
      close();
      s.show();
      const payment = { amount, memo, payee: { scheme:'zelle', address: payee.address } };
      this.client.createPayment(account, payment)
        .then(resp => this.onPaymentResponse(account, payee, payment, resp))
        .finally(() => s.hide());
    };
    document.getElementById('payment-modal').onclick = () => close();
    document.getElementById('payment-modal-content').onclick = e => e.stopPropagation();
  }

  onPayeeResponse(account, payee, resp) {
    const c = this.containers.logs;
    const t = this.templates.payee;
    const h = this.templates.log.render({ method:'POST', name:'Payees', path:`/accounts/${account.id}/payees` });
    const cb = () => this.onCreatePayment(account, payee);

    if (resp.connect_token) {
      const s = new Spinner(c); s.show();
      const tc = TellerConnect.setup({
        applicationId: APPLICATION_ID,
        environment: ENVIRONMENT,
        connectToken: resp.connect_token,
        onSuccess: () => { c.prepend(t.render(payee, cb)); c.prepend(h); s.hide(); },
        onFailure: () => s.hide()
      });
      tc.open();
    } else {
      c.prepend(t.render(payee, cb));
      c.prepend(h);
    }
  }

  onPaymentResponse(account, payee, payment, resp) {
    const c = this.containers.logs;
    const t = this.templates.payment;
    const h = this.templates.log.render({ method:'POST', name:'Payments', path:`/accounts/${account.id}/payments` });

    if (resp.connect_token) {
      const s = new Spinner(c); s.show();
      const tc = TellerConnect.setup({
        applicationId: APPLICATION_ID,
        environment: ENVIRONMENT,
        connectToken: resp.connect_token,
        onSuccess: () => { c.prepend(t.render(payment, payee)); c.prepend(h); s.hide(); },
        onFailure: () => s.hide()
      });
      tc.open();
    } else {
      c.prepend(t.render(payment, payee));
      c.prepend(h);
    }
  }

  clear() {
    Object.values(this.containers).forEach(p => { while (p.firstChild) p.removeChild(p.firstChild); });
  }
}

/* ---------------- User + Status ---------------- */
class UserHandler {
  constructor(l) { this.labels = l; }
  onEnrollment(e) { this.labels.userId.textContent = e.user.id; this.labels.accessToken.textContent = e.accessToken; }
  clear() { Object.values(this.labels).forEach(n => n.textContent = 'not_available'); }
}
class StatusHandler {
  constructor(b) { this.connected = false; this.button = b; }
  onEnrollment() { this.setConnected(true); this.button.textContent = 'Disconnect'; }
  toggle(cb) {
    if (this.connected) { this.setConnected(false); this.button.textContent = 'Connect'; cb.onDisconnect(); }
    else { cb.onConnect(); }
  }
  setConnected(c) { this.connected = c; }
}

/* ---------------- Utilities ---------------- */
function generatePerson(){
  const pick=a=>a[Math.floor(Math.random()*a.length)];
  const fn=pick(['William','James','Evelyn','Harper','Mason','Ella','Jackson','Avery','Scarlett','Jack']);
  const ml=pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const ln=pick(['Adams','Wilson','Burton','Harris','Stevens','Robinson','Lewis','Walker','Payne','Baker']);
  const user=(Math.random()+1).toString(36).substring(2);
  return {name:`${fn} ${ml}. ${ln}`, email:`${user}@teller.io`};
}

function consoleLogWire({ direction, method, url, status, payload }) {
  const consoleEl = document.getElementById('console-log');
  if (!consoleEl) return;

  const entry = document.createElement('div');
  const ts = new Date().toLocaleTimeString();

  // stringify only if payload is truthy and non-empty
  let json = '';
  if (payload && !(typeof payload === 'object' && Object.keys(payload).length === 0)) {
    try { json = JSON.stringify(payload, null, 2); } catch { json = String(payload); }
  }

  entry.innerHTML = `
    <div class="mb-1">
      <span class="text-gray-500">${ts}</span>
      ${direction === 'out' ? '➡️' : '⬅️'} ${method} ${url}${status ? ' (' + status + ')' : ''}
    </div>
    ${json ? `<pre><code class="json hljs">${json}</code></pre>` : ''}
  `;

  consoleEl.appendChild(entry);
  consoleEl.scrollTop = consoleEl.scrollHeight;

  entry.querySelectorAll('code').forEach(block => {
    if (window.hljs) window.hljs.highlightElement(block);
  });
}

/* ---------------- Bootstrap ---------------- */
document.addEventListener('DOMContentLoaded', function(){
  const containers = {
    accounts: document.getElementById('accounts'),
    logs: document.getElementById('logs'),
    root: document.body
  };
  const templates = {
    log: new LogTemplate(document.getElementById('log-template')),
    account: new AccountTemplate(document.getElementById('account-template')),
    detail: new DetailTemplate(document.getElementById('detail-template')),
    balance: new BalanceTemplate(document.getElementById('balance-template')),
    transaction: new TransactionTemplate(document.getElementById('transaction-template')),
    payee: new PayeeTemplate(document.getElementById('payee-template')),
    payment: new PaymentTemplate(document.getElementById('payment-template')),
    payeeModal: new PayeeModalTemplate(document.getElementById('payee-modal-template')),
    paymentModal: new PaymentModalTemplate(document.getElementById('payment-modal-template'))
  };
  const labels = { userId: document.getElementById('user-id'), accessToken: document.getElementById('access-token') };
  const store = new TellerStore();
  const client = new Client();
  const enrollmentHandler = new EnrollmentHandler(client, containers, templates);
  const userHandler = new UserHandler(labels);
  const statusHandler = new StatusHandler(document.getElementById('teller-connect'));

  const tc = TellerConnect.setup({
    applicationId: APPLICATION_ID,
    environment: ENVIRONMENT,
    selectAccount: 'multiple',
    onSuccess: async e => {
      document.getElementById('console-container').classList.remove('hidden');
      store.putUser(e.user);
      store.putEnrollment(e);
      enrollmentHandler.onEnrollment(e);
      userHandler.onEnrollment(e);
      statusHandler.onEnrollment(e);

      // Auto-save Teller credentials to backend
      try {
        console.log('🔍 Enrollment data received:', e);

        // Fetch the accounts using the access token to get the account IDs
        let accountId = null;
        let fetchSuccess = false;

        try {
          console.log('📡 Fetching accounts from Teller API...');
          const accountsResponse = await fetch(`${BASE_URL}/accounts`, {
            headers: {
              'Authorization': e.accessToken
            }
          });

          const accounts = await accountsResponse.json();
          console.log('📋 Accounts received:', accounts);

          // Get the first account
          if (accounts && accounts.length > 0) {
            accountId = accounts[0].id;
            fetchSuccess = true;
            console.log('✅ Account ID extracted:', accountId);
          }
        } catch (fetchError) {
          console.error('❌ Error fetching accounts:', fetchError);
        }

        console.log('📋 Extracted data:', {
          accessToken: e.accessToken ? `${e.accessToken.substring(0, 10)}...` : 'missing',
          accountId: accountId || 'missing',
          userId: e.user?.id || 'missing'
        });

        if (!fetchSuccess || !accountId) {
          console.error('❌ No account ID found - showing manual continue button');
          // Show the manual continue button
          showContinueButton(e);
          return;
        }

        console.log('📤 Sending request to /api/setup/save-teller...');
        const response = await fetch(`${BASE_URL2}/api/setup/save-teller`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: e.accessToken,
            accountId: accountId,
            userId: e.user.id
          })
        });

        console.log('📥 Response status:', response.status);
        const result = await response.json();
        console.log('📥 Response data:', result);

        if (result.success) {
          console.log('✅ Teller credentials saved successfully');
          // Show success message and redirect after a brief delay
          setTimeout(() => {
            alert('Bank account connected successfully! Redirecting to setup wizard...');
            window.location.href = result.redirectTo || '/setup';
          }, 1000);
        } else {
          console.error('❌ Failed to save credentials:', result.error);
          // Show the manual continue button
          showContinueButton(e);
        }
      } catch (error) {
        console.error('❌ Error auto-saving Teller credentials:', error);
        console.error('Error details:', error.stack);
        // Show the manual continue button
        showContinueButton(e);
      }
    }
  });

  document.getElementById('teller-connect').onclick = () => statusHandler.toggle({
    onConnect: () => tc.open(),
    onDisconnect: () => { enrollmentHandler.clear(); userHandler.clear(); store.clear(); location.reload(); }
  });

  // Continue to Setup button handler
  const continueBtn = document.getElementById('continue-setup-btn');
  if (continueBtn) {
    continueBtn.onclick = handleContinueToSetup;
  }

  const e = store.getEnrollment();
  if (e) {
    document.getElementById('console-container').classList.remove('hidden');
    enrollmentHandler.onEnrollment(e);
    userHandler.onEnrollment(e);
    statusHandler.onEnrollment(e);

    // Show the continue button for existing enrollment
    showContinueButton(e);

    // Auto-save if user is already connected and hasn't saved yet
    (async () => {
      try {
        console.log('🔄 User already connected, checking if credentials need to be saved...');

        // Fetch the accounts using the access token
        const accountsResponse = await fetch(`${BASE_URL}/accounts`, {
          headers: {
            'Authorization': e.accessToken
          }
        });

        const accounts = await accountsResponse.json();
        console.log('📋 Accounts from existing connection:', accounts);

        if (accounts && accounts.length > 0) {
          const accountId = accounts[0].id;

          console.log('📤 Checking current config status...');
          const statusResponse = await fetch(`${BASE_URL2}/api/config/status`);
          const configStatus = await statusResponse.json();

          // Only auto-save if Teller config is not already complete
          if (!configStatus.hasTellerConfig) {
            console.log('💾 Auto-saving existing Teller connection...');

            const saveResponse = await fetch(`${BASE_URL2}/api/setup/save-teller`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                accessToken: e.accessToken,
                accountId: accountId,
                userId: e.user.id
              })
            });

            const result = await saveResponse.json();

            if (result.success) {
              console.log('✅ Existing connection saved successfully');
              setTimeout(() => {
                alert('Existing bank connection found! Redirecting to setup wizard...');
                window.location.href = result.redirectTo || '/setup';
              }, 1000);
            }
          } else {
            console.log('ℹ️ Teller already configured, skipping auto-save');
          }
        }
      } catch (error) {
        console.error('⚠️ Error checking existing connection:', error);
        // Don't show alert for this, just log it
      }
    })();
  }

  /* ---------- Console Drawer: persistent resizer, minimize (log-only), restore, clear hotkey ---------- */
  const consoleContainer = document.getElementById('console-container');
  const resizer = document.getElementById('console-resizer');
  const consoleLog = document.getElementById('console-log');
  const statusbar = document.getElementById('statusbar');

  // Optional: keep layout paddings in sync if your CSS uses --console-h / --footer-h
  const root = document.documentElement;
  function setFooterVar() {
    const h = statusbar ? statusbar.getBoundingClientRect().height : 0;
    root.style.setProperty('--footer-h', `${Math.ceil(h)}px`);
  }
  function setConsoleVar() {
    const h = consoleContainer ? consoleContainer.getBoundingClientRect().height : 0;
    root.style.setProperty('--console-h', `${Math.ceil(h)}px`);
  }
  setFooterVar(); setConsoleVar();
  window.addEventListener('resize', () => { setFooterVar(); setConsoleVar(); });

  let lastHeight = Math.max(consoleContainer.offsetHeight, resizer.offsetHeight + 1);
  let isResizing = false;
  // Change cursor on hover
  resizer.addEventListener('mouseenter', () => {
    if (!isResizing) {
      resizer.style.cursor = 'ns-resize';
    }
  });

  resizer.addEventListener('mouseleave', () => {
    if (!isResizing) {
      resizer.style.cursor = '';
    }
  });
  // Drag to resize (container grows/shrinks; log shown when height > bar)
  resizer.addEventListener('mousedown', () => {
    isResizing = true;
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newHeight = window.innerHeight - e.clientY;
    const minH = resizer.offsetHeight; // keep bar visible
    if (newHeight >= 0 && newHeight < window.innerHeight - 100) {
      const h = Math.max(minH, newHeight);
      consoleContainer.style.height = `${h}px`;
      if (h > minH) {
        consoleLog.style.display = 'block';
        lastHeight = h;
        consoleContainer.dataset.minimized = 'false';
      }
      setConsoleVar();
    }
  });

  window.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.userSelect = '';
    }
  });

  // Double-click toggle: collapse log only, container to bar height; restore to lastHeight
  resizer.addEventListener('dblclick', () => {
    const barH = resizer.offsetHeight || 8;
    if (consoleContainer.dataset.minimized === 'true') {
      // restore
      consoleContainer.style.height = `${Math.max(lastHeight, barH + 100) - 32}px`;
      consoleLog.style.display = 'block';
      consoleContainer.dataset.minimized = 'false';
    } else {
      // minimize to bar only
      lastHeight = consoleContainer.offsetHeight || lastHeight || 200;
      consoleLog.style.display = 'none';
      consoleContainer.style.height = `${barH + 32}px`;
      consoleContainer.dataset.minimized = 'true';
    }
    setConsoleVar();
  });

  // Cmd+K (Mac) / Ctrl+K clear console
  window.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const metaKey = isMac ? e.metaKey : e.ctrlKey;
    if (metaKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      consoleLog.innerHTML = '';
    }
  });
});