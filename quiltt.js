// Quiltt API client.
//
// Two auth scopes:
//  - Environment scope (Bearer API secret): issuing session tokens, listing profiles.
//  - Profile scope (Basic profileId:apiSecret): all GraphQL data access. Server-to-server
//    Basic auth is not subject to the per-profile session token rate limits (10/hr, 20/day),
//    so the sync always uses it. Session tokens are only issued to launch the Connector UI.
//
// Unified account/transaction/balance data lives in Quiltt's GraphQL API — the REST API
// only covers auth, profiles, webhooks and provider passthrough.

const QUILTT_API_BASE = "https://api.quiltt.io";
const QUILTT_AUTH_BASE = "https://auth.quiltt.io";
const GRAPHQL_URL = `${QUILTT_API_BASE}/v1/graphql`;
const SESSIONS_URL = `${QUILTT_AUTH_BASE}/v1/users/sessions`;

// Thrown when Quiltt rejects our credentials (bad API secret or unknown profile).
// Callers use this to distinguish "fix your config" from transient/API errors.
class QuilttAuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "QuilttAuthError";
    this.statusCode = statusCode;
  }
}

// Connection statuses that mean the user must re-run the Connector to repair the link.
function connectionNeedsRepair(status) {
  if (!status) return false;
  const s = String(status).toUpperCase();
  return s.startsWith("ERROR") || s === "DISCONNECTED";
}

function profileBasicAuth(profileId, apiSecret) {
  return `Basic ${Buffer.from(`${profileId}:${apiSecret}`).toString("base64")}`;
}

// Execute a GraphQL query against a Profile's data.
async function gql({ quiltt, query, variables }) {
  const { profileId, apiSecret } = quiltt;
  if (!profileId || !apiSecret) {
    throw new Error("Quiltt is not configured (missing profileId or apiSecret)");
  }

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: profileBasicAuth(profileId, apiSecret),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => "");
    throw new QuilttAuthError(
      `Quiltt auth error ${res.status}: check API secret and profile ID. ${body}`.trim(),
      res.status
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Quiltt GraphQL HTTP ${res.status}: ${body}`);
  }

  const json = await res.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Quiltt GraphQL error: ${json.errors.map(e => e.message).join("; ")}`);
  }
  return json.data;
}

// Issue a Session token (creates a new Profile when profileId is omitted).
// Returns { token, profileId, expiresAt }.
async function issueSessionToken({ apiSecret, profileId }) {
  if (!apiSecret) throw new Error("Quiltt API secret is not configured");

  const res = await fetch(SESSIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(profileId ? { userId: profileId } : { metadata: { source: "actual-sync" } }),
  });

  const body = await res.json().catch(() => ({}));

  if (res.status === 401 || res.status === 403) {
    throw new QuilttAuthError(`Quiltt rejected the API secret (${res.status})`, res.status);
  }
  if (res.status === 429) {
    throw new Error("Quiltt session token rate limit hit (10/hour per profile). Try again later.");
  }
  if (!res.ok) {
    throw new Error(`Quiltt session request failed (${res.status}): ${JSON.stringify(body)}`);
  }

  return { token: body.token, profileId: body.userId, expiresAt: body.expiresAt };
}

// Verify the API secret works at environment scope. Returns { ok, error? }.
async function testApiSecret(apiSecret) {
  try {
    const res = await fetch(`${QUILTT_API_BASE}/v1/profiles?limit=1`, {
      headers: { Authorization: `Bearer ${apiSecret}` },
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Quiltt returned ${res.status}: ${body.slice(0, 300)}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// List all accounts on the profile, with connection status + latest balance.
async function fetchAccounts({ quiltt }) {
  const data = await gql({
    quiltt,
    query: `
      query {
        accounts {
          id
          name
          kind
          institution { name }
          connection { id status }
          balance { current available at }
        }
      }
    `,
  });
  return (data.accounts || []).map(a => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    institution: a.institution?.name || null,
    connectionId: a.connection?.id || null,
    connectionStatus: a.connection?.status || null,
    balance: a.balance?.current ?? a.balance?.available ?? null,
    balanceAt: a.balance?.at || null,
  }));
}

// Fetch one account's balance + connection status (used for reconcile).
async function fetchAccount({ quiltt, accountId }) {
  const data = await gql({
    quiltt,
    query: `
      query {
        account(id: "${accountId}") {
          id
          name
          kind
          connection { id status }
          balance { current available at }
        }
      }
    `,
  });
  if (!data.account) throw new Error(`Quiltt account not found: ${accountId}`);
  return data.account;
}

// Fetch transactions for one account since startDate (YYYY-MM-DD).
// Cursor-paginated at Quiltt's 100-records-per-page cap.
// Returns { transactions, connection } — connection.status lets the caller
// flag mappings whose bank link needs repair.
async function fetchTransactions({ quiltt, accountId, startDate }) {
  const transactions = [];
  let after = null;
  let connection = null;
  const MAX_PAGES = 100; // 10k transactions — far beyond any sane sync window

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await gql({
      quiltt,
      query: `
        query FetchTransactions($after: String) {
          account(id: "${accountId}") {
            connection { id status }
            transactions(
              first: 100,
              after: $after,
              sort: DATE_DESC,
              filter: { date_gte: "${startDate}" }
            ) {
              nodes { id date description amount status entryType }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `,
      variables: { after },
    });

    if (!data.account) throw new Error(`Quiltt account not found: ${accountId}`);
    connection = data.account.connection || connection;

    const conn = data.account.transactions;
    transactions.push(...(conn?.nodes || []));

    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  return { transactions, connection };
}

export {
  QuilttAuthError,
  connectionNeedsRepair,
  issueSessionToken,
  testApiSecret,
  fetchAccounts,
  fetchAccount,
  fetchTransactions,
};
