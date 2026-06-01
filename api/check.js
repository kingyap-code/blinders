// Blinders — subscription access check (single serverless function).
//
// The app calls this to answer ONE question: does this person have an active
// paid plan? It asks Paddle directly using the secret API key (server-side only),
// so the key is never exposed to the browser.
//
// Three ways the app calls it (POST JSON body):
//   { transactionId: "txn_..." }   → just after checkout — figure out what they bought
//   { subscriptionId: "sub_..." }  → on app load — is the monthly sub still active?
//   { email: "a@b.com" }           → "Restore access" — look them up by email
//
// Always responds 200 with: { plan: "free" | "pro" | "lifetime", subscriptionId?, transactionId?, expiresAt? }
// "free" means no active paid plan was found (or we couldn't confirm one).
//
// Required environment variable (set in Vercel dashboard):
//   PADDLE_API_KEY  — a Paddle (production) API key with read access.

// ── Your Paddle price IDs (from the checkout buttons). Edit here if they change. ──
const PRO_PRICE = 'pri_01ks1twfe0r7995nfbbte7nrw3';      // monthly subscription
const LIFETIME_PRICE = 'pri_01ks1tzeg628mrqt3h9zgwrjfw'; // one-time lifetime

const PADDLE_API = 'https://api.paddle.com';

// ── Origins allowed to call this endpoint. Browsers send the real Origin header
// automatically — attackers running curl/scripts can spoof it, so this isn't a
// security boundary, just a cheap filter against drive-by abuse from random pages.
const ALLOWED_HOST_SUFFIXES = ['blinders.pro', '.vercel.app', 'localhost', '127.0.0.1'];

function originAllowed(req) {
  const raw = req.headers.origin || req.headers.referer || '';
  if (!raw) return false;
  let host;
  try { host = new URL(raw).hostname; } catch (e) { return false; }
  return ALLOWED_HOST_SUFFIXES.some(
    (s) => host === s || host.endsWith(s.startsWith('.') ? s : '.' + s) || host === s.replace(/^\./, '')
  );
}

// ── Strict input shapes. Anything that doesn't look like a real Paddle id or a
// real email gets rejected before we burn a Paddle API call on it.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,30}$/;
const TXN_RE = /^txn_[a-z0-9]{4,60}$/;
const SUB_RE = /^sub_[a-z0-9]{4,60}$/;

function validEmail(v) { return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v); }
function validTxn(v)   { return typeof v === 'string' && TXN_RE.test(v); }
function validSub(v)   { return typeof v === 'string' && SUB_RE.test(v); }

// ── Per-IP rate limiter. Real users hit this 1–2 times per session; we cap at
// 20 requests/min/IP, which is generous enough to absorb retries and impossible
// to hit organically. An attacker scripting /api/check gets 429'd after #20
// and never reaches Paddle, so they can't drain our Paddle rate budget.
//
// Storage is in-memory (per warm serverless instance). Not perfectly accurate
// across cold starts, but Vercel reuses warm instances for bursts from the
// same client, so it works well as a first line of defense. Upgrade to Vercel
// KV if/when this needs to be truly cross-instance.
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 20;
const rlBuckets = new Map(); // ip → [timestamps]

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  let arr = rlBuckets.get(ip) || [];
  arr = arr.filter((t) => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) {
    rlBuckets.set(ip, arr);
    return true;
  }
  arr.push(now);
  rlBuckets.set(ip, arr);
  // Bounded cleanup so the Map can't grow unbounded over a warm instance's life.
  if (rlBuckets.size > 5000) {
    for (const [k, v] of rlBuckets) {
      if (!v.length || now - v[v.length - 1] > RL_WINDOW_MS) rlBuckets.delete(k);
    }
  }
  return false;
}

async function paddleGet(path, apiKey) {
  const res = await fetch(PADDLE_API + path, {
    headers: { Authorization: 'Bearer ' + apiKey },
  });
  if (!res.ok) return null;
  return res.json();
}

// Pull the list of price IDs out of a transaction (handles both field shapes).
function priceIdsOf(entity) {
  const items = entity?.items || entity?.line_items || [];
  return items.map((i) => i?.price?.id || i?.price_id).filter(Boolean);
}

// Given a subscription id, return a plan result if it's currently active.
async function fromSubscription(subscriptionId, apiKey) {
  const sub = await paddleGet('/subscriptions/' + encodeURIComponent(subscriptionId), apiKey);
  const data = sub?.data;
  if (!data) return null;
  const active = data.status === 'active' || data.status === 'trialing';
  if (!active) return null;
  return {
    plan: 'pro',
    subscriptionId: data.id,
    expiresAt: data.current_billing_period?.ends_at || null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!originAllowed(req)) {
    res.status(403).json({ error: 'forbidden_origin' });
    return;
  }

  // Rate limit BEFORE we read Paddle, so attackers can't burn our Paddle
  // budget. The 429 response keeps semantics consistent with real HTTP clients
  // (browsers/curl/scripts all understand it).
  if (rateLimited(clientIp(req))) {
    res.setHeader('Retry-After', String(RL_WINDOW_MS / 1000));
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    // Backend not configured yet — tell the app so it can fail safe.
    res.status(200).json({ plan: 'free', error: 'server_not_configured' });
    return;
  }

  const body = req.body || {};
  const transactionId = body.transactionId;
  const subscriptionId = body.subscriptionId;
  const email = body.email;

  try {
    // ── Just after checkout: inspect the transaction to see what they bought. ──
    if (transactionId) {
      if (!validTxn(transactionId)) { res.status(400).json({ error: 'bad_transaction_id' }); return; }
      const tx = await paddleGet('/transactions/' + encodeURIComponent(transactionId), apiKey);
      const data = tx?.data;
      if (data) {
        if (priceIdsOf(data).includes(LIFETIME_PRICE)) {
          res.status(200).json({ plan: 'lifetime', transactionId: data.id });
          return;
        }
        if (data.subscription_id) {
          const result = await fromSubscription(data.subscription_id, apiKey);
          if (result) { res.status(200).json(result); return; }
        }
      }
      res.status(200).json({ plan: 'free' });
      return;
    }

    // ── On app load: re-check the monthly subscription is still active. ──
    if (subscriptionId) {
      if (!validSub(subscriptionId)) { res.status(400).json({ error: 'bad_subscription_id' }); return; }
      const result = await fromSubscription(subscriptionId, apiKey);
      res.status(200).json(result || { plan: 'free' });
      return;
    }

    // ── Restore access: find the customer by email, then their active plan. ──
    if (email) {
      if (!validEmail(email)) { res.status(400).json({ error: 'bad_email' }); return; }
      const cust = await paddleGet('/customers?email=' + encodeURIComponent(email), apiKey);
      const customer = cust?.data?.[0];
      if (!customer) { res.status(200).json({ plan: 'free' }); return; }

      // Active monthly subscription?
      const subs = await paddleGet('/subscriptions?customer_id=' + encodeURIComponent(customer.id), apiKey);
      const activeSub = (subs?.data || []).find(
        (s) => s.status === 'active' || s.status === 'trialing'
      );
      if (activeSub) {
        res.status(200).json({
          plan: 'pro',
          subscriptionId: activeSub.id,
          expiresAt: activeSub.current_billing_period?.ends_at || null,
        });
        return;
      }

      // Otherwise a completed lifetime purchase?
      const txs = await paddleGet('/transactions?customer_id=' + encodeURIComponent(customer.id), apiKey);
      const lifeTx = (txs?.data || []).find(
        (t) =>
          ['completed', 'paid', 'billed'].includes(t.status) &&
          priceIdsOf(t).includes(LIFETIME_PRICE)
      );
      if (lifeTx) { res.status(200).json({ plan: 'lifetime', transactionId: lifeTx.id }); return; }

      res.status(200).json({ plan: 'free' });
      return;
    }

    res.status(400).json({ error: 'missing_identifier' });
  } catch (e) {
    // Never hard-fail: if Paddle is unreachable, the app falls back to its cached plan.
    res.status(200).json({ plan: 'free', error: 'lookup_failed' });
  }
}
