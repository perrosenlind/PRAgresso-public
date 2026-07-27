# Changelog

All notable changes to **PRAgresso** are logged here.

Versioning follows SemVer: patch (third digit) = bug fix, minor (second) = new feature, major (first) = breaking change.

## 1.5.1 — 2026-07-27

Maintenance release from a full code review. ESLint reported 15 `no-undef` errors across `cells.js`; four of them were live functional bugs, invisible because every call site sat inside a bare `catch`. A lint gate now blocks the release pipeline so this class cannot ship again.

### Fixed
- **Every option under "Autosave timing" did nothing.** `IDLE_TIMEOUT_MS`, `SAVE_COOLDOWN_MS` and `DIALOG_SWEEP_MS` are held in module-level `let`s for cheap access on the timer hot path, initialised once from `SETTING_DEFAULTS` — and never assigned again. `loadSettings` populated the `settings` object; `onSettingsChanged` updated `settings[key]`; neither wrote back to the `let`s. So the idle timeout was pinned at 15 s and the dialog sweep at 8 s no matter what the options page said. A new `syncTimingVars()` mirrors (and range-clamps) the three values after every settings load and change, and a shortened idle timeout now re-arms the running countdown immediately instead of taking effect one cycle later.
- **The advertised "Submit time report" banner still never appeared.** 1.4.11 diagnosed this as `explanation` being scoped inside a closed try-block and fixed that constant — but `createSubmitBanner` itself is *also* declared inside that block, while all four call sites sit after it closes. Every call threw `ReferenceError` into a swallowing catch. `createSubmitBanner`, `removeSubmitBanner` and `compareTimerModes` are now bound at `notifyNow` scope. `compareTimerModes` was additionally exported from the top-level init block, where it is always `undefined`; it is exposed from inside `notifyNow` instead.
- **Delproj summary under-reported day-registered rows by the length of a working day.** Absence and vacation rows use Tidsenhet `Dagar` and carry `1.00` per day; Agresso's own footer converts them to hours before totalling, the panel did not. A week of vacation showed `5.00` under a `TIMMAR` heading next to Agresso's `40.00`. The panel now reads the `reg_unit` column (and its edit-mode input) and scales day-unit rows by the working-day length, derived from `Normaltimmar ÷ day-column count` so part-time schedules convert correctly rather than assuming 8.
- **Day-column detection depended on the grid being Swedish or English.** Day columns and the aggregate Sum column both carry `data-fieldname^="reg_value"`, and the Sum column was excluded by matching its *header text* against `sum|summa|Σ`. On any other localisation that test fails, the Sum column counts as an extra day and every row's hours double — a regression this code has already suffered once. Detection is now structural: day columns are exactly `reg_value1..N`, the aggregate is the digit-less `reg_value`. The anchored-regex-against-concatenated-text trap fixed in `recomputeDelprojSummary` was still present in `applyFaktVardeSum`; fixed there too (cosmetic only — it cost the Fakt. värde total its column alignment).
- **The whole same-origin-frame branch of period-end detection was unreachable.** `dateTokenRe` was a `const` inside the Sum-left scan's try-block, with ten references from the in-frame fallback outside it. The first reference gates the `dateNodes` filter, so it always came back empty and the entire scan short-circuited. Hoisted to `findPeriodEndDate` scope, alongside `isRedColor` which was hoisted for the same reason in 1.4.11. A "table chosen for Sum-left scan" log that sat above `let tbl2` (a TDZ error, and structurally incapable of reporting anything but `null`) now runs after `tbl2` is selected.
- **Vacation-day panel only recognised Swedish row labels.** The Saldo table is located by locale-independent column headers, but the rows inside it were matched against Swedish text only, leaving the panel silently empty on an English-localised install. English variants added for the row labels and the three column headers.

### Changed
- **Activity tracking no longer thrashes layout.** `markActivity` was bound to 13 event types including `mousemove`, `scroll` and `wheel` with no throttle, and each call ran through to `resetTimerBar`, which performs two forced synchronous layouts and restarts a CSS transition. Listeners were also attached to both the document *and* its window, both in the capture phase, so every event ran the chain twice. One ten-minute session logged over 5,600 timer restarts, roughly 900 of them inside a single second after a save postback. Activity events now pass through a 250 ms leading-edge throttle (invisible against a timeout measured in seconds) and bind to the document only.
- **`SAVE_COOLDOWN_MS` now does something.** It was exposed in the options page and documented, but never read anywhere. It now enforces a minimum gap between two saves, deferring rather than dropping the second — a postback re-render could otherwise re-trigger the idle timer immediately after a save.
- **`SAVE_DEBOUNCE_MS` removed.** Also never read, and redundant with the idle timeout, which already serves as the save debounce. Dropped from the options page and cleared from storage on next load rather than left to confuse settings exports.
- **Hot-path tracing is opt-in.** Per-event `console.debug` output is gated behind a new **Diagnostics → Verbose console logging** setting (off by default). The low-volume `console.info` / `console.warn` lifecycle and health messages the troubleshooting docs point at are unchanged.

### Security
- **Cross-frame activity messages are now origin-checked.** The content script runs with `all_frames: true` and the top-frame `message` handler validated only `ev.data.type`, so any third-party iframe embedded in the Agresso page could hold the autosave countdown open indefinitely or drive the red period-end UI via `agresso_period_enforce`. The handler now requires `ev.origin === location.origin`, and the sender posts to that origin instead of `'*'`.

### Internal
- `scripts/publish-release.sh` gains an ESLint gate (`--max-warnings=0`) between the syntax check and the release commit. `node --check` only parses and cannot see a constant referenced from outside its block — which is precisely how the submit-banner bug shipped twice.
- Removed dead bindings flagged by the lint sweep: `lastActivityAt`, `isSameDay`, `PERIOD_NOTIFY_KEY`, and two unused locals.
- README refreshed — it still described v1.4.8 and omitted the vacation-day panel shipped in 1.5.0.

## 1.5.0 — 2026-06-15

### Added
- **Vacation-day summary panel on the Lönespecifikation page.** A new panel is injected directly under the `Saldo för en resurs` table that totals your available vacation days — every `Sparade dagar år N` row plus `Årets betalda semesterdagar` — and shows the grand total in its header (`N dagar`). `Obetalda semesterdagar` (unpaid) is deliberately excluded. The headline figure totals the **Restbelopp** (remaining) column — how many days are still available — with each row's **Ursprungligt belopp** (original) shown alongside for reference and a `Totalt` footer row mirroring both columns. The Saldo table is located by its stable `Ursprungligt belopp` + `Restbelopp` column headers (not the locale-dependent section title), so the panel only appears where that table exists and tears itself down elsewhere. The panel is collapsible (state persisted across reloads like the Delproj summary), re-seats itself after postbacks, and follows the Advania theme tint. Toggle it under **Layout → Show vacation-day summary panel** (on by default).

## 1.4.11 — 2026-06-10

### Fixed
- **"Tidrapport påminnelse — Idag är sista dagen" fired on the Utlägg page (and every other non-timesheet page).** `checkPeriodAndNotify` ran ungated on init and on every DOM mutation in the top frame, and both `findPeriodEndDate` and `isReportStatusKlar` scan `getAllDocuments()` — which includes the *hidden* iframes Unit4 keeps alive for inactive app tabs. So from the Utlägg page the extension read a period end and an `Utkast` status out of the invisible background timesheet and painted the red reminder into the top document. Autosave always had a visibility gate (`detectTimesheetPage`, which requires a *visible* grid header) — the reminder never got one. That same gate now fronts `checkPeriodAndNotify`, and a new `clearPeriodEndUi()` tears down the red indicator state, the forcing stylesheet, the banner and the 1 s enforcer interval when you leave the timesheet (deliberately without touching `period_notify_date` — navigating away isn't acknowledging the reminder; it also runs when the detected deadline lies in the future, so stale red state clears when you move from an overdue week back to the current one).
- **The reminder claimed "sista dagen" on a Wednesday when the period ran Mon 08/06 – Sun 14/06.** The alarm condition is `detected end ≤ today` (so a misdetected *past* date alarms every day all week), and two detection paths could return the period's **first** day: the in-frame fallback returned the first date header in DOM order (`Mån 08/06`), and a final fallback returned the "Datum i perioden" input value (`08/06/2026`) verbatim as the period end. New primary detection path: read the day-column headers of the *visible* grid (`th[data-fieldname^="reg_value"]`, the same anchor `detectTimesheetPage` uses), parse every `dd/mm` token — attribute text / innerHTML first, because `textContent` collapses `Mån<br>08/06` to `Mån08/06` which the `\b` in the date regex rejects — infer the year from the "Datum i perioden" input with New Year wrap handling and a ±45-day sanity guard, then take the **latest non-red weekday column** as the submit deadline. Red-styled holidays are excluded by color; weekends are excluded by weekday arithmetic even when color detection fails (e.g. under the dark theme). For week 202624 that's Fre 12/06, so nothing fires before Friday. The "Datum i perioden" fallback is removed outright — a wrong date is strictly worse than none, and the manual override exists for exotic layouts.
- **Four silently-swallowed scope errors in the period code.** (1) `columnLooksRed` was called before its `const` declaration (TDZ inside a try/catch), so the "latest black candidate" selection never ran; the block now sits after the helpers it uses. (2) `isRedColor` was declared inside the `if (sumIdx > 0)` block but referenced by three other heuristics — red-column skipping in all the fallback scans threw and was swallowed, leaving the in-frame Sum-left scan completely dead; it's now declared once at `findPeriodEndDate` scope. (3) `notifyNow(true)` on the already-notified path was a TDZ call (const arrow declared later in the function), so UI re-enforcement silently did nothing; it's a hoisted function declaration now. (4) The persistent submit banner was never created: all four `createSubmitBanner` call sites referenced `explanation`, a const scoped inside an already-closed try block — it's now declared at function scope, so the advertised one-click submit banner finally appears (on the deadline day, on the timesheet only).
- **Overdue wording + localization.** When the detected deadline lies in the past, the indicator and banner now say "Perioden har passerat – skicka in din tidrapport." (en: "The reporting period has ended — submit your time report.") instead of falsely claiming today is the last day. The hard-coded `- Submit time report!` subtext override now respects the sv/en reminder language ("- Skicka in tidrapporten!").

## 1.4.10 — 2026-05-30

### Fixed
- **The Utlägg overview "Utkast" / "Pågående" tiles closed their draft-list popup by themselves before you could click anything.** The dialog-sweep (which auto-dismisses the save-success overlay after an autosave, plus session / logout dialogs) classified *any* dialog-like element whose text contained one of a broad keyword list — `'spara'`, `'utkast'`, `'tidrapport'`, `'genomfört'`, `'uppdatera'`, … — as a save dialog, then hid it and clicked its close/OK button. The draft list opened from the **Utkast** tile is a `.k-window` / `role="dialog"` popup whose own heading literally contains the word "utkast", so the MutationObserver's `dialogAdded` branch kicked off an 8 s sweep (polling every 120 ms) that immediately killed it. None of the sweep code gates on `onTimesheetPage`, so it fired on the expense overview even though that isn't a timesheet. Fix: save-dialog detection is now **selector-only** — `isSaveDialog` matches strictly the Unit4 `u4_messageoverlay_success` overlay family (either the candidate itself or an overlay nested inside it), and the bare-keyword text scan in both `isSaveDialog` and `sweepDialogs` is removed. The genuine save-success overlay is still dismissed on the timesheet because it's keyed off that reliable selector — which also dodges a postback race where `onTimesheetPage` momentarily flips false while the overlay is on screen, so a page-gate would have *stopped* dismissing the real overlay. Separately, `RETURN_TO_APP_LABELS` was narrowed to the full phrases `'tillbaka till applikationen'` / `'return to application'`; the bare `'tillbaka'` / `'gå tillbaka'` matched ordinary "Back" buttons and were a second way `checkReturnToAppButton` could auto-close the popup. Logout-page return-to-application handling still matches the full phrase.

## 1.4.9 — 2026-05-29

### Fixed
- **Edit-row columns drifted right (Tidsenhet + every day cell shoved one slot over) on absence rows showing Tidsenhet "Dagar".** Same root cause as the 1.2.16 "Timmar" drift — a hidden-column editor cell occupying space in the edit row — but it slipped through on absence rows. The 1.2.16 hide rule matches the Arb.typ (`work_type`) edit cell via `tr.EditRow td:has(input[title="Arb.typ"])`. On a "Dagar" row work_type isn't editable, so Agresso renders it as an **empty `EditLabel` cell with no `<input>`** — the `:has(input[title=…])` selector never matches it. Because the column's header is `display:none`, that orphaned ~76px cell becomes the only thing defining the column width and pushes Tidsenhet and all seven day columns one slot to the right. Normal "Timmar" rows hid the symptom because the cell carries a titled input the CSS already catches. Fix: new `hideEditRowHiddenColumnCells()` reaches the stray cell structurally — it anchors on the `reg_value1` day editor (whose input name is stable across units/row types) and walks left (Tidsenhet → Arb.typ → Bereds.), hiding the Arb.typ / Bereds. cells when they're an empty placeholder or the column's own titled editor, never a populated field. Runs from `enhanceLayout` so it re-applies on every grid refresh.

## 1.4.8 — 2026-05-15

### Fixed
- **Delproj summary panel jumped to the top of the page after status changes / week changes.** `findArbetstimmarAnchor` walked up looking for `<fieldset>` or `<section>` wrappers, but this Agresso build doesn't render either tag — sections are always `<div class="u4-section-placeholder">` wrappers. The walk-up always fell through to `heading.parentElement`, which after a postback was sometimes a `<div>` enclosing Tidrapport för too — so my "insert before Arbetstimmar" call dropped the panel above Tidrapport för. New anchor logic targets `h2.SectionTitle` directly and walks up to the outermost `u4-section-placeholder` (Agresso's actual section wrapper class). `ensureDelprojPanel` also re-seats the panel directly before that wrapper on every refresh — idempotent when already in place — so status changes, week changes, and saves can't strand the panel in a stale position.

## 1.4.7 — 2026-05-13

### Fixed
- **Editing a row still hid it from the Delproj summary and zero'd out its Fakt. värde contribution.** Root cause was structural, not just about preferring `input.value` vs `textContent`: when a row enters edit mode, Agresso replaces the row's HTML wholesale — a static row's ~20 top-level `<td>`s drop to ~4 in the `EditRow`, with all the field editors nested deep inside as `<input>` widgets. The earlier fixes still used `row.children[faktIdx]` (cellIndex against the header row) for the EditRow, which no longer lined up — every cell read returned NaN, the row collapsed to `effective = 0`, and it was silently dropped from the summary. The Fakt. värde footer total was wrong the same way. New helpers `readEditRowFakt`, `readEditRowDaySum`, `readEditRowDelprojCode`, `readEditRowDelprojName` find the values via stable input-name patterns instead: `input[name$="$inv_value$i"]` for the billable value, `input[name$="$reg_valueN$i"]` for each day (N=1..7), `input[title="Delproj"]` for the Delproj code, and the editor's `$RowDescription` sibling for the project name. Both `applyFaktVardeSum` and `recomputeDelprojSummary` now branch on `tr.EditRow` to use these helpers; static rows keep the cellIndex path that already worked.

## 1.4.6 — 2026-05-13

### Fixed
- **Delproj summary dropped the row being edited.** v1.4.5 made `readCellNumber` and `extractDelprojCode` prefer `input.value` over `cell.textContent` so that the row's value would stay in the total while the user typed. But Agresso's EditRow renders an editor `<input>` in **every** cell of the row — including cells the user isn't actually typing in — and the non-focused inputs often default to `value="0"` while the real displayed number lives in the cell's text node. Result: as soon as a row entered edit mode, every numeric cell on it read as 0 from my preferred input, so `effective = max(0, 0) = 0` and the row was silently dropped from the panel (the Fakt. värde footer recomputed correctly because Agresso's own commit had landed by the time the user moved focus). Fix: only trust `input.value` when the input is the document's `activeElement` (i.e., the user is typing in *that* cell right now). For all other cells, read `textContent` first — that mirrors what Agresso is displaying regardless of edit state. Same logic now used in both `readCellNumber` and `extractDelprojCode`.

## 1.4.5 — 2026-05-13

### Fixed
- **Fakt. värde footer total + Delproj summary went briefly wrong (value "disappeared") while a row was being edited.** Both `applyFaktVardeSum` and `recomputeDelprojSummary` explicitly skipped any row carrying the `EditRow` class — Agresso's marker for the row whose cells are currently displaying inline editors. The row's textContent was empty in that state (the editor `<input>` carried the value, not the cell text), so the value silently dropped out of the totals until the user blurred. New helper `readCellNumber()` reads `input.value` from a child editor when present and falls back to `cell.textContent` otherwise; the `EditRow` skip is removed from both code paths and the helper is also used in the Delproj-code extraction so a row being re-categorised stays grouped under the code the user is typing.
- **Totals only updated on blur / click-elsewhere, not while typing.** `onFieldInput` now calls `scheduleLayoutRefresh()` and `scheduleDelprojSummary()` directly. With the existing 200 ms debounce in `scheduleLayoutRefresh`, this is cheap even at typing speed — the user sees the Fakt. värde footer and the Delproj panel update inline as they type, and immediately (within 200 ms) when they press Enter or Tab.

## 1.4.4 — 2026-05-13

### Fixed
- **`Fakt. värde` footer total + Delproj summary went stale after editing a cell.** The MutationObserver in `initObservers()` only watched `childList` mutations and the `title`/`onclick` attributes, but Agresso commits some in-place edits by mutating an existing text node's `characterData` — neither code path fires, so the debounced `scheduleLayoutRefresh()` never ran and the totals stayed pinned at their initial values until the user added/removed a row or sorted the grid. Two-part fix: (1) observer now also watches `characterData: true`, so direct text mutations on body cells trigger the refresh path; (2) `onFieldBlur` explicitly calls `scheduleLayoutRefresh()` + `scheduleDelprojSummary()` as a belt-and-suspenders trigger when an editor loses focus, regardless of how Agresso wires the commit back into the DOM.

## 1.4.3 — 2026-05-13

### Added
- **Delproj summary totals footer row.** New `tfoot` row at the bottom of the panel labelled "Totalt" with the same three columns as the body rows: grand-total `Timmar` (sum of per-row `max(Sum, Fakt. värde)`) and a dimmed `Underlag` summary (`S X.XX / F Y.YY`) of the raw column totals. Header still shows the same total as a `Σ N.NN h` chip so the figure stays visible when the panel is collapsed.

## 1.4.2 — 2026-05-13

### Fixed
- **Delproj summary still doubled every group's hours.** v1.4.1 added a Sum-column exclusion based on `SUM_HEADER_RE` (`/^\s*(sum|summa|Σ)\s*$/i`, anchored), but tested it against the **concatenation** of `textContent` and `title` separated by a space. When the Sum `<th>` carried both (text "Sum" + `title="Sum"`), the concatenated probe was `"Sum Sum"`, which the anchored regex rejected — so the Sum column slipped through `^reg_value` and got summed alongside the day cells, doubling every row's hours. Fix: probe `textContent` and `title` separately and treat a match in either as "this is the Sum column, exclude it from day cells".

## 1.4.1 — 2026-05-13

### Fixed
- **Delproj summary missing rows whose `Fakt. värde` was 0.** v1.4.0's day-column filter required `data-fieldname` to end in a numeric suffix (`^reg_value_\d+$`), but this Agresso build names the day columns without that suffix — the filter therefore matched zero day columns, every row's hours read as 0, and any row with `Fakt. värde = 0` was skipped entirely (four of the six visible Delproj groups disappeared from the panel). New rule: match `data-fieldname^="reg_value"` BUT exclude any column whose header text is "Sum" / "Summa" / "Σ" — that's how we tell the per-row Sum aggregate apart from the day cells regardless of naming convention.
- **`Minimize Arbetstimmar by default` was a no-op.** v1.4.0 dispatched `.click()` on the legend element, but Agresso wires its collapse handler on a small icon inside the legend, not on the legend itself. Refactored to walk the section for the first onclick-bearing child (preferring handlers whose code text mentions `toggle / collapse / expand / hide / show`) and dispatch both a `.click()` and a synthetic `MouseEvent` so older grid layouts respond too.

### Changed
- **Bigger Delproj-panel collapse toggle.** Button bumped from 14×14 to 28×28 with a 20px chevron and a hover highlight — easier to hit and matches Agresso's own header-control sizing.

## 1.4.0 — 2026-05-13

### Added
- **Optional `Arbetstimmar` default-collapse.** New setting `arbetstimmar_collapsed_default` (off by default). When enabled, the native `Arbetstimmar` (Från / Till / Återstående) section is collapsed once per page load by triggering Agresso's own legend-click handler — keeps the timesheet starting focused on Tidtransaktion. The collapse only fires when the section's content is currently visible (a one-shot per-page flag prevents re-clicking on later layout refreshes), so the user can manually re-open the section any time and it stays open.

### Changed
- **Delproj summary panel moved to in-flow placement above `Arbetstimmar`.** v1.3.0 first tried inserting next to `Saldolista` (which broke its chrome) then switched to a fixed-position overlay (which floated awkwardly). v1.4.0 anchors on the `Arbetstimmar` heading and inserts before it, so the panel sits between the (Tidrapport för + Saldolista) row and Arbetstimmar without touching either container.
- **Collapse toggle now uses a double-arrow chevron (`«`).** Matches Agresso's own section-collapse icon, rotated via CSS so the orientation flips with state (points up when expanded, down when collapsed) instead of swapping characters.

### Fixed
- **Delproj row hours no longer double-count.** The day-column detection in v1.3.0 used `data-fieldname^="reg_value"`, which also matched Agresso's per-row Sum column (it carries `data-fieldname` like `reg_value_sum`). Each row's hours therefore counted as `days + Sum = 2 × actual`. Tightened to `data-fieldname` of the form `reg_value_<digit>` so only the seven day columns are summed.

## 1.3.0 — 2026-05-13

### Added
- **Delproj summary panel.** New right-column section next to `Saldolista` that groups every `Tidtransaktion` row by Delproj code and shows the summed hours per group, so per-delprojekt totals are visible without manual scanning. Each row's contribution is `effective = max(Sum, Fakt. värde)` — if the row's billable value is higher than the hours total (typical Agresso pattern when a separate billable rate applies) the billable side carries the time we count; if Fakt. värde is empty, Sum is used; rows where both are empty/zero are skipped. The panel shows `Timmar` (the effective sum, bold) and a dimmed `Underlag` column listing the raw `S / F` breakdown so the rule stays transparent. Header shows a `Σ N.NN h` grand total and a collapse toggle (collapsed state persisted in `chrome.storage.local`). Refreshes on every grid mutation through the same observer branch as the project-name labels and Fakt. värde footer total. Toggleable from the options page (`show_delproj_summary`, default on).

## 1.2.1 — 2026-05-13

### Fixed
- **Fakt. värde footer total now lines up with the hours `Sum` total.** v1.2.0 injected the total as a bare `<span>`, which bypassed Agresso's native cell wrappers (className + `align="right"` + nested `<div>` with vertical-align rules) and rendered the number below the Σ row's baseline, slightly right of where the matching hours total sat in the Sum column. New approach: clone the inner DOM of the neighbouring Sum cell (the one already showing the hours total in the same `tr.SumItem`), swap the deepest leaf's text to our Fakt. värde total, and reuse the template's className / `align` / `valign` / inline style. Since none of those properties pin a pixel width, the alignment follows Agresso's own column-flow rules and scales dynamically with viewport width without any hard-coded padding on our side.

## 1.2.0 — 2026-05-13

### Added
- **Fakt. värde column total in the Σ footer row.** Agresso renders a `Sum` total for the hours column but leaves the adjacent `Fakt. värde` (billable value) cell in the `tr.SumItem` footer empty, so the user had to add the column up by eye when reviewing a draft. New `applyFaktVardeSum()` (cells.js) sums every body row's Fakt. värde value and writes the formatted total into the matching footer cell, right next to the existing hours sum (`24.00` in the timesheet shown in v1.2.0's release notes screenshot). Runs from `enhanceLayout()` so it refreshes on every grid mutation (row add / delete / in-row edit / sort). Column is located by header-text match (regex `/fakt\.?\s*v(ä|a)rde/i`) rather than by `data-fieldname`, because the underlying fieldname varies across Agresso installations while the visible label is stable; the footer `<td>` is then resolved by cellIndex so hidden columns (`Bereds.` / `Arb.typ` via `display: none`) keep the header → footer alignment correct. Only injects when the native cell is empty, so an Agresso configuration that already renders its own total is left untouched.

## 1.1.1 — 2026-04-21

### Fixed
- **Edit-row columns no longer drift right when a Tidkod / Delproj / Aktivitet picker is focused.** Root cause: Agresso's `.slcEditor` inputs (Tidkod, Delproj, Aktivitet autocompleters) call `ShowTypeAheadIcon(this)` on focus, which injects a picker icon as a sibling of the input inside the same `<td>`. The grid runs with `table-layout: auto`, so that sibling raises the cell's preferred width, which the browser redistributes by shrinking the flex Beskrivningstext column — Tidsenhet and every day cell then drift out from under their headers. Unfocusing the editor removes the icon and the row snaps back (which is why the symptom was transient and tied to which cell was "marked"). Fix lives in `cells.js` as `installEditRowWidthLock()`: on `focusin` inside a `.slcEditor`, snapshot every cell's current rendered width, pin them as inline `width` values, and switch the owning table to `table-layout: fixed`; on `focusout`, restore. The edit row therefore cannot be reshaped while a picker is open.

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
