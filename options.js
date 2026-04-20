// Options page — reads/writes chrome.storage.local. The content script reacts
// to storage changes live via chrome.storage.onChanged, so clicking Save does
// not require a page reload.

const DEFAULTS = {
  IDLE_TIMEOUT_MS: 15000,
  SAVE_DEBOUNCE_MS: 1800,
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
  theme: 'auto'
};

const NUMBER_KEYS = ['IDLE_TIMEOUT_MS', 'SAVE_DEBOUNCE_MS', 'SAVE_COOLDOWN_MS', 'DIALOG_SWEEP_MS', 'session_keepalive_minutes'];
const BOOL_KEYS = ['reminder_enabled', 'auto_stay_signed_in', 'auto_return_to_app', 'session_keepalive_enabled', 'hide_ace_code', 'hide_work_type', 'show_project_label'];
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

async function loadAll() {
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
