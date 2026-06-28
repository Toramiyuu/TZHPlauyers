# Social Games Sign-up Flow Implementation Plan

Created: 2026-06-28
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Add a public "Join our social games" sign-up flow — a CTA on the lockscreen and viewer opens a modal where prospective players submit name + phone + chosen game day(s) **without any auth**; submissions land in a new admin "Sign-ups" review tab, with admin-editable recurring game days configured in Settings.

**Architecture:** The single new architectural piece is an **unauthenticated `action:'submitSignup'` POST branch** handled BEFORE the admin-password check in both `api/state.js` (prod, Upstash Redis) and `server.js` (local in-memory). It may only ever append one sanitized, length-capped signup. Two new state arrays — `socialGames` (admin-configured recurring days) and `signups` (submissions) — are added to defaults + GET normalizer. The locked GET response is enriched with the **enabled** `socialGames` (public-safe subset) so the lockscreen modal shows real days. All UI/logic is added to the single inline `<script>` in `public/index.html`; pure helpers (`validateSignup`, `unhandledCount`, `timeAgo`) go in `public/monthly-draw.js` with Node tests in a new `scripts/test-signups.js` wired into `npm test`.

**Tech Stack:** Vanilla JS (no frameworks, no build, no new deps), Express + Vercel serverless, Upstash Redis, existing Apple-light CSS design tokens.

---

## Scope

### In Scope
- New state: `socialGames[]` (id, day, weekday, time, enabled) + `signups[]` (id, name, phone, days[], at, handled) in `api/state.js` `DEFAULT_STATE` + GET normalizer, and `server.js` defaults.
- Unauthenticated `submitSignup` POST branch (append-only, sanitized, capped at 500) in both `api/state.js` and `server.js`, handled before the password check.
- Locked-GET enrichment: include enabled `socialGames` (public-safe subset) in the `{locked:true}` response (both servers).
- Pure helpers `validateSignup`, `unhandledCount`, `timeAgo` in `public/monthly-draw.js` + unit tests in `scripts/test-signups.js` wired into `npm test`.
- Lockscreen CTA (under the gate card) + viewer CTA (header nav, alongside Members/Leaderboard) → shared `#joinModal` sign-up modal (name, tel phone, multi-select day chips, honeypot, inline validation, thank-you state).
- Admin "Sign-ups" tab: review list, unread count badge, highlighted unhandled rows + "New" pill, per-row actions (Mark handled, Copy phone, Add to roster, Delete with two-tap confirm).
- Admin Settings "Social Game Days" card: weekday-`<select>` + time per row, enable/disable toggle, add/remove, save.
- CTA hides on both screens when zero enabled days exist.

### Out of Scope
- Email/SMS/push notifications to admins (in-app badge + highlight only).
- Duplicate-phone dedup, rate limiting, CAPTCHA (honeypot + length-cap only, per decision #4).
- Editing a signup's contents after submission (only mark/handle/add-to-roster/delete).
- Auto-adding signups to roster/session without admin action.
- Auto-restoring default days when the admin deletes all of them (CTA hides instead, per decision #2).

---

## Approach

**Chosen:** Extend the existing single-blob state + shallow-merge POST with one append-only public branch; add all UI to the existing inline script and pure logic to `monthly-draw.js`.
**Why:** It matches every existing contract (one Redis blob, `apiPost`/`apiFetch`, `.modal-overlay`, admin tabs, the `monthly-draw.js` pure-helper home) and adds zero dependencies — at the cost of growing the already-large `index.html` further (accepted; it's the project's established single-file pattern).
**Alternatives considered:**
- *Separate public read endpoint for game days* (rejected — decision #1 chose enriching the locked GET instead, avoiding a second endpoint).
- *Separate `signups` Redis key* (rejected — breaks the single-blob `{...state,...updates}` model the whole app relies on; the 500-cap keeps blob growth bounded).
- *Client-only default days on the lockscreen* (rejected — decision #1 wants the admin's real current days behind the gate; `DEFAULT_SOCIAL_GAMES` remains only as a last-resort fallback).

---

## Context for Implementer

> Written for an implementer who has never seen this codebase.

**Patterns to follow (verified line refs, `public/index.html` unless noted):**
- **Modal:** `.modal-overlay > .modal-box` with `<h2>`, `.modal-desc`, `.modal-input`, `.modal-actions` (`.btn .btn-secondary` + `.btn .btn-primary`). Model: `#guestModal` markup (706–717); open/close via `classList.add('open')`/`remove('open')` (`openGuestModal`/`closeGuestModal` 1868–1876).
- **Public submit reference (sanitization shape):** the spec's Task 1 snippet — append-only, trim+slice caps, honeypot early-return, validate days against enabled games.
- **Persistence (admin writes):** `await refreshState();` → build new array → `await apiPost({ field });` → set `state.field` → re-render → `notify(...)`. Models: `confirmAddRoster` (1853–1865), `confirmAddGuest` (1878–1889), `saveSiteCode` (2370–2381).
- **`apiPost`** (1249–1262) always sends the admin password; returns `null` on 401 (caller must early-return). **`apiFetch`** (1238–1247) sends `?code=` from localStorage; returns the GET body (`{locked:true,...}` or full state).
- **Admin tab bar:** `#adminTabs` (945–951) — `.admin-tab-btn[data-tab=X]` (`.tab-icon` SVG + `.tab-label`) + `.admin-tab-panel[data-tab=X]` (954+). `setAdminTab(name)` (3167–3177) toggles `.active` and calls `renderMonthlyTab()` for `monthly` — add a `signups` branch there.
- **Settings card model:** "Site Access Code" card (1163–1181) — `renderSiteCodeSection()` (2350–2361) renders into a display div from `state`; Save/Generate/Remove buttons. Mirror for the "Social Game Days" card.
- **Two-tap delete confirm:** `deleteRosterPlayer(id, btn)` (1751–1756) — first click sets `btn.textContent='?'`, `btn.dataset.confirmed='yes'`, 3s revert timer; second click performs the action. Mirror for `deleteSignup`.
- **Helpers:** `escHtml` (3199–3201, always escape echoed text on render), `notify(msg,type)` (3203–3210; `type='warn'` for errors), `copyLink()` (3212–3214, the `navigator.clipboard.writeText(...).then(...notify)` pattern).
- **Polling:** `poll()` (1271–1303) runs every 2s; on `s.locked` it returns early (1280–1283) **without** storing `state`; on success sets `state=s`, renders viewer, and (if admin open) re-renders admin sub-sections incl. `renderMonthlyTab()` (1301). **Escape handler** for `.open` modals at 3628–3638.
- **Viewer:** header nav `.vh-nav` (885–888) holds Members/Leaderboard buttons (SVG `.ic` + label) — add the viewer CTA here. Footer at 896.
- **Lockscreen:** `#siteGate > .gate-content > .gate-card` (742–757); existing `.gate-admin-link` button (755) `→ openPwModal()`. Add the join CTA in `.gate-content`.

**Conventions / gotchas:**
- **⛔ `npm test` does NOT `node --check` `server.js`** — the design guard only syntax-checks `api/state.js` (check (a) below). So `npm test` green is NOT a sufficient gate for `server.js`. After ANY task that edits `server.js` (or `api/state.js`), run `node --check api/state.js server.js` explicitly.
- **Design guard (`scripts/verify-redesign.js`, in `npm test`) is strict** — verified rules: (a) `api/state.js` passes `node --check`; (b) the **last** `<script>` (the inline app script, opens at line 1196) must parse via `new Function(...)` — do NOT add any `<script>` tag after it, and never put a literal `</script>` in a JS string; (e) **every `var(--x)` must resolve to a declared token** — only use existing tokens (see palette below) or declare new ones in CSS; (f) **no pictographic emoji** — use inline `<svg class="ic" viewBox="0 0 24 24">` icons or the allowed glyphs `✓ ✕ → ← …`; (h) `backdrop-filter` only on `.modal-overlay`/`#pwModal`/`#historyModal` — the new modal uses class `modal-overlay`, so it inherits overlay styling; add NO new `backdrop-filter`; (i) no new `!important`.
- **Time string `9–11pm` uses an EN DASH (U+2013), not a hyphen.** En dash is outside the guard's emoji ranges (safe). Keep it consistent across server defaults, client `DEFAULT_SOCIAL_GAMES`, and the time `<input>` default.
- **Available design tokens (reuse — declaring new ones also OK if declared in CSS):** accent `--a-blue` `--a-blue-2` `--a-blue-tint`; ink `--a-ink` `--a-ink-2` `--a-ink-3`; surfaces `--a-bg` `--a-card` `--a-card-2`; lines `--a-line` `--a-line-2`; semantic `--red` `--warn` `--green` `--gold`; spacing `--sp-xs/sm/md/lg/xl/2xl`; radius `--radius-sm/md/lg/xl`; fonts `--font-apple` `--font-mono`; `--shadow-sm/md/lg`; `--transition`. **Alert accent = blue:** badge/"New" pill bg `--a-blue` (white text); unhandled-row tint `--a-blue-tint` + left border `--a-blue`.
- Roster item shape when adding from a signup: `{ id:'p'+Date.now(), name, photo:null, points:0 }` (the GET normalizer backfills `points` but include it explicitly).

**Domain context:** The app gates *data* behind a daily site code but the page HTML always loads — so a button on the lockscreen can open a modal and POST even while "locked". `submitSignup` deliberately ignores the lock (it only affects GET).

## Runtime Environment

- **Local dev:** `npm start` → `node server.js`, serves `public/` on `http://localhost:3000` (`/` viewer, `/?admin` admin). In-memory state resets on restart — fine for testing the sign-up flow end-to-end (unlike history/sessions/lucky-draw, which need Vercel+Redis).
- **Prod:** Vercel serverless `api/state.js` + Upstash Redis (`court-state` key). Auto-deploys on push to GitHub `Toramiyuu/TZHPlauyers`.
- **Admin password:** `ADMIN_PASSWORD` env (default `TZH123`).
- **Tests:** `npm test` (design guard + 5 behavioral suites). After each task also run `node --check api/state.js server.js` and `node --check` on the extracted inline script.

## Assumptions

- **No mobile bottom tab bar exists.** The spec referenced "both bars", but `grep` confirms a single `#adminTabs` (945) styled responsively — there is no second tab-button set. The Sign-ups tab button is added to `#adminTabs` only. Supported by: grep of `data-tab`/`mobile-tab`. — Task 3 depends on this.
- **`formatTimeAgo` does not exist.** The spec said "engagement uses `formatTimeAgo`", but no such helper is in the file (grep). A pure `timeAgo(at, now)` is added to `monthly-draw.js` and used by the signup rows. Supported by: grep `timeAgo|formatTime|ago`. — Tasks 1, 3 depend on this.
- The locked GET, after my GET-normalizer additions, always has `current.socialGames` as an array before the lock check, so the enrichment map is safe. Supported by: `api/state.js` GET flow 125–143.
- `state.socialGames` on an authenticated admin client is the full list (incl. disabled); `getEnabledGameDays()` filters `enabled` client-side. Behind the gate, the server already sent only enabled games, so the filter is a no-op. — Tasks 2, 4.
- The `submitSignup` branch returning a single `{ok:true}` (incl. honeypot/validation paths) is sufficient feedback for the client; no field-level server error detail is surfaced to anonymous users beyond a generic 400. — Tasks 1, 2.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `submitSignup` branch placed after the password check → public submit returns 401 | Med | High | Insert the branch as the FIRST statement inside the `POST` block, before destructuring/`401`. Verify with an unauthenticated POST in Task 1 DoD + Task 5 security check. |
| Public branch accepts arbitrary `updates` (e.g. `roster`, `siteCode`) | Low | High | Branch reads ONLY `action,name,phone,days,hp`; constructs the `signup` object itself; never spreads `req.body`. Task 5 asserts POSTing `{action:'submitSignup', roster:[...], siteCode:null}` changes nothing but appends. |
| Blob grows unbounded from abuse | Med | Med | `signups` capped at 500 (newest-first, drop oldest) on every append, both servers. |
| Lockscreen modal shows no/stale days behind the gate | Med | Med | Enrich locked GET with enabled games; `poll()` captures `lockedSocialGames`; `getEnabledGameDays()` falls back to `DEFAULT_SOCIAL_GAMES` only if both absent. |
| Design guard fails on a new `var(--token)` or stray emoji | Med | Med | Reuse declared tokens (palette above); all icons are inline SVG or `✓ ✕ →`. Run `npm test` after each task. |
| Badge/render work on the 2s poll adds cost | Low | Low | `unhandledCount` is an O(n) array filter over a ≤500 cap; badge text update only. Re-render the full signups list only when the tab is active or after an action. |
| Disabled day still accepted server-side | Low | Med | Server validates `days` against enabled `socialGames`; Task 4 DoD + Task 5 verify a disabled day is rejected. |
| Read-modify-write race on the single blob — an unauthenticated signup (`kv.get`→mutate→`kv.set`) arriving during an admin save reads the pre-save blob and clobbers the admin's change (or vice-versa); an attacker could fire rapid signups during a known admin-edit window | Low | Med | **Accepted, not gold-plated** (the app already tolerates admin-vs-admin last-write-wins; Upstash has no transaction here). Keep the write window minimal — NO awaits between `kv.get` and `kv.set` beyond the `set` itself; re-read immediately before the `set`. Do NOT add a lock/CAS — call it out, don't over-engineer (low-concurrency club app). |
| A syntax error in `server.js` ships past `npm test` — the design guard's `node --check` covers `api/state.js` ONLY, not `server.js` | Low | Med | `npm test` is NOT a sufficient gate for `server.js`. Standing rule: run `node --check api/state.js server.js` after ANY task that touches either file (Tasks 1 + 5 do; see Context → Conventions). |

## Goal Verification

### Truths
1. A prospective player on the locked lockscreen can open the modal and submit name + phone + day(s) with **no site code and no admin password**, and sees a thank-you state. (TS-001)
2. The same modal opens from the viewer header nav and works identically. (TS-002)
3. A submitted sign-up appears in the admin **Sign-ups** tab within one 2s poll, with an unread badge and a highlighted "New" row. (TS-003)
4. Per-row actions persist: Mark handled clears the badge/highlight; Copy phone copies; Add to roster adds the player and marks handled; Delete (two-tap) removes the row. (TS-003, TS-004)
5. Editing a day's time / disabling a day in Settings is reflected in the public modal's chips and enforced server-side (disabled day rejected). (TS-005)
6. Removing all enabled days hides the CTA on both lockscreen and viewer. (TS-005)
7. `submitSignup` cannot write any field other than appending one sanitized signup, and the array is length-capped. (Task 5 security check)
8. `npm test` is green; `api/state.js`, `server.js`, and the extracted inline script pass `node --check`.

### Artifacts
- `api/state.js` (DEFAULT_STATE, GET normalizer, locked enrichment, POST `submitSignup` branch)
- `server.js` (parallel defaults, enrichment, submit branch)
- `public/monthly-draw.js` (`validateSignup`, `unhandledCount`, `timeAgo`)
- `scripts/test-signups.js` + `package.json` test script
- `public/index.html` (join modal, CTAs, Sign-ups tab + render/actions, Social Game Days card, poll/Escape wiring)

## E2E Test Scenarios

### TS-001: Submit from the locked lockscreen (no auth)
**Priority:** Critical
**Preconditions:** A site code is set; browser has no valid `siteCode` in localStorage (locked view shows).
**Mapped Tasks:** Task 1, Task 2
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Load `/` with a site code set (lockscreen visible) | Gate card shows; a "Want to join our social games?" CTA is visible under it |
| 2 | Click the CTA | `#joinModal` opens; title + session line; one day chip per enabled day showing day + time; Name + Phone fields |
| 3 | Submit empty | Inline validation error; no network success |
| 4 | Fill Name, Phone (with digits), toggle ≥1 day, Submit | Modal shows "Thanks! We'll be in touch." then auto-closes; no code/password was entered |

### TS-002: Submit from the viewer header CTA
**Priority:** Critical
**Preconditions:** No site code (open site), viewer visible.
**Mapped Tasks:** Task 2
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Load `/` (viewer) | A "Join social games" button sits in the header nav next to Members/Leaderboard |
| 2 | Click it | Same `#joinModal` opens with enabled day chips |
| 3 | Fill + submit valid data | Thank-you state, auto-close |

### TS-003: Sign-up appears in admin tab with badge + highlight; mark handled
**Priority:** Critical
**Preconditions:** Admin panel open (`/?admin`, authed); ≥1 sign-up submitted via TS-001/002.
**Mapped Tasks:** Task 1, Task 3
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Wait ≤2s after a submit | Sign-ups tab shows an unread count badge (blue); within one poll |
| 2 | Open the Sign-ups tab | Newest-first row shows name, phone, day chips, relative time, a "New" pill, and a highlighted (blue-tint, left-border) row |
| 3 | Click "Copy phone" | `notify('Phone copied')`; clipboard holds the phone |
| 4 | Click "Mark as contacted" | Row un-highlights, "New" pill gone, badge count decrements/clears |

### TS-004: Add to roster + delete
**Priority:** High
**Preconditions:** ≥1 sign-up in the list; admin open.
**Mapped Tasks:** Task 3
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click "Add to roster" on a row | Player appears in the roster (Session tab); the signup is marked handled; `notify` confirms; duplicate name is guarded |
| 2 | Click "Delete" once | Button shows a confirm state (e.g. "?") |
| 3 | Click "Delete" again within 3s | Row is removed and persists after a poll |

### TS-005: Settings day editing flows to the public modal + enforcement
**Priority:** High
**Preconditions:** Admin open; Settings tab.
**Mapped Tasks:** Task 4, Task 1
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | In "Social Game Days", change a day's time and Save | Reopen `#joinModal` → that chip shows the new time |
| 2 | Disable a day and Save | That day's chip disappears from the modal; a `submitSignup` POST with that day is rejected (400) server-side |
| 3 | Remove/disable ALL days and Save | The CTA disappears on both lockscreen and viewer; modal cannot be opened |
| 4 | Add a day (weekday select + time) and Save | New chip appears in the modal |

---

## E2E Results

Executed via Claude Code Chrome against the local dev server (`server.js`, port 3997). Site locked with an access code; a fresh-device player simulated by clearing the `siteCode` from localStorage.

| Scenario | Priority | Result | Fix Attempts | Notes |
|----------|----------|--------|--------------|-------|
| TS-001 | Critical | PASS | 1 | Fixed: locked-lockscreen sign-up modal opened *behind* the gate. `#siteGate` is `z-index:500` but `.modal-overlay` (incl. `#joinModal`) was `z-index:300`, so the modal was invisible/non-interactive on a locked device. Added ID-specific override `#joinModal{z-index:560}` (above the gate's 500, below the admin preview-exit button's 600). After the fix: CTA opens the modal above the dimmed gate; empty submit → "Please enter your name."; name+phone+Friday → "✓ Thanks!" confirmation with no access code / admin password; server-side record persisted sanitized (`id` prefixed `su`, `handled:false`, timestamp, no credential fields). |
| TS-002 | Critical | PASS | 0 | Viewer-header "Join social games" CTA opens the modal; submit records a sanitized sign-up. |
| TS-003 | Critical | PASS | 0 | Admin "Sign-ups" tab shows unread badge, New pill, highlight; Copy and Mark-contacted row actions work; badge clears. |
| TS-004 | High | PASS | 0 | "Add to roster" promotes a sign-up to the player roster; delete uses two-tap confirm. |
| TS-005 | High | PASS | 1 | Settings day edits flow to the public modal (time edit, disable-day removes chip + 400s submissions, disable-all hides both CTAs + 400s any submit, add-day appends an editable row). Fix attempt 1 (prior task): one-time `adminInitDone` render so the Settings card repopulates after a reload. |

**z-index fix (TS-001):** `public/index.html` — added `#joinModal{z-index:560}` after `.modal-overlay.open{display:flex}`. Design guard (`npm test`) re-run green: no new `!important`, no new `backdrop-filter` selector.

---

## Progress Tracking

- [x] Task 1: State + public submitSignup path + pure helpers + tests
- [x] Task 2: Lockscreen + viewer CTA → public sign-up modal
- [x] Task 3: Admin "Sign-ups" tab (review list + badge + row actions)
- [x] Task 4: Admin Settings "Social Game Days" editor
- [x] Task 5: Verify

**Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0

---

## Implementation Tasks

### Task 1: State + public (unauthenticated) submitSignup path + pure helpers

**Objective:** Add `socialGames`/`signups` to both servers' defaults + the GET normalizer, enrich the locked GET with enabled games, add an append-only unauthenticated `submitSignup` POST branch (before the password check) to both servers, and add Node-testable pure helpers with tests wired into `npm test`.
**Dependencies:** None
**Mapped Scenarios:** TS-001 (server side), TS-005 (enforcement)

**Files:**
- Modify: `api/state.js`
- Modify: `server.js`
- Modify: `public/monthly-draw.js`
- Create: `scripts/test-signups.js`
- Modify: `package.json` (add `&& node scripts/test-signups.js` to the `test` script)

**Key Decisions / Notes:**
- **`api/state.js` `DEFAULT_STATE` (after line 69 block):** add
  `socialGames: [{id:'sg-fri',day:'Friday',weekday:5,time:'9–11pm',enabled:true},{id:'sg-sun',day:'Sunday',weekday:0,time:'9–11pm',enabled:true},{id:'sg-mon',day:'Monday',weekday:1,time:'9–11pm',enabled:true}]` and `signups: []`.
- **GET normalizer (after line 136, before the `siteCode` lock at 137):** `if (!Array.isArray(current.socialGames)) current.socialGames = DEFAULT_STATE.socialGames.map(g => ({ ...g }));` and `if (!Array.isArray(current.signups)) current.signups = [];`.
- **Locked GET enrichment (137–142):** replace `return res.status(200).json({ locked: true });` with a response that also includes the public-safe enabled games: map `current.socialGames.filter(g => g && g.enabled)` → `{ id, day, weekday, time, enabled:true }` and return `{ locked:true, socialGames: <that> }`. Include NO other state.
- **POST `submitSignup` branch — FIRST statements inside the `POST` block (before `const { password, ...updates }` at 151):** the branch's **literal first line is `const b = req.body || {};`** (must_fix — do NOT depend on `req.body` being defined; an empty/malformed body must yield a clean 400 / fall-through, never a 500 throw), then `if (b.action === 'submitSignup') { … }`. Inside: read only `name,phone,days,hp`; `name=String(b.name||'').trim().slice(0,80)`, `phone=String(b.phone||'').trim().slice(0,40)`, `days=Array.isArray(b.days)?b.days.map(d=>String(d).slice(0,20)).slice(0,7):[]`; **honeypot check BEFORE the 400 validation** (so bots get a fake `{ok:true}` and can't probe field requirements), trimmed to avoid false positives from whitespace autofill: `if (String(b.hp||'').trim()) return res.json({ok:true});`; reject `if (!name||!phone||!days.length||!/\d/.test(phone)) return res.status(400)…`; **read state with an explicit shallow copy on empty Redis — mirror the existing admin path at 159–161, never persist/alias the `DEFAULT_STATE` singleton:** `let state; try { state = (await kv.get(STATE_KEY)) || { ...DEFAULT_STATE }; } catch (e) { return res.status(500)… }`; `allowed = new Set((Array.isArray(state.socialGames)?state.socialGames:DEFAULT_STATE.socialGames).filter(g=>g&&g.enabled).map(g=>g.day))`; `validDays = days.filter(d=>allowed.has(d))`; `if(!validDays.length) return res.status(400)…`; build `signup={id:'su'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),name,phone,days:validDays,at:Date.now(),handled:false}`; `state.signups=[signup,...(Array.isArray(state.signups)?state.signups:[])].slice(0,500)` — **the `.slice(0,500)` is the LAST op on every append (newest-first), so the 500-cap can never be bypassed by ordering**; `kv.set` (try-catch→500); `return res.json({ok:true})`. **Never spread `req.body`/`updates`** — the branch reads only the named fields and self-constructs `signup`. **Day-name match (should_fix):** the server slices each submitted day to 20 chars before matching against the un-sliced `allowed` set; because the admin day editor (Task 4) sets `day` only from the fixed weekday-name map (all ≤9 chars), `g.day` never reaches the 20-char cap and the sliced submit value always matches exactly. Do not allow free-typed day names anywhere.
- **`server.js`:** add the same two arrays to `DEFAULT_STATE` (11–36); enrich the locked GET (42–47) with enabled games; add the same `submitSignup` branch as the FIRST statements in the POST handler. **Its literal first line is `const b = req.body || {};`** — server.js line 53 currently does `const { password, ...updates } = req.body;` with NO null guard (must_fix: an empty-body POST throws before any logic), so the branch must read `b` defensively and be guarded by `if (b.action === 'submitSignup')`, using the in-memory `state` object (no `kv`), with the same sanitize / trimmed-honeypot / validate / append / 500-cap as above.
- **`public/monthly-draw.js`** (add to the factory + the returned object at ~256):
  - `validateSignup({name,phone,days}, enabledDays)` → `{ok,error}`: trims; name required (≤80); phone required + must contain a digit (`/\d/`); `days` must be a non-empty array all contained in `enabledDays` (array of day-name strings). Return first failure as `{ok:false,error:'...'}`, else `{ok:true,error:''}`. Mirrors server validation.
  - `unhandledCount(signups)` → count of `!s.handled` (tolerate non-array → 0).
  - `timeAgo(at, now)` → pure relative string: `<45s`→`'just now'`, `<60m`→`'Nm ago'`, `<24h`→`'Nh ago'`, else `'Nd ago'`; `now` injectable for tests (no `Date.now()` inside).
- **`scripts/test-signups.js`:** follow `scripts/test-monthly-draw.js` pattern (`check(name,cond)`, count, `process.exit(fail?1:0)`). Cover `validateSignup`: missing name, missing phone, phone-without-digit, empty days, day not in enabled set, valid case, and a **weekday-name day round-trips through `validateSignup` AND a `days.map(d=>d.slice(0,20))` filter against the same enabled set with no truncation loss** (guards the day-name cap mismatch); `unhandledCount`: mixed/empty/non-array; `timeAgo`: just-now / minutes / hours / days boundaries with injected `now`.

**Definition of Done:**
- [ ] `node --check api/state.js && node --check server.js` pass.
- [ ] New unit tests pass; `npm test` green (design guard + all suites + new suite).
- [ ] A simulated unauthenticated POST `{action:'submitSignup',name,phone,days:[<enabled day>]}` (no password) returns `{ok:true}` and appends one sanitized signup (verified via a Node harness hitting `server.js` or a direct module test).
- [ ] An old blob lacking `socialGames`/`signups` normalizes without throwing (GET returns arrays).
- [ ] A `submitSignup` POST that also carries `roster`/`siteCode` does NOT change those fields.
- [ ] An **empty / malformed-body** POST does NOT throw — it returns a clean 400 (or falls through to the 401), never a 500 (verifies the `req.body || {}` guard in both files).
- [ ] A **honeypot-filled** POST (`hp` non-empty) returns `{ok:true}` and appends **nothing** to `signups`.

**Verify:**
- `npm test`
- `node --check api/state.js server.js scripts/test-signups.js public/monthly-draw.js`
- `node scripts/test-signups.js`

---

### Task 2: Lockscreen + viewer CTA → public sign-up modal

**Objective:** Add the shared `#joinModal`, a lockscreen CTA (under the gate card) and a viewer header-nav CTA, the client logic to render enabled-day chips, validate inline, POST `submitSignup` without a password, show a thank-you state, and hide the CTA when no enabled days exist.
**Dependencies:** Task 1
**Mapped Scenarios:** TS-001, TS-002, TS-005 (CTA hide)

**Files:**
- Modify: `public/index.html` (markup + CSS in `<style>` + JS in the inline `<script>`)

**Key Decisions / Notes:**
- **Client constants/state (top of inline script, near `let state`):** `const DEFAULT_SOCIAL_GAMES = [...]` mirroring server defaults (en-dash time); `let lockedSocialGames = null;`.
- **`getEnabledGameDays()`:** return `(state?.socialGames ?? lockedSocialGames ?? DEFAULT_SOCIAL_GAMES).filter(g => g && g.enabled)`.
- **`poll()` (1271–1303):** the `if (s.locked)` block has **TWO** early returns (the non-admin path after `showSiteGate()` ~1281, and the admin path ~1283). Insert `if (Array.isArray(s.socialGames)) lockedSocialGames = s.socialGames; updateJoinCtaVisibility();` as the **first two statements inside `if (s.locked) {`** — i.e. ABOVE the nested `if (!sessionStorage.getItem('adminPwd'))` at ~1277 — so it runs before BOTH returns (otherwise the headline TS-001 locked-CTA update is skipped on one path). In the success path, call `updateJoinCtaVisibility();` after `state=s`. Also call it at the end of `showSiteGate()` (2280–2292).
- **`updateJoinCtaVisibility()`:** toggle `#gateJoinLink` and `#viewerJoinBtn` `style.display` based on `getEnabledGameDays().length > 0`.
- **Modal markup `#joinModal.modal-overlay`** (place near `#guestModal`): `.modal-box` with `<h2>Join our social games</h2>`, a `.modal-desc` session line, a `#joinDayChips` container (filled by `renderJoinDayChips()`), Name `<input class="modal-input" type="text">`, Phone `<input type="tel" inputmode="numeric">`, a visually-hidden honeypot `<input name="hp" tabindex="-1" autocomplete="off">` (hide via inline style/`position:absolute;left:-9999px`, NOT `display:none` token issues), `.modal-actions` (Cancel + Submit), and a hidden `#joinThanks` thank-you block + `#joinError` inline error.
- **Lockscreen CTA:** add `<button id="gateJoinLink" class="gate-join-link" onclick="openJoinModal()">Want to join our social games?</button>` in `.gate-content` near `.gate-admin-link` (755). New `.gate-join-link` CSS using declared tokens (secondary style; don't clash with `.gate-enter-btn`).
- **Viewer CTA:** add a `<button id="viewerJoinBtn" onclick="openJoinModal()">` into `.vh-nav` (885–888), matching the existing nav buttons (inline `<svg class="ic">` + label "Join social games").
- **`openJoinModal()`:** if `getEnabledGameDays().length === 0` return (do nothing); reset fields + hide thanks/error; `renderJoinDayChips()`; `classList.add('open')`; focus the Name field. **`closeJoinModal()`:** `classList.remove('open')`.
- **`renderJoinDayChips()`:** one toggle chip per enabled game: `<button type="button" class="join-day-chip" role="button" aria-pressed="false" data-day="<day>" onclick="toggleJoinDay(this)">`<day> · <time></button>` (escHtml). New `.join-day-chip`/`.join-day-chip.selected` CSS (≥44px touch target; selected uses `--a-blue`/`--a-blue-tint`).
- **`toggleJoinDay(btn)`:** flip a `selected` class + `aria-pressed`.
- **`submitJoinForm()`:** gather name, phone, selected days (`[...document.querySelectorAll('#joinDayChips .join-day-chip.selected')].map(c=>c.dataset.day)`), honeypot value; run `MonthlyDraw.validateSignup({name,phone,days}, getEnabledGameDays().map(g=>g.day))` → on invalid show `#joinError`; else `fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'submitSignup',name,phone,days,hp})})` (NO password). On `ok` → show `#joinThanks`, hide form, `setTimeout(closeJoinModal, ~1800)`. On failure → show `#joinError`, allow retry.
- **Escape wiring:** in the handler at 3628–3638 add `if (isOpen('joinModal')) closeJoinModal();`.
- **Accessibility:** labelled inputs, `aria-pressed` on chips, focus first field on open, ≥44px targets, escape closes, escHtml echoed text.

**Definition of Done:**
- [ ] From the locked lockscreen (site code set) the CTA opens the modal; submitting name+phone+day(s) succeeds with no code/password and shows the thank-you state.
- [ ] The viewer header CTA opens the same modal and works.
- [ ] Invalid/empty submits show an inline error and do not close; honeypot-filled submits are silently accepted (server returns ok, nothing stored).
- [ ] With zero enabled days, both CTAs are hidden and the modal won't open.
- [ ] `npm test` green; extracted inline script passes `node --check`.

**Verify:**
- `npm test`
- Extract inline `<script>` → `node --check` (see Task 5 procedure)
- Browser E2E (TS-001, TS-002): Chrome tools or playwright-cli against `npm start`

---

### Task 3: Admin "Sign-ups" tab (review list + badge + row actions)

**Objective:** Add a `signups` admin tab (button + panel) with an unread count badge, a newest-first list highlighting unhandled rows, and per-row actions: Mark handled, Copy phone, Add to roster, Delete (two-tap confirm).
**Dependencies:** Task 1
**Mapped Scenarios:** TS-003, TS-004

**Files:**
- Modify: `public/index.html` (markup + CSS + JS)

**Key Decisions / Notes:**
- **Tab button** in `#adminTabs` (after the `monthly` button, 949): `<button class="admin-tab-btn" data-tab="signups" onclick="setAdminTab('signups')"><span class="tab-icon"><svg class="ic" viewBox="0 0 24 24">…</svg></span><span class="tab-label">Sign-ups</span><span class="signup-badge" id="signupBadge" style="display:none"></span></button>` (single `#adminTabs` — no mobile bar; see Assumptions). New `.signup-badge` CSS (small pill, `--a-blue` bg, **bold white text ≥13px** so white-on-`#0071e3` (~4.5:1) reads cleanly — same for the row "New" pill). Because `--a-blue` is also the chip-selected color, ensure the unhandled-row treatment (blue-tint + left border, in the admin tab) is not visually confused with a selected chip (in the public modal) — they live in different views, but confirm during Task 5 E2E.
- **Panel** `.admin-tab-panel[data-tab="signups"]` (after the monthly panel, 1148): an `.admin-card` titled "Sign-ups" containing `<div id="signupsList"></div>`.
- **`setAdminTab` (3176):** add `if (name === 'signups') renderSignupsTab();`.
- **`renderSignupsBadge()`:** `const n = MonthlyDraw.unhandledCount(state.signups||[]); badge.textContent=n; badge.style.display = n>0?'inline-flex':'none';`. Call from `poll()` when `adminOpen` (after `renderMonthlyTab()` at 1301) — cheap, keeps badge live.
- **⛔ Polling safety (should_fix):** `poll()` calls **only `renderSignupsBadge()`** per 2s tick — do NOT call `renderSignupsTab()` from `poll()`. Re-rendering up to 500 rows (each running `timeAgo`) every 2s is a hot-path regression. The full list re-renders only on tab-activation (`setAdminTab('signups')`) and after a row action. Consequence: relative times (`3m ago`) on already-rendered rows go stale until the tab is reopened — that is **acceptable** and matches the rest of the admin; do not "fix" it with a per-poll re-render.
- **`renderSignupsTab()`:** sort `(state.signups||[]).slice().sort((a,b)=>b.at-a.at)`; empty → "No sign-ups yet."; each row: name, phone, day chips (read-only), `MonthlyDraw.timeAgo(s.at, clockNow())`; unhandled rows get a `.signup-row.unhandled` class (blue-tint + left border) and a "New" pill; action buttons (≥44px, SVG/text, no emoji). Always escHtml echoed text. Also call `renderSignupsBadge()`.
- **`markSignupHandled(id)`:** `await refreshState();` map signups toggling `handled:true` for `id`; `await apiPost({ signups });` set `state.signups`; `renderSignupsTab()` (badge updates within).
- **`copySignupPhone(phone)`:** `navigator.clipboard.writeText(phone).then(()=>notify('Phone copied'))` (mirror `copyLink`).
- **`addSignupToRoster(id)`:** `await refreshState();` find signup; guard duplicate name (case-insensitive) in `state.roster` → if dup, `notify(...,'warn')` but still mark handled; else append `{id:'p'+Date.now()+Math.random().toString(36).slice(2,6),name,photo:null,points:0}` to roster, `apiPost({roster})`; then mark the signup handled (`apiPost({signups})`); update local state; re-render; `notify('Added to roster')`. **Id (suggestion):** `'p'` prefix matches the existing `DEFAULT_ROSTER` (`p0…p18`); the random suffix avoids same-millisecond collisions on a rapid double-add (the existing `'r'+Date.now()` guest path lacks this — we don't propagate that latent bug).
- **`deleteSignup(id, btn)`:** two-tap confirm exactly like `deleteRosterPlayer` (1751–1756); on confirm `await refreshState();` filter out `id`; `apiPost({signups})`; set state; `renderSignupsTab()`. **⛔ The delete button must be a TEXT `×` glyph** (U+00D7 — an allowed glyph, not an emoji), NOT an inline SVG: the two-tap confirm swaps `btn.textContent='?'` and reverts to `'×'`, which would permanently wipe an SVG child and leave the button iconless. Match `deleteRosterPlayer`'s text-`×` button exactly.
- All writes here are admin-only (authed panel) → normal password-bearing `apiPost`.

**Definition of Done:**
- [ ] A sign-up submitted via Task 2 appears here within one 2s poll.
- [ ] Badge counts unhandled and clears as rows are handled.
- [ ] Unhandled rows are visually highlighted with a "New" pill.
- [ ] Copy phone, Add to roster, Mark handled, Delete (two-tap) all work and persist across a poll.
- [ ] `npm test` green; inline script passes `node --check`.

**Verify:**
- `npm test`
- Browser E2E (TS-003, TS-004) against `npm start`

---

### Task 4: Admin Settings "Social Game Days" editor

**Objective:** Add a "Social Game Days" card to the Settings tab to render/edit `socialGames` — per row: enable/disable toggle, weekday `<select>` (Mon–Sun), time text field, Remove; plus "Add day" and Save. Changes flow to the public modal immediately.
**Dependencies:** Task 1 (state + validation)
**Mapped Scenarios:** TS-005

**Files:**
- Modify: `public/index.html` (markup + CSS + JS)

**Key Decisions / Notes:**
- **Card** in the Settings panel (after the Site Access Code card, 1181), modeled on it: title + `<div id="socialGamesList"></div>` + an "Add day" button + a Save button + helper text.
- **Day model = weekday picker (decision #3):** each row has a `<select>` of Mon–Sun (value = weekday number 0–6, label = day name) and a time `<input type="text">` default `9–11pm`, plus an enable checkbox/toggle and a Remove button. `day` (string name) and `weekday` (number) are kept in sync from the select on save.
- **`renderSocialGamesCard()`:** render rows from `state.socialGames` (each with a stable `id`); a blank "Add day" appends a new row (`id:'sg'+Date.now()`, default Friday/weekday 5/`9–11pm`/enabled). Re-render reads current values back from the DOM first so unsaved edits survive an add/remove (or keep an in-memory working copy — implementer's choice, document it).
- **`saveSocialGames()`:** `await refreshState();` read rows from the DOM → build `socialGames` array `{id,day,weekday,time,enabled}`; **ignore blank day/time rows**; `await apiPost({ socialGames });` set `state.socialGames`; `renderSocialGamesCard()`; if `getEnabledGameDays().length===0` the public CTA hides (call `updateJoinCtaVisibility()`); `notify('Game days saved')`.
- **Empty handling (decision #2):** do NOT auto-restore defaults when the admin removes everything; the public CTA simply hides. Document this in the card's helper text ("With no enabled days, the public sign-up button is hidden.").
- New CSS for `.social-games-row` / select / time input reusing declared tokens (`admin-form-input` etc.).
- Weekday number↔name map (a const array `['Sunday','Monday',...,'Saturday']`) for select labels and keeping `day`/`weekday` consistent.

**Definition of Done:**
- [ ] Editing a day's time updates what the public modal shows (reopen modal → new time).
- [ ] Disabling a day removes its chip from the modal AND a `submitSignup` for that day is rejected server-side (Task 1 enforcement).
- [ ] Adding/removing days persists across a poll/reload.
- [ ] Removing all enabled days hides the public CTA (no auto-restore).
- [ ] `npm test` green; inline script passes `node --check`.

**Verify:**
- `npm test`
- Browser E2E (TS-005) against `npm start`

---

### Task 5: Verify

**Objective:** Full verification — automated checks, browser E2E for all scenarios, and explicit security sanity on the public endpoint.
**Dependencies:** Tasks 1–4
**Mapped Scenarios:** TS-001…TS-005

**Files:** None (verification only; fix any defects in the relevant task's files)

**Key Decisions / Notes:**
- Run `npm test` (incl. strict `verify-redesign`).
- Extract the inline `<script>` to a temp file and `node --check` it; `node --check api/state.js server.js`.
- Browser E2E (desktop + mobile width) per TS-001…TS-005 using Claude Code Chrome (or playwright-cli) against `npm start`: lockscreen submit without code/password → thank-you; viewer CTA; admin tab badge + highlight + Mark/Copy/Add-to-roster/Delete; Settings day edit/disable reflected in modal + enforced; DevTools console clean on `/` and `/?admin`. **Visually confirm** the blue badge / "New" pill text is legible (bold, adequate size) and the unhandled-row highlight is distinguishable from any selected/active state.
- **Security sanity (must pass):** an unauthenticated POST `{action:'submitSignup', name:'x', phone:'012', days:['Friday'], roster:[...], siteCode:null}` MUST append exactly one signup and leave `roster`/`siteCode` unchanged; confirm the `signups` array is length-capped at 500 (append 501 in a loop via a Node harness on `server.js`, assert length 500, newest-first).

**Definition of Done:**
- [ ] `npm test` green (0 failures).
- [ ] Inline script + `api/state.js` + `server.js` pass `node --check`.
- [ ] No emoji / undefined `var()` (design guard green).
- [ ] All TS-001…TS-005 pass in a real browser with console clean.
- [ ] Security check confirms `submitSignup` writes only an appended signup and the cap holds.

**Verify:**
- `npm test`
- `node --check api/state.js server.js`
- Browser automation run covering TS-001…TS-005
- Node harness for the cap + field-isolation security check

---

## Open Questions

None — the four product decisions (locked-GET enrichment, hide-CTA-when-empty, weekday-picker model, light validation) and the two visual decisions (viewer CTA in header nav, blue alert accent) are resolved.
