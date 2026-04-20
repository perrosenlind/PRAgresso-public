# PRAgresso — v1.0.0

A Chrome extension that polishes the [Unit4 ERP / Agresso](https://www.unit4.com/) daily time-registration workflow. Inline autosave, a full-page dark mode, period-end reminders, wider Beskrivningstext, project-name labels under Delproj codes, auto-click for the session-expired / logout dialogs, and a configurable options page.

Released under the MIT License — see [`LICENSE`](LICENSE).

## Install

1. Clone / download this repo.
2. Open `chrome://extensions/` and enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the project folder.
4. Open your Agresso timesheet on `https://ubw.unit4cloud.com/`. The floating indicator appears bottom-right.

### Adding your own on-prem host

`manifest.json` ships with only the shared Unit4 Cloud host. If your organisation uses an on-prem Agresso install on a different URL, add that origin to `host_permissions` and `content_scripts[0].matches`, then reload the extension:

```json
"host_permissions": [
  "https://ubw.unit4cloud.com/*",
  "https://agresso.yourcompany.tld/*"
],
"content_scripts": [
  {
    "css": ["styles.css"],
    "js": ["cells.js"],
    "matches": [
      "https://ubw.unit4cloud.com/*",
      "https://agresso.yourcompany.tld/*"
    ],
    "all_frames": true
  }
]
```

## Features

- **Autosave.** Idle timer → Alt+S shortcut → dialog sweep. Only arms on the time-registration page (detected by the presence of the Delproj / reg-value / reg-unit column headers); every other Agresso surface shows the indicator disabled. Tooltip shows the projected next-save timestamp.
- **Alt+Shift+S** toggles autosave on/off from any page.
- **Full-page dark mode** via CSS `invert + hue-rotate`, with images / icons re-inverted so they look normal. Respects OS `prefers-color-scheme` when set to Auto.
- **Widened Beskrivningstext** (description) column — 500px floor, flexes to absorb remaining horizontal space so the grid always fills the viewport.
- **Project-name label** under Delproj codes, preserved across sort / pagination and dashes inside customer names.
- **Period-end reminder** with a one-click *Submit time report* banner when today is the last day of the shown period and the report status is not `Klar`.
- **Auto-click** for "Stay signed in" / "Keep me signed in" / "Return to application" dialogs (individually toggleable).
- **Proactive session keep-alive** — periodically pings Agresso's `/api/session/current?renew=true` endpoint so the session stays warm during long idle stretches. Also dispatches a benign `pointermove` to keep Unit4's own heartbeat primed. Runs everywhere in Agresso, not just the timesheet.
- **Column hiding** for `Bereds.` / `Arb.typ` via `display: none` (configurable; hides both static and edit-mode cells).
- **Options page** for all tunables, JSON export/import of settings, per-feature toggles.

## Options

Click the extension toolbar icon to open the options page. Settings persist in `chrome.storage.local` (survives cache clears), and are mirrored into every open Agresso tab via `chrome.storage.onChanged` — no reload needed.

| Section | Setting | Storage key |
| --- | --- | --- |
| Appearance | Theme (Auto / Dark / Light) | `theme` |
| Timing | Idle timeout / debounce / cooldown / dialog sweep | `IDLE_TIMEOUT_MS`, `SAVE_DEBOUNCE_MS`, `SAVE_COOLDOWN_MS`, `DIALOG_SWEEP_MS` |
| Reminder | Enabled, language, manual period-end override | `reminder_enabled`, `reminder_lang`, `period_override` |
| Auto-click | Stay signed in, Return to application | `auto_stay_signed_in`, `auto_return_to_app` |
| Session | Keep-alive enabled, interval (minutes) | `session_keepalive_enabled`, `session_keepalive_minutes` |
| Layout | Hide `Bereds.` / `Arb.typ`, Delproj label | `hide_ace_code`, `hide_work_type`, `show_project_label` |

## Files

- `manifest.json` — MV3 extension manifest.
- `cells.js` — main content script (autosave + layout + indicator + theming + keep-alive).
- `background.js` — service worker for keyboard commands and toolbar-icon clicks.
- `styles.css` — injected stylesheet (indicator, dark mode, column sizing, column hiding).
- `options.html` / `options.js` — settings page.
- `icons/` — 16/32/48 px toolbar icons.
- `CHANGELOG.md` — version history.
- `LICENSE` — MIT.

## Troubleshooting

- **Extension silent after install.** Confirm the host pattern in `manifest.json` matches the URL you're opening. Chrome blocks content scripts on unmatched hosts.
- **No autosaves firing.** Open DevTools → Console and look for `[PRAgresso] Save button not found for …s` — the health check logs this if the save-button selectors have gone stale (usually after a Unit4 upgrade).
- **Edit-row labels appear to overflow between columns.** Make sure the hidden-column options (Bereds. / Arb.typ) match what your Agresso instance actually renders; the overlap is usually caused by an otherwise-hidden column's editor re-appearing in edit mode.

## Development

Edit `cells.js` / `styles.css` then hit **Reload** on the extensions page.

A ready-to-run ESLint config (`.eslintrc.json`) is included:

```bash
npx eslint cells.js options.js background.js
```

### Contributing

Issues and pull requests welcome. Please keep commit messages descriptive and follow SemVer for version bumps:

- **Patch** (third digit) — bug fix.
- **Minor** (second digit) — new feature, non-breaking.
- **Major** (first digit) — breaking change (incompatible settings migration, manifest-level change forcing re-install).

Update `manifest.json`, `README.md`, and `CHANGELOG.md` in lockstep on every version bump.

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Per Rosenlind.
