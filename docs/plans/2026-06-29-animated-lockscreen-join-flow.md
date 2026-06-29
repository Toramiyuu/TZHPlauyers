# Animated Lockscreen + Calendar Join Flow Implementation Plan

Created: 2026-06-29
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

> Spec-review incorporated (3 must_fix + 4 should_fix + 3 suggestions): server-authoritative clock via GET `today`; shared month-end-clamped `addMonthsISO`; weekday-from-game guard; dates de-dupe+cap ≤12; strict skill allow-list + escHtml; enumerated reduced-motion overrides; added boundary E2E (TS-008).

## Summary

**Goal:** Redesign the TZH Badminton site gate into an animated, hero-centric "Want to join our social games?" lockscreen, and upgrade the already-shipped public sign-up flow into a 3-step panel with a real calendar (Mon/Fri/Sun dates) and a required skill-level field — porting the user-approved prototype into production.

**Architecture:** In-place evolution of the existing feature. Reshape `#siteGate` and `#joinModal` markup/CSS/JS inside the single `public/index.html`; extend the existing unauthenticated `submitSignup` endpoint + GET normalizer in `api/state.js`; extend the pure validators in `public/monthly-draw.js`; update the existing admin Sign-ups tab. No new files (except none), no new deps, no framework — vanilla JS only.

**Tech Stack:** Node/Express + Vercel serverless, Upstash Redis (single `court-state` blob, shallow-merge POST), vanilla JS + inline CSS in one HTML file. Tests are plain `node` scripts wired into `npm test`; static design guard `scripts/verify-redesign.js`.

## Scope

### In Scope

1. **Lockscreen redesign (`#siteGate`):** promote "Want to join our social games?" from the small underlined `#gateJoinLink` to the animated HERO (big word-by-word headline, float + shimmer CTA, ambient shuttle motes, one-shot court-line beam on intro). Members access-code card stays as a calm SECONDARY module below the hero (approved "keep current balance").
2. **Unlock transition:** correct site code → light-bloom + scale/blur gate exit while viewer/admin reveals beneath; wrong code shakes the input.
3. **Join flow redesign (`#joinModal`):** replace weekday-chips with a 3-step panel — (1) real calendar month grid (only enabled-weekday dates on/after today and within ~3 months selectable; month nav), (2) details (name, phone, REQUIRED skill: Beginner/Intermediate/Advanced, selected-date pills), (3) animated thank-you. Honeypot + a11y preserved.
4. **Data model:** extend stored signup with `skill` + specific `dates` (ISO), keeping derived weekday `days` for backward-compat. Server validates/sanitizes dates (real date, enabled weekday, ≥ today, capped count) + skill, still unauthenticated and append-only.
5. **Admin Sign-ups tab:** show skill + specific dates per row (fall back to day tags for legacy rows); keep unread badge + unhandled highlight + existing actions.

### Out of Scope

- Changing the members-password mechanism itself (`siteCode` admin config stays as-is — it remains the admin-set member password).
- The `socialGames` Settings editor UI (unchanged; it still drives which weekdays are open — now consumed by the calendar instead of chips).
- Any change to courts/rounds/draws/loyalty features.
- Email/SMS notifications on new sign-ups (admin badge only, as today).
- Worktree (Worktree: No).

## Approach

**Chosen:** Port the approved prototype in-place into the existing `#siteGate`/`#joinModal`/`submitSignup`/admin-tab wiring.
**Why:** Reuses the proven unauthenticated submit path, locked-GET `socialGames` surfacing, CTA-visibility logic, admin review actions, and pure-validator test harness — minimal blast radius, maximal consistency. Cost: the new CSS/JS must live inside the single 4,300-line `index.html` and pass the strict design guard (no new `!important`, backdrop-filter only on `.modal-overlay`, declared tokens only).
**Alternatives considered:**
- *New standalone gate/flow component swapped in* — rejected: duplicates wiring (submit, CTA visibility, admin tab), larger surface, no benefit for a vanilla-JS single-file app.
- *Keep weekday-chips, just restyle the gate* — rejected: the approved design requires a real calendar + skill field; chips don't satisfy the requirement.

## Context for Implementer

> Written for someone who has never seen this codebase.

- **Single-file frontend:** `public/index.html` = CSS in `<head>` `<style>`, markup, then one big inline `<script>` near the bottom. Vanilla JS, globals attached by `function` declarations. No build.
- **Approved design source of truth:** `design-prototypes/TZH Lockscreen Prototype.html` — vanilla JS + the production tokens, written to port cleanly. Lift its CSS/markup/JS, adapting to the gotchas below. The motion is approved; don't redesign it.
- **Existing gate:** markup `public/index.html:818` (`#siteGate` → `.gate-card` with logo, "Welcome", `#gateInput` XXX-XXX, Enter, "Members only", `#gateJoinLink`, "Admin access"). CSS `:339+`. JS: `showSiteGate()` `:2461`, `hideSiteGate()` `:2476`, `initHeroGate()` `:2455`, `submitSiteCode()` `:2511`, `formatCodeInput()` `:2506`, `previewLockscreen()` `:2487`. The gate is shown by `poll()` when GET returns `{locked:true}`; **the page HTML always loads, only data is gated** — so the join flow can submit while "locked".
- **Existing join modal:** markup `:771` (`#joinModal.modal-overlay`). JS: `openJoinModal()` `:3489`, `closeJoinModal()` `:3505`, `submitJoinForm()` `:3509`, `renderJoinDayChips()` `:3476`, `toggleJoinDay()` `:3484`, `getEnabledGameDays()` `:3461`, `updateJoinCtaVisibility()` `:3468`.
- **Existing admin tab:** `setAdminTab()` `:3408` calls `renderSignupsTab()` `:3555`; badge `renderSignupsBadge()` `:3545`; row actions `markSignupHandled`/`copySignupPhone`/`addSignupToRoster`/`deleteSignup` `:3598+`.
- **Pure validators:** `public/monthly-draw.js` exports `window.MonthlyDraw` (Node-`require`-able). `validateSignup({name,phone,days}, enabledDays)` `:267`, `unhandledCount` `:285`, `timeAgo(at,now)` `:297`. Tests: `scripts/test-signups.js`.
- **Server:** `api/state.js` — GET returns whole state or `{locked:true, socialGames:[openDays]}`; `submitSignup` branch `:172` is the ONLY unauthenticated POST (honeypot, sanitizes, validates `days` against enabled `socialGames`, append-only, 500-cap, returns in every branch so it can't fall through to the password-gated update). `todayISO()` `:26`. `DEFAULT_STATE.socialGames`/`signups` `:69`. GET normalizer `:143-144`.
- **Client consts:** `WEEKDAY_NAMES = ['Sunday'..'Saturday']` (index = JS `getDay()`) `:1332`; `DEFAULT_SOCIAL_GAMES` `:1325`; `lockedSocialGames` (locked-GET weekday snapshot) `:1330`; `clockNow()` `:3778` (synced server time — pass to `timeAgo`); `escHtml` `:3441`; `notify` `:3445`; `formatDisplayDate(iso)` `:2639`; history calendar render `renderCalendar()` `:2700` (a horizontal strip — reference only; the join calendar is a 7-col grid).
- **Patterns to follow:** read-modify-write admin saves do `await refreshState(); if (await apiPost({x}) === null) return; state.x = x; render();`. `apiPost` always sends the admin password; the public submit uses raw `fetch` with no password.

### ⛔ Design-guard gotchas (`scripts/verify-redesign.js`, part of `npm test`) — MUST honor

- **(i) `!important`** allowed ONLY on `#admin … padding` and `scroll-behavior`. The prototype's reduced-motion blanket `*{animation-duration:.001s!important}` is FORBIDDEN. Instead, after the lockscreen animation rules, add a `@media (prefers-reduced-motion:reduce){…}` block that overrides each animated selector's `animation:none` and sets resting `opacity/transform/filter` — no `!important` needed (later, equal-specificity rules win).
- **(h) `backdrop-filter`** only on `.modal-overlay`/`#pwModal`/`#historyModal`. Keep the join panel inside `#joinModal.modal-overlay` (already allowed). Do NOT add `backdrop-filter` to `#siteGate` or a new overlay. (Gate blur uses `filter:` not `backdrop-filter:` — `filter` is unrestricted.)
- **(e) `var(--x)`** must be declared. The prototype uses `--ease-out`/`--ease-soft` — DECLARE them in `:root` (adding tokens is fine). For monospace, reuse the gate's inline `ui-monospace,SFMono-Regular,Menlo,monospace` stack (the existing `--font-mono` token is a sans mirror, not true mono).
- **(f) emoji** allow-list `✓ ✕ → ← …` only. Use inline SVG for icons; `×`(U+00D7) and `‹ ›`(U+2039/203A, via `&#8249;`/`&#8250;`) are not in the picto range and are fine.
- **(g)** no `transform:rotate(` literal, no `text-shadow` (outside the inline script). Prototype uses none — keep it that way.
- **(b)** the inline `<script>` must parse (`new Function`). After editing, extract it and `node --check`.
- **Never add a global `body{overflow:hidden}`** (prototype had one) — it would lock admin/viewer scrolling. Scope `overflow:hidden` to `#siteGate` only (it's `position:fixed;inset:0`).

## Runtime Environment

- **Local dev:** `node server.js` (port 3000 by default) serves `public/` and a stub `/api/state`. NOTE (from project memory): `server.js` can't fully exercise history/sessions/lucky-draw, but it DOES serve the gate + `submitSignup` for local E2E.
- **Prod:** Vercel serverless `api/state.js` + Upstash Redis. Deploy = push to GitHub (`Toramiyuu/TZHPlauyers` → `tzhplayers.vercel.app`).
- **Browser E2E:** `playwright-cli` blocks `file://` — serve over HTTP (`python3 -m http.server` for the static prototype, or `node server.js` for the app) and load `http://127.0.0.1:<port>/…`.

## Feature Inventory (join-modal refactor)

| Existing (to replace/keep) | Location | Maps to |
|---|---|---|
| `renderJoinDayChips()` / `toggleJoinDay()` (weekday chips UI) | `:3476`,`:3484` | **Replaced** by calendar (Task 5); remove as orphans |
| `openJoinModal()` / `closeJoinModal()` | `:3489`,`:3505` | **Rewritten** for 3-step panel (Task 5) |
| `submitJoinForm()` (POST days) | `:3509` | **Rewritten** to POST `{name,phone,skill,dates,hp}` (Task 5) |
| `getEnabledGameDays()` / `updateJoinCtaVisibility()` | `:3461`,`:3468` | **Kept** — calendar derives selectable weekdays from these |
| `#joinModal.modal-overlay` shell + `.join-*` CSS | `:771`,`:212` | **Reshaped** in place (Task 5) |
| `validateSignup` (days-only) | monthly-draw.js`:267` | **Kept** (back-compat + tests); new `validateJoinRequest` added (Task 1) |
| `submitSignup` server branch (days) | state.js`:172` | **Extended** to dates+skill, days-legacy fallback (Task 2) |
| `renderSignupsTab()` (day tags) | `:3555` | **Extended** to show skill + dates (Task 6) |

## Assumptions

- The calendar's selectable weekdays come from enabled `socialGames` (today: Sun/Mon/Fri) via `getEnabledGameDays()` on the loaded site and `lockedSocialGames` on the locked gate — supported by state.js`:150-153` surfacing open games on locked GET — Tasks 5, 2 depend on this.
- Old signups already in Redis have `days` but no `dates`/`skill`; the admin tab must render them gracefully — supported by append-only model (no per-item migration) — Task 6 depends on this.
- Skill is REQUIRED and one of exactly `Beginner|Intermediate|Advanced` (user decision) — Tasks 1, 2, 5, 6.
- Booking horizon ≈ 3 months ahead (user decision); past and >3-months are not selectable — Tasks 1, 2, 5.
- A mid-deploy user on an old cached client might still POST `{days}` without `{dates}` — server keeps a legacy `days` path so they don't break — Task 2.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| New CSS trips the design guard (`!important`, backdrop-filter, undeclared token, emoji) | High | Build red | Apply the gotchas above exactly; run `npm test` after Tasks 3,4,5,6 and fix before moving on |
| Public `submitSignup` widened into an injection/abuse vector | Low | High | Server self-builds the signup object; never spreads `req.body`; validates+caps dates (≤60) & skill; keeps honeypot + 500-cap + returns-in-every-branch; add a test asserting it can't write `roster`/`siteCode` |
| Calendar lets a past/non-game/out-of-window date through to the server | Medium | Medium | Validate `isValidISO` + weekday ∈ enabled set AND `today ≤ date ≤ maxISO` (inclusive) BOTH client (`validateJoinRequest`) and server (mirrored inline); ISO strings compared lexically |
| Client & server compute a different "today"/"+3mo" → a client-accepted date 400s at submit (day-boundary / month-end overflow / timezone) | Medium | High | Server is the clock authority: GET returns `today`; client uses it as the lower bound. Both compute the window with the SAME `addMonthsISO(iso,3)` helper (month-end clamped). Inclusive boundary. (review must_fix #1 & #2) |
| A persisted game day missing a numeric `weekday` poisons the enabled-weekday set with `-1` | Low | Medium | Derive `w = Number.isFinite(g.weekday) ? g.weekday : WEEKDAY_NAMES.indexOf(g.day)` and drop `-1`, on BOTH client and server (review must_fix #3) |
| Each signup row carries a large `dates` payload, bloating the polled blob | Low | Medium | De-dupe then cap dates ≤12 per signup, on both layers (review should_fix) |
| Intro animation replays on every 2s poll while locked (jarring) | Medium | Low | Play intro only when gate transitions hidden→shown (reuse `showSiteGate`'s `alreadyOpen` guard / `initHeroGate`) |
| Locked gate lacks `socialGames` so calendar is empty | Low | Medium | `lockedSocialGames` is populated from the locked GET (`:1409`); fall back to `DEFAULT_SOCIAL_GAMES`; if truly none enabled, `updateJoinCtaVisibility` hides the hero CTA |
| Reduced-motion users get motion | Low | Low | `@media (prefers-reduced-motion:reduce)` override block (no `!important`) neutralizing each animated selector |

## Goal Verification

### Truths
1. On the locked gate, the hero "Want to join our social games?" renders large with the intro animation, and the members code card sits below it. (TS-001)
2. Tapping the hero opens a calendar where only enabled-weekday dates on/after today and within ~3 months are selectable; other days are inert. (TS-002)
3. The details step requires a skill level and shows the picked dates; submitting posts WITHOUT any site code or admin password and shows the thank-you. (TS-003)
4. The new sign-up appears in the admin Sign-ups tab showing name, phone, skill, and the specific dates, with an unread badge + highlight. (TS-004)
5. Entering the correct site code plays the unlock transition and reveals the main site; a wrong code shakes the input and does not unlock. (TS-005)
6. With no enabled game days, the hero/viewer join CTAs are hidden. (TS-006)
7. `npm test` is green (design guard + all node tests, incl. new `validateJoinRequest` tests); `api/state.js`, `server.js`, and the extracted inline script pass `node --check`.

### Artifacts
- `public/monthly-draw.js` — `validateJoinRequest` + date helpers (real impl, Task 1)
- `scripts/test-signups.js` — new assertions (Task 1)
- `api/state.js` — extended `submitSignup` (Task 2)
- `public/index.html` — hero/intro (Task 3), unlock (Task 4), calendar flow (Task 5), admin rows (Task 6)

## E2E Test Scenarios

### TS-001: Locked-gate hero + intro animation
**Priority:** Critical · **Preconditions:** a `siteCode` is set (locked) · **Mapped Tasks:** 3
| Step | Action | Expected Result |
|---|---|---|
| 1 | Load the app with no valid `siteCode` in localStorage (serve over HTTP) | `#siteGate` shows; hero headline "Want to join our social games?" is the dominant element, animating in word-by-word; members code card below |
| 2 | Wait ~2s | Intro settles; hero gently floats; CTA pill shows "Tap to pick your dates"; no console errors |

### TS-002: Calendar restricts to enabled weekdays + window
**Priority:** Critical · **Preconditions:** socialGames = Fri/Sun/Mon enabled · **Mapped Tasks:** 5
| Step | Action | Expected Result |
|---|---|---|
| 1 | Click the hero | Join panel opens on Step 1 (calendar), step dot 1 active |
| 2 | Inspect the current month grid | Only Mon/Fri/Sun cells on/after today are selectable (have the open dot); other days are inert/dimmed |
| 3 | Click a selectable date | It highlights (selected); Next becomes enabled; hint shows count + time |
| 4 | Page forward past ~3 months | Next-month chevron stops at the ~3-month bound |

### TS-003: Details + unauthenticated submit
**Priority:** Critical · **Preconditions:** ≥1 date selected · **Mapped Tasks:** 5, 2, 1
| Step | Action | Expected Result |
|---|---|---|
| 1 | Click Next to Step 2 | Name, Phone, Skill chips, selected-date pills shown; Submit disabled |
| 2 | Fill name + phone, leave skill unset | Submit stays disabled (skill required) |
| 3 | Pick a skill | Submit enables |
| 4 | Click Submit (no site code / no admin password) | POST `submitSignup` succeeds; Step 3 thank-you with animated check; panel auto-closes |

### TS-004: Sign-up appears in admin with skill + dates
**Priority:** Critical · **Preconditions:** TS-003 submitted; admin unlocked · **Mapped Tasks:** 6, 2
| Step | Action | Expected Result |
|---|---|---|
| 1 | Open admin → Sign-ups tab | The new row shows name, phone, skill, and the specific date(s); "New" pill + highlight; tab badge incremented |
| 2 | Click "Mark contacted" | Row un-highlights; badge decrements |

### TS-005: Unlock transition / wrong code
**Priority:** Critical · **Preconditions:** known correct `siteCode` · **Mapped Tasks:** 4
| Step | Action | Expected Result |
|---|---|---|
| 1 | Type a wrong 6-char code, Enter | Input shakes; error shown; gate stays |
| 2 | Type the correct code, Enter | Gate plays light-bloom + scale/blur exit; viewer (or admin) reveals beneath; no console errors |

### TS-006: No enabled game days hides CTA
**Priority:** High · **Preconditions:** all socialGames disabled · **Mapped Tasks:** 5
| Step | Action | Expected Result |
|---|---|---|
| 1 | Disable all game days in Settings, reload locked gate | Hero/join CTA hidden; members code card still present and usable |

### TS-008: +3-month boundary date is accepted client→server (no false 400)
**Priority:** High · **Preconditions:** locked gate, socialGames Fri/Sun/Mon enabled · **Mapped Tasks:** 1, 2, 5
| Step | Action | Expected Result |
|---|---|---|
| 1 | Page forward to the last selectable month and select the latest enabled date at the +3-month inclusive bound | Date is selectable (within window) |
| 2 | Complete the form and Submit | Server accepts (no 400); thank-you shows; the row appears in admin with that exact date — confirming client window == server window |

### TS-007: Mobile width
**Priority:** Medium · **Preconditions:** viewport 390×844 · **Mapped Tasks:** 3, 5
| Step | Action | Expected Result |
|---|---|---|
| 1 | Load locked gate at mobile width | Hero scales (clamp), code card fits, no overflow |
| 2 | Open join flow, run calendar→form | Panel fits, touch targets ≥44px, calendar usable |

## Progress Tracking

- [x] Task 1: Pure validators + date helpers (`validateJoinRequest`) + tests
- [x] Task 2: Server `submitSignup` accepts/validates dates + skill (legacy `days` fallback)
- [x] Task 3: Lockscreen hero redesign + intro animation
- [x] Task 4: Unlock transition + wrong-code shake
- [x] Task 5: Join flow — 3-step calendar panel
- [x] Task 6: Admin Sign-ups rows show skill + dates

      **Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Tasks

### Task 1: Pure validators + date helpers

**Objective:** Add date/skill validation to the shared pure lib so client and server enforce the same rules; keep existing exports/tests intact.
**Dependencies:** None
**Mapped Scenarios:** TS-002, TS-003

**Files:**
- Modify: `public/monthly-draw.js`
- Modify: `scripts/test-signups.js`

**Key Decisions / Notes:**
- Add `SKILLS = ['Beginner','Intermediate','Advanced']` and export it. Skill must be **strictly one of these three** (allow-list), not merely truthy (review should_fix).
- Add `isValidISO(s)` → true only for a real `YYYY-MM-DD` that round-trips (reject `2026-02-30`, `2026-13-01`, non-strings). Add `isoWeekday(iso)` → JS weekday 0–6 (construct `new Date(y, m-1, d)`; deterministic, not a clock read). Add `weekdayName(iso)` using the same `['Sunday'..'Saturday']` order as client `WEEKDAY_NAMES`.
- **Add `addMonthsISO(iso, n)`** (review must_fix #1) — deterministic month math with **month-end clamp**: parse y/m/d, advance n months, clamp day to the last day of the target month (so `2026-11-30 + 3mo → 2027-02-28`, never overflow to March). Shared by client (compute `maxISO`) and mirrored by the server. Add tests for month-end + Dec→Jan rollover.
- Add `validateJoinRequest(input, opts)` where `input={name,phone,skill,dates}` and `opts={enabledWeekdays:number[], todayISO:string, maxISO:string}`. Rules (first failure wins, user-facing `error`): name non-empty ≤80; phone has a digit; skill ∈ SKILLS; `dates` is a non-empty array; each date passes `isValidISO`, satisfies `todayISO ≤ date ≤ maxISO` **inclusive** (lexical compare — ISO sorts), and `isoWeekday(date) ∈ enabledWeekdays`; **de-dupe dates, then cap to ≤12** (review should_fix — payload-growth guard). Return `{ok, error, clean:{name,phone,skill,dates:uniqueSorted, days:uniqueWeekdayNames}}`.
- `enabledWeekdays` is computed by the CALLER from `socialGames` using the same guard the UI uses: `w = Number.isFinite(g.weekday) ? g.weekday : WEEKDAY_NAMES.indexOf(g.day)`, dropping `-1` (review must_fix #3). Document this so client+server build the set identically.
- Keep `validateSignup`, `unhandledCount`, `timeAgo` unchanged (back-compat).
- Pure only — no `Date.now()`, no clock reads; `todayISO`/`maxISO` injected by the caller (which derives them from the synced server clock — see Tasks 2/5).

**Definition of Done:**
- [ ] `validateJoinRequest` rejects: empty name, name>80, no-digit phone, missing/non-allow-list skill, empty dates, past date, date > maxISO, wrong-weekday date, invalid/non-ISO string (`2026-02-30`); accepts a valid request and returns `clean.days` derived + de-duped, `clean.dates` de-duped + capped ≤12.
- [ ] `addMonthsISO` is correct for month-end clamp (`2026-11-30`→`2027-02-28`) and Dec→Jan rollover; `maxISO` boundary is inclusive (a date == maxISO is accepted).
- [ ] Existing `validateSignup`/`unhandledCount`/`timeAgo` tests still pass.
- [ ] `node --check public/monthly-draw.js`; `npm test` green.

**Verify:** `node scripts/test-signups.js && npm test`

### Task 2: Server `submitSignup` accepts dates + skill

**Objective:** Extend the unauthenticated submit endpoint to store `skill` + specific `dates` (with derived `days`), validated + sanitized server-side, keeping a legacy `days`-only path.
**Dependencies:** Task 1 (mirrors its rules)
**Mapped Scenarios:** TS-003, TS-004

**Files:**
- Modify: `api/state.js`
- Modify: `scripts/test-signups.js` (or add `scripts/test-state-signup.js` wired into `npm test`) — pure-logic test of the validation mirror

**Key Decisions / Notes:**
- **Server is the clock authority (review must_fix #1 & #2).** Add a `WEEKDAY_NAMES` const + an `addMonthsISO(iso,n)` mirror to `api/state.js` (inline — state.js intentionally avoids `require('../public/monthly-draw.js')` to dodge Vercel bundling surprises; keep the two copies identical, covered by Task 1's tests for the logic). In the `submitSignup` branch compute `today = todayISO()` and `maxISO = addMonthsISO(today, 3)` from the SERVER clock.
- **Surface `today` to the client (review must_fix #2):** include `today: todayISO()` in BOTH GET responses — the full `return res.json({ ...current, serverTime, today })` and the locked `return res.json({ locked:true, socialGames:openGames, today })`. The calendar uses this server `today` as its lower bound so client and server never disagree at the day boundary.
- `enabledWeekdays = state.socialGames.filter(g=>g&&g.enabled).map(g => Number.isFinite(g.weekday) ? g.weekday : WEEKDAY_NAMES.indexOf(g.day)).filter(w => w >= 0)` (review must_fix #3 — tolerate a persisted game missing a numeric weekday; never let `-1` poison the set).
- New dates path: read `name`, `phone`, `skill`, `dates` (honeypot first). Validate skill ∈ exactly the three; validate/sanitize each date (`isValidISO`, weekday ∈ `enabledWeekdays`, `today ≤ date ≤ maxISO` inclusive), **de-dupe then cap ≤12** (review should_fix); derive `days` (unique weekday names). Reject 400 if no valid date or bad skill.
- **Legacy fallback (review suggestion):** if `dates` is absent but `days` is present (old cached client), keep the CURRENT days-only path **byte-for-byte** — validate against enabled `g.day` NAMES (not the new weekday set) and store `{…, days}` without `dates`/`skill`. New clients always send `dates`+`skill`.
- Build the signup object server-side: `{ id, name, phone, skill?, dates?, days, at, handled:false }` — NEVER spread `req.body`. Keep append-only + 500-count-cap + return-in-every-branch (cannot fall through to password-gated updates).
- GET normalizer: no per-item signup migration; confirm `signups` still defaults to `[]` and locked GET still surfaces `socialGames` open days. Tolerate old blobs.
- Testability without Redis: factor the date/skill decision to mirror Task 1 exactly and add node assertions (valid, past date, > maxISO, wrong weekday, invalid ISO, bad skill, de-dupe+cap, and a "carries `roster`/`siteCode` → ignored, one signup appended" shape check).

**Definition of Done:**
- [ ] An unauthenticated `submitSignup` with `{name,phone,skill,dates}` (valid) is accepted and stored with derived `days`; invalid/non-allow-list skill or any invalid/past/>maxISO/wrong-weekday date → 400; dates de-duped + capped ≤12.
- [ ] A `submitSignup` carrying extra fields (`roster`, `siteCode`) changes NOTHING but appends one sanitized signup.
- [ ] A game day persisted without a numeric `weekday` (only `day` name) still resolves its weekday via `WEEKDAY_NAMES.indexOf` and does not poison the enabled set.
- [ ] Both GET responses include `today`; legacy `{days}`-only submit still validates against day NAMES and works; old blob without `dates`/`skill` normalizes cleanly.
- [ ] `node --check api/state.js`; `npm test` green.

**Verify:** `node --check api/state.js && npm test`

### Task 3: Lockscreen hero redesign + intro animation

**Objective:** Replace the gate card layout with the hero-first lockscreen + intro motion from the prototype, honoring the design guard.
**Dependencies:** None
**Mapped Scenarios:** TS-001, TS-006, TS-007

**Files:**
- Modify: `public/index.html` (CSS `:339+` SITE GATE region; markup `:818`; JS `showSiteGate`/`initHeroGate` `:2455+`)

**Key Decisions / Notes:**
- Declare ALL new tokens in `:root` before use and keep a running list to re-check against guard (e) (review should_fix): at minimum `--ease-out`, `--ease-soft` (any other `var(--x)` the ported CSS introduces must be declared too — a single typo fails the whole-file scan). Add `overflow:hidden` to `#siteGate` (no global body overflow).
- Reshape `#siteGate .gate-content`: brandmark (logo + mono eyebrow) → HERO `<button>` ("Want to join our social games?" big, word-by-word reveal, float + shimmer CTA, `→` SVG arrow) → members access-code card (keep `#gateInput`, error, Enter — current balance) → "Members only" foot → "Admin access" link. The hero `onclick` opens the new join flow (Task 5's `openJoinModal`). Remove the old standalone `#gateJoinLink` (its role is now the hero).
- Add ambient `.mote` particles (spawned by JS into `#siteGate`) and one `.beam` sweep; all CSS-driven, declared tokens, no `text-shadow`, no `transform:rotate(`.
- Play intro once per show: trigger the `.lit`/entrance only when the gate transitions hidden→shown (extend `initHeroGate` / `showSiteGate`'s `alreadyOpen` guard); spawn motes there.
- Add a `@media (prefers-reduced-motion:reduce)` block AFTER the animation rules that **enumerates every new animated selector** (review should_fix) — hero word reveal, hero float, CTA shimmer, mote drift, beam sweep, plus Task 4's lock-bloom and input shake — setting each to `animation:none` + its resting `opacity/transform/filter`. NO `!important` (later, equal-specificity rules win, satisfying guard (i)).
- Keep `previewLockscreen()` working (admin preview).

**Definition of Done:**
- [ ] Locked gate renders hero-first with intro animation; members code card below; CTA hidden when no enabled days (works with `updateJoinCtaVisibility`).
- [ ] No console errors; mobile width has no overflow.
- [ ] `npm test` green (design guard passes — verify checks e/f/g/h/i).

**Verify:** `npm test` + browser E2E (TS-001, TS-007) over HTTP.

### Task 4: Unlock transition + wrong-code shake

**Objective:** Animate the gate exit on correct code and shake on wrong code.
**Dependencies:** Task 3
**Mapped Scenarios:** TS-005

**Files:**
- Modify: `public/index.html` (CSS gate region; JS `submitSiteCode` `:2511`)

**Key Decisions / Notes:**
- Add a `lock-bloom`/exit animation class on `#siteGate` (scale + `filter:blur` + fade — `filter`, not `backdrop-filter`). On success in `submitSiteCode`: add the exit class, then after the animation (~1s) call `hideSiteGate()` (which already routes to viewer or admin). Preserve current behavior (admin reveal when `adminPwd` present).
- Wrong code: add a `shake` class to `#gateInput` (remove after ~0.4s) in addition to showing the existing error.
- Respect reduced-motion (skip the bloom; just hide).

**Definition of Done:**
- [ ] Correct code → transition then site reveal (viewer/admin per existing logic); wrong code → shake + error, no unlock.
- [ ] `npm test` green.

**Verify:** `npm test` + browser E2E (TS-005) over HTTP with a known `siteCode`.

### Task 5: Join flow — 3-step calendar panel

**Objective:** Replace the weekday-chips modal with the 3-step calendar→details→thanks panel, posting dates + skill.
**Dependencies:** Task 1, Task 2
**Mapped Scenarios:** TS-002, TS-003, TS-006, TS-007

**Files:**
- Modify: `public/index.html` (markup `#joinModal` `:771`; CSS `.join-*` `:212+`; JS `openJoinModal`/`submitJoinForm` `:3489+`)

**Key Decisions / Notes:**
- Keep `#joinModal.modal-overlay` (backdrop-filter allowed). Replace inner content with: step dots; Step 1 calendar (7-col month grid, month label + `‹`/`›` nav bounded to [current month, +3 months]); Step 2 details (name, phone, REQUIRED skill chips, selected-date pills with remove, honeypot `#joinHp`); Step 3 thanks (SVG check + message).
- Calendar selectable rule: `serverToday <= date <= maxISO` (inclusive) AND `isoWeekday(date) ∈ enabledWeekdays` where `enabledWeekdays = getEnabledGameDays().map(g => Number.isFinite(g.weekday) ? g.weekday : WEEKDAY_NAMES.indexOf(g.day)).filter(w=>w>=0)` (uses `lockedSocialGames` on the locked gate).
- **Lower bound from the SERVER clock (review must_fix #2):** use the `today` field the GET now returns — `state.today` on the loaded site, the locked-GET `today` (store it like `lockedSocialGames`, e.g. `lockedToday`) on the gate. Fallback to a synced value derived from `clockNow()` only if `today` is absent (never the bare browser-local `todayISO()`). `maxISO = MonthlyDraw.addMonthsISO(serverToday, 3)` — same helper the server uses, so the windows match exactly. Month-nav is bounded to `[month(serverToday), month(maxISO)]`.
- State: a `Set` of selected ISO dates + selected skill; Next gating per step; reset on open/close.
- Submit via `validateJoinRequest` (client) then `fetch('/api/state',{POST, body:{action:'submitSignup', name, phone, skill, dates, hp}})` — no password. On success → Step 3, auto-close. On failure → inline error.
- Remove orphaned `renderJoinDayChips`/`toggleJoinDay` and the old day-chip markup. Keep `getEnabledGameDays`/`updateJoinCtaVisibility`. Wire the viewer `#viewerJoinBtn` to the same flow.
- A11y: ESC closes (extend global keydown), focus first field/Step, `aria-pressed` on skill chips, ≥44px targets, `escHtml` echoed text.

**Definition of Done:**
- [ ] From locked gate AND viewer, the flow opens; calendar restricts dates correctly (weekday + window); skill required; submit works WITHOUT auth; thank-you shows; invalid/empty rejected inline.
- [ ] No enabled days → CTA hidden (TS-006).
- [ ] `npm test` green; extracted inline script `node --check` clean.

**Verify:** `npm test` + browser E2E (TS-002, TS-003, TS-006, TS-007) over HTTP.

### Task 6: Admin Sign-ups rows show skill + dates

**Objective:** Surface skill + specific dates in the admin Sign-ups tab; keep legacy rows + badge + actions working.
**Dependencies:** Task 2
**Mapped Scenarios:** TS-004

**Files:**
- Modify: `public/index.html` (`renderSignupsTab` `:3555`; minor CSS for a skill pill / date chips reusing `.signup-day-tag`)

**Key Decisions / Notes:**
- Per row, render: name, phone, a skill pill `escHtml(s.skill)` (only when `s.skill` is set), and the specific `s.dates` as chips with `escHtml` on each formatted date (review should_fix — defence-in-depth even though dates are server-sanitized); if `s.dates` absent, fall back to `s.days` tags (legacy). Keep `timeAgo(s.at, clockNow())`, "New" pill, unhandled highlight, and the existing Copy phone / Add to roster / Mark contacted / Delete actions unchanged.
- Reuse declared tokens; no emoji; SVG icons as today.

**Definition of Done:**
- [ ] A new signup shows name, phone, skill, and dates; a legacy signup (days only) still renders via day tags; badge + highlight + all four row actions still work.
- [ ] `npm test` green.

**Verify:** `npm test` + browser E2E (TS-004) over HTTP.

## Open Questions

None — design direction, calendar semantics, password model, skill requirement, and booking window are all resolved.

## E2E Results

Executed Phase B against `server.js` on `http://127.0.0.1:3300` via playwright-cli (desktop 1280×800 + mobile 390×844). The floating hero's infinite `gate-hero-float` animation defeats playwright's click-stability check, so hero/modal multi-step actions were driven through `run-code` page-evaluate (`openJoinModal()`, `jcalShift()`, cell `.click()`); transient animation classes (`.shake` 450ms, `.unlocking` 850ms) were captured by 50ms polling inside one evaluate. The unauthenticated submit path was probed directly (Node `fetch`) to confirm it appends exactly one sanitized signup and cannot write `siteCode`/`roster`/`numCourts`/forged `id`/`handled`, with prototype pollution and bad weekday/past/skill/honeypot inputs all rejected.

| Scenario | Priority | Result | Fix Attempts | Notes |
|----------|----------|--------|--------------|-------|
| TS-001 | Critical | PASS | 0 | Hero headline word-by-word reveal, float + shimmer CTA, motes, beam sweep on intro; tapping hero opens join flow |
| TS-002 | Critical | PASS | 0 | Calendar month grid: only Mon/Fri/Sun on/after today are `.jcal-cell open`; month-nav chevrons disable at current/max month |
| TS-003 | Critical | PASS | 0 | Step 2 renders name/phone/skill/date-pill; Submit gated on REQUIRED skill; unauthenticated submit appended one sanitized signup (ISO dates + skill + derived days + server `id`, `handled:false`); Step 3 thank-you auto-closes ~2.6s |
| TS-004 | Critical | PASS | 0 | Admin "Sign-ups 1" unread badge; row shows name / Advanced pill / New badge / phone / Mon 29 Jun chip; Mark contacted flips `handled:true`, clears badge + highlight |
| TS-005 | Critical | PASS | 0 | Wrong code → `.shake` observed, gate stays locked, error shown; correct code → `.unlocking` bloom, viewer revealed beneath, gate hidden, class resets to `lit` |
| TS-006 | High | PASS | 0 | All games disabled → `#gateHero` + `#viewerJoinBtn` `display:none`; access-code card still present and unlocks; restored after |
| TS-007 | Medium | PASS | 0 | Mobile 390×844: hero fits, input 60px / Enter 46px (≥44), modal panel 358px fits, day cells 40×40px, only 29th selectable; screenshot confirms clean Apple-light layout |
| TS-008 | High | PASS | 0 | Boundary: `getJoinMaxISO()` = 2026-09-29; Sep next-chevron disabled, open days Fri/Sun/Mon; picked 2026-09-28; submit 200 (no false 400), server appended dates `["2026-09-28"]` days `["Monday"]` |

**Security (unauthenticated submit path):** confirmed it can only ever append one sanitized signup — a malicious submit could not overwrite `siteCode`/`roster`/`numCourts`, could not forge `id`/`handled`, caused no prototype pollution, and stored only sanitized keys; invalid ISO / past date / wrong weekday / bad skill all returned 400; the honeypot was silently dropped (returns `{ok:true}` but appends nothing).

**Not verified:** the real Upstash Redis blob shape and the live Vercel deploy were not exercised — local `server.js` mirrors the same `buildSignup`/`todayISO` validators and GET-`today` clock, so the validation + normalization paths are equivalent. `prefers-reduced-motion` overrides were asserted statically by the design guard (check `g`/enumerated selectors), not via a motion-reduced browser profile.
