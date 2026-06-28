# Audit — Engagement + Monthly Draw Overhaul (2026-06-28)

Fresh audit of the new Engagement (Lucky Draw) and Monthly Draw code added in this overhaul
(mechanics, visuals, bugs, accessibility, mobile). BUG_REPORT.md items B1–B9 were already fixed in
the prior code and were **not** re-touched. This note records what was audited, severity, and what changed.

## Scope audited
- Engagement: name-reel picker reuse, ranked winners, pool removal, editable draw date, viewer badge, wheel removal.
- Monthly: manual tube entry + stepper, token/leftover display, month header, auto-roll, manual close, ~20s undo, carry-over, additive CSV merge, history.
- Shared: the single `#pickerOverlay` reveal fed by two draw sources; `api/state.js` migration of old blobs.

## Findings & fixes

| # | Severity | Finding | Fix / status |
|---|----------|---------|--------------|
| A1 | High | Spin button stayed disabled after adding pool names — pool mutators (`addDrawName`/`removeDrawEntry`/`clearDrawPool`/`loadSessionIntoPool`) called `renderDrawPool()` but not `renderDrawResult()` (which computes the button's enabled state), and the focused input blocked the 2s poll from refreshing it. | Fixed — each pool mutator now also calls `renderDrawResult()` so the button updates immediately. Browser-verified. |
| A2 | High | Two independent live spins (engagement + monthly) could stomp the single picker overlay/`pickerRaf` (poll fires both `checkForNewSpin` + `checkForNewMonthlyDraw` each tick). | Fixed — `activeRevealKind` serializer; the non-owning source defers without consuming its guard and reveals once the overlay frees. |
| A3 | High | `mdRankLbl(4)` returns `'3rd'`; ranks >3 medal had no CSS color. | Fixed — engagement reveal uses `MonthlyDraw.ordinal()`; medal style class capped at `rank-3` (medal number/label still show the true rank). |
| A4 | High | Auto-roll could re-archive the month right after Undo, especially across a page reload (page-local guard lost). | Fixed — suppression persisted in shared state as `monthlyDraw.rollSuppressedMonth`; `ensureMonthlyRoll` skips when `md.month === md.rollSuppressedMonth`. Browser-verified across a reload. |
| A5 | High | Concurrent auto-roll could double-archive. | Fixed — `mdRolling` set before the first `await` in `rollMonth`, cleared in `finally`; `ensureMonthlyRoll` returns early if `mdRolling`. |
| A6 | Med | Engagement Spin could be re-enabled mid-reveal by the poll, allowing a second spin during the ~5.3s animation. | Fixed — enabled state is spin-aware: `poolHasEnough && !(spin live)`. Browser-verified (button stays disabled during reveal). |
| A7 | Med | A winner could be removed before its scheduled viewer reveal (admin/viewer desync). | Fixed — result rows + Remove buttons render only once `clockNow() >= result.at` (matches the viewer gate). |
| A8 | Med | CSV import / manual add could create duplicate identities or double-count on a stale copy. | Fixed — `await refreshState()` before merge; `mergeParticipants(..., {add:true})` matches by name(+phone); collision-resistant `newParticipantId()`. Browser-verified (re-add sums, no duplicate). |
| A9 | Med | Undo toast inside a `renderMonthlyTab`-managed container would be clobbered every 2s poll. | Fixed — `#mdUndoToast` mounted as a fixed-position sibling of `#notif`, outside any re-rendered container. |
| A10 | Med | Touch targets: `.md-tube-step button` was 26×26 (< 44px); new number/date inputs at 13–14px (iOS zoom-on-focus). | Fixed — `@media(max-width:640px)`: stepper buttons / delete / number+date inputs ≥44px and inputs ≥16px font. |
| A11 | Low | Focus-visible outlines missing on the new non-`.btn` controls. | Fixed — `.md-tube-step button`, `.md-cust-del`, `.draw-rank-del`, `.md-undo-btn` added to the focus-visible group. |
| A12 | Low | Orphaned code after wheel removal (`formatTimeAgo`, `.md-tickets` CSS, wheel default confetti id). | Fixed — removed; `launchConfetti` default points at `pickerConfetti`. |

## Changes-review findings (verification phase)

A final changes-review of the diff surfaced three more items, all applied and runtime-verified:

| # | Severity | Finding | Fix / status |
|---|----------|---------|--------------|
| A13 | should_fix | `rollMonth(isAuto)` did `await refreshState()` but never re-validated staleness afterward — a second admin device whose local `md.month` hadn't yet seen another device's roll would archive the now-current (empty) month a second time and pop a spurious undo toast. `mdRolling`/`lastAutoRolledFrom` only de-dupe within one session; `rollSuppressedMonth` only guards the post-Undo case. | Fixed — after the refresh, auto-roll re-checks `md.month && md.month < currentMonthKey()` and returns early if no longer stale. Manual `closeMonth` (isAuto=false) is unaffected. Runtime-verified: single-device auto-roll still fires (2026-05→2026-06, 13→1 tube); concurrent re-roll becomes a no-op. |
| A14 | suggestion | `stepParticipantTubes` computed an **absolute** target from the possibly-stale local tube count, so a concurrent edit on another device could be clobbered by the stepper. | Fixed — `setParticipantTubes(id, val, {delta:true})` applies the ±1 to the freshly-refreshed tube count. Runtime-verified (10→11 by one click). |
| A15 | suggestion | Manual add of an already-present name silently summed tubes (additive merge) with a generic "Added {name}." toast — surprising for an admin re-typing a name. | Fixed — when the add matches an existing identity, the toast reads "Added N tube(s) to {name}." Runtime-verified ("Added 2 tube(s) to Harvey.", tubes 11→13). |

Not taken: server.js `luckyDraw.drawDate` defaults to `null` while `api/state.js` uses `todayISO()`. Harmless (the client coalesces with `|| todayISO()`) and `server.js` is a local-dev-only convenience server; adding a date helper there is scope creep. Left as-is.

## Verified-good (no change needed)
- **`escHtml` coverage:** all user-entered names/phones are escaped in HTML and in `aria-label` attributes (escapes `"` → attribute-injection safe); `pickerName`/`pickerTitle` use `textContent`.
- **Poll clobber:** new date/tube/number inputs are real `<input>`s, so the existing `isEditing()` poll guard skips re-render while focused.
- **Sync:** reveals use `clockNow()` (server-offset clock); reduced-motion honored by the picker, confetti, and the undo toast.
- **Escape key:** closes the picker overlay (wheel branch removed).
- **Contrast:** new badges/chips reuse the already-proven `md-rank-*` / `md-win-badge` / `picker-prize` token pairs; viewer chips use `--accent` on the existing tinted pill.
- **Design guard:** `verify-redesign.js` green (no emoji, all `var()` resolve, no stray `backdrop-filter`/`text-shadow`/`!important`, inline script parses).

## Tests
- `npm test` green: `verify-redesign` + `test-monthly-draw` (99) + `test-state-normalize` (17) + `test-session-court` + `test-next-up`.
- New unit coverage: `ordinal` (incl. 11/12/13 teens), `withTokens`, `carryOverParticipants` (tubes%4, keep-zero), `mergeParticipants` (add-mode), `matchParticipant`/`participantKey`, `nextMonthKey`/`monthLabel`, `reindexRanks`, `parseDrawCsv` tubes; `normalizeDrawState` old-blob migration.
- Inline `<script>` passes `node --check`; `grep -in "wheel\|spinWheel\|lastWinner"` clean.

## Deferred to live-deploy verification
- Pixel-level mobile-width measurement (headless `playwright-cli` could not narrow its window; the `@media(max-width:640px)` rule is CSS-valid and its selectors match real elements). Full TS-001…005 re-run + mobile visual pass happen on `tzhplayers.vercel.app` after deploy (per the plan's confirmed decision #5).
