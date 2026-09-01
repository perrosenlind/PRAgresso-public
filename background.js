// Background service worker.
//
// Responsibilities:
//   1. Listen for the `toggle-autosave` keyboard command and broadcast it to
//      every content-script frame of the active tab.
//   2. Relay cross-frame messages for content scripts that cannot reach each
//      other directly (e.g. when the Agresso app is framed by an origin that
//      breaks window.top access).
//   3. Drive the session keep-alive ping off a chrome.alarms schedule.
//
// (3) used to live in the content script as a window.setInterval. It does not
// any more, and must not move back. Chrome applies intensive throttling to a
// backgrounded tab and freezes a non-audible one outright after ~5 minutes,
// which suspends page timers entirely — so the ping stopped firing exactly
// when it was needed (user away from the keyboard) and stopped *silently*.
// Observed in the wild: 30+ missed pings across 61 minutes with zero network
// requests and zero console output, ending in a server-side session timeout.
// chrome.alarms survives tab freezing, tab backgrounding and service-worker
// eviction, which is the entire reason for the move.
//
// Settings live in chrome.storage.local and are read at fire time — the worker
// holds no durable state of its own beyond the KEEPALIVE_STATE_KEY record,
// because it can be evicted between any two alarms.

const LOG_PREFIX = '[PRAgresso]';

function broadcast(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {
    // Best-effort: ignore frames that aren't listening.
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-autosave') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id != null) broadcast(tab.id, { type: 'toggle-autosave' });
    }
  });
});

// Clicking the toolbar icon opens the options page. The content script runs
// automatically on matched hosts via host_permissions, so the icon itself is
// purely a shortcut to configuration.
chrome.action.onClicked.addListener(() => {
  try { chrome.runtime.openOptionsPage(); } catch (e) { /* ignore */ }
});

// --- Session keep-alive ---

const KEEPALIVE_ALARM = 'pragresso-keepalive';
// 1 minute is the floor Chrome enforces for alarms; anything lower is silently
// clamped. We tick at the floor and decide per tick whether the user's
// configured interval has actually elapsed (see keepAliveTick). Ticking faster
// than the interval is what makes the schedule self-healing: a laptop that
// slept through four ticks pings on the first tick after wake rather than
// waiting out a fresh full period.
const KEEPALIVE_TICK_MINUTES = 1;
const AGRESSO_TAB_MATCH = 'https://ubw.unit4cloud.com/*';
const KEEPALIVE_STATE_KEY = 'keepalive_state';
const KEEPALIVE_HISTORY_MAX = 20;
const KEEPALIVE_TIMEOUT_MS = 15000;
// Surface a failing keep-alive in the toolbar rather than letting it rot
// quietly — silence being indistinguishable from success is what hid the
// original bug for an hour.
const KEEPALIVE_FAIL_BADGE_AT = 3;
// A renew endpoint answering with the login or logout page means the session
// is already gone; a 200 is not enough on its own.
const LOGIN_PAGE_MARKERS = [
  'logon.aspx',
  'login.aspx',
  '/logout/logout.aspx',
  'name="username"',
  'id="username"',
  'do you want to log out'
];

const KEEPALIVE_DEFAULTS = {
  session_keepalive_enabled: true,
  session_keepalive_minutes: 5
};

async function readKeepAliveState() {
  try {
    const got = await chrome.storage.local.get(KEEPALIVE_STATE_KEY);
    const st = got && got[KEEPALIVE_STATE_KEY];
    if (st && typeof st === 'object') return st;
  } catch (e) { /* ignore */ }
  return { lastPingAt: 0, lastResult: null, consecutiveFailures: 0, history: [] };
}

async function writeKeepAliveState(state) {
  try { await chrome.storage.local.set({ [KEEPALIVE_STATE_KEY]: state }); } catch (e) { /* ignore */ }
}

// Derive the renew URL from a live tab rather than hardcoding the app path, so
// this keeps working on any Unit4 Cloud deployment using the /<app>/api/...
// convention (se_adv_prod_web, se_adv_test_web, another tenant entirely).
function renewUrlForTab(tabUrl) {
  try {
    const u = new URL(tabUrl);
    const m = (u.pathname || '/').match(/^\/[^/]+\//);
    const base = m ? m[0] : '/';
    return `${u.origin}${base}api/session/current?renew=true&_=${Date.now()}`;
  } catch (e) {
    return null;
  }
}

// Assert on the outcome — never fire and forget. A non-2xx, a redirect toward
// the logout/login flow, or a body that smells like the login page all mean
// the ping did not renew anything.
async function pingOnce(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, KEEPALIVE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'manual',
      signal: ctl.signal
    });
    // `redirect: 'manual'` surfaces a 3xx as an opaque response: status 0, no
    // readable Location. That is all we need — the app only redirects a renew
    // call when the session is already dead.
    if (res.type === 'opaqueredirect') return { ok: false, status: 0, why: 'redirect' };
    if (!res.ok) return { ok: false, status: res.status, why: 'http' };
    const ct = res.headers.get('content-type') || '';
    if (/html/i.test(ct)) {
      let body = '';
      try { body = (await res.text()).slice(0, 4096).toLowerCase(); } catch (e) { body = ''; }
      if (LOGIN_PAGE_MARKERS.some((m) => body.includes(m))) {
        return { ok: false, status: res.status, why: 'login-page' };
      }
    }
    return { ok: true, status: res.status, why: 'ok' };
  } catch (err) {
    const why = (err && err.name === 'AbortError') ? 'timeout' : 'network';
    return { ok: false, status: 0, why, detail: err && err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function setFailBadge(consecutiveFailures, why) {
  try {
    if (consecutiveFailures >= KEEPALIVE_FAIL_BADGE_AT) {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#d9534f' });
      await chrome.action.setTitle({
        title: `PRAgresso — session keep-alive failing (${consecutiveFailures}× ${why}). Click for options.`
      });
    } else {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'PRAgresso — click for options' });
    }
  } catch (e) { /* ignore */ }
}

async function keepAliveTick(force) {
  const cfg = await chrome.storage.local.get(KEEPALIVE_DEFAULTS);
  // Deliberately NOT gated on `autosave_enabled`. Keep-alive is a session
  // feature, not a page-mutating one, and it has its own toggle. The old
  // content-script tick bailed whenever autosave was off, which silently
  // disabled session survival for anyone who runs with autosave disabled.
  if (cfg.session_keepalive_enabled === false && !force) return;

  const minutes = Math.max(1, Math.min(120, Number(cfg.session_keepalive_minutes) || 5));
  const state = await readKeepAliveState();

  if (!force) {
    // 15s of slack so a tick that lands a hair early still counts; without it
    // a 5-minute interval on a 1-minute tick would drift to 6.
    const due = (state.lastPingAt || 0) + (minutes * 60 * 1000) - 15000;
    if (Date.now() < due) return;
  }

  // No open Agresso tab, no ping — there is no session to keep warm.
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: AGRESSO_TAB_MATCH }); } catch (e) { tabs = []; }
  if (!tabs.length) return;

  const url = renewUrlForTab(tabs[0].url);
  if (!url) return;

  const result = await pingOnce(url);
  const ts = new Date().toISOString();
  const line = `keepalive ${result.ok ? 'ok' : 'fail'} ${result.status} ${ts}` +
    (result.ok ? '' : ` (${result.why}${result.detail ? ': ' + result.detail : ''})`);
  if (result.ok) console.info(LOG_PREFIX, line);
  else console.warn(LOG_PREFIX, line);

  state.lastPingAt = Date.now();
  state.lastResult = { ok: result.ok, status: result.status, why: result.why, ts };
  state.consecutiveFailures = result.ok ? 0 : (Number(state.consecutiveFailures) || 0) + 1;
  state.history = [state.lastResult, ...(Array.isArray(state.history) ? state.history : [])]
    .slice(0, KEEPALIVE_HISTORY_MAX);
  await writeKeepAliveState(state);
  await setFailBadge(state.consecutiveFailures, result.why);

  // Mirror the outcome into the page console of every Agresso tab. The worker's
  // own console lives behind chrome://extensions → service worker, which is not
  // where anyone debugging a timesheet is looking.
  for (const tab of tabs) {
    if (tab.id != null) {
      broadcast(tab.id, {
        type: 'keepalive-result',
        ok: result.ok,
        status: result.status,
        why: result.why,
        ts,
        consecutiveFailures: state.consecutiveFailures
      });
    }
  }
}

// Alarms are named, so create() is idempotent — but it also *resets* the
// schedule, and the worker re-runs this file on every wake. Check first, or a
// worker that respawns often would push the next fire out indefinitely.
async function ensureKeepAliveAlarm() {
  try {
    const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
    if (existing) return;
    await chrome.alarms.create(KEEPALIVE_ALARM, {
      periodInMinutes: KEEPALIVE_TICK_MINUTES,
      delayInMinutes: KEEPALIVE_TICK_MINUTES
    });
    console.info(LOG_PREFIX, 'keep-alive alarm created', { everyMinutes: KEEPALIVE_TICK_MINUTES });
  } catch (e) {
    console.warn(LOG_PREFIX, 'keep-alive alarm could not be created', e && e.message);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== KEEPALIVE_ALARM) return;
  keepAliveTick(false).catch((e) => {
    console.warn(LOG_PREFIX, 'keepalive tick threw', e && e.message);
  });
});

chrome.runtime.onStartup.addListener(() => { ensureKeepAliveAlarm(); });
chrome.runtime.onInstalled.addListener(() => { ensureKeepAliveAlarm(); });
ensureKeepAliveAlarm();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'relay-activity' && sender.tab && sender.tab.id != null) {
    broadcast(sender.tab.id, { type: 'activity-broadcast', from: sender.frameId ?? null });
    return;
  }
  // Options page: "Test now" — bypasses the interval gate but not the
  // open-tab requirement, and reports back so the page can show the outcome.
  if (msg.type === 'keepalive-ping-now') {
    keepAliveTick(true)
      .then(() => readKeepAliveState())
      .then((st) => sendResponse({ ok: true, state: st }))
      .catch((e) => sendResponse({ ok: false, error: e && e.message }));
    return true;
  }
});
