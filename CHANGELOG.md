# Changelog

All notable changes to **PRAgresso** are logged here.

Versioning follows SemVer: patch (third digit) = bug fix, minor (second) = new feature, major (first) = breaking change.

## 1.1.0 — 2026-04-20

### Added
- **Advania brand theme** as a fourth appearance option alongside Auto / Dark / Light. Uses the official Advania palette extracted from their branding kit — Indigo `#4f0077` for primary accents (timer bar, saving state), Pink `#cc0085` for the active toggle switch, Orange `#d54429` for errors, Dark Grey `#303030` as the indicator canvas, Light Grey `#edeef0` for foreground text. Applies the same page-wide invert filter as Dark mode so the Agresso page itself also darkens; only the indicator repaints in the brand palette. Options page also themes in the same colours when Advania is selected.

### Note for maintainers
- The Advania theme is an opinionated brand extension; future public-release packaging may need to strip or rename it if the extension is distributed beyond Advania staff. The `publish-release.sh` scrub still permits the theme through, because the palette itself (hex values) contains no proprietary information — only the theme label and the CSS class name `[data-theme="advania"]` reference the brand name.

## 1.0.1 — 2026-04-20

### Fixed
- **Summary (Σ) row values now align with their day columns when columns are hidden.** Agresso renders the totals row as `<tr class="SumItem">` with cell IDs suffixed by fieldname (e.g. `…_sumRow_ace_code`, `…_sumRow_work_type`). The 1.0.0 column-hide selector covered headers, static body cells, and edit-row cells, but not the summary-row cells — so on rows where Bereds. / Arb.typ are hidden everywhere else, the summary row still rendered empty placeholders for them and visually shifted the Mån–Sum totals to the left. Selector extended with `tr.SumItem td[id$="_sumRow_<fieldname>"]` so every row type of a hidden column is hidden consistently.

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
