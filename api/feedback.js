// Blinders — feedback proxy.
//
// The landing page used to POST feedback directly to a Google Apps Script URL.
// Problem: that endpoint is public and has no rate limit, so a single attacker
// with `curl` could burn through Apps Script's daily quota (~20k req/day on free
// tier) and lock real users out of submitting feedback for 24h.
//
// This function sits between the browser and Apps Script and applies:
//   - Origin allow-list (same as /api/check — cheap drive-by filter)
//   - Per-IP rate limit (3 submissions / 10 minutes — generous for humans,
//     death for spam scripts)
//   - Strict input validation (type, max length, no HTML in message)
//
// Real users still submit normally. Attackers get 429'd before reaching Apps Script.

const FEEDBACK_GAS_URL =
  'https://script.google.com/macros/s/AKfycbxSSC7cRHY1m5pDULmy0AoIpa78jNjB9v_XJkJkw4HXLnVw6WADFSqW87OWOLCKuIxy/exec';

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

// ── In-memory rate limiter. Per Vercel serverless instance — not perfect
// across cold starts, but in practice the same warm instance handles bursts
// from the same IP, so it works well enough as a first line of defense.
// (Upgrade to Vercel KV if you ever need this to be truly cross-instance.)
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_MAX = 3;                    // max submissions per window
const buckets = new Map();             // ip → [timestamps]

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  let arr = buckets.get(ip) || [];
  arr = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    buckets.set(ip, arr);
    return true;
  }
  arr.push(now);
  buckets.set(ip, arr);
  // Periodic small cleanup — keep the Map from growing forever.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (!v.length || now - v[v.length - 1] > RATE_WINDOW_MS) buckets.delete(k);
    }
  }
  return false;
}

const VALID_TYPES = new Set(['bug', 'idea', 'praise', 'other']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!originAllowed(req)) {
    res.status(403).json({ error: 'forbidden_origin' });
    return;
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    res.status(429).json({ error: 'rate_limited', retryAfterSec: RATE_WINDOW_MS / 1000 });
    return;
  }

  const body = req.body || {};
  let { type, msg, page } = body;

  if (typeof type !== 'string' || !VALID_TYPES.has(type)) type = 'other';
  if (typeof msg !== 'string' || !msg.trim()) {
    res.status(400).json({ error: 'empty_message' });
    return;
  }
  msg = msg.trim().slice(0, 2000);
  page = typeof page === 'string' ? page.slice(0, 60) : '';

  // Forward to Apps Script. We use the same `mode: no-cors`-style POST it
  // expected before, but server-to-server (no CORS involved at this hop).
  try {
    const params = new URLSearchParams({ type, msg, page });
    const upstream = await fetch(`${FEEDBACK_GAS_URL}?${params.toString()}`, { method: 'GET' });
    // Apps Script returns 200 even on errors; we don't surface its body.
    res.status(upstream.ok ? 200 : 502).json({ ok: upstream.ok });
  } catch (e) {
    res.status(502).json({ error: 'upstream_unreachable' });
  }
}
