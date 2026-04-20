# Changelog

All notable changes to **PRAgresso** are logged here.

Versioning follows SemVer: patch (third digit) = bug fix, minor (second) = new feature, major (first) = breaking change.

## 1.0.0 — 2026-04-20

Initial public release.

### Core features

- **Inline autosave** — idle-timer + `Alt+S` shortcut + automatic dialog sweep. Gated on the time-registration page (detected by the Delproj / reg-value / reg-unit column headers), so every other Agresso surface shows the indicator disabled and the save button is never invoked out of context.
- **`Alt+Shift+S`** toggles autosave on/off from any Agresso page, via a background service worker + `chrome.commands` binding.
- **Proactive session keep-alive** — periodic (configurable, default every 5 min) `fetch` against `/api/session/current?renew=true` plus a synthetic `pointermove` so Unit4's own heartbeat stays warm and long idle stretches don't log the user out.
- **Auto-click** for "Stay signed in" / "Keep me signed in" / "Return to application" dialogs. Both toggles are independently configurable from the options page.
- **Period-end reminder** — highlights the indicator red and shows a one-click *Submit time report* banner when today is the last day of the period and the status isn't `Klar`. Supports manual period-end override for edge cases where Agresso's own period detection is off.
- **Full-page dark mode** — CSS `invert + hue-rotate` on the page root, with images / icons / the floating indicator re-inverted so they render at normal colours. Respects OS `prefers-color-scheme` when theme = `auto`; can be forced via options.
- **Widened Beskrivningstext** — description column floors at 500px and flexes to absorb remaining horizontal space, so the grid always fills the viewport and long descriptions don't truncate to "Konsulta…".
- **Project-name label** under Delproj codes, preserved across sort / pagination / in-row edits. Handles multi-dash customer names correctly by stripping only the trailing Agresso code suffix.
- **Column hiding** — optional `display: none` for `Bereds.` / `Arb.typ`. Applies to both static cells and edit-mode editor widgets, so hidden columns don't reappear as stray pickers when the user clicks into edit mode.
- **Options page** — all tunables exposed, JSON export / import for settings portability, live update via `chrome.storage.onChanged` (no reload needed).
- **Settings stored in `chrome.storage.local`** — survives cache clears, shared across all frames and tabs, auto-migrates legacy `agresso_*` `localStorage` keys from older builds.

### Compatibility

- Manifest v3 Chrome extension.
- Host permission: `https://ubw.unit4cloud.com/*` by default. On-prem Agresso URLs can be added by editing `manifest.json` (see README).
- CSS `:has()` used in column-hide rules — Chrome 105+ required.

### License

MIT — Copyright © 2026 Per Rosenlind.
