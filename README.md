# PRAgresso — v1.7.1

A Chrome extension that polishes the [Unit4 ERP / Agresso](https://www.unit4.com/) daily time-registration workflow. Inline autosave, a full-page dark mode, period-end reminders, wider Beskrivningstext, project-name labels under Delproj codes, per-delprojekt and vacation-day summary panels, auto-click for the session-expired / logout dialogs, and a configurable options page.

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
- **Project-name label** under Delproj codes, preserved across sort / pagination and dashes inside customer names — including the row you are currently editing, where Agresso shows a bare code in a lookup editor and no name at all.
- **Period-end reminder** with a one-click *Submit time report* banner when today is the last day of the shown period and the report status is not `Klar`.
- **Auto-click** for "Stay signed in" / "Keep me signed in" / "Return to application" dialogs (individually toggleable).
- **Proactive session keep-alive** — periodically pings Agresso's `/api/session/current?renew=true` endpoint so the session stays warm during long idle stretches. Also dispatches a benign `pointermove` to keep Unit4's own heartbeat primed. Runs everywhere in Agresso, not just the timesheet.
- **Column hiding** for `Bereds.` / `Arb.typ` via `display: none` (configurable; hides both static and edit-mode cells).
- **Fakt. värde column total** — sums the billable-value column and renders the total into the otherwise-empty footer cell next to the existing hours `Sum` (24.00 in the screenshot world). Updates live as rows are added / edited.
- **Delproj summary panel** — extra section above `Arbetstimmar` that groups every Tidtransaktion row by Delproj code and shows hours summed per group, so per-delprojekt totals are visible at a glance. Each row counts as `max(Sum, Fakt. värde)` (Sum used when Fakt. värde is empty; Fakt. värde used when it's higher than Sum). Rows registered in days (Tidsenhet `Dagar` — absence, vacation) are converted to hours first, using `Normaltimmar ÷ day columns` as the working-day length, so they line up with Agresso's own footer total. Collapsible via a double-arrow chevron in the panel header.
- **Vacation-day summary panel** — on the Lönespecifikation page, a panel under the `Saldo för en resurs` table totalling your available vacation days: every `Sparade dagar år N` row plus `Årets betalda semesterdagar`, with `Obetalda semesterdagar` deliberately excluded. The headline figure totals the **Restbelopp** (remaining) column, with **Ursprungligt belopp** shown alongside for reference. Collapsible, and the state persists across reloads.
- **Optional Arbetstimmar default-collapse** — opt-in setting that auto-collapses the native `Arbetstimmar` (Från / Till / Återstående) section on first render, so the timesheet starts focused on Tidtransaktion. Triggers Agresso's own collapse handler once per page load; you can re-open the section manually any time.
- **Sticky Beskrivningstext + hours.** Picking a `Delproj` or `Aktivitet` makes Agresso re-render the row and overwrite the description with that entity's default text, so a row could only ever be filled in one order: codes first, text last. PRAgresso remembers what you typed and writes it back after each of those postbacks — write the description and punch the hours now, fill in the codes when you know them. Hours are only restored into cells Agresso blanked, never over a value it recalculated. Held fields get a blue left edge; clear a field to release the hold. A hold belongs to the row you typed it in and nowhere else: adding, deleting or re-sorting rows renumbers the grid, so PRAgresso releases every hold the moment that happens rather than writing your text into whichever row inherited the number.
- **Unknown lookup values are flagged red.** Agresso's `Tidkod` / `Delproj` / `Aktivitet` / `Bereds.` / `Arb.typ` editors accept anything you type: enter a code the row cannot use, tab out, and the field looks exactly like a valid one — the objection only arrives when the save fails. `Aktivitet` is the usual casualty, because it is scoped to the row's own `Delproj`, so a code that is right on one agreement is wrong on the next. PRAgresso marks such a field with a red ring as soon as you leave it, reading the answer Agresso already resolved into the editor's hidden `$RowDescription` sibling — no extra lookups, and no pre-baked list of valid codes, which could not exist anyway. The ring clears the moment you start correcting the value.
- **Options page** for all tunables, JSON export/import of settings, per-feature toggles.

## Options

Click the extension toolbar icon to open the options page. Settings persist in `chrome.storage.local` (survives cache clears), and are mirrored into every open Agresso tab via `chrome.storage.onChanged` — no reload needed.

| Section | Setting | Storage key |
| --- | --- | --- |
| Appearance | Theme (Auto / Dark / Light / Advania) | `theme` |
| Timing | Idle timeout / save cooldown / dialog sweep | `IDLE_TIMEOUT_MS`, `SAVE_COOLDOWN_MS`, `DIALOG_SWEEP_MS` |
| Reminder | Enabled, language, manual period-end override | `reminder_enabled`, `reminder_lang`, `period_override` |
| Auto-click | Stay signed in, Return to application | `auto_stay_signed_in`, `auto_return_to_app` |
| Session | Keep-alive enabled, interval (minutes) | `session_keepalive_enabled`, `session_keepalive_minutes` |
| Layout | Hide `Bereds.` / `Arb.typ`, Delproj label, Delproj summary panel, vacation-day summary panel, Arbetstimmar default-collapse | `hide_ace_code`, `hide_work_type`, `show_project_label`, `show_delproj_summary`, `show_semester_summary`, `arbetstimmar_collapsed_default` |
| Editing | Keep typed `Beskrivningstext` and hours across `Delproj` / `Aktivitet` changes | `sticky_edit_values` |
| Editing | Flag lookup values the row's own menu does not offer | `flag_unknown_lookup_values` |
| Diagnostics | Verbose console logging | `debug_logging` |

`SAVE_COOLDOWN_MS` is the minimum gap between two saves — a postback can re-trigger the idle timer immediately after a save, and the cooldown defers that second save rather than dropping it.

> **Removed in 1.5.1:** `SAVE_DEBOUNCE_MS`. It was never read by the content script (the idle timeout already serves as the save debounce) and is cleared from storage on next load.

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
- **No autosaves firing.** Open DevTools → Console and look for `[PRAgresso] Save button not found for …s` — the health check logs this if the save-button selectors have gone stale (usually after a Unit4 upgrade). This warning is always logged; for per-event tracing (timer restarts, dialog sweeps, activity) turn on **Diagnostics → Verbose console logging** first.
- **Delproj summary total disagrees with the grid footer.** The panel converts `Dagar`-unit rows to hours using `Normaltimmar ÷ number of day columns`. If `Normaltimmar` is blank or the grid renders an unusual number of day columns, it falls back to 8 h/day, which can differ from what your instance uses.
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
