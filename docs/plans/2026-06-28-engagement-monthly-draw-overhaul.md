# Engagement + Monthly Draw Overhaul Implementation Plan

Created: 2026-06-28
Status: COMPLETE
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Overhaul the TZH Badminton Engagement (Lucky Draw) and Monthly Draw admin tabs: replace the canvas pie wheel with the existing anonymous name‑reel picker, add per‑press ranked winners (1st/2nd/…) with an editable draw date, add manual tube entry with auto token/leftover conversion, and a calendar/month carry‑over system with auto‑roll + manual close + undo.

**Architecture:** Single Express app (`server.js`) + Vercel serverless (`api/state.js`) persisting one JSON blob in Upstash Redis via shallow merge. All UI/logic lives in `public/index.html` (one inline `<script>`); pure, Node‑testable logic lives in `public/monthly-draw.js` (`window.MonthlyDraw`). New pure logic is added to `monthly-draw.js` (unit‑tested via `scripts/test-monthly-draw.js`); DOM/rendering stays inline. State is read → mutated → posted back per sub‑object (`apiPost({ luckyDraw })`, `apiPost({ monthlyDraw })`).

**Tech Stack:** Vanilla JS (no build step, no frameworks, no new deps), CSS custom‑property design tokens, Node test scripts run via `npm test`.

## Scope

### In Scope
- **Engagement tab:** name‑reel picker (reuse `#pickerOverlay`), one winner per Spin press, ranked 1st/2nd/… winners each removed from pool, editable draw date (current + history), updated viewer badge, removal of all dead pie‑wheel code.
- **Monthly tab:** manual tube add/edit with +/- stepper (±1) + number input, tokens (`floor(tubes/4)`) + leftover (`tubes%4`) display, month header/label, auto‑roll on new calendar month, manual "Close month & carry over", ~20s "Closed {month} — Undo" toast, carry‑over (`tubes%4`, tokens reset to 0, keep zero‑tube people), name(+phone) identity merge, additive CSV import (merge‑and‑sum tubes), enhanced history archive.
- **State migration:** `api/state.js` + `server.js` defaults/normalizers extended (gracefully) for `luckyDraw.drawDate/results`, `monthlyDraw.month`, participant `tubes`/`tokens`. Old `lastWinner` ignored.
- **Polish/audit (prompt Task 3):** accessibility, ≥44px touch targets on new steppers/buttons, mobile widths, badge contrast ≥4.5:1, `prefers-reduced-motion`, `escHtml` on all user input, Escape closes picker, `isEditing()` poll‑guard for new inputs; a short `docs/` audit note.
- **New unit tests** + verification (npm test green, inline‑script `node --check`, dead‑code grep clean, carry‑over sanity, deploy + browser E2E on `tzhplayers.vercel.app`).

### Out of Scope
- Re‑fixing BUG_REPORT.md items B1–B9 (already fixed in current code — audit for *new* issues only).
- The legacy `monthlyDraws` / `drawOdds` / `monthlySpin` / `shopCustomers` / `drawPrizes` state fields (unused by the active ballot UI; left AS‑IS, not removed).
- Changing the Monthly Draw reveal/picker behaviour itself (only generalize `showPickerOverlay` to also serve Engagement).
- Any new fonts, libraries, or build tooling.

## Approach

**Chosen:** Reuse the existing `#pickerOverlay` name‑reel picker for both Monthly and Engagement (generalize `showPickerOverlay(spin)`), keep all new pure logic in `public/monthly-draw.js` for Node test coverage, and keep DOM rendering inline. State changes ride the existing per‑sub‑object shallow‑merge POST pattern.

**Why:** Maximizes reuse of already‑tested, viewer‑synced picker + confetti code (the prompt explicitly requests this), keeps the new mechanics (ordinal, carry‑over, merge, month math) unit‑testable in Node without a DOM harness, and avoids touching the shallow‑merge persistence contract. Cost: `public/index.html` (already ~3.5k lines) grows further — acceptable since it's the single‑file architecture and the net change removes the entire pie‑wheel block.

**Alternatives considered:**
- *Keep the pie wheel for Engagement* — rejected: the prompt mandates the name‑reel picker and removal of wheel code.
- *Put new logic inline in index.html* — rejected: not Node‑testable; prompt Task 4 requires unit tests for `ordinal()`, tube/leftover conversion, and carry‑over.
- *Close every skipped month individually on auto‑roll* — rejected: prompt says auto‑roll "writes once" (`month === currentMonthKey()` after rolling); multiple skipped months collapse into one archived close.

## Context for Implementer

> Written for an implementer who has never seen this codebase.

- **Single source of UI:** `public/index.html` — CSS in `<head>` `<style>`, markup, then one big inline `<script>` near the bottom (ends ~line 3563, before `</script></body>`). `public/monthly-draw.js` is loaded via `<script src>` BEFORE the inline script, exposing `window.MonthlyDraw`; the inline script already calls `MonthlyDraw.parseDrawCsv` etc. inside functions (safe — runs after load).
- **Persistence contract:** `api/state.js` POST does `state = { ...state, ...updates }` (shallow merge). Client pattern: `const luckyDraw = { ...(state.luckyDraw||{}), ...changes }; await apiPost({ luckyDraw }); state.luckyDraw = luckyDraw;` then re‑render. Always `await refreshState()` before a read‑modify‑write that matters (B4 race guard) — see `drawPrize` (`index.html:2849`).
- **Polling:** `poll()` runs every 2s (`index.html:1233`). When admin is open it re‑renders everything incl. `renderMonthlyTab()` (`:1263`) and calls `checkForNewSpin(state.luckyDraw)` (`:1254`) + `checkForNewMonthlyDraw(state.monthlyDraw)` (`:1255`). **`isEditing()` guard (`:1227,:1251`)** skips the whole poll while a focused INPUT/TEXTAREA/SELECT exists — this is how in‑progress admin edits survive; the new date/tube inputs rely on it.
- **Server clock sync:** use `clockNow()` (`:3109`, `Date.now()+clockOffset`) for all `startAt`/reveal timing so viewer + admin reveal in sync. `prefersReducedMotion()` at `:3110`.
- **The picker (KEEP, generalize):** `#pickerOverlay` DOM (`:898–907`), CSS (`:512–531`), JS `checkForNewMonthlyDraw` (`:3468`), `showPickerOverlay` (`:3486`), `animatePicker` (`:3513`), `displayPickerWinner` (`:3538`), `hidePickerOverlay` (`:3500`). Picker globals: `lastDrawSpinId`, `shownWinnerSpinId`, `pickerRaf`, `pickerAutoHideTimer`, `pickerSafetyTimer` (`:3462–3466`). `SPIN_GRACE_MS` (`:3290`) is **shared** with the monthly picker — keep it.
- **Engagement reveal guard:** keep the existing `lastSpinId` global (`:3287`) as the Engagement‑specific `checkForNewSpin` guard so it does not collide with the monthly `lastDrawSpinId`. Add a separate `shownEngagementSpinId` only if needed (picker `displayPickerWinner` is idempotent per `spin.id`, which is unique per `Date.now()` — sharing is safe).
- **New module globals to declare (top of the relevant JS sections):** `activeRevealKind` (null, F2 overlay serializer); `mdRolling` (false, F4 re‑entrancy); `mdPreCloseSnapshot` (null, undo snapshot); `mdUndoTimer` (null); `lastAutoRolledFrom` (null, same‑session de‑dupe). Reuse the existing `lastSpinId`/`lastDrawSpinId`/`shownWinnerSpinId`/picker timers; do NOT introduce a second copy. Note: `monthlyDraw.rollSuppressedMonth` is PERSISTED state (not a JS global) — add it to the `api/state.js` normalizer default (`''`/absent).
- **Reusable CSS already present:** `.md-tube-step`, `.md-tube-step button/input`, `.md-leftover`, `.md-cust-del` (`:469–475`); `.md-cust`, `.md-tickets`, `.md-prize-rank`, `.md-win-badge`, `.md-rank-1/2/3`, `.picker-prize`, `.rank-medal`. Tube‑step buttons are **26×26px** (`:471`) — below 44px; bump on mobile (Task 5).
- **Design tokens (`:root` ~line 12–30):** `--green:#0071e3` is the Apple **blue** accent (legacy name — NOT green); `--green-light:#0066cc`; `--accent:#f0b429` (gold); `--gold/--silver/--bronze`; `--card #fff`, `--card2`, `--dark #e8f0fb`, `--border/--border2`, `--text #1d1d1f`, `--text-2`, `--muted`, `--radius-sm/md/lg/xl`, `--shadow-*`, `--fs-xs…2xl`, `--red`. Use only declared tokens.
- **Helpers to reuse:** `escHtml` (`:2965`), `notify(msg,type)` (`:2969`), `todayISO()` (`:2346`, client copy with TZ offset), `launchConfetti(id)` (`:3400` — KEEP), `setSpinBtnEnabled(enabled)` (`:3122` — KEEP), `mdRankLbl(r)` (`:2692`, 1–3 only — engagement uses new `ordinal`).
- **Gotchas:**
  - The design guard `scripts/verify-redesign.js` is strict and part of `npm test`. After editing: (b) inline `<script>` must parse; (f) **NO pictographic emoji** anywhere (only `✓ ✕ → ← …` allowed — use SVG icons / plain text); (g) no `transform:rotate(` literal & no `text-shadow` outside the script; (h) `backdrop-filter` only on `.modal-overlay`/`#pwModal`/`#historyModal` (the picker does NOT use it — keep it that way); (e) every `var(--x)` must resolve; (c)/(d) no old‑green `#1a9e5c`/`rgba(26,158,92` and no GitHub‑dark greys in CSS/markup. `#16a55a` (in `launchConfetti`) is allowed.
  - Removing wheel code must also remove `#wheelCloseBtn` from the shared `:focus-visible` selector group (`:621`) and the `wheelOverlay` branch of the keydown handler (`:3449–3450`), or `grep -in "wheel"` will still hit (Task 4 acceptance requires a clean grep).
  - `launchConfetti()`'s default container id is `confettiContainer` (the wheel's, removed). Only the picker calls it, always as `launchConfetti('pickerConfetti')` — safe; the null‑check (`:3403`) handles the missing default.
  - `parseDrawCsv` MUST keep its existing "tokens ≥ 1 eligible / others skipped" filter (existing tests assert `participants.length===2`, `skipped===2`). Adding a `tubes` field is additive; do not change eligibility.

## Runtime Environment

- **Local dev:** `npm start` → Express on `:3000` (`/` viewer, `/?admin` admin). In‑memory shallow merge; NO `api/state.js` normalizer and NO Redis (state resets on restart). Good for quick smoke + the picker/stepper UI, but cross‑device/history/persistence behave differently than prod.
- **Production:** push to GitHub `Toramiyuu/TZHPlauyers` → Vercel auto‑deploys to `tzhplayers.vercel.app` (Upstash Redis). **Confirmed decision #5 authorizes the commit/push** for deploy + live browser E2E. Admin password `TZH123` (env `ADMIN_PASSWORD`); admin via `/?admin`.
- **Verify suite:** `npm test` = `verify-redesign` + `test-monthly-draw` + `test-session-court` + `test-next-up`.

## Autonomous Decisions

- **Auto‑roll trigger scope:** `ensureMonthlyRoll()` runs from `renderMonthlyTab()` but ONLY when `currentAdminTab === 'monthly'` (the admin is actually viewing the Monthly tab) and never from the public viewer/poll path — matches "when the admin opens the Monthly tab" and prevents the Undo toast from firing while the admin is on another tab. (`renderMonthlyTab` is called on every admin poll, so this gate is required.)
- **Re‑roll suppression after Undo (persisted in shared state — F1):** a page‑local flag is NOT enough — a post‑Undo page reload (or a second admin device) would lose it and silently re‑archive the month the admin just restored. So `undoMonthRoll()` writes `monthlyDraw.rollSuppressedMonth = <restored month>` into the POSTed snapshot. `ensureMonthlyRoll()` auto‑rolls only when `md.month < currentMonthKey()` AND `md.month !== md.rollSuppressedMonth`. The flag is cleared (set to `null`/absent) by a deliberate manual `closeMonth()`, and is naturally moot once the calendar advances past it (the next real close sets a fresh month). This survives reloads and other devices. A page‑local `lastAutoRolledFrom` is still kept as a cheap same‑session de‑dupe, but correctness rests on the persisted field.
- **CSV import semantics (user‑confirmed):** ADD to carried‑over — imported tubes are summed onto the matched person's existing tubes (by name+phone key); people absent from the CSV keep their tubes; new people are appended. Helper text updated from "replaces the current list" to reflect additive merge. Import does NOT wipe `results`/`spin`.
- **Stepper increment (user‑confirmed):** ±1 tube per click; a direct number input allows any value.
- **Undo window (user‑confirmed):** ~20s, then the toast auto‑dismisses and the close becomes permanent (`mdPreCloseSnapshot` cleared).
- **Identity merge key:** `name` lower‑cased + trimmed; when BOTH records have a non‑empty phone, the trimmed phone must also match to merge (phone as tiebreaker per prompt); if either lacks a phone, match on normalized name alone.
- **Engagement draw date input:** native `<input type="date">` (mirrors the session‑date input at `:2366`), `max = todayISO()` optional (draw date may legitimately be a planned session — leave editable to any date; no future cap).
- **`ordinal()` location:** added to `public/monthly-draw.js` (exported, unit‑tested) and called as `MonthlyDraw.ordinal(n)` inline, consistent with existing `MonthlyDraw.*` usage.
- **Manual close new month:** sets open month to `nextMonthKey(md.month)`; auto‑roll sets it to `currentMonthKey()` (catch up to now).
- **Single picker overlay is serialized between the two reveal sources (F2):** `poll()` fires BOTH `checkForNewSpin(luckyDraw)` and `checkForNewMonthlyDraw(monthlyDraw)` every 2s, and both `luckyDraw.spin` and `monthlyDraw.spin` can be live within `SPIN_GRACE_MS` simultaneously — they would otherwise stomp the single `#pickerOverlay`/`pickerRaf`. Introduce a module global `activeRevealKind` ('engagement'|'monthly'|null), set when a reveal begins and cleared in `hidePickerOverlay()`. Each `checkForNew*` bails (WITHOUT consuming its `lastSpinId`/`lastDrawSpinId` guard, so it retries on the next poll) if a reveal of the OTHER kind currently owns the overlay. The deferred draw simply reveals once the overlay frees. This guarantees the prompt's "only one reveal at a time" assumption in code rather than by luck.

## Assumptions

- `public/monthly-draw.js` loads before the inline script and `window.MonthlyDraw` is available inside all draw functions — supported by existing `MonthlyDraw.parseDrawCsv` usage (`index.html:2820`). Tasks 1,3,4 depend on this.
- The shallow‑merge POST persists whole `luckyDraw`/`monthlyDraw` sub‑objects unchanged — supported by `api/state.js:179` and `server.js:62`. All tasks depend on this.
- `isEditing()` reliably guards new INPUTs from poll clobber because it checks `document.activeElement.tagName` — supported by `:1227`. Tasks 3,4 depend on this for date/tube inputs.
- Existing `test-monthly-draw.js` assertions on `parseDrawCsv` eligibility (2 eligible / 2 skipped) remain valid because eligibility filter is unchanged — Task 1 depends on this.
- `clockNow()`/`SPIN_GRACE_MS`/picker globals are shared between Monthly and Engagement; safety is ENFORCED by the `activeRevealKind` serialization guard (F2), not assumed — Task 3 depends on this.
- Old saved Redis blobs may have `luckyDraw.lastWinner` and `monthlyDraw.participants[].tokens` (no `tubes`); normalizers must tolerate and derive (`tubes = tokens*4`) without throwing — Task 2 depends on this.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Auto‑roll re‑fires after Undo, instantly re‑closing the month — incl. across a page reload / 2nd device | Med | High | **Persisted** `monthlyDraw.rollSuppressedMonth` (F1), written by `undoMonthRoll()`; `ensureMonthlyRoll` skips when `md.month === md.rollSuppressedMonth`. Cleared by deliberate manual close. Verified by E2E TS‑005 incl. a reload sub‑step. |
| Auto‑roll runs concurrently (multiple polls) and double‑archives | Med | High | `mdRolling` re‑entrancy flag set as the FIRST synchronous statement of `rollMonth` (before `await refreshState()`), cleared in a `try/finally` (F4); `ensureMonthlyRoll` returns immediately if `mdRolling`; after roll `month===currentMonthKey()` so the condition is false next poll. |
| Poll clobbers a half‑typed tube count or draw date | Med | Med | Reuse `isEditing()` poll guard; number/date inputs are focusable INPUTs so the whole poll early‑returns while focused. |
| Removing wheel code breaks inline‑script parse or leaves dangling refs | Med | High | After removal run `npm test` (verify‑redesign parse check) + `node --check` on extracted inline script + `grep -in "wheel\|lastWinner\|spinWheel"` must be empty (Task 4 DoD). |
| New badge/label introduces emoji or undefined `var()` → design‑guard fail | Med | Med | Use only SVG icons + declared tokens; run `npm test` after each task. |
| CSV add‑merge double‑counts tubes if admin imports the same sheet twice | Low | Med | Documented behaviour (additive by design, user‑chosen); helper text states "adds to current tubes"; admin can Clear first. Not auto‑mitigated beyond clear messaging. |
| Carry‑over drops a person and breaks cross‑month identity | Low | High | `carryOverParticipants` keeps everyone incl. tubes=0 (decision #4), preserving ids/keys; unit‑tested. |
| Stepper/date controls too small on mobile (touch target) | Med | Med | Task 5 bumps `.md-tube-step button` to ≥44px on mobile, verified via browser E2E at mobile width. |

## Goal Verification

### Truths
1. Engagement uses the name‑reel picker (no canvas/pie wheel); pressing Spin reveals exactly ONE winner, removed from the pool; pressing again reveals the next, labelled 1st/2nd/3rd/4th… (`ordinal`). → TS‑001
2. A draw date is shown before spinning, defaults to today, and is editable for the current draw and for past draws in history. → TS‑002
3. The viewer badge (`#viewerLastWinner`) shows the ranked winners + the draw date (not "Last winner: X"). → TS‑001/TS‑002
4. Monthly participants can be added/edited manually with a ±1 tube stepper + number input; tokens (`floor/4`) and leftover (`%4`) display live; CSV import still works and ADDS to existing tubes. → TS‑003
5. The current month label shows; auto‑roll on a new calendar month and manual "Close month & carry over" both work; the ~20s Undo restores the pre‑close state. → TS‑004/TS‑005
6. On close each participant's tubes become `tubes%4`, tokens reset to 0, leftover carries to next month, people matched by name(+phone), and the month is archived with winners + tube snapshot. (Harvey 6 → 1 token + 2 leftover → next month 2 tubes.) → TS‑004 + unit tests
7. No dead wheel code remains (`grep` clean); `npm test` is green; the inline script passes `node --check`; no console errors on the live site. → verification phase

### Artifacts
- `public/monthly-draw.js` — `ordinal`, `withTokens`, `carryOverParticipants`, `participantKey`, `mergeParticipants`, `nextMonthKey`, `monthLabel`, `reindexRanks`, extended `parseDrawCsv` (returns `tubes`).
- `scripts/test-monthly-draw.js` — new assertions for all of the above (existing assertions unchanged).
- `public/index.html` — generalized `showPickerOverlay`, rerouted `checkForNewSpin`, `spinDraw`/`renderDrawResult`/`renderViewerLastWinner`/`renderDrawDate`/`setDrawDate`/`getDrawDate`/`startNewDraw`/`removeDrawWinner`/`editDrawHistoryDate`; `renderMonthlyTab` rebuild with steppers/month‑header/history; `ensureMonthlyRoll`/`closeMonth`/`rollMonth`/`undoMonthRoll`/`currentMonthKey`/`addParticipantManual`/`setParticipantTubes`/`stepParticipantTubes`/`removeParticipant`; merge‑add `importDrawCsv`; wheel code removed.
- `api/state.js` + `server.js` — extended defaults/normalizers.
- `docs/audit-2026-06-28-draw-overhaul.md` — Task 3 audit note.

## E2E Test Scenarios

> Executed on the live `tzhplayers.vercel.app` deploy (confirmed decision #5) — or local `npm start` for picker/stepper UI smoke. Admin: `/?admin`, password `TZH123`. Use Claude Code Chrome if connected, else playwright‑cli; if no browser tool is available, hand the URL + steps to the user.

### TS-001: Engagement — name‑reel picker, ranked winners, pool removal
**Priority:** Critical
**Preconditions:** Admin logged in, Engagement tab, pool has ≥3 names (Pull today's session or add manually).
**Mapped Tasks:** Task 3

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click Spin (label reads "Spin — pick 1st winner") | `#pickerOverlay` opens; one big name shuffles fast then decelerates to a single winner (no pie wheel anywhere) |
| 2 | While the reveal is still animating, click Spin again | Nothing happens — the button is disabled for the whole ~5.3s reveal (F6); the result row + its Remove button only appear AFTER the name locks (F10) |
| 3 | Wait for reveal | Winner locks with confetti; overlay shows "1st Winner"; winner is removed from the pool chips |
| 4 | Click Spin again (label "Spin — pick 2nd winner"); spin a 4th time later | A second/…/4th different winner each revealed + removed; labels read 2nd/3rd/4th Winner (ordinal, not "3rd" for rank 4); result list shows ranked winners |
| 6 | In results, click Remove on the 1st winner | 1st removed, others re‑number (2nd→1st), removed name returns to the pool |
| 7 | Open the viewer (`/`) | `#viewerLastWinner` shows the ranked winner(s) + the draw date, not "Last winner: X" |

### TS-002: Engagement — editable draw date (current + history)
**Priority:** High
**Preconditions:** Engagement tab.
**Mapped Tasks:** Task 3

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Observe the draw‑date control near Spin | Defaults to today, shown human‑readably (e.g. "Draw date: Sunday 28 June 2026") |
| 2 | Change the date input to another day | New date persists (survives a 2s poll while focused/blur) and shows on the viewer badge |
| 3 | Click "Start new draw" | Current results archive into history with the draw date; results clear; date resets to today |
| 4 | Edit a past draw's date in history | The history row's date updates and persists |

### TS-003: Monthly — manual tube entry, token/leftover, additive CSV
**Priority:** Critical
**Preconditions:** Monthly tab.
**Mapped Tasks:** Task 4

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Add a participant "Harvey" with 6 tubes | Row shows "1 token · 2 tubes carry over"; ≥44px steppers on mobile |
| 2 | Click the + stepper twice | Tubes 6→8; display updates to "2 tokens · 0 tubes carry over" |
| 3 | Type 5 directly into the number input | Tubes=5 → "1 token · 1 tube carry over" |
| 4 | Import a CSV containing Harvey with 4 tubes | Harvey's tubes become 5+4=9 (additive merge by name); a new CSV person is appended; note says it added to existing |
| 5 | Import the SAME CSV again | Harvey's tubes sum again (9+4=13 — intended additive behaviour); rows/ids stay unique (no duplicate Harvey row, F7) |

### TS-004: Monthly — manual close, carry‑over, archive
**Priority:** Critical
**Preconditions:** Monthly tab; Harvey at 6 tubes; a draw optionally spun.
**Mapped Tasks:** Task 4

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Note the month header label (e.g. "June 2026") and the "4 tubes = 1 token; leftover carries" explainer | Both visible |
| 2 | Click "Close month & carry over" | Month archived in Past months with winners + tube snapshot; Harvey now shows 2 tubes (6%4), 0 tokens; zero‑tube people retained |
| 3 | Inspect Past months history | Shows closed month label, winners, and that leftover carried forward |

### TS-005: Monthly — auto‑roll + ~20s Undo
**Priority:** High
**Preconditions:** Deterministically seed a stale month. From the admin page DevTools console, post a prior month with some participants:
`fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'TZH123',monthlyDraw:{...(state.monthlyDraw),month:'2026-05',participants:[{id:'mpA',name:'Harvey',phone:'',tubes:6,tokens:1}],rollSuppressedMonth:null}})})` then reload the admin page on a NON‑monthly tab.
**Mapped Tasks:** Task 4

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open the Monthly tab (stored `month`='2026-05' < current) | Old month auto‑closes silently; month header shows the current month; Harvey now shows 2 tubes / 0 tokens; a "Closed May 2026 — Undo" toast appears |
| 2 | Wait through a 2s poll WITHOUT clicking Undo | The month does NOT re‑roll or double‑archive (one history entry only); toast persists |
| 3 | Click Undo within ~20s | Pre‑close state restored (month='2026-05', Harvey 6 tubes/1 token pre‑carry, results intact); no immediate silent re‑roll on the next poll |
| 4 | After Undo, RELOAD the admin page and open the Monthly tab again | The month still does NOT auto‑re‑roll (persisted `rollSuppressedMonth`='2026-05', F1); admin can close manually when ready |
| 5 | Re‑seed a stale month, auto‑roll, then let the toast expire (~20s) without Undo | Toast disappears; `mdPreCloseSnapshot` cleared; the close is permanent |

## Progress Tracking

- [x] Task 1: Pure draw logic + unit tests in `monthly-draw.js`
- [x] Task 2: State defaults/normalizers migration (`api/state.js`, `server.js`)
- [x] Task 3: Engagement tab — picker + ranked winners + editable date; remove wheel
- [x] Task 4: Monthly tab — manual tubes + month system + carry‑over + undo + additive CSV
- [x] Task 5: Polish, accessibility/mobile audit + `docs/` audit note

**Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0 — _(Tasks 3 & 4 browser-verified locally via playwright-cli: picker/ranked winners/removal, manual tubes, carry-over 6→2, auto-roll+undo+F1-suppression-across-reload, additive merge, monthly prize draw — 0 console errors. Full TS‑001…005 re-run on the live deploy in the verify phase.)_

## Implementation Tasks

### Task 1: Pure draw logic + unit tests in `monthly-draw.js`

**Objective:** Add and unit‑test all new pure logic the UI will depend on, and extend `parseDrawCsv` to return `tubes` — without breaking existing assertions.
**Dependencies:** None
**Mapped Scenarios:** Underpins TS‑001/003/004

**Files:**
- Modify: `public/monthly-draw.js`
- Modify: `scripts/test-monthly-draw.js`

**Key Decisions / Notes:**
- Add exported pure helpers:
  - `ordinal(n)` → "1st/2nd/3rd/4th/11th/21st/22nd/23rd…" (handle 11–13 teens).
  - `withTokens(p)` → `{ ...p, tokens: drawTokens(p.tubes) }`.
  - `carryOverParticipants(list)` → each `{ ...p, tubes: drawLeftover(p.tubes), tokens: 0 }`; keep ALL entries incl. tubes→0 (decision #4).
  - `participantKey(name, phone)` → `String(name).trim().toLowerCase()` + (phone trimmed ? `'|'+phone` : `''`)`; with the match rule: phone is a tiebreaker only when both present (implement as a `matchParticipant(a,b)` predicate or document key composition — keep it simple and testable).
  - `mergeParticipants(existing, incoming, { add })` → for each `incoming`, find an `existing` match by the name(+phone) rule; if found, `add ? tubes = existing.tubes + incoming.tubes : tubes = incoming.tubes`; if not, append (id left for caller to assign). Returns a new array; existing ids preserved. Recompute `tokens` via `drawTokens`.
  - `nextMonthKey("YYYY-MM")` → next month key (handle Dec→Jan rollover).
  - `monthLabel("YYYY-MM")` → e.g. "June 2026" (build from the key, not `Date.now()`).
  - `reindexRanks(list)` → sort by rank, reassign `rank = i+1` (engagement winner removal re‑rank).
- Extend `parseDrawCsv`: for each ELIGIBLE participant also return `tubes` — from the "Accumulated tubes" column when present, else `tokens*4` fallback. Do NOT change the `tokens>=1` eligibility filter (existing tests depend on it).
- TDD: write the new `check(...)` assertions FIRST (they fail), then implement. Keep all existing assertions passing.

**Definition of Done:**
- [ ] `node scripts/test-monthly-draw.js` passes incl. new cases: `ordinal` covering the teen trap — `ordinal(1)==='1st'`, `ordinal(2)==='2nd'`, `ordinal(3)==='3rd'`, `ordinal(4)==='4th'`, `ordinal(11)==='11th'`, `ordinal(12)==='12th'`, `ordinal(13)==='13th'`, `ordinal(21)==='21st'`, `ordinal(22)==='22nd'`, `ordinal(23)==='23rd'`, `ordinal(111)==='111th'`, `ordinal(112)==='112th'`; `withTokens`; `carryOverParticipants` (6→2/tokens0; a tubes=0 person is KEPT at 0); `mergeParticipants` add‑mode sums tubes + matches by name+phone (and name‑only when a phone is missing) + appends a new person; `nextMonthKey('2026-12')==='2027-01'`; `monthLabel('2026-06')==='June 2026'`; `reindexRanks` (removing rank 2 from `[{rank:1},{rank:2},{rank:3}]` yields ranks `[1,2]` in order); `parseDrawCsv` returns `tubes` (and the `tubes = tokens*4` fallback when no tubes column).
- [ ] All pre‑existing `test-monthly-draw.js` assertions still pass.
- [ ] `npm test` green.

**Verify:**
- `node scripts/test-monthly-draw.js`
- `npm test`

### Task 2: State defaults/normalizers migration

**Objective:** Extend `api/state.js` (and `server.js` for local parity) so GET tolerates old blobs and exposes the new fields; POST is unchanged (shallow merge already carries whole sub‑objects).
**Dependencies:** Task 1 (final shapes)
**Mapped Scenarios:** Underpins all TS

**Files:**
- Modify: `api/state.js`
- Modify: `server.js`

**Key Decisions / Notes:**
- `DEFAULT_STATE.luckyDraw` → `{ entries: [], drawDate: todayISO(), spin: null, results: [], history: [] }` (drop `lastWinner`).
- `DEFAULT_STATE.monthlyDraw` → add `month: ''` (client initializes via `ensureMonthlyRoll` when empty) and `rollSuppressedMonth: ''` (F1 undo‑suppression, persisted); keep `prizes/participants/results/spin/history`.
- GET normalizer (additive, never throw on old blobs):
  - `luckyDraw`: ensure `entries` array, `drawDate` (default `todayISO()`), `results` (default `[]`), `history` (default `[]`), `spin` (default null). Stop forcing `lastWinner` (ignore it; leaving an old field present is harmless but do not depend on it).
  - `monthlyDraw`: ensure `month` (default `''`), `rollSuppressedMonth` (default `''`), and map `participants` so each has `tubes` (`p.tubes != null ? p.tubes : (p.tokens||0)*4`) and `tokens` (`drawTokens(tubes)`), preserving `id/name/phone`. Requires importing the pure `drawTokens`/`drawLeftover` into `api/state.js` (it's a CommonJS module — `require('../public/monthly-draw.js')`), OR inline a 1‑line `floor(tubes/4)` to avoid a serverless require‑path surprise. **Prefer inline** `(tubes)=>Math.floor((Number(tubes)||0)/4)` to avoid bundling path issues on Vercel; keep it tiny.
- `server.js` `DEFAULT_STATE`: mirror the new `luckyDraw`/`monthlyDraw` defaults (no normalizer needed locally; client handles missing fields defensively).
- Do NOT touch the legacy `monthlyDraws/drawOdds/monthlySpin/shopCustomers/drawPrizes` normalizer lines (out of scope).

**Definition of Done:**
- [ ] `node --check api/state.js` and `node --check server.js` pass.
- [ ] A GET against a simulated OLD blob (only `luckyDraw.lastWinner` + `monthlyDraw.participants[].tokens`) returns `luckyDraw.results`/`drawDate` and `monthlyDraw.month` + participants with derived `tubes`/`tokens` (verify with a tiny node snippet calling the handler or by reasoning + local smoke).
- [ ] `npm test` green (verify‑redesign check (a) passes).

**Verify:**
- `node --check api/state.js && node --check server.js`
- `npm test`

### Task 3: Engagement tab — picker + ranked winners + editable date; remove wheel

**Objective:** Replace the pie wheel with the name‑reel picker for Engagement, one winner per Spin press with ordinal ranks and pool removal, an editable draw date (current + history), an updated viewer badge, and remove ALL dead wheel code.
**Dependencies:** Task 1 (`ordinal`, `reindexRanks`), Task 2 (`drawDate`/`results` normalizer)
**Mapped Scenarios:** TS‑001, TS‑002

**Files:**
- Modify: `public/index.html`

**Key Decisions / Notes:**
- **State (migrate gracefully, ignore old `lastWinner`):** `luckyDraw = { entries, drawDate, spin:{ id, kind:'engagement', title:'Lucky Draw', noPrize:true, rank, entries:[...pool], winnerIndex, winnerName, startAt, durationMs } | null, results:[{rank,name,at,spinId}], history:[{date,at,winners:[{rank,name}]}] }`.
- **Generalize `showPickerOverlay(spin)` (F3):** set `#pickerTitle` text from `spin.title || 'Monthly Lucky Draw'`. Branch on `spin.noPrize`: engagement → `<span class="rank-medal">${rank}</span><span>${MonthlyDraw.ordinal(rank)} Winner</span>` (NEVER `mdRankLbl`, which returns `'3rd'` for any rank ≥3 — see `:2692`); monthly → unchanged `${mdRankLbl(rank)} Prize${prize?' — '+prize:''}`. **Cap the style class at `rank-3`** so ranks >3 reuse the defined bronze medal palette: `className = 'picker-prize rank-' + Math.min(rank, 3)` (the medal NUMBER still shows the true `rank`; the label still shows the true ordinal). This avoids an undefined/`currentColor` medal for 4th+ winners without adding any new `var()` (design‑guard (e) safe).
- **Reroute `checkForNewSpin(ld)`** through the picker (mirror `checkForNewMonthlyDraw`) but keep the existing `lastSpinId` guard (separate from monthly's `lastDrawSpinId`); share `pickerRaf`/`pickerSafetyTimer`/`displayPickerWinner`/`animatePicker`. Respect `SPIN_GRACE_MS`, `prefersReducedMotion()`, reveal only when `clockNow() >= startAt`. **Serialize against monthly (F2):** before showing, if `activeRevealKind && activeRevealKind !== 'engagement'` (a monthly reveal owns the overlay), `return` WITHOUT setting `lastSpinId` so it retries next poll; otherwise set `activeRevealKind = 'engagement'`. Mirror the same guard inside `checkForNewMonthlyDraw` for `'monthly'`. Clear `activeRevealKind = null` in `hidePickerOverlay()`.
- **`spinDraw()`** (replaces `spinWheel`): require `entries.length >= 2` for the 1st winner (`results.length===0`) and `>= 1` thereafter; double‑spin guard `if (live && clockNow() < live.startAt+live.durationMs) return`; `rank = results.length+1`; pick `winnerIndex` in current pool; build engagement `spin` (`durationMs ≈ 4500`, `startAt = clockNow()+800`); append `{rank,name,at:startAt+durationMs,spinId}` to `results`; remove winner from `entries`; `setSpinBtnEnabled(false)`; `apiPost({ luckyDraw })`; `checkForNewSpin`; `renderDrawResult`.
- **Spin button (F6):** markup `onclick` → `spinDraw()`; label set by `renderDrawResult()` to `Spin — pick ${ordinal(results.length+1)} winner`. Enabled state is recomputed every render so the 2s poll self‑heals it, and MUST be spin‑aware: `enabled = poolHasEnough AND NOT (ld.spin && clockNow() < ld.spin.startAt + ld.spin.durationMs)` — i.e. stay disabled for the whole ~5.3s reveal (mirrors the monthly `drawPrize` live‑spin guard at `:2858`). Otherwise a poll mid‑reveal would re‑enable the button and let the admin start a second spin while the first overlay is still animating. `poolHasEnough = entries.length >= (results.length===0 ? 2 : 1)`.
- **Date controls (new markup in the Engagement card):** a labelled `<input type="date" id="drawDateInput" onchange="setDrawDate(this.value)">` + a human‑readable line. `getDrawDate()` → `ld.drawDate || todayISO()`. `setDrawDate(val)` posts `drawDate`. `renderDrawDate()` updates the input value + readable label (use `new Date(iso+'T00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'})`). Rely on `isEditing()` poll guard.
- **`renderDrawResult()`** rebuild: ranked winners list (sorted by rank, each with a Remove button → `removeDrawWinner(rank)` and per‑winner avatar if in roster), a "Start new draw" button (`startNewDraw()`), and the draw history (each row shows date + winners, with an editable date input → `editDrawHistoryDate(idx,val)`). **Render a result row (and its Remove button) only when `clockNow() >= result.at` (F10)** — the same reveal gate the viewer uses — so a winner can never be removed before the viewer has seen it appear (prevents admin/viewer desync). Set the Spin button label/enabled state here.
- **`removeDrawWinner(rank)`** → drop that result, `reindexRanks` the rest, push the removed name back into `entries`, post, re‑render.
- **`startNewDraw()`** → archive `{ date: getDrawDate(), at: clockNow(), winners: results.map(r=>({rank:r.rank,name:r.name})) }` into `history` (cap ~24), clear `results`, reset `drawDate = todayISO()`, post, re‑render.
- **`editDrawHistoryDate(idx,val)`** → set `history[idx].date = val`, post.
- **`renderViewerLastWinner()`** rebuild: if `results` has revealed winners, show ranked chips (`ordinal(rank)`: name) + the draw date; else hide. `escHtml` everything.
- **Remove dead wheel code:** the `#wheelOverlay` DOM block (`:888–895`, incl. its `#confettiContainer`); the wheel functions `spinWheel`, `computeFinalAngle`, `showWheelOverlay`, `hideWheelOverlay`, `handleOverlayClick`, `wheelSegColors`, `drawWheelAtAngle`, `animateWheel`, `displayWheelWinner` and the `wheelRaf`/`wheelAutoHideTimer` globals; the wheel CSS (`:447–449`, `:501–507`) and the `#wheelCloseBtn` token in the shared `:focus-visible` group (`:621`); the `wheelOverlay` branch in the keydown handler (`:3449–3450`). **KEEP** `launchConfetti`, `setSpinBtnEnabled`, `SPIN_GRACE_MS`, and the entire picker.
- **Replace ALL user‑facing "wheel" copy (F12)** so the Task 4 `grep -in "wheel"` DoD passes — not just functions/DOM/CSS: the card title icon/text and helper text at `:1049` ("Build a pool and spin the wheel live on the viewer screen." → e.g. "Build a pool and draw winners live on the viewer screen."), and the Spin `<button>` at `:1073` (static "Spin the Wheel" → the dynamic label `Spin — pick {ordinal} winner` set by `renderDrawResult`; swap the pie‑wheel‑looking SVG for a neutral icon). Re‑run `grep -in "wheel"` as the final step of this task.

**Definition of Done:**
- [ ] `grep -in "wheel\|spinWheel\|lastWinner" public/index.html` returns nothing (incl. helper text + button label, F12).
- [ ] Inline `<script>` passes parse (verify‑redesign check (b)) and `node --check` on the extracted script.
- [ ] `npm test` green.
- [ ] Every new read of `luckyDraw.results`/`drawDate`/`spin` coalesces a default (`|| []`, `|| todayISO()`) so the normalizer‑less local `server.js` path never renders `undefined`/`NaN` (F5).
- [ ] Pressing Spin again WHILE the reveal is still animating does nothing — button stays disabled for the whole reveal (F6).
- [ ] A winner's Remove button appears only AFTER its reveal completes (`clockNow() >= result.at`), so it can't be removed before the viewer sees it (F10).
- [ ] Engagement + monthly do not stomp the overlay: if both `spin`s are live, one reveal completes then the other shows (F2) — no blank/overwritten name.
- [ ] Browser (TS‑001 + TS‑002): picker reveals one ordinal‑ranked winner per Spin press (1st/2nd/3rd/4th via `ordinal`), winners leave the pool, Remove re‑ranks + returns to pool, draw date defaults to today and is editable (current + history), viewer badge shows ranked winners + date, no pie wheel and no console errors.

**Verify:**
- `grep -in "wheel\|spinWheel\|lastWinner" public/index.html` (expect empty)
- `npm test`
- Extract inline script → `node --check` (one‑off)
- Browser E2E TS‑001, TS‑002

### Task 4: Monthly tab — manual tubes + month system + carry‑over + undo + additive CSV

**Objective:** Add manual tube entry/editing with ±1 stepper + number input and live token/leftover display, a month header/label, auto‑roll + manual close + ~20s Undo, carry‑over math + name(+phone) identity merge, additive CSV import, and an enhanced history archive.
**Dependencies:** Task 1 (`withTokens`, `carryOverParticipants`, `mergeParticipants`, `nextMonthKey`, `monthLabel`), Task 2 (`month`/tubes normalizer)
**Mapped Scenarios:** TS‑003, TS‑004, TS‑005

**Files:**
- Modify: `public/index.html`

**Key Decisions / Notes:**
- **State:** `monthlyDraw = { month:"YYYY-MM", prizes, participants:[{id,name,phone,tubes,tokens}], results, spin, history:[{month,label,at,winners:[{rank,name,prize}],participants:[{name,phone,tubes,tokens}]}] }`. Tokens are ALWAYS derived from tubes via `withTokens` whenever saved (so `buildBallot` reading `p.tokens` keeps working).
- **Month helpers (inline):** `currentMonthKey()` → `todayISO().slice(0,7)`; `monthLabel`/`nextMonthKey` via `MonthlyDraw`.
- **`renderMonthlyTab()` rebuild order:** call `ensureMonthlyRoll()` FIRST (gated on `currentAdminTab==='monthly'`), then render: month header card (label + "Close month & carry over" button + one‑line explainer "4 tubes = 1 token; leftover tubes carry to next month"); a manual add row (name + optional phone + tubes → `addParticipantManual()`); participants list with `.md-tube-step` (− / number input / +) + `${tokens} token(s) · ${leftover} tube(s) carry over` via `.md-leftover`, a `.md-cust-del` remove; prizes; draw buttons; results; enhanced history.
- **Unique id helper (F7):** a single `newParticipantId()` → `'mp' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7)`, used by BOTH manual add and CSV import so a manual‑add and an import in the same millisecond can't collide (ids must be unique for `buildBallot`/results‑by‑id/`removeParticipant`).
- **Manual entry fns:** `addParticipantManual()` (id via `newParticipantId()`, `withTokens`); `setParticipantTubes(id,val)` (clamp `Number(val)||0` ≥0, `withTokens`); `stepParticipantTubes(id,delta)` (delta ±1, clamp ≥0); `removeParticipant(id)`. Each `await refreshState()` → mutate → `apiPost({monthlyDraw})` → re‑render. Number input uses `onchange` (not poll‑sensitive while focused thanks to `isEditing()`).
- **`importDrawCsv` (additive merge, F7):** `await refreshState()` FIRST (mirror the existing code at `:2827` — never merge onto a stale local copy, since the shallow merge overwrites the whole `monthlyDraw` sub‑object) → parse → build `incoming` `{name,phone,tubes,tokens}` → `mergeParticipants(refreshedExisting, incoming, { add:true })` → assign `newParticipantId()` to any new entries → `withTokens` all → keep `results`/`spin` as‑is → post. Update helper text: imports ADD to the current month's tubes (no longer "replaces the list"); still note 0‑token rows from the sheet are skipped. (Re‑importing the same sheet intentionally sums again — documented; admin can Clear first.)
- **Auto‑roll `ensureMonthlyRoll()` (F1/F4):** FIRST line `if (mdRolling) return;`. If `!md.month` → initialize `month=currentMonthKey()` (no archive) and post once (guarded by `mdRolling`). Else auto‑roll only when `md.month < currentMonthKey()` AND `md.month !== md.rollSuppressedMonth` (persisted, F1) AND `md.month !== lastAutoRolledFrom` (cheap same‑session de‑dupe) → `rollMonth(true)`. Gated on `currentAdminTab === 'monthly'` (see Autonomous Decisions).
- **`rollMonth(isAuto)` (F4/F8):** set `mdRolling = true` as the FIRST synchronous statement (BEFORE any `await`), and wrap the whole body in `try { … } finally { mdRolling = false; }`. Body: `await refreshState()`; snapshot `mdPreCloseSnapshot = deep copy of md`; **build the archive participant snapshot from `md.participants` (PRE‑carry) FIRST** — `{ month:md.month, label:monthLabel(md.month), at:clockNow(), winners:(results sorted)→{rank,name,prize}, participants: md.participants.map(p=>({name,phone,tubes:p.tubes,tokens:p.tokens})) }`; THEN `const carried = carryOverParticipants(md.participants)`; `month = isAuto ? currentMonthKey() : nextMonthKey(md.month)`; on AUTO also keep `lastAutoRolledFrom = <old month>`; clear any `rollSuppressedMonth` (deliberate close supersedes a prior undo); `results=[]`, `spin=null`; `history=[archive, ...].slice(0,36)`; `apiPost`; update `state.monthlyDraw`; re‑render; then `isAuto ? showUndoToast(label) : notify('Closed '+label+'.')`. (Order matters: archive shows Harvey 6 tubes/1 token; live list shows 2 tubes/0 tokens — F8.)
- **`closeMonth()`** (manual button) → `rollMonth(false)`; manual close explicitly sets `rollSuppressedMonth = null` (clears any prior undo suppression).
- **Undo toast (F9):** a dedicated `#mdUndoToast` element (NOT `notify`, which has no button) **mounted as a fixed‑position sibling of `#notif`, OUTSIDE any container `renderMonthlyTab` rewrites via innerHTML** — otherwise the 20s timer's element/handler is clobbered by the next poll re‑render. Text "Closed {label}" + an Undo `<button onclick="undoMonthRoll()">`. Styled with declared tokens only, NO `backdrop-filter`, NO emoji (design‑guard (e)/(f)/(h)). Auto‑hide after ~20s (`mdUndoTimer`), which also clears `mdPreCloseSnapshot` (close becomes permanent). `undoMonthRoll()` → if `mdPreCloseSnapshot`, POST `monthlyDraw = { ...mdPreCloseSnapshot, rollSuppressedMonth: mdPreCloseSnapshot.month }` (F1 — persist suppression so a reload/2nd device won't re‑roll), restore `state.monthlyDraw`, also set `lastAutoRolledFrom = mdPreCloseSnapshot.month`, clear the snapshot, hide the toast, re‑render, `notify('Month close undone.')`.
- **Enhanced `renderMonthlyHistory()`:** per archived month show label, winners (`name (ordinal/rankLbl)`), and a note that leftover tubes carried forward (e.g. count of carried participants / total carried tubes from snapshot).
- **Touch targets:** the existing `.md-tube-step button` is 26px — Task 5 bumps to ≥44px on mobile; ensure the new add row + number inputs are ≥16px font to avoid iOS zoom.

**Definition of Done:**
- [ ] Manual add/edit: adding Harvey with 6 tubes shows "1 token · 2 tubes carry over"; +/− steps by 1; number input sets any value; tokens always = `floor(tubes/4)`.
- [ ] CSV import ADDS to existing tubes by identity (does not replace the whole list), after a `refreshState()`; new people appended with collision‑resistant ids; re‑importing the same sheet sums again but rows/ids stay unique (F7); helper text reflects additive behaviour.
- [ ] Month header label shows; manual "Close month & carry over" archives + applies `tubes%4` + tokens→0 + keeps zero‑tube people; auto‑roll fires once on a stale `month`; ~20s Undo restores pre‑close state without immediate re‑roll — including after a page reload / 2nd device (persisted `rollSuppressedMonth`, F1).
- [ ] Two polls firing during a (slow) roll produce exactly ONE archive entry (`mdRolling` set before first await + try/finally, F4).
- [ ] Archive snapshot captures PRE‑carry tubes/tokens (Harvey 6/1) while the live list shows POST‑carry (2/0) — F8.
- [ ] Every new read of `monthlyDraw.month`/`participants[].tubes`/`tokens` coalesces a default so the normalizer‑less local `server.js` path never renders `NaN` (F5).
- [ ] The Undo button still works after a 2s poll re‑render (`#mdUndoToast` mounted outside `renderMonthlyTab`'s innerHTML, F9).
- [ ] `node` carry‑over sanity (6 → 1 token, 2 leftover; after close → 2 tubes) matches via `drawTokens`/`drawLeftover`.
- [ ] `npm test` green; inline script parses.
- [ ] Browser TS‑003, TS‑004, TS‑005 pass.

**Verify:**
- `npm test`
- `node -e "const m=require('./public/monthly-draw.js');console.log(m.drawTokens(6),m.drawLeftover(6),m.drawLeftover(6))"` (expect `1 2 2`)
- Browser E2E TS‑003, TS‑004, TS‑005

### Task 5: Polish, accessibility/mobile audit + audit note

**Objective:** Fresh audit (mechanics/visuals/bugs/accessibility/mobile) of the new Engagement + Monthly code, fix what's found, and write a short `docs/` audit note. Do NOT re‑fix B1–B9.
**Dependencies:** Task 3, Task 4
**Mapped Scenarios:** Cross‑cutting (re‑run TS‑001…005 at mobile width)

**Files:**
- Modify: `public/index.html`
- Create: `docs/audit-2026-06-28-draw-overhaul.md`

**Key Decisions / Notes:**
- Verify: 2s poll never clobbers in‑progress edits on the new date/tube inputs (`isEditing()`); reveals stay synced via `clockNow()`; double‑spin/double‑close guards hold; `escHtml` on ALL user‑entered names/phones (engagement names, manual participant name/phone, draw‑date labels); Escape closes the picker; focus‑visible states on new controls; **≥44px touch targets** on `.md-tube-step button` and the new buttons at mobile width; new sections render correctly at mobile widths incl. the bottom tab bar; badge/chip contrast ≥4.5:1 (reuse existing `md-rank`/`md-win-badge`/`picker-prize` tokens); `prefers-reduced-motion` respected by picker + confetti (already handled — confirm new paths don't bypass it).
- Keep Apple‑blue tokens + existing visual language; no new fonts/libraries; no emoji (design‑guard f).
- Write `docs/audit-2026-06-28-draw-overhaul.md`: what was audited, findings + severity, what changed.

**Definition of Done:**
- [ ] `npm test` green (all design‑guard checks incl. emoji/var()/backdrop‑filter pass).
- [ ] Mobile‑width browser pass (~390px): `.md-tube-step button` and new add/close/undo buttons measure ≥44px; bottom tab bar works; no horizontal overflow.
- [ ] DevTools console shows ZERO errors after loading `/` (viewer) and `/?admin`, and after running one engagement spin + one monthly close (read via browser tool's console capture).
- [ ] New badges/chips reuse the already‑proven `md-rank-*` / `md-win-badge` / `picker-prize` token pairs (no new color pairs introduced), so ≥4.5:1 contrast holds by reuse.
- [ ] `docs/audit-2026-06-28-draw-overhaul.md` written.

**Verify:**
- `npm test`
- Browser E2E (mobile viewport) re‑run of TS‑001…005
