// Plaid API client (raw fetch — no SDK dependency).
//
// Modern endpoints only:
//  - /link/token/create          create Link tokens (new connections + update mode repairs)
//  - /item/public_token/exchange one-time exchange after Link succeeds → access_token per Item
//  - /transactions/sync          cursor-based transaction stream, per Item
//  - /accounts/get               cached accounts + balances (free; /accounts/balance/get is paid)
//  - /item/remove                permanently disconnect an Item
//
// Auth: PLAID-CLIENT-ID + PLAID-SECRET headers. API version pinned via Plaid-Version.

const PLAID_VERSION = "2020-09-14";
const PLAID_ENVS = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

// Shown in the Link UI (max 30 chars) and used as the stable, non-PII user id.
const CLIENT_NAME = "Actual Budget Sync";
const CLIENT_USER_ID = "actual-sync";

// Item errors that Link update mode can repair. When one of these comes back,
// the Item's bank login broke — flag its mappings as needsReconnect.
const RECONNECT_ERROR_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "ACCESS_NOT_GRANTED",
  "INVALID_CREDENTIALS",
  "INSUFFICIENT_CREDENTIALS",
  "PENDING_EXPIRATION",
]);

class PlaidApiError extends Error {
  constructor({ error_type, error_code, error_message, request_id }, httpStatus) {
    super(`Plaid ${error_type}/${error_code}: ${error_message}`);
    this.name = "PlaidApiError";
    this.errorType = error_type;
    this.errorCode = error_code;
    this.requestId = request_id;
    this.httpStatus = httpStatus;
  }

  get needsReconnect() {
    return RECONNECT_ERROR_CODES.has(this.errorCode);
  }
}

function baseUrl(plaidConfig) {
  const url = PLAID_ENVS[plaidConfig.env];
  if (!url) throw new Error(`Invalid Plaid env "${plaidConfig.env}" (use "sandbox" or "production")`);
  return url;
}

async function plaidRequest(plaidConfig, path, body = {}) {
  const { clientId, secret } = plaidConfig;
  if (!clientId || !secret) {
    throw new Error("Plaid is not configured (missing clientId or secret)");
  }

  const res = await fetch(`${baseUrl(plaidConfig)}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Plaid-Version": PLAID_VERSION,
      "PLAID-CLIENT-ID": clientId,
      "PLAID-SECRET": secret,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (json.error_type) throw new PlaidApiError(json, res.status);
    throw new Error(`Plaid ${path} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

// Create a Link token.
//  - New connection: products ["transactions"] + transactions.days_requested.
//  - Update mode (repair): pass accessToken and OMIT products — the Item keeps its
//    access_token; Link's onSuccess public_token must NOT be re-exchanged.
async function createLinkToken(plaidConfig, { accessToken } = {}) {
  const body = {
    client_name: CLIENT_NAME,
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: CLIENT_USER_ID },
  };

  if (accessToken) {
    body.access_token = accessToken;
  } else {
    body.products = ["transactions"];
    body.transactions = {
      days_requested: Math.min(730, Math.max(30, Number(plaidConfig.daysRequested) || 90)),
    };
  }

  const json = await plaidRequest(plaidConfig, "/link/token/create", body);
  return { linkToken: json.link_token, expiration: json.expiration };
}

// Exchange Link's one-time public_token for a permanent access_token.
async function exchangePublicToken(plaidConfig, publicToken) {
  const json = await plaidRequest(plaidConfig, "/item/public_token/exchange", {
    public_token: publicToken,
  });
  return { accessToken: json.access_token, itemId: json.item_id };
}

// Cached accounts + balances for one Item (free endpoint, refreshes ~daily).
async function getAccounts(plaidConfig, accessToken) {
  const json = await plaidRequest(plaidConfig, "/accounts/get", { access_token: accessToken });
  return { accounts: json.accounts || [], item: json.item };
}

// Permanently disconnect an Item. NOTE: on the Trial plan this does NOT free
// up an Item slot — the 10-Item limit counts all Items ever created.
async function removeItem(plaidConfig, accessToken) {
  await plaidRequest(plaidConfig, "/item/remove", { access_token: accessToken });
  return true;
}

// Pull all pending updates for an Item via /transactions/sync.
//
// Cursor semantics (per Plaid docs):
//  - cursor is per-Item; omit on the very first call to get full history
//  - page with has_more/next_cursor; the CALLER must persist the returned cursor
//    only after successfully applying the whole batch (crash-safe: a failed run
//    re-fetches the same window, and imported_id dedup makes replay idempotent)
//  - TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION → restart the whole loop from
//    the original cursor (handled here with retries)
//
// Returns { added, modified, removed, nextCursor, accounts, updateStatus }.
async function transactionsSyncAll(plaidConfig, accessToken, cursor) {
  const MAX_MUTATION_RETRIES = 3;

  for (let attempt = 0; ; attempt++) {
    try {
      const added = [];
      const modified = [];
      const removed = [];
      let accounts = [];
      let updateStatus = null;
      let pageCursor = cursor || undefined;
      let hasMore = true;

      while (hasMore) {
        const json = await plaidRequest(plaidConfig, "/transactions/sync", {
          access_token: accessToken,
          ...(pageCursor ? { cursor: pageCursor } : {}),
          count: 500,
        });

        added.push(...(json.added || []));
        modified.push(...(json.modified || []));
        removed.push(...(json.removed || []));
        if (json.accounts?.length) accounts = json.accounts;
        updateStatus = json.transactions_update_status || updateStatus;

        pageCursor = json.next_cursor;
        hasMore = json.has_more;
      }

      return { added, modified, removed, nextCursor: pageCursor, accounts, updateStatus };
    } catch (err) {
      // Data changed under us mid-pagination — restart from the original cursor
      if (
        err instanceof PlaidApiError &&
        err.errorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" &&
        attempt < MAX_MUTATION_RETRIES
      ) {
        continue;
      }
      throw err;
    }
  }
}

export {
  PlaidApiError,
  createLinkToken,
  exchangePublicToken,
  getAccounts,
  removeItem,
  transactionsSyncAll,
};
