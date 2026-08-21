(() => {
  // --- Settings (hydrated from chrome.storage.local; see loadSettings below). ---
  // These are `let`s so the options page can change them live without a reload.
  const SETTING_DEFAULTS = {
    IDLE_TIMEOUT_MS: 15000,
    SAVE_COOLDOWN_MS: 4500,
    DIALOG_SWEEP_MS: 8000,
    autosave_enabled: true,
    reminder_enabled: true,
    reminder_lang: 'sv',
    period_override: '',
    auto_stay_signed_in: true,
    auto_return_to_app: true,
    hide_ace_code: true,
    hide_work_type: true,
    show_project_label: true,
    show_delproj_summary: true,
    show_semester_summary: true,
    arbetstimmar_collapsed_default: false,
    // Hold user-typed Beskrivningstext and day hours across the postbacks
    // that a Delproj / Aktivitet change triggers. See applyStickyEditValues.
    sticky_edit_values: true,
    // 'auto' | 'dark' | 'light' — 'auto' follows OS prefers-color-scheme
    theme: 'auto',
    // Verbose per-event tracing (timer restarts, sweeps, activity). Off by
    // default: startTimer alone emitted >5000 console lines in a 10-minute
    // session, which drowns the warnings that actually matter.
    debug_logging: false,
    // Proactive session keep-alive. Periodically calls Agresso's own session
    // renew endpoint + dispatches a benign activity event so we aren't logged
    // out during long idle stretches. See sessionKeepAliveTick.
    session_keepalive_enabled: true,
    session_keepalive_minutes: 5,
    // Cache: last period-end ISO date we notified about. Shared across frames
    // via chrome.storage.local (replaces the old window.top.localStorage trick).
    period_notify_date: null
  };
  let SAVE_COOLDOWN_MS = SETTING_DEFAULTS.SAVE_COOLDOWN_MS;
  let DIALOG_SWEEP_MS = SETTING_DEFAULTS.DIALOG_SWEEP_MS;
  let IDLE_TIMEOUT_MS = SETTING_DEFAULTS.IDLE_TIMEOUT_MS;
  let settings = { ...SETTING_DEFAULTS };

  // The three timing knobs above are read on every timer/sweep start, so they
  // are mirrored out of `settings` into plain `let`s rather than dereferenced
  // each time. Nothing else may write them — call this after any change to
  // `settings` so the options page actually takes effect. (Until 1.5.1 this
  // function did not exist: the `let`s were initialised from the defaults and
  // never reassigned, which silently pinned every Timing option to its default.)
  const TIMING_BOUNDS = {
    IDLE_TIMEOUT_MS: [2000, 600000],
    SAVE_COOLDOWN_MS: [500, 30000],
    DIALOG_SWEEP_MS: [500, 60000]
  };
  function coerceTiming(key) {
    const [lo, hi] = TIMING_BOUNDS[key];
    const n = Number(settings[key]);
    if (!Number.isFinite(n)) return SETTING_DEFAULTS[key];
    return Math.max(lo, Math.min(hi, n));
  }
  function syncTimingVars() {
    IDLE_TIMEOUT_MS = coerceTiming('IDLE_TIMEOUT_MS');
    SAVE_COOLDOWN_MS = coerceTiming('SAVE_COOLDOWN_MS');
    DIALOG_SWEEP_MS = coerceTiming('DIALOG_SWEEP_MS');
  }

  const LAYOUT_REFRESH_MS = 200;
  const DIALOG_SWEEP_INTERVAL_MS = 120;
  const DELETE_KEYWORDS = ['ta bort', 'delete', 'remove'];
  const ADD_KEYWORDS = ['lägg till', 'add', 'new row'];
  const IDLE_RETRY_MS = 1200;
  const NO_CHANGES_POLL_MS = 600;
  const HEALTH_CHECK_MS = 30000;
  const IS_MAC = /mac/i.test(navigator.platform);
  const SHORTCUT_LABEL = IS_MAC ? 'Option+S' : 'Alt+S';
  const LOG_PREFIX = '[PRAgresso]';
  try { console.info(LOG_PREFIX, 'cells.js loaded'); } catch (e) {}
  // Hot-path tracing, gated behind the `debug_logging` option. console.info /
  // console.warn stay ungated — those are the low-volume lifecycle and health
  // messages the troubleshooting docs tell users to look for.
  function logDebug(...args) {
    if (!settings.debug_logging) return;
    try { console.debug(LOG_PREFIX, ...args); } catch (e) {}
  }
  const NO_CHANGES_TEXT = 'inga ändringar gjorda!';
  // Pages sometimes show an alternate no-data banner text. Detect that too.
  const NO_CHANGES_TEXT_ALT = 'tidrapporten är tom. inga data har sparats.';
  const SAVE_DIALOG_SELECTORS = [
    '[id^="u4_messageoverlay_success"]',
    '.u4-messageoverlay-success-header',
    '.u4-messageoverlay-success-body',
    '.u4-messageoverlay-success-footer'
  ];
  // NOTE: save-dialog detection is intentionally SELECTOR-ONLY (the
  // u4_messageoverlay_success family in SAVE_DIALOG_SELECTORS above). We used
  // to also match a list of bare keywords ('spara', 'utkast', 'tidrapport',
  // 'genomfört', 'uppdatera', …) against any dialog's text, but those words
  // appear in benign popups — most visibly the Utlägg draft list opened from
  // the "Utkast" tile — so the sweep mis-classified them as save dialogs and
  // auto-dismissed them before the user could interact. See isSaveDialog().
  const SAVE_BUTTON_SELECTORS = [
    // Unit4 Cloud ribbon save button (new)
    'a[aria-label="Spara"]',
    'a[aria-label="Save"]',
    'a.RibbonInlineButtonHappy[aria-label*="Spara"]',
    'a.RibbonInlineButtonHappy[title*="Alt+s"]',
    'a[title="(Alt+s)"]',
    'a[id$="tblsysSave"]',
    // Generic / legacy on-prem selectors
    'button[data-cmd="save"]',
    'button[data-action="save"]',
    'button[id*="save"]',
    'button[name*="save"]',
    'input[type="submit"][value*="Save"]',
    'input[type="button"][value*="Save"]',
    'input[type="submit"][value*="Spara"]',
    'input[type="button"][value*="Spara"]',
    'input[type="submit"][value*="Uppdatera"]',
    'input[type="button"][value*="Uppdatera"]',
    'button[title*="Save"]',
    'button[title*="Spara"]',
    'button[title*="Uppdatera"]',
    'a[data-cmd="save"]',
    'a[menu_id="TS294"]',
    'a[data-menu-id="TS294"]',
    'a[href*="menu_id=TS294"]',
    'a[href*="type=topgen"][href*="TS294"]'
  ];
  const SHORTCUT_COMBOS = [
    { altKey: true, metaKey: false },
    { altKey: false, metaKey: true },
    { altKey: true, metaKey: true }
  ];

  // Unified timer state
  let unifiedTimer = null;
  let timerStartedAt = 0;
  let timerDuration = IDLE_TIMEOUT_MS;
  let timerReason = 'idle';
  
  let layoutTimer = null;
  let lastSaveAt = 0;
  let pendingRow = null;
  let dialogSweepTimer = null;
  let dialogSweepEndAt = 0;
  let periodStatusRefreshTimer = null;
  let periodHighlightEnforcer = null;
  let dropdownActive = false;
  let dropdownRow = null;
  let dialogMissLogged = false;
  let noChangesBannerVisible = false;
  let noChangesPollTimer = null;
  let timerBar = null;
  const trackedWindows = new Set();
  const trackedActivityDocs = new Set();

  function getAllDocuments() {
    const seen = new Set();
    const docs = [];

    const enqueue = (doc) => {
      if (!doc || seen.has(doc)) {
        return;
      }
      seen.add(doc);
      docs.push(doc);

      try {
        const frames = doc.querySelectorAll('iframe, frame');
        frames.forEach((f) => {
          try {
            enqueue(f.contentDocument);
          } catch (e) {
            // ignore cross-origin frames
          }
        });
      } catch (e) {
        // ignore
      }
    };

    enqueue(document);
    try {
      if (window.top && window.top.document) {
        enqueue(window.top.document);
      }
    } catch (e) {
      // ignore cross-origin access to top
    }

    return docs;
  }

  // The bulk of column sizing is done in styles.css (`!important` beats
  // Agresso's inline styles). BUT Agresso's `ColumnsAutoResizable` script
  // also reads `data-minwidth` / `data-tempwidth` attributes on every
  // header <th> and can re-apply the old 90px width via JS on resize,
  // column-drag, or grid refresh. Rewriting those attributes to match
  // our desired width makes the auto-resize path agree with the CSS.
  // Side effect: if the user drags the description column narrower,
  // Agresso's own resize will honour the drag — we only raise the floor.
  function applyFieldSizing() {
    // Only Beskrivningstext gets a sizing override. Tidsenhet / reg_unit
    // used to be force-widened here, but in edit mode Agresso positions
    // its picker widget relative to the cell in ways that don't adapt to
    // CSS width changes — the "Timmar" label kept visually overflowing
    // into the Mån column no matter what width we picked. The real fix
    // for that bug lives in styles.css (`tr.EditRow td { overflow:
    // hidden }`): clip any overflow inside edit-row cells so nothing
    // spills into neighbouring columns, while leaving Agresso's native
    // widget layout otherwise untouched.
    try {
      const DESC_FLOOR = 500;
      document.querySelectorAll('th[data-fieldname="description"]').forEach((th) => {
        try {
          const curMin = parseInt(th.getAttribute('data-minwidth') || '0', 10);
          if (curMin < DESC_FLOOR) th.setAttribute('data-minwidth', String(DESC_FLOOR));
          const curTemp = parseInt(th.getAttribute('data-tempwidth') || '0', 10);
          if (curTemp < DESC_FLOOR) th.setAttribute('data-tempwidth', String(DESC_FLOOR));
          th.style.removeProperty('width');
          th.style.setProperty('min-width', `${DESC_FLOOR}px`, 'important');
        } catch (e) {}
      });
    } catch (e) { /* ignore */ }
  }

  // Edit-row column-alignment lock. Agresso's typeahead pickers
  // (`<input class="slcEditor">` used for Tidkod, Delproj, Aktivitet, ...)
  // call `ShowTypeAheadIcon(this)` on focus, which injects a picker icon
  // as a sibling of the input inside the same <td>. In table-layout:auto
  // that sibling raises the cell's preferred width, which steals width
  // from the flex Beskrivningstext column — Tidsenhet and every day cell
  // then drift out from under their headers. Unfocusing the editor
  // removes the icon and the row snaps back.
  //
  // Fix: on focusin inside a .slcEditor, snapshot the current rendered
  // width of every cell in the owning edit row and pin those widths as
  // inline `width` + switch the owning table to `table-layout: fixed` so
  // the frozen widths become authoritative. On focusout, restore the
  // original table-layout and drop the inline widths. Global listener
  // (capture phase) so it survives Agresso's own DOM churn and works
  // regardless of which editor class instance is active.
  let _editRowLockInstalled = false;
  function installEditRowWidthLock() {
    if (_editRowLockInstalled) return;
    _editRowLockInstalled = true;
    const LOCK_FLAG = 'pragressoEditLock';
    const ORIG_LAYOUT = 'pragressoOrigTableLayout';

    const lockRow = (row) => {
      if (!row || row.dataset[LOCK_FLAG]) return;
      try {
        [...row.children].forEach((td) => {
          const w = td.getBoundingClientRect().width;
          if (w > 0 && !td.style.width) td.style.width = `${w}px`;
        });
        const table = row.closest('table');
        if (table && getComputedStyle(table).tableLayout !== 'fixed') {
          table.dataset[ORIG_LAYOUT] = table.style.tableLayout || '';
          table.style.tableLayout = 'fixed';
        }
        row.dataset[LOCK_FLAG] = '1';
      } catch (e) {}
    };

    const unlockRow = (row) => {
      if (!row || !row.dataset[LOCK_FLAG]) return;
      try {
        [...row.children].forEach((td) => { td.style.removeProperty('width'); });
        const table = row.closest('table');
        if (table && ORIG_LAYOUT in table.dataset) {
          table.style.tableLayout = table.dataset[ORIG_LAYOUT] || '';
          delete table.dataset[ORIG_LAYOUT];
        }
        delete row.dataset[LOCK_FLAG];
      } catch (e) {}
    };

    const onFocusIn = (e) => {
      const t = e.target;
      if (!t || !t.classList || !t.classList.contains('slcEditor')) return;
      const row = t.closest && t.closest('tr.EditRow');
      if (row) lockRow(row);
    };
    const onFocusOut = (e) => {
      const t = e.target;
      if (!t || !t.classList || !t.classList.contains('slcEditor')) return;
      const row = t.closest && t.closest('tr.EditRow');
      // Defer: Agresso's blur handler (ResetTextBox) runs first and may
      // briefly re-focus the input while swapping widgets. Unlock on the
      // next tick so rapid focus→blur→focus cycles don't flash widths.
      setTimeout(() => {
        if (row && !row.contains(row.ownerDocument.activeElement)) unlockRow(row);
      }, 0);
    };

    try {
      document.addEventListener('focusin', onFocusIn, true);
      document.addEventListener('focusout', onFocusOut, true);
    } catch (e) {}
  }

  // Inject a stylesheet that toggles column visibility based on user settings.
  // Using display:none (rather than width:0) removes the residual 1px border
  // that the old approach left behind. Re-called when hide_* settings change.
  const COLUMN_HIDE_STYLE_ID = 'agresso-column-hide-style';
  function applyColumnHideSheet() {
    try {
      const rules = [];
      // Selectors match three cell states per column:
      //   1. <th data-fieldname="X"> — the column header
      //   2. static body <td> with onclick="TG.GS.ER(this, 'X')"
      //   3. EDIT-row <td> that contains a widget — matched via :has()
      //      against the editor <input>'s title attribute, which Agresso
      //      populates with the human-readable column name ("Bereds." /
      //      "Arb.typ"). Without (3), hidden columns reappear as two
      //      stray pickers between Tidsenhet and Mån the moment the user
      //      edits any row.
      // Selectors match four cell states per column:
      //   1. <th data-fieldname="X"> — the column header.
      //   2. Static body <td> with onclick="TG.GS.ER(this, 'X')".
      //   3. EDIT-row <td> containing an editor <input> whose title is the
      //      human-readable column name ("Bereds." / "Arb.typ").
      //   4. SUM/footer-row <td> with id ending in "_sumRow_<fieldname>"
      //      (Agresso's tr.SumItem suffixes cell IDs with the fieldname).
      //      Without (4), the summary row still renders empty cells for
      //      hidden columns and visibly shifts the day-totals left.
      if (settings.hide_ace_code) {
        rules.push(
          `[data-fieldname="ace_code"], ` +
          `td[onclick*="'ace_code'"], td[onclick*='"ace_code"'], ` +
          `tr.EditRow td:has(input[title="Bereds."]), ` +
          `tr.SumItem td[id$="_sumRow_ace_code"] ` +
          `{ display: none !important; }`
        );
      }
      if (settings.hide_work_type) {
        rules.push(
          `[data-fieldname="work_type"], ` +
          `td[onclick*="'work_type'"], td[onclick*='"work_type"'], ` +
          `tr.EditRow td:has(input[title="Arb.typ"]), ` +
          `tr.SumItem td[id$="_sumRow_work_type"] ` +
          `{ display: none !important; }`
        );
      }
      const css = rules.join('\n');
      const existing = document.getElementById(COLUMN_HIDE_STYLE_ID);
      if (!css) {
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        return;
      }
      if (existing) {
        existing.textContent = css;
      } else {
        const style = document.createElement('style');
        style.id = COLUMN_HIDE_STYLE_ID;
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
      }
    } catch (e) { /* ignore */ }
  }

  // Resolve the Agresso field name for a table cell. In the Unit4 Cloud grid,
  // body <td>s carry the name in an inline handler (TG.GS.ER(this, 'work_order')),
  // while the legacy on-prem layout placed data-fieldname on the <td> itself.
  // As a final fallback we walk up to the table and use the header <th> at the
  // same cellIndex. This makes the lookup robust across re-renders (sort, etc.).
  function getCellFieldName(td) {
    try {
      const direct = td.getAttribute && td.getAttribute('data-fieldname');
      if (direct) return direct;
      const onclick = (td.getAttribute && td.getAttribute('onclick')) || '';
      const m = onclick.match(/TG\.GS\.ER\s*\(\s*this\s*,\s*['"]([^'"]+)['"]\s*\)/);
      if (m && m[1]) return m[1];
      const table = td.closest ? td.closest('table') : null;
      if (table) {
        const headerRow = table.querySelector('tr');
        const headers = headerRow ? headerRow.querySelectorAll('th') : [];
        const header = headers[td.cellIndex];
        if (header) {
          const df = header.getAttribute('data-fieldname');
          if (df) return df;
        }
      }
    } catch (e) {}
    return null;
  }

  // Strip the trailing " - <code>" segment from a cell title, preserving any
  // dashes that appear inside the customer/project name. Examples:
  //   "Customer Inc, Project Foo-Bar - 123456-7"       → "Customer Inc, Project Foo-Bar"
  //   "Another Customer (ABC123) - 234567-1"          → "Another Customer (ABC123)"
  //   "Customer - 12345"                              → "Customer"
  // Regex: last " - " followed by digits/uppercase/hyphens (an Agresso code).
  const TITLE_CODE_STRIP_RE = /\s-\s[A-Z0-9][A-Z0-9\-\/]*\s*$/i;
  function extractProjectDescription(title) {
    if (!title) return '';
    let s = title.replace(TITLE_CODE_STRIP_RE, '').trim();
    if (s === title || s === '') {
      // Fallback: last " - " anywhere. Handles codes with unexpected shapes.
      const idx = title.lastIndexOf(' - ');
      s = (idx !== -1 ? title.substring(0, idx) : title).trim();
    }
    return s;
  }

  // Keep the user's visual position stable across our own DOM injections.
  // After "Lägg till" Agresso re-renders the grid and runs its own
  // auto-scroll; our rAF/debounced passes then re-insert project labels and
  // re-render the Delproj panel. Any height those add ABOVE the first
  // visible grid row pushes the whole page down without scrollTop moving —
  // the net effect reads as a scroll jump the user has to correct manually.
  // Anchor on the first grid row intersecting the viewport top and restore
  // its viewport-relative position after the mutation. Only rows below the
  // anchor (or the anchor itself, which grows downward) change otherwise,
  // and those don't move the view. No-op at scrollTop 0 and when nothing
  // above the anchor changed (delta 0), so Agresso's own intentional
  // scrolling is never fought.
  function withStableViewport(fn) {
    let anchor = null;
    let anchorTop = 0;
    let se = null;
    try {
      se = document.scrollingElement;
      if (se && se.scrollTop > 0) {
        const rows = document.querySelectorAll('table.Excel tr, .MainTable tr');
        for (const tr of rows) {
          const r = tr.getBoundingClientRect();
          if (r.bottom > 0 && r.height > 0) { anchor = tr; anchorTop = r.top; break; }
        }
      }
    } catch (e) {}
    try {
      fn();
    } finally {
      try {
        if (anchor && se && anchor.isConnected) {
          const delta = anchor.getBoundingClientRect().top - anchorTop;
          if (delta) se.scrollTop += delta;
        }
      } catch (e) {}
    }
  }

  // Coalesce rapid calls into a single pass per animation frame.
  let projectLabelsRafScheduled = false;
  function addProjectLabels() {
    if (projectLabelsRafScheduled) return;
    projectLabelsRafScheduled = true;
    const run = () => {
      projectLabelsRafScheduled = false;
      withStableViewport(applyProjectLabels);
    };
    try { requestAnimationFrame(run); } catch (e) { setTimeout(run, 16); }
  }

  const PROJECT_LABEL_CLASS = 'agresso-work-order-label';
  const PROJECT_LABEL_STYLE =
    'font-size: 10px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

  // Create / update / remove the small project-name line inside a cell.
  // Only direct children are considered, so a label never gets confused with
  // one belonging to a nested widget inside the same cell.
  function setProjectLabel(cell, text) {
    try {
      if (!cell || !cell.children) return;
      let label = null;
      for (const node of cell.children) {
        if (node.classList && node.classList.contains(PROJECT_LABEL_CLASS)) { label = node; break; }
      }
      if (!text) {
        if (label && label.parentNode) label.parentNode.removeChild(label);
        return;
      }
      if (label) {
        if (label.textContent !== text) label.textContent = text;
        if (label.getAttribute('title') !== text) label.setAttribute('title', text);
        return;
      }
      const para = (cell.ownerDocument || document).createElement('p');
      para.className = PROJECT_LABEL_CLASS;
      para.setAttribute('style', PROJECT_LABEL_STYLE);
      // The column is ~120px wide, so most names ellipsize — keep the full
      // string reachable on hover.
      para.setAttribute('title', text);
      para.textContent = text;
      cell.appendChild(para);
    } catch (e) {}
  }

  function applyProjectLabels() {
    try {
      if (settings.show_project_label === false) {
        // Setting turned off — remove any labels previously added.
        document.querySelectorAll('.agresso-work-order-label').forEach((n) => {
          try { n.parentNode && n.parentNode.removeChild(n); } catch (e) {}
        });
        return;
      }
      const tds = document.querySelectorAll('td');
      for (let i = 0; i < tds.length; ++i) {
        try {
          const td = tds[i];
          if (!td || !td.getAttribute) continue;
          const title = td.getAttribute('title');
          if (!title) continue;
          const trimmed = title.trim();
          if (!trimmed || trimmed === '-' || trimmed === '- ' || trimmed === ' -') continue;
          const field = getCellFieldName(td);
          if (field !== 'work_order' && field !== 'project') continue;
          const existing = td.querySelector && td.querySelector('.agresso-work-order-label');
          const descText = extractProjectDescription(title);
          if (!descText) {
            if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
            continue;
          }
          if (existing) {
            // Title changed (edit-in-row) — update text without re-creating.
            if (existing.textContent !== descText) existing.textContent = descText;
            continue;
          }
          const para = document.createElement('p');
          para.className = PROJECT_LABEL_CLASS;
          para.setAttribute('style', PROJECT_LABEL_STYLE);
          para.textContent = descText;
          td.appendChild(para);
        } catch (e) {}
      }

      // The row being edited. Its Delproj cell renders a lookup editor instead
      // of a titled <td>, so the loop above — which keys off the cell's title
      // attribute — finds nothing there, and the one row the user is actually
      // working on was the only row in the grid showing a bare code with no
      // project name under it. The name is sitting in the editor's hidden
      // RowDescription sibling; render it under the input with the same label.
      document.querySelectorAll('tr.EditRow').forEach((row) => {
        try {
          const editor = findEditRowDelprojEditor(row);
          const cell = (editor && editor.closest && editor.closest('td')) ||
            editRowCellByField(row, DELPROJ_FIELDNAMES);
          if (!cell) return;
          setProjectLabel(cell, readEditRowDelprojName(row));
        } catch (e) {}
      });
    } catch (e) {}
  }

  // Sum the "Fakt. värde" (billable value) column and render the total into the
  // matching cell of the SumItem (footer) row. Agresso fills in a column total
  // for hours (Sum column) but leaves Fakt. värde blank, so the user has to add
  // it up themselves when reviewing a draft. We drop the total directly into
  // that empty footer cell, next to the existing hours sum.
  //
  // Column is matched by header text rather than `data-fieldname` because the
  // underlying fieldname varies across Agresso installations (bill_value /
  // fact_value / value_1 / ...), while the visible label "Fakt. värde" is
  // stable. Footer cell is located by cellIndex so hidden columns
  // (display:none on Bereds. / Arb.typ) don't throw the alignment off — both
  // header <th> and footer <td> at the matched index move in lockstep.
  //
  // Alignment strategy: clone the inner DOM of the neighbouring Sum cell
  // (the one already showing 24.00) into the target Fakt. värde cell, then
  // overwrite the leaf text with our total. Reusing Agresso's own wrapper
  // markup (className, align attribute, inline style, nested <div>s) means
  // our value inherits the exact same right-alignment, vertical-align,
  // padding, font, and width-flow rules as the native Sum total — so the
  // two numbers line up at any viewport size without any fixed widths or
  // hard-coded padding on our side.
  const FAKT_SUM_ATTR = 'data-pragresso-fakt-sum';
  const FAKT_HEADER_RE = /fakt\.?\s*v(ä|a)rde/i;
  const SUM_HEADER_RE = /^\s*(sum|summa|Σ)\s*$/i;
  // Day columns carry data-fieldname reg_value1..reg_value7; the aggregate Sum
  // column is the digit-less `reg_value`. Discriminating on the attribute is
  // locale-independent — matching the Sum column by its *header text* (which
  // is what SUM_HEADER_RE was doing on its own) silently fails on any
  // non-sv/en install, and a missed Sum column gets counted as an eighth day,
  // doubling every row's hours.
  const DAY_FIELD_RE = /^reg_value\d+$/i;
  // Rows registered in days rather than hours (absence, vacation) put "1.00"
  // in each day cell and rely on the Tidsenhet column for meaning. Agresso's
  // own footer normalises those to hours before totalling; we must too, or a
  // 5-day vacation row reads as "5.00 h" next to Agresso's "40.00".
  const REG_UNIT_FIELD = 'reg_unit';
  const DAY_UNIT_RE = /^\s*(dag|dagar|day|days)\s*$/i;
  const DEFAULT_HOURS_PER_DAY = 8;

  // Parse a number from Agresso's two number formats: Swedish ("1 234,56")
  // and English ("1234.56"). Returns NaN if the string is empty or not
  // numeric.
  function parseAgressoNum(raw) {
    if (raw == null) return NaN;
    const t = ('' + raw).trim();
    if (!t) return NaN;
    const n = parseFloat(t.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }

  // Read a numeric value from a STATIC body cell (a row without the
  // `EditRow` class). For EditRow cells, see readEditRowFakt /
  // readEditRowDaySum — those use input-name lookups instead, because
  // Agresso replaces a static row's markup entirely when it enters edit
  // mode: the row drops from ~20 top-level <td>s down to ~4, with all the
  // field editors nested inside as input widgets, so cellIndex-based
  // lookups no longer line up with the header columns.
  function readCellNumber(cell) {
    if (!cell) return NaN;
    // Focused editor → live value (handles per-cell editing in static rows
    // for Agresso variants that allow in-place editing without an EditRow).
    try {
      const inputs = cell.querySelectorAll ? cell.querySelectorAll('input, textarea') : [];
      const active = (cell.ownerDocument || document).activeElement;
      for (const inp of inputs) {
        if (inp.type === 'hidden') continue;
        if (inp === active) {
          const n = parseAgressoNum(inp.value);
          return Number.isFinite(n) ? n : 0;
        }
      }
    } catch (e) {}
    const textN = parseAgressoNum(cell.textContent);
    if (Number.isFinite(textN)) return textN;
    try {
      const inputs = cell.querySelectorAll ? cell.querySelectorAll('input, textarea') : [];
      for (const inp of inputs) {
        if (inp.type === 'hidden') continue;
        const n = parseAgressoNum(inp.value);
        if (Number.isFinite(n)) return n;
      }
    } catch (e) {}
    return NaN;
  }

  // EditRow readers — find values by Agresso's stable input-name patterns
  // since the row's top-level cell layout doesn't survive the static → edit
  // transformation. Names look like
  //   b$s89$g89s90$rowN$reg_valueK$i    (K = 1..7, day cells)
  //   b$s89$g89s90$rowN$inv_value$i     (Fakt. värde)
  // Selectors below match the suffix only, so the section / grid prefix
  // (`b$s89$g89s90$rowN`) doesn't matter.
  function readEditRowFakt(row) {
    if (!row || !row.querySelector) return NaN;
    const inp = row.querySelector('input[name$="$inv_value$i"]');
    if (!inp) return NaN;
    return parseAgressoNum(inp.value);
  }
  function readEditRowDaySum(row) {
    if (!row || !row.querySelectorAll) return NaN;
    let total = 0;
    let any = false;
    // Scan by name suffix instead of a fixed 1..7 loop: a period view can
    // render more than seven day columns (a week bracketed by both adjacent
    // weekends shows nine, reg_value1..reg_value9), and the hardcoded loop
    // silently dropped days 8+ from the sum.
    for (const inp of row.querySelectorAll('input[name$="$i"]')) {
      if (!/\$reg_value\d+\$i$/.test(inp.name || '')) continue;
      const n = parseAgressoNum(inp.value);
      if (Number.isFinite(n)) { total += n; any = true; }
    }
    return any ? total : NaN;
  }
  // Tidsenhet in edit mode is an input rather than a plain cell, so the
  // header-index read used on static rows finds nothing here.
  function readEditRowUnit(row) {
    if (!row || !row.querySelector) return '';
    const inp = row.querySelector(`input[name$="$${REG_UNIT_FIELD}$i"]`);
    if (inp && typeof inp.value === 'string') return inp.value.trim();
    const sel = row.querySelector(`select[name$="$${REG_UNIT_FIELD}$i"]`);
    if (sel) {
      const opt = (sel.selectedOptions && sel.selectedOptions[0]) ||
        (sel.options && sel.options[sel.selectedIndex]);
      if (opt) return (opt.text || '').trim();
    }
    return '';
  }
  // Locate the Delproj lookup editor inside an EditRow.
  //
  // `input[title="Delproj"]` reads like the obvious anchor and was the only
  // one until now, but Agresso CLEARS that title the moment the user picks a
  // value from the editor's autocomplete list. Verified against the live
  // grid: right after picking a Delproj the editor came back with `title=""`
  // while the untouched Aktivitet editor beside it still carried
  // `title="Aktivitet"`. So the title only finds the field while it is still
  // empty — precisely when there is nothing to read. Fall back to the column
  // position: edit rows keep a 1:1 cell↔header alignment in this build
  // (hidden columns included, see 1.5.3), so the header carrying
  // data-fieldname `work_order` / `project` points at the right cell no
  // matter what the editor's attributes say.
  const DELPROJ_FIELDNAMES = ['work_order', 'project'];
  const DELPROJ_TITLE_SEL =
    'input[title="Delproj"], input[title="Sub project"], input[title="Subproject"]';

  function editRowCellByField(row, fieldNames) {
    try {
      if (!row || !row.children || !row.closest) return null;
      const table = row.closest('table');
      const headerRow = table && table.querySelector('tr');
      const headers = headerRow ? headerRow.querySelectorAll('th') : [];
      // Only trust the index while the counts line up — a row rendering fewer
      // cells than the header has is not addressable this way.
      if (!headers.length || headers.length !== row.children.length) return null;
      for (let i = 0; i < headers.length; ++i) {
        const f = headers[i].getAttribute('data-fieldname');
        if (f && fieldNames.indexOf(f) !== -1) return row.children[i];
      }
    } catch (e) {}
    return null;
  }

  function findEditRowDelprojEditor(row) {
    if (!row || !row.querySelector) return null;
    const byTitle = row.querySelector(DELPROJ_TITLE_SEL);
    if (byTitle) return byTitle;
    const cell = editRowCellByField(row, DELPROJ_FIELDNAMES);
    return cell ? cell.querySelector('input[name$="$Editor"]') : null;
  }

  // Read one of a lookup editor's hidden siblings. Agresso renders each lookup
  // as `<base>$Editor` (what you see) plus `<base>$RowValue` (the resolved
  // code) and `<base>$RowDescription` (the human-readable name). Matched by
  // scanning the siblings rather than with an attribute selector so the `$`
  // characters in the name never need CSS escaping.
  function readEditorSibling(editor, suffix) {
    try {
      if (!editor || !editor.name) return '';
      const wanted = editor.name.replace(/\$Editor$/, '') + '$' + suffix;
      const scope = (editor.closest && editor.closest('td')) || editor.parentElement;
      if (!scope || !scope.querySelectorAll) return '';
      for (const inp of scope.querySelectorAll(`input[name$="$${suffix}"]`)) {
        if (inp.name === wanted) return typeof inp.value === 'string' ? inp.value.trim() : '';
      }
    } catch (e) {}
    return '';
  }

  function readEditRowDelprojCode(row) {
    const editor = findEditRowDelprojEditor(row);
    if (!editor) return '';
    // Editor first — that's what the user is typing right now; the resolved
    // RowValue covers the renders where the editor comes back blank.
    const typed = typeof editor.value === 'string' ? editor.value.trim() : '';
    return typed || readEditorSibling(editor, 'RowValue');
  }
  function readEditRowDelprojName(row) {
    return readEditorSibling(findEditRowDelprojEditor(row), 'RowDescription');
  }
  function applyFaktVardeSum() {
    try {
      // Find the Tidtransaktion grid. Anchor on reg_value or description (both
      // already used elsewhere in this file to identify the timesheet table).
      const anchor =
        document.querySelector('th[data-fieldname^="reg_value"]') ||
        document.querySelector('th[data-fieldname="description"]');
      const table = anchor && anchor.closest ? anchor.closest('table') : null;
      if (!table) return;
      const headerRow = table.querySelector('tr');
      if (!headerRow) return;
      const headers = headerRow.querySelectorAll('th');
      let faktIdx = -1;
      let sumIdx = -1;
      for (let i = 0; i < headers.length; ++i) {
        // Test textContent and title separately — same anchored-regex trap
        // fixed in recomputeDelprojSummary: SUM_HEADER_RE is `^…$`, so the
        // concatenated `"Sum Sum"` a <th> with both produces never matched.
        // Only cosmetic here (sumIdx is a style template, not an addend), but
        // it cost the Fakt. värde total Agresso's own column alignment.
        const tcText = (headers[i].textContent || '').trim();
        const titleText = (headers[i].getAttribute('title') || '').trim();
        if (faktIdx < 0 && (FAKT_HEADER_RE.test(tcText) || FAKT_HEADER_RE.test(titleText))) { faktIdx = i; continue; }
        if (sumIdx < 0 && (SUM_HEADER_RE.test(tcText) || SUM_HEADER_RE.test(titleText))) { sumIdx = i; }
      }
      if (faktIdx < 0) return;

      const sumRow = table.querySelector('tr.SumItem');
      if (!sumRow) return;
      const sumCells = sumRow.children;
      const target = sumCells[faktIdx];
      if (!target) return;
      const template = sumIdx >= 0 ? sumCells[sumIdx] : null;

      let total = 0;
      let any = false;
      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        if (row === headerRow) continue;
        if (!row.classList) continue;
        if (row.classList.contains('SumItem')) continue;
        let n;
        if (row.classList.contains('EditRow')) {
          // EditRow has a different cell layout — find inv_value by input
          // name pattern instead of cellIndex.
          n = readEditRowFakt(row);
        } else {
          const cell = row.children && row.children[faktIdx];
          if (!cell || cell.tagName !== 'TD') continue;
          n = readCellNumber(cell);
        }
        if (!Number.isFinite(n)) continue;
        total += n;
        any = true;
      }

      const ours = target.hasAttribute(FAKT_SUM_ATTR);
      const prev = target.getAttribute(FAKT_SUM_ATTR);
      if (!any) {
        if (ours) {
          target.innerHTML = '';
          target.removeAttribute(FAKT_SUM_ATTR);
        }
        return;
      }
      const formatted = total.toFixed(2);
      if (ours && prev === formatted) return;

      // First-time injection: if Agresso already rendered numeric content in
      // this cell (some installations DO total the column), leave it alone.
      if (!ours) {
        const native = (target.textContent || '').trim();
        if (native && /\d/.test(native)) return;
      }

      // Mirror the Sum cell's wrapper attributes so our cell adopts Agresso's
      // own right-aligned / vertical-aligned layout. Width-flow stays dynamic
      // because none of these properties pin a pixel size — they just describe
      // how text aligns inside whatever width the column ends up at.
      if (template) {
        if (template.className) target.className = template.className;
        const al = template.getAttribute('align');
        if (al) target.setAttribute('align', al);
        const valign = template.getAttribute('valign');
        if (valign) target.setAttribute('valign', valign);
        if (template.style && template.style.cssText) target.style.cssText = template.style.cssText;
        // Replace target's content with a clone of the template's inner DOM,
        // then swap the deepest leaf's text to our total. Cloning (not raw
        // innerHTML copy) is safer for any picked-up event handlers — the
        // clones are detached and never bound to Agresso's own listeners.
        target.innerHTML = '';
        for (const child of Array.from(template.childNodes)) {
          target.appendChild(child.cloneNode(true));
        }
        let leaf = target;
        while (leaf.firstElementChild) leaf = leaf.firstElementChild;
        leaf.textContent = formatted;
      } else {
        // No Sum template available — fall back to a right-aligned text node.
        // Better than nothing; almost never hit in practice because the
        // timesheet grid always has a Sum column to the left of Fakt. värde.
        target.textContent = formatted;
        target.style.textAlign = 'right';
      }
      target.setAttribute(FAKT_SUM_ATTR, formatted);
    } catch (e) { /* ignore */ }
  }

  // ── Delproj summary panel ──────────────────────────────────────────────
  // Group Tidtransaktion rows by Delproj code and sum hours per group, so
  // totals per delprojekt are visible without manual scanning. Read-only
  // scrape; no Agresso API calls. Refresh path is the same MutationObserver
  // branch that drives addProjectLabels / applyFaktVardeSum.
  //
  // Per-row effective value uses the user's rule:
  //   effective = max(sum, fakt_värde)
  // Rationale: if the row's billable value is higher than its hours total
  // (typical Agresso pattern when a separate billable rate applies), the
  // billable side carries the time we actually want to count. If only Sum
  // is present, use Sum.
  const DELPROJ_PANEL_ID = 'pragresso-delproj-summary';
  const DELPROJ_COLLAPSED_KEY = 'pragresso_delproj_collapsed';
  let delprojSummaryRafScheduled = false;
  let delprojSummaryCollapsed = false;

  function extractDelprojCode(td) {
    if (!td) return '';
    // If the typeahead picker in this cell is currently focused, prefer
    // its live value (the user is actively typing the new Delproj code).
    // Otherwise fall back to the static text rendered by Agresso — this
    // matters for edit-row cells where the Delproj input exists but is
    // un-focused and may carry a stale or empty default value alongside
    // the real code held in a text node sibling.
    try {
      const input = td.querySelector && td.querySelector('input.slcEditor, input[type="text"], input, textarea');
      const active = (td.ownerDocument || document).activeElement;
      if (input && active === input && typeof input.value === 'string' && input.value.trim()) {
        return input.value.trim();
      }
    } catch (e) {}
    // Static cell: leaf text before the agresso-work-order-label paragraph
    // we inject ourselves — that node holds the bare Delproj code.
    try {
      for (const node of td.childNodes) {
        if (node.nodeType === 3) {
          const t = (node.textContent || '').trim();
          if (t) return t;
        } else if (node.nodeType === 1) {
          if (node.classList && node.classList.contains('agresso-work-order-label')) continue;
          if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') continue;
          const t = (node.textContent || '').trim();
          if (t) return t;
        }
      }
    } catch (e) {}
    // Final fallbacks: textContent, then any input value.
    const all = (td.textContent || '').trim();
    if (all) return all;
    try {
      const input = td.querySelector && td.querySelector('input, textarea');
      if (input && typeof input.value === 'string' && input.value.trim()) {
        return input.value.trim();
      }
    } catch (e) {}
    return '';
  }

  function findArbetstimmarAnchor() {
    // Find the Arbetstimmar section's outermost `u4-section-placeholder`
    // wrapper. We insert our panel BEFORE that wrapper so it sits between
    // the (Tidrapport för + Saldolista) row and Arbetstimmar.
    //
    // Agresso doesn't render <fieldset> or <section> elements anywhere in
    // this build — sections are always wrapped in
    //   <div class="u4-section-placeholder Horizontal">
    //     <div class="PlaceHolderRow"> ... <h2 class="SectionTitle">… </h2>
    // — so earlier walk-ups that searched for tag names FIELDSET/SECTION
    // always fell through to `heading.parentElement`, which after a status
    // change / week change happened to be a wrapper that ALSO enclosed
    // Tidrapport för. Result: the panel jumped to the very top of the page.
    //
    // New strategy: target h2.SectionTitle (Agresso's stable heading class)
    // and walk up to the outermost u4-section-placeholder ancestor — that's
    // the wrapper Agresso ships per-section.
    try {
      const titles = document.querySelectorAll('h2.SectionTitle, h3.SectionTitle, .SectionTitle');
      let heading = null;
      for (const t of titles) {
        if (/^\s*Arbetstimmar\s*$/i.test(t.textContent || '')) {
          heading = t;
          break;
        }
      }
      if (!heading) {
        // Fallback: legacy markup with no SectionTitle class.
        const all = document.querySelectorAll('h1,h2,h3,h4,legend');
        for (const t of all) {
          if (/^\s*Arbetstimmar\s*$/i.test(t.textContent || '')) {
            heading = t;
            break;
          }
        }
      }
      if (!heading) return null;

      let node = heading;
      let placeholder = null;
      for (let i = 0; i < 12 && node && node.parentElement; ++i) {
        node = node.parentElement;
        if (node.classList && node.classList.contains('u4-section-placeholder')) {
          placeholder = node;
        }
      }
      return placeholder || heading.parentElement || heading;
    } catch (e) {}
    return null;
  }

  function ensureDelprojPanel() {
    let panel = document.getElementById(DELPROJ_PANEL_ID);
    const anchor = findArbetstimmarAnchor();
    if (panel) {
      // Re-seat the panel directly before the Arbetstimmar wrapper. After a
      // postback (status change, week change, save), Agresso re-renders the
      // page and the panel may end up at the wrong place (e.g., above
      // Tidrapport för) if a previous render anchored on a different
      // ancestor. Idempotent — does nothing when already correctly placed.
      if (anchor && anchor.parentNode && panel.nextSibling !== anchor) {
        try { anchor.parentNode.insertBefore(panel, anchor); } catch (e) {}
      }
      return panel;
    }
    panel = document.createElement('section');
    panel.id = DELPROJ_PANEL_ID;
    panel.className = 'pragresso-delproj-panel';
    panel.innerHTML =
      '<header class="pragresso-delproj-header">' +
        '<button type="button" class="pragresso-delproj-toggle" aria-expanded="true" title="Visa/dölj"></button>' +
        '<span class="pragresso-delproj-title">Delproj sammanställning</span>' +
        '<span class="pragresso-delproj-total" data-total></span>' +
      '</header>' +
      '<div class="pragresso-delproj-body">' +
        '<table class="pragresso-delproj-table">' +
          '<thead><tr><th>Delproj</th><th class="num">Timmar</th><th class="num small">Underlag</th></tr></thead>' +
          '<tbody></tbody>' +
        '</table>' +
      '</div>';
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(panel, anchor);
    } else {
      const host = document.body || document.documentElement;
      if (!host) return null;
      host.appendChild(panel);
    }

    const toggleBtn = panel.querySelector('.pragresso-delproj-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        delprojSummaryCollapsed = !delprojSummaryCollapsed;
        applyDelprojCollapsedState(panel);
        try {
          if (chrome && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ [DELPROJ_COLLAPSED_KEY]: delprojSummaryCollapsed });
          }
        } catch (e) {}
      });
    }
    applyDelprojCollapsedState(panel);
    return panel;
  }

  function applyDelprojCollapsedState(panel) {
    if (!panel) return;
    panel.classList.toggle('collapsed', !!delprojSummaryCollapsed);
    const btn = panel.querySelector('.pragresso-delproj-toggle');
    if (btn) {
      btn.setAttribute('aria-expanded', delprojSummaryCollapsed ? 'false' : 'true');
    }
  }

  function removeDelprojSummary() {
    const panel = document.getElementById(DELPROJ_PANEL_ID);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
  }

  // Working-day length, used to convert day-registered rows to hours.
  // Derived from the "Normaltimmar" field (Agresso names that input
  // `…$normalhrs_schedule$i`) divided by the number of day columns, so a
  // part-timer on 20 h/week correctly gets 4 h per vacation day rather than a
  // hard-coded 8. Falls back to DEFAULT_HOURS_PER_DAY when the field is
  // absent or the arithmetic lands somewhere implausible.
  function getHoursPerDay(dayCount) {
    if (!dayCount || dayCount <= 0) return DEFAULT_HOURS_PER_DAY;
    try {
      for (const doc of getAllDocuments()) {
        const inp = doc.querySelector &&
          doc.querySelector('input[id*="normalhrs_schedule"], input[name*="normalhrs_schedule"]');
        if (!inp) continue;
        const weekly = parseAgressoNum(inp.value);
        if (!Number.isFinite(weekly) || weekly <= 0) continue;
        const perDay = weekly / dayCount;
        if (perDay > 0 && perDay <= 24) return perDay;
      }
    } catch (e) {}
    return DEFAULT_HOURS_PER_DAY;
  }

  function recomputeDelprojSummary() {
    const anchor =
      document.querySelector('th[data-fieldname^="reg_value"]') ||
      document.querySelector('th[data-fieldname="description"]');
    const table = anchor && anchor.closest ? anchor.closest('table') : null;
    if (!table) return null;
    const headerRow = table.querySelector('tr');
    if (!headerRow) return null;
    const headers = headerRow.querySelectorAll('th');
    // Identify day-column indexes directly from data-fieldname (reg_value_1..7)
    // and the Fakt. värde column via its header text. We deliberately do NOT
    // depend on locating the "Sum" column header — Agresso's Sum cell can be
    // empty in body rows, and matching its header by text has been unreliable
    // (the earlier version of this code consistently read S=0 because of it).
    // Instead, sum the day cells ourselves: that's what the Sum column would
    // contain anyway, and the day fieldnames are stable across installations.
    const dayIdxs = [];
    let faktIdx = -1;
    let unitIdx = -1;
    let woIdx = -1;
    for (let i = 0; i < headers.length; ++i) {
      const th = headers[i];
      const df = (th.getAttribute && th.getAttribute('data-fieldname')) || '';
      // Test textContent and title separately. SUM_HEADER_RE is anchored
      // (`^…$`), so the previous `(textContent + ' ' + title)` concat broke
      // it when the Sum <th> had both: `"Sum Sum"` never matched, the Sum
      // column slipped through, and every row's hours doubled.
      const tcText = (th.textContent || '').trim();
      const titleText = (th.getAttribute('title') || '').trim();
      const isFakt = FAKT_HEADER_RE.test(tcText) || FAKT_HEADER_RE.test(titleText);
      if (woIdx < 0 && df === 'work_order') { woIdx = i; continue; }
      if (unitIdx < 0 && df === REG_UNIT_FIELD) { unitIdx = i; continue; }
      if (faktIdx < 0 && isFakt) { faktIdx = i; continue; }
      // Day columns are exactly reg_value1..reg_valueN. The aggregate Sum
      // column is the digit-less `reg_value`, so DAY_FIELD_RE excludes it
      // structurally — no dependency on the header reading "Sum"/"Summa"/"Σ",
      // which is what the old text test needed and which does not hold on a
      // localised install.
      if (DAY_FIELD_RE.test(df)) {
        dayIdxs.push(i);
      }
    }
    if (!dayIdxs.length && faktIdx < 0) return null;

    const hoursPerDay = getHoursPerDay(dayIdxs.length);

    const groups = new Map();
    let totalEffective = 0;
    let totalSum = 0;
    let totalFakt = 0;

    const rows = table.querySelectorAll('tr');
    for (const row of rows) {
      if (row === headerRow) continue;
      if (!row.classList) continue;
      if (row.classList.contains('SumItem')) continue;

      // EditRow path — find values via stable input-name patterns. The
      // static cell layout is gone when a row is in edit mode, so the
      // cellIndex-based reads below would walk past the wrong <td>s.
      let code = '';
      let name = '';
      let sumN = 0;
      let faktN = 0;
      if (row.classList.contains('EditRow')) {
        code = readEditRowDelprojCode(row);
        if (code) name = readEditRowDelprojName(row);
        // Locked-column fallback. Absence rows (SEM → FRANVAR) render
        // Delproj and Tidsenhet as plain `GridCell EditLabel` cells with NO
        // editor input, so the title-based readers above come back empty and
        // the row used to vanish from the panel while in edit mode. In this
        // build an edit row keeps a 1:1 cell↔header alignment (hidden
        // columns included, verified live: 22 cells vs 22 <th>s), so when
        // the counts line up we can trust header indexes and read the cells
        // the same way the static path does.
        const aligned = row.children.length === headers.length;
        if (!code && aligned && woIdx >= 0) {
          const woTd = row.children[woIdx];
          if (woTd && woTd.tagName === 'TD') {
            code = extractDelprojCode(woTd);
            if (code) {
              const lbl = woTd.querySelector && woTd.querySelector('.agresso-work-order-label');
              if (lbl) name = (lbl.textContent || '').trim();
            }
          }
        }
        if (!code) continue;
        const ds = readEditRowDaySum(row);
        if (Number.isFinite(ds)) sumN = ds;
        let unitText = readEditRowUnit(row);
        if (!unitText && aligned && unitIdx >= 0) {
          const unitTd = row.children[unitIdx];
          unitText = unitTd ? (unitTd.textContent || '').trim() : '';
        }
        if (DAY_UNIT_RE.test(unitText)) sumN *= hoursPerDay;
        const fk = readEditRowFakt(row);
        if (Number.isFinite(fk)) faktN = fk;
      } else {
        let workOrderTd = null;
        for (const td of row.children) {
          if (!td || td.tagName !== 'TD') continue;
          if (getCellFieldName(td) === 'work_order') { workOrderTd = td; break; }
        }
        if (!workOrderTd) continue;
        code = extractDelprojCode(workOrderTd);
        if (!code) continue;

        for (const idx of dayIdxs) {
          const cell = row.children[idx];
          if (!cell || cell.tagName !== 'TD') continue;
          const n = readCellNumber(cell);
          if (Number.isFinite(n)) sumN += n;
        }
        // Absence/vacation rows are registered in days (Tidsenhet "Dagar"),
        // so their cells hold 1.00 per day, not an hour count. Agresso's own
        // footer converts them before totalling — a 5-day vacation week shows
        // 40.00 there. Without this the panel reported 5.00 under a "Timmar"
        // heading, off by the working-day length.
        if (unitIdx >= 0) {
          const unitCell = row.children[unitIdx];
          const unitText = unitCell ? (unitCell.textContent || '').trim() : '';
          if (DAY_UNIT_RE.test(unitText)) sumN *= hoursPerDay;
        }

        const faktCell = faktIdx >= 0 ? row.children[faktIdx] : null;
        const faktVal = faktCell ? readCellNumber(faktCell) : NaN;
        faktN = Number.isFinite(faktVal) ? faktVal : 0;

        // Static-row name: prefer the project label paragraph we already
        // injected for show_project_label, fall back to title attribute.
        const nameNode = workOrderTd.querySelector ? workOrderTd.querySelector('.agresso-work-order-label') : null;
        name = nameNode ? (nameNode.textContent || '').trim() : '';
        if (!name) {
          const title = workOrderTd.getAttribute && workOrderTd.getAttribute('title');
          name = title ? extractProjectDescription(title) : '';
        }
      }
      const effective = Math.max(sumN, faktN);
      if (effective <= 0) continue;

      let g = groups.get(code);
      if (!g) {
        g = { code, name, effective: 0, sum: 0, fakt: 0, rows: 0 };
        groups.set(code, g);
      } else if (!g.name && name) {
        g.name = name;
      }
      g.effective += effective;
      g.sum += sumN;
      g.fakt += faktN;
      g.rows += 1;
      totalEffective += effective;
      totalSum += sumN;
      totalFakt += faktN;
    }

    const list = Array.from(groups.values()).sort((a, b) => {
      if (b.effective !== a.effective) return b.effective - a.effective;
      return a.code.localeCompare(b.code);
    });
    return { list, totalEffective, totalSum, totalFakt };
  }

  function renderDelprojSummary(panel, data) {
    if (!panel || !data) return;
    const tbody = panel.querySelector('tbody');
    const totalEl = panel.querySelector('[data-total]');
    const table = panel.querySelector('.pragresso-delproj-table');
    if (!tbody || !table) return;

    tbody.innerHTML = '';
    if (!data.list.length) {
      const tr = document.createElement('tr');
      tr.className = 'pragresso-delproj-empty';
      tr.innerHTML = '<td colspan="3">Inga delprojekt med tid registrerad.</td>';
      tbody.appendChild(tr);
    } else {
      for (const g of data.list) {
        const tr = document.createElement('tr');
        const codeCell = document.createElement('td');
        codeCell.className = 'code';
        const codeSpan = document.createElement('span');
        codeSpan.className = 'pragresso-delproj-code';
        codeSpan.textContent = g.code;
        codeCell.appendChild(codeSpan);
        if (g.name) {
          const nameSpan = document.createElement('span');
          nameSpan.className = 'pragresso-delproj-name';
          nameSpan.textContent = g.name;
          codeCell.appendChild(nameSpan);
        }
        const hoursCell = document.createElement('td');
        hoursCell.className = 'num';
        hoursCell.textContent = g.effective.toFixed(2);
        const underlagCell = document.createElement('td');
        underlagCell.className = 'num small';
        underlagCell.textContent = `S ${g.sum.toFixed(2)} / F ${g.fakt.toFixed(2)}`;
        tr.appendChild(codeCell);
        tr.appendChild(hoursCell);
        tr.appendChild(underlagCell);
        tbody.appendChild(tr);
      }
    }

    // Footer total row. Mirrors the per-group columns so users can read off
    // the grand total without scrolling back up to the panel header. Header
    // also keeps its `Σ N.NN h` chip so the total is visible even when the
    // panel is collapsed.
    let tfoot = table.querySelector('tfoot');
    if (!tfoot) {
      tfoot = document.createElement('tfoot');
      table.appendChild(tfoot);
    }
    tfoot.innerHTML = '';
    if (data.list.length) {
      const tr = document.createElement('tr');
      tr.className = 'pragresso-delproj-total-row';
      const labelCell = document.createElement('td');
      labelCell.className = 'code';
      labelCell.textContent = 'Totalt';
      const hoursCell = document.createElement('td');
      hoursCell.className = 'num';
      hoursCell.textContent = data.totalEffective.toFixed(2);
      const underlagCell = document.createElement('td');
      underlagCell.className = 'num small';
      underlagCell.textContent = `S ${data.totalSum.toFixed(2)} / F ${data.totalFakt.toFixed(2)}`;
      tr.appendChild(labelCell);
      tr.appendChild(hoursCell);
      tr.appendChild(underlagCell);
      tfoot.appendChild(tr);
    }

    if (totalEl) {
      totalEl.textContent = `Σ ${data.totalEffective.toFixed(2)} h`;
    }
  }

  function applyDelprojSummary() {
    try {
      if (settings.show_delproj_summary === false) {
        removeDelprojSummary();
        return;
      }
      const data = recomputeDelprojSummary();
      if (!data) {
        // No timesheet grid on this page — drop any stale panel.
        removeDelprojSummary();
        return;
      }
      const panel = ensureDelprojPanel();
      if (!panel) return;
      renderDelprojSummary(panel, data);
    } catch (e) { /* ignore */ }
  }

  function scheduleDelprojSummary() {
    if (delprojSummaryRafScheduled) return;
    delprojSummaryRafScheduled = true;
    const run = () => {
      delprojSummaryRafScheduled = false;
      withStableViewport(applyDelprojSummary);
    };
    try { requestAnimationFrame(run); } catch (e) { setTimeout(run, 16); }
  }

  // Hydrate collapsed state from storage as early as possible so the first
  // render doesn't flash open if the user previously collapsed it.
  try {
    if (chrome && chrome.storage && chrome.storage.local && chrome.storage.local.get) {
      chrome.storage.local.get([DELPROJ_COLLAPSED_KEY]).then((res) => {
        delprojSummaryCollapsed = !!(res && res[DELPROJ_COLLAPSED_KEY]);
        const panel = document.getElementById(DELPROJ_PANEL_ID);
        if (panel) applyDelprojCollapsedState(panel);
      }).catch(() => {});
    }
  } catch (e) {}

  // ─────────────────────────────────────────────────────────────────────
  // Semester (vacation-day) summary — injected under the "Saldo för en
  // resurs" table on the Lönespecifikation page. Totals the user's available
  // vacation days: every "Sparade dagar år N" row plus "Årets betalda
  // semesterdagar". The headline figure is the Restbelopp (remaining) total —
  // how many days are still available — and the Ursprungligt belopp (original)
  // total rides alongside for reference.
  // ─────────────────────────────────────────────────────────────────────
  const SEMESTER_PANEL_ID = 'pragresso-semester-summary';
  const SEMESTER_COLLAPSED_KEY = 'pragresso_semester_collapsed';
  let semesterSummaryRafScheduled = false;
  let semesterSummaryCollapsed = false;
  // Rows that count toward the vacation-day total, matched on the trimmed
  // Beskrivning text. Anchored at the start so "Obetalda semesterdagar"
  // (unpaid) is excluded — it is neither "Sparade dagar" nor "Årets betalda
  // semesterdagar".
  // Anchored at the start so "Obetalda semesterdagar" (unpaid) stays excluded.
  // English variants included alongside the Swedish ones — the rest of the
  // extension carries an sv/en switch, and the surrounding column detection is
  // already locale-independent, so matching only Swedish row labels left the
  // panel silently empty on an English-localised install.
  const SEMESTER_ROW_RE = /^(sparade dagar år\b|årets betalda semesterdagar\b|saved days year\b|paid holidays this year\b|paid holiday days this year\b)/i;
  const SALDO_DESC_RE = /beskrivning|description/i;
  const SALDO_URSPRUNG_RE = /ursprungligt|original amount/i;
  const SALDO_REST_RE = /restbelopp|remaining amount|remaining balance/i;

  // Days read cleaner as plain integers; keep decimals only when present.
  function fmtDays(n) {
    if (!Number.isFinite(n)) return '0';
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function findSaldoTable() {
    // Identify the Saldo table by its column headers rather than the section
    // title: the "Ursprungligt belopp" + "Restbelopp" labels are stable,
    // whereas section-title text varies by install/locale.
    try {
      const tables = document.querySelectorAll('table');
      for (const table of tables) {
        const ths = table.querySelectorAll('th');
        if (!ths.length) continue;
        let hasRest = false;
        let hasUrsprung = false;
        for (const th of ths) {
          const t = (th.textContent || '').trim();
          if (SALDO_REST_RE.test(t)) hasRest = true;
          if (SALDO_URSPRUNG_RE.test(t)) hasUrsprung = true;
        }
        if (hasRest && hasUrsprung) return table;
      }
    } catch (e) {}
    return null;
  }

  function recomputeSemesterSummary(table) {
    if (!table) return null;
    const headerRow = table.querySelector('tr');
    if (!headerRow) return null;
    const headers = headerRow.querySelectorAll('th');
    let descIdx = -1;
    let ursprungIdx = -1;
    let restIdx = -1;
    for (let i = 0; i < headers.length; ++i) {
      const t = (headers[i].textContent || '').trim();
      if (descIdx < 0 && SALDO_DESC_RE.test(t)) descIdx = i;
      if (ursprungIdx < 0 && SALDO_URSPRUNG_RE.test(t)) ursprungIdx = i;
      if (restIdx < 0 && SALDO_REST_RE.test(t)) restIdx = i;
    }
    if (restIdx < 0) return null;
    if (descIdx < 0) descIdx = 0;

    const list = [];
    let totalUrsprung = 0;
    let totalRest = 0;
    const rows = table.querySelectorAll('tr');
    for (const row of rows) {
      if (row === headerRow) continue;
      const cells = row.children;
      if (!cells || cells.length <= restIdx) continue;
      const descCell = cells[descIdx];
      if (!descCell) continue;
      const label = (descCell.textContent || '').trim();
      if (!SEMESTER_ROW_RE.test(label)) continue;
      const rest = readCellNumber(cells[restIdx]);
      const ursprung = ursprungIdx >= 0 ? readCellNumber(cells[ursprungIdx]) : NaN;
      const restN = Number.isFinite(rest) ? rest : 0;
      const ursprungN = Number.isFinite(ursprung) ? ursprung : 0;
      list.push({ label, rest: restN, ursprung: ursprungN });
      totalRest += restN;
      totalUrsprung += ursprungN;
    }
    if (!list.length) return null;
    return { list, totalRest, totalUrsprung, hasUrsprung: ursprungIdx >= 0 };
  }

  // Find the smallest heading-ish element whose text matches `re`. Used to
  // locate section titles on the Lönespecifikation page, which (unlike the
  // timesheet) does NOT wrap sections in `u4-section-placeholder`.
  function findHeadingByText(re) {
    let best = null;
    let bestLen = Infinity;
    try {
      const sel = 'h1,h2,h3,h4,legend,.SectionTitle';
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.textContent || '').trim();
        if (t && re.test(t) && t.length < bestLen) { best = el; bestLen = t.length; }
      }
    } catch (e) {}
    return best;
  }

  // Resolve the node the panel should sit immediately AFTER: the outermost
  // block that contains the "Saldo för en resurs" section but NOT the
  // following "Information om lönespecifikation" section. Inserting after it
  // drops the panel between the two sections — directly under the Saldo table
  // and aligned with the section column. Returns null if the headings can't
  // be found, in which case ensureSemesterPanel falls back to the table.
  function findSemesterAnchorNode() {
    const saldo = findHeadingByText(/saldo för en resurs/i);
    if (!saldo) return null;
    const info = findHeadingByText(/information om lönespecifikation/i);
    if (!info) return null;
    let node = saldo;
    for (let i = 0; i < 15 && node.parentElement && node.parentElement !== document.body; ++i) {
      const parent = node.parentElement;
      // Stop before climbing into an ancestor that also spans the next
      // section — `node` then is the Saldo block, a sibling of the Info block.
      if (parent.contains(info)) break;
      node = parent;
    }
    // Guard: never return a node that itself encloses the Info section.
    if (node.contains && node.contains(info)) return null;
    return node;
  }

  function placeSemesterPanel(panel, table) {
    const anchor = findSemesterAnchorNode();
    if (anchor && anchor.parentNode) {
      if (anchor.nextSibling !== panel) {
        try { anchor.parentNode.insertBefore(panel, anchor.nextSibling); } catch (e) {}
      }
      return true;
    }
    // Fallback: directly after the Saldo table element.
    if (table && table.parentNode) {
      if (table.nextSibling !== panel) {
        try { table.parentNode.insertBefore(panel, table.nextSibling); } catch (e) {}
      }
      return true;
    }
    return false;
  }

  function ensureSemesterPanel(table) {
    let panel = document.getElementById(SEMESTER_PANEL_ID);
    if (panel) {
      // Re-seat between the Saldo and Information sections. After a postback
      // Agresso re-renders and the panel can drift; idempotent in place.
      placeSemesterPanel(panel, table);
      return panel;
    }
    panel = document.createElement('section');
    panel.id = SEMESTER_PANEL_ID;
    panel.className = 'pragresso-sem-panel';
    panel.innerHTML =
      '<header class="pragresso-sem-header">' +
        '<button type="button" class="pragresso-sem-toggle" aria-expanded="true" title="Visa/dölj"></button>' +
        '<span class="pragresso-sem-title">Totalt antal semesterdagar</span>' +
        '<span class="pragresso-sem-total" data-total></span>' +
      '</header>' +
      '<div class="pragresso-sem-body">' +
        '<table class="pragresso-sem-table">' +
          '<thead><tr><th>Beskrivning</th><th class="num small">Ursprungligt</th><th class="num">Återstående</th></tr></thead>' +
          '<tbody></tbody>' +
        '</table>' +
      '</div>';
    if (!placeSemesterPanel(panel, table)) {
      const host = document.body || document.documentElement;
      if (!host) return null;
      host.appendChild(panel);
    }

    const toggleBtn = panel.querySelector('.pragresso-sem-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        semesterSummaryCollapsed = !semesterSummaryCollapsed;
        applySemesterCollapsedState(panel);
        try {
          if (chrome && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ [SEMESTER_COLLAPSED_KEY]: semesterSummaryCollapsed });
          }
        } catch (e) {}
      });
    }
    applySemesterCollapsedState(panel);
    return panel;
  }

  function applySemesterCollapsedState(panel) {
    if (!panel) return;
    panel.classList.toggle('collapsed', !!semesterSummaryCollapsed);
    const btn = panel.querySelector('.pragresso-sem-toggle');
    if (btn) {
      btn.setAttribute('aria-expanded', semesterSummaryCollapsed ? 'false' : 'true');
    }
  }

  function removeSemesterSummary() {
    const panel = document.getElementById(SEMESTER_PANEL_ID);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
  }

  function renderSemesterSummary(panel, data) {
    if (!panel || !data) return;
    const tbody = panel.querySelector('tbody');
    const totalEl = panel.querySelector('[data-total]');
    const table = panel.querySelector('.pragresso-sem-table');
    if (!tbody || !table) return;

    tbody.innerHTML = '';
    for (const g of data.list) {
      const tr = document.createElement('tr');
      const labelCell = document.createElement('td');
      labelCell.className = 'label';
      labelCell.textContent = g.label;
      const ursprungCell = document.createElement('td');
      ursprungCell.className = 'num small';
      ursprungCell.textContent = data.hasUrsprung ? fmtDays(g.ursprung) : '';
      const restCell = document.createElement('td');
      restCell.className = 'num';
      restCell.textContent = fmtDays(g.rest);
      tr.appendChild(labelCell);
      tr.appendChild(ursprungCell);
      tr.appendChild(restCell);
      tbody.appendChild(tr);
    }

    // Footer grand-total row, mirroring the per-row columns. The header chip
    // keeps the same total so it stays visible when the panel is collapsed.
    let tfoot = table.querySelector('tfoot');
    if (!tfoot) {
      tfoot = document.createElement('tfoot');
      table.appendChild(tfoot);
    }
    tfoot.innerHTML = '';
    const tr = document.createElement('tr');
    tr.className = 'pragresso-sem-total-row';
    const labelCell = document.createElement('td');
    labelCell.className = 'label';
    labelCell.textContent = 'Totalt';
    const ursprungCell = document.createElement('td');
    ursprungCell.className = 'num small';
    ursprungCell.textContent = data.hasUrsprung ? fmtDays(data.totalUrsprung) : '';
    const restCell = document.createElement('td');
    restCell.className = 'num';
    restCell.textContent = fmtDays(data.totalRest);
    tr.appendChild(labelCell);
    tr.appendChild(ursprungCell);
    tr.appendChild(restCell);
    tfoot.appendChild(tr);

    if (totalEl) {
      totalEl.textContent = `${fmtDays(data.totalRest)} dagar`;
    }
  }

  function applySemesterSummary() {
    try {
      if (settings.show_semester_summary === false) {
        removeSemesterSummary();
        return;
      }
      const table = findSaldoTable();
      const data = table ? recomputeSemesterSummary(table) : null;
      if (!data) {
        // Not on a page with a Saldo table — drop any stale panel.
        removeSemesterSummary();
        return;
      }
      const panel = ensureSemesterPanel(table);
      if (!panel) return;
      renderSemesterSummary(panel, data);
    } catch (e) { /* ignore */ }
  }

  function scheduleSemesterSummary() {
    if (semesterSummaryRafScheduled) return;
    semesterSummaryRafScheduled = true;
    const run = () => {
      semesterSummaryRafScheduled = false;
      withStableViewport(applySemesterSummary);
    };
    try { requestAnimationFrame(run); } catch (e) { setTimeout(run, 16); }
  }

  // Hydrate the semester panel's collapsed state from storage early so the
  // first render doesn't flash open if the user previously collapsed it.
  try {
    if (chrome && chrome.storage && chrome.storage.local && chrome.storage.local.get) {
      chrome.storage.local.get([SEMESTER_COLLAPSED_KEY]).then((res) => {
        semesterSummaryCollapsed = !!(res && res[SEMESTER_COLLAPSED_KEY]);
        const panel = document.getElementById(SEMESTER_PANEL_ID);
        if (panel) applySemesterCollapsedState(panel);
      }).catch(() => {});
    }
  } catch (e) {}

  // Collapse the native Arbetstimmar section once per page load when the
  // user opted into it. Agresso wires its collapse handler on a small icon
  // inside the section header (typically a `<span>` with onclick), NOT on
  // the legend element itself — clicking the legend text alone is a no-op.
  // We therefore look for a clickable element near the heading whose
  // onclick handler hints at toggling, and dispatch a click on it.
  let arbetstimmarDefaultCollapseApplied = false;
  function findSectionToggleTarget(section, heading) {
    if (!section) return null;
    // 1. Onclick-bearing element whose handler text mentions a toggle.
    try {
      const onclickEls = section.querySelectorAll('[onclick]');
      for (const el of onclickEls) {
        if (el === heading) continue;
        const oc = el.getAttribute('onclick') || '';
        if (/toggle|collapse|expand|hide|show|minimi|maximi/i.test(oc)) return el;
      }
      if (onclickEls.length) return onclickEls[0]; // best guess: first interactive child
    } catch (e) {}
    // 2. Anchor / button child.
    try {
      const a = section.querySelector('a, button');
      if (a) return a;
    } catch (e) {}
    return null;
  }

  function applyArbetstimmarDefaultCollapse() {
    if (arbetstimmarDefaultCollapseApplied) return;
    if (settings.arbetstimmar_collapsed_default !== true) return;
    const heading = Array.from(document.querySelectorAll('legend,h1,h2,h3,h4,div,span,th,caption'))
      .find((el) => /^Arbetstimmar$/i.test((el.textContent || '').trim()));
    if (!heading) return; // Section not yet in DOM — observer will retry.

    let section = heading;
    for (let i = 0; i < 8 && section && section.parentElement; ++i) {
      section = section.parentElement;
      if (section.tagName === 'FIELDSET' || section.tagName === 'SECTION') break;
    }

    // If a content table is already height:0 the section is already
    // collapsed — don't click or we'd re-expand it.
    let visible = false;
    if (section && section.querySelectorAll) {
      const candidates = section.querySelectorAll('table, .DataListBlue, .ExcelGrid');
      for (const c of candidates) {
        if (heading.contains(c)) continue;
        const rect = c.getBoundingClientRect && c.getBoundingClientRect();
        if (rect && rect.height > 0) { visible = true; break; }
      }
    }

    if (visible) {
      const target = findSectionToggleTarget(section, heading) || heading;
      try { target.click(); } catch (e) {}
      // Some Agresso section toggles only respond to a real mouse-event
      // sequence rather than the synthetic .click() above. Dispatch one as
      // a fallback so older grid layouts also collapse.
      try {
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        target.dispatchEvent(ev);
      } catch (e) {}
    }
    arbetstimmarDefaultCollapseApplied = true;
  }

  // Hide the stray hidden-column editor cells that the CSS hide sheet can't
  // reach on absence rows.
  //
  // Background: `applyColumnHideSheet` hides the Bereds. (ace_code) and
  // Arb.typ (work_type) columns. For edit rows it matches the editor cell
  // via `tr.EditRow td:has(input[title="Bereds."/"Arb.typ"])` (the 1.2.16
  // fix). But on an absence row (Tidsenhet "Dagar") work_type isn't
  // editable, so Agresso renders it as an EMPTY `EditLabel` cell with NO
  // <input> — the `:has(input[title=...])` selector never matches it. The
  // header's work_type column is `display:none`, so that stray ~76px cell
  // becomes the only thing defining the column's width and it shoves
  // Tidsenhet + every day column one slot to the right (the exact "Timmar"
  // drift, back again on Dagar rows). Normal "Timmar" rows hid the symptom
  // because the cell carries a titled input the CSS already catches.
  //
  // Fix the same way 1.2.16 did — remove the stray cell — but reach it
  // structurally: anchor on the reg_value1 day editor (its input name is
  // stable across units/row types) and walk left to Tidsenhet, then
  // Arb.typ, then Bereds.
  function hideEditRowHiddenColumnCells() {
    if (!settings.hide_work_type && !settings.hide_ace_code) return;
    try {
      getAllDocuments().forEach((doc) => {
        if (!doc.querySelectorAll) return;
        doc.querySelectorAll('tr.EditRow').forEach((row) => {
          const dayInput = row.querySelector('input[name*="$reg_value1$"]');
          const dayCell = dayInput && dayInput.closest('td');
          if (!dayCell) return;
          const unitCell = dayCell.previousElementSibling;          // Tidsenhet — keep visible
          const workTypeCell = unitCell && unitCell.previousElementSibling;   // Arb.typ
          const aceCodeCell = workTypeCell && workTypeCell.previousElementSibling; // Bereds.
          // Only hide a cell that is genuinely the hidden column's editor
          // (titled input) or an empty placeholder label — never a real
          // populated field, so an unexpected layout can't lose data.
          const hideStray = (cell, title) => {
            if (!cell) return;
            const inp = cell.querySelector('input, select, textarea');
            const ok = !inp
              || (inp.getAttribute('title') || '') === title
              || !(cell.textContent || '').trim();
            if (ok) cell.style.setProperty('display', 'none', 'important');
          };
          if (settings.hide_work_type) hideStray(workTypeCell, 'Arb.typ');
          if (settings.hide_ace_code) hideStray(aceCodeCell, 'Bereds.');
        });
      });
    } catch (e) { /* ignore */ }
  }

  // ── Sticky edit values (Beskrivningstext + hours) ──────────────────────
  // Problem this solves: you want to write the description and punch the
  // hours NOW, and fill in Delproj / Aktivitet later once you know them.
  // Agresso makes that impossible. Picking a Delproj or an Aktivitet fires
  // a full postback that REPLACES the whole grid document, and the server
  // re-renders Beskrivningstext from the picked entity's default text —
  // project name for Delproj, activity name for Aktivitet. Anything you
  // typed is gone. Verified against the live grid: typing "TEST FOR CLAUDE"
  // then switching Aktivitet UTB → ITS came back as "IT-Strategi".
  //
  // Fix: remember what the USER typed, then write it back into the freshly
  // rendered row after every postback.
  //
  // State lives in sessionStorage, not a module variable, because the
  // postback swaps the grid document out from under us — every module-level
  // `let` in this file is re-initialised on the other side. sessionStorage
  // is per-tab, same-origin across the frame nest, and dies with the tab.
  const STICKY_KEY = 'pragresso_sticky_edit_v1';
  // Entries are scoped to an editing session, not a workday. Six hours is
  // long enough to survive a lunch break with a row left open and short
  // enough that a forgotten entry can't haunt tomorrow.
  const STICKY_TTL_MS = 6 * 60 * 60 * 1000;
  // How long a stored row must be absent from edit mode before we forget
  // it. Must comfortably exceed a postback's dead window (~300ms) or a
  // saved-then-reopened row would lose its hold mid-flight.
  const STICKY_ORPHAN_MS = 5000;
  const STICKY_MARK = 'data-pragresso-sticky';
  const STICKY_DESC_SEL = 'input[name$="$description$i"], textarea[name$="$description$i"]';
  const STICKY_DAY_RE = /\$reg_value(\d+)\$i$/;
  // Rows seen missing since <timestamp>. In-memory on purpose: a postback
  // wipes it, which just restarts the grace period — the failure mode is
  // "forgets a little later", never "forgets a value the user still wants".
  const stickyMissingSince = new Map();

  // Editor inputs are named `<prefix>$row<N>$<field>$i`; every field in a
  // row shares the `<prefix>$row<N>` head, which is how a row is addressed
  // across a postback.
  //
  // The head is NOT a row identity, though — `row<N>` is an ORDINAL, and
  // Agresso reassigns the whole numbering on every render, in the grid's
  // current sort order. Verified live: after "Lägg till" the existing
  // row0..row6 came back as row1..row7, with the new row taking row0. A
  // delete pulls everything after it up the same way. So a hold recorded
  // against `row3` can, one postback later, address a completely different
  // transaction — which is exactly the bug reported from the field: delete
  // the row you had been typing in and your text reappeared in the row
  // Agresso jumped to. Everything below treats a change in the grid's shape
  // as "these keys are no longer trustworthy" and drops the holds.
  function stickyRowKey(el) {
    const m = /^(.*\$row\d+)\$/.exec((el && el.name) || '');
    return m ? m[1] : '';
  }

  // Count the grid's rows. Every data row carries a `<prefix>$rowN$_delete`
  // checkbox, so counting distinct row heads counts rows — the nested widget
  // markup an edit row renders inside its cells can't inflate the number the
  // way counting <tr> elements would.
  function gridRowCount(doc) {
    try {
      if (!doc || !doc.querySelector) return 0;
      // Scope to the Tidtransaktion table so an unrelated grid elsewhere on
      // the page can't move the number.
      const anchor = doc.querySelector('th[data-fieldname="description"]');
      const scope = (anchor && anchor.closest && anchor.closest('table')) || doc;
      const keys = new Set();
      scope.querySelectorAll('input[name$="$_delete"]').forEach((cb) => {
        const k = stickyRowKey(cb);
        if (k) keys.add(k);
      });
      return keys.size;
    } catch (e) {
      return 0;
    }
  }

  // Drop every hold and clear the blue-edge markers. Called the moment the
  // user does something that renumbers rows, i.e. before the postback rather
  // than trying to guess the new numbering on the other side of it.
  function releaseStickyHolds(reason) {
    try {
      const store = readStickyStore();
      if (!Object.keys(store).length) return;
      logDebug('sticky: releasing holds —', reason);
      writeStickyStore(null);
      stickyMissingSince.clear();
      getAllDocuments().forEach((doc) => {
        if (!doc.querySelectorAll) return;
        doc.querySelectorAll(`[${STICKY_MARK}]`).forEach((el) => el.removeAttribute(STICKY_MARK));
      });
    } catch (e) { /* ignore */ }
  }

  function readStickyStore() {
    let obj;
    try {
      const raw = sessionStorage.getItem(STICKY_KEY);
      if (!raw) return {};
      obj = JSON.parse(raw);
    } catch (e) {
      return {};
    }
    if (!obj || typeof obj !== 'object') return {};
    const now = Date.now();
    let pruned = false;
    for (const k of Object.keys(obj)) {
      const e = obj[k];
      if (!e || typeof e !== 'object' || !(now - (e.ts || 0) < STICKY_TTL_MS)) {
        delete obj[k];
        pruned = true;
      }
    }
    if (pruned) writeStickyStore(obj);
    return obj;
  }

  function writeStickyStore(obj) {
    try {
      if (!obj || !Object.keys(obj).length) sessionStorage.removeItem(STICKY_KEY);
      else sessionStorage.setItem(STICKY_KEY, JSON.stringify(obj));
    } catch (e) { /* private mode / quota — feature degrades to off */ }
  }

  // Write a value back into a re-rendered editor.
  //
  // Deliberately does NOT dispatch input/change: Agresso binds its own
  // onchange to these editors and a synthetic one re-triggers the very
  // postback we are recovering from — an endless re-render loop. Plain
  // `.value` is enough, because form serialisation reads the property, so
  // the restored text posts on the next real submit either way.
  //
  // The hidden `<field>$IsDirty` sibling is Agresso's own "user touched
  // this" marker; flipping it makes the server treat the value as an edit
  // rather than as the stale default it just sent us.
  function setStickyValue(el, value) {
    try {
      if (el.disabled) return false;
      if (el.value === value) return false;
      el.value = value;
      const row = el.closest('tr');
      const dirty = row && row.querySelector(`input[name="${el.name.replace(/\$i$/, '$IsDirty')}"]`);
      if (dirty && dirty.value !== 'true') dirty.value = 'true';
      if (row) row.dataset.agressoDirty = '1';
      return true;
    } catch (e) {
      return false;
    }
  }

  // Record what the user types. Bound once, capture phase, at the document
  // root so it survives Agresso's DOM churn without per-row rebinding.
  let _stickyCaptureInstalled = false;
  function installStickyCapture() {
    if (_stickyCaptureInstalled) return;
    _stickyCaptureInstalled = true;

    const onEdit = (ev) => {
      if (settings.sticky_edit_values === false) return;
      // isTrusted gates out our own restore writes and any Agresso-
      // dispatched synthetic event, so the store only ever holds text a
      // human actually typed. Without this the server's default text would
      // capture itself and the feature would pin the wrong string.
      if (!ev || !ev.isTrusted) return;
      const el = ev.target;
      if (!el || !el.name || !el.closest || !el.closest('tr.EditRow')) return;
      const key = stickyRowKey(el);
      if (!key) return;

      const isDesc = /\$description\$i$/.test(el.name);
      const dayMatch = STICKY_DAY_RE.exec(el.name);
      if (!isDesc && !dayMatch) return;

      const store = readStickyStore();
      const entry = store[key] || (store[key] = { desc: null, days: {} });
      if (!entry.days) entry.days = {};
      entry.ts = Date.now();
      // Anchor the hold to the grid as it looks right now. Row names are
      // ordinals (see stickyRowKey), so a row count that no longer matches
      // means the key may address a different row entirely.
      entry.rows = gridRowCount(el.ownerDocument || document);

      if (isDesc) {
        const v = el.value || '';
        // Emptying the field is the release gesture: clear it and the next
        // Aktivitet change is free to drop its default text in again.
        entry.desc = v.trim() ? v : null;
      } else {
        const v = (el.value || '').trim();
        const n = parseAgressoNum(v);
        // Only positive day values are held. Zeroing a cell means the user
        // wants it empty, so drop the hold instead of restoring it forever.
        if (Number.isFinite(n) && n > 0) entry.days[dayMatch[1]] = v;
        else delete entry.days[dayMatch[1]];
      }

      if (entry.desc == null && !Object.keys(entry.days).length) delete store[key];
      writeStickyStore(store);
    };

    try {
      document.addEventListener('input', onEdit, true);
      document.addEventListener('change', onEdit, true);
    } catch (e) { /* ignore */ }
  }

  function applyStickyEditValues() {
    if (settings.sticky_edit_values === false) {
      // Turning the option off mid-session should release every hold
      // immediately, not on the next postback.
      try {
        getAllDocuments().forEach((doc) => {
          if (!doc.querySelectorAll) return;
          doc.querySelectorAll(`[${STICKY_MARK}]`).forEach((el) => el.removeAttribute(STICKY_MARK));
        });
      } catch (e) {}
      stickyMissingSince.clear();
      writeStickyStore(null);
      return;
    }

    const store = readStickyStore();
    if (!Object.keys(store).length) {
      stickyMissingSince.clear();
      return;
    }

    const seen = new Set();
    let gridPresent = false;
    let dropped = false;

    try {
      getAllDocuments().forEach((doc) => {
        if (!doc.querySelectorAll) return;
        if (!doc.querySelector('th[data-fieldname="description"]')) return;
        gridPresent = true;

        // Wait for the grid to be fully in the DOM before trusting its shape
        // or writing anything back. A postback replaces the whole document
        // and the parser appends rows one at a time, so a pass landing
        // mid-parse would under-count the rows (and drop a hold that is
        // perfectly valid). The footer row is emitted after the last data
        // row, and readyState leaves 'loading' once the parse ends — either
        // one means the grid is all there. Skipping costs nothing: the
        // mutation burst that follows brings us straight back.
        if (doc.readyState === 'loading' && !doc.querySelector('tr.SumItem')) return;

        // Rows were added or removed since the hold was taken, so every row
        // ordinal below the change has shifted and no stored key can be
        // trusted to still name the row the user typed into. Forget them —
        // writing the text back into whatever row inherited the number is
        // how the held text ended up in a stranger's row.
        const rowCount = gridRowCount(doc);
        if (rowCount) {
          for (const key of Object.keys(store)) {
            const stale = store[key];
            if (stale && stale.rows && stale.rows !== rowCount) {
              delete store[key];
              dropped = true;
            }
          }
        }

        doc.querySelectorAll('tr.EditRow').forEach((row) => {
          const descEl = row.querySelector(STICKY_DESC_SEL);
          const anyNamed = descEl || row.querySelector('input[name*="$row"]');
          const key = stickyRowKey(anyNamed);
          if (!key) return;
          seen.add(key);

          const entry = store[key];
          if (!entry) {
            if (descEl) descEl.removeAttribute(STICKY_MARK);
            return;
          }

          if (entry.desc != null && descEl) {
            setStickyValue(descEl, entry.desc);
            descEl.setAttribute(STICKY_MARK, '1');
          } else if (descEl) {
            descEl.removeAttribute(STICKY_MARK);
          }

          for (const [idx, val] of Object.entries(entry.days || {})) {
            const inp = row.querySelector(`input[name$="$reg_value${idx}$i"]`);
            if (!inp) continue;
            // Restore only into a cell the postback blanked or zeroed.
            // A non-zero value already in the cell is the server's own
            // arithmetic (a Dagar→timmar conversion, say) and outranks
            // our snapshot — fighting it would corrupt absence rows.
            const cur = parseAgressoNum(inp.value);
            if (Number.isFinite(cur) && cur !== 0) continue;
            if (setStickyValue(inp, val)) inp.setAttribute(STICKY_MARK, '1');
          }
        });
      });
    } catch (e) { /* ignore */ }

    // Forget rows that have left edit mode (saved, deleted, or cancelled).
    // Gated on actually having found the grid, so a page without one — the
    // Lönespecifikation view, a dialog frame — can never clear the store.
    if (!gridPresent) {
      if (dropped) writeStickyStore(store);
      return;
    }
    const now = Date.now();
    for (const key of Object.keys(store)) {
      if (seen.has(key)) {
        stickyMissingSince.delete(key);
        continue;
      }
      const since = stickyMissingSince.get(key);
      if (!since) {
        stickyMissingSince.set(key, now);
      } else if (now - since > STICKY_ORPHAN_MS) {
        delete store[key];
        stickyMissingSince.delete(key);
        dropped = true;
      }
    }
    if (dropped) writeStickyStore(store);
  }

  // Central layout enhancer used during init and on layout refresh.
  function enhanceLayout() {
    try { applyFieldSizing(); } catch (e) {}
    try { applyColumnHideSheet(); } catch (e) {}
    try { hideEditRowHiddenColumnCells(); } catch (e) {}
    try { installStickyCapture(); } catch (e) {}
    try { applyStickyEditValues(); } catch (e) {}
    try { positionIndicatorNearSaveButton(); } catch (e) {}
    try { addProjectLabels(); } catch (e) {}
    try { applyFaktVardeSum(); } catch (e) {}
    try { scheduleDelprojSummary(); } catch (e) {}
    try { scheduleSemesterSummary(); } catch (e) {}
    try { applyArbetstimmarDefaultCollapse(); } catch (e) {}
    try { installEditRowWidthLock(); } catch (e) {}
  }

  const INDICATOR_ID = 'agresso-autosave-indicator';
  // When true, show extra debug controls (bell, debug, override/settings).
  // Toggle in code during development by setting to `true` and reloading the page.
  // You can also call `window.agresso_setIndicatorDebug(true)` in the console
  // after reloading to persist the flag for the session (no reload required).
  let INDICATOR_DEBUG = false;
  const OK_LABELS = ['ok', 'stäng', 'close', 'oké'];
  // Full phrases only. The bare 'tillbaka' / 'gå tillbaka' were removed: they
  // match ordinary "Back" buttons (e.g. inside the Utlägg draft popup), and
  // checkReturnToAppButton would auto-click them. The logout-page button reads
  // "Tillbaka till applikationen", which the full phrase still matches.
  const RETURN_TO_APP_LABELS = ['tillbaka till applikationen', 'return to application'];
  const STAY_SIGNED_IN_LABELS = ['förbli inloggad', 'håll mig inloggad', 'stanna inloggad', 'fortsätt vara inloggad', 'stay signed in', 'keep me signed in', 'remain signed in', 'stay logged in'];
  const CLOSE_SELECTORS = ['[aria-label="Close"]', '.close', '.k-i-close', '.modal-close'];
  const ACTIVITY_MESSAGE = 'agresso-autosave-activity';

  // Storage helpers. Settings live in chrome.storage.local (see loadSettings).
  // The small in-memory `settings` object is mirrored from storage and kept in
  // sync via chrome.storage.onChanged so the content script reacts live to the
  // options page without a reload.
  function getToggleEnabled() {
    return settings.autosave_enabled !== false;
  }

  function setToggleEnabled(enabled) {
    settings.autosave_enabled = !!enabled;
    try { chrome.storage.local.set({ autosave_enabled: !!enabled }); } catch (e) {}
    applyToggleState(enabled);
    // When toggled off, stop timers and prevent saves. When toggled on, resume watching.
    try {
      if (!enabled) {
        stopTimer();
        setIndicator('pending', 'Autosave disabled', 'Paused');
      } else {
        setIndicator('saved', 'Autosave ready', 'Watching for edits');
        // start idle timer anew
        try { startTimer(IDLE_TIMEOUT_MS, 'idle'); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      // ignore
    }
  }

  function applyToggleState(enabled) {
    try {
      const doc = getIndicatorDocument();
      const ind = doc.getElementById(INDICATOR_ID);
      if (ind) {
        if (!enabled) {
          ind.classList.add('agresso-disabled');
        } else {
          ind.classList.remove('agresso-disabled');
        }
        if (enabled) {
          ind.classList.add('agresso-enabled');
        } else {
          ind.classList.remove('agresso-enabled');
        }
      }
      try {
        document.documentElement.setAttribute('data-agresso-autosave-enabled', enabled ? '1' : '0');
      } catch (e) {
        // ignore
      }
    } catch (e) {
      // ignore
    }
  }

  function getIndicatorDocument() {
    // Return the document where the indicator should be injected.
    // Prefer the top-level same-origin document when available so the
    // indicator is visible even when the script runs in a frame. Do not
    // call `ensureIndicator()` here to avoid recursion.
    try {
      try {
        if (window.top && window.top.document && window.top !== window) {
          return window.top.document;
        }
      } catch (e) {
        // access to top may be cross-origin
      }
    } catch (e) {}
    return document;
  }

  function scheduleLayoutRefresh() {
    if (layoutTimer) {
      clearTimeout(layoutTimer);
    }
    layoutTimer = window.setTimeout(() => {
      layoutTimer = null;
      enhanceLayout();
    }, LAYOUT_REFRESH_MS);
  }

  function ensureIndicator() {
    const indicatorDoc = getIndicatorDocument();
    let indicator = indicatorDoc.getElementById(INDICATOR_ID);
    if (indicator) {
      return indicator;
    }

    indicator = indicatorDoc.createElement('div');
    indicator.id = INDICATOR_ID;

    // Create a small on/off toggle inside the indicator (we'll place it first)
    let toggle = null;
    try {
      toggle = indicatorDoc.createElement('button');
      toggle.className = 'agresso-toggle';
      toggle.setAttribute('type', 'button');
      toggle.setAttribute('aria-pressed', String(getToggleEnabled()));
      toggle.title = 'Toggle autosave on / off';

      const sw = indicatorDoc.createElement('span');
      sw.className = 'switch';
      const knob = indicatorDoc.createElement('span');
      knob.className = 'knob';
      sw.appendChild(knob);
      toggle.appendChild(sw);

      toggle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        const cur = getToggleEnabled();
        const next = !cur;
        setToggleEnabled(next);
        try { toggle.setAttribute('aria-pressed', String(next)); } catch (e) {}
      }, true);
    } catch (e) {
      toggle = null;
    }

    // Small reminder bell button: click toggles reminder on/off, Shift+click cycles language
    let reminderBtn = null;
    if (INDICATOR_DEBUG) {
      try {
        reminderBtn = indicatorDoc.createElement('button');
        reminderBtn.className = 'agresso-reminder-btn';
        reminderBtn.setAttribute('type', 'button');
        reminderBtn.style.marginLeft = '6px';
        reminderBtn.style.fontSize = '14px';
        reminderBtn.style.lineHeight = '1';
        reminderBtn.style.padding = '2px 6px';
        reminderBtn.style.borderRadius = '4px';
        reminderBtn.style.border = 'none';
        reminderBtn.style.background = 'transparent';
        reminderBtn.textContent = '🔔';
        reminderBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (ev.shiftKey) {
            const next = cycleReminderLang();
            updateReminderButtonState(reminderBtn);
            try { setIndicator('pending', next === 'en' ? 'Reminder (en)' : 'Påminnelse (sv)', ''); } catch (e) {}
            return;
          }
          const cur = getReminderEnabled();
          setReminderEnabled(!cur);
          updateReminderButtonState(reminderBtn);
        }, true);
      } catch (e) {
        reminderBtn = null;
      }
    }

    // Debug button to log detection report to console (avoids CSP issues)
    let debugBtn = null;
    if (INDICATOR_DEBUG) {
      try {
        debugBtn = indicatorDoc.createElement('button');
        debugBtn.className = 'agresso-debug-btn';
        debugBtn.setAttribute('type', 'button');
        debugBtn.style.marginLeft = '6px';
        debugBtn.style.fontSize = '12px';
        debugBtn.style.lineHeight = '1';
        debugBtn.style.padding = '2px 6px';
        debugBtn.style.borderRadius = '4px';
        debugBtn.style.border = 'none';
        debugBtn.style.background = 'transparent';
        debugBtn.textContent = '🐞';
        debugBtn.title = 'Debug: print period-detection report to console';
        debugBtn.addEventListener('click', (ev) => {
          ev.stopPropagation(); ev.preventDefault();
          try {
            const report = buildDebugReport();
            console.log(LOG_PREFIX, 'Period detection report', report);
          } catch (e) {
            console.error(LOG_PREFIX, 'Debug report failed', e);
          }
        }, true);
      } catch (e) {
        debugBtn = null;
      }
    }

    

    // Settings / override panel (only in debug mode)
    let settingsBtn = null;
    let settingsPanel = null;
    if (INDICATOR_DEBUG) {
      try {
        settingsBtn = indicatorDoc.createElement('button');
        settingsBtn.className = 'agresso-settings-btn';
        settingsBtn.setAttribute('type', 'button');
        settingsBtn.style.marginLeft = '6px';
        settingsBtn.style.fontSize = '12px';
        settingsBtn.style.lineHeight = '1';
        settingsBtn.style.padding = '2px 6px';
        settingsBtn.style.borderRadius = '4px';
        settingsBtn.style.border = 'none';
        settingsBtn.style.background = 'transparent';
        settingsBtn.textContent = '⚙️';
        settingsBtn.title = 'Settings: set manual period end override';

        settingsPanel = indicatorDoc.createElement('div');
        settingsPanel.className = 'agresso-settings-panel';
        settingsPanel.style.position = 'fixed';
        settingsPanel.style.zIndex = '999999';
        settingsPanel.style.padding = '8px';
        settingsPanel.style.background = '#fff';
        settingsPanel.style.border = '1px solid #ccc';
        settingsPanel.style.borderRadius = '6px';
        settingsPanel.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
        settingsPanel.style.display = 'none';
        settingsPanel.innerHTML = '<div style="font-size:12px;margin-bottom:6px;">Manual period end (YYYY-MM-DD or DD/MM):</div>';

        const inp = indicatorDoc.createElement('input');
        inp.type = 'text';
        inp.placeholder = '2026-01-11 or 11/01';
        inp.style.width = '150px';
        inp.style.marginRight = '6px';
        settingsPanel.appendChild(inp);

        const saveBtn = indicatorDoc.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.style.marginRight = '4px';
        settingsPanel.appendChild(saveBtn);

        const clearBtn = indicatorDoc.createElement('button');
        clearBtn.textContent = 'Clear';
        settingsPanel.appendChild(clearBtn);

        saveBtn.addEventListener('click', (ev) => {
          ev.stopPropagation(); ev.preventDefault();
          const v = inp.value && inp.value.trim();
          if (!v) return;
          setOverrideDate(v);
          try { setIndicator('pending', 'Override saved', v); } catch (e) {}
          // Request notification permission and trigger notification if override is today
          try {
            const parsed = parseDateFlexible(v);
            const today = new Date();
            const isToday = parsed && parsed.getFullYear && parsed.getFullYear() === today.getFullYear() && parsed.getMonth() === today.getMonth() && parsed.getDate() === today.getDate();
            if (typeof Notification !== 'undefined' && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
              Notification.requestPermission().then((perm) => {
                if (perm === 'granted' && isToday) {
                  try { showPeriodNotification(parsed); } catch (e) {}
                }
              }).catch(() => {
                if (isToday) try { setIndicator('pending', 'Sista dagen i perioden', 'Skicka in tidrapport idag'); } catch (e) {}
              });
            } else {
              if (isToday) {
                try { showPeriodNotification(parsed); } catch (e) { try { setIndicator('pending', 'Sista dagen i perioden', 'Skicka in tidrapport idag'); } catch (e2) {} }
              }
            }
          } catch (e) {
            // ignore
          }
          settingsPanel.style.display = 'none';
        }, true);

        clearBtn.addEventListener('click', (ev) => {
          ev.stopPropagation(); ev.preventDefault();
          clearOverrideDate();
          try { setIndicator('saved', 'Override cleared', ''); } catch (e) {}
          settingsPanel.style.display = 'none';
        }, true);

        settingsBtn.addEventListener('click', (ev) => {
          ev.stopPropagation(); ev.preventDefault();
          if (settingsPanel.style.display === 'none') {
            // prefill with existing override if present
            try { inp.value = settings.period_override || ''; } catch (e) { inp.value = ''; }
            const rect = settingsBtn.getBoundingClientRect();
            settingsPanel.style.left = `${Math.max(8, rect.left)}px`;
            settingsPanel.style.top = `${Math.max(8, rect.top - 80)}px`;
            settingsPanel.style.display = 'block';
          } else {
            settingsPanel.style.display = 'none';
          }
        }, true);

      } catch (e) {
        settingsBtn = null; settingsPanel = null;
      }
    }

    const dot = indicatorDoc.createElement('span');
    dot.className = 'agresso-autosave-dot';

    const label = indicatorDoc.createElement('span');
    label.className = 'agresso-autosave-label';

    const sub = indicatorDoc.createElement('span');
    sub.className = 'agresso-autosave-sub';

    // Append toggle first so it replaces the left-side dot visually
    if (toggle) indicator.appendChild(toggle);
    if (reminderBtn) indicator.appendChild(reminderBtn);
    if (debugBtn) indicator.appendChild(debugBtn);
    if (settingsBtn) indicator.appendChild(settingsBtn);
    indicator.appendChild(dot);
    indicator.appendChild(label);
    indicator.appendChild(sub);

    // Append indicator to document and apply saved toggle state
    indicatorDoc.body.appendChild(indicator);
    try { applyToggleState(getToggleEnabled()); } catch (e) {}
    try { updateReminderButtonState(reminderBtn); } catch (e) {}
    try { if (settingsPanel) indicatorDoc.body.appendChild(settingsPanel); } catch (e) {}
    return indicator;
  }

  function findPrimarySaveButton() {
    const docs = getAllDocuments();
    for (const doc of docs) {
      const candidates = Array.from(
        doc.querySelectorAll('button, input[type="button"], input[type="submit"], a')
      );
      const match = candidates.find((el) => {
        if (!isVisible(el)) {
          return false;
        }
        const text = (el.innerText || el.value || '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        return text.includes('spara') || id === 'b$tblsyssave'.toLowerCase() || title.includes('alt+s');
      });
      if (match) {
        return match;
      }
    }
    return null;
  }

  function getViewportRect(el) {
    if (!el) {
      return null;
    }

    try {
      const rect = el.getBoundingClientRect();
      let top = rect.top;
      let left = rect.left;
      let width = rect.width;
      let height = rect.height;
      let win = el.ownerDocument?.defaultView;

      while (win && win.parent && win !== win.parent) {
        const frame = win.frameElement;
        if (!frame) {
          break;
        }
        const frameRect = frame.getBoundingClientRect();
        top += frameRect.top;
        left += frameRect.left;
        win = win.parent;
      }

      return { top, left, width, height, right: left + width, bottom: top + height };
    } catch (e) {
      return null;
    }
  }

  function positionIndicatorNearSaveButton() {
    // The indicator used to be anchored to the save-button's vertical/
    // horizontal position, which caused visible jitter every time the user
    // switched between the Start panel, the menu panel and the timesheet
    // (the save button only exists on the timesheet, so the indicator kept
    // snapping between the anchored position and the CSS fallback). Now we
    // just strip any inline positioning and let styles.css keep it pinned
    // at `bottom: 20px; right: 16px` — stable across panel switches.
    try {
      const indicator = ensureIndicator();
      if (!indicator) return;
      indicator.style.removeProperty('top');
      indicator.style.removeProperty('bottom');
      indicator.style.removeProperty('left');
      indicator.style.removeProperty('right');
    } catch (e) { /* ignore */ }
    return;
    /* Legacy save-button-anchored positioning kept here for reference; the
       early return above bypasses it. Keeping as dead code on purpose — if
       per-layout anchoring ever becomes desirable again it can be re-enabled
       by deleting the early return. Node parses it as unreachable code but
       the syntax is still valid. */
    // eslint-disable-next-line no-unreachable
    (() => {
    const indicator = ensureIndicator();
    const doc = (indicator && indicator.ownerDocument) || document;
    let btn = null;
    try {
      for (const sel of SAVE_BUTTON_SELECTORS) {
        try {
          const el = doc.querySelector(sel);
          if (el && !el.disabled && isVisible(el)) { btn = el; break; }
        } catch (e) {}
      }
    } catch (e) {}
    if (!btn) btn = findPrimarySaveButton();
    if (!btn) {
      indicator.style.top = 'auto';
      indicator.style.bottom = '20px';
      indicator.style.right = '16px';
      indicator.style.left = 'auto';
      return;
    }
    const rect = getViewportRect(btn);
    if (!rect) {
      indicator.style.top = 'auto';
      indicator.style.bottom = '20px';
      indicator.style.right = '16px';
      indicator.style.left = 'auto';
      return;
    }
    const indHeight = indicator.offsetHeight || 34;
    const indWidth = indicator.offsetWidth || 180;
    const top = rect.top + (rect.height - indHeight) / 2;
    const viewportWidth = (doc.defaultView && doc.defaultView.innerWidth) || window.innerWidth || 0;
    const viewportHeight = (doc.defaultView && doc.defaultView.innerHeight) || window.innerHeight || 0;

    // Anchor vertically aligned with the save button, but place the indicator
    // on the right side of the page (inside the main content area if possible).
    try {
      const clampedTop = Math.max(8, Math.min(top, Math.max(8, viewportHeight - indHeight - 8)));
      // find a suitable content container to anchor inside
      let rightPos = 16; // default distance from viewport right edge
      try {
        const contentSelectors = ['main', '#content', '.container', '.page', '.u4-main', '.u4-content', '.k-grid', '.u4-body'];
        let chosen = null;
        let chosenW = 0;
        for (const sel of contentSelectors) {
          try {
            const el = doc.querySelector(sel);
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (r.width > chosenW && r.width < viewportWidth - 40) { chosen = r; chosenW = r.width; }
          } catch (e) {}
        }
        if (chosen) {
          const paddingFromContent = 12;
          const extraInset = 6; // give a few extra pixels from the content edge
          rightPos = Math.max(8, Math.min(viewportWidth - indWidth - 8, Math.round(viewportWidth - chosen.right + paddingFromContent + extraInset)));
        } else {
          // If no content container, try mirroring the save button X position
          const extraInset = 6;
            try {
              if (rect && typeof rect.left === 'number') {
                // Mirror the button's horizontal center across the viewport center
                const btnCenter = rect.left + (rect.width || 0) / 2;
                const mirroredCenter = Math.round(viewportWidth - btnCenter);
                let desiredLeft = Math.round(mirroredCenter - indWidth / 2);
                // Clamp inside viewport with small margins
                desiredLeft = Math.max(8, Math.min(viewportWidth - indWidth - 8, desiredLeft));
                // Compute a right offset so the indicator's right edge is fixed
                let rightPosFromLeft = Math.round(viewportWidth - desiredLeft - indWidth);
                // Shift a few pixels to the left so it's not flush with the border
                const mirrorExtraShift = 30;
                let rightPos = Math.max(8, Math.min(viewportWidth - indWidth - 8, rightPosFromLeft + mirrorExtraShift));
                // Position using `right` so expansion grows to the left (right edge fixed)
                indicator.style.position = 'fixed';
                indicator.style.top = `${clampedTop}px`;
                indicator.style.right = `${rightPos}px`;
                indicator.style.left = 'auto';
                indicator.style.bottom = 'auto';
                // Ensure transforms/origins anchor to the right side
                try { indicator.style.transformOrigin = 'right center'; } catch (e) {}
                return;
              } else {
                rightPos = 16 + extraInset;
              }
            } catch (e) {
              rightPos = 16 + extraInset;
            }
        }
      } catch (e) {
        rightPos = 16;
      }

      indicator.style.position = 'fixed';
      indicator.style.top = `${clampedTop}px`;
      indicator.style.right = `${rightPos}px`;
      indicator.style.left = 'auto';
      indicator.style.bottom = 'auto';
    } catch (e) {
      // fallback: bottom-right corner
      indicator.style.position = 'fixed';
      indicator.style.top = 'auto';
      indicator.style.bottom = '20px';
      indicator.style.right = '16px';
      indicator.style.left = 'auto';
    }
    })();
  }

  function bindIndicatorTracking() {
    const attach = (win) => {
      if (!win || trackedWindows.has(win)) {
        return;
      }
      trackedWindows.add(win);
      try {
        win.addEventListener('resize', positionIndicatorNearSaveButton, true);
        win.addEventListener('scroll', positionIndicatorNearSaveButton, true);
      } catch (e) {
        // ignore cross-origin listeners
      }
    };

    attach(window);
    try {
      attach(window.top);
    } catch (e) {
      // ignore cross-origin top access
    }

    getAllDocuments().forEach((doc) => {
      try {
        attach(doc.defaultView);
      } catch (e) {
        // ignore frames we cannot access
      }
    });
  }

  // Leading-edge throttle in front of markActivity.
  //
  // `mousemove` / `scroll` / `wheel` fire at pointer-poll rate, and every one
  // of them used to run the full markActivity -> startTimer -> resetTimerBar
  // chain, which performs two forced synchronous layouts (reading offsetWidth
  // and clientWidth) and restarts a CSS transition. A single 10-minute session
  // logged >5600 timer restarts, ~900 of them inside one second after a save
  // postback — roughly 1800 forced layouts in that second.
  //
  // The idle timeout is measured in seconds, so collapsing bursts to one call
  // per ACTIVITY_THROTTLE_MS is semantically invisible: the countdown starts at
  // most that much early. Dropped trailing events cost nothing because the
  // leading edge already re-armed the timer for the full duration.
  const ACTIVITY_THROTTLE_MS = 250;
  let lastActivitySignalAt = 0;
  function onActivityEvent() {
    const now = Date.now();
    if (now - lastActivitySignalAt < ACTIVITY_THROTTLE_MS) return;
    lastActivitySignalAt = now;
    markActivity();
  }

  function bindActivityListeners() {
    const attachListeners = (target) => {
      if (!target || !target.addEventListener) return;
      try {
        // Broad set of events to catch typing, clicks, touch, scroll and pointer movement
        const events = [
          'keydown',
          'keyup',
          'keypress',
          'input',
          'click',
          'pointerdown',
          'pointerup',
          'touchstart',
          'wheel',
          'scroll',
          'mousemove',
          'focusin',
          'focusout'
        ];
        events.forEach((evt) => target.addEventListener(evt, onActivityEvent, true));
      } catch (e) {
        // ignore frames we cannot access
      }
    };

    const attachDoc = (doc) => {
      if (!doc || trackedActivityDocs.has(doc)) return;
      trackedActivityDocs.add(doc);
      // Attach to the Document only. Binding the Window as well (as this did
      // until 1.5.1) double-fires every listener: in the capture phase the
      // window handler runs first, then the document handler, for the same
      // event — doubling the cost of the high-frequency events below.
      attachListeners(doc);
    };

    // Attach to all reachable documents and the main document
    getAllDocuments().forEach(attachDoc);
    attachDoc(document);
  }

  function ensureTimerBar() {
    const indicator = ensureIndicator();
    let bar = indicator.querySelector('.agresso-autosave-timer');
    if (!bar) {
      bar = indicator.ownerDocument.createElement('div');
      bar.className = 'agresso-autosave-timer';
      // Ensure the bar has sensible sizing so transform-based animation is visible
      try {
        bar.style.display = 'block';
        // initialize at 0 width so JS-driven transitions animate reliably
        bar.style.width = '0px';
        bar.style.height = '6px';
        bar.style.background = '#22c55e';
        bar.style.transformOrigin = 'left';
      } catch (e) {}
      indicator.appendChild(bar);
    }
    timerBar = bar;
    return bar;
  }

  function getTimerRemainingMs() {
    try {
      if (timerStartedAt && timerDuration) {
        const elapsed = Date.now() - timerStartedAt;
        return Math.max(800, timerDuration - elapsed);
      }
    } catch (e) {}
    return timerDuration || IDLE_TIMEOUT_MS;
  }

  // Put the projected next-save time (and current state) into the indicator's
  // title attribute so users can hover to see exactly when autosave will fire.
  function updateIndicatorTooltip(indicator, state, labelText, subText) {
    if (!indicator) return;
    try {
      const parts = [];
      if (labelText) parts.push(labelText);
      if (subText) parts.push(subText);
      if (!getToggleEnabled()) {
        parts.push(`Autosave is OFF (${IS_MAC ? 'Option' : 'Alt'}+Shift+S to toggle)`);
      } else if (state === 'saved' || state === 'pending' || state === undefined) {
        const remaining = getTimerRemainingMs();
        if (remaining && timerStartedAt) {
          const at = new Date(timerStartedAt + timerDuration);
          const hh = String(at.getHours()).padStart(2, '0');
          const mm = String(at.getMinutes()).padStart(2, '0');
          const ss = String(at.getSeconds()).padStart(2, '0');
          parts.push(`Next auto-save at ~${hh}:${mm}:${ss} (${Math.ceil(remaining / 1000)}s)`);
        }
      }
      indicator.title = parts.join('\n');
    } catch (e) { /* ignore */ }
  }

  // --- Autosave gating: timesheet-only ---
  // Autosave is only meaningful on the time-registration page ("Daglig
  // tidregistrering" / "Tidtransaktion"). Every other Agresso surface
  // (Start panel, menu tree, reports, Utlägg, admin screens, …) uses its
  // own save semantics — saves there would at best be no-ops and at worst
  // trigger validation errors.
  //
  // So: autosave is OFF by default on every page, and only arms itself once
  // we detect the timesheet grid. The user's persisted `autosave_enabled`
  // toggle is honoured on top of this: if they disable it, autosave stays
  // off on the timesheet too. All GUI enhancements (labels, dark mode,
  // column hiding, indicator, keep-alive) keep working everywhere.
  //
  // Detection signals (any one is enough):
  // Detection is DOM-only. URL-based checks false-positive because Unit4
  // keeps the top-frame URL pointing at the parent menu entry (the Utlägg
  // tab still has `menu_id=TS294` in the URL even though the timesheet
  // grid is nowhere to be seen). The `<th data-fieldname="work_order">`
  // / `reg_value*` / `reg_unit` headers are unique to the time-transaction
  // grid and only exist in the DOM when that grid is actually rendered.
  let onTimesheetPage = false;
  let timesheetPollTimer = null;

  function detectTimesheetPage() {
    try {
      const docs = getAllDocuments();
      for (const doc of docs) {
        try {
          if (!doc.querySelector) continue;
          const header =
            doc.querySelector('th[data-fieldname="work_order"]') ||
            doc.querySelector('th[data-fieldname^="reg_value"]') ||
            doc.querySelector('th[data-fieldname="reg_unit"]');
          if (header && isVisible(header)) return true;
        } catch (e) { /* cross-origin doc — skip */ }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function updateTimesheetState() {
    try {
      const now = detectTimesheetPage();
      if (now === onTimesheetPage) return;
      onTimesheetPage = now;
      const indicator = (() => { try { return ensureIndicator(); } catch (e) { return null; } })();
      if (now) {
        // Entered the timesheet — restore the indicator to reflect the
        // user's *persisted* toggle state (applyToggleState with the
        // persisted value strips `agresso-disabled` if the toggle is on
        // and arms the timer via the normal flow).
        try {
          if (indicator) indicator.classList.remove('agresso-paused');
        } catch (e) {}
        try { applyToggleState(getToggleEnabled()); } catch (e) {}
        if (getToggleEnabled()) {
          console.info(LOG_PREFIX, 'Timesheet page detected — autosave armed');
          try { setIndicator('saved', 'Autosave ready', 'Watching for edits'); } catch (e) {}
          try { startTimer(IDLE_TIMEOUT_MS, 'idle'); } catch (e) {}
        } else {
          try { setIndicator('pending', 'Autosave disabled', 'Paused'); } catch (e) {}
        }
      } else {
        console.info(LOG_PREFIX, 'Not on timesheet — autosave disabled');
        try { stopTimer(); } catch (e) {}
        try { stopTimerBar(); } catch (e) {}
        // Force the full disabled visual: grey toggle, flat timer bar, no
        // countdown. applyToggleState(false) does not touch the persisted
        // toggle — only the CSS class — so returning to the timesheet
        // restores whatever the user had configured.
        try { applyToggleState(false); } catch (e) {}
        try {
          if (indicator) {
            indicator.classList.remove('agresso-paused');
            const bar = indicator.querySelector('.agresso-autosave-timer');
            if (bar) {
              bar.style.transition = 'none';
              bar.style.width = '0px';
              bar.classList.remove('agresso-period-moving');
            }
          }
        } catch (e) {}
        try { setIndicator('pending', 'Autosave disabled', 'Not on timesheet'); } catch (e) {}
      }
    } catch (e) { /* ignore */ }
  }

  function startTimesheetPoll() {
    try { if (timesheetPollTimer) clearInterval(timesheetPollTimer); } catch (e) {}
    // Check immediately so the gating applies on a deep-link / bookmarked load.
    try { updateTimesheetState(); } catch (e) {}
    try {
      timesheetPollTimer = window.setInterval(updateTimesheetState, 2000);
    } catch (e) {}
  }

  // --- Session keep-alive ---
  // Unit4/Agresso logs a user out after ~N minutes of inactivity. The built-in
  // heartbeat (/api/session/current?renew=true) is driven by the app itself
  // and can go silent while the user is reading, attending meetings, etc.
  // This helper fires a same-origin fetch against that same endpoint on a
  // configurable interval so the server-side session stays warm. As a belt-
  // and-suspenders move we also dispatch a benign pointermove event, which
  // keeps U4's own internal heartbeat primed. Runs only in the top frame (the
  // inner <frame> will have been minimally initialised by then) and only when
  // the master autosave toggle is on — turning autosave off disables all our
  // page-mutating behaviour, keep-alive included.
  let sessionKeepAliveTimer = null;
  function sessionKeepAliveTick() {
    try {
      if (!getToggleEnabled()) return;
      if (settings.session_keepalive_enabled === false) return;
      // Build the renew URL relative to the app's own base so it works on
      // any Agresso / Unit4 Cloud deployment using the /<app>/api/... convention
      const base = (() => {
        try {
          const p = location.pathname || '/';
          const m = p.match(/^\/[^\/]+\//);
          return m ? m[0] : '/';
        } catch (e) { return '/'; }
      })();
      const url = `${location.origin}${base}api/session/current?renew=true&_=${Date.now()}`;
      fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store' })
        .then((r) => { try { logDebug('session keep-alive', r.status, url); } catch (e) {} })
        .catch((err) => { try { logDebug('session keep-alive failed (non-fatal)', err && err.message); } catch (e) {} });
      // Secondary: synthesise a benign pointermove so any idle-based client-
      // side timers Agresso runs are also reset.
      try {
        const target = document.body || document.documentElement;
        const ev = new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 0, clientY: 0, pointerType: 'mouse' });
        target && target.dispatchEvent(ev);
      } catch (e) { /* some browsers disallow synthetic PointerEvent */ }
    } catch (e) { /* ignore */ }
  }
  function scheduleSessionKeepAlive() {
    try { if (sessionKeepAliveTimer) clearInterval(sessionKeepAliveTimer); } catch (e) {}
    sessionKeepAliveTimer = null;
    if (settings.session_keepalive_enabled === false) return;
    const minutes = Math.max(1, Math.min(120, Number(settings.session_keepalive_minutes) || 5));
    const ms = minutes * 60 * 1000;
    try {
      sessionKeepAliveTimer = window.setInterval(sessionKeepAliveTick, ms);
      // Fire once shortly after load so we don't have to wait a full interval.
      window.setTimeout(sessionKeepAliveTick, 15000);
      console.info(LOG_PREFIX, 'session keep-alive scheduled every', minutes, 'min');
    } catch (e) { /* ignore */ }
  }

  // --- Save-button health check ---
  // If the indicator is visible and findPrimarySaveButton returns null for
  // longer than HEALTH_CHECK_MS, the selectors are probably stale (Agresso UI
  // changed). We log a one-time warning so the issue is easy to spot without
  // staring at the indicator.
  let saveButtonMissingSince = 0;
  let saveButtonMissingLogged = false;
  function checkSaveButtonHealth() {
    try {
      const indicator = document.getElementById(INDICATOR_ID);
      if (!indicator) return;
      const btn = findPrimarySaveButton();
      if (btn) {
        saveButtonMissingSince = 0;
        saveButtonMissingLogged = false;
        return;
      }
      const now = Date.now();
      if (!saveButtonMissingSince) saveButtonMissingSince = now;
      if (!saveButtonMissingLogged && now - saveButtonMissingSince >= HEALTH_CHECK_MS) {
        saveButtonMissingLogged = true;
        console.warn(
          LOG_PREFIX,
          `Save button not found for ${Math.floor((now - saveButtonMissingSince) / 1000)}s — ` +
          'SAVE_BUTTON_SELECTORS and findPrimarySaveButton may need updating for this Agresso build.'
        );
      }
    } catch (e) { /* ignore */ }
  }

  function resetTimerBar(durationMs) {
    const bar = ensureTimerBar();
    // If indicator is paused, keep the bar full and don't animate it
    try {
      const parentIndicator = bar.closest && bar.closest('#' + INDICATOR_ID);
      if (parentIndicator && parentIndicator.classList.contains('agresso-paused')) {
        try { bar.style.transition = 'none'; } catch (e) {}
        try { bar.style.width = '100%'; } catch (e) {}
        return;
      }
    } catch (e) {}
    // Disable any CSS animations/transforms that may conflict
    try { bar.style.animation = 'none'; } catch (e) {}
    try { bar.style.transform = 'none'; } catch (e) {}
    bar.style.transition = 'none';
    // initialize to 0px (not percent) so the pixel delta is definite
    bar.style.width = '0px';
    // force reflow
    // eslint-disable-next-line no-unused-expressions
    bar.offsetWidth;
    // Determine target width in pixels from the indicator/container so
    // percent-based computed widths don't interfere with transition.
    let targetPx = null;
    try {
      const parent = bar.parentElement || bar.ownerDocument.body;
      const pw = (parent && parent.clientWidth) || bar.offsetWidth || 0;
      targetPx = `${pw}px`;
    } catch (e) {
      targetPx = '100%';
    }
    // Use inline transition so it takes precedence and animates from 0px->targetPx
    try { bar.style.willChange = 'width'; } catch (e) {}
    bar.style.transition = `width ${durationMs}ms linear`;
    // Trigger the width change to start the animation
    bar.style.width = targetPx;
  }

  function stopTimerBar() {
    const bar = timerBar || ensureTimerBar();
    try { bar.style.animation = 'none'; } catch (e) {}
    // If indicator is paused, keep it full instead of collapsing
    try {
      const parentIndicator = bar.closest && bar.closest('#' + INDICATOR_ID);
      if (parentIndicator && parentIndicator.classList.contains('agresso-paused')) {
        try { bar.style.transition = 'none'; } catch (e) {}
        try { bar.style.width = '100%'; } catch (e) {}
        return;
      }
    } catch (e) {}
    bar.style.transition = 'none';
    bar.style.width = '0px';
  }

  // Find the Agresso "Send for approval / Skicka för godkännande / Submit"
  // ribbon button. Used by the period-end banner so the user can submit their
  // time report in one click. Matched by label/title/aria-label text so it
  // works across Swedish/English locales.
  const SUBMIT_BUTTON_LABELS = [
    'skicka för godkännande',
    'skicka till godkännande',
    'skicka in',
    'skicka',
    'send for approval',
    'submit',
    'submit for approval'
  ];
  function findSubmitButton() {
    const docs = getAllDocuments();
    for (const doc of docs) {
      try {
        const candidates = Array.from(
          doc.querySelectorAll('a[role="button"], button, input[type="submit"], input[type="button"]')
        );
        const match = candidates.find((el) => {
          if (!isVisible(el) || el.disabled) return false;
          const pieces = [
            el.getAttribute('aria-label') || '',
            el.getAttribute('title') || '',
            el.textContent || '',
            el.value || ''
          ].join(' ').toLowerCase();
          return SUBMIT_BUTTON_LABELS.some((label) => pieces.includes(label));
        });
        if (match) return match;
      } catch (e) { /* ignore cross-origin */ }
    }
    return null;
  }

  function findSaveButton() {
    const docs = getAllDocuments();
    for (const doc of docs) {
      for (const selector of SAVE_BUTTON_SELECTORS) {
        const el = doc.querySelector(selector);
        if (el && !el.disabled && isVisible(el)) {
          return el;
        }
      }
    }
    return null;
  }

  function setIndicator(state, labelText, subText) {
    const indicator = ensureIndicator();
    // Preserve whether the indicator currently has the period-end marker
    const hadPeriodMarker = indicator.classList.contains('agresso-period-end');

    indicator.classList.remove(
      'agresso-saving',
      'agresso-saved',
      'agresso-pending',
      'agresso-error'
    );
    indicator.classList.add(`agresso-${state}`);

    const label = indicator.querySelector('.agresso-autosave-label');
    const sub = indicator.querySelector('.agresso-autosave-sub');
    if (label) {
      label.textContent = labelText;
    }
    if (sub) {
      sub.textContent = subText;
    }

    // If label/subtext indicate autosave is paused, mark indicator so
    // timer-bar logic can keep the bar full and ignore activity.
    try {
      const hint = ((labelText || '') + ' ' + (subText || '')).toLowerCase();
      if (hint.indexOf('autosave paused') >= 0 || hint.indexOf('inga ändringar gjorda') >= 0 || hint.indexOf('autosave disabled') >= 0) {
        try { indicator.classList.add('agresso-paused'); } catch (e) {}
        try {
          const bar = indicator.querySelector('.agresso-autosave-timer');
          if (bar) { bar.style.transition = 'none'; bar.style.width = '100%'; }
        } catch (e) {}
      } else {
        try { indicator.classList.remove('agresso-paused'); } catch (e) {}
      }
    } catch (e) {}

    // Update the tooltip with the projected next save time so users can see
    // exactly when autosave will next fire. Updated on every state change and
    // by the timer-bar tick (see resetTimerBar).
    try { updateIndicatorTooltip(indicator, state, labelText, subText); } catch (e) {}

    positionIndicatorNearSaveButton();
    // If we just reached a saved state, clear any period-end highlight
    try {
      if (state === 'saved') {
        // Only clear the period-end reminder when the report Status is set to 'Klar'
        try {
          const isKlar = isReportStatusKlar();
          if (isKlar) {
            try { indicator.classList.remove('agresso-period-end'); } catch (e) {}
            try {
              const bar = indicator.querySelector('.agresso-autosave-timer');
              if (bar) {
                try { bar.classList.remove('agresso-period-moving'); } catch (e) {}
                bar.style.background = '#22c55e';
                bar.style.boxShadow = 'none';
              }
            } catch (e) {}
            try {
              settings.period_notify_date = null;
              chrome.storage.local.set({ period_notify_date: null });
            } catch (e) {}
            try { if (periodStatusRefreshTimer) { clearInterval(periodStatusRefreshTimer); periodStatusRefreshTimer = null; } } catch (e) {}
              try { if (periodHighlightEnforcer) { clearInterval(periodHighlightEnforcer); periodHighlightEnforcer = null; } } catch (e) {}
            try { highlightStatusField(false); } catch (e) {}
            // Remove any persistent submit banners
            try { const b = document.getElementById('agresso-period-banner'); if (b && b.parentNode) b.parentNode.removeChild(b); } catch (e) {}
            try { if (window.top && window.top.document && window.top !== window) { const bt = window.top.document.getElementById('agresso-period-banner'); if (bt && bt.parentNode) bt.parentNode.removeChild(bt); } } catch (e) {}
          } else {
            // If we were displaying the period marker before this state change,
            // reapply it unless the report is confirmed 'Klar'. This avoids the
            // page briefly removing our visual reminder during normal UI updates.
            try {
              if (hadPeriodMarker) {
                try { indicator.classList.add('agresso-period-end'); } catch (e) {}
                try {
                  const bar = indicator.querySelector('.agresso-autosave-timer');
                  if (bar) {
                    try { bar.classList.add('agresso-period-moving'); try { resetTimerBar(getTimerRemainingMs()); } catch (e2) {} } catch (e) {}
                    bar.style.background = '#d9534f';
                    bar.style.boxShadow = '0 0 6px rgba(217,83,79,0.6)';
                  }
                } catch (e) {}
                try { indicator.style.border = '2px solid rgba(217,83,79,0.9)'; } catch (e) {}
                try { indicator.style.background = 'linear-gradient(180deg, rgba(36,41,50,0.95), rgba(30,25,28,0.95))'; } catch (e) {}
              }
            } catch (e) {
              // ignore
            }
          }
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore
    }

    // If the indicator is currently marked as period-end, ensure the subtext
    // clearly instructs the user to submit the timereport.
    try {
      const subEl = indicator.querySelector('.agresso-autosave-sub');
      if (indicator.classList.contains('agresso-period-end')) {
        if (subEl) subEl.textContent = getReminderLang() === 'en' ? '- Submit time report!' : '- Skicka in tidrapporten!';
      }
    } catch (e) {
      // ignore
    }
  }

  function isReportStatusKlar() {
    try {
      const docs = getAllDocuments();
      for (const doc of docs) {
        try {
          // First try: hidden RowDescription / RowValue inputs which often
          // accompany datalist controls. RowDescription typically contains
          // the human-readable text like 'Klar'.
          try {
            const desc = doc.querySelector('input[id$="RowDescription"], input[name$="RowDescription"], input[id*="RowDescription"], input[name*="RowDescription"]');
            if (desc && (desc.value || desc.getAttribute('value'))) {
              const v = (desc.value || desc.getAttribute('value') || '').toString().trim().toLowerCase();
              if (v.indexOf('klar') >= 0) return true;
            }
          } catch (e) {}

          try {
            const valIn = doc.querySelector('input[id$="RowValue"], input[name$="RowValue"], input[id*="RowValue"], input[name*="RowValue"]');
            if (valIn && (valIn.value || valIn.getAttribute('value'))) {
              const vv = (valIn.value || valIn.getAttribute('value') || '').toString().trim().toLowerCase();
              // Some implementations use 'N' to indicate the selected item
              if (vv === 'n' || vv.indexOf('klar') >= 0) return true;
            }
          } catch (e) {}

          // Next, try datalistcontrol elements that have title='Status' and
          // contain an input with the human-readable description.
          try {
            const dl = Array.from(doc.querySelectorAll('datalistcontrol')).find(d => {
              try { return (d.getAttribute('title') || '').toLowerCase().indexOf('status') >= 0; } catch (e) { return false; }
            });
            if (dl) {
              try {
                const inner = dl.querySelector('input');
                if (inner && (inner.value || inner.getAttribute('value'))) {
                  const v = (inner.value || inner.getAttribute('value') || '').toString().trim().toLowerCase();
                  if (v.indexOf('klar') >= 0) return true;
                }
              } catch (e) {}
            }
          } catch (e) {}

          // Fallback: look for visible label/text mentioning 'Status' and check
          // nearby select/input values.
          try {
            const labelNode = Array.from(doc.querySelectorAll('label, th, td, div, span'))
              .find(n => /\bstatus\b/i.test((n.textContent||'').trim()));
            if (labelNode) {
              const container = labelNode.closest('tr') || labelNode.parentElement || doc;
              const input = container.querySelector('select, input[type="text"], input');
              if (input) {
                const val = (input.value || (input.selectedOptions && input.selectedOptions[0] && input.selectedOptions[0].text) || '').toString().trim().toLowerCase();
                if (val.indexOf('klar') >= 0) return true;
              }
            }
          } catch (e) {}

          // Final fallback: check any select's selected option text for 'Klar'
          const selects = Array.from(doc.querySelectorAll('select'));
          for (const s of selects) {
            try {
              const selText = (s.selectedOptions && s.selectedOptions[0] && s.selectedOptions[0].text) || (s.options && s.options[s.selectedIndex] && s.options[s.selectedIndex].text) || '';
              if ((selText||'').toLowerCase().indexOf('klar') >= 0) return true;
            } catch (e) {}
          }
        } catch (e) {
          // ignore per-document errors
        }
      }
    } catch (e) {
      // ignore
    }
    return false;
  }

  function getReportStatusText() {
    try {
      const docs = getAllDocuments();
      for (const doc of docs) {
        try {
          const labelNode = Array.from(doc.querySelectorAll('label, th, td, div, span'))
            .find(n => /\bstatus\b/i.test((n.textContent||'').trim()));
          if (labelNode) {
            const container = labelNode.closest('tr') || labelNode.parentElement || doc;
            const input = container.querySelector('select, input[type="text"], input');
            if (input) {
              // selected option text or input value
              const selText = (input.selectedOptions && input.selectedOptions[0] && input.selectedOptions[0].text) || input.value || '';
              if (selText) return (selText || '').trim();
            }
          }

          const selects = Array.from(doc.querySelectorAll('select'));
          for (const s of selects) {
            try {
              const selText = (s.selectedOptions && s.selectedOptions[0] && s.selectedOptions[0].text) || (s.options && s.options[s.selectedIndex] && s.options[s.selectedIndex].text) || '';
              if (selText) return (selText || '').trim();
            } catch (e) {}
          }
        } catch (e) {
          // ignore per-document errors
        }
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  function refreshPeriodIndicatorStatus() {
    try {
      const indicator = ensureIndicator();
      if (!indicator.classList.contains('agresso-period-end')) return;
      const lang = getReminderLang();
      // The stored notify key is the detected deadline — if it lies in the
      // past, say "overdue" instead of the misleading "today is the last day".
      let overdue = false;
      try {
        const iso = settings.period_notify_date;
        const endD = iso ? parseDateFlexible(iso) : null;
        if (endD) {
          const t = new Date(); t.setHours(0, 0, 0, 0);
          endD.setHours(0, 0, 0, 0);
          overdue = endD.getTime() < t.getTime();
        }
      } catch (e) {}
      const base = overdue
        ? (lang === 'en' ? 'The reporting period has ended — submit your time report.' : 'Perioden har passerat – skicka in din tidrapport.')
        : (lang === 'en' ? 'Today is the last day of the period — submit your time report.' : 'Idag är sista dagen för perioden – skicka in din tidrapport.');
      const statusText = getReportStatusText();
      const sub = statusText ? `${base} • Status: ${statusText}` : base;
      try {
        const subEl = indicator.querySelector('.agresso-autosave-sub');
        if (subEl) subEl.textContent = sub;
      } catch (e) {}
    } catch (e) {
      // ignore
    }
  }

  function highlightStatusField(highlight) {
    try {
      const docs = getAllDocuments();
      for (const doc of docs) {
        try {
          const labelNode = Array.from(doc.querySelectorAll('label, th, td, div, span'))
            .find(n => /\bstatus\b/i.test((n.textContent||'').trim()));
          if (!labelNode) continue;
          const container = labelNode.closest('tr') || labelNode.parentElement || doc;
          // Try to find a status input or readable text in the same container
          const input = container.querySelector('select, input[type="text"], input');
          let val = null;
          try {
            if (input) {
              const tag = (input.tagName || '').toLowerCase();
              if (tag === 'select') {
                val = (input.selectedOptions && input.selectedOptions[0] && input.selectedOptions[0].text) || null;
              } else {
                val = (input.value || input.textContent || null) || null;
              }
            }
          } catch (e) {
            val = null;
          }

          // If no form control found, try to read textual status from nearby cells
          if (val === null || val === '') {
            try {
              // look for a span/div/td inside the container that contains status text
              const textNode = container.querySelector('span, div, td, strong, b, em');
              if (textNode) {
                const t = (textNode.textContent || '').trim();
                if (t) val = t;
              }
            } catch (e) {
              // ignore
            }
          }

          // If we still couldn't determine a value, do not apply highlight
          if (val === null || (typeof val === 'string' && val.trim() === '')) {
            if (!highlight) {
              try { if (input) { input.style.boxShadow = ''; input.style.background = ''; } } catch (e) {}
            }
            return false;
          }

          const isKlar = ('' + val).toLowerCase().indexOf('klar') >= 0;
          if (highlight) {
            if (!isKlar) {
              try {
                if (input) { input.style.boxShadow = '0 0 8px rgba(217,83,79,0.65)'; input.style.background = '#fff7f7'; }
              } catch (e) {}
            } else {
              try { if (input) { input.style.boxShadow = ''; input.style.background = ''; } } catch (e) {}
            }
          } else {
            try { if (input) { input.style.boxShadow = ''; input.style.background = ''; } } catch (e) {}
          }
          return true;
        } catch (e) {
          // ignore per-doc
        }
      }
    } catch (e) {}
    return false;
  }

  function isDeletionButton(target) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    const text = (target.textContent || target.innerText || target.getAttribute('value') || '').toLowerCase();
    return DELETE_KEYWORDS.some((kw) => text.includes(kw));
  }

  function isAddRowButton(target) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    const text = (target.textContent || target.innerText || target.getAttribute('value') || '').toLowerCase();
    return ADD_KEYWORDS.some((kw) => text.includes(kw));
  }

  function isNoChangesBannerVisible() {
    const docs = getAllDocuments();
    return docs.some((doc) => {
      try {
        const body = doc.body;
        if (!body) {
          return false;
        }
        const text = (body.innerText || '').toLowerCase();
        return text.includes(NO_CHANGES_TEXT) || text.includes(NO_CHANGES_TEXT_ALT);
      } catch (e) {
        return false;
      }
    });
  }

  function refreshNoChangesBannerState(reason) {
    const visible = isNoChangesBannerVisible();
    if (visible === noChangesBannerVisible) {
      return;
    }

    noChangesBannerVisible = visible;
    console.info(LOG_PREFIX, 'No-changes banner state', { visible, reason });

    if (visible) {
      stopTimer();
      setIndicator('pending', 'Autosave paused', '');
    } else {
      const row = pendingRow || getDirtyRow();
      if (row) {
        setIndicator('pending', 'Autosave ready', 'Watching for edits');
        startTimer(IDLE_TIMEOUT_MS, 'idle');
      } else {
        setIndicator('saved', 'Autosave ready', 'Watching for edits');
        startTimer(IDLE_TIMEOUT_MS, 'idle');
      }
    }
  }

  function stopTimer() {
    if (unifiedTimer) {
      clearTimeout(unifiedTimer);
      unifiedTimer = null;
    }
    stopTimerBar();
  }

  function startTimer(durationMs, reason) {
    stopTimer();
    // Central gate: only arm the idle timer when we're actually on the
    // timesheet AND the user's master toggle is on. Every call site used to
    // restart the timer unconditionally (markActivity on any input, retry
    // branches in onTimerComplete, init, …) which kept the countdown
    // running on Start / menu panels even though performSave was gated.
    if (!onTimesheetPage || !getToggleEnabled()) {
      logDebug('Timer start suppressed', { onTimesheetPage, enabled: getToggleEnabled(), reason });
      return;
    }

    timerStartedAt = Date.now();
    timerDuration = durationMs;
    timerReason = reason;

    logDebug('Timer started', { durationMs, reason });
    resetTimerBar(durationMs);

    unifiedTimer = window.setTimeout(() => {
      unifiedTimer = null;
      onTimerComplete();
    }, durationMs);
  }

  function onTimerComplete() {
    logDebug('Timer completed', { reason: timerReason });
    // If autosave is disabled, stop and don't proceed with save
    try {
      if (!getToggleEnabled()) {
        logDebug('Timer completed but autosave disabled');
        stopTimer();
        setIndicator('pending', 'Autosave disabled', 'Paused');
        return;
      }
    } catch (e) {
      // ignore
    }
    
    // Check if we should actually save
    if (dropdownActive) {
      logDebug('Save skipped - dropdown active');
      startTimer(IDLE_RETRY_MS, 'retry-dropdown');
      return;
    }
    
    if (noChangesBannerVisible) {
      logDebug('Save skipped - no changes banner visible');
      stopTimer();
      setIndicator('pending', 'Autosave paused', '');
      return;
    }
    
    // Perform the save - let the save function handle the outcome
    performSave(timerReason);
  }

  function markActivity() {
    // If we're in a frame (not the top window), forward activity to the top window
    try {
      if (window.top && window.top !== window) {
        // If the top-level indicator is paused, don't forward or restart
        try {
          const topDoc = window.top.document;
          const topInd = topDoc && topDoc.getElementById && topDoc.getElementById(INDICATOR_ID);
          if (topInd && topInd.classList && topInd.classList.contains('agresso-paused')) {
            return;
          }
        } catch (e) {
          // cross-origin may throw; ignore
        }
        // Targeted rather than '*': every frame running this content script is
        // on the Agresso origin (host_permissions restricts it), so scoping the
        // target keeps the message out of any foreign frame in between.
        window.top.postMessage({ type: ACTIVITY_MESSAGE, ts: Date.now() }, window.location.origin);
        return;
      }
    } catch (e) {
      // ignore cross-origin access; fall through to local handling
    }

    // If local/top indicator is marked paused, don't restart timer on movement/clicks
    try {
      const doc = getIndicatorDocument();
      const ind = doc && doc.getElementById && doc.getElementById(INDICATOR_ID);
      if (ind && ind.classList && ind.classList.contains('agresso-paused')) return;
    } catch (e) {
      // ignore
    }

    // Restart idle countdown on activity
    startTimer(IDLE_TIMEOUT_MS, 'idle');
  }

  function performSave(trigger) {
    // Respect toggle: skip saves when disabled
    try {
      if (!getToggleEnabled()) {
        console.info(LOG_PREFIX, 'Autosave disabled, skipping save');
        setIndicator('pending', 'Autosave disabled', 'Paused');
        return;
      }
    } catch (e) {
      // ignore
    }
    // Only save when we've actually detected the timesheet grid — every
    // other Agresso page has different save semantics or no save button.
    try {
      if (!onTimesheetPage) {
        console.info(LOG_PREFIX, 'Not on timesheet, skipping save');
        setIndicator('pending', 'Autosave disabled', 'Not on timesheet');
        return;
      }
    } catch (e) {}
    // Only perform save from the top frame
    try {
      if (window.top && window.top !== window) return;
    } catch (e) {
      // if cross-origin error, bail
      return;
    }

    // Cooldown: never fire two saves closer together than SAVE_COOLDOWN_MS.
    // A postback re-render can re-trigger the idle timer almost immediately
    // after a save, and Agresso responds badly to overlapping submits. Re-arm
    // the countdown for the remainder instead of dropping the save outright.
    try {
      const since = Date.now() - lastSaveAt;
      if (lastSaveAt && since < SAVE_COOLDOWN_MS) {
        const wait = SAVE_COOLDOWN_MS - since;
        logDebug('Save deferred by cooldown', { trigger, sinceMs: since, waitMs: wait });
        startTimer(wait, 'cooldown');
        return;
      }
    } catch (e) {}

    console.info(LOG_PREFIX, 'Saving via shortcut', { trigger, shortcut: SHORTCUT_LABEL });
    setIndicator('saving', 'Saving…', `Using ${SHORTCUT_LABEL}`);
    triggerShortcutSave();

    // Note: removed fallback button-click logic to avoid CSP/page errors.

    lastSaveAt = Date.now();
    startDialogSweep('autosave');

    window.setTimeout(() => {
      const timestamp = new Date().toLocaleTimeString(undefined, {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      try {
        // If the indicator (or a no-changes banner) indicates paused state
        // after save, preserve the paused state and do not restart timer.
        const doc = getIndicatorDocument();
        const ind = doc && doc.getElementById ? doc.getElementById(INDICATOR_ID) : null;
        const pausedNow = (ind && ind.classList && ind.classList.contains('agresso-paused')) || noChangesBannerVisible || isNoChangesBannerVisible();
        if (pausedNow) {
          try { setIndicator('pending', 'Autosave paused', ''); } catch (e) {}
          try { stopTimer(); } catch (e) {}
        } else {
          setIndicator('saved', 'Saved', `at ${timestamp}`);
          // Restart idle countdown after a save completes
          startTimer(IDLE_TIMEOUT_MS, 'idle');
        }
      } catch (e) {
        // Fallback: behave as saved
        try { setIndicator('saved', 'Saved', `at ${timestamp}`); } catch (e2) {}
        try { startTimer(IDLE_TIMEOUT_MS, 'idle'); } catch (e2) {}
      }
      if (pendingRow) {
        pendingRow.dataset.agressoDirty = '0';
        pendingRow = null;
      }
    }, 1500);
    // After save completes, give the page a short moment and then re-check
    // for the "no changes" banner. If present, follow existing procedure
    // (refreshNoChangesBannerState will pause/stop timers as needed).
    window.setTimeout(() => {
      try { refreshNoChangesBannerState('post-save-check'); } catch (e) {}
    }, 800);
  }

  function getDirtyRow() {
    return document.querySelector('tr[data-agresso-dirty="1"]');
  }

  function triggerShortcutSave() {
    const docs = getAllDocuments();
    const targets = new Set();

    docs.forEach((doc) => {
      if (!doc) {
        return;
      }
      targets.add(doc.activeElement);
      targets.add(doc.body);
      targets.add(doc);
      try {
        if (doc.defaultView) {
          targets.add(doc.defaultView);
        }
      } catch (e) {
        // ignore
      }
    });

    SHORTCUT_COMBOS.forEach((combo) => {
      const base = {
        key: 's',
        code: 'KeyS',
        altKey: combo.altKey,
        metaKey: combo.metaKey,
        bubbles: true,
        cancelable: true,
        composed: true,
        keyCode: 83,
        which: 83
      };

      const events = [
        new KeyboardEvent('keydown', base),
        new KeyboardEvent('keypress', base),
        new KeyboardEvent('keyup', base)
      ];

      targets.forEach((el) => {
        if (el && typeof el.dispatchEvent === 'function') {
          events.forEach((evt) => el.dispatchEvent(evt));
        }
      });
    });

    console.info(LOG_PREFIX, 'Shortcut events dispatched', { shortcut: SHORTCUT_LABEL, targets: targets.size, combos: SHORTCUT_COMBOS.length });
  }

  // Fallback save click logic removed (caused errors on some pages/CSP).

  function isVisible(el) {
    if (!el) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findDialogButton(allowHidden = false) {
    const docs = getAllDocuments();
    for (const doc of docs) {
      try {
        const buttons = Array.from(
          doc.querySelectorAll('button, input[type="button"], input[type="submit"], a')
        );

        // First check for "stay signed in" buttons (highest priority for session dialogs)
        if (settings.auto_stay_signed_in !== false) {
          const staySignedInButton = buttons.find((btn) => {
            const text = (btn.textContent || btn.value || '').toLowerCase().trim();
            return STAY_SIGNED_IN_LABELS.some((label) => text.includes(label));
          });
          if (staySignedInButton && (allowHidden || isVisible(staySignedInButton))) {
            return staySignedInButton;
          }
        }

        // Then check for "return to application" buttons (higher priority after save)
        if (settings.auto_return_to_app !== false) {
          const returnButton = buttons.find((btn) => {
            const text = (btn.textContent || btn.value || '').toLowerCase().trim();
            return RETURN_TO_APP_LABELS.some((label) => text.includes(label));
          });
          if (returnButton && (allowHidden || isVisible(returnButton))) {
            return returnButton;
          }
        }

        // Then check for standard OK/Close buttons
        const okButton = buttons.find((btn) => {
          const text = (btn.textContent || btn.value || '').toLowerCase().trim();
          return OK_LABELS.some((label) => text === label || text === `${label}.` || text === `[${label}]`);
        });
        if (okButton && (allowHidden || isVisible(okButton))) {
          return okButton;
        }

        for (const selector of CLOSE_SELECTORS) {
          const el = doc.querySelector(selector);
          if (el && (allowHidden || isVisible(el))) {
            return el;
          }
        }
      } catch (e) {
        // ignore cross-origin issues
      }
    }

    return null;
  }

  function findDialogContainer(el) {
    if (!(el instanceof HTMLElement)) {
      return null;
    }
    const selectors = [
      '[role="dialog"]',
      '.modal',
      '.k-window',
      '.notification',
      '.alert',
      '.k-dialog',
      ...SAVE_DIALOG_SELECTORS
    ];
    if (el.matches(selectors.join(','))) {
      return el;
    }
    return el.closest(selectors.join(','));
  }

  function isSaveDialog(dialog) {
    if (!dialog) {
      return false;
    }
    // Only the genuine Unit4 save-success overlay counts. Match either the
    // candidate itself or an overlay nested inside it (the candidate may be a
    // .k-window / [role="dialog"] wrapper). No text-keyword fallback — see the
    // note next to SAVE_DIALOG_SELECTORS for why.
    return SAVE_DIALOG_SELECTORS.some((sel) => {
      try {
        return dialog.matches(sel) || !!dialog.querySelector(sel);
      } catch (e) {
        return false;
      }
    });
  }

  function isLogoutDialog(dialog) {
    if (!dialog) {
      return false;
    }
    const text = (dialog.innerText || dialog.textContent || '').toLowerCase();
    // Check for logout/sign out related text and "return to application" button presence
    const hasLogoutText = text.includes('log out') || text.includes('logout') || text.includes('sign out') || text.includes('logga ut');
    const hasReturnButton = RETURN_TO_APP_LABELS.some((label) => text.includes(label));
    return hasLogoutText && hasReturnButton;
  }

  function isStaySignedInDialog(dialog) {
    if (!dialog) {
      return false;
    }
    const text = (dialog.innerText || dialog.textContent || '').toLowerCase();
    // Check for stay signed in / session expiration text and stay-signed-in button presence
    const hasSessionText = text.includes('session') || text.includes('sign in') || text.includes('signed in') || text.includes('inloggad') || text.includes('timeout') || text.includes('expire');
    const hasStayButton = STAY_SIGNED_IN_LABELS.some((label) => text.includes(label));
    return hasSessionText && hasStayButton;
  }

  function sweepDialogs(reason) {
    // If autosave is disabled, do not attempt to sweep/dismiss dialogs
    try {
      if (!getToggleEnabled()) {
        return false;
      }
    } catch (e) {
      // ignore
    }
    // Only sweep dialogs from the top frame
    try {
      if (window.top && window.top !== window) return false;
    } catch (e) {
      return false;
    }

    // First ensure there's any dialog-like element that looks like a save/confirmation
    const docs = getAllDocuments();
    let sawSaveDialogCandidate = false;
    let sawLogoutDialogCandidate = false;
    let sawStaySignedInDialogCandidate = false;
    const dialogSelectors = ['[role="dialog"]', '.modal', '.k-window', '.notification', '.alert', '.k-dialog', ...SAVE_DIALOG_SELECTORS];
    for (const doc of docs) {
      try {
        const candidate = doc.querySelector(dialogSelectors.join(','));
        if (!candidate) {
          continue;
        }

        // Check if it's a stay-signed-in dialog (highest priority)
        if (isStaySignedInDialog(candidate)) {
          sawStaySignedInDialogCandidate = true;
          break;
        }

        // Check if it's a logout dialog (higher priority for return-to-app)
        if (isLogoutDialog(candidate)) {
          sawLogoutDialogCandidate = true;
          break;
        }

        // Only the genuine save-success overlay (selector-based) counts as a
        // save dialog. The old bare-keyword text scan lived here and is gone:
        // it matched benign popups like the Utlägg draft list (whose heading
        // contains the word "utkast") and auto-closed them.
        if (isSaveDialog(candidate)) {
          sawSaveDialogCandidate = true;
          break;
        }
      } catch (e) {
        // ignore cross-origin issues
      }
    }

    // If nothing looks like a save, logout, or stay-signed-in dialog, silently skip without logging.
    if (!sawSaveDialogCandidate && !sawLogoutDialogCandidate && !sawStaySignedInDialogCandidate) {
      return false;
    }

    // We found a dialog-like candidate; look for a dismiss/OK button.
    // If the user has left the window (document hidden or not focused) allow
    // finding buttons even if they are not visible so background popups get dismissed.
    let allowHidden = false;
    try {
      const docsVisHidden = docs.some((d) => {
        try {
          return d.visibilityState === 'hidden' || d.hidden;
        } catch (e) {
          return false;
        }
      });
      allowHidden = (typeof document.hidden !== 'undefined' && document.hidden) || !document.hasFocus() || docsVisHidden;
    } catch (e) {
      // ignore
    }

    const button = findDialogButton(allowHidden);
    if (button) {
      const dialog = findDialogContainer(button);
      // Accept save, logout, and stay-signed-in dialogs
      if (!dialog || (!isSaveDialog(dialog) && !isLogoutDialog(dialog) && !isStaySignedInDialog(dialog))) {
        console.info(LOG_PREFIX, 'Dialog ignored (not save, logout, or stay-signed-in)', { reason });
        return false;
      }

      // For stay-signed-in dialogs, log a specific message
      if (isStaySignedInDialog(dialog)) {
        console.info(LOG_PREFIX, 'Stay-signed-in dialog detected, clicking to remain signed in', { reason });
      }

      // For logout dialogs, log a specific message
      if (isLogoutDialog(dialog)) {
        console.info(LOG_PREFIX, 'Logout dialog detected, clicking "Return to application"', { reason });
      }

      // Hide dialog and any backdrop/overlay immediately
      try {
        dialog.style.display = 'none';
        dialog.style.visibility = 'hidden';
        dialog.style.opacity = '0';
        dialog.style.pointerEvents = 'none';
      } catch (e) {
        // ignore
      }

      // Also hide any backdrop/overlay elements
      docs.forEach((doc) => {
        try {
          const overlays = doc.querySelectorAll('.k-overlay, .modal-backdrop, [class*="overlay"], [class*="backdrop"]');
          overlays.forEach((overlay) => {
            try {
              overlay.style.display = 'none';
              overlay.style.visibility = 'hidden';
              overlay.style.opacity = '0';
            } catch (e) {
              // ignore
            }
          });
        } catch (e) {
          // ignore
        }
      });

      // Click button to dismiss
      try {
        button.click();
      } catch (e) {
        // ignore
      }
      console.info(LOG_PREFIX, 'Dialog dismissed', { reason });
      return true;
    }

    // Only log a warning if we haven't already when a save-like dialog was present
    if (!dialogMissLogged) {
      console.warn(LOG_PREFIX, 'Dialog button not found', { reason });
      dialogMissLogged = true;
    }
    return false;
  }

  function startDialogSweep(reason) {
    // Respect toggle: don't start sweeping dialogs when autosave is disabled
    try {
      if (!getToggleEnabled()) return;
    } catch (e) {
      // ignore
    }
    // Extend sweep time if already running
    dialogSweepEndAt = Date.now() + DIALOG_SWEEP_MS;
    
    if (dialogSweepTimer) {
      logDebug('Extending dialog sweep', { reason });
      return;
    }

    dialogMissLogged = false;

    dialogSweepTimer = window.setInterval(() => {
      if (Date.now() > dialogSweepEndAt) {
        window.clearInterval(dialogSweepTimer);
        dialogSweepTimer = null;
        return;
      }

      sweepDialogs(reason);
      checkReturnToAppButton();
    }, DIALOG_SWEEP_INTERVAL_MS);
    logDebug('Started dialog sweep', { reason, durationMs: DIALOG_SWEEP_MS });
  }

  function checkReturnToAppButton() {
    // Gate on both master autosave toggle and the per-feature option.
    try {
      if (!getToggleEnabled() || settings.auto_return_to_app === false) {
        return false;
      }
    } catch (e) {
      return false;
    }

    // Look for "return to application" button on the page
    const docs = getAllDocuments();
    for (const doc of docs) {
      try {
        const buttons = Array.from(
          doc.querySelectorAll('button, input[type="button"], input[type="submit"], a')
        );

        // Debug: log all button texts on logout page
        if (window.location.href.includes('/Logout/Logout.aspx') && buttons.length > 0) {
          const buttonTexts = buttons.map(b => (b.textContent || b.value || '').toLowerCase().trim()).filter(t => t);
          if (buttonTexts.length > 0) {
            logDebug('Buttons found on page:', buttonTexts);
          }
        }

        const returnButton = buttons.find((btn) => {
          const text = (btn.textContent || btn.value || '').toLowerCase().trim();
          const matches = RETURN_TO_APP_LABELS.some((label) => text.includes(label));
          if (matches) {
            logDebug('Button text matches return-to-app label:', { text, matchedLabel: RETURN_TO_APP_LABELS.find(l => text.includes(l)) });
          }
          return matches;
        });

        if (returnButton) {
          const visible = isVisible(returnButton);
          logDebug('Return button found', { text: returnButton.textContent || returnButton.value, visible });
          
          if (visible) {
            console.info(LOG_PREFIX, 'Clicking "return to application" button...', { text: returnButton.textContent || returnButton.value });
            try {
              returnButton.click();
              return true;
            } catch (e) {
              console.warn(LOG_PREFIX, 'Failed to click "return to application" button', e);
            }
          }
        }
      } catch (e) {
        // ignore cross-origin issues
      }
    }

    return false;
  }

  // --- Period end detection and notification ---
  // The period-end notify cache (one entry per period end) lives in
  // chrome.storage.local under `period_notify_date`, read via
  // `settings.period_notify_date`. Everything else is mirrored from `settings`.

  function getReminderEnabled() {
    return settings.reminder_enabled !== false;
  }

  function setReminderEnabled(enabled) {
    settings.reminder_enabled = !!enabled;
    try { chrome.storage.local.set({ reminder_enabled: !!enabled }); } catch (e) {}
  }

  function getReminderLang() {
    return settings.reminder_lang || 'sv';
  }

  function setReminderLang(lang) {
    settings.reminder_lang = String(lang || 'sv');
    try { chrome.storage.local.set({ reminder_lang: settings.reminder_lang }); } catch (e) {}
  }

  function cycleReminderLang() {
    const cur = getReminderLang();
    const next = cur === 'en' ? 'sv' : 'en';
    setReminderLang(next);
    return next;
  }

  function getOverrideDate() {
    try {
      const v = settings.period_override;
      if (!v) return null;
      return parseDateFlexible(v);
    } catch (e) { return null; }
  }

  function setOverrideDate(v) {
    settings.period_override = String(v || '');
    try { chrome.storage.local.set({ period_override: settings.period_override }); } catch (e) {}
  }

  function clearOverrideDate() {
    settings.period_override = '';
    try { chrome.storage.local.set({ period_override: '' }); } catch (e) {}
  }

  function updateReminderButtonState(btn) {
    try {
      if (!btn) return;
      const enabled = getReminderEnabled();
      const lang = getReminderLang();
      try { btn.setAttribute('aria-pressed', String(enabled)); } catch (e) {}
      btn.title = enabled ? (lang === 'en' ? 'Reminder: On (en) - Shift+click to switch language' : 'Påminnelse: På (sv) - Shift+click för språk') : (lang === 'en' ? 'Reminder: Off - click to enable' : 'Påminnelse: Av - klicka för att aktivera');
      btn.style.opacity = enabled ? '1' : '0.45';
    } catch (e) {
      // ignore
    }
  }

  function parseDateFlexible(s) {
    if (!s) return null;
    s = s.trim();
    // ISO yyyy-mm-dd
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (iso) {
      return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    }

    // dd/mm/yyyy or dd.mm.yyyy or dd mm yyyy
    const parts = /^(\d{1,2})[\/\.\s](\d{1,2})[\/\.\s](\d{2,4})$/.exec(s);
    if (parts) {
      let day = Number(parts[1]);
      let month = Number(parts[2]);
      let year = Number(parts[3]);
      if (year < 100) year += 2000;
      return new Date(year, month - 1, day);
    }

    // dd/mm or dd.mm (no year) -> assume current year
    const twoPart = /^(\d{1,2})[\/\.\s](\d{1,2})$/.exec(s);
    if (twoPart) {
      const day = Number(twoPart[1]);
      const month = Number(twoPart[2]);
      const year = (new Date()).getFullYear();
      return new Date(year, month - 1, day);
    }

    // Try Date.parse fallback (e.g., "1 January 2025")
    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
    return null;
  }

  function findPeriodEndDate() {
    try {
      console.info(LOG_PREFIX, 'findPeriodEndDate: start scan');

      // Shared red-ish color detector. Defined once at function scope: the
      // legacy heuristics below referenced a copy that lived inside the
      // `if (sumIdx > 0)` block, so every use outside that block threw a
      // (silently swallowed) ReferenceError and red columns were never
      // skipped in the fallback scans.
      const isRedColor = (colorStr) => {
        if (!colorStr) return false;
        const rgb = /rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/i.exec(colorStr);
        if (rgb) {
          const r = Number(rgb[1]), g = Number(rgb[2]), b = Number(rgb[3]);
          return r > 140 && r > g + 30 && r > b + 30;
        }
        const hex = /#([0-9a-f]{6}|[0-9a-f]{3})/i.exec(colorStr);
        if (hex) {
          let h = hex[1]; if (h.length === 3) h = h.split('').map(c=>c+c).join('');
          const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
          return r > 140 && r > g + 30 && r > b + 30;
        }
        return false;
      };

      // --- Primary deterministic path ---
      // Read the day-column headers of the VISIBLE time-transaction grid:
      // th[data-fieldname^="reg_value"] is unique to that grid (same anchor
      // detectTimesheetPage uses). The visibility check matters — Unit4
      // keeps inactive app tabs alive as hidden iframes, and a stale grid
      // in one of those must not drive the reminder. The submit deadline is
      // the latest weekday column that isn't red (weekends/holidays are
      // rendered red and aren't workdays); everything below this block is
      // legacy fallback heuristics that only run when no visible grid with
      // parseable day headers exists.
      try {
        const dayTokenRe = /\b(\d{1,2})[\/\.](\d{1,2})\b/;
        for (const doc of getAllDocuments()) {
          let headerCells = [];
          try { headerCells = Array.from(doc.querySelectorAll('th[data-fieldname^="reg_value"]')).filter(isVisible); } catch (e) { continue; }
          if (!headerCells.length) continue;

          // Reference date for year inference (and New Year wrap), from the
          // 'Datum i perioden' style input in the same document.
          let refDate = null;
          try {
            const explicit = Array.from(doc.querySelectorAll('input')).map(n => (n.value || '').trim()).find(v => /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(v));
            if (explicit) refDate = parseDateFlexible(explicit);
          } catch (e) {}
          const ref = refDate || new Date();
          const refMonth = ref.getMonth() + 1;

          const columns = [];
          for (const th of headerCells) {
            try {
              const div = th.querySelector('.DivOverflowNoWrap, .Ellipsis, .Separator');
              // textContent collapses 'Mån<br>08/06' to 'Mån08/06', which the
              // \b in dayTokenRe rejects — prefer attribute text and innerHTML
              // (with tags stripped to spaces) over textContent.
              const raw = String(
                (div && ((div.dataset && div.dataset.originaltext) || div.getAttribute('title') || div.innerHTML)) ||
                (th.getAttribute && th.getAttribute('title')) || th.innerHTML || th.textContent || ''
              ).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ');
              const m = dayTokenRe.exec(raw);
              if (!m) continue;
              const day = Number(m[1]), month = Number(m[2]);
              if (!day || day > 31 || !month || month > 12) continue;
              let year = ref.getFullYear();
              if (refMonth === 12 && month === 1) year += 1;
              else if (refMonth === 1 && month === 12) year -= 1;
              const dt = new Date(year, month - 1, day);
              // Sanity guard: a day column should sit near the reference date.
              if (Math.abs(dt.getTime() - ref.getTime()) > 45 * 24 * 3600 * 1000) continue;
              let red = false;
              try {
                const win = (th.ownerDocument && th.ownerDocument.defaultView) || window;
                red = isRedColor((win.getComputedStyle && win.getComputedStyle(div || th).color) || '');
              } catch (e) {}
              columns.push({ dt, red });
            } catch (e) {}
          }
          if (!columns.length) continue;

          const latest = columns.reduce((a, b) => (a.dt > b.dt ? a : b)).dt;
          const workdays = columns.filter(c => !c.red && c.dt.getDay() >= 1 && c.dt.getDay() <= 5);
          const deadline = workdays.length ? workdays.reduce((a, b) => (a.dt > b.dt ? a : b)).dt : latest;
          console.info(LOG_PREFIX, 'findPeriodEndDate: visible grid day headers', { columns: columns.length, periodEnd: latest, deadline });
          return deadline;
        }
      } catch (e) {}

      // (Removed deterministic "direct div match" scan to avoid static div identification)
      const indicatorEl = document.getElementById('agresso-autosave-indicator');
      let nodes = Array.from(document.querySelectorAll('h1,h2,h3,p,div,span,label,td,th'));
      if (indicatorEl) {
        nodes = nodes.filter(n => !indicatorEl.contains(n));
      }
      const dateRangeIso = /(\d{4}-\d{2}-\d{2})\s*[–—-]\s*(\d{4}-\d{2}-\d{2})/;
      const dateRangeSlashed = /(\d{1,2}[\/\.\s]\d{1,2}[\/\.\s]\d{2,4})\s*[–—-]\s*(\d{1,2}[\/\.\s]\d{1,2}[\/\.\s]\d{2,4})/;
      const monthNameRange = /(\d{1,2}\s+[A-Za-zåäöÅÄÖ]+\s+\d{4})\s*[–—-]\s*(\d{1,2}\s+[A-Za-zåäöÅÄÖ]+\s+\d{4})/;
      // Matches a bare `dd/mm` (or `dd.mm`) day-column token. Declared at
      // function scope for the same reason isRedColor was hoisted in 1.4.11:
      // it used to be a `const` inside the Sum-left scan's try-block while ten
      // later call sites — the whole same-origin-frame fallback — referenced it
      // from outside. Every one threw ReferenceError into a swallowing catch,
      // so the first gate (`dateNodes`) always came back empty and the entire
      // in-frame scan was unreachable code.
      const dateTokenRe = /\b(\d{1,2})[\/\.](\d{1,2})\b/;

      // Prefer elements that mention 'period' or similar
      const priority = nodes.filter((n) => /period|perioden|vecka|veckor|tidrapport/i.test((n.textContent||'')));
      const searchList = priority.length ? priority : nodes;

      for (const el of searchList) {
        if (indicatorEl && indicatorEl.contains(el)) continue;
        const txt = (el.textContent || '').trim();
        let m = dateRangeIso.exec(txt);
        if (m) {
          console.info(LOG_PREFIX, 'findPeriodEndDate: matched iso range in element', txt.slice(0,200));
          try { console.info(LOG_PREFIX, 'findPeriodEndDate: matched element outer', (el.outerHTML||'').slice(0,200)); } catch (e) {}
          return parseDateFlexible(m[2]);
        }
        m = dateRangeSlashed.exec(txt);
        if (m) {
          console.info(LOG_PREFIX, 'findPeriodEndDate: matched slashed range in element', txt.slice(0,200));
          try { console.info(LOG_PREFIX, 'findPeriodEndDate: matched element outer', (el.outerHTML||'').slice(0,200)); } catch (e) {}
          return parseDateFlexible(m[2]);
        }
        m = monthNameRange.exec(txt);
        if (m) {
          console.info(LOG_PREFIX, 'findPeriodEndDate: matched month name range in element', txt.slice(0,200));
          try { console.info(LOG_PREFIX, 'findPeriodEndDate: matched element outer', (el.outerHTML||'').slice(0,200)); } catch (e) {}
          return parseDateFlexible(m[2]);
        }
      }

      // Deterministic header `th` scan: look for th elements containing
      // DivOverflowNoWrap header DIVs with date tokens (e.g. "Fre<br>09/01").
      try {
        const ths = Array.from(document.querySelectorAll('th'));
        if (ths.length) {
          const headerDates = [];
          const dateTokenSimple = /\b(\d{1,2})[\/\.](\d{1,2})\b/;
          const isRedColorLocal = (colorStr) => {
            if (!colorStr) return false;
            const rgb = /rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/i.exec(colorStr);
            if (rgb) {
              const r = Number(rgb[1]), g = Number(rgb[2]), b = Number(rgb[3]);
              return r > 140 && r > g + 30 && r > b + 30;
            }
            const hex = /#([0-9a-f]{6}|[0-9a-f]{3})/i.exec(colorStr);
            if (hex) {
              let h = hex[1]; if (h.length === 3) h = h.split('').map(c=>c+c).join('');
              const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
              return r > 140 && r > g + 30 && r > b + 30;
            }
            return false;
          };

          ths.forEach((th) => {
            try {
              const div = th.querySelector && th.querySelector('.DivOverflowNoWrap, .Ellipsis, .Separator');
              if (!div) return;
              const raw = ((div.dataset && div.dataset.originaltext) || div.getAttribute('title') || div.textContent || div.innerHTML || '').toString().replace(/<br\s*\/?>(\s*)/gi,' ').trim();
              const m = dateTokenSimple.exec(raw);
              if (m) {
                // read computed color if possible
                let color = '';
                try { color = (window.getComputedStyle && window.getComputedStyle(div).color) || div.style && div.style.color || ''; } catch (e) {}
                headerDates.push({ th, day: Number(m[1]), month: Number(m[2]), raw, color, idx: th.cellIndex });
              }
            } catch (e) {}
          });

          if (headerDates.length) {
            // choose the rightmost non-Sum header (closest to Sum on the left)
            headerDates.sort((a,b) => (a.idx || 0) - (b.idx || 0));
            // find index of Sum header if present
            const sumTh = Array.from(document.querySelectorAll('th')).find(t => /\b(sum|summa|\u03a3)\b/i.test((t.textContent||t.getAttribute('title')||'').toLowerCase()));
            const sumIdx = sumTh ? sumTh.cellIndex : null;
            // iterate left-to-right up to sumIdx or choose rightmost
            let candidate = null;
            if (sumIdx !== null) {
              for (let i = headerDates.length - 1; i >= 0; i--) {
                const h = headerDates[i];
                if (h.idx >= sumIdx) continue; // skip anything at/after sum
                if (isRedColorLocal(h.color)) continue;
                candidate = h; break;
              }
            } else {
              // no sum found: pick rightmost non-red
              for (let i = headerDates.length - 1; i >= 0; i--) {
                const h = headerDates[i]; if (isRedColorLocal(h.color)) continue; candidate = h; break;
              }
            }
            if (!candidate) candidate = headerDates[headerDates.length - 1];
            if (candidate) {
              const inferredYear = (function(){ try { const explicit = Array.from(document.querySelectorAll('input,span,div')).map(n=>(n.value||n.textContent||'').trim()).find(v=>/^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(v)); if (explicit){ const d=parseDateFlexible(explicit); if (d) return d.getFullYear(); } } catch(e){} return (new Date()).getFullYear(); })();
              const dt = new Date(inferredYear, candidate.month - 1, candidate.day);
              console.info(LOG_PREFIX, 'findPeriodEndDate: detected end by deterministic th-scan', { raw: candidate.raw, columnIndex: candidate.idx, date: dt });
              return dt;
            }
          }
        }
      } catch (e) {}

        // New: scan the entire table for day/date tokens (handles layouts where first row isn't the date row)
      try {
          // (The "table chosen for Sum-left scan" log used to sit here, above
          // `let tbl2` — a TDZ ReferenceError swallowed by its own try/catch,
          // and it could never have reported anything but null this early. It
          // now runs after tbl2 is actually selected, below.)
        // Prefer the table inside the 'Daglig tidregistrering' section if present
        const heading = Array.from(document.querySelectorAll('h1,h2,h3,legend,div,span,th'))
          .find(el => /Arbetstimmar|Daglig tidregistrering|Tidrapport/i.test(el.textContent||''));
        const tableRoot = heading ? (heading.closest('section') || heading.closest('fieldset') || heading.closest('table') || document.body) : document.body;
        try { console.info(LOG_PREFIX, 'findPeriodEndDate: heading found', !!heading, heading && (heading.textContent||'').slice(0,120)); } catch (e) {}
        try { console.info(LOG_PREFIX, 'findPeriodEndDate: tableRoot selected', tableRoot && (tableRoot.tagName || 'body')); } catch (e) {}
        // Choose the most likely table that contains date tokens
        const candidateTables = Array.from(tableRoot.querySelectorAll('table'));
        let tbl2 = null;
        const matches = [];
        // Direct scan: look for floating header DIVs (DivOverflowNoWrap etc.) that contain date tokens
        try {
          const docs = getAllDocuments();
          const floating = [];
          for (const d of docs) {
            try {
              const found = Array.from(d.querySelectorAll('.DivOverflowNoWrap, .Ellipsis, .Separator'))
                .filter(n => {
                  try {
                    const t = (n.textContent || '') + '|' + (n.getAttribute && n.getAttribute('title') || '') + '|' + (n.dataset && n.dataset.originaltext || '') + '|' + (n.innerHTML || '');
                    return dateTokenRe.test(t);
                  } catch (e) { return false; }
                });
              floating.push(...found);
            } catch (e) {}
          }
            if (floating.length) {
              try { console.info(LOG_PREFIX, 'findPeriodEndDate: floating headers count', floating.length); } catch (e) {}
              const candidates = [];
              const floatInfo = [];
              for (const n of floating) {
                try {
                  const hdrCell = n.closest && n.closest('th,td');
                  const raw = (n.getAttribute && n.getAttribute('title') || n.dataset && n.dataset.originaltext || n.textContent || n.innerHTML || '').replace(/<br\s*\/?>(\s*)/gi, ' ').trim();
                  const m = dateTokenRe.exec(raw);
                  if (!m) continue;
                  const inner = n.querySelector && n.querySelector('.DivOverflowNoWrap, .Ellipsis, .Separator');
                  const color = (inner && (window.getComputedStyle ? window.getComputedStyle(inner).color : inner.style && inner.style.color)) || (hdrCell && (window.getComputedStyle ? window.getComputedStyle(hdrCell).color : hdrCell.style && hdrCell.style.color)) || '';
                  const bgColor = (inner && (window.getComputedStyle ? window.getComputedStyle(inner).backgroundColor : inner.style && inner.style.backgroundColor)) || (hdrCell && (window.getComputedStyle ? window.getComputedStyle(hdrCell).backgroundColor : hdrCell.style && hdrCell.style.backgroundColor)) || '';
                  let classes = '';
                  try { classes = hdrCell ? Array.from(hdrCell.classList || []).slice(0,8).join(' ') : (n.className || '').toString(); } catch(e){}
                  let nearestBg = bgColor;
                  try {
                    let elp = inner || hdrCell || n;
                    while (elp && elp.parentElement) {
                      try {
                        const cs = window.getComputedStyle ? window.getComputedStyle(elp) : null;
                        const bg = cs && cs.backgroundColor ? cs.backgroundColor : '';
                        if (bg && !/^(rgba\(0,\s*0,\s*0,\s*0\)|transparent)$/i.test(bg)) { nearestBg = bg; break; }
                      } catch(e){}
                      elp = elp.parentElement;
                    }
                  } catch(e){}
                  let outer = '';
                  try { outer = (n.outerHTML || '').slice(0,200); } catch(e){}
                  // extract inline style color if present (helps when computedStyle differs)
                  let inlineColor = '';
                  try {
                    const s = n.getAttribute && n.getAttribute('style');
                    if (s) {
                      const m = /color\s*:\s*([^;\s]+)/i.exec(s);
                      if (m) inlineColor = m[1];
                    }
                    // also check element.style.color
                    if (!inlineColor && n.style && n.style.color) inlineColor = n.style.color;
                    // normalize hex shorthand to full hex
                    if (inlineColor && /^#[0-9a-f]{3}$/i.test(inlineColor)) inlineColor = inlineColor.split('').map(c=>c+c).join('');
                  } catch(e){}
                  // sample rendered element at the floating node center (helps detect styles applied to other layers)
                  let renderColor = '';
                  let renderBg = '';
                  let renderBefore = '';
                  let renderAfter = '';
                  try {
                    const win = (n.ownerDocument && n.ownerDocument.defaultView) || window;
                    const rect = n.getBoundingClientRect && n.getBoundingClientRect();
                    if (rect && win && typeof win.elementFromPoint === 'function') {
                      const cx = rect.left + (rect.width||0)/2;
                      const cy = rect.top + (rect.height||0)/2;
                      try {
                        const elAt = win.elementFromPoint(cx, cy) || n;
                        const cs = win.getComputedStyle ? win.getComputedStyle(elAt) : (elAt.style||{});
                        renderColor = cs && cs.color ? cs.color : '';
                        renderBg = cs && cs.backgroundColor ? cs.backgroundColor : '';
                        try { renderBefore = win.getComputedStyle(elAt, '::before').color || ''; } catch(e){}
                        try { renderAfter = win.getComputedStyle(elAt, '::after').color || ''; } catch(e){}
                      } catch(e){}
                    }
                  } catch(e){}

                  floatInfo.push({ raw: String(raw).slice(0,120), columnIndex: hdrCell ? hdrCell.cellIndex : null, color: (color||'').toString(), bgColor: (bgColor||'').toString(), classes: classes, nearestBg: (nearestBg||'').toString(), outer: outer, inlineColor: inlineColor, renderColor: renderColor, renderBg: renderBg, renderBefore: renderBefore, renderAfter: renderAfter });
                  candidates.push({ hdrCell, raw, day: Number(m[1]), month: Number(m[2]), idx: hdrCell ? hdrCell.cellIndex : null, color, bgColor, classes, nearestBg, outer, inlineColor, renderColor, renderBg, renderBefore, renderAfter });
                } catch (e) {}
              }
              try { console.info(LOG_PREFIX, 'findPeriodEndDate: floating headers info', floatInfo); } catch (e) {}
              try { console.info(LOG_PREFIX, 'findPeriodEndDate: floating headers info json', JSON.stringify(floatInfo)); } catch (e) {}

              if (candidates.length) {
                // infer year from visible explicit date strings across reachable docs (used to compare dates)
                let inferredYear = (new Date()).getFullYear();
                try {
                  const allTextNodes = [];
                  for (const d2 of docs) {
                    try { allTextNodes.push(...Array.from(d2.querySelectorAll('input,span,div')).map(x => (x.value||x.textContent||'').trim())); } catch(e){}
                  }
                  const explicit = allTextNodes.find(v => /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(v));
                  if (explicit) {
                    const dd = parseDateFlexible(explicit);
                    if (dd) inferredYear = dd.getFullYear();
                  }
                } catch(e){}

                candidates.sort((a,b) => (b.idx || 0) - (a.idx || 0));
                const sumTh = Array.from(document.querySelectorAll('th')).find(t => /\b(sum|summa|\u03a3)\b/i.test((t.textContent||t.getAttribute('title')||'').toLowerCase()));
                const sumIdx = sumTh ? sumTh.cellIndex : null;
                let chosen = null;

                // helper: detect dark/black-ish colors
                const isBlackish = (colorStr) => {
                  if (!colorStr) return false;
                  try {
                    // rgba or rgb
                    const rgbMatch = /rgba?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(colorStr);
                    if (rgbMatch) {
                      const r = Number(rgbMatch[1]), g = Number(rgbMatch[2]), b = Number(rgbMatch[3]);
                      const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
                      return mx <= 100 && (mx - mn) <= 40; // dark and low chroma
                    }
                    // hex formats #rrggbb or #rgb
                    const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})/i.exec(colorStr.trim());
                    if (hex) {
                      let h = hex[1];
                      if (h.length === 3) h = h.split('').map(c=>c+c).join('');
                      const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
                      const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
                      return mx <= 100 && (mx - mn) <= 40;
                    }
                    // common named black/grays
                    const lowered = (colorStr||'').toString().toLowerCase();
                    if (['black','#000','grey','gray','darkgray','darkgrey'].includes(lowered)) return true;
                  } catch(e){}
                  return false;
                };

                const isRedColorLocal = (colorStr) => {
                  if (!colorStr) return false;
                  const rgb = /rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/i.exec(colorStr);
                  if (rgb) {
                    const r = Number(rgb[1]), g = Number(rgb[2]), b = Number(rgb[3]);
                    return r > 140 && r > g + 30 && r > b + 30;
                  }
                  const hex = /#([0-9a-f]{6}|[0-9a-f]{3})/i.exec(colorStr);
                  if (hex) {
                    let h = hex[1]; if (h.length === 3) h = h.split('').map(c=>c+c).join('');
                    const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
                    return r > 140 && r > g + 30 && r > b + 30;
                  }
                  return false;
                };

                const columnLooksRed = (candidate) => {
                  try {
                    if (isRedColorLocal(candidate.color) || isRedColorLocal(candidate.bgColor)) return true;
                    let tbl = candidate.hdrCell && candidate.hdrCell.closest && candidate.hdrCell.closest('table');
                    if (!tbl) {
                      try {
                        const docsAll = getAllDocuments();
                        const token = (candidate.raw || '').replace(/\s+-\s+Sidhuvud$/i, '').split(/\s+/).slice(0,3).join(' ');
                        for (const d of docsAll) {
                          try {
                            const tables = Array.from(d.querySelectorAll('table'));
                            for (const t of tables) {
                              try {
                                const hdr = t.querySelector('thead tr') || t.querySelector('tr');
                                if (!hdr) continue;
                                const cells = Array.from(hdr.querySelectorAll('th,td'));
                                const match = cells.find(c => {
                                  try {
                                    const inner = c.querySelector && c.querySelector('.DivOverflowNoWrap, .Ellipsis, .Separator');
                                    const txt = (inner && (inner.getAttribute && inner.getAttribute('title') || inner.dataset && inner.dataset.originaltext || inner.textContent || inner.innerHTML)) || (c.getAttribute && c.getAttribute('title') || c.textContent || c.innerHTML) || '';
                                    return (txt || '').indexOf(token) >= 0 || (candidate.idx !== undefined && (c.cellIndex === candidate.idx));
                                  } catch (e) { return false; }
                                });
                                if (match) { tbl = t; break; }
                              } catch (e) {}
                            }
                            if (tbl) break;
                          } catch (e) {}
                        }
                      } catch (e) {}
                    }
                    if (!tbl) {
                      try { console.info(LOG_PREFIX, 'findPeriodEndDate: no owning table found for floating candidate', { raw: candidate.raw, columnIndex: candidate.idx }); } catch (e) {}
                      return false;
                    }
                    const rows = Array.from(tbl.querySelectorAll('tr'));
                    let checked = 0;
                    for (let r = 1; r < rows.length && checked < 6; r++) {
                      try {
                        const cell = rows[r].cells && rows[r].cells[candidate.idx];
                        if (!cell) continue;
                        const txt = (cell.textContent || '').trim();
                        if (!txt) continue;
                        checked++;
                        const innerCell = cell.querySelector && cell.querySelector('.DivOverflowNoWrap, .Ellipsis, .Separator');
                        const cellColor = (innerCell && (window.getComputedStyle ? window.getComputedStyle(innerCell).color : innerCell.style && innerCell.style.color)) || (window.getComputedStyle ? window.getComputedStyle(cell).color : cell.style && cell.style.color) || '';
                        const cellBg = (innerCell && (window.getComputedStyle ? window.getComputedStyle(innerCell).backgroundColor : innerCell.style && innerCell.style.backgroundColor)) || (window.getComputedStyle ? window.getComputedStyle(cell).backgroundColor : cell.style && cell.style.backgroundColor) || '';
                        if (isRedColorLocal(cellColor) || isRedColorLocal(cellBg)) return true;
                      } catch (e) { /* ignore row errors */ }
                    }
                  } catch (e) {}
                  return false;
                };

                // prefer latest date among candidates that are black/dark gray (not red).
                // This block used to sit above the helper definitions, so the
                // columnLooksRed call threw a swallowed TDZ ReferenceError and
                // the branch never selected anything.
                try {
                  // Gather only candidates that have an inline color and where that inline color is black/dark
                  const blackCandidates = candidates.filter(c => {
                    try {
                      if (columnLooksRed(c)) return false;
                      if (!c.inlineColor) return false;
                      return isBlackish(c.inlineColor.toString());
                    } catch(e){ return false; }
                  });
                  if (blackCandidates.length) {
                    // pick the latest calendar date among blackCandidates
                    let best = null; let bestTime = -Infinity;
                    for (const c of blackCandidates) {
                      try {
                        const dt = new Date(inferredYear, (c.month||1)-1, c.day||1).getTime();
                        if (dt > bestTime) { bestTime = dt; best = c; }
                      } catch(e){}
                    }
                    if (best) {
                      chosen = best;
                      try { console.info(LOG_PREFIX, 'findPeriodEndDate: chose latest black candidate', { raw: chosen.raw, columnIndex: chosen.idx, inferredYear }); } catch(e){}
                    }
                  }
                } catch(e){}

                if (!chosen) {
                  if (sumIdx !== null) {
                    for (const c of candidates) {
                      if (c.idx >= sumIdx) continue;
                      if (columnLooksRed(c)) {
                        try { console.info(LOG_PREFIX, 'findPeriodEndDate: skipping floating candidate because column looks red', { raw: c.raw, columnIndex: c.idx, color: c.color, bgColor: c.bgColor }); } catch (e) {}
                        continue;
                      }
                      chosen = c; break;
                    }
                  }
                }
                if (!chosen) {
                  for (const c of candidates) {
                    if (columnLooksRed(c)) {
                      try { console.info(LOG_PREFIX, 'findPeriodEndDate: skipping floating candidate because column looks red', { raw: c.raw, columnIndex: c.idx, color: c.color, bgColor: c.bgColor }); } catch (e) {}
                      continue;
                    }
                    chosen = c; break;
                  }
                }
                if (!chosen) chosen = candidates[0];

                try {
                  let inferredYear = (new Date()).getFullYear();
                  try {
                    const allTextNodes = [];
                    for (const d2 of docs) {
                      try { allTextNodes.push(...Array.from(d2.querySelectorAll('input,span,div')).map(x => (x.value||x.textContent||'').trim())); } catch (e) {}
                    }
                    const explicit = allTextNodes.find(v => /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(v));
                    if (explicit) {
                      const d = parseDateFlexible(explicit);
                      if (d) inferredYear = d.getFullYear();
                    }
                  } catch (e) {}

                  // Enforce: if any header candidates have inlineColor that is blackish,
                  // choose the latest date among those headers and override `chosen`.
                  try {
                    const inlineBlack = candidates.filter(c => c && c.inlineColor && isBlackish(c.inlineColor.toString()));
                    if (inlineBlack.length) {
                      let bestH = null; let bestT = -Infinity;
                      for (const c of inlineBlack) {
                        try {
                          if (!c.day || !c.month) continue;
                          const dtVal = new Date(inferredYear, (c.month||1)-1, c.day||1).getTime();
                          if (dtVal > bestT) { bestT = dtVal; bestH = c; }
                        } catch(e){}
                      }
                      if (bestH) {
                        chosen = bestH;
                        try { console.info(LOG_PREFIX, 'findPeriodEndDate: overriding chosen with latest inline-black header', { raw: chosen.raw, columnIndex: chosen.idx }); } catch(e){}
                      }
                    }
                  } catch(e){}
                  const dt = new Date(inferredYear, (chosen.month || 1) - 1, chosen.day || 1);
                  console.info(LOG_PREFIX, 'findPeriodEndDate: detected end by floating header (chosen)', { raw: chosen.raw, columnIndex: chosen.idx, date: dt });
                  try { console.info(LOG_PREFIX, 'findPeriodEndDate: floating chosen json', JSON.stringify({ raw: chosen.raw, columnIndex: chosen.idx, date: dt.toISOString(), color: chosen.color, bgColor: chosen.bgColor, classes: chosen.classes, nearestBg: chosen.nearestBg, outer: chosen.outer })); } catch (e) {}
                  return dt;
                } catch (e) {}
              }
            }
        } catch (e) {}
        if (candidateTables.length) {
          let best = null;
          let bestScore = 0;
          candidateTables.forEach((t) => {
            try {
              const txt = (t.innerText || '').trim();
              let score = 0;
              if (dateTokenRe.test(txt)) score += 10;
              // count day tokens
              const dayMatches = txt.match(/\b\d{1,2}[\/\.]\d{1,2}\b/g) || [];
              score += dayMatches.length;
              // prefer tables with multiple columns/rows
              const cols = t.querySelectorAll('tr:first-child th, tr:first-child td').length || 0;
              const rows = t.querySelectorAll('tr').length || 0;
              score += Math.min(10, cols) + Math.min(5, rows);
              if (score > bestScore) { bestScore = score; best = t; }
            } catch (e) {}
          });
          try { console.info(LOG_PREFIX, 'findPeriodEndDate: candidateTables count', candidateTables.length, 'bestScore', bestScore, 'bestTable', !!best); } catch (e) {}
          tbl2 = best || candidateTables[0];
        } else {
          try { console.info(LOG_PREFIX, 'findPeriodEndDate: no candidateTables found under tableRoot'); } catch (e) {}
          // If none found under the chosen tableRoot, fall back to searching all reachable documents
          try {
            const docs = getAllDocuments();
            const allTables = [];
            for (const d of docs) {
              try { allTables.push(...Array.from(d.querySelectorAll('table'))); } catch (e) {}
            }
            if (allTables.length) {
              // Score tables across documents similarly to the candidateTables path
              let bestGlobal = null;
              let bestGlobalScore = 0;
              allTables.forEach((t) => {
                try {
                  const txt = (t.innerText || '').trim();
                  let score = 0;
                  if (dateTokenRe.test(txt)) score += 10;
                  const dayMatches = txt.match(/\b\d{1,2}[\/\.]\d{1,2}\b/g) || [];
                  score += dayMatches.length;
                  const cols = t.querySelectorAll('tr:first-child th, tr:first-child td').length || 0;
                  const rows = t.querySelectorAll('tr').length || 0;
                  score += Math.min(10, cols) + Math.min(5, rows);
                  if (score > bestGlobalScore) { bestGlobalScore = score; bestGlobal = t; }
                } catch (e) {}
              });
              tbl2 = bestGlobal || allTables[0];
            } else {
              tbl2 = tableRoot.querySelector('table');
            }
          } catch (e) {
            tbl2 = tableRoot.querySelector('table');
          }
        }
        try { console.info(LOG_PREFIX, 'findPeriodEndDate: table chosen for Sum-left scan', tbl2 ? { tag: tbl2.tagName, rows: (tbl2.querySelectorAll && tbl2.querySelectorAll('tr').length) || 0 } : null); } catch (e) {}

        // New heuristic: locate a header cell labelled 'Sum' (or variants) and scan left
        // from that column. If a column's displayed text is styled red, skip it;
        // the first non-red column to the left is assumed to be the last workday.
        try {
          if (tbl2) {
            let headerRow = tbl2.querySelector('thead tr') || tbl2.querySelector('tr');
            // If the chosen header row looks too small, try a few top rows to find a better header
            try {
              if (headerRow) {
                const topRows = Array.from(tbl2.querySelectorAll('tr'));
                if ((headerRow.querySelectorAll('th,td').length || 0) < 2) {
                  for (let ri = 0; ri < Math.min(6, topRows.length); ri++) {
                    const r = topRows[ri];
                    if ((r.querySelectorAll('th,td').length || 0) > 2) { headerRow = r; break; }
                  }
                }
              }
            } catch (e) {}
            if (headerRow) {
              try {
                // Collect header text and computed color for debugging
                const hdrCells = Array.from(headerRow.querySelectorAll('th,td'));
                const headerInfo = hdrCells.map((h, ci) => {
                  try {
                    const inner = h.querySelector && h.querySelector('.DivOverflowNoWrap, .Ellipsis, .Separator');
                    const rawText = (inner && ((inner.dataset && inner.dataset.originaltext) || inner.getAttribute && inner.getAttribute('title') || inner.textContent || inner.innerHTML)) || (h && (h.getAttribute && h.getAttribute('title') || h.textContent || h.innerHTML)) || '';
                    let color = '';
                    try { color = (window.getComputedStyle ? window.getComputedStyle(inner || h).color : (inner && inner.style && inner.style.color) || (h && h.style && h.style.color)) || ''; } catch (e) { color = ''; }
                    return { idx: (h.cellIndex || ci), text: String(rawText).replace(/<br\s*\/?>(\s*)/gi, ' ').trim().slice(0,120), color };
                  } catch (e) { return { idx: ci, text: '', color: '' }; }
                });
                try { console.info(LOG_PREFIX, 'findPeriodEndDate: header info', headerInfo); } catch (e) {}
              } catch (e) {}
              const headers = Array.from(headerRow.querySelectorAll('th,td'));
              const sumIdx = headers.findIndex(h => /\b(sum|summa|\u03a3)\b/i.test((h.textContent||'').trim()));
                if (sumIdx > 0) {
                // iterate left from sumIdx - 1, look for a non-red column
                for (let ci = sumIdx - 1; ci >= 0; ci--) {
                  try {
                    const headerCell = headers[ci];
                    // prefer inner DivOverflowNoWrap / Ellipsis / Separator when reading color/text
                    let headerInner = null;
                    try { headerInner = headerCell && headerCell.querySelector && headerCell.querySelector('.DivOverflowNoWrap, .Ellipsis, .Separator'); } catch (e) { headerInner = null; }
                    // quick check on header color (prefer inner element if present)
                    const headerColor = (headerInner && (window.getComputedStyle ? window.getComputedStyle(headerInner).color : headerInner.style && headerInner.style.color)) || (headerCell && (window.getComputedStyle ? window.getComputedStyle(headerCell).color : headerCell.style && headerCell.style.color));
                    let colIsRed = isRedColor(headerColor);

                    // If header not red, inspect up to first 6 data rows in that column
                    if (!colIsRed) {
                      const rows = Array.from(tbl2.querySelectorAll('tr'));
                      let checked = 0;
                      for (let r = 1; r < rows.length && checked < 6; r++) {
                        const cell = rows[r].cells && rows[r].cells[ci];
                        if (!cell) continue;
                        const txt = (cell.textContent || '').trim();
                        if (!txt) continue;
                        checked++;
                        // prefer inner styled element inside the data cell
                        let cellInner = null;
                        try { cellInner = cell.querySelector && cell.querySelector('.DivOverflowNoWrap, .Ellipsis, .Separator'); } catch (e) { cellInner = null; }
                        const cellColor = (cellInner && (window.getComputedStyle ? window.getComputedStyle(cellInner).color : cellInner.style && cellInner.style.color)) || (window.getComputedStyle ? window.getComputedStyle(cell).color : cell.style && cell.style.color);
                        if (isRedColor(cellColor)) {
                          colIsRed = true;
                          break;
                        }
                      }
                    }

                    if (!colIsRed) {
                      // Try to parse a date token from the header cell, its attributes, or inner HTML
                      let txt = '';
                      try {
                        const sourceEl = (headerInner && headerInner.nodeType) ? headerInner : headerCell;
                        txt = (sourceEl && (sourceEl.textContent || sourceEl.getAttribute && sourceEl.getAttribute('title') || sourceEl.dataset && sourceEl.dataset.originaltext || sourceEl.innerHTML)) || '';
                        // Replace any <br> tags with spaces for parsing
                        txt = String(txt).replace(/<br\s*\/?>(\s*)/gi, ' ');
                        txt = txt.trim();
                      } catch (e) { txt = (headerCell && headerCell.textContent) || ''; }
                      const m = dateTokenRe.exec(txt);
                      if (m) {
                        // infer year similar to other heuristics
                        let inferredYear = (new Date()).getFullYear();
                        try {
                          const explicit = Array.from(document.querySelectorAll('input,span,div')).map(n => (n.value||n.textContent||'').trim()).find(v => /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(v));
                          if (explicit) {
                            const d = parseDateFlexible(explicit);
                            if (d) inferredYear = d.getFullYear();
                          } else {
                            const bodyMatch = (document.body && document.body.innerText) || '';
                            const bm = /(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4})/.exec(bodyMatch);
                            if (bm) {
                              const d = parseDateFlexible(bm[1]);
                              if (d) inferredYear = d.getFullYear();
                            }
                          }
                        } catch (e) {}
                        const dt = new Date(inferredYear, Number(m[2]) - 1, Number(m[1]));
                        console.info(LOG_PREFIX, 'findPeriodEndDate: detected end by Sum-left red-scan', { headerText: txt, columnIndex: ci, date: dt });
                        return dt;
                      }
                      // if header doesn't include explicit date token, attempt to find any day token inside header or first data cell
                      try {
                        const maybe = (headerCell && (headerCell.textContent || headerCell.getAttribute('title') || headerCell.dataset && headerCell.dataset.originaltext || headerCell.innerHTML)) || '';
                        const maybeClean = String(maybe).replace(/<br\s*\/?>(\s*)/gi, ' ').trim();
                        const dm = /\b(\d{1,2})\b/.exec(maybeClean);
                        if (dm) {
                          let inferredYear = (new Date()).getFullYear();
                          try {
                            const explicit = Array.from(document.querySelectorAll('input,span,div')).map(n => (n.value||n.textContent||'').trim()).find(v => /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(v));
                            if (explicit) {
                              const d = parseDateFlexible(explicit);
                              if (d) inferredYear = d.getFullYear();
                            }
                          } catch (e) {}
                          const day = Number(dm[1]);
                          // attempt to infer month by looking rightmost date-like header before sum
                          let month = null;
                          for (let k = ci; k >= Math.max(0, ci - 8); k--) {
                            try {
                              const hhRaw = headers[k] && (headers[k].textContent || headers[k].getAttribute('title') || headers[k].dataset && headers[k].dataset.originaltext || headers[k].innerHTML) || '';
                              const hh = String(hhRaw).replace(/<br\s*\/?>(\s*)/gi, ' ').trim();
                              const mm = /\b(\d{1,2})[\/\.](\d{1,2})\b/.exec(hh);
                              if (mm) { month = Number(mm[2]); break; }
                            } catch (e) {}
                          }
                          if (!month) month = (new Date()).getMonth() + 1;
                          const dt = new Date(inferredYear, month - 1, day);
                          console.info(LOG_PREFIX, 'findPeriodEndDate: detected end by Sum-left day-scan', { headerText: maybe, columnIndex: ci, date: dt });
                          return dt;
                        }
                      } catch (e) {}
                    }
                  } catch (e) {
                    // continue to next column on any error
                  }
                }
              }
            }
          }
        } catch (e) {
          // ignore Sum-left heuristic errors
        }

        // Fallback: if Sum-left didn't return, try scanning header cells for date tokens
        try {
          if (tbl2) {
            const headerRowCandidates = Array.from(tbl2.querySelectorAll('tr')).slice(0, 6);
            let headerCells = [];
            for (const r of headerRowCandidates) {
              const cols = Array.from(r.querySelectorAll('th,td'));
              if (cols.length > headerCells.length) headerCells = cols;
            }
            if (headerCells.length) {
              // collect date-like header cells with their column index
              const hdrs = headerCells.map((h, idx) => {
                let txt = '';
                try { txt = (h.textContent || h.getAttribute('title') || h.dataset && h.dataset.originaltext || h.innerHTML) || ''; txt = String(txt).replace(/<br\s*\/?>(\s*)/gi, ' ').trim(); } catch (e) { txt = (h.textContent||'').trim(); }
                const m = dateTokenRe.exec(txt);
                return { el: h, idx, txt, hasDate: !!m };
              }).filter(x => x.hasDate);

              // iterate right-to-left across detected date headers and return first non-red column
              for (let i = hdrs.length - 1; i >= 0; i--) {
                const info = hdrs[i];
                const ci = info.idx;
                let colIsRed = false;
                try {
                  const headerColor = info.el && (window.getComputedStyle ? window.getComputedStyle(info.el).color : info.el.style && info.el.style.color);
                  colIsRed = isRedColor(headerColor);
                } catch (e) {}
                if (!colIsRed) {
                  // inspect a few rows for red text
                  try {
                    const rows = Array.from(tbl2.querySelectorAll('tr'));
                    let checked = 0;
                    for (let r = 1; r < rows.length && checked < 6; r++) {
                      const cell = rows[r].cells && rows[r].cells[ci];
                      if (!cell) continue;
                      const txt = (cell.textContent || '').trim();
                      if (!txt) continue;
                      checked++;
                      const cellColor = window.getComputedStyle ? window.getComputedStyle(cell).color : cell.style && cell.style.color;
                      if (isRedColor(cellColor)) { colIsRed = true; break; }
                    }
                  } catch (e) {}
                }
                if (!colIsRed) {
                  // parse date from header text
                  const m2 = dateTokenRe.exec(info.txt);
                  if (m2) {
                    let inferredYear = (new Date()).getFullYear();
                    try {
                      const explicit = Array.from(document.querySelectorAll('input,span,div')).map(n => (n.value||n.textContent||'').trim()).find(v => /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(v));
                      if (explicit) {
                        const d = parseDateFlexible(explicit);
                        if (d) inferredYear = d.getFullYear();
                      }
                    } catch (e) {}
                    const dt = new Date(inferredYear, Number(m2[2]) - 1, Number(m2[1]));
                    console.info(LOG_PREFIX, 'findPeriodEndDate: detected end by header-scan fallback', { headerText: info.txt, columnIndex: ci, date: dt });
                    return dt;
                  }
                }
              }
            }
          }
        } catch (e) {
          // ignore fallback errors
        }
        if (matches.length) {
          // Infer year from any explicit dd/mm/yyyy found on page or in nearby 'Datum i perioden' input
          let inferredYear = (new Date()).getFullYear();
          try {
            const explicit = Array.from(document.querySelectorAll('input,span,div')).map(n => (n.value||n.textContent||'').trim()).find(v => /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(v));
            if (explicit) {
              const d = parseDateFlexible(explicit);
              if (d) inferredYear = d.getFullYear();
            } else {
              // try previous heuristic: look for any dd/mm/yyyy anywhere
              const bodyMatch = (document.body && document.body.innerText) || '';
              const m = /(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4})/.exec(bodyMatch);
              if (m) {
                const d = parseDateFlexible(m[1]);
                if (d) inferredYear = d.getFullYear();
              }
            }
          } catch (e) {}
          // Build candidate dates for all matches and choose the latest local date
          try {
            const dts = matches.map(ch => new Date(inferredYear, ch.month - 1, ch.day));
            // Normalize by local date value (strip time)
            const maxDt = dts.reduce((a,b) => (a > b ? a : b));
            console.info(LOG_PREFIX, 'findPeriodEndDate: parsed table matches', { matchesCount: matches.length, inferredYear, maxDt });
            return maxDt;
          } catch (e) {
            const chosen = matches[matches.length - 1];
            const dt = new Date(inferredYear, chosen.month - 1, chosen.day);
            console.info(LOG_PREFIX, 'findPeriodEndDate: fallback parsed table match', { text: chosen.text, day: chosen.day, month: chosen.month, year: inferredYear, dt, matchesCount: matches.length });
            return dt;
          }
        }
      } catch (e) {
        // ignore
      }

      // Fallback: search body text
      const body = (document.body && document.body.innerText) || '';
      let m = dateRangeIso.exec(body);
      if (m) {
        console.info(LOG_PREFIX, 'findPeriodEndDate: matched iso range in body', m[0].slice(0,200));
        return parseDateFlexible(m[2]);
      }
      m = dateRangeSlashed.exec(body);
      if (m) {
        console.info(LOG_PREFIX, 'findPeriodEndDate: matched slashed range in body', m[0].slice(0,200));
        return parseDateFlexible(m[2]);
      }
      m = monthNameRange.exec(body);
      if (m) {
        console.info(LOG_PREFIX, 'findPeriodEndDate: matched month name range in body', m[0].slice(0,200));
        return parseDateFlexible(m[2]);
      }
      // Same-origin frames: attempt the same heuristics inside each frame (handles Agresso iframe nesting)
      try {
        for (let fi = 0; fi < (window.frames && window.frames.length || 0); fi++) {
          try {
            const fr = window.frames[fi];
            const fd = fr.document;
            if (!fd) continue;
            // Look for DivOverflowNoWrap-style date headers first
            const candidates = Array.from(fd.querySelectorAll('.DivOverflowNoWrap, .Ellipsis, .Separator'));
            const dateNodes = candidates.filter((n) => {
              try {
                const t = (n.textContent || '').trim();
                const title = n.getAttribute && (n.getAttribute('title') || '');
                const data = n.dataset && n.dataset.originaltext ? n.dataset.originaltext : '';
                const inner = n.innerHTML || '';
                return dateTokenRe.test(t) || dateTokenRe.test(title) || dateTokenRe.test(data) || dateTokenRe.test(inner);
              } catch (e) { return false; }
            });

            if (dateNodes.length) {
              try { console.info(LOG_PREFIX, 'findPeriodEndDate: frame dateNodes count', fi, dateNodes.length); } catch (e) {}
              // Group by table
              const tablesMap = new Map();
              dateNodes.forEach((n) => {
                try {
                  const tbl = n.closest && n.closest('table');
                  if (!tbl) return;
                  if (!tablesMap.has(tbl)) tablesMap.set(tbl, []);
                  tablesMap.get(tbl).push(n);
                } catch (e) {}
              });

              // If no tables found from these nodes, try a broader search for nodes
              if (tablesMap.size === 0) {
                try {
                  const extra = Array.from(fd.querySelectorAll('[data-originaltext], [title]'))
                    .filter(el => {
                      try {
                        const v = (el.dataset && el.dataset.originaltext) || el.getAttribute('title') || el.innerHTML || '';
                        return dateTokenRe.test(String(v));
                      } catch (e) { return false; }
                    });
                  try { console.info(LOG_PREFIX, 'findPeriodEndDate: frame extra candidate count', fi, extra.length); } catch (e) {}
                  extra.forEach((n) => {
                    try {
                      const tbl = n.closest && n.closest('table');
                      if (!tbl) return;
                      if (!tablesMap.has(tbl)) tablesMap.set(tbl, []);
                      tablesMap.get(tbl).push(n);
                    } catch (e) {}
                  });
                  // Spatial fallback: if still no tables mapped, try matching each date node
                  // to any table in the frame by comparing the node's horizontal center
                  // with header cell bounding rects.
                  if (tablesMap.size === 0) {
                    try {
                      const allTables = Array.from(fd.querySelectorAll('table'));
                      if (allTables.length) {
                        for (const n of extra.length ? extra : nodes) {
                          try {
                            const srcRect = n.getBoundingClientRect ? n.getBoundingClientRect() : null;
                            if (!srcRect) continue;
                            const srcX = srcRect.left + (srcRect.width || 0) / 2;
                            for (const t of allTables) {
                              try {
                                const hdr = t.querySelector('thead tr') || t.querySelector('tr');
                                if (!hdr) continue;
                                const hdrs = Array.from(hdr.querySelectorAll('th,td'));
                                for (let i = 0; i < hdrs.length; i++) {
                                  try {
                                    const r = hdrs[i].getBoundingClientRect();
                                    if (srcX >= (r.left - 2) && srcX <= (r.right + 2)) {
                                      if (!tablesMap.has(t)) tablesMap.set(t, []);
                                      tablesMap.get(t).push(n);
                                      throw 'mapped';
                                    }
                                  } catch (e) {
                                    if (e === 'mapped') break;
                                  }
                                }
                                // if mapped, move to next node
                                if (tablesMap.has(t) && tablesMap.get(t).indexOf(n) >= 0) break;
                              } catch (e) {}
                            }
                          } catch (e) {}
                        }
                      }
                    } catch (e) {}
                  }
                } catch (e) {}
              }

              for (const [tbl, nodes] of tablesMap.entries()) {
                try {
                  // New: try mapping date DIV nodes directly to their nearest th/td
                  for (const n of nodes) {
                    try {
                      const headerCellDirect = n.closest && n.closest('th,td');
                      if (headerCellDirect && headerCellDirect.cellIndex >= 0) {
                        // prefer date token on the node (handles <div class="DivOverflowNoWrap" elements)
                        let txtRaw = '';
                        try { txtRaw = (n.getAttribute && (n.getAttribute('title') || '')) || n.dataset && n.dataset.originaltext || (n.textContent || n.innerHTML || ''); } catch (e) { txtRaw = (n.textContent||n.innerHTML||''); }
                        txtRaw = String(txtRaw).replace(/<br\s*\/?>(\s*)/gi, ' ').trim();
                        const m = dateTokenRe.exec(txtRaw);
                        if (m) {
                          let inferredYear = (new Date()).getFullYear();
                          try {
                            const explicit = Array.from(fd.querySelectorAll('input,span,div')).map(x => (x.value||x.textContent||'').trim()).find(v => /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(v));
                            if (explicit) {
                              const d = parseDateFlexible(explicit);
                              if (d) inferredYear = d.getFullYear();
                            }
                          } catch (e) {}
                          const dt = new Date(inferredYear, Number(m[2]) - 1, Number(m[1]));
                          console.info(LOG_PREFIX, 'findPeriodEndDate: mapped date-node to header cell in frame', { frame: fi, nodeText: txtRaw, columnIndex: headerCellDirect.cellIndex, date: dt });
                          return dt;
                        }
                      }
                    } catch (e) {}
                  }
                  // find header row/cells
                  const headerRow = tbl.querySelector('thead tr') || tbl.querySelector('tr');
                  const headers = headerRow ? Array.from(headerRow.querySelectorAll('th,td')) : [];
                  const sumIdx = headers.findIndex(h => /\b(sum|summa|\u03a3)\b/i.test((h.textContent||'').trim()));
                  const frGetStyle = (el) => { try { return fr.getComputedStyle ? fr.getComputedStyle(el).color : (el.style && el.style.color) || ''; } catch (e) { return ''; } };
                  const isRedInFrame = (colorStr) => {
                    return isRedColor(colorStr);
                  };

                  // Spatial mapping: find which header column horizontally matches a floating node
                  const getColumnIndexByX = (tblNode, srcNode) => {
                    try {
                      const srcRect = srcNode.getBoundingClientRect();
                      const srcX = srcRect.left + srcRect.width / 2;
                      const hdrRow = tblNode.querySelector('thead tr') || tblNode.querySelector('tr');
                      if (!hdrRow) return -1;
                      const hdrs = Array.from(hdrRow.querySelectorAll('th,td'));
                      for (let i = 0; i < hdrs.length; i++) {
                        try {
                          const r = hdrs[i].getBoundingClientRect();
                          if (srcX >= (r.left - 2) && srcX <= (r.right + 2)) return i;
                        } catch (e) { continue; }
                      }
                    } catch (e) {}
                    return -1;
                  };

                  if (sumIdx > 0) {
                    for (let ci = sumIdx - 1; ci >= 0; ci--) {
                      try {
                        const headerCell = headers[ci];
                        const headerColor = headerCell && frGetStyle(headerCell);
                        let colIsRed = isRedInFrame(headerColor);
                        if (!colIsRed) {
                          const rows = Array.from(tbl.querySelectorAll('tr'));
                          let checked = 0;
                          for (let r = 1; r < rows.length && checked < 6; r++) {
                            const cell = rows[r].cells && rows[r].cells[ci];
                            if (!cell) continue;
                            const txt = (cell.textContent || '').trim();
                            if (!txt) continue;
                            checked++;
                            const cellColor = frGetStyle(cell);
                            if (isRedInFrame(cellColor)) { colIsRed = true; break; }
                          }
                        }
                        if (!colIsRed) {
                          // parse date from header cell (title, data-originaltext, innerHTML)
                          let txt = '';
                          try { txt = (headerCell && (headerCell.textContent || headerCell.getAttribute('title') || headerCell.dataset && headerCell.dataset.originaltext || headerCell.innerHTML)) || ''; txt = String(txt).replace(/<br\s*\/?>(\s*)/gi, ' ').trim(); } catch (e) { txt = (headerCell && headerCell.textContent) || ''; }
                          const m = dateTokenRe.exec(txt);
                          if (m) {
                            let inferredYear = (new Date()).getFullYear();
                            try {
                              const explicit = Array.from(fd.querySelectorAll('input,span,div')).map(n => (n.value||n.textContent||'').trim()).find(v => /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(v));
                              if (explicit) {
                                const d = parseDateFlexible(explicit);
                                if (d) inferredYear = d.getFullYear();
                              }
                            } catch (e) {}
                            const dt = new Date(inferredYear, Number(m[2]) - 1, Number(m[1]));
                            console.info(LOG_PREFIX, 'findPeriodEndDate: detected end in frame by Sum-left', { frame: fi, headerText: txt, columnIndex: ci, date: dt });
                            return dt;
                          }
                        }
                      } catch (e) {}
                    }
                  }

                  // fallback: examine date-like nodes in this table, choose rightmost non-red
                  // Also attempt spatial mapping: map floating date nodes to columns by X coordinate
                  for (const dn of nodes) {
                    try {
                      let raw = '';
                      try { raw = (dn.getAttribute && (dn.getAttribute('title') || '')) || dn.dataset && dn.dataset.originaltext || (dn.textContent || dn.innerHTML || ''); } catch (e) { raw = (dn.textContent||dn.innerHTML||''); }
                      raw = String(raw).replace(/<br\s*\/?>(\s*)/gi, ' ').trim();
                      const m = dateTokenRe.exec(raw);
                      if (!m) continue;
                      let colIdx = -1;
                      try {
                        const maybeCell = dn.closest && dn.closest('th,td');
                        if (maybeCell && typeof maybeCell.cellIndex === 'number') colIdx = maybeCell.cellIndex;
                        if (colIdx < 0) colIdx = getColumnIndexByX(tbl, dn);
                      } catch (e) { colIdx = getColumnIndexByX(tbl, dn); }
                      if (colIdx >= 0) {
                        let inferredYear = (new Date()).getFullYear();
                        try {
                          const explicit = Array.from(fd.querySelectorAll('input,span,div')).map(n => (n.value||n.textContent||'').trim()).find(v => /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(v));
                          if (explicit) {
                            const d = parseDateFlexible(explicit);
                            if (d) inferredYear = d.getFullYear();
                          }
                        } catch (e) {}
                        const dt = new Date(inferredYear, Number(m[2]) - 1, Number(m[1]));
                        console.info(LOG_PREFIX, 'findPeriodEndDate: mapped node->column by geometry in frame', { frame: fi, raw, columnIndex: colIdx, date: dt });
                        return dt;
                      }
                    } catch (e) {}
                  }
                  const headerCells = headers.length ? headers : Array.from(tbl.querySelectorAll('th,td'));
                  const hdrs = [];
                  headerCells.forEach((h, idx) => {
                    try {
                      let txt = (h.textContent || h.getAttribute('title') || h.dataset && h.dataset.originaltext || h.innerHTML) || '';
                      txt = String(txt).replace(/<br\s*\/?>(\s*)/gi, ' ').trim();
                      if (dateTokenRe.test(txt)) hdrs.push({ el: h, idx, txt });
                    } catch (e) {}
                  });
                  for (let i = hdrs.length - 1; i >= 0; i--) {
                    const info = hdrs[i];
                    const ci = info.idx;
                    let colIsRed = false;
                    try { colIsRed = isRedInFrame(frGetStyle(info.el)); } catch (e) {}
                    if (!colIsRed) {
                      try {
                        const rows = Array.from(tbl.querySelectorAll('tr'));
                        let checked = 0;
                        for (let r = 1; r < rows.length && checked < 6; r++) {
                          const cell = rows[r].cells && rows[r].cells[ci];
                          if (!cell) continue;
                          const txt = (cell.textContent || '').trim();
                          if (!txt) continue;
                          checked++;
                          const cellColor = frGetStyle(cell);
                          if (isRedInFrame(cellColor)) { colIsRed = true; break; }
                        }
                      } catch (e) {}
                    }
                    if (!colIsRed) {
                      const m2 = dateTokenRe.exec(info.txt);
                      if (m2) {
                        let inferredYear = (new Date()).getFullYear();
                        try {
                          const explicit = Array.from(fd.querySelectorAll('input,span,div')).map(n => (n.value||n.textContent||'').trim()).find(v => /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(v));
                          if (explicit) {
                            const d = parseDateFlexible(explicit);
                            if (d) inferredYear = d.getFullYear();
                          }
                        } catch (e) {}
                        const dt = new Date(inferredYear, Number(m2[2]) - 1, Number(m2[1]));
                        console.info(LOG_PREFIX, 'findPeriodEndDate: detected end in frame by header fallback', { frame: fi, headerText: info.txt, columnIndex: ci, date: dt });
                        return dt;
                      }
                    }
                  }
                } catch (e) {}
              }
            }
          } catch (e) {
            // cross-origin or access error - ignore
          }
        }
      } catch (e) {}
      // If not found in this document, try same-origin iframes (Agresso may render inside frames)
      try {
        for (let i = 0; i < (window.frames && window.frames.length || 0); i++) {
          try {
            const fr = window.frames[i];
            const fd = fr.document;
            if (!fd) continue;
            const fbody = (fd.body && fd.body.innerText) || '';
            let fm = dateRangeIso.exec(fbody);
            if (fm) {
              console.info(LOG_PREFIX, 'findPeriodEndDate: matched iso range in iframe body', fm[0].slice(0,200));
              return parseDateFlexible(fm[2]);
            }
            fm = dateRangeSlashed.exec(fbody);
            if (fm) {
              console.info(LOG_PREFIX, 'findPeriodEndDate: matched slashed range in iframe body', fm[0].slice(0,200));
              return parseDateFlexible(fm[2]);
            }
            fm = monthNameRange.exec(fbody);
            if (fm) {
              console.info(LOG_PREFIX, 'findPeriodEndDate: matched month name range in iframe body', fm[0].slice(0,200));
              return parseDateFlexible(fm[2]);
            }
          } catch (e) {
            // cross-origin or other access errors - ignore
          }
        }
      } catch (e) {}

      // NOTE: a former fallback read the 'Datum i perioden' input here and
      // returned its value as the period end. That input holds a date INSIDE
      // the period (typically the first day), so it produced false "last
      // day" alarms for the whole week. Returning null is strictly better
      // than returning a wrong date — the user can always set a manual
      // override for exotic layouts.
    } catch (e) {
      // ignore
    }
    return null;
  }

  function buildDebugReport() {
    try {
      const heading = Array.from(document.querySelectorAll('h1,h2,h3,legend,div,span,th'))
        .find(el => /Arbetstimmar|Daglig tidregistrering|Tidrapport/i.test(el.textContent||''));
      const tbl = heading ? (heading.closest('section') || heading.closest('fieldset') || heading.closest('table') || document.body).querySelector('table') : null;
      const headerRow = tbl ? (tbl.querySelector('tr') || tbl.querySelector('thead tr')) : null;
      const cells = headerRow ? Array.from(headerRow.querySelectorAll('th,td')) : [];
      const headerCells = cells.map(c => ({ text: (c.innerText||'').trim(), html: (c.innerHTML||'').trim(), outer: (c.outerHTML||'').slice(0,500), attrs: Array.from(c.attributes||[]).map(a=>({name:a.name,value:a.value})) }));

      const attrMatches = [];
      if (tbl) {
        tbl.querySelectorAll('*').forEach(el=>{
          Array.from(el.attributes||[]).forEach(a=>{
            if (/\d{1,2}[\/\.]\d{1,2}/.test(a.value)) {
              attrMatches.push({ tag: el.tagName, attr: a.name, value: a.value, outer: (el.outerHTML||'').slice(0,300) });
            }
          });
        });
      }

      const textMatches = [];
      if (tbl) {
        tbl.querySelectorAll('*').forEach(el=>{
          const t = (el.textContent||'').trim();
          if (/\b\d{1,2}[\/\.]\d{1,2}\b/.test(t)) textMatches.push({ tag: el.tagName, text: t.slice(0,200), outer: (el.outerHTML||'').slice(0,200) });
        });
      }

      const datumInput = (() => {
        const node = Array.from(document.querySelectorAll('label,div,span,th,td')).find(n => /Datum i perioden/i.test(n.textContent || ''));
        if (!node) return null;
        const input = node.closest('tr')?.querySelector('input') || node.querySelector('input') || node.nextElementSibling?.querySelector('input') || document.querySelector('input[type="text"], input[type="date"]');
        return input ? { value: input.value || input.getAttribute('value') || null, outer: input.outerHTML } : null;
      })();

      return { heading: heading ? (heading.textContent||'').trim() : null, tableFound: !!tbl, headerCells, attrMatches: attrMatches.slice(0,50), textMatches: textMatches.slice(0,50), datumInput };
    } catch (e) {
      return { error: String(e) };
    }
  }

  function localIsoDate(d) {
    try {
      if (!d || !d.getFullYear) return null;
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${da}`;
    } catch (e) { return null; }
  }

  function showPeriodNotification(endDate) {
    // Respect user preference for reminder
    try {
      const enabled = getReminderEnabled();
      console.info(LOG_PREFIX, 'showPeriodNotification: reminder enabled?', enabled);
      if (!enabled) return;
    } catch (e) {}

    const lastNotified = settings.period_notify_date || null;
    const endIso = localIsoDate(endDate) || endDate.toISOString().slice(0,10);
    console.info(LOG_PREFIX, 'showPeriodNotification: endIso', endIso, 'lastNotified', lastNotified);
    // If the report status is already 'Klar', skip showing any notification/UI.
    try {
      if (isReportStatusKlar()) {
        try { console.info(LOG_PREFIX, 'showPeriodNotification: status is Klar, skipping notification entirely'); } catch (e) {}
        return;
      }
    } catch (e) {}
    if (lastNotified === endIso) {
      // Already stored as notified — ensure the visual indicator is applied
      try { console.info(LOG_PREFIX, 'showPeriodNotification: already notified, enforcing UI highlight'); } catch (e) {}
      // If the report status is already 'Klar', do not enforce the highlight
      try {
        if (isReportStatusKlar()) {
          try { console.info(LOG_PREFIX, 'showPeriodNotification: status is Klar, skipping UI enforcement'); } catch (e) {}
          return;
        }
      } catch (e) {}
      try { /* force UI-only highlight without updating storage */ notifyNow(true); } catch (e) {}
      try {
        // Ask the top-level frame to enforce the highlight as well (works via postMessage
        // even across origins; the top frame's content-script will listen and apply).
        if (window.top && window.top !== window) {
          try { window.top.postMessage({ type: 'agresso_period_enforce', endIso: endIso }, '*'); } catch (e) {}
        }
      } catch (e) {}
      return;
    }
    // Instead of using browser notifications (which may be blocked), highlight the
    // autosave timer bar in red and display a clear reminder in the indicator.
    // Function declaration (hoisted): the already-notified fast path above
    // calls notifyNow(true) before this line, which threw a swallowed TDZ
    // ReferenceError when this was a const arrow function.
    function notifyNow(forceUIOnly) {
      const lang = getReminderLang();
      const title = lang === 'en' ? 'Time report reminder' : 'Tidrapport påminnelse';
      // Distinguish "today is the deadline" from "the deadline has passed" —
      // a misleading 'last day' text on overdue reports was a long-standing
      // confusion source.
      const endIsPast = (() => {
        try {
          const t = new Date(); t.setHours(0, 0, 0, 0);
          const e2 = new Date(endDate); e2.setHours(0, 0, 0, 0);
          return e2.getTime() < t.getTime();
        } catch (e) { return false; }
      })();
      const body = endIsPast
        ? (lang === 'en' ? 'The reporting period has ended — submit your time report.' : 'Perioden har passerat – skicka in din tidrapport.')
        : (lang === 'en' ? 'Today is the last day of the period — submit your time report.' : 'Idag är sista dagen för perioden – skicka in din tidrapport.');
      // Declared here (not inside the try below) because the banner calls at
      // the bottom of this function need it — they used to reference it out
      // of scope and silently never created the banner.
      const explanation = endIsPast
        ? (lang === 'en' ? 'Red = the period has ended — submit your time report.' : 'Röd = perioden har passerat — skicka in din tidrapport.')
        : (lang === 'en' ? 'Red = today is the last day — submit your time report.' : 'Röd = idag är sista dagen — skicka in din tidrapport.');

      // Same class of bug as `explanation` above, and the reason the advertised
      // submit banner still never appeared after 1.4.11 "fixed" it: these three
      // were `const`s inside the enforcer try-block below, while every call site
      // sits after that block closes. The calls threw ReferenceError straight
      // into a bare catch. Bound here at function scope, assigned below.
      let createSubmitBanner;
      let removeSubmitBanner;
      let compareTimerModes;

        try {
          // Update the indicator label/subtext and add an explicit explanation
          try {
            try { setIndicator('pending', title, `${body} • ${explanation}`); } catch (e) {}
          } catch (e) {}

          // Ensure the timer bar exists and set it to a red color to indicate urgency.
          // Also set the animation duration to match the current autosave timer remaining time.
          try {
            const bar = ensureTimerBar();
            bar.style.backgroundColor = '#d9534f';
            bar.style.boxShadow = '0 0 6px rgba(217,83,79,0.6)';
            try {
              // Use the same width-based timer as normal mode so behavior matches
              resetTimerBar(getTimerRemainingMs());
            } catch (e) {}
          } catch (e) {}

          // Add a persistent visual marker on the indicator element
          try {
            const indicator = ensureIndicator();
            indicator.classList.add('agresso-period-end');
            // Apply inline styles to ensure visual highlight even if CSS didn't load
            try {
              indicator.style.border = '2px solid rgba(217,83,79,0.9)';
              indicator.style.background = 'linear-gradient(180deg, rgba(36,41,50,0.95), rgba(30,25,28,0.95))';
              const labelEl = indicator.querySelector('.agresso-autosave-label'); if (labelEl) labelEl.style.color = '#fff';
              const subEl = indicator.querySelector('.agresso-autosave-sub'); if (subEl) subEl.style.color = '#ffecec';
            } catch (e) {}
            try { highlightStatusField(true); } catch (e) {}
            
          } catch (e) {}

            // Also attempt to update the top-level document's indicator so the
            // visual highlight is visible when this script runs inside a frame.
            try {
              if (window.top && window.top.document) {
                try {
                  const topDoc = window.top.document;
                  const topInd = topDoc.getElementById(INDICATOR_ID);
                  if (topInd) {
                    topInd.classList.add('agresso-period-end');
                    try { topInd.classList.remove('agresso-saving'); } catch (e) {}
                    try { topInd.classList.remove('agresso-saved'); } catch (e) {}
                    try { topInd.classList.add('agresso-pending'); } catch (e) {}
                    try {
                      const lbl = topInd.querySelector('.agresso-autosave-label');
                      if (lbl) lbl.textContent = title;
                      const subEl = topInd.querySelector('.agresso-autosave-sub');
                      if (subEl) subEl.textContent = body;
                    } catch (e) {}
                    try {
                      const bar = topInd.querySelector('.agresso-autosave-timer');
                      if (bar) {
                        try { bar.classList.add('agresso-period-moving'); try { resetTimerBar(getTimerRemainingMs()); } catch (e2) {} } catch (e) {}
                        bar.style.backgroundColor = '#d9534f';
                        bar.style.boxShadow = '0 0 6px rgba(217,83,79,0.6)';
                      }
                    } catch (e) {}
                    try {
                      topInd.style.border = '2px solid rgba(217,83,79,0.9)';
                      topInd.style.background = 'linear-gradient(180deg, rgba(36,41,50,0.95), rgba(30,25,28,0.95))';
                    } catch (e) {}
                    
                  }
                } catch (e) {}
              }
            } catch (e) {}

          // Immediately refresh subtext with current Status and start periodic refresh
          try { refreshPeriodIndicatorStatus(); } catch (e) {}
          try {
            if (periodStatusRefreshTimer) clearInterval(periodStatusRefreshTimer);
            periodStatusRefreshTimer = window.setInterval(refreshPeriodIndicatorStatus, 2000);
          } catch (e) {}
          // No native system notification — keep visual indicator coloring only.
        } catch (e) {
          // ignore
        }
        try {
          // Inject a forcing CSS override into both current and top documents
              const injectStyle = (doc) => {
            try {
              if (!doc) return;
              const existing = doc.getElementById('agresso-period-end-style');
              if (existing) return;
              const s = doc.createElement('style');
              s.id = 'agresso-period-end-style';
                  s.textContent = `#${INDICATOR_ID} { border: 2px solid rgba(217,83,79,0.9) !important; background: linear-gradient(180deg, rgba(36,41,50,0.95), rgba(30,25,28,0.95)) !important; }
                #${INDICATOR_ID} .agresso-autosave-timer { height: 6px !important; display: block !important; background-color: #d9534f !important; box-shadow: 0 0 6px rgba(217,83,79,0.6) !important; transform-origin: left !important; }
                #${INDICATOR_ID} .agresso-autosave-label, #${INDICATOR_ID} .agresso-autosave-sub { color: #fff !important; }
                /* No CSS animation here; progress is driven via inline width transition from JS */
                #${INDICATOR_ID} .agresso-autosave-timer.agresso-period-moving { /* uses JS width transition */ }
              `;
              (doc.head || doc.body || doc.documentElement).appendChild(s);
            } catch (e) {}
          };

          try { injectStyle(document); } catch (e) {}
          try { if (window.top && window.top.document && window.top !== window) injectStyle(window.top.document); } catch (e) {}

          // Enforce visual highlight on both current and top documents. Do this
          // immediately and at a few short delays to beat any UI updates that
          // would otherwise remove the styling/classes.
          const enforceHighlight = (doc) => {
            try {
              if (!doc) return;
              const ind = doc.getElementById && doc.getElementById(INDICATOR_ID);
              if (!ind) return;
              try { ind.classList.add('agresso-period-end'); } catch (e) {}
              try { ind.classList.remove('agresso-saving'); } catch (e) {}
              try { ind.classList.remove('agresso-saved'); } catch (e) {}
              try { ind.classList.add('agresso-pending'); } catch (e) {}
              try { ind.style.border = '2px solid rgba(217,83,79,0.9)'; } catch (e) {}
              try { ind.style.background = 'linear-gradient(180deg, rgba(36,41,50,0.95), rgba(30,25,28,0.95))'; } catch (e) {}
                  try {
                const bar = ind.querySelector && ind.querySelector('.agresso-autosave-timer');
                if (bar) {
                  try { bar.classList.add('agresso-period-moving'); try { resetTimerBar(getTimerRemainingMs()); } catch (e2) {} } catch (e) {}
                  try { bar.style.backgroundColor = '#d9534f'; } catch (e) {}
                  try { bar.style.boxShadow = '0 0 6px rgba(217,83,79,0.6)'; } catch (e) {}
                }
              } catch (e) {}
            } catch (e) {}
          };

          try { enforceHighlight(document); } catch (e) {}
          try { if (window.top && window.top.document && window.top !== window) enforceHighlight(window.top.document); } catch (e) {}
          [100, 500, 1500, 3000].forEach((ms) => {
            try { window.setTimeout(() => { try { enforceHighlight(document); } catch (e) {} try { if (window.top && window.top.document && window.top !== window) enforceHighlight(window.top.document); } catch (e) {} }, ms); } catch (e) {}
          });

          // Start a persistent enforcer that reapplies highlight until the
          // stored notify key changes or the user acknowledges the period.
          try {
            // Helper to show a small persistent banner prompting submission
            createSubmitBanner = (doc, titleText, bodyText) => {
              try {
                if (!doc || !doc.body) return;
                if (doc.getElementById('agresso-period-banner')) return;
                const ban = doc.createElement('div');
                ban.id = 'agresso-period-banner';
                ban.style.position = 'fixed';
                ban.style.right = '16px';
                ban.style.bottom = '20px';
                ban.style.zIndex = '9999999';
                ban.style.padding = '18px 20px';
                ban.style.background = 'linear-gradient(180deg, rgba(217,83,79,0.95), rgba(181,62,62,0.95))';
                ban.style.color = '#fff';
                ban.style.borderRadius = '10px';
                ban.style.boxShadow = '0 6px 18px rgba(0,0,0,0.35)';
                ban.style.fontSize = '15px';
                ban.style.display = 'flex';
                ban.style.flexDirection = 'column';
                ban.style.alignItems = 'flex-start';
                ban.style.gap = '10px';
                ban.style.maxWidth = '420px';
                // Explanation line on top (bold)
                const expl = doc.createElement('div');
                expl.style.fontWeight = '700';
                expl.style.fontSize = '15px';
                expl.textContent = titleText || 'SISTA DAGEN I PERIODEN';
                // Regular message below
                const txt = doc.createElement('div');
                txt.style.maxWidth = '360px';
                txt.style.fontSize = '13px';
                txt.textContent = bodyText || 'Submit your time report today.';
                const controls = doc.createElement('div');
                controls.style.display = 'flex';
                controls.style.gap = '8px';
                // Primary action: if we can find a submit / send-for-approval
                // button, click it directly. Otherwise fall back to scrolling
                // the save button into view (same as before).
                const submitBtn = findSubmitButton();
                const btn = doc.createElement('button');
                btn.textContent = submitBtn
                  ? (getReminderLang() === 'en' ? 'Submit time report' : 'Skicka in tidrapport')
                  : (titleText || 'Open report');
                btn.style.background = '#fff';
                btn.style.color = '#b02a2a';
                btn.style.border = 'none';
                btn.style.padding = '8px 10px';
                btn.style.borderRadius = '6px';
                btn.style.cursor = 'pointer';
                btn.addEventListener('click', (ev) => {
                  ev.stopPropagation(); ev.preventDefault();
                  try {
                    const target = findSubmitButton();
                    if (target) {
                      try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
                      try { target.click(); } catch (e) {}
                      return;
                    }
                    const sb = findSaveButton();
                    if (sb) {
                      try { sb.scrollIntoView({ behavior: 'smooth' }); } catch (e) {}
                      try { sb.focus(); } catch (e) {}
                    }
                  } catch (e) {}
                }, true);
                controls.appendChild(btn);
                ban.appendChild(expl);
                ban.appendChild(txt);
                ban.appendChild(controls);
                (doc.body || doc.documentElement).appendChild(ban);
              } catch (e) {}
            };

            removeSubmitBanner = (doc) => {
              try {
                if (!doc) return;
                const ex = doc.getElementById('agresso-period-banner');
                if (ex && ex.parentNode) ex.parentNode.removeChild(ex);
              } catch (e) {}
            };

            // Diagnostic: compare timer bar behavior in normal vs highlighted mode.
            compareTimerModes = () => {
              return new Promise((resolve) => {
                try {
                  const doc = document;
                  const bar = doc.querySelector('.agresso-autosave-timer');
                  if (!bar) return resolve({ error: 'no-timer-bar' });

                  const sample = () => {
                    const cs = window.getComputedStyle(bar);
                    return {
                      classList: Array.from(bar.classList),
                      animationName: cs.animationName,
                      animationDuration: cs.animationDuration,
                      transform: cs.transform,
                      width: cs.width,
                      inlineWidth: bar.style.width || null,
                      inlineTransform: bar.style.transform || null,
                      inlineTransition: bar.style.transition || null
                    };
                  };

                  // baseline
                  const baseline = sample();
                  const hadMoving = bar.classList.contains('agresso-period-moving');
                  const hadMarker = (bar.closest('.agresso-period-end') != null) || (document.querySelector('.agresso-period-end') != null);

                  // apply highlighted mode
                  bar.classList.add('agresso-period-moving');
                  // also ensure parent indicator has period-end marker
                  const parentIndicator = bar.closest('.agresso-enabled, .agresso-disabled, .agresso-indicator') || document.body;
                  parentIndicator.classList.add('agresso-period-end');

                  // allow styles to settle
                  setTimeout(() => {
                    const highlighted = sample();
                    // revert to previous state
                    if (!hadMoving) bar.classList.remove('agresso-period-moving');
                    if (!hadMarker) parentIndicator.classList.remove('agresso-period-end');
                    resolve({ baseline, highlighted });
                  }, 110);
                } catch (e) { resolve({ error: String(e) }); }
              });
            };
            // Expose the diagnostic here, where it actually exists.
            try { window.agresso_compareTimerModes = compareTimerModes; } catch (e) {}
            try { if (periodHighlightEnforcer) { clearInterval(periodHighlightEnforcer); periodHighlightEnforcer = null; } } catch (e) {}
            periodHighlightEnforcer = window.setInterval(() => {
              try { enforceHighlight(document); } catch (e) {}
              try { if (window.top && window.top.document && window.top !== window) enforceHighlight(window.top.document); } catch (e) {}
              // Stop if the notify cache no longer matches (cleared / advanced to a new period)
              if (settings.period_notify_date !== endIso) {
                try { clearInterval(periodHighlightEnforcer); periodHighlightEnforcer = null; } catch (e) {}
                try { removeSubmitBanner(document); } catch (e) {}
                try { if (window.top && window.top.document && window.top !== window) removeSubmitBanner(window.top.document); } catch (e) {}
              }
            }, 1000);
          } catch (e) {}

          if (!forceUIOnly) {
            try {
              settings.period_notify_date = endIso;
              chrome.storage.local.set({ period_notify_date: endIso });
            } catch (e) {}
            // Create a persistent banner prompting submission (current + top)
            try { createSubmitBanner(document, explanation, `${title} — ${body}`); } catch (e) {}
            try { if (window.top && window.top.document && window.top !== window) createSubmitBanner(window.top.document, explanation, `${title} — ${body}`); } catch (e) {}
            console.info(LOG_PREFIX, 'showPeriodNotification: stored period_notify_date', endIso);
          } else {
            try { console.info(LOG_PREFIX, 'showPeriodNotification: UI-only enforcement, not storing key'); } catch (e) {}
          }
          // Always attempt to create the persistent submit banner so users
          // get a visible prompt even when we only enforce UI (already-notified path).
          try { createSubmitBanner(document, explanation, `${title} — ${body}`); } catch (e) {}
          try { if (window.top && window.top.document && window.top !== window) createSubmitBanner(window.top.document, explanation, `${title} — ${body}`); } catch (e) {}
        } catch (e) {}
      }

    // Fire after a short timeout so init tasks finish first
    window.setTimeout(notifyNow, 200);
  }

  // Tear down every period-end visual (indicator highlight, forcing style,
  // submit banner, enforcer intervals) in both the current and the top
  // document. Deliberately leaves the stored period_notify_date alone —
  // navigating away from the timesheet must not count as acknowledging the
  // reminder; only Status 'Klar' clears the key (see setIndicator).
  function clearPeriodEndUi() {
    try { if (periodStatusRefreshTimer) { clearInterval(periodStatusRefreshTimer); periodStatusRefreshTimer = null; } } catch (e) {}
    try { if (periodHighlightEnforcer) { clearInterval(periodHighlightEnforcer); periodHighlightEnforcer = null; } } catch (e) {}
    const docs = [document];
    try { if (window.top && window.top.document && window.top !== window) docs.push(window.top.document); } catch (e) {}
    for (const doc of docs) {
      try {
        const ind = doc.getElementById && doc.getElementById(INDICATOR_ID);
        if (ind && ind.classList.contains('agresso-period-end')) {
          try { ind.classList.remove('agresso-period-end'); } catch (e) {}
          try { ind.style.border = ''; ind.style.background = ''; } catch (e) {}
          try {
            const labelEl = ind.querySelector('.agresso-autosave-label'); if (labelEl) labelEl.style.color = '';
            const subEl = ind.querySelector('.agresso-autosave-sub'); if (subEl) subEl.style.color = '';
          } catch (e) {}
          try {
            const bar = ind.querySelector('.agresso-autosave-timer');
            if (bar) {
              try { bar.classList.remove('agresso-period-moving'); } catch (e) {}
              bar.style.backgroundColor = '';
              bar.style.background = '';
              bar.style.boxShadow = '';
            }
          } catch (e) {}
        }
        const st = doc.getElementById && doc.getElementById('agresso-period-end-style');
        if (st && st.parentNode) st.parentNode.removeChild(st);
        const ban = doc.getElementById && doc.getElementById('agresso-period-banner');
        if (ban && ban.parentNode) ban.parentNode.removeChild(ban);
      } catch (e) {}
    }
    try { highlightStatusField(false); } catch (e) {}
  }

  function checkPeriodAndNotify(context) {
    try {
      // The reminder is only meaningful where the user can act on it — the
      // timesheet itself. Unit4 keeps inactive app tabs (Utlägg, menus,
      // Start panel) alive as hidden iframes, so without this gate the
      // scans below happily read a period end and an 'Utkast' status out of
      // an invisible background grid and alarm on every page of the app.
      // detectTimesheetPage requires a VISIBLE grid header, which is the
      // same gate autosave already uses.
      if (!detectTimesheetPage()) {
        clearPeriodEndUi();
        console.info(LOG_PREFIX, 'checkPeriodAndNotify: not on timesheet, skipping', context || '');
        return false;
      }

      // Helper: normalize to start of day for comparisons
      const startOfDay = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
      const todayStart = startOfDay(new Date());

      // Respect manual override first
      const override = getOverrideDate();
      if (override) {
        console.info(LOG_PREFIX, 'checkPeriodAndNotify: using override', override);
        try {
          const overrideStart = startOfDay(override);
          // Notify if the override date is today or earlier (period due/overdue).
          if (overrideStart.getTime() <= todayStart.getTime()) {
                if (!isReportStatusKlar()) {
                  showPeriodNotification(override);
                  console.info(LOG_PREFIX, 'checkPeriodAndNotify: override is today-or-earlier, notified');
                  return true;
                } else {
                  console.info(LOG_PREFIX, 'checkPeriodAndNotify: override is today-or-earlier but status Klar, not notifying');
                  return false;
                }
              }
              console.info(LOG_PREFIX, 'checkPeriodAndNotify: override is after today');
              clearPeriodEndUi();
        } catch (e) {
          console.info(LOG_PREFIX, 'checkPeriodAndNotify: override parsing error', e);
        }
        return false;
      }

      const end = findPeriodEndDate();
      if (!end) {
        console.info(LOG_PREFIX, 'checkPeriodAndNotify: no end date found');
        return false;
      }
      const endStart = startOfDay(end);
      const today = new Date();
      console.info(LOG_PREFIX, 'checkPeriodAndNotify: found end date', localIsoDate(end) || end.toISOString().slice(0,10), 'today', localIsoDate(today) || today.toISOString().slice(0,10));

      // Notify when the period end is today or earlier (due/overdue), but only until Status becomes 'Klar'
      if (endStart.getTime() <= todayStart.getTime()) {
        if (!isReportStatusKlar()) {
          showPeriodNotification(end);
          // Force the GUI timer bar to red when not 'Klar'
          try {
            const applyRedUI = (doc) => {
              try {
                const d = doc || document;
                const ind = d.getElementById && d.getElementById(INDICATOR_ID);
                if (ind) {
                  try { ind.classList.add('agresso-period-end'); } catch (e) {}
                  try { ind.classList.remove('agresso-saving'); } catch (e) {}
                  try { ind.classList.remove('agresso-saved'); } catch (e) {}
                  try { ind.classList.add('agresso-pending'); } catch (e) {}
                  try { ind.style.border = '2px solid rgba(217,83,79,0.9)'; } catch (e) {}
                  try { ind.style.background = 'linear-gradient(180deg, rgba(36,41,50,0.95), rgba(30,25,28,0.95))'; } catch (e) {}
                  try {
                    const bar = ind.querySelector && ind.querySelector('.agresso-autosave-timer');
                    if (bar) {
                      try { bar.classList.add('agresso-period-moving'); try { resetTimerBar(getTimerRemainingMs()); } catch (e2) {} } catch (e) {}
                      bar.style.backgroundColor = '#d9534f';
                      bar.style.boxShadow = '0 0 6px rgba(217,83,79,0.6)';
                    }
                  } catch (e) {}
                }
                try {
                    const existing = (d.getElementById && d.getElementById('agresso-period-end-style')) || null;
                  if (!existing) {
                    const s = d.createElement('style');
                    s.id = 'agresso-period-end-style';
                    s.textContent = `#${INDICATOR_ID} { border: 2px solid rgba(217,83,79,0.9) !important; background: linear-gradient(180deg, rgba(36,41,50,0.95), rgba(30,25,28,0.95)) !important; } #${INDICATOR_ID} .agresso-autosave-timer { height: 6px !important; display: block !important; background-color: #d9534f !important; box-shadow: 0 0 6px rgba(217,83,79,0.6) !important; transform-origin: left !important; } #${INDICATOR_ID} .agresso-autosave-label, #${INDICATOR_ID} .agresso-autosave-sub { color: #fff !important; } /* No CSS animation; JS width transition controls progress */ #${INDICATOR_ID} .agresso-autosave-timer.agresso-period-moving { }
`;
                    (d.head || d.body || d.documentElement).appendChild(s);
                  }
                } catch (e) {}
              } catch (e) {}
            };
            try { applyRedUI(document); } catch (e) {}
            try { if (window.top && window.top.document && window.top !== window) applyRedUI(window.top.document); } catch (e) {}
          } catch (e) {}

          console.info(LOG_PREFIX, 'checkPeriodAndNotify: end date is today-or-earlier, notified');
          return true;
        }
        console.info(LOG_PREFIX, 'checkPeriodAndNotify: end date is today-or-earlier but status Klar, not notifying');
        return false;
      }
      console.info(LOG_PREFIX, 'checkPeriodAndNotify: end date is after today');
      // A future deadline means any red state still showing is stale (e.g.
      // the user navigated from an overdue week back to the current one).
      clearPeriodEndUi();
    } catch (e) {
      // ignore
    }
    return false;
  }
  // Page-context helper injection removed due to site Content Security Policy (CSP).
  // Use the content-script debug button or dispatch the DOM event `agresso_check_period`
  // (e.g. `document.dispatchEvent(new Event('agresso_check_period'))`) to trigger checks safely.

  function onFieldInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (!target.matches('input, textarea, select')) {
      return;
    }

    if (target.matches('input[type="checkbox"]') && !target.hasAttribute('data-fieldname')) {
      return; // ignore row select checkboxes
    }

    const row = target.closest('tr');
    if (!row) {
      return;
    }

    row.dataset.agressoDirty = '1';
    pendingRow = row;
    markActivity();

    // Live-update the Fakt. värde footer total and the Delproj summary as
    // the user types. scheduleLayoutRefresh is debounced at 200 ms so this
    // is cheap even on fast typing; readCellNumber reads the editor's
    // current value via input.value so the row's contribution stays in
    // sync with what the user has typed so far.
    try { scheduleLayoutRefresh(); } catch (e) {}
    try { scheduleDelprojSummary(); } catch (e) {}
  }

  function onFieldBlur(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (!target.matches('input, textarea, select')) {
      return;
    }

    const row = target.closest('tr');
    if (!row) {
      return;
    }

    const next = event.relatedTarget;
    if (next && row.contains(next)) {
      return; // still inside the same row
    }

    if (row.dataset.agressoDirty === '1') {
      pendingRow = row;
    }

    markActivity();

    // Belt-and-suspenders: after blur, Agresso commits the editor value
    // back into the cell. If it does so by mutating an existing text node's
    // characterData rather than replacing the node, the MutationObserver
    // won't fire childList. Trigger a refresh explicitly so the Fakt. värde
    // footer total and the Delproj summary panel update immediately.
    try { scheduleLayoutRefresh(); } catch (e) {}
    try { scheduleDelprojSummary(); } catch (e) {}
  }

  function onDropdownOpen(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.matches('select')) {
      dropdownActive = true;
      dropdownRow = target.closest('tr') || dropdownRow;
    }

    markActivity();
  }

  function onDropdownClose(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.matches('select')) {
      dropdownActive = false;
      const row = target.closest('tr') || dropdownRow;
      const isDirty = row && row.dataset.agressoDirty === '1';
      dropdownRow = null;
      if (row && (isDirty || pendingRow === row)) {
        pendingRow = row;
      }

      markActivity();
    }
  }

  function onDeleteClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (isDeletionButton(target)) {
      // Deleting renumbers every row after the deleted one, so a held
      // Beskrivningstext would otherwise be written into whichever row
      // inherits the number — the row Agresso jumps to when the deleted one
      // disappears. Release before the postback carries the change out.
      releaseStickyHolds('delete clicked');
      const row = target.closest('tr');
      pendingRow = row || pendingRow;
      markActivity();
      return;
    }

    if (isAddRowButton(target)) {
      // Same hazard: a new row is inserted in sort position, not appended,
      // so every row after it shifts by one.
      releaseStickyHolds('add row clicked');
      markActivity();
      return;
    }

    // Sorting reorders rows without changing how many there are, which the
    // row-count guard in applyStickyEditValues cannot see. A column header
    // click is cheap to detect and losing a hold costs nothing next to
    // restoring text into the wrong row.
    try {
      const th = target.closest ? target.closest('th') : null;
      const table = th && th.closest ? th.closest('table') : null;
      if (table && table.querySelector('th[data-fieldname]')) {
        releaseStickyHolds('column header clicked');
      }
    } catch (e) { /* ignore */ }
  }

  function initObservers() {
    const observer = new MutationObserver((records) => {
      let rowsRemoved = false;
      let rowsAdded = false;
      let dialogAdded = false;
      for (const rec of records) {
        if (rec.removedNodes && rec.removedNodes.length) {
          rowsRemoved = rowsRemoved || Array.from(rec.removedNodes).some((n) => n.nodeName === 'TR');
        }
        if (rec.addedNodes && rec.addedNodes.length) {
          const added = Array.from(rec.addedNodes);
          rowsAdded = rowsAdded || added.some((n) => {
            if (!n || !n.nodeName) return false;
            if (n.nodeName === 'TR') return true;
            if (n instanceof HTMLElement && n.querySelector) {
              try { return !!n.querySelector('tr'); } catch (e) { return false; }
            }
            return false;
          });
          dialogAdded = dialogAdded || added.some((n) => {
            if (!(n instanceof HTMLElement)) {
              return false;
            }
            const roleDialog = n.getAttribute('role') === 'dialog';
            const modalClass = n.classList.contains('modal') || n.classList.contains('k-window');
            const alertClass = n.classList.contains('alert') || n.classList.contains('notification');
            return roleDialog || modalClass || alertClass;
          });
        }
      }
      if (rowsRemoved) {
        markActivity();
      }
      // Detect edit-in-row: Agresso mutates the <td>'s `title` attribute when
      // a cell's value changes. Trigger the rAF-coalesced label updater so the
      // project name under the Delproj code stays in sync.
      let attrDirty = false;
      for (const rec of records) {
        if (rec.type !== 'attributes') continue;
        if (rec.attributeName !== 'title' && rec.attributeName !== 'onclick') continue;
        const target = rec.target;
        if (target && target.nodeName === 'TD') { attrDirty = true; break; }
      }
      // When the grid rerenders (sort, paging, AJAX refresh) or an edit
      // mutates a <td>'s title, re-apply project labels immediately instead
      // of waiting on the debounced layout refresh — continuous mutations
      // during a rerender would otherwise keep resetting the 200ms timer and
      // labels would never come back.
      if (rowsAdded || rowsRemoved || attrDirty) {
        try { addProjectLabels(); } catch (e) {}
        try { scheduleDelprojSummary(); } catch (e) {}
        // Restore held Beskrivningstext / hours on the same immediate path
        // rather than via the 200ms debounce: a postback re-render is a
        // burst of mutations that keeps resetting that timer, and the user
        // would watch the server's default text sit in the field until the
        // churn stopped.
        try { applyStickyEditValues(); } catch (e) {}
      }
      if (dialogAdded) {
        startDialogSweep('dialog added');
      }
      refreshNoChangesBannerState('mutation');
      scheduleLayoutRefresh();
        // Check whether today is the last day in the currently shown period and notify once.
        // Run this after a short debounce so transient DOM swaps during navigation
        // don't cause false negatives/positives.
        try {
          if (periodStatusRefreshTimer) clearTimeout(periodStatusRefreshTimer);
          periodStatusRefreshTimer = window.setTimeout(() => {
            try { checkPeriodAndNotify('mutation'); } catch (e) { /* ignore */ }
            periodStatusRefreshTimer = null;
          }, 300);
        } catch (e) { /* ignore */ }
      bindIndicatorTracking();
      bindActivityListeners();
    });
    // Observe the document root (documentElement) rather than `body` so the
    // observer stays active if the page replaces or re-creates <body> during
    // client-side navigation (common on SPA-like pages).
    const rootNode = document.documentElement || document.body;
    try {
      // attributeFilter catches edit-in-row updates on body cells where
      // Agresso mutates the <td title="..."> in place without replacing the
      // row. Scoped to just the two attributes we care about to keep the
      // observer firing rate low.
      observer.observe(rootNode, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['title', 'onclick'],
        // characterData catches in-place edits to cell values where Agresso
        // mutates an existing text node's data instead of replacing it (no
        // childList fire). Without this, the Fakt. värde footer total and
        // the Delproj summary panel went stale on edit until the next sort
        // or row add/remove.
        characterData: true
      });
    } catch (e) {
      try { observer.observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (err) { /* ignore */ }
    }
  }

  function init() {
    applyTheme();
    enhanceLayout();
    applyColumnHideSheet();
    // Stamp the running build's version on <html> so page-context tooling
    // (and debugging sessions) can tell WHICH build is actually loaded —
    // an unpacked extension edit is invisible until the user reloads the
    // extension in chrome://extensions, and guessing wastes hours.
    try {
      document.documentElement.setAttribute(
        'data-pragresso-build',
        (chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : '?'
      );
    } catch (e) {}
    console.info(LOG_PREFIX, 'Init', { isMac: IS_MAC, shortcut: SHORTCUT_LABEL, autosave: getToggleEnabled() });
    // Reflect the persisted toggle state on the indicator. Unlike earlier
    // versions we do NOT force-enable autosave on every reload — respect the
    // user's choice from the options page / indicator toggle.
    try { applyToggleState(getToggleEnabled()); } catch (e) {}

    // If this is not the top-level frame, do not start timers or perform saves here.
    // Non-top frames will forward activity events to the top frame via postMessage.
    const isTop = (() => {
      try { return window.top === window; } catch (e) { return false; }
    })();

    if (!isTop) {
      // Minimal init for frames: layout tweaks and activity listeners only.
      document.addEventListener('input', onFieldInput, true);
      document.addEventListener('blur', onFieldBlur, true);
      document.addEventListener('click', onDeleteClick, true);
      document.addEventListener('focusin', onDropdownOpen, true);
      document.addEventListener('change', onDropdownClose, true);
      document.addEventListener('focusout', onDropdownClose, true);
      bindActivityListeners();
      scheduleLayoutRefresh();
      return;
    }

    // Top-level frame: full behavior
    setIndicator('saved', 'Autosave ready', 'Watching for edits');
    // Check whether today is the last day in the currently shown period and notify once
    try { checkPeriodAndNotify('init'); } catch (e) { /* ignore */ }
    

    // Attach field event listeners
    document.addEventListener('input', onFieldInput, true);
    document.addEventListener('blur', onFieldBlur, true);
    document.addEventListener('click', onDeleteClick, true);
    document.addEventListener('focusin', onDropdownOpen, true);
    document.addEventListener('change', onDropdownClose, true);
    document.addEventListener('focusout', onDropdownClose, true);

    bindActivityListeners();

    // Start idle timer on init
    startTimer(IDLE_TIMEOUT_MS, 'idle');

    // Kick off a short sweep at load in case a dialog is already present.
    startDialogSweep('init');

    // Special handling for logout page: continuously check for "return to application" button
    if (window.location.href.includes('/Logout/Logout.aspx')) {
      console.info(LOG_PREFIX, 'Logout page detected, starting extended dialog sweep');
      // Start a longer sweep for the logout page
      dialogSweepEndAt = Date.now() + 30000; // 30 seconds instead of 8
    }

    refreshNoChangesBannerState('init');

    positionIndicatorNearSaveButton();
    bindIndicatorTracking();

    if (!noChangesPollTimer) {
      noChangesPollTimer = window.setInterval(() => {
        refreshNoChangesBannerState('poll');
      }, NO_CHANGES_POLL_MS);
    }

    // Periodic health check: warn if the save button selectors stop matching.
    try {
      window.setInterval(checkSaveButtonHealth, HEALTH_CHECK_MS);
    } catch (e) {}

    // Proactive session keep-alive — see sessionKeepAliveTick docstring.
    scheduleSessionKeepAlive();

    // Gate autosave on being on the timesheet page. Without this, autosave
    // would fire Alt+S on the Start panel / menu tree / Utlägg / etc. — all
    // surfaces that have no save button or different save semantics.
    startTimesheetPoll();

    // Keep the indicator tooltip's "Next auto-save at..." countdown fresh.
    try {
      window.setInterval(() => {
        try {
          const ind = document.getElementById(INDICATOR_ID);
          if (!ind || !ind.classList.contains('agresso-saved')) return;
          const label = ind.querySelector('.agresso-autosave-label');
          const sub = ind.querySelector('.agresso-autosave-sub');
          updateIndicatorTooltip(ind, 'saved', label ? label.textContent : '', sub ? sub.textContent : '');
        } catch (e) {}
      }, 1000);
    } catch (e) {}

    // Initialize mutation observer
    initObservers();
  }

  // --- Settings bootstrap ---
  // Load persisted settings from chrome.storage.local (with one-time migration
  // from the pre-0.5 localStorage keys), hydrate the in-memory `settings`
  // object, then run init. Changes made through the options page or the
  // indicator toggle are mirrored back into `settings` via the
  // chrome.storage.onChanged listener below so side-effects (column-hide CSS,
  // indicator state) can update without a reload.
  async function loadSettings() {
    let stored = {};
    try {
      stored = await chrome.storage.local.get(SETTING_DEFAULTS);
    } catch (e) {
      stored = { ...SETTING_DEFAULTS };
    }
    settings = { ...SETTING_DEFAULTS, ...stored };

    // Migrate legacy localStorage keys (0.4.x and older) on first run.
    try {
      const migrations = {
        agresso_autosave_enabled: 'autosave_enabled',
        agresso_period_notify_enabled: 'reminder_enabled',
        agresso_period_notify_lang: 'reminder_lang',
        agresso_period_override: 'period_override',
        agresso_period_notify_date: 'period_notify_date'
      };
      const toWrite = {};
      for (const [oldKey, newKey] of Object.entries(migrations)) {
        const v = localStorage.getItem(oldKey);
        if (v === null) continue;
        if (newKey === 'autosave_enabled' || newKey === 'reminder_enabled') {
          toWrite[newKey] = v === '1' || v === 'true';
        } else {
          toWrite[newKey] = v;
        }
        try { localStorage.removeItem(oldKey); } catch (e) {}
      }
      if (Object.keys(toWrite).length) {
        Object.assign(settings, toWrite);
        try { await chrome.storage.local.set(toWrite); } catch (e) {}
      }
    } catch (e) { /* ignore */ }

    syncTimingVars();
  }

  function onSettingsChanged(changes) {
    let layoutDirty = false;
    let themeDirty = false;
    let keepAliveDirty = false;
    let timingDirty = false;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (!(key in SETTING_DEFAULTS)) continue;
      settings[key] = newValue;
      if (key in TIMING_BOUNDS) timingDirty = true;
      if (key === 'hide_ace_code' || key === 'hide_work_type') layoutDirty = true;
      if (key === 'theme') themeDirty = true;
      if (key === 'session_keepalive_enabled' || key === 'session_keepalive_minutes') keepAliveDirty = true;
      if (key === 'autosave_enabled') {
        try { applyToggleState(!!newValue); } catch (e) {}
      }
    }
    if (timingDirty) {
      syncTimingVars();
      // Re-arm the countdown so a shortened idle timeout takes effect now
      // instead of after the currently-running (old-duration) timer expires.
      try { if (unifiedTimer) startTimer(IDLE_TIMEOUT_MS, 'idle'); } catch (e) {}
    }
    if (layoutDirty) {
      try { applyColumnHideSheet(); } catch (e) {}
    }
    if (themeDirty) {
      try { applyTheme(); } catch (e) {}
    }
    if (keepAliveDirty) {
      try { scheduleSessionKeepAlive(); } catch (e) {}
    }
    try { addProjectLabels(); } catch (e) {}
    try { scheduleDelprojSummary(); } catch (e) {}
    try { scheduleSemesterSummary(); } catch (e) {}
    try { applyStickyEditValues(); } catch (e) {}
    // If the user just enabled "Minimize Arbetstimmar by default", honour
    // it on the next render pass. We don't collapse retroactively here —
    // the one-shot flag prevents that — but turning it on then opening a
    // fresh timesheet tab will collapse as expected.
    try { applyArbetstimmarDefaultCollapse(); } catch (e) {}
  }

  // Apply the theme setting by stamping a `data-agresso-theme` attribute on
  // the document root AND (when dark) toggling a class that darkens the
  // entire Agresso page via a CSS invert+hue-rotate filter. styles.css keys
  // indicator colours off the attribute and re-inverts our own UI so it
  // stays correctly themed on top of the inverted page.
  function applyTheme() {
    try {
      const theme = settings.theme || 'auto';
      const root = document.documentElement;
      const prefersDark = (() => {
        try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
      })();
      const effective = theme === 'auto' ? (prefersDark ? 'dark' : 'light') : theme;

      if (theme === 'auto') {
        root.removeAttribute('data-agresso-theme');
      } else {
        root.setAttribute('data-agresso-theme', theme);
      }
      // Agresso is built out of nested <frameset>s and <frame>s (not
      // iframes). CSS filters on a frameset's <html> are invisible because
      // framesets don't render any painted content themselves — only the
      // child <frame>s paint. Each frame is also a separate rendering
      // context, so frame-level filters don't chain. Strategy: apply the
      // invert filter in every frame EXCEPT those that only contain a
      // <frameset> (they'd waste work and double-nest visually on the rare
      // browser that does propagate).
      const hasFrameset = !!(document.body && document.body.tagName === 'FRAMESET') ||
                          !!document.querySelector('frameset');
      // Both `dark` and `advania` share the page-wide invert filter (they
      // paint the Agresso canvas dark); `light` and `auto→light` leave it.
      if ((effective === 'dark' || effective === 'advania') && !hasFrameset) {
        root.classList.add('agresso-dark-page');
      } else {
        root.classList.remove('agresso-dark-page');
      }
      try {
        console.info(LOG_PREFIX, 'applyTheme', { setting: theme, effective, hasFrameset, url: location.href });
      } catch (e) {}
    } catch (e) { /* ignore */ }
  }

  // React to OS dark-mode changes live when the user has selected "auto".
  try {
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const rerun = () => { try { applyTheme(); } catch (e) {} };
      if (mq.addEventListener) mq.addEventListener('change', rerun);
      else if (mq.addListener) mq.addListener(rerun);
    }
  } catch (e) { /* ignore */ }

  try {
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') onSettingsChanged(changes);
      });
    }
  } catch (e) { /* ignore */ }

  // Listen for the Alt+Shift+S keyboard command relayed from the background
  // service worker, plus cross-frame activity broadcasts.
  try {
    if (chrome?.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'toggle-autosave') {
          try { setToggleEnabled(!getToggleEnabled()); } catch (e) {}
        } else if (msg.type === 'activity-broadcast') {
          try { markActivity(); } catch (e) {}
        }
      });
    }
  } catch (e) { /* ignore */ }

  function boot() {
    loadSettings().then(() => {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
    });
  }
  boot();

  // Allow page to request a manual check by dispatching a DOM event (works despite CSP)
  try {
    document.addEventListener('agresso_check_period', () => {
      try {
        const res = checkPeriodAndNotify('page-event');
        console.info(LOG_PREFIX, 'agresso_check_period handler result', res);
        try {
          const indicator = ensureIndicator();
          if (indicator) {
            indicator.dataset.lastPeriodCheck = JSON.stringify({ result: !!res, ts: new Date().toISOString() });
          }
        } catch (e) {}
      } catch (e) {
        // ignore
      }
    }, false);
  } catch (e) {
    // ignore
  }

  // Listen for activity messages from child frames and treat them as activity
  try {
    if (window.top === window) {
      window.addEventListener('message', (ev) => {
        try {
          // Only trust frames from the Agresso origin itself. The content
          // script runs with all_frames:true, so without this check any
          // third-party iframe embedded in the page could hold the autosave
          // countdown open indefinitely (ACTIVITY_MESSAGE) or paint the red
          // period-end UI (agresso_period_enforce).
          if (!ev || ev.origin !== window.location.origin) return;
          if (ev.data && ev.data.type === ACTIVITY_MESSAGE) {
            // Mark activity in the top frame
            onActivityEvent();
              return;
            }
            // Handle requests from child frames to enforce a period highlight
            if (ev && ev.data && ev.data.type === 'agresso_period_enforce') {
              try {
                const endIso = ev.data && ev.data.endIso;
                // Apply enforcement locally in the top frame
                try {
                  const indicator = ensureIndicator();
                  if (indicator) {
                    indicator.classList.add('agresso-period-end');
                    try { indicator.classList.remove('agresso-saving'); } catch (e) {}
                    try { indicator.classList.remove('agresso-saved'); } catch (e) {}
                    try { indicator.classList.add('agresso-pending'); } catch (e) {}
                    try { indicator.style.border = '2px solid rgba(217,83,79,0.9)'; } catch (e) {}
                    try { indicator.style.background = 'linear-gradient(180deg, rgba(36,41,50,0.95), rgba(30,25,28,0.95))'; } catch (e) {}
                    try {
                      const bar = indicator.querySelector('.agresso-autosave-timer');
                      if (bar) {
                        try { bar.classList.add('agresso-period-moving'); try { resetTimerBar(getTimerRemainingMs()); } catch (e2) {} } catch (e) {}
                        bar.style.backgroundColor = '#d9534f';
                        bar.style.boxShadow = '0 0 6px rgba(217,83,79,0.6)';
                      }
                    } catch (e) {}
                  }
                } catch (e) {}

                // Inject forcing style into top doc if missing
                try {
                  const doc = document;
                  const existing = doc.getElementById('agresso-period-end-style');
                  if (!existing) {
                    const s = doc.createElement('style');
                    s.id = 'agresso-period-end-style';
                    s.textContent = `#${INDICATOR_ID} { border: 2px solid rgba(217,83,79,0.9) !important; background: linear-gradient(180deg, rgba(36,41,50,0.95), rgba(30,25,28,0.95)) !important; } #${INDICATOR_ID} .agresso-autosave-timer { height: 6px !important; display: block !important; background-color: #d9534f !important; box-shadow: 0 0 6px rgba(217,83,79,0.6) !important; transform-origin: left !important; } #${INDICATOR_ID} .agresso-autosave-label, #${INDICATOR_ID} .agresso-autosave-sub { color: #fff !important; } /* No CSS animation; JS width transition controls progress */ #${INDICATOR_ID} .agresso-autosave-timer.agresso-period-moving { }
`;
                    (doc.head || doc.body || doc.documentElement).appendChild(s);
                  }
                } catch (e) {}

                // Start a persistent enforcer in top if not already running
                try {
                  if (periodHighlightEnforcer) { clearInterval(periodHighlightEnforcer); periodHighlightEnforcer = null; }
                  periodHighlightEnforcer = window.setInterval(() => {
                    try {
                      const ind2 = ensureIndicator();
                      if (ind2) {
                        ind2.classList.add('agresso-period-end');
                        ind2.classList.remove('agresso-saving');
                        ind2.classList.remove('agresso-saved');
                        ind2.classList.add('agresso-pending');
                        try { ind2.style.border = '2px solid rgba(217,83,79,0.9)'; } catch (e) {}
                        try { ind2.style.background = 'linear-gradient(180deg, rgba(36,41,50,0.95), rgba(30,25,28,0.95))'; } catch (e) {}
                        try { const bar = ind2.querySelector('.agresso-autosave-timer'); if (bar) { try { bar.classList.add('agresso-period-moving'); try { resetTimerBar(getTimerRemainingMs()); } catch (e2) {} } catch (e) {} bar.style.backgroundColor = '#d9534f'; bar.style.boxShadow = '0 0 6px rgba(217,83,79,0.6)'; } } catch (e) {}
                      }
                    } catch (e) {}
                    // Stop if the notify cache no longer matches this period
                    try {
                      if (settings.period_notify_date !== endIso) {
                        try { clearInterval(periodHighlightEnforcer); periodHighlightEnforcer = null; } catch (e) {}
                      }
                    } catch (e) {}
                  }, 1000);
                } catch (e) {}
              } catch (e) {}
              return;
          }
        } catch (e) {
          // ignore malformed messages
        }
      }, false);
    }
  } catch (e) {
    // ignore cross-origin
  }
  try {
    try { window.agresso_buildDebugReport = buildDebugReport; } catch (e) {}
    // agresso_compareTimerModes is NOT exported here: it is a closure inside
    // notifyNow and only exists once a period-end notification has run, so a
    // reference at this scope is always undefined. notifyNow exports it itself.
    try {
      window.agresso_setIndicatorDebug = function(enabled) {
        try { INDICATOR_DEBUG = !!enabled; } catch (e) {}
        try { console.info(LOG_PREFIX, 'agresso_setIndicatorDebug =>', INDICATOR_DEBUG); } catch (e) {}
      };
    } catch (e) {}
  } catch (e) {}
})();
