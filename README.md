# PRAgresso — v1.10.1

A Chrome extension that polishes the [Unit4 ERP / Agresso](https://www.unit4.com/) daily time-registration workflow. Inline autosave, a full-page dark mode, period-end reminders, wider Beskrivningstext, project-name labels under Delproj codes, per-delprojekt and vacation-day summary panels, auto-click for the session-expired / logout dialogs, and a configurable options page. Opt-in extras: marking rows whose billed hours were adjusted, a Delproj library with history import, a widescreen layout, and an MCP bridge that lets a local AI agent read, fill in and save the time report.

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
- **Proactive session keep-alive** — periodically pings Agresso's `/api/session/current?renew=true` endpoint so the session stays warm during long idle stretches. Scheduled from the background service worker via `chrome.alarms`, **not** a page timer: Chrome freezes a backgrounded tab after a few minutes, which would suspend the very pings you need while away from the keyboard. Every ping asserts on its response and logs `keepalive ok|fail <status> <timestamp>`; three failures in a row raise a red `!` on the toolbar icon. Runs everywhere in Agresso, not just the timesheet, and independently of the autosave toggle.
- **Idle-logout recovery** — if a timeout drops you on `Logout.aspx`, the extension clicks *Return to the application* for you. It stands down when *you* clicked log out, and gives up after two attempts in ten minutes so a dead session cannot loop.
- **Column hiding** for `Bereds.` / `Arb.typ` via `display: none` (configurable; hides both static and edit-mode cells).
- **Fakt. värde column total** — sums the billable-value column and renders the total into the otherwise-empty footer cell next to the existing hours `Sum` (24.00 in the screenshot world). Updates live as rows are added / edited.
- **Delproj summary panel** — extra section above `Arbetstimmar` that groups every Tidtransaktion row by Delproj code and shows hours summed per group, so per-delprojekt totals are visible at a glance. Each row counts as `max(Sum, Fakt. värde)` (Sum used when Fakt. värde is empty; Fakt. värde used when it's higher than Sum). Rows registered in days (Tidsenhet `Dagar` — absence, vacation) are converted to hours first, using `Normaltimmar ÷ day columns` as the working-day length, so they line up with Agresso's own footer total. Collapsible via a double-arrow chevron in the panel header.
- **Vacation-day summary panel** — on the Lönespecifikation page, a panel under the `Saldo för en resurs` table totalling your available vacation days: every `Sparade dagar år N` row plus `Årets betalda semesterdagar`, with `Obetalda semesterdagar` deliberately excluded. The headline figure totals the **Restbelopp** (remaining) column, with **Ursprungligt belopp** shown alongside for reference. Collapsible, and the state persists across reloads.
- **Full days marked green.** Once a day's `Återstående timmar` reaches 0, that day's cell in the Tidtransaktion `∑` row turns dark green with white text, in light and dark mode alike; hover any day for `Återstår X.XX h`. Days with no scheduled hours (weekends, holidays) are never marked. It tracks the `∑` row as you edit, whether or not Agresso recalculates `Återstående` before you save: each day's target is snapshotted as `Återstående + ∑` and the hours left are measured against it. Read-only — it never presses *Uppdatera*.
- **Adjusted rows tinted (opt-in).** A Tidtransaktion row whose `Fakt. värde` differs from its `Sum` (2.00 h reported, 4.00 h billed) gets a soft tint in the theme colour (blue, or pink under Advania) and a bold `Fakt. värde`; hover the row for `Justerad: rapporterat … h, fakturerat … h (+…)`. Rows with `Fakt. värde` 0 (non-billable) and rows registered in days are left alone. Updates live as you edit.
- **Delproj library (opt-in).** Remembers every Delproj code that appears on a saved row, with its name, the last week it was used and how many weeks it was used in. You can also add your own codes ahead of time. A collapsible *Delproj bibliotek* panel on the time-registration page lets you search the library, click a code to type it into the row you are editing, start a **new row** with a code (＋ Ny rad), remove entries, and **import the codes from the last N weeks or months**. The import reads earlier weeks in a hidden copy of the timesheet, never saves anything, can be stopped, and resumes on its own if the timesheet reloads mid-run.
- **Widescreen layouts A and B (opt-in).** A compact header bar with the period's key figures, **‹ / ›** week navigation, a date picker and the report status, Agresso's *Tidrapport för* and *Arbetstimmar* tucked behind **Period & arbetstimmar ▾**, and the Delproj library beside Tidtransaktion where it stays in view while you scroll. **A** puts the library and the summary in a column on the right. **B** makes the library a narrow rail on the left with *Senaste / Egna / Mest använda* filters, and shows the summary as chips above the grid. In both, Tidtransaktion gets the panels' look. Choosing *Klar* as status asks you to confirm with **Spara som Klar**, which saves and thereby submits the report. The column's top lines up with the Tidtransaktion box and it keeps its own height, so it stays still while the grid re-renders. Collapsing everything in it folds it to a thin strip at the page's edge.
- **AI agents over MCP (opt-in).** Let a local AI agent read the open time report, fill in rows, use the Delproj library and save the report — never submit it. See [AI agents (MCP)](#ai-agents-mcp).
- **Delproj codes stay on one line**, with the column widened just enough to fit the widest code.
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
| Layout | Hide `Bereds.` / `Arb.typ`, Delproj label, Delproj summary panel, vacation-day summary panel, Arbetstimmar default-collapse, full-day marker | `hide_ace_code`, `hide_work_type`, `show_project_label`, `show_delproj_summary`, `show_semester_summary`, `arbetstimmar_collapsed_default`, `mark_full_days` |
| Layout | Mark rows where `Fakt. värde` ≠ `Sum` | `mark_adjusted_rows` |
| Delproj library | Enable. Entries are managed on the options page or in the panel | `delproj_library_enabled` (entries in `delproj_library`, panel state in `pragresso_library_collapsed`, import choice in `pragresso_library_import_pref`) |
| Widescreen layout | Off / A (right column) / B (left rail) | `wide_layout` (page-side copies in `localStorage`: `pragresso_wide_layout`, `pragresso_wide_folded`, `pragresso_wide_details`) |
| AI agents (MCP) | Allow a local agent to read, fill in and save the time report | `mcp_enabled` (bridge status in `mcp_state`) |
| Editing | Keep typed `Beskrivningstext` and hours across `Delproj` / `Aktivitet` changes | `sticky_edit_values` |
| Editing | Flag lookup values the row's own menu does not offer | `flag_unknown_lookup_values` |
| Diagnostics | Verbose console logging | `debug_logging` |

`SAVE_COOLDOWN_MS` is the minimum gap between two saves — a postback can re-trigger the idle timer immediately after a save, and the cooldown defers that second save rather than dropping it.

> **Removed in 1.5.1:** `SAVE_DEBOUNCE_MS`. It was never read by the content script (the idle timeout already serves as the save debounce) and is cleared from storage on next load.

## AI agents (MCP)

PRAgresso can expose the open time report to a local AI agent as an MCP server. The agent works in **your** Agresso tab, so every change is visible as it happens.

| Tool | Does |
| --- | --- |
| `get_timesheet` | Period, status, hours registered / remaining per day, every row (Delproj, Aktivitet, description, hours per day, Sum, Fakt. värde, adjusted). |
| `list_library` | Delproj codes from the library, optionally filtered. |
| `add_library_code` | Adds a code (and name) to the library as your own entry. |
| `add_row` | Adds a row and fills Delproj, Aktivitet, description and hours per day, with exact codes checked by Agresso. Does not save. |
| `update_row` | Changes an existing row's codes, description or hours. Does not save. |
| `save_timesheet` | Saves the report, the same as *Spara*. **Never submits it.** |

### Setup (once per computer)

Needs Node.js 18 or newer and the extension loaded from a folder on disk. **Run every command from the PRAgresso folder**, the one holding `manifest.json`. Run from anywhere else, `node` cannot find the script, and `claude mcp add` registers a path that does not exist.

1. **Turn it on.** Open the PRAgresso options and tick **AI agents (MCP)**, then **Save**. The section shows the extension id and the commands below, filled in with your id.
2. **Register the local bridge with Chrome:**
   ```sh
   cd /path/to/PRAgresso
   node mcp/pragresso-mcp.js install --extension-id <id from the options page>
   ```
   This writes `se.pragresso.mcp.json` into Chrome's and Edge's `NativeMessagingHosts` folders (on Windows, plus a `HKCU` registry key) and a launcher in `~/.pragresso/`. Only the extension with that id may start it.
3. **Add the MCP server to your agent:**
   - Claude Code (all projects):
     ```sh
     claude mcp add -s user pragresso -- "$(command -v node)" "$PWD/mcp/pragresso-mcp.js"
     ```
   - Claude Desktop or any other MCP client: add a stdio server to its config:
     ```json
     { "mcpServers": { "pragresso": { "command": "/absolute/path/to/node", "args": ["/absolute/path/to/PRAgresso/mcp/pragresso-mcp.js"] } } }
     ```
4. **Reload, in this order:** reload the extension in `chrome://extensions` (⟳), then reload the Agresso tab and open *Daglig tidregistrering*. A tab that was open when the extension was reloaded has lost its connection to the extension until it is reloaded.
5. **Check.** In the options, **Bridge** should show a green **● connected**. If not, click **Reconnect**. `claude mcp list` should list `pragresso ✔ Connected`. Restart the agent session if it was already running.

### Using it

Keep Agresso open on **Daglig tidregistrering** with the week you want to work on. If several Agresso tabs are open, the agent uses the one you are looking at. Then ask your agent in plain words, for example:

- *"What have I reported this week, and how many hours are left per day?"*
- *"Add 2 hours on Wednesday on Kund AB 123456-7, activity SPE, description 'FortiToken rollout'."*
- *"Move Tuesday's 2 hours on row 3 to Thursday."*
- *"Which Delproj codes have I used for Kund AB?"*
- *"Save the time report."*

What to expect:

- **You see every change live** in the tab: the agent fills the row in the same way you would type it.
- **Codes are exact.** Agresso's own lookup picks the *first* match (typing `SPE` once gave `AZS`), so PRAgresso forces the exact code and has Agresso confirm it. A code the row cannot use comes back to the agent under `problems`, and the row is left for the agent or you to fix.
- **Nothing is saved unless asked.** `add_row` and `update_row` never save, and autosave waits while the agent is filling a row, so a half-built row is never saved. `save_timesheet` saves even when autosave is paused, because the agent was asked to save.
- **The report can never be submitted** through MCP. There is no such tool, and the extension refuses any tool not on its own list.
- Each new row takes a few seconds, because every changed day is a round-trip to Agresso.

### Troubleshooting MCP

| Where | Message | Fix |
| --- | --- | --- |
| Options → Bridge | `local bridge not installed` | Run step 2, from the PRAgresso folder. |
| Options → Bridge | `Access to native messaging requires nativeMessaging permission` | Reload the extension. The permission is only picked up on a reload. |
| Agent | `PRAgresso is not connected: open Chrome…` | Chrome is closed, or **AI agents (MCP)** is off. Turn it on and check that Bridge says connected. |
| Agent | `PRAgresso is not active in the Agresso tab — reload the tab` | The extension was reloaded after the tab opened. Reload the tab. |
| Agent | `…not showing the time registration page` | Open *Daglig tidregistrering* in the Agresso tab. |
| Agent | `No Agresso tab is open in Chrome` | Open Agresso. |
| `node …` | `Cannot find module …/mcp/pragresso-mcp.js` | Run it from the PRAgresso folder. |

**Run step 2 again** when you move the PRAgresso folder, when the extension id changes (an unpacked extension's id follows its folder), or when the Node binary it pinned goes away. The installer pins Homebrew's stable `/opt/homebrew/bin/node`, so `brew upgrade` is fine. Re-run step 3 too if the folder moved.

**Uninstall:** untick **AI agents (MCP)**, run `claude mcp remove pragresso -s user`, and delete `~/.pragresso/` and `se.pragresso.mcp.json` from `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (and the Edge equivalent). On Linux it is `~/.config/google-chrome/NativeMessagingHosts/`. On Windows, also delete the `HKCU\Software\Google\Chrome\NativeMessagingHosts\se.pragresso.mcp` key.

### How it fits together

```
agent ⇄ stdio ⇄ pragresso-mcp.js (MCP server)
                     ⇅  ~/.pragresso/mcp.sock (mode 600, this user only)
               pragresso-mcp.js native (started by Chrome)
                     ⇅  Native Messaging
               background.js ⇄ cells.js in the Agresso tab
```

The agent starts the script as an MCP server. Chrome starts the same script as a Native Messaging host while the option is on. Nothing listens on the network. The bridge only relays: which tools exist and what they may do is decided by the extension, which re-checks the option on every call.

## Files

- `manifest.json` — MV3 extension manifest.
- `early.js` — tiny `document_start` script that marks the page with the chosen widescreen layout, so the column is reserved before Agresso paints.
- `cells.js` — main content script: autosave, layout, indicator, theming, logout recovery, the Delproj panels and library import, the widescreen layout, and the MCP tools.
- `background.js` — service worker: keyboard commands, toolbar-icon clicks, the `chrome.alarms`-driven session keep-alive, and the MCP bridge's Native Messaging port.
- `mcp/pragresso-mcp.js` — MCP stdio server, Chrome Native Messaging host and installer for the AI-agent bridge (zero dependencies).
- `styles.css` — injected stylesheet: indicator, dark mode, column sizing, column hiding and the Delproj panels. The full-day, adjusted-row, Delproj-column and widescreen rules are injected by `cells.js` instead, so they land after Agresso's own sheets.
- `options.html` / `options.js` — settings page, including the Delproj library editor and the MCP bridge status.
- `icons/` — 16/32/48 px toolbar icons.
- `CHANGELOG.md` — version history.
- `LICENSE` — MIT.

## Troubleshooting

- **Extension silent after install.** Confirm the host pattern in `manifest.json` matches the URL you're opening. Chrome blocks content scripts on unmatched hosts.
- **No autosaves firing.** Open DevTools → Console and look for `[PRAgresso] Save button not found for …s` — the health check logs this if the save-button selectors have gone stale (usually after a Unit4 upgrade). This warning is always logged; for per-event tracing (timer restarts, dialog sweeps, activity) turn on **Diagnostics → Verbose console logging** first.
- **Delproj summary total disagrees with the grid footer.** The panel converts `Dagar`-unit rows to hours using `Normaltimmar ÷ number of day columns`. If `Normaltimmar` is blank or the grid renders an unusual number of day columns, it falls back to 8 h/day, which can differ from what your instance uses.
- **Library import stops with a message.** It names the week it stopped at and why. `Agresso bytte inte period` means the week did not load. Run it again, since it picks up the codes already read. `blev aldrig klar` means the grid did not finish rendering within 15 s, usually because Agresso is slow at that moment. Codes are saved week by week, so nothing read before the stop is lost.
- **Widescreen layout shows no column.** The column only appears when the Delproj library and/or the Delproj summary is turned on, and only on *Daglig tidregistrering*.
- **AI agent problems.** See [Troubleshooting MCP](#troubleshooting-mcp).
- **Edit-row labels appear to overflow between columns.** Make sure the hidden-column options (Bereds. / Arb.typ) match what your Agresso instance actually renders; the overlap is usually caused by an otherwise-hidden column's editor re-appearing in edit mode.

## Development

Edit `cells.js` / `styles.css` then hit **Reload** on the extensions page.

A ready-to-run ESLint config (`.eslintrc.json`) is included:

```bash
npx eslint@8 early.js cells.js options.js background.js mcp/pragresso-mcp.js
```

ESLint 9 no longer reads `.eslintrc.*`, so pin v8 until the config is migrated.

### Contributing

Issues and pull requests welcome. Please keep commit messages descriptive and follow SemVer for version bumps:

- **Patch** (third digit) — bug fix.
- **Minor** (second digit) — new feature, non-breaking.
- **Major** (first digit) — breaking change (incompatible settings migration, manifest-level change forcing re-install).

Update `manifest.json`, `README.md`, `CHANGELOG.md` and `VERSION` in `mcp/pragresso-mcp.js` in lockstep on every version bump.

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Per Rosenlind.
