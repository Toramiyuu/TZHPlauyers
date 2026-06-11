# Pro Redesign + Bug Fixes (Viewer + Admin) Implementation Plan

Created: 2026-06-11
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Apply the flat "flagship dark" redesign across the viewer and admin UI, fix all 9 documented bugs (B1–B9), and finish a complete color-token sweep so every color is driven by `:root` tokens — per `CLAUDE_PROMPT_pro_redesign.md`.
**Architecture:** Single-file vanilla app (`public/index.html`: CSS in `<style>`, markup, one inline `<script>`) + Vercel serverless backend (`api/state.js`, Upstash Redis) + a local-dev Express server (`server.js`). No build step, no framework, no new runtime dependencies.
**Tech Stack:** Vanilla HTML/CSS/JS, Node.js, Express (local), `@upstash/redis` (prod). Node built-in scripts serve as the test/verification harness (no test framework in repo).

## Scope

### In Scope
- **Phase 1:** Confirm all 9 bug fixes (B1–B9 from `BUG_REPORT.md`) match the prompt; fix any divergence.
- **Phase 2:** Rewrite the `:root` token block + `body` + `.ic` exactly per prompt; add tier/medal palette tokens; rewrite button polish.
- **Phase 3 (viewer):** Hybrid wholesale-rewrite of the fully-specified sections — court display + header, site gate, members-modal tier cards, history modal, leaderboard medals — from the prompt text, reusing the existing 27 `.ic` SVG paths.
- **Phase 4 (admin):** Hybrid rewrite of toast (`notify`/`#notif`), `.rc` roster card, title-icon color, `.admin-hdr-brand`.
- **Full color sweep — boundary = "All UI colors; keep decorative palettes":**
  - **Tokenize (in `:root`, CSS) — UI/structural/semantic:** GitHub-dark structural grays (snap to the nearest neutral token — the prompt's intended unification); the tier/medal accent palette (new exact-hex tokens); button-variant state hex (`#111619`, `#e6a020/#c88a10`, `#f14a44/#b02020` → tokens; `#000`/`#fff` button text stay — conventional); the 2 inline `style=` colors (L662 `#58a6ff`→`var(--platinum)`, L697 `#8b949e`→`var(--muted)`).
  - **Unify ALL old brand-green, BOTH forms:** `rgba(26,158,92,…)` (7 CSS lines → hue `22,165,90`, opacities kept) AND `#1a9e5c` hex (4 sites: avatar L946, wheel L2573, center dot L2618, confetti L2635 → `#16a55a`).
  - **KEEP inline (decorative randomized palettes, like `medalColors`):** avatar `COLORS` (L946), `wheelSegColors` (L2572), `launchConfetti` (L2630) — NOT lifted into `:root`. Only their single `#1a9e5c` green entry is unified (above).
- **Phase 5:** Automated verification harness + browser E2E at 375/1280/1920px + `prefers-reduced-motion`.

### Out of Scope
- Any new feature/behavior beyond the prompt. No renaming of element IDs, class names, or `onclick` handler names.
- The 3 modal-overlay `backdrop-filter` blurs (`.modal-overlay`, `#pwModal`, `#historyModal`) — explicitly allowed by the prompt; leave them.
- The intentional green pulse `box-shadow:0 0` glows (`.status-dot`, `.round-row.live .round-live-dot`, `#gateInput:focus` ring) — keep.
- Adding the B8/B9 logic to `server.js` (it has no auto-save path; it is local-dev only).
- A test framework / build tooling.

## Approach

**Chosen:** Hybrid section rewrite + full color-token sweep, on the current branch, diffable against checkpoint `c2195c8`.
**Why:** Exploration confirmed `c2195c8` (= current HEAD) already implements Phases 1–4 correctly (0 emoji, 0 `transform:rotate`, 0 `text-shadow`, 27 `.ic` SVGs, only the 3 allowed modal blurs). The remaining real work is (a) a full color-token sweep — 7 green tints + a spread of GitHub-dark structural grays + the tier/medal palette — and (b) guaranteeing the fully-specified sections match the prompt's exact CSS/markup. Hybrid rewrite gives exact-spec conformance for those sections without the regression risk of retyping all ~2700 lines.
**Alternatives considered:**
- *Verify-against-spec + apply color delta only* — lowest risk, but doesn't honor the user's preference to rewrite the specified sections cleanly.
- *Literal from-scratch rewrite of both files* — rejected: retyping ~2700 lines of already-conforming code for an end-state nearly identical to `c2195c8` is high-risk/low-benefit.

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **The app is ONE file:** `public/index.html` (~2700 lines). CSS lives in the `<style>` block (roughly lines 1–520), then markup, then one inline `<script>` (~line 970 onward). The Vercel backend is `api/state.js`; `server.js` is a simplified local mirror.
- **⛔ Preserve all element IDs, class names, and `onclick` handler names.** Only visuals + the specific JS in the bug fixes change. Do NOT rename functions.
- **Authoritative spec:** `CLAUDE_PROMPT_pro_redesign.md` (exact CSS blocks, markup, and JS snippets). `BUG_REPORT.md` documents B1–B9.
- **"Hybrid rewrite verbatim" vs "reuse SVGs" — not contradictory:** "verbatim" applies to the CSS/markup blocks the prompt gives IN FULL (e.g. `:root`, gate, court-card, `notify`, leaderboard) — paste those exactly. The SVG icon path data is NOT in the prompt (only one example), so for those, REUSE the existing 27 `.ic` paths from checkpoint `c2195c8` rather than re-authoring. Net: spec text where the spec is complete; checkpoint where it isn't.
- **New `:root` green:** `--green:#16a55a` = `rgba(22,165,90,…)`. Tokens `--green-tint:rgba(22,165,90,.10)`, `--green-line:rgba(22,165,90,.28)`.
- **Tokens can't reach canvas / JS string literals.** CSS custom properties only work in CSS. For the lucky-draw `<canvas>` (`ctx.fillStyle`/`strokeStyle`) and `tierForPoints()` (L2244 — returns hex used in inline `style=`), tokenizing means centralizing values in ONE JS constant that mirrors the `:root` tokens — not literally `var(--x)`.
- **No `!important`** except the two existing allowed lines: mobile `#admin{padding:… !important}` (~L472) and the reduced-motion `*{scroll-behavior:auto!important}` (~L505).
- **Conventions:** CSS is dense single-line rules; match that style. Keep typographic `✓`/`✕` glyphs (allowed); no other emoji.

## Runtime Environment

- **Start (local):** `node server.js` → serves on `http://localhost:3000/` (viewer) and `/?admin` (admin). Admin password `TZH123`.
- **API:** `GET /api/state` (public, siteCode-gated), `POST /api/state` (admin, merges updates).
- **Prod:** Vercel serverless `api/state.js` + Upstash Redis (`court-state` key). Not exercised locally without Redis env.
- **Syntax check:** `node --check api/state.js`.

## Assumptions

- HEAD `c2195c8` already implements Phases 1–4 correctly (verified by direct file reads this session) — Tasks 2, 5, 6 are conformance rewrites, expected to produce small diffs. — Tasks 2, 5, 6.
- Tier/medal accent colors are tokenized at their EXACT current hex (no intended visual change) — supported by the prompt keeping inline `medalColors`. — Tasks 3, 4.
- Structural GitHub-dark grays are snapped to the nearest existing neutral token (`--dark/--card/--card2/--elev/--border/--border2/--text/--text-2/--muted`). This is a deliberate, minor visual unification — the prompt explicitly says to "replace any hardcoded hex … with the matching token." — Task 4.
- The `.tier-range` per-tier tinted bg/text pairs are derived from `--tc` via `color-mix` (matching the existing `.tier-icon` pattern) rather than getting 12 bespoke tokens — accepts a tiny shift on the tier-range pills to avoid token explosion; flagged for the verify eyeball. — Task 4.
- Decorative randomized palettes (avatar/wheel/confetti) stay inline like `medalColors`; only their single `#1a9e5c` old-green entry is unified to `#16a55a`. (User-confirmed boundary: "All UI colors; keep decorative palettes.") — Task 4.
- `server.js` is local-dev only and does not need B8/B9; the real backend is `api/state.js`. — Task 2.
- No test framework exists; node built-in scripts (`scripts/verify-redesign.js`, `scripts/smoke-server.js`) are the executable test/verification harness, wired via `npm test`. — Task 1.
- Browser extension may be unavailable (per project history); spec-verify falls back to playwright-cli/agent-browser per the browser-automation rules. — Phase 5.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Color sweep shifts visual intensity | Medium | Medium | Green tints keep their exact opacities (only hue → 22,165,90); tier/medal accent tokens set to EXACT current hex; structural grays snap to nearest neutral token (intended); `verify-redesign.js` + browser eyeball at 3 widths confirm. |
| `.tier-range` color-mix derivation drifts from the current bespoke hex pills | Medium | Low | Tier-range pills are minor UI; the `--tc` color-mix mirrors the existing `.tier-icon` approach; verify-phase eyeballs the Members modal — if drift is unacceptable, fall back to exact per-tier soft tokens. |
| Decorative palettes left un-tokenized read as "incomplete sweep" | Low | Low | Explicit user-confirmed boundary documented in Scope/Assumptions; guard scans them only for old-green, not for token compliance. |
| CSS vars can't reach canvas/JS inline styles | High | Low | Centralize those values in a single JS constant mirroring the tokens; documented in Task 4 Key Decisions. |
| Rewriting working CSS sections introduces regressions | Medium | Medium | Hybrid rewrites use the prompt's exact text; `verify-redesign.js` + E2E scenarios catch drift; every change diffable against `c2195c8`. |
| Inline `<script>` syntax break during edits | Low | High | `verify-redesign.js` parses the inline script via `new Function(src)` after every task; run before marking DoD. |
| Browser extension unavailable for E2E | Medium | Low | Fall back to playwright-cli (`node server.js` on :3000) or provide URL for manual check. |

## Goal Verification

### Truths
1. All 9 bugs B1–B9 are fixed exactly per `BUG_REPORT.md`/the prompt (code points match; server round-trips). — TS-006 covers B2/B3 observably.
2. Zero childish elements: 0 emoji except `✓`/`✕`, 0 `transform:rotate`, 0 `text-shadow`, `backdrop-filter` only on the 3 modal overlays. — TS-002/004/005.
3. One token-driven design system: every used `var(--x)` resolves to a defined token (`:root`, or the per-tier `--tc` local); no leftover deny-listed GitHub-dark hex; green unified (both `rgba` and `#1a9e5c` forms); tier/medal palette tokenized; decorative palettes kept inline by design.
4. Viewer + admin are visually consistent flat dark at 375 / 1280 / 1920px. — TS-002/003/007.
5. App still serves and round-trips: `node server.js` → `GET /` 200, `POST /api/state` (pwd) persists, wrong pwd → 401; `node --check api/state.js` passes; inline `<script>` parses. — TS executed against running app.
6. `prefers-reduced-motion` disables the gate fade-in animation. — TS-007.

### Artifacts
- `scripts/verify-redesign.js` (static design + Phase-5 guard), `scripts/smoke-server.js` (running-app round-trip), `public/index.html`, `api/state.js`, `package.json` (test wiring).

## E2E Test Scenarios

### TS-001: Site gate — single fade-in + code validation
**Priority:** Critical
**Preconditions:** A `siteCode` is set on state; fresh load (no stored code).
**Mapped Tasks:** Task 5

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Load `/` with a siteCode set | `#siteGate` shows one clean centered `.gate-card` that fades in ONCE (no grid lines, floating dots, mouse glow, or ripple) |
| 2 | Type a wrong code, click Enter | `#gateError` "Incorrect code. Try again." shows; gate stays |
| 3 | Type the correct code, press Enter | Gate hides; viewer renders |

### TS-002: Viewer court display (TV / 1920px)
**Priority:** Critical
**Preconditions:** ≥1 round with courts and players.
**Mapped Tasks:** Task 4, Task 5

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Load `/` at 1920×1080 | Header reads "TZH **Badminton**" (accent on Badminton); flat court cards with a green top accent bar, round badge pill, circular avatars, `VS` badge |
| 2 | Inspect for childish elements | No emoji, no rotated/glowing/glass elements; only the live pulse dots glow |

### TS-003: Admin panel + toast
**Priority:** High
**Preconditions:** Admin unlocked (`TZH123`).
**Mapped Tasks:** Task 6

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open `/?admin`, unlock | Four tabs show SVG icons (no emoji); card titles show green-tinted SVG icons |
| 2 | Add a roster player with a name | Green success toast appears top-right |
| 3 | Click "Add player" with empty name | Amber (`--warn`) toast "Enter a player name." — no `⚠` glyph |

### TS-004: Members modal — flat tiers, SVG icons
**Priority:** High
**Mapped Tasks:** Task 4, Task 5

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open the Members modal | Tier cards are flat (1px border, top accent bar), tier icons are SVGs in tier colors, no sparkles/glass |
| 2 | Find the popular tier | Badge reads "Most Popular" and is NOT rotated |

### TS-005: Leaderboard + decorative rendering after the color sweep
**Priority:** Medium
**Mapped Tasks:** Task 4, Task 5

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open the Leaderboard modal | Top-3 podium shows numeric badges `1` `2` `3` (gold/silver/bronze tints), not 🥇🥈🥉 emoji |
| 2 | View player avatars; open the lucky-draw wheel and trigger a spin/confetti | Avatar initials render on colored circles (the green entry now matches the new brand green); the wheel segments + confetti render with their decorative palettes intact — no missing/black fills after the sweep |

### TS-006: History edit — full roster (B2) + empty back-date (B3)
**Priority:** High
**Preconditions:** Admin unlocked; roster has players not checked in today; a past date with no session.
**Mapped Tasks:** Task 2

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open history, pick a past date, "+ Create session for this date" | New session is EMPTY (no rounds copied from today) (B3) |
| 2 | Edit it, open the "Add player…" select | Dropdown lists the FULL roster, including players not checked in today (B2) |

### TS-007: Responsive + reduced motion
**Priority:** Medium
**Mapped Tasks:** Task 5, Task 6

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Load viewer at 375px and admin at 375px | No horizontal overflow; tap targets ≥ ~40px; layout intact |
| 2 | Enable `prefers-reduced-motion` and reload the gate | `.gate-card` shows no fade-in animation |

## Progress Tracking

- [x] Task 1: Verification harness (TDD RED)
- [x] Task 2: Bug-fix conformance (B1–B9) + server smoke test
- [x] Task 3: Design tokens & tier/medal palette (Phase 2)
- [x] Task 4: Full color-token sweep (CSS + JS/canvas)
- [x] Task 5: Hybrid rewrite — viewer sections (Phase 3) — verified verbatim-conformant (color sweep applied in Task 4; no structural drift)
- [x] Task 6: Hybrid rewrite — admin + toast (Phase 4) — verified verbatim-conformant (notify/#notif/.rc/title-icons/hdr-brand match prompt)

**Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0 _(browser TS checks run in spec-verify)_

## Implementation Tasks

### Task 1: Verification harness (TDD RED)

**Objective:** Encode the prompt's Phase-5 acceptance criteria as an executable guard that FAILS on the current tree (the leftover green tints + grays), so the color sweep is TDD red→green.
**Dependencies:** None
**Mapped Scenarios:** None (tooling)

**Files:**
- Create: `scripts/verify-redesign.js`
- Modify: `package.json` (add `"test": "node scripts/verify-redesign.js"`)

**Key Decisions / Notes:**
- Pure Node built-ins (`fs`, `child_process`) — no new dependency. Reads `public/index.html` and `api/state.js`. Each check prints offending `line:snippet` on failure.
- **(a) state.js syntax:** `node --check api/state.js` via `child_process` exits 0.
- **(b) inline-script parse:** extract the inline app script (slice between the last `<script>`…`</script>`) and `new Function(src)` with no throw.
- **(c) no old brand-green — BOTH forms:** zero matches of `rgba(26,158,92` AND zero matches of `#1a9e5c` (case-insensitive) anywhere.
- **(d) no GitHub-dark structural hex (explicit deny-list, not "any hex"):** zero matches of `#0d1117|#161b22|#30363d|#21262d|#c9d1d9|#adb5bd|#e6edf3|#8b949e|#444c56|#111619` outside the `:root` block. Using an explicit deny-list avoids false-positives on allowed tier/medal/decorative hex and SVG path data.
- **(e) `var(--x)` resolves — handle locals + fallbacks:** build the DEFINED set from EVERY `--name:` declaration anywhere in the stylesheet (not just `:root`) — this legitimately includes the per-tier local `--tc`. For each `var(--name …)` usage, parse only the `--name` (ignore any `, fallback`); assert it's in the DEFINED set. (Resolves the `var(--tc, …)` false-positive.)
- **(f) emoji scan with precise allow-list:** flag pictographic emoji ranges (`\u{1F000}-\u{1FAFF}`, `\u{2600}-\u{26FF}`, `\u{2700}-\u{27BF}`, `\u{2B00}-\u{2BFF}`, regional indicators, VS16/ZWJ) but ALLOW the typographic glyphs actually used: `✓ ✕ → ← …`. (Resolves arrow/ellipsis false-positives.)
- **(g) no static rotate badge / no text-shadow:** flag literal `transform:rotate(` only (the removed tier-popular badge). EXPLICITLY allow `rotate(` inside multi-function transforms (confetti keyframe `translateY(..) rotate(..)`, L400) and `ctx.rotate(` (L2600). Zero `text-shadow`.
- **(h) `backdrop-filter` by selector, not count:** assert every CSS rule containing `backdrop-filter` is one of the allowed selectors (`.modal-overlay`, `#pwModal`, `#historyModal`). Do NOT use a numeric threshold (there are 6 raw occurrences = 3 plain + 3 `-webkit-` across 3 lines, which is correct).
- **(i) `!important`:** only on the two allowed lines (mobile `#admin` padding, reduced-motion `scroll-behavior`).

**Definition of Done:**
- [ ] `node scripts/verify-redesign.js` exits non-zero NOW, listing the 7 green-tint lines + `#1a9e5c` sites + the GitHub-dark grays (RED confirmed) — and does NOT falsely flag `var(--tc, …)`, the confetti `rotate()`, the `→ ← …` glyphs, or the 3 modal `backdrop-filter` rules.
- [ ] `npm test` invokes the script.
- [ ] No diagnostics errors in the script.

**Verify:** `node scripts/verify-redesign.js; echo "exit=$?"` (expect non-zero + violation list)

---

### Task 2: Bug-fix conformance (B1–B9) + server smoke test

**Objective:** Confirm every B1–B9 fix matches the prompt/`BUG_REPORT.md` exactly (fix any drift), and prove the running app round-trips.
**Dependencies:** None
**Mapped Scenarios:** TS-006

**Files:**
- Modify (only if divergence found): `public/index.html`, `api/state.js`
- Create: `scripts/smoke-server.js`

**Key Decisions / Notes:**
- Check each fix at its known location: B1/B5 `poll()` (~L1013) guard + `renderPlayersSection`; B4 `refreshState()` as first line of all 10 mutations (~L1272…2274); B7 `deleteRosterPlayer` strips `sessions`; B2 `renderSessionDetail` uses `state.roster` + `addHistoryPlayer` roster-first; B3 `createHistorySession` `rounds:[]`; B6 `startHistoryEdit` 3s timeout; B8 client `todayISO` local + server offset; B9 snapshot includes `courtRounds`.
- `smoke-server.js`: spawn `node server.js` on an ephemeral `PORT`, poll until up, then assert: `GET /` → 200 and body contains `id="viewer"`; `POST /api/state` `{password:'TZH123', numCourts:3}` → `{ok:true}` and a follow-up `GET /api/state` shows `numCourts===3`; `POST` with wrong password → 401. Kill the server. Use Node 18+ global `fetch`.
- `server.js` is local-dev only — do NOT add B8/B9 to it.
- **Test-coverage honesty:** B3 (empty back-date) and B2 (full-roster dropdown) are covered observably by TS-006. B8-client/B9 are statically asserted by `verify-redesign.js` (source contains the offset `todayISO` + `courtRounds` in the snapshot) and B9/B8-server runtime is not unit-tested because `api/state.js` needs Redis and exports only the handler. **B1, B4, B5, B6, B7 have NO executable regression test** — they are DOM/timing/concurrency behaviors verified by code-point inspection + the inline-script parse + manual/browser check. This gap is accepted (no test framework, single-file app); documented rather than papered over.

**Definition of Done:**
- [ ] All 9 bug-fix code points match the prompt (drift, if any, fixed).
- [ ] `node --check api/state.js` passes.
- [ ] `node scripts/smoke-server.js` passes (200 / persist / 401).
- [ ] TS-006 passes in browser (empty back-date + full-roster dropdown).

**Verify:** `node --check api/state.js && node scripts/smoke-server.js`

---

### Task 3: Design tokens & tier/medal palette (Phase 2)

**Objective:** Make `:root` the single source of truth — rewrite it (+`body`,`.ic`,button polish) exactly per prompt and ADD the tier/medal palette tokens.
**Dependencies:** Task 1
**Mapped Scenarios:** TS-002, TS-003

**Files:**
- Modify: `public/index.html` (`:root`, `body`, `.ic`, `.btn*`)

**Key Decisions / Notes:**
- Paste the prompt's exact `:root` block, `body` rule, and `.ic` rule (Phase 2). Then paste the prompt's button polish block (`.btn`, `.btn .ic`, `.btn:active`, `.btn-primary` + `:hover`/`:active`) verbatim.
- ADD tier/medal accent tokens to `:root` at EXACT current hex (no visual change): `--bronze:#cd7f32;--bronze-line:#b87333;--silver:#7d8590;--gold:#f0b429;--platinum:#58a6ff;--platinum-line:#388bfd;--diamond:#bc8cff;--diamond-line:#8957e5;--visitor:#555e6b;` plus medal tints `--medal-gold:#f5cf5b;--medal-silver:#cdd3da;--medal-bronze:#e0975a;`. Confirm `--gold` equals the existing `--accent` (#f0b429) — reuse `--accent`, don't duplicate, OR alias.
- ADD button-state tokens at EXACT current hex: `--accent-hover:#e6a020;--accent-active:#c88a10;--red-hover:#f14a44;--red-active:#b02020;` and reuse `--card`/`--dark` for `.btn-secondary:active` `#111619` (snap to nearest). `--green-dark` already exists. `#000`/`#fff` button text stay (conventional, not tokenized).
- Tier-text grays (`#c9d1d9`,`#e6edf3`,`#adb5bd`) are NOT new tokens — they snap to `--text`/`--text-2`/`--muted` during the Task 4 sweep.
- Document the exact token→hex map in a CSS comment block so the JS mirror (Task 4) stays in sync.
- **Deviation (YAGNI):** `--medal-*` tokens were NOT added — `medalColors` stays inline hex because the leaderboard appends alpha (`#f5cf5b22`/`66`), which `var()` cannot do. Adding unused tokens would be dead code. Tier `--tc` uses the darker variant (`.tier-bronze{--tc:#b87333}`=`--bronze-line`, `.tier-platinum{--tc:#388bfd}`=`--platinum-line`, `.tier-vip{--tc:#8957e5}`=`--diamond-line`); `.th-*` headers use the light token for `color` + the `-line` token for `border`. The benefits-table check green `#3fb950` (`.ck`) snaps to `--green-light` (brand unify, Task 4).

**Definition of Done:**
- [ ] `:root`/`body`/`.ic`/button-polish CSS match the prompt verbatim (plus the additive token block).
- [ ] All listed tier/medal + button-state tokens defined; `--gold`==`--accent` confirmed.
- [ ] `verify-redesign.js` "var resolves" passes for any new `var()` usages introduced here; inline script still parses.
- [ ] Buttons render with the new flat style + active offset (browser).

**Verify:** `node scripts/verify-redesign.js` (var-resolve + parse sections pass)

---

### Task 4: Full color-token sweep (CSS + JS/canvas)

**Objective:** Eliminate every leftover hardcoded color — the turn that flips `verify-redesign.js` to GREEN.
**Dependencies:** Task 3
**Mapped Scenarios:** TS-002, TS-005

**Files:**
- Modify: `public/index.html`

**Key Decisions / Notes:**
- **Old brand-green — unify BOTH forms:**
  - `rgba(26,158,92,…)` CSS tints — 7 lines (~94 `.06`, 115 `.04`, 122 `.15`, 128 `.35`+`.08`, 236 `.12`, 239 `.12`, 377 `.12`): change hue → `22,165,90`, KEEP each opacity.
  - `#1a9e5c` hex — 4 sites → `#16a55a`: avatar `COLORS[0]` (L946), `wheelSegColors` (L2573), wheel center dot (L2618), `launchConfetti` (L2635). These live in decorative palettes — change ONLY the green entry, leave the rest of each palette untouched.
- **Structural grays → nearest neutral token (snap):** `.rsummary` `#c9d1d9`→`--text-2`; `.btable td` border `#161b22`→`--border`, text `#adb5bd`→`--muted`, first-child `#c9d1d9`→`--text-2`; `.tier-range` bg `#21262d`→`--card2`/`--elev`; scrollbar `#0d1117`→`--dark`, `#30363d`→`--border2`; `.tier-icon` fallbacks `var(--tc,#444c56)`→`var(--tc,var(--border2))`, `var(--tc,#8b949e)`→`var(--tc,var(--muted))`; canvas hub `#0d1117` (L2615/2627)→via JS const (below); inline `<th>` Benefits `#8b949e` (L697)→`style="color:var(--muted)"`.
- **Tier/medal semantic CSS → tier tokens:** `.th-b/.th-s/.th-g/.th-p/.th-v` (L301-303) and `.tier-visitor/.tier-silver/.tier-bronze/.tier-gold/.tier-platinum/.tier-diamond` `--tc` (L277-282) → `var(--bronze)`/`var(--silver)`/`var(--gold)`/`var(--platinum)`/`var(--diamond)`/`var(--visitor)` (+ `-line` border variants). Inline `.tier-perk` `style="color:#58a6ff"` (L662)→`style="color:var(--platinum)"`.
- **`.tier-range` per-tier tinted bg/text pairs (L277-282):** derive from `--tc` via `color-mix` (e.g. `background:color-mix(in srgb,var(--tc) 18%,var(--dark));color:color-mix(in srgb,var(--tc) 70%,var(--text))`) — mirrors the existing `.tier-icon` pattern, removes ~12 bespoke hex without new tokens. Accept the minor pill shift (flagged for verify eyeball).
- **JS / canvas (CSS vars can't reach `ctx.fillStyle` or returned hex):** add ONE constant near the top of the inline script — `const TIER = { visitor:'#555e6b', silver:'#7d8590', gold:'#f0b429', platinum:'#58a6ff', diamond:'#bc8cff' }` (and `tc` text values) mirroring the tokens — and rewrite **`tierForPoints(pts)` (L2244, NOT `playerTier`)** to return from it. For the wheel canvas (`ctx.fillStyle`/`strokeStyle`), keep the decorative `wheelSegColors` palette inline; only the structural hub `#0d1117` (L2615/2627) reads a `const DARK='#0a0c0f'` mirror of `--dark`. `medalColors` (L2299) stays inline per prompt (values unchanged).
- **KEEP inline (decorative, like `medalColors`):** avatar `COLORS` array (non-green), `wheelSegColors`, `launchConfetti` — do NOT lift into `:root`.
- Re-run `verify-redesign.js` after editing — inline script MUST still parse.

**Definition of Done:**
- [ ] `node scripts/verify-redesign.js` exits 0 — no `rgba(26,158,92`, no `#1a9e5c`, no deny-listed GitHub-dark hex outside `:root`, all `var(--x)` resolve (incl. `--tc` locals), inline script parses — GREEN.
- [ ] `tierForPoints` + canvas hub read from the JS constant mirrors; decorative palettes otherwise untouched.
- [ ] No diagnostics errors.
- [ ] Browser eyeball: tier colors, leaderboard medals, avatar/wheel/confetti render correctly (TS-005 step 2); tier-range pills acceptable.

**Verify:** `node scripts/verify-redesign.js; echo exit=$?` (expect 0)

---

### Task 5: Hybrid rewrite — viewer sections (Phase 3)

**Objective:** Wholesale-rewrite the fully-specified viewer sections from the prompt, reusing existing SVG paths.
**Dependencies:** Task 3
**Mapped Scenarios:** TS-001, TS-002, TS-004, TS-005, TS-006

**Files:**
- Modify: `public/index.html`

**Key Decisions / Notes:**
- Court display CSS (`#viewer`,`.viewer-header`,`.round-badge`,`#courtsDisplay`,`.court-card`+`::before`,`.court-label`,`.team-block`,`.avatar`,`.player-slot .pname`,`.vs-badge`) + header markup `<h1>TZH <span class="vh-accent">Badminton</span></h1>`.
- Site gate: paste the prompt's gate CSS + markup; `initHeroGate` becomes the single re-trigger fade. Ensure the old HERO-GATE animation/markup/IIFE are gone (already removed at `c2195c8` — confirm).
- Members modal tier cards (flat, top accent bar, `.tier-icon` with `color:var(--tc)` + `color-mix` fallback) — REUSE the existing 6 tier SVGs + 5 earn-row SVGs; headline weight 700, no sparkles; `.tier-popular-badge` "Most Popular", no rotate.
- History modal `.history-box` (flat) + `.history-close`/`.cal-chevron` circles.
- Leaderboard: `medalColors=['#f5cf5b','#cdd3da','#e0975a']` + `.lb-podium-medal` numeric badges.
- ⛔ Preserve all IDs/classes/`onclick` names.

**Definition of Done:**
- [ ] Listed sections match the prompt verbatim; existing SVG paths reused.
- [ ] `verify-redesign.js` stays GREEN; inline script parses.
- [ ] TS-001, TS-002, TS-004, TS-005 pass in browser; no emoji.

**Verify:** `node scripts/verify-redesign.js` + browser TS-001/002/004/005

---

### Task 6: Hybrid rewrite — admin + toast (Phase 4)

**Objective:** Wholesale-rewrite the fully-specified admin sections + toast from the prompt.
**Dependencies:** Task 3
**Mapped Scenarios:** TS-003, TS-007

**Files:**
- Modify: `public/index.html`

**Key Decisions / Notes:**
- `notify(msg,type)` + `#notif` CSS + `#notif.notif-warn{background:var(--warn)}`; confirm all warn-type calls pass `'warn'` and the "Confirm replace" label (no `⚠`).
- `.rc` roster card CSS (`:hover`, `.in-session`) per prompt.
- `.admin-card-title .ic,.section-title .ic{... color:var(--green-light)}`; `.admin-hdr-brand` → `--text`, tight tracking.
- Confirm the four tab + six card-title icons are SVG (reuse existing); "Editing historical session" pill is a clean bordered amber chip (no `⚠`).
- ⛔ Preserve all IDs/classes/`onclick` names.

**Definition of Done:**
- [ ] Listed sections match the prompt; toast shows green (success) / amber (warn).
- [ ] `verify-redesign.js` GREEN; inline script parses.
- [ ] TS-003 + TS-007 pass in browser; no emoji.

**Verify:** `node scripts/verify-redesign.js` + browser TS-003/007

---

_Phase 5 full verification (browser at 375/1280/1920px, reduced-motion, `node server.js` round-trip) is executed in spec-verify via the TS scenarios above._

## E2E Results (playwright-cli @ localhost:3300 — Chrome extension unavailable on this machine)

| Scenario | Priority | Result | Notes |
|----------|----------|--------|-------|
| TS-001 Site gate | Critical | PASS | Clean centered `.gate-card`, green eyebrow/focus ring, "Welcome" + code input, no grid/dots/glow/ripple. Validation logic unchanged from c2195c8. |
| TS-002 Viewer (1920) | Critical | PASS | "TZH **Badminton**" accent, flat court cards w/ green top bar, avatars (green avatar = new brand green), VS, SVG buttons, 0 emoji. |
| TS-003 Admin + toast | High | PASS | Brand in `--text`, SVG tab + card-title icons, flat `.rc` cards; warn toast → `--warn` amber (#cd7d2c), no ⚠. |
| TS-004 Members modal | High | PASS | Flat tier cards w/ colored top bars, SVG tier icons, "Most Popular" not rotated, `color-mix` tier-range pills render correctly, tokenized tier-perk colors, 0 sparkles. |
| TS-005 Leaderboard | Medium | PASS | Numeric rank badges 1/2/3 (gold/silver/bronze tints, not emoji), tier badges via `tierForPoints`, avatars render. |
| TS-006 History B2/B3 | High | NOT EXERCISED | `server.js` (local) lacks the `updateSession`/sessions backend — that flow only runs on Vercel+Redis (`api/state.js`). B2 (`state.roster` source) + B3 (`rounds:[]`) are code-verified in Task 2. |
| TS-007 Responsive + reduced-motion | Medium | PASS | 375px viewer: single-column, **0px** horizontal overflow; `@media(prefers-reduced-motion) .gate-card{animation:none}` confirmed in source. |

## Not Verified (Step 12)

| Not Verified | Reason |
|-------------|--------|
| TS-006 history edit flow (B2 full-roster dropdown, B3 empty back-date) end-to-end in a browser | Local `server.js` has no history/session backend (`updateSession` action, `sessions` map, auto-save). The B2/B3 fixes are verified at the code level (Task 2) and would only run against the Vercel + Upstash Redis deployment. |
| Lucky-draw wheel spin + confetti render | Default local state has no `luckyDraw` entries; triggering requires admin draw-pool setup. The decorative `wheelSegColors`/`launchConfetti` palettes are unchanged except the unified `#1a9e5c→#16a55a` green, and that same green renders correctly in player avatars (verified TS-002/005). |
| B8 server `TZ_OFFSET_HOURS` / B9 `courtRounds` runtime persistence | `api/state.js` needs Upstash Redis; not runnable locally. Verified statically (source) + the client B8 local date renders correctly (admin shows "Thursday 11 June 2026"). |

## Verification Adjustments (changes-review: 0 must_fix, 2 should_fix, 6 suggestions)

**Fixed (should_fix):**
- **Button-state tokens were dead** — wired `.btn-accent:hover/:active` and `.btn-danger:hover/:active` to `var(--accent-hover)/--accent-active/--red-hover/--red-active` (were still literal hex).
- **3 markup tier inline-styles missed** — tokenized `#cd7f32→var(--bronze)` (L621), `#f0b429→var(--gold)` (L651), `#bc8cff→var(--diamond)` (L673); only `#58a6ff` had been swept.
- **Structural `#0a0e14`** (`.round-editor` bg) → `var(--dark)`.

**Accepted deviations / kept-by-design (suggestions):**
- **`tierForPoints()` returns inline hex directly** (no separate `const TIER`/`const DARK` mirror) — it already IS the single JS color source; a wrapper const would be redundant indirection. Canvas hub uses literal `'#0a0c0f'` (mirrors `--dark`; `var()` can't reach `ctx.fillStyle`). Functionally identical to the planned mirror; recorded as an intentional simplification.
- **Kept intentional:** `.gate-error{color:#ff6b6b}` (distinct brighter semantic error red, single-use, like `--warn`); leaderboard podium `.p1/.p2/.p3` (`#ffd700/#c0c0c0/#cd7f32` — a cohesive medal palette, kept inline like `medalColors`); `.tier-popular-badge` text `#1a1205` (per prompt allow).
- **Guard "dead-token" check NOT added** — it would flag the pre-existing unused `--blue` token (out of scope to remove per change-discipline). The deny-list guard stays GitHub-dark-specific by design.
- **`smoke-server.js` fixed port 3517** — kept (overridable via `SMOKE_PORT`; SIGTERM→SIGKILL cleanup verified no leaks; low single-run risk).
