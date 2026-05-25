// Blinders — client-side plan/access state. Loaded by both index.html and app.html.
//
// Single source of truth for "is this person Pro / Lifetime / Free?".
// It asks the backend (/api/check) which talks to Paddle. The result is cached in
// localStorage so the app still works offline and survives a brief Paddle outage
// without locking out paying customers.
//
// NOTE: this is a client-side gate. It stops casual/non-technical bypass (your
// whole audience), but a determined developer could override it in DevTools — that
// is true of any static web app and is acceptable for this stage.
//
// Exposes window.BlindersPlan with: get(), isPro(), refresh(), activate(txId),
// restore(email), promptRestore().

(function () {
  var KEY = 'blinders_access';            // { plan, ref, ts }
  var GRACE_MS = 7 * 24 * 60 * 60 * 1000; // trust cached plan up to 7 days if backend unreachable

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function write(plan, ref) {
    try { localStorage.setItem(KEY, JSON.stringify({ plan: plan, ref: ref || null, ts: Date.now() })); } catch (e) {}
  }
  function clearStored() { try { localStorage.removeItem(KEY); } catch (e) {} }

  // Dev unlock: visiting any URL with ?unlock=<DEV_UNLOCK_TOKEN> persists a flag that
  // promotes this browser to lifetime locally. Lets King test paid features on his own
  // machine without affecting real users. Not a security boundary — see file header.
  // To revert: DevTools → Application → Local Storage → delete `blinders_dev_unlock`.
  var DEV_KEY = 'blinders_dev_unlock';
  var DEV_UNLOCK_TOKEN = 'blinders-dev-Qm7K3pNvR4sT9xL1hZ6cF5bY8dV2wJaH';
  function devUnlocked() {
    try {
      var params = new URLSearchParams(window.location.search);
      if (params.get('unlock') === DEV_UNLOCK_TOKEN) {
        localStorage.setItem(DEV_KEY, '1');
      }
      return localStorage.getItem(DEV_KEY) === '1';
    } catch (e) { return false; }
  }
  var IS_DEV = devUnlocked();

  // Current plan used synchronously by feature gates. Seed from cache, refine via server.
  var current = 'free';
  if (IS_DEV) {
    current = 'lifetime';
  } else {
    var cached = read();
    if (cached && cached.plan &&
        (cached.plan === 'lifetime' || (Date.now() - (cached.ts || 0)) < GRACE_MS)) {
      current = cached.plan;
    }
  }

  function isPro() { return current === 'pro' || current === 'lifetime'; }

  function onChange() {
    if (document.body) document.body.setAttribute('data-plan', current);
    var label = current === 'lifetime' ? 'Lifetime' : current === 'pro' ? 'Pro' : 'Free';
    document.querySelectorAll('.strip-profile-plan, .popup-top-plan').forEach(function (el) { el.textContent = label; });
    if (typeof window.onBlindersPlanChange === 'function') {
      try { window.onBlindersPlanChange(current); } catch (e) {}
    }
  }

  async function callCheck(payload) {
    var res = await fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  function applyResult(data, refOverride) {
    current = data.plan;
    var ref = refOverride || null;
    if (!ref) {
      if (data.subscriptionId) ref = { kind: 'sub', id: data.subscriptionId };
      else if (data.transactionId) ref = { kind: 'tx', id: data.transactionId };
    }
    write(current, ref);
    onChange();
  }

  // Re-verify on load using whatever identifier we stored.
  async function refresh() {
    if (IS_DEV) return; // dev unlock pins this browser to lifetime; skip server check
    var c = read();
    if (!c || !c.ref) return;
    var payload = {};
    if (c.ref.kind === 'sub') payload.subscriptionId = c.ref.id;
    else if (c.ref.kind === 'tx') payload.transactionId = c.ref.id;
    else if (c.ref.kind === 'email') payload.email = c.ref.value;
    else return;
    try {
      var data = await callCheck(payload);
      if (data && data.plan && data.plan !== 'free') {
        applyResult(data, c.ref.kind === 'email' ? c.ref : null);
      } else if (data && data.plan === 'free' && !data.error) {
        // Backend definitively confirmed no active plan → downgrade.
        current = 'free'; clearStored(); onChange();
      }
      // On error (server_not_configured / lookup_failed) keep the cached plan.
    } catch (e) { /* offline → keep cached plan */ }
  }

  // Called right after a successful Paddle checkout.
  async function activate(transactionId) {
    try {
      var data = await callCheck({ transactionId: transactionId });
      if (data && data.plan && data.plan !== 'free') { applyResult(data); return current; }
    } catch (e) {}
    return 'free';
  }

  // "Restore access" — look up by the email they paid with.
  async function restore(email) {
    try {
      var data = await callCheck({ email: email });
      if (data && data.plan && data.plan !== 'free') {
        applyResult(data, { kind: 'email', value: email });
        return current;
      }
    } catch (e) {}
    return 'free';
  }

  // Self-contained restore dialog (inline styles so it works on both pages).
  function promptRestore() {
    if (document.getElementById('blindersRestoreOverlay')) return;
    var ov = document.createElement('div');
    ov.id = 'blindersRestoreOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';
    ov.innerHTML =
      '<div style="background:#1a1c20;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:24px;max-width:380px;width:90%;font-family:inherit;box-shadow:0 20px 60px rgba(0,0,0,0.5);">' +
        '<div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:6px;">Restore your access</div>' +
        '<div style="font-size:13px;color:rgba(255,255,255,0.55);margin-bottom:16px;line-height:1.4;">Enter the email you paid with and we’ll unlock your plan on this device.</div>' +
        '<input id="blindersRestoreEmail" type="email" autocomplete="email" placeholder="you@email.com" style="width:100%;box-sizing:border-box;padding:11px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:#fff;font-size:14px;font-family:inherit;margin-bottom:10px;outline:none;">' +
        '<div id="blindersRestoreMsg" style="font-size:12.5px;min-height:18px;margin-bottom:10px;line-height:1.3;"></div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
          '<button id="blindersRestoreCancel" style="padding:9px 16px;border-radius:9px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;font-size:13px;cursor:pointer;font-family:inherit;">Cancel</button>' +
          '<button id="blindersRestoreGo" style="padding:9px 16px;border-radius:9px;border:none;background:#3DDC97;color:#0F0F10;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;">Restore</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    var emailEl = ov.querySelector('#blindersRestoreEmail');
    var msgEl = ov.querySelector('#blindersRestoreMsg');
    var goBtn = ov.querySelector('#blindersRestoreGo');
    setTimeout(function () { emailEl.focus(); }, 50);
    function close() { ov.remove(); }
    ov.querySelector('#blindersRestoreCancel').onclick = close;
    ov.onclick = function (e) { if (e.target === ov) close(); };
    goBtn.onclick = async function () {
      var email = (emailEl.value || '').trim();
      if (!email || email.indexOf('@') < 1) {
        msgEl.style.color = '#FF5A5F'; msgEl.textContent = 'Please enter a valid email.'; return;
      }
      goBtn.disabled = true; goBtn.textContent = 'Checking…';
      msgEl.style.color = 'rgba(255,255,255,0.55)'; msgEl.textContent = 'Looking up your account…';
      var plan = await restore(email);
      if (plan !== 'free') {
        msgEl.style.color = '#3DDC97';
        msgEl.textContent = (plan === 'lifetime' ? 'Lifetime' : 'Pro') + ' access restored! Reloading…';
        setTimeout(function () { location.reload(); }, 1200);
      } else {
        goBtn.disabled = false; goBtn.textContent = 'Restore';
        msgEl.style.color = '#FF5A5F';
        msgEl.textContent = 'No active plan found for that email. Make sure it matches your receipt.';
      }
    };
    emailEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') goBtn.click(); });
  }

  // Single source of truth for displayed prices. Update here if prices change in
  // Paddle so the in-app upgrade modal stays in sync. (The landing page in
  // index.html has standalone marketing copy and is edited manually alongside.)
  var PRICING = {
    pro:      { price: '$15',  unit: '/ month' },
    lifetime: { price: '$179', unit: '/ once'  },
  };

  window.BlindersPlan = {
    get: function () { return current; },
    isPro: isPro,
    refresh: refresh,
    activate: activate,
    restore: restore,
    promptRestore: promptRestore,
    PRICING: PRICING,
  };

  // Reflect cached plan immediately, then verify with the server.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onChange);
  } else {
    onChange();
  }
  refresh();
})();
