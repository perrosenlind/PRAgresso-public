// Options page — reads/writes chrome.storage.local. The content script reacts
// to storage changes live via chrome.storage.onChanged, so clicking Save does
// not require a page reload.

const DEFAULTS = {
  IDLE_TIMEOUT_MS: 15000,
  SAVE_COOLDOWN_MS: 4500,
  DIALOG_SWEEP_MS: 8000,
  autosave_enabled: true,
  reminder_enabled: true,
  reminder_lang: 'sv',
  period_override: '',
  auto_stay_signed_in: true,
  auto_return_to_app: true,
  session_keepalive_enabled: true,
  session_keepalive_minutes: 5,
  hide_ace_code: true,
  hide_work_type: true,
  show_project_label: true,
  show_delproj_summary: true,
  show_semester_summary: true,
  arbetstimmar_collapsed_default: false,
  sticky_edit_values: true,
  flag_unknown_lookup_values: true,
  theme: 'auto',
  debug_logging: false
};

const NUMBER_KEYS = ['IDLE_TIMEOUT_MS', 'SAVE_COOLDOWN_MS', 'DIALOG_SWEEP_MS', 'session_keepalive_minutes'];
const BOOL_KEYS = ['reminder_enabled', 'auto_stay_signed_in', 'auto_return_to_app', 'session_keepalive_enabled', 'hide_ace_code', 'hide_work_type', 'show_project_label', 'show_delproj_summary', 'show_semester_summary', 'arbetstimmar_collapsed_default', 'sticky_edit_values', 'flag_unknown_lookup_values', 'debug_logging'];
const STRING_KEYS = ['reminder_lang', 'period_override', 'theme'];

function applyTheme(value) {
  const root = document.documentElement;
  if (value === 'auto' || !value) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', value);
}

const $ = (id) => document.getElementById(id);
const status = $('status');

function flash(msg, kind) {
  status.textContent = msg;
  status.style.color = kind === 'error' ? 'var(--danger)' : 'var(--muted)';
  if (kind !== 'error') {
    setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 2500);
  }
}

// Keys that used to exist and no longer do. SAVE_DEBOUNCE_MS was never read by
// the content script — the idle timeout already serves as the save debounce —
// so it is dropped rather than left sitting in storage confusing exports.
const OBSOLETE_KEYS = ['SAVE_DEBOUNCE_MS'];

async function loadAll() {
  try { await chrome.storage.local.remove(OBSOLETE_KEYS); } catch (err) { /* ignore */ }
  const stored = await chrome.storage.local.get(DEFAULTS);
  for (const k of NUMBER_KEYS) $(k).value = stored[k] ?? DEFAULTS[k];
  for (const k of BOOL_KEYS) $(k).checked = !!stored[k];
  for (const k of STRING_KEYS) $(k).value = stored[k] ?? DEFAULTS[k];
  applyTheme(stored.theme);
  renderJson(stored);
}

function collect() {
  const out = {};
  for (const k of NUMBER_KEYS) {
    const n = Number($(k).value);
    out[k] = Number.isFinite(n) && n > 0 ? n : DEFAULTS[k];
  }
  for (const k of BOOL_KEYS) out[k] = !!$(k).checked;
  for (const k of STRING_KEYS) out[k] = $(k).value || '';
  return out;
}

function renderJson(obj) {
  $('settings_json').value = JSON.stringify(obj, null, 2);
}

async function save() {
  const values = collect();
  await chrome.storage.local.set(values);
  applyTheme(values.theme);
  renderJson(values);
  flash('Saved ✓');
}

async function resetDefaults() {
  await chrome.storage.local.set(DEFAULTS);
  await loadAll();
  flash('Reset to defaults');
}

function importJson() {
  try {
    const parsed = JSON.parse($('settings_json').value);
    const sanitized = { ...DEFAULTS };
    for (const k of Object.keys(parsed)) {
      if (k in DEFAULTS) sanitized[k] = parsed[k];
    }
    chrome.storage.local.set(sanitized).then(async () => {
      await loadAll();
      flash('Imported ✓');
    });
  } catch (err) {
    flash('Invalid JSON: ' + err.message, 'error');
  }
}

// --- Session keep-alive status -------------------------------------------
// The worker writes every ping outcome to chrome.storage.local under
// `keepalive_state`. Surfacing it here is the point: the original failure was
// invisible for an hour precisely because a dead keep-alive and a healthy one
// looked identical from the outside.
const KEEPALIVE_STATE_KEY = 'keepalive_state';

function describeKeepAlive(state) {
  if (!state || !state.lastResult) return { text: 'no ping recorded yet', bad: false };
  const r = state.lastResult;
  const when = new Date(r.ts);
  const mins = Math.round((Date.now() - when.getTime()) / 60000);
  const ago = Number.isFinite(mins) ? (mins < 1 ? 'just now' : `${mins} min ago`) : '';
  if (r.ok) return { text: `ok (HTTP ${r.status}) — ${ago}`, bad: false };
  const fails = Number(state.consecutiveFailures) || 1;
  return { text: `FAILED: ${r.why}${r.status ? ` (HTTP ${r.status})` : ''} — ${ago}, ${fails} in a row`, bad: true };
}

async function renderKeepAlive() {
  const el = $('keepalive_status');
  if (!el) return;
  let state = null;
  try {
    const got = await chrome.storage.local.get(KEEPALIVE_STATE_KEY);
    state = got && got[KEEPALIVE_STATE_KEY];
  } catch (err) { /* ignore */ }
  const { text, bad } = describeKeepAlive(state);
  el.textContent = text;
  el.style.color = bad ? 'var(--danger)' : 'var(--muted)';
}

async function testKeepAlive() {
  const btn = $('btn_keepalive_test');
  if (btn) btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'keepalive-ping-now' });
    if (res && res.ok) {
      await renderKeepAlive();
      const r = res.state && res.state.lastResult;
      // No open Agresso tab means the worker skipped the ping entirely rather
      // than failing it — say so instead of showing a stale result as fresh.
      if (!r || Date.now() - new Date(r.ts).getTime() > 15000) {
        flash('No ping sent — is an Agresso tab open?', 'error');
      } else {
        flash(r.ok ? 'Ping ok ✓' : `Ping failed: ${r.why}`, r.ok ? null : 'error');
      }
    } else {
      flash('Ping failed: ' + ((res && res.error) || 'no response from the service worker'), 'error');
    }
  } catch (err) {
    flash('Ping failed: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText($('settings_json').value);
    flash('Copied to clipboard ✓');
  } catch (err) {
    flash('Clipboard blocked: ' + err.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  renderKeepAlive();
  $('btn_keepalive_test').addEventListener('click', testKeepAlive);
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && KEEPALIVE_STATE_KEY in changes) renderKeepAlive();
    });
  } catch (err) { /* ignore */ }
  $('btn_save').addEventListener('click', save);
  $('btn_reset').addEventListener('click', resetDefaults);
  $('btn_export').addEventListener('click', copyJson);
  $('btn_import').addEventListener('click', importJson);
  // Theme picker persists immediately on change so open Agresso tabs flip
  // at the same time as the options page, without waiting for Save.
  $('theme').addEventListener('change', async (ev) => {
    const v = ev.target.value;
    applyTheme(v);
    try {
      await chrome.storage.local.set({ theme: v });
      flash('Theme saved ✓');
    } catch (err) {
      flash('Could not save theme: ' + err.message, 'error');
    }
  });
});
