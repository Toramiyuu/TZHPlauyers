# Site-Wide Styling Cleanup Implementation Plan

Created: 2026-06-11
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Complete the de-glow pass, rebuild viewer buttons, reconcile the membership popup, optimize court display density, raise text contrast, consolidate duplicate design systems, and add accessibility basics — all CSS + minimal markup only, no JS/API changes.

**Architecture:** Single-file edit to `public/index.html` — all CSS rules in the `<style>` block (lines 7–480) plus targeted markup tweaks (aria-labels, class additions). No new dependencies, no `!important`, no JS logic changes.

**Tech Stack:** Vanilla CSS, HTML attributes (aria-label), existing design tokens in `:root`.

## Scope

### In Scope

1. Remove glow/bevel from `.gate-enter-btn` and `.cal-strip-btn.s-sel`
2. Rebuild `#membersBtn`, `#lbBtn`, `#adminBtn` as proper flat buttons
3. Restyle `.members-box` / tier cards / earn section / benefits section to flat dashboard aesthetic
4. Optimize court display density and responsive scaling
5. Raise contrast on dim text (`.rsummary`, `.btable td`, `.da`, `.cal-strip-name`)
6. Consolidate `.section`/`.admin-card` and `.row`/`.admin-btn-row` and `.modal-input`/`.admin-form-input` duplicates
7. Apply `--fs-*` tokens to hardcoded font sizes
8. Add `:focus-visible` outlines, aria-labels on icon-only buttons, bump tap targets, `prefers-reduced-motion`

### Out of Scope

- JavaScript logic changes
- API / server changes
- New dependencies
- Renaming/removing existing class names or IDs
- Content changes to membership tiers/benefits

## Approach

**Chosen:** Sequential CSS pass — work through each section of the stylesheet top-to-bottom, grouped by the 7 task areas. Each task is independently verifiable.

**Why:** Single file with no build step means changes are immediately visible on reload. Sequential ordering prevents conflicts between edits.

**Alternatives considered:** (1) Extract CSS to separate file — rejected, out of scope and would require build step. (2) CSS custom properties refactor first — rejected, tokens already exist, just need to apply them.

## Context for Implementer

> All work happens in one file: `public/index.html` (2698 lines). CSS is in lines 7–480, HTML markup follows, JS starts at line 961.

- **Design tokens** are in `:root` (lines 9–20): `--green`, `--green-light`, `--dark`, `--card`, `--card2`, `--border`, `--border2`, `--text`, `--muted`, `--accent`, `--red`, `--blue`, spacing `--sp-*`, radii `--radius-*`, shadows `--shadow-*`, type scale `--fs-*`, `--transition`
- **Intentional glows to KEEP:** `.status-dot` (line 39, `box-shadow:0 0 7px var(--green)`) and `.round-row.live .round-live-dot` (line 106, `box-shadow:0 0 6px var(--green)`) — these are "live" pulse indicators
- **Button system:** `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-accent`, `.btn-danger`, `.btn-ghost`, `.btn-sm` (lines 46–62) — flat, no glow, this is the target aesthetic
- **Two card systems to unify:** `.section`/`.section-title` (lines 63–65) and `.admin-card`/`.admin-card-title` (lines 430–432)
- **Two row systems:** `.row` (line 66) and `.admin-btn-row` (line 439)
- **Two input systems:** `.modal-input` (line 136) and `.admin-form-input` (line 435)
- **Existing `!important` to remove:** lines 248, 268 (tier-card/earn-item hover), line 467 (admin mobile padding — keep this one, it's a specificity override for mobile)
- **Dynamic markup:** Close/delete buttons are rendered both statically (lines 547, 629, 762) and dynamically in JS (line 1245 for `.rc-del`, line 1271 for guest chip ×). Aria-labels on static buttons go in HTML; dynamic ones need JS template literal updates.
- **Gotchas:** The `#adminBtn` (line 958) is outside the `#admin` div — it's always visible as a fixed position button. The `.gate-enter-btn` has a bouncy cubic-bezier transition that must be replaced with a standard ease.

## Runtime Environment

- **Start command:** `node server.js` (local dev) or Vercel auto-deploy
- **Port:** 3000 (local)
- **Deploy:** Push to GitHub → auto-deploys to `tzhplayers.vercel.app`

## Assumptions

- Design tokens in `:root` are correct and sufficient — no new tokens needed — supported by lines 9–20 — all tasks depend on this
- The `.btn-primary` style (lines 47–49) is the canonical flat button look — Task 1, 2 depend on this
- The `#admin{padding:16px 16px 72px !important}` mobile override (line 467) is acceptable to keep — it's a specificity workaround for mobile bottom tab bar padding — Task 3 depends on this
- Dynamic button markup in JS can receive aria-label attributes without breaking onclick handlers — Task 7 depends on this

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Breaking court layout at certain screen widths | Medium | High | Test at phone (375px), laptop (1280px), and TV (1920px+) widths for 1–4 courts |
| Membership popup content shift from removing rotations | Low | Medium | Only change CSS transforms, keep all padding/margin; verify content is intact |
| Focus ring interfering with existing border-based focus styles | Low | Low | Use `:focus-visible` (not `:focus`) and `outline-offset` to avoid overlap |

## Goal Verification

### Truths

1. No `box-shadow` glow/bevel exists on any button (only `.status-dot` and `.round-live-dot` pulses remain)
2. `#membersBtn`, `#lbBtn`, and `#adminBtn` are ≥40px tall with ≥14px text
3. Membership popup uses no rotations, no offset shadows, no `!important`, and surfaces use design tokens
4. Court cards feel dense and intentional at 2-court layout on wide screens (avatars/names scale up)
5. All dim text (`.rsummary`, `.btable td`, `.da`, `.cal-strip-name`) has contrast ratio ≥4.5:1 on `--dark`
6. `.section` and `.admin-card` render identically; `.row` and `.admin-btn-row` render identically
7. Every focusable control shows a visible `:focus-visible` ring; icon-only buttons have aria-labels

### Artifacts

- `public/index.html` — the single modified file containing all CSS and markup changes

## E2E Test Scenarios

### TS-001: Glow Audit — Gate Enter Button
**Priority:** Critical
**Preconditions:** Site has access code enabled
**Mapped Tasks:** Task 1

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to the site gate page | Gate screen displays with "Enter" button |
| 2 | Inspect `.gate-enter-btn` visually | No glow, no 3D bevel — flat green button |
| 3 | Hover over the button | Subtle darken effect, no scale bounce |

### TS-002: Viewer Buttons Visibility
**Priority:** Critical
**Preconditions:** Site loaded, viewer visible
**Mapped Tasks:** Task 2

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to viewer page | TZH Members, Leaderboard buttons visible in header |
| 2 | Inspect button sizes | Both buttons ≥40px tall, text ≥14px |
| 3 | Inspect Admin button (bottom-right) | Visible, flat, ≥40px tall |
| 4 | Resize to mobile width (375px) | Buttons remain well-sized, not tiny |

### TS-003: Membership Popup Aesthetic
**Priority:** High
**Preconditions:** Viewer loaded
**Mapped Tasks:** Task 3

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click "TZH Members" button | Modal opens |
| 2 | Inspect tier cards | No rotation, no hard offset shadows, flat cards with token surfaces |
| 3 | Inspect earn section | No rotation on items, no offset shadows |
| 4 | Scroll to benefits table | Table readable, dashes visible, content intact |
| 5 | Close modal | Closes cleanly |

### TS-004: Court Display Density
**Priority:** High
**Preconditions:** Admin has set up 2 courts with players
**Mapped Tasks:** Task 4

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to viewer with 2 courts | Courts display centered, not stretched edge-to-edge |
| 2 | Resize to 1920px width | Cards feel full, avatars/names scaled up, not swimming in empty space |
| 3 | Resize to 375px | Cards stack, readable |

### TS-005: Contrast and Readability
**Priority:** High
**Preconditions:** Rounds exist, membership popup accessible
**Mapped Tasks:** Task 5

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open admin, look at round summaries | `.rsummary` text is clearly readable |
| 2 | Open membership popup, scroll to benefits table | Table body text readable, dash marks ("—") visible |
| 3 | Open history calendar | Day name labels clearly visible |

### TS-006: Keyboard Focus Visibility
**Priority:** Medium
**Preconditions:** Any page loaded
**Mapped Tasks:** Task 7

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Tab through the page | Every button, input, select shows a visible focus ring |
| 2 | Click a button with mouse | No focus ring visible (`:focus-visible` scoping) |

## Progress Tracking

- [x] Task 1: De-glow pass — gate-enter-btn and cal-strip-btn
- [x] Task 2: Rebuild viewer buttons (membersBtn, lbBtn, adminBtn)
- [x] Task 3: Reconcile membership popup to flat aesthetic
- [x] Task 4: Court display density and responsive scaling
- [x] Task 5: Raise contrast on dim text
- [x] Task 6: Consolidate design system (cards, rows, inputs, type scale)
- [x] Task 7: Accessibility — focus rings, aria-labels, tap targets, reduced motion

**Total Tasks:** 7 | **Completed:** 7 | **Remaining:** 0

## Implementation Tasks

### Task 1: De-glow Pass — Gate Enter Button & Calendar Selected Day

**Objective:** Remove the remaining glow/bevel effects from `.gate-enter-btn` and `.cal-strip-btn.s-sel`, making them consistent with the flat button system.
**Dependencies:** None
**Mapped Scenarios:** TS-001

**Files:**

- Modify: `public/index.html` (CSS lines 233–235, 215)

**Key Decisions / Notes:**

- `.gate-enter-btn` (line 233): Strip `box-shadow` (inset bevel + outer glow), replace `transition` cubic-bezier bounce with standard ease, remove `transform:scale` on hover/active. Match `.btn-primary` style but larger.
- `.gate-enter-btn:hover` (line 234): Remove `box-shadow` and `transform:scale(1.03)`. Use `background:var(--green-light)` only.
- `.gate-enter-btn:active` (line 235): Remove `box-shadow` and `transform:scale(0.97)`. Use darker green.
- `.cal-strip-btn.s-sel` (line 215): Remove `box-shadow:0 4px 14px rgba(26,158,92,.45)` and `background:linear-gradient(...)`. Replace with flat `background:var(--green);color:#fff`.
- After changes, grep `box-shadow` to confirm no button glows remain (only `.status-dot` and `.round-live-dot` pulses, `.modal-box`, `.history-box` surface shadows).

**Definition of Done:**

- [ ] `.gate-enter-btn` has no `box-shadow`, no scale transform, no cubic-bezier bounce
- [ ] `.cal-strip-btn.s-sel` has flat green fill, no glow shadow
- [ ] `grep box-shadow` shows only intentional pulse indicators and surface shadows

**Verify:**

- Visual: load site gate, inspect enter button; open history calendar, inspect selected day

---

### Task 2: Rebuild Viewer Buttons (membersBtn, lbBtn, adminBtn)

**Objective:** Replace the tiny translucent pill buttons with proper, substantial flat buttons matching the `.btn` system.
**Dependencies:** None
**Mapped Scenarios:** TS-002

**Files:**

- Modify: `public/index.html` (CSS lines 163–164, 285–288, 315)

**Key Decisions / Notes:**

- `#membersBtn` (line 285): Restyle as accent/gold family button — solid background with accent tones, ≥40px tall, padding ~10px 22px, font-size ≥14px (use `var(--fs-base)` or `var(--fs-md)`), border-radius 8px (not 100px pill), font-weight 700
- `#lbBtn` (line 287): Restyle as green family button — similar to `.btn-primary` but viewer-specific
- `#adminBtn` (line 163): Restyle as neutral button — bump to ≥40px tall, ≥14px text, comfortable padding. Keep it unobtrusive but clearly a button.
- Mobile overrides at line 315: Update to keep buttons well-sized (don't shrink below 14px text or 40px height)

**Definition of Done:**

- [ ] All three viewer buttons are ≥40px tall with ≥14px font-size
- [ ] `#membersBtn` has accent/gold identity, `#lbBtn` has green identity, `#adminBtn` is neutral
- [ ] All are flat (no glow, no translucent pills)
- [ ] Mobile (≤600px) buttons remain well-sized

**Verify:**

- Visual: load viewer, inspect all three buttons at desktop and mobile widths

---

### Task 3: Reconcile Membership Popup to Flat Aesthetic

**Objective:** Remove rotations, offset shadows, `!important` hovers, and hardcoded hex backgrounds from the members modal. Replace with token-based flat cards that match the app's dashboard aesthetic while preserving all content and tier color identities.
**Dependencies:** None
**Mapped Scenarios:** TS-003

**Files:**

- Modify: `public/index.html` (CSS lines 240–284, 289–316)

**Key Decisions / Notes:**

- `.members-box` (line 240): Replace hardcoded `#080c14` with `var(--card)`, replace `#1e2535` border with `var(--border)`
- `.tier-card` (line 246): Remove `box-shadow:4px 4px 0 0 var(--tc,...)` offset shadow. Use `var(--card2)` or `var(--dark)` background instead of `#0d1117`. Keep `--tc` per-tier accent for border color.
- `.tier-grid .tier-card:nth-child(N)` (line 247): Remove all `transform:rotate(...)` declarations
- `.tier-card:hover` (line 248): Remove `!important`, remove translate/rotate transform, remove offset shadow. Use quiet hover: `border-color:var(--tc);background:var(--card2)` or subtle shift.
- `.earn-section` (line 263): Replace `#080c12` with `var(--card2)`, remove offset `box-shadow`
- `.earn-item` (line 266): Remove offset shadow, remove rotation. Replace `#0d1117` with `var(--dark)`.
- `.earn-item:hover` (line 268): Remove `!important`, remove translate, remove offset shadow
- `.earn-rate` (line 271): Remove offset shadow, remove `transform:rotate(2deg)`. Replace `#0d1117` with `var(--dark)`.
- `.earn-rate:hover` (line 272): Remove translate, remove offset shadow
- `.benefits-section` (line 274): Remove offset shadow, replace `#080c12` with `var(--card2)`
- Keep all per-tier accent colors (`--tc` custom property) — these are meaningful
- Keep content markup untouched

**Definition of Done:**

- [ ] No `transform:rotate(...)` on any tier card or earn item
- [ ] No hard offset `box-shadow` (`Npx Npx 0 0 ...`) in members section
- [ ] No `!important` in members section CSS
- [ ] All surfaces use design tokens (`--card`, `--card2`, `--dark`, `--border`, etc.)
- [ ] Per-tier accent colors preserved
- [ ] All content and structure intact

**Verify:**

- Visual: open members popup, inspect tier cards, earn section, benefits table

---

### Task 4: Court Display Density and Responsive Scaling

**Objective:** Make the viewer court display feel intentionally full rather than sparse on wide screens. Cap layout width, scale up avatars/names, and tighten vertical spacing.
**Dependencies:** None
**Mapped Scenarios:** TS-004

**Files:**

- Modify: `public/index.html` (CSS lines 28–37)

**Key Decisions / Notes:**

- `#courtsDisplay` (line 28): Add `max-width:1100px;margin:0 auto` to cap width and center on large screens. Increase `minmax(280px,1fr)` to a larger min for better card density.
- `.court-card` (line 29): Tighten `gap` if needed, ensure padding scales
- `.avatar` (line 35): Use `clamp()` for responsive sizing — e.g. `width:clamp(72px,8vw,100px);height:clamp(72px,8vw,100px)` so avatars grow on large screens
- `.player-slot .pname` (line 36): Increase clamp range — e.g. `clamp(13px,1.6vw,18px)` for larger names on TV displays
- `.vs-badge` (line 37): Already uses clamp, verify range is appropriate
- `.court-label` (line 31): Bump font-size for large screens
- Test with 1, 2, 3, 4 courts at 375px, 1280px, and 1920px widths

**Definition of Done:**

- [ ] Court display has `max-width` and centers on screens >1100px
- [ ] Avatars scale up on large screens via `clamp()`
- [ ] Player names scale up on large screens
- [ ] 1, 2, 3, 4 courts all look balanced at phone/laptop/large widths
- [ ] No excessive dead space inside court cards

**Verify:**

- Visual: load viewer with 2 courts, resize to phone/laptop/TV widths

---

### Task 5: Raise Contrast on Dim Text

**Objective:** Bump dim text colors to meet ~4.5:1 contrast ratio against `--dark` (#0d1117) background.
**Dependencies:** None
**Mapped Scenarios:** TS-005

**Files:**

- Modify: `public/index.html` (CSS lines 108, 212, 278–279, 282)

**Key Decisions / Notes:**

- `.rsummary` (line 108): Change `color:#adb5bd` to `color:#c9d1d9` (same as `--text` but slightly muted — ~5:1 ratio on `#0d1117`)
- `.cal-strip-name` (line 212): Change `color:rgba(255,255,255,.35)` to `color:rgba(255,255,255,.55)` or `color:var(--muted)` — current is ~2:1, need ~4.5:1
- `.btable td` (line 278): Change `color:#8b949e` to `color:#adb5bd` for better readability
- `.btable td:first-child` (line 279): `color:#c9d1d9` is already reasonable, keep as is
- `.da` (line 282): Change `color:#30363d` to `color:var(--muted)` or `color:#6e7681` — current is nearly invisible (~1.3:1)
- WCAG target: body text ~4.5:1. On `#0d1117`: `#8b949e` = ~4.2:1 (borderline), `#adb5bd` = ~5.6:1 (good), `#c9d1d9` = ~8:1 (excellent)

**Definition of Done:**

- [ ] `.rsummary` text is clearly scannable (not faint gray)
- [ ] `.cal-strip-name` day labels are legible
- [ ] `.btable td` body text is readable
- [ ] `.da` dashes are visible as a clear "—" (just calmer than checkmarks)
- [ ] No text falls below ~4.5:1 contrast ratio on dark backgrounds

**Verify:**

- Visual: inspect round summaries, calendar day labels, benefits table, dash marks

---

### Task 6: Consolidate Design System — Cards, Rows, Inputs, Type Scale

**Objective:** Unify duplicate CSS selectors and apply the `--fs-*` type scale tokens to hardcoded font sizes.
**Dependencies:** None
**Mapped Scenarios:** None (structural/consistency)

**Files:**

- Modify: `public/index.html` (CSS lines 63–66, 430–439, various hardcoded font-size lines)

**Key Decisions / Notes:**

**Card unification:** `.section` (line 63) and `.admin-card` (line 430) should render identically. Approach: make `.section` match `.admin-card` by aligning their `border-radius` and `padding`. `.section` uses `border-radius:12px;padding:18px 20px`, `.admin-card` uses `border-radius:var(--radius-md);padding:var(--sp-md)`. Unify both to use tokens: `border-radius:var(--radius-md);padding:var(--sp-md)`. Similarly for `.section-title` (line 64) vs `.admin-card-title` (line 431) — they're already very close, just ensure identical rules.

**Row unification:** `.row` (line 66) uses `gap:10px`, `.admin-btn-row` (line 439) uses `gap:var(--sp-sm)` (8px). Align `.row` to use `gap:var(--sp-sm)`.

**Input unification:** `.modal-input` (line 136) and `.admin-form-input` (line 435) — align padding and border-radius to use tokens consistently.

**Type scale application:** Replace hardcoded font sizes with nearest `--fs-*` token where they map cleanly. Don't make anything smaller. Key targets:
- `.rc-name` 12px → `var(--fs-xs)` (12px) ✓
- `.guest-strip-label` 11px → `var(--fs-xs)` (12px, nudge up)
- `.tier-perk` 13px → `var(--fs-sm)` (13px) ✓
- `.btable` 11.5px → `var(--fs-xs)` (12px, nudge up)
- `.lb-name` 14px → `var(--fs-base)` (14px) ✓
- `.cal-strip-name` 10px → stays small (heading context), but bump to 11px for legibility
- `.court-label` 13px → `var(--fs-sm)` (13px) ✓

**Definition of Done:**

- [ ] `.section` and `.admin-card` render with identical border-radius, padding, and border
- [ ] `.section-title` and `.admin-card-title` render identically
- [ ] `.row` and `.admin-btn-row` have consistent gap
- [ ] `.modal-input` and `.admin-form-input` look the same
- [ ] Hardcoded font sizes mapped to `--fs-*` tokens where applicable
- [ ] No visual regression in any card or form element

**Verify:**

- Visual: compare admin cards across all tabs; compare modal inputs with admin form inputs

---

### Task 7: Accessibility — Focus Rings, Aria Labels, Tap Targets, Reduced Motion

**Objective:** Add visible `:focus-visible` outlines, aria-labels on icon-only buttons, bump small tap targets, and respect `prefers-reduced-motion`.
**Dependencies:** Tasks 1–2 (button styles finalized before adding focus rings)

**Files:**

- Modify: `public/index.html` (CSS: new rules after line ~480; HTML: lines 547, 629, 762, 958; JS templates: lines 1245, 1253, 1257, 1271)

**Key Decisions / Notes:**

**Focus rings:** Add a global `:focus-visible` style using `outline:2px solid var(--green);outline-offset:2px` on interactive elements: `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-accent`, `.btn-danger`, `.btn-ghost`, `.admin-tab-btn`, `.nav-btn`, `#membersBtn`, `#lbBtn`, `#adminBtn`, `.cal-chevron`, `.cal-strip-btn`, `.rc`, `.rc-del`, `.rc-points-btn`, `.history-close`, `.members-close`, `.lb-close`, `#wheelCloseBtn`, `.gate-enter-btn`, `.draw-chip button`, `.guest-chip button`, inputs, selects, textareas. Then keep `outline:none` on regular `:focus` (only mouse) — browsers only fire `:focus-visible` on keyboard navigation.

**Aria-labels on static markup:**
- Line 547: `.history-close` → add `aria-label="Close history"`
- Line 629: `.members-close` → add `aria-label="Close members"`
- Line 762: `.lb-close` → add `aria-label="Close leaderboard"`
- Line 958: `#adminBtn` → add `aria-label="Open admin panel"`
- Line 771: `#wheelCloseBtn` already has `aria-label="Close lucky draw"` ✓

**Aria-labels on dynamic markup (JS templates):**
- Line 1245: `.rc-del` → add `aria-label="Remove ${rp.name} from roster"`
- Line 1253: `.rc-points-btn` (minus) → add `aria-label="Decrease points"`
- Line 1257: `.rc-points-btn` (plus) → add `aria-label="Increase points"`
- Line 1271: `.guest-chip button` → add `aria-label="Remove ${g.name}"`

**Tap targets:** Bump toward 44px minimum where feasible:
- `.rc-del` (18px) → 28px visual, with padding for 44px hit area
- `.rc-points-btn` (20px) → 28px with padding for larger hit area
- `.btn-sm` (28px tall) → bump padding to ~7px 14px for ~34px min-height
- `.cal-strip-btn` (34px) → bump to 40px

**Reduced motion:** Add `@media(prefers-reduced-motion:reduce)` block to disable `pulse`, `gate-float`, `word-appear`, `gate-line-draw`, `gate-dot-appear`, `gate-corner-in` animations. Confetti already respects this (line 397).

**Definition of Done:**

- [ ] Tab-navigating through the page shows visible focus ring on every interactive element
- [ ] Mouse clicks do NOT show focus ring (`:focus-visible` scoping)
- [ ] All icon-only buttons (×, +, −) have descriptive `aria-label`
- [ ] `.rc-del`, `.rc-points-btn`, `.btn-sm`, `.cal-strip-btn` have ≥34px effective tap area
- [ ] `prefers-reduced-motion` disables all decorative animations (except confetti which already does)

**Verify:**

- Tab through page, verify focus rings
- Check rendered HTML for aria-labels on close/delete buttons
- Inspect computed sizes of small buttons

---

## E2E Results

| Scenario | Priority | Result | Fix Attempts | Notes |
|----------|----------|--------|--------------|-------|
| TS-001 | Critical | PASS | 0 | .gate-enter-btn: box-shadow:none, transform:none, background-color .15s transition |
| TS-002 | Critical | PASS | 0 | All 3 viewer buttons ≥40px, 14px font, box-shadow:none |
| TS-003 | High | PASS | 0 | Members modal: transform:none on all cards, box-shadow:none, token-based backgrounds |
| TS-004 | High | PASS | 0 | Courts display: max-width:1100px, avatars 102px, names 18px, VS 34px (clamp scaled) |
| TS-005 | High | PASS | 0 | rsummary #c9d1d9, cal-strip-name rgba(.6), btable td #adb5bd, da var(--muted) |
| TS-006 | Medium | PASS | 0 | :focus-visible rules confirmed in stylesheet for all interactive elements |

## Open Questions

None — the task prompt is comprehensive and unambiguous.

### Deferred Ideas

- Full WCAG AA audit (color contrast on all elements, not just the specified ones)
- Dark/light theme toggle
- CSS extraction to separate file with build step
