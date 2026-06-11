# Admin Panel Revamp Implementation Plan

Created: 2026-06-10
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Complete revamp of the Admin Panel in `public/index.html` — replace single long scroll with tabbed navigation (Session, Courts, Engagement, Settings), modern dashboard styling, responsive design, full modal redesign, and polish to perfection. All existing functionality preserved.

**Architecture:** Single-file vanilla JS/CSS restructure. Admin markup split into 4 tab panels controlled by `setAdminTab()`. All inline styles moved to CSS classes. New CSS custom properties for spacing/shadow/radius/font-size scales. Modals redesigned with dashboard-consistent classes.

**Tech Stack:** Vanilla JS, HTML, CSS (no framework, no build step, no new dependencies)

## Scope

### In Scope

- Tabbed admin navigation (Session, Courts, Engagement, Settings)
- Persistent admin header with session date at-a-glance, View Display, Log Out
- CSS design system: new tokens for spacing, shadows, radii, font sizes
- Move all inline `style="..."` to CSS classes
- Responsive layout (mobile-first, desktop multi-column)
- Modern dashboard styling distinct from customer-facing pages
- Full modal redesign (pwModal, addRosterModal, guestModal, bulkModal, historyModal)
- Consistent form controls (inputs, selects, labels)
- Tab state persistence in localStorage
- Poll-safe tab switching (no reload, no focus theft)

### Out of Scope

- API changes (server.js / api/state.js untouched)
- Viewer display changes (#viewer, court cards, leaderboard modal on viewer)
- Landing page / site gate changes
- Lucky draw wheel overlay changes
- Members modal (viewer-side)
- New features or functionality — pure reskin/restructure

## Approach

**Chosen:** Progressive restructure
**Why:** Lower risk of breaking existing `getElementById` references. Each task builds on the previous, and we can verify functionality incrementally.
**Alternatives considered:** Clean rewrite of admin section — produces cleaner code but higher risk of missed element ID connections.

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:** Existing `.section`, `.btn`, `.row` class system (index.html:57-60). CSS custom properties in `:root` (index.html:9-13).
- **Conventions:** All code lives in `public/index.html` — CSS in `<style>`, HTML in `<body>`, JS in `<script>`. No build step. No framework. Element IDs are used extensively by render functions.
- **Key files:**
  - `public/index.html` — the ONLY file to modify (~2343 lines total)
  - `server.js` — local dev server (read-only, use for testing)
  - `api/state.js` — Vercel serverless endpoint (read-only)
- **Gotchas:**
  - `renderPlayersSection()` writes to `#rosterGrid`, `#guestStrip`, `#sessionCount` — these IDs must exist in the Session tab panel at all times
  - `renderCourtControls()` writes to `#courtCtrlGrid`, `#currentRoundPill`, `#prevRoundBtn`, `#nextRoundBtn`, `#restingStrip` — must exist in Courts tab
  - `renderDrawPool()` writes to `#drawPool` — must exist in Engagement tab
  - `renderSiteCodeSection()` writes to `#siteCodeDisplay` — must exist in Settings tab
  - `renderAdmin()` calls all renderers — all tab panels must have their target IDs present in DOM (even if hidden via CSS)
  - `poll()` (line 861) re-renders court controls, round list, and draw pool every 2s — guarded by `isEditing()`. Active tab content must refresh without stealing focus.
  - `isEditing()` checks `document.activeElement` for INPUT/TEXTAREA/SELECT — this guards against poll re-renders while typing
  - The `addRosterModal` and `guestModal` have big inline style blocks (lines 394, 413) that need to move to CSS classes
  - `showAdmin()` sets `#admin` to `display:flex` — the tab system must work within flex layout
- **Domain context:** Badminton club admin manages sessions, players, court schedules, lucky draw, and site access. Admin is used courtside on phones.

## Runtime Environment

- **Start command:** `npm start` (runs `server.js` on port 3000)
- **Deploy:** Push to GitHub auto-deploys on Vercel
- **Health check:** Visit `http://localhost:3000/` — should show viewer; click "Admin" button

## Assumptions

- All tab panel content exists in DOM simultaneously (hidden via `display:none`) so `getElementById` calls in render functions always find their targets — supported by how current `renderAdmin()` works. Tasks 1-7 depend on this.
- The `isEditing()` guard is sufficient for poll-safe editing across tabs — no per-tab guard needed. Supported by current implementation (index.html:855-859). Tasks 1, 4 depend on this.
- Mobile bottom tab bar is acceptable UX for thumb-friendly navigation. User confirmed "either works." Task 2 depends on this.
- Points editing stays in Session tab alongside player roster cards. User confirmed decision (1). Task 3 depends on this.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Broken element IDs after restructure | Medium | High | Keep all existing IDs; verify every `getElementById` reference after moving markup into tab panels |
| Poll re-render breaks active tab state | Low | Medium | Tab panels stay in DOM (hidden, not removed); `isEditing()` guard unchanged |
| Mobile tab bar overflow at 375px | Medium | Low | Use icons + short labels; test at 375px explicitly in Task 2 |
| CSS specificity conflicts with existing styles | Low | Medium | New admin styles scoped under `#admin` or `.admin-*` prefix; extend `:root` vars, don't override |

## Goal Verification

### Truths

1. Admin panel shows 4 tabs (Session, Courts, Engagement, Settings) with only the active tab's content visible
2. Persistent header shows session date, "View Display" and "Log Out" on every tab
3. All 24+ inline `style="..."` attributes in admin markup replaced with CSS classes
4. All 5 modals (pw, addRoster, guest, bulk, history) have dashboard-consistent styling with no inline styles
5. Layout works at 375px (no overflow, thumb-friendly tabs) and 1280px (multi-column where appropriate)
6. Every feature from the inventory list still functions (TS-001 through TS-004 pass)
7. No regressions in viewer, landing page, leaderboard modal, or wheel overlay

### Artifacts

- `public/index.html` — modified with new admin structure, CSS, and tab logic

## E2E Test Scenarios

### TS-001: Tab Navigation and State Persistence
**Priority:** Critical
**Preconditions:** Admin logged in, state loaded
**Mapped Tasks:** Task 1, Task 2

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to localhost:3000, click Admin, enter password | Admin panel opens on Session tab (default) |
| 2 | Click "Courts" tab | Courts tab content visible, Session content hidden, no page reload |
| 3 | Click "Engagement" tab | Engagement content visible, Courts hidden |
| 4 | Click "Settings" tab | Settings content visible |
| 5 | Click "Session" tab | Back to Session tab |
| 6 | Click "View Display" in header | Switches to viewer |
| 7 | Click Admin button, re-enter admin | Returns to last active tab (Session) |
| 8 | Verify persistent header shows session date, View Display, Log Out on each tab | All visible on every tab |

### TS-002: Session Tab — Players & Points
**Priority:** Critical
**Preconditions:** Admin logged in, roster has players
**Mapped Tasks:** Task 3

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | On Session tab, tap a roster player card | Player toggles in/out of session, check mark appears/disappears |
| 2 | Click player name to edit inline | Name becomes editable input, type new name, press Enter |
| 3 | Click player photo area | File picker opens for photo upload |
| 4 | Click +/- on points controls | Points value changes, leaderboard updates |
| 5 | Click "+ Add to Roster" | Modal opens with dashboard styling, add a player |
| 6 | Click "+ Add Multiple" | Bulk modal opens, enter names, confirm import |
| 7 | Click "+ Add Guest" | Guest modal opens, add guest, appears in guest strip |
| 8 | Start typing in date input, wait 3+ seconds | Poll does NOT clear the input (isEditing guard works) |

### TS-003: Courts Tab — Schedule Management
**Priority:** Critical
**Preconditions:** Admin logged in, players in session
**Mapped Tasks:** Task 4

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Switch to Courts tab | Court count, quick nav, per-court controls, generate section, round list all visible |
| 2 | Change courts count and save | Number updates |
| 3 | Click Generate Schedule (with enough players) | Rounds generated, round list populates |
| 4 | Click Next/Prev in quick round nav | Round pill updates, court displays change |
| 5 | Click per-court advance arrows | Individual court round changes |
| 6 | Expand a round row, edit player assignments, save | Round saved, court displays update |
| 7 | Click "Set Live" on a round | All courts switch to that round |
| 8 | Click "+ Add Round Manually" | New round appears at bottom of list |

### TS-004: Engagement & Settings Tabs
**Priority:** High
**Preconditions:** Admin logged in, players in session
**Mapped Tasks:** Task 5, Task 6

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Switch to Engagement tab | Lucky Draw section visible with pool and controls |
| 2 | Click "Pull today's session" | Pool populates with player names |
| 3 | Add a name manually via input | Name appears in pool |
| 4 | Click "Spin the Wheel!" | Wheel overlay appears on viewer, animates, shows winner |
| 5 | Switch to Settings tab | Share link and site access code sections visible |
| 6 | Click "Copy Link" | Link copied to clipboard |
| 7 | Click "Generate" for site code | Code appears in input |
| 8 | Save site code | Code displays as active, large monospace display |

## E2E Results

| Scenario | Priority | Result | Fix Attempts | Notes |
|----------|----------|--------|--------------|-------|
| TS-001   | Critical | PASS   | 0            | Tab nav, localStorage persistence, header visible on all tabs |
| TS-002   | Critical | PASS   | 0            | Player toggle, inline name edit, points +/-, modals, isEditing guard |
| TS-003   | Critical | PASS   | 0            | Courts count, quick nav, per-court controls, round list, Set Live |
| TS-004   | High     | PASS   | 0            | Draw pool, manual add, Settings share link, Generate site code |

## Progress Tracking

- [x] Task 1: CSS Design System & Tab Infrastructure
- [x] Task 2: Responsive Tab Bar & Persistent Header
- [x] Task 3: Session Tab — Date, Players, Points
- [x] Task 4: Courts Tab — Schedule Management
- [x] Task 5: Engagement Tab — Lucky Draw
- [x] Task 6: Settings Tab — Share Link & Site Code
- [x] Task 7: Modal Redesign & Final Polish
      **Total Tasks:** 7 | **Completed:** 7 | **Remaining:** 0

## Implementation Tasks

### Task 1: CSS Design System & Tab Infrastructure

**Objective:** Establish new CSS custom properties, create tab container markup with `setAdminTab()` logic, and set up the admin panel skeleton with all 4 tab panels.
**Dependencies:** None
**Mapped Scenarios:** TS-001 (steps 1-5)

**Files:**

- Modify: `public/index.html`

**Key Decisions / Notes:**

- Extend `:root` with new tokens (index.html:9-13): `--sp-xs: 4px` through `--sp-2xl: 48px`, `--radius-sm/md/lg`, `--shadow-sm/md/lg`, `--fs-xs` through `--fs-2xl`, `--admin-bg` (slightly different from `--dark` for admin distinction)
- Add scoped admin CSS: `.admin-tabs`, `.admin-tab-btn`, `.admin-tab-panel`, `.admin-card` (replaces `.section` in admin)
- `setAdminTab(name)` toggles `.active` class on tab buttons and panels. Saves to `localStorage.setItem('adminTab', name)`. Default: 'session'.
- Wrap each existing admin `.section` in the appropriate `<div class="admin-tab-panel" data-tab="...">` — keep all content in DOM, toggle via CSS `display`.
- Keep ALL existing element IDs unchanged. Verify: `rosterGrid`, `courtCtrlGrid`, `roundList`, `drawPool`, `sessionDateDisplay`, `sessionCount`, `siteCodeDisplay`, `shareLink`, `currentRoundPill`, `numCourtsInput`, `prevRoundBtn`, `nextRoundBtn`, `restingStrip`, `guestStrip`, `drawNameInput`, `numRoundsInput`, `generateBtn`, `siteCodeInput`.

**Definition of Done:**

- [ ] 4 tab panels exist in admin markup, `setAdminTab()` toggles visibility
- [ ] Only active tab panel is visible; other 3 are hidden
- [ ] New CSS tokens added to `:root`
- [ ] Tab state persists in localStorage
- [ ] `npm start` runs, admin shows tabs, switching works
- [ ] All existing element IDs present in DOM

**Verify:**

- `npm start` and manual check in browser at localhost:3000

---

### Task 2: Responsive Tab Bar & Persistent Header

**Objective:** Build the sticky admin header (session date at-a-glance, View Display, Log Out) and responsive tab bar that works at 375px and 1280px.
**Dependencies:** Task 1
**Mapped Scenarios:** TS-001 (steps 6-8)

**Files:**

- Modify: `public/index.html`

**Key Decisions / Notes:**

- Persistent header: replaces current `.admin-header` div (index.html:662-668). Shows formatted session date (from `renderSessionDateSection` — add a `#headerDate` span), "View Display" button, "Log Out" button. Always visible regardless of active tab.
- Tab bar sits below header. On desktop (>640px): horizontal row with text labels + icons. On mobile (<=640px): compact bottom bar with icons + short labels, fixed to bottom of viewport for thumb reach.
- Icons: use Unicode emoji that match existing section emojis — Session: 📅, Courts: 🏸, Engagement: 🎡, Settings: ⚙️
- Tab buttons: min 44px tap target on mobile
- No horizontal overflow at 375px — 4 tabs equally sized

**Definition of Done:**

- [ ] Persistent header shows session date, View Display, Log Out
- [ ] Tab bar with 4 tabs, icons + labels
- [ ] Mobile (<=640px): bottom fixed tab bar, no overflow at 375px
- [ ] Desktop (>640px): horizontal tabs below header
- [ ] Tab buttons have min 44px tap targets on mobile
- [ ] Switching tabs is instant, no layout shift

**Verify:**

- Browser test at 375px and 1280px viewport widths

---

### Task 3: Session Tab — Date, Players, Points

**Objective:** Restructure the Session tab content: session date picker, roster grid with points editing, guest strip, add-player buttons. Move all inline styles to CSS classes.
**Dependencies:** Task 1, Task 2
**Mapped Scenarios:** TS-002

**Files:**

- Modify: `public/index.html`

**Key Decisions / Notes:**

- Session Date section: keep `sessionDateDisplay`, `sessionDateInput`, "Set Date" button, "View History" button. Restyle with `.admin-card` and consistent form control classes.
- Roster grid: keep `#rosterGrid` ID and `.roster-grid` class. Cards get dashboard polish — cleaner backgrounds, better spacing. Points editing (`.rc-points`, `.rc-points-btn`, `.rc-points-input`) stays inside each roster card.
- Remove inline styles from: section-title `style="justify-content:space-between"` (line 684), helper text `style="font-size:11px..."` (line 688), button row `style="margin-top:8px"` (line 691), date input (line 676), date display (line 673).
- Create utility CSS classes: `.admin-form-input` (shared input styling), `.admin-form-label`, `.admin-helper-text`, `.admin-btn-row`.
- Session count `#sessionCount` element must remain for `renderPlayersSection()` to write to.

**Definition of Done:**

- [ ] Session tab shows date section + player roster + guest strip + action buttons
- [ ] All inline styles in Session tab content replaced with CSS classes
- [ ] Tap to toggle player in/out of session works
- [ ] Inline name edit works
- [ ] Photo upload works
- [ ] Points +/- and direct input work
- [ ] Add to Roster / Add Multiple / Add Guest buttons work
- [ ] Guest strip displays and remove works
- [ ] `isEditing()` guard prevents poll from disrupting active inputs

**Verify:**

- Test all player interactions in running app

---

### Task 4: Courts Tab — Schedule Management

**Objective:** Restructure the Courts tab: court count, quick round nav, per-court controls, resting strip, generate section, round list. Move inline styles to CSS classes.
**Dependencies:** Task 1, Task 2
**Mapped Scenarios:** TS-003

**Files:**

- Modify: `public/index.html`

**Key Decisions / Notes:**

- Courts count row: `#numCourtsInput` + Save button. Restyle input with `.admin-form-input`.
- Quick nav: keep `.quick-nav` structure with `#currentRoundPill`, `#prevRoundBtn`, `#nextRoundBtn`. Dashboard polish.
- Per-court controls: `#courtCtrlGrid` with `.court-ctrl-grid`. Keep existing grid layout but polish cards.
- Resting strip: `#restingStrip`. Keep existing structure.
- Generate row: `#numRoundsInput`, `#generateBtn`. Move inline styles from `.gen-row input[type=number]` to classes.
- Round list: `#roundList`. Keep all round-row/editor structure. Move inline styles from round editor labels and inputs (lines 1470-1474) to CSS classes.
- Remove inline styles from: "Individual Court Control" label (line 719), court count label (line 704), court count input (line 705), quick-nav margin (line 710), round editor label input (line 1473).
- On desktop (>900px): consider 2-column layout for courts count + quick nav side by side.

**Definition of Done:**

- [ ] Courts tab shows all court management controls
- [ ] All inline styles in Courts tab replaced with CSS classes
- [ ] Court count save works
- [ ] Quick round nav (Prev/Next) works
- [ ] Per-court advance arrows work
- [ ] Resting players strip updates correctly
- [ ] Generate schedule works (including confirm-to-replace)
- [ ] Round list: expand/collapse, edit, save, delete, set-live all work
- [ ] Add Round Manually works

**Verify:**

- Generate a schedule, navigate rounds, edit a round, verify viewer updates

---

### Task 5: Engagement Tab — Lucky Draw

**Objective:** Restructure the Engagement tab with Lucky Draw pool and spin controls. Move inline styles to CSS classes.
**Dependencies:** Task 1, Task 2
**Mapped Scenarios:** TS-004 (steps 1-4)

**Files:**

- Modify: `public/index.html`

**Key Decisions / Notes:**

- Lucky Draw section: keep `#drawPool`, `#drawNameInput`, all draw buttons. Restyle with `.admin-card`.
- Remove inline styles from: helper text (line 745), button rows (lines 747, 751), input (line 752-753), spin button (line 757).
- Pool chips (`.draw-chip`) get dashboard styling.
- Spin button: full-width accent style, prominent. Keep `spinWheel()` onclick.
- This tab may feel sparse with just Lucky Draw. Consider adding a "tip" or description card about the wheel feature to fill space appropriately. Don't add functionality — just polish the layout.

**Definition of Done:**

- [ ] Engagement tab shows Lucky Draw with pool, add, clear, spin
- [ ] All inline styles replaced with CSS classes
- [ ] Pull session into pool works
- [ ] Add name manually works
- [ ] Remove individual names works
- [ ] Clear pool works
- [ ] Spin wheel triggers overlay on viewer
- [ ] Pool chips styled consistently

**Verify:**

- Add names to pool, spin wheel, verify overlay appears

---

### Task 6: Settings Tab — Share Link & Site Code

**Objective:** Restructure the Settings tab with Share Viewer Link and Site Access Code sections. Move inline styles to CSS classes.
**Dependencies:** Task 1, Task 2
**Mapped Scenarios:** TS-004 (steps 5-8)

**Files:**

- Modify: `public/index.html`

**Key Decisions / Notes:**

- Share Viewer Link: keep `#shareLink`, `copyLink()`. Restyle `.link-box` with dashboard card.
- Site Access Code: keep `#siteCodeDisplay`, `#siteCodeInput`, `generateSiteCode()`, `saveSiteCode()`, `removeSiteCode()`. Move inline styles from: description text (line 763), code input (line 776), remove button wrapper (line 781-782).
- `renderSiteCodeSection()` writes inline styles into `#siteCodeDisplay` (line 1627-1631) — refactor these to use CSS classes instead of inline style strings in the JS function.
- On desktop: consider side-by-side layout for the two cards.

**Definition of Done:**

- [ ] Settings tab shows Share Link and Site Access Code
- [ ] All inline styles replaced with CSS classes
- [ ] Copy link works
- [ ] Generate / Save / Remove site code all work
- [ ] `renderSiteCodeSection()` uses CSS classes instead of inline style strings
- [ ] Active code displays with large monospace text

**Verify:**

- Generate a code, save it, verify display, remove it

---

### Task 7: Modal Redesign & Final Polish

**Objective:** Full dashboard redesign of all 5 modals (pwModal, addRosterModal, guestModal, bulkModal, historyModal). Final polish pass: consistent spacing, accessible markup, cleanup of any remaining inline styles.
**Dependencies:** Tasks 1-6
**Mapped Scenarios:** TS-001 through TS-004 (all — final regression sweep)

**Files:**

- Modify: `public/index.html`

**Key Decisions / Notes:**

- Create unified modal classes: `.modal-overlay` (replaces per-modal overlay styles), `.modal-box` (replaces `.pw-box`, `.bulk-box`, individual inline styles), `.modal-header`, `.modal-body`, `.modal-actions`.
- `addRosterModal` (line 394): move all inline styles to `.modal-overlay` + `.modal-box` classes. Photo preview area gets a proper class.
- `guestModal` (line 413): same treatment — move inline overlay + input styles to classes.
- `bulkModal` (line 381): already uses classes (`.bulk-box`) but needs dashboard-consistent restyling.
- `pwModal` (line 368): already uses classes (`.pw-box`) — restyle for dashboard consistency.
- `historyModal` (line 428): already has good CSS — harmonize with new dashboard tokens (spacing, radii, shadows).
- Grep for remaining `style="` in admin section and fix any stragglers.
- Ensure all buttons are real `<button>` elements (not `<div onclick>`).
- Verify `tab-index` and keyboard navigation basics.
- Run full feature parity sweep (every item from the inventory list in the prompt).

**Definition of Done:**

- [ ] All 5 modals use unified `.modal-*` CSS classes
- [ ] No inline `style="..."` on modal overlays or boxes (except `display:none` for hidden file inputs)
- [ ] Dashboard-consistent typography, spacing, borders, shadows across all modals
- [ ] Zero remaining unnecessary inline styles in admin markup
- [ ] Full feature parity sweep passes (every inventory item functional)
- [ ] No regressions in viewer, landing page, leaderboard modal, wheel overlay
- [ ] Responsive check at 375px and 1280px passes
- [ ] `npm start` works, no new dependencies

**Verify:**

- Open each modal, test its functionality
- Run through complete TS-001 to TS-004 scenarios
- Check 375px and 1280px viewports
- Grep admin markup for remaining `style="` attributes

---

## Open Questions

None — all decisions confirmed by user.

## Deferred Ideas

- Per-tab poll optimization (only re-render active tab's content) — not needed now since `isEditing()` guard is sufficient
- Keyboard shortcuts for tab switching (Ctrl+1/2/3/4)
- Animated tab transitions (slide/fade)
