# Next Up Display Implementation Plan

Created: 2026-06-14
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Show the players who are up next (the round after each court's current one) on the public viewer so resting players get a heads-up, plus four admin controls: a show/hide toggle, an inline "override who's next" editor, a "Start Next Round" button, and clickable Up Next rows that let a logged-in admin advance a single court straight from the viewer.

**Architecture:** Pure front-end change inside the single-file app `public/index.html`. The "next" matchup already exists in `state.rounds` (the full schedule is generated up front), so the viewer just reads `state.rounds[courtRounds[i] + 1].courts[i]`. A new `state.showNextUp` boolean flows through the existing `POST /api/state` handler unchanged (`api/state.js:179` merges arbitrary fields). All new admin UI lives in the existing **Courts** tab and reuses the round-editor primitives (`buildPlayerSelect`, the `saveRound` pattern).

**Tech Stack:** Vanilla JS + inline CSS in `public/index.html`. Upstash Redis state via `POST /api/state`. No new dependencies. No backend edits.

## Scope

### In Scope

- Viewer "Up Next" panel below the courts grid, one row per court with a next round: `Court N → A & B vs C & D`.
- `state.showNextUp` persisted flag (default ON); admin toggle to show/hide the panel on the viewer.
- "Start Next Round" admin button — advances **each** court forward by one round (preserves per-court offsets, bounded to the last round).
- "Override who's next" admin editor — per-court dropdowns for the next round + a single "Save Up Next" button with duplicate-player validation.
- Clickable Up Next rows on the viewer **only when the device is a logged-in admin** (`sessionStorage.adminPwd` present) → advances that one court via `advanceCourt(i, 1)`.

### Out of Scope

- Backend / `api/state.js` changes (none needed — generic field merge).
- Auto-generating a new round when a court is already on the last round (the override editor and panel simply show nothing for that court; admin uses the existing "Generate Schedule" / "+ Add Round Manually").
- Singles/empty-slot editing semantics beyond what the existing round editor already supports (see Assumptions).
- Any new state for "acknowledged / seen" by players — display only.

## Approach

**Chosen:** Extend the single-file app in place, reusing existing render/editor primitives.
**Why:** The schedule already contains the next round and the codebase already has a per-court round model (`getCourtRounds`), an inline matchup editor (`renderRoundList`/`saveRound`/`buildPlayerSelect`), and a per-court advance (`advanceCourt`). Reusing them gives consistent UX and styling at the cost of adding more functions to an already-large file (~3360 lines) — acceptable since this is the file's established pattern.
**Alternatives considered:**
- *Separate modal for the override editor* — rejected: adds a modal (and the design guard restricts `backdrop-filter` to 3 named modal selectors), more code, worse for quick edits than inline dropdowns.
- *New `state.nextUp` structure to store overrides separately* — rejected: the next round already lives in `state.rounds`; a parallel structure would duplicate data and desync from the schedule.

## Context for Implementer

> Write for an implementer who has never seen the codebase. Everything is in `public/index.html`.

**Per-court round model:**
- `getCourtRounds()` (`index.html:1254`) returns an array — the current round index for each court. Court `i` shows `state.rounds[courtRounds[i]].courts[i]`. The **next** round for court `i` is index `courtRounds[i] + 1` (exists only if `< state.rounds.length`).
- `playerById(id)` (`:1160`) resolves a player; returns undefined if not found.
- `apiPost(updates)` (`:1183`) sends `{ password, ...updates }`; on 401 it logs out. `state = { ...state, ...updates }` server-side, so new top-level fields like `showNextUp` persist with zero backend work.

**Viewer render flow:**
- `renderViewer()` (`:1269`) runs every 2s poll. It rebuilds the courts grid (`#courtsDisplay`) only when a cheap signature `__lastCourtSig` changes (`stateSig` at `:1265` reduces base64 photos to a length marker). `renderLeaderboard()` and `renderViewerLastWinner()` run every poll regardless.
- `poll()` (`:1225`) calls `renderViewer()` **unconditionally every poll**, before the `adminOpen` branch — so the signature (with `adm` added) is recomputed every 2s and an admin login/logout is reflected within one poll. **Do NOT move `renderUpNext()` behind the `adminOpen` branch.**
- **Layout caveat:** `#viewer` is `display:flex; flex-direction:column` and `#courtsDisplay` has `flex:1` (`:52`, `:67`) — it absorbs all free vertical height. A panel inserted *after* `#courtsDisplay` would be pushed down near the footer on a tall always-on display, NOT sit directly under the cards. Wrap the grid + panel together (see Task 1) so the panel is visually adjacent.
- **Integrate Up Next into the signature:** add `snu: state.showNextUp` and `adm: !!sessionStorage.getItem('adminPwd')` to the object passed to `stateSig` (`:1277`), and call a new `renderUpNext()` **inside** the `if (courtSig !== __lastCourtSig)` block so it only rebuilds when courts/rounds/toggle/admin-state change (flicker-free, matches the existing pattern).
- `buildCourtCard()` (`:1310`) and `aAvatarHTML()` show the existing court styling — match the visual language.

**Admin render flow:**
- `renderCourtControls()` (`:1347`) runs on every poll (when admin open) and after every court action. It renders `#courtCtrlGrid`, the quick-nav pill, prev/next buttons, and calls `renderRestingPlayers()` at the end. **Add `renderNextUpEditor()` and set the toggle checkbox state here** so they stay in sync.
- `advanceCourt(courtIdx, delta)` (`:1818`) clamps to `[0, rounds.length-1]`, posts `{courtRounds}`, then calls `renderCourtControls()` + `renderRoundList()`. **It does NOT call `renderViewer()`** — add a `renderViewer()` call at its end so the viewer (and the clickable Up Next rows) update instantly when advanced.
- `stepAllCourts(delta)` (`:1427`) is the existing quick-nav that snaps all courts to `courtRounds[0]+delta`. Do NOT reuse it for "Start Next Round" — the chosen behavior is per-court +1.

**Round-editor primitives to reuse for the override editor:**
- `buildPlayerSelect(elId, selectedId)` (`:1888`) returns `<select id="elId">` with every `state.players` entry as an option, `selected` on the match.
- `saveRound(i)` (`:1852`) is the template for `saveNextUp()`: deep-clone `state.rounds`, read selects, rebuild `court.team1/team2`, **validate duplicates** (a player appearing twice in the same round → `notify(..., 'warn')` and abort), `apiPost({ rounds })`, update `state.rounds`, re-render.
- The round editor markup uses classes `.court-editor`, `.selectors-row`, `.rl-team-label`, `.amp`, `.vs-small` (already styled). Reuse them in the override editor to avoid new CSS.

**Poll-safety (important):** `poll()` (`:1205`) skips updating state while `isEditing()` (`:1199`) is true (an `<input>/<select>/<textarea>` is focused) **and** the admin panel is open — this prevents clobbering an in-progress dropdown selection. Because the override editor uses `<select>`, focusing a dropdown pauses polling; this matches the existing round editor. No extra handling needed.

**Design-system guard (`scripts/verify-redesign.js`, run via `npm test`) — MUST stay green:**
- Theme is **minimalist Apple-style, light**, single blue accent `--green:#0071e3`. (The earlier "flat-dark / brand-green #16a55a" is gone — do NOT reintroduce it.)
- (c) Never use `#1a9e5c` or `rgba(26,158,92,...)` anywhere.
- (d) No GitHub-dark greys in markup/CSS: `#0d1117 161b22 30363d 21262d c9d1d9 adb5bd e6edf3 8b949e 444c56 111619`. Use tokens instead.
- (e) **Every `var(--x)` used must be declared in the stylesheet.** Reuse existing tokens (`--card --card2 --border --border2 --text --text-2 --muted --green --green-tint --green-line --radius-md --radius-lg --sp-sm --sp-md --sp-lg --fs-sm --fs-base --fs-md --fs-lg --shadow-sm`, all in `:root` at `:12-45`). If a genuinely new token is needed, declare it in `:root`.
- (f) No emoji except `✓ ✕ → ← …`. Use `→` for the "next" indicator (already used in the UI; also outside the guard's emoji ranges).
- (g) No `text-shadow`, no literal `transform:rotate(`. (h) No `backdrop-filter` outside the 3 allowed modals. (i) No new `!important`.
- The guard also parses the inline `<script>` with `new Function(...)` — any JS syntax error fails check (b).

**Conventions:** camelCase functions, `escHtml()` (`:2761`) for any user-supplied text in template strings, `notify(msg, 'warn')` for errors / `notify(msg)` for success toasts.

## Runtime Environment

- **Start command (local):** `node server.js` → http://localhost:3000 (per repo `server.js`). Local server supports court/round logic (what this feature uses); history/sessions/lucky-draw flows are not fully testable locally — use the Vercel deploy for those (not needed here).
- **Deploy:** push to GitHub `Toramiyuu/TZHPlauyers` → auto-deploys to tzhplayers.vercel.app.
- **Design guard:** `npm test` → `node scripts/verify-redesign.js` (exit 0 = pass).
- **Admin:** open with `?admin` or `#admin`; password `TZH123` (env `ADMIN_PASSWORD`).

## Assumptions

- The full schedule is generated up front so `rounds[ri+1]` is the real "next" round — supported by `generateSchedule()` (`:1780`) filling all rounds and `courtRounds` tracking per-court position. Tasks 1, 3, 4 depend on this.
- A new top-level `state.showNextUp` persists with no backend change — supported by `api/state.js:179` (`state = { ...state, ...updates }`). Task 2 depends on this.
- Default visibility is ON: viewer treats `state.showNextUp !== false` as shown, so existing deployments (no field) show the panel. Tasks 1, 2 depend on this.
- The override editor targets doubles courts (4 player slots) and reuses `buildPlayerSelect`, which lists all session players with no explicit "empty" option — same limitation as the existing round editor (`:1888`). Singles/empty next-round slots default to the first player on save, exactly as the round editor already behaves. Task 3 depends on this.
- Calling `advanceCourt`/`renderCourtControls`/`renderRoundList` from the viewer is safe because the admin DOM nodes exist (the `#admin` div is `display:none`, not removed). Task 4 depends on this.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| New CSS uses an undeclared `var(--x)` → guard check (e) fails | Medium | Build/test red | Reuse only the listed existing tokens; if a new one is needed, declare it in `:root`. Run `npm test` after CSS edits. |
| Override save places the same player in two courts of one round | Medium | Invalid schedule | `saveNextUp()` validates duplicates **per affected next-round index** before posting (mirrors `saveRound`); aborts with `notify(...,'warn')`. |
| Poll rebuilds the editor and resets an in-progress selection | Medium | Lost admin edit | Rely on existing `isEditing()` guard in `poll()` (focused `<select>` pauses state sync); explicit "Save Up Next" button commits. Same as round editor. |
| Up Next panel flickers every 2s poll | Medium | Poor UX on the always-on display | Render `renderUpNext()` inside the `__lastCourtSig` guarded block with `snu`/`adm` added to the signature — rebuilds only on real change. |
| Court on last round has no next | High | Undefined read / empty UI | Panel skips that court's row (hides whole panel if none); editor shows an inline "on last round" note and excludes it from save. |
| Clicking a viewer row as admin doesn't refresh the viewer | Medium | Stale display until next poll | Add `renderViewer()` to `advanceCourt()` so the viewer updates immediately. |

## Goal Verification

### Truths

1. On the viewer, for every court that has a next round, an "Up Next" row shows that court's next matchup (`Court N → A & B vs C & D`). — TS-001
2. The panel is hidden entirely when no court has a next round, or when `state.showNextUp === false`. — TS-001, TS-002
3. The admin show/hide toggle flips `state.showNextUp`, persists, and the viewer reflects it within one poll. — TS-002
4. "Start Next Round" advances each court by exactly one round (offsets preserved), bounded at the last round, and the viewer/admin update. — TS-003
5. The override editor writes the chosen players into `rounds[ri+1].courts[i]`, rejects duplicate players within a round, and the viewer Up Next reflects the saved change. — TS-004
6. When the viewing device is a logged-in admin, clicking an Up Next row advances that one court and the panel updates immediately; a non-admin device shows the same rows as plain (non-clickable) text. — TS-005
7. `npm test` (design guard) exits 0 after all changes. — TS-006

### Artifacts

- `public/index.html` — `renderUpNext()`, `#upNextPanel` markup + CSS, signature integration in `renderViewer()`.
- `public/index.html` — `toggleNextUp()`, `startNextRound()`, toggle + button markup in the Courts tab, checkbox sync in `renderCourtControls()`.
- `public/index.html` — `renderNextUpEditor()`, `saveNextUp()`, `#upNextEditor` markup.
- `public/index.html` — `advanceCourt()` gains a `renderViewer()` call; `renderUpNext()` admin-clickable branch.

## E2E Test Scenarios

### TS-001: Up Next panel appears for courts with a next round
**Priority:** Critical
**Preconditions:** App loaded as a non-admin viewer; a schedule of ≥2 rounds is generated; courts are on round 1 (not the last round).
**Mapped Tasks:** Task 1

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/` (viewer) | Courts grid shows current round matchups |
| 2 | Read the area below the courts grid | An "Up Next" panel lists one row per court: `Court N → <next round's players>` matching `rounds[currentRound+1]` |
| 3 | In admin, advance all courts to the **last** round, return to viewer | The Up Next panel is not shown (no next round for any court) |

### TS-002: Show/hide toggle controls the viewer panel
**Priority:** High
**Preconditions:** Admin logged in (`?admin`, password), schedule with a next round exists.
**Mapped Tasks:** Task 2

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open admin → Courts tab | "Show Up Next on viewer" toggle is present and checked (default ON) |
| 2 | Uncheck the toggle | Toast confirms; open the viewer → Up Next panel is gone |
| 3 | Re-check the toggle, open the viewer | Up Next panel returns |

### TS-003: Start Next Round advances each court by one
**Priority:** High
**Preconditions:** Admin logged in; ≥3 rounds; set Court 1 to Round 2 and Court 2 to Round 1 via the per-court → buttons.
**Mapped Tasks:** Task 2

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Note each court's round in the per-court controls | C1=Round 2, C2=Round 1 |
| 2 | Click "Start Next Round" | Toast confirms; C1=Round 3, C2=Round 2 (each +1, offsets preserved) |
| 3 | Put all courts on the last round, click "Start Next Round" again | No change; a warn toast indicates courts are already on the last round |

### TS-004: Override who's next writes the next round and validates duplicates
**Priority:** Critical
**Preconditions:** Admin logged in; ≥2 courts each with a next round; ≥6 session players. For step 4, set the two courts to **different** rounds (e.g. C1=Round 1, C2=Round 2) so their next rounds are different indices.
**Mapped Tasks:** Task 3

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open Courts tab → "Up Next — Override" | Per-court dropdowns prefilled with the next round's players + a "Save Up Next" button; any court on its last round shows an "on last round" note instead |
| 2 | Change Court 1 Team A player 1 to a resting player, click "Save Up Next" | Success toast; viewer's Up Next row for Court 1 shows the new player |
| 3 | Set two slots in the **same** court (or two courts sharing one next-round index) to the same player, click "Save Up Next" | Warn toast naming the duplicate; nothing is saved |
| 4 | With C1 and C2 on different rounds, set the same player into C1's next round AND C2's next round (different indices), click "Save Up Next" | Saves successfully (no duplicate error) — the same player in two *different* next rounds is allowed |

### TS-005: Admin-only clickable Up Next on the viewer
**Priority:** High
**Preconditions:** Two browser contexts — one logged-in admin device, one plain viewer device; schedule with a next round.
**Mapped Tasks:** Task 4

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | On the plain viewer device, hover/click an Up Next row | Row is plain text, no pointer cursor, click does nothing |
| 2 | On the admin device, open the viewer (View Display) and click an Up Next row | That court advances to its next round; the panel updates immediately (row reflects the new next round or disappears if now last) |
| 3 | As admin, keep clicking rows until every court reaches its last round | The whole Up Next panel hides cleanly — no orphan empty panel, no console error |

### TS-006: Design guard stays green
**Priority:** Critical
**Preconditions:** All code changes complete.
**Mapped Tasks:** Task 1–4

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Run `npm test` | `RESULT: PASS — all design-system checks green.` exit 0 |

## E2E Results

Executed via Claude Code Chrome against the local dev server (`node server.js`, in-memory state mirroring the real `state = {...state, ...updates}` merge) with a seeded 2-court / 3-round schedule. Evidence: screenshots + in-page assertions.

| Scenario | Priority | Result | Fix Attempts | Notes |
|----------|----------|--------|--------------|-------|
| TS-001 Up Next panel | Critical | PASS | 0 | Panel renders directly below the court cards (wrapper fix verified); correct next-round players; hides when all courts on last round |
| TS-002 Show/hide toggle | High | PASS | 0 | `toggleNextUp(false)` → panel hidden + "Up Next hidden" toast; `(true)` → panel shown with 2 rows |
| TS-003 Start Next Round | High | PASS | 0 | Both courts R1→R2 (offsets preserved); no-op + "All courts are on the last round" warn when all on last |
| TS-004 Override editor | Critical | PASS | 0 | Editor prefilled with next round; valid save persisted to viewer AND server (`{team1:[p0,p1],team2:[p4,p5]}`); duplicate "Thomas" rejected (warn, nothing saved) |
| TS-005 Admin clickable rows | High | PASS | 0 | Admin: rows `clickable`/`role=button`/cursor:pointer, click advanced single court + panel updated; last-round row removed; all-last hides panel cleanly; non-admin rows plain (no clickable/onclick, cursor:auto) |
| TS-006 Design guard | Critical | PASS | 0 | `npm test` → all 9 design checks green + 3 behavioral suites pass |

## Not Verified

| Not Verified | Reason |
|-------------|--------|
| Vercel/Upstash-Redis production path | Out of scope — no backend change; local `server.js` mirrors the same generic field-merge that `api/state.js:179` uses, exercised in TS-004 (server round-trip confirmed) |
| Cross-device real-time sync of the panel across two physical devices | Untestable in this harness; covered indirectly by the 2s poll + verified single-device updates |

## Progress Tracking

- [x] Task 1: Viewer "Up Next" panel (read-only) + render-signature integration
- [x] Task 2: Admin show/hide toggle + "Start Next Round" button
- [x] Task 3: "Override who's next" editor (dropdowns + Save Up Next)
- [x] Task 4: Admin-only clickable Up Next rows on the viewer

      **Total Tasks:** 4 | **Completed:** 4 | **Remaining:** 0

## Implementation Tasks

### Task 1: Viewer "Up Next" panel (read-only) + render-signature integration

**Objective:** Render a panel below the courts grid showing each court's next-round matchup, flicker-free, respecting `state.showNextUp`.
**Dependencies:** None
**Mapped Scenarios:** TS-001, TS-002 (display side), TS-006

**Files:**
- Modify: `public/index.html` (markup after `#courtsDisplay` at `:857`; new CSS in `<style>`; `renderViewer()` at `:1269`; new `renderUpNext()`)

**Key Decisions / Notes:**
- **Placement (avoid the `flex:1` push-down):** wrap the courts grid and the new panel in a container so the panel sits directly beneath the cards. Replace the bare `#courtsDisplay` at `:857` with `<div class="viewer-main"><div id="courtsDisplay"></div><div id="upNextPanel" class="upnext-panel"></div></div>` (still before `.viewer-footer` at `:858`). CSS: `.viewer-main { flex:1; display:flex; flex-direction:column; gap:var(--sp-md); min-height:0 }` and keep `#courtsDisplay { flex:1 }` inside it; `.upnext-panel { flex:0 0 auto }` so it hugs the bottom of the cards. (Without the wrapper, `#courtsDisplay`'s `flex:1` absorbs all height and shoves the panel to the footer.) Confirm the actual vertical placement in the browser and adjust flex if needed.
- `renderUpNext()`: compute `courtRounds = getCourtRounds()`, `total = state.rounds.length`. If `state.showNextUp === false` → clear panel, `display:none`, return. For each court `i`, `ni = courtRounds[i]+1`; skip if `ni >= total` or `!rounds[ni].courts[i]`. Build rows `Court ${i+1} → ${nameA} & ${nameB} vs ${nameC} & ${nameD}` using `playerById` (fallback `'TBD'`) and `escHtml`. If no rows → hide panel. Otherwise show.
- In `renderViewer()`, add `snu: state.showNextUp, adm: !!sessionStorage.getItem('adminPwd')` to the `stateSig({...})` call (`:1277`) and call `renderUpNext()` inside the `if (courtSig !== __lastCourtSig) { ... }` block (after the court loop).
- CSS: reuse only declared tokens (`--card --border --text --text-2 --muted --green --green-tint --radius-md --sp-sm --sp-md --fs-sm --fs-base --fs-md --shadow-sm`). Use `→` glyph. No `text-shadow`/`!important`.

**Definition of Done:**
- [ ] `npm test` passes (design guard green)
- [ ] Inline `<script>` parses (no syntax error)
- [ ] Viewer shows one Up Next row per court that has a next round, with correct next-round players
- [ ] Panel hides when `state.showNextUp === false` or when no court has a next round
- [ ] Panel renders **directly below the court cards** (visual browser check on a tall window), not floated near the footer
- [ ] No visible flicker on the 2s poll (panel only rebuilds when courts/rounds/toggle/admin-state change)

**Verify:**
- `npm test`
- `node server.js`, open `http://localhost:3000`, generate a schedule via admin, confirm the panel renders below the courts.

### Task 2: Admin show/hide toggle + "Start Next Round" button

**Objective:** Add a Courts-tab toggle that persists `state.showNextUp`, and a button that advances every court forward one round (offsets preserved).
**Dependencies:** Task 1 (viewer reads `showNextUp`)
**Mapped Scenarios:** TS-002, TS-003

**Files:**
- Modify: `public/index.html` (Courts tab markup near `:982`–`988`; new `toggleNextUp()`, `startNextRound()`; checkbox sync inside `renderCourtControls()` at `:1347`)

**Key Decisions / Notes:**
- Markup: in the Courts tab, after the per-court controls / resting strip (`:988`), add a row with the "Start Next Round →" primary button (`class="btn btn-primary btn-sm"`) and a labelled checkbox `id="showNextUpToggle"` ("Show Up Next on viewer") with `onchange="toggleNextUp(this.checked)"`. Use `.admin-btn-row`/`.admin-mt` classes.
- `toggleNextUp(on)`: `await apiPost({ showNextUp: on }); state.showNextUp = on; renderViewer(); notify(on ? 'Up Next shown on viewer' : 'Up Next hidden on viewer');`
- `startNextRound()`: `total = rounds.length`, `cur = getCourtRounds()`, `next = cur.map(r => Math.min(total-1, (r ?? 0)+1))`. If `next` equals `cur` for all courts → `notify('All courts are on the last round','warn')` and return. Else `await apiPost({ courtRounds: next }); state.courtRounds = next; renderCourtControls(); renderRoundList(); renderViewer(); notify('Started next round');`
- In `renderCourtControls()`, after building the grid, set `document.getElementById('showNextUpToggle').checked = state.showNextUp !== false;` (guard for null).

**Definition of Done:**
- [ ] `npm test` passes
- [ ] Toggle reflects current `state.showNextUp` (checked by default) and flipping it updates the viewer within one poll
- [ ] "Start Next Round" advances each court by exactly +1, preserves per-court offsets, and is a no-op (warn toast) when all courts are on the last round
- [ ] Admin panel and viewer both reflect the new rounds immediately

**Verify:**
- `npm test`
- Local browser: toggle off → viewer panel gone; set courts to different rounds → click Start Next Round → each advances by one.

### Task 3: "Override who's next" editor (dropdowns + Save Up Next)

**Objective:** Per-court editor for the next round's matchup using dropdowns, saved with duplicate validation, handling the last-round case.
**Dependencies:** None (reuses `buildPlayerSelect`)
**Mapped Scenarios:** TS-004

**Files:**
- Modify: `public/index.html` (Courts tab markup near `:988`; new `renderNextUpEditor()`, `saveNextUp()`; call `renderNextUpEditor()` from `renderCourtControls()`)

**Key Decisions / Notes:**
- Markup: add `<div class="admin-subsection-label">Up Next — Override</div><div id="upNextEditor"></div>` in the Courts tab (below the Start Next Round row), and a "Save Up Next" button (or render it inside `#upNextEditor`).
- `renderNextUpEditor()`: for each court `i`, `ni = courtRounds[i]+1`. If `ni >= rounds.length` → render an inline note "Court N: on last round (no next round)". Else reuse the round-editor markup (`.court-editor`/`.selectors-row`/`.rl-team-label`/`.amp`/`.vs-small`) with selects `un_c${i}_t1p1|t1p2|t2p1|t2p2` via `buildPlayerSelect(elId, rounds[ni].courts[i].team?[k])`. Render one "Save Up Next" button calling `saveNextUp()`. Call this from the end of `renderCourtControls()`.
- `saveNextUp()` (mirror `saveRound`): deep-clone `state.rounds`; for each court `i` with a next round, read its 4 selects and set `rounds[ni].courts[i] = { team1:[t1p1,t1p2], team2:[t2p1,t2p2] }`.
- **Duplicate check scoped per next-round INDEX (critical — not a flat dedupe):** courts can have *different* `courtRounds[i]`, so court 0's next round and court 1's next round may be different round objects. Group the edited courts by their `ni`; within **each `ni` group only**, collect all ids across that round's courts and reject if any id repeats → `notify('Duplicate player: '+names,'warn')` and abort (no post). A player legitimately appearing in two courts whose next rounds are *different* indices MUST be allowed; a player in two courts that *share* one `ni` MUST be rejected. (A naive flat dedupe across all selects would wrongly flag the former and could miss the latter.)
- On success: `await apiPost({ rounds }); state.rounds = rounds; renderCourtControls(); renderRoundList(); renderViewer(); notify('Up Next saved!');`
- Poll-safety is automatic via `isEditing()` (focused `<select>` pauses polling) — same as the round editor.

**Definition of Done:**
- [ ] `npm test` passes
- [ ] Editor shows prefilled dropdowns for each court that has a next round, and an "on last round" note otherwise
- [ ] Saving writes the selected players into `rounds[ri+1].courts[i]`; the viewer Up Next reflects it
- [ ] Same player placed in two courts that **share** one next-round index is rejected (warn toast, nothing saved)
- [ ] Same player placed in two courts whose next rounds are **different** indices is **allowed** (saves successfully)

**Verify:**
- `npm test`
- Local browser: change a next-round dropdown, Save → viewer updates; force a duplicate → warn toast, no change.

### Task 4: Admin-only clickable Up Next rows on the viewer

**Objective:** When the viewing device is a logged-in admin, make Up Next rows clickable to advance that one court; refresh the viewer immediately.
**Dependencies:** Task 1
**Mapped Scenarios:** TS-005

**Files:**
- Modify: `public/index.html` (`renderUpNext()` clickable branch + CSS; `advanceCourt()` at `:1818` add `renderViewer()`)

**Key Decisions / Notes:**
- In `renderUpNext()`, compute `isAdmin = !!sessionStorage.getItem('adminPwd')` (already in the signature). When `isAdmin`, add class `clickable` and `onclick="advanceCourt(${i},1)"` + `title` to each row; otherwise plain. (Since the signature includes `adm`, login state changes trigger a rebuild.)
- Add CSS `.upnext-row.clickable { cursor:pointer } .upnext-row.clickable:hover { background:var(--green-tint) }` — declared tokens only.
- Add `renderViewer();` to the end of `advanceCourt()` (after `renderRoundList()`), so clicking on the viewer updates the courts + Up Next instantly (also benefits the admin per-court → buttons). `renderViewer()` is signature-guarded, so this is cheap.

**Definition of Done:**
- [ ] `npm test` passes
- [ ] On a logged-in admin device, Up Next rows show a pointer cursor + hover state and clicking advances that court; the panel updates immediately
- [ ] On a non-admin device, rows are plain text and not clickable
- [ ] Advancing the **final** court via its Up Next row hides the whole panel cleanly (no orphan empty panel, no console error)
- [ ] `advanceCourt()` still works from the admin per-court controls (no regression — no double-render glitch from the added `renderViewer()`)

**Verify:**
- `npm test`
- Local browser: with `sessionStorage.adminPwd` set (log in), open View Display, click a row → that court advances and the panel refreshes. Clear admin creds → rows are inert.
