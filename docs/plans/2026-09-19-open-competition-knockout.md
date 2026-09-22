# Open Competition ("Knockout") Implementation Plan

Created: 2026-09-19
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** A public, code-entered tournament that anybody can enter, not just the regulars who come to the social games. An admin creates an event with one or more CATEGORIES ("Men's Doubles Open", "Mixed Doubles U40"); each carries its own PUBLIC CODE meant to be printed on a poster or posted on Instagram. Entering that code on the public site opens the registration form for that category. For doubles, one person fills in both players' details. The admin confirms entries and marks them paid, seeds the field, generates a draw, and enters results; the bracket goes live on the viewer and the hall screen.

**Architecture:** One new state key, `state.knockout`, holding the event, its categories, their entrants and their draws. Pure logic (bracket maths, seeding, validation, projections) lives in `public/knockout.js` (`window.Knockout`, required by Node); server handlers live in `lib/knockout.js` behind the existing `{status, body, changed}` contract. Two unauthenticated POST branches (`knockoutLookup`, `submitKnockoutEntry`) sit with `submitSignup` BEFORE the admin-password check; sixteen admin actions sit with the other admin dispatchers. All UI is added to the inline script in `public/index.html`, per the project's established single-file pattern.

**Tech Stack:** Vanilla JS (no frameworks, no build, no new deps), Express + Vercel serverless, Upstash Redis, the existing Apple-light design tokens.

---

## Decisions (confirmed by the user, 2026-09-19)

These were chosen before implementation and override anything ambiguous below.

1. **Single elimination is the primary format**, modelled on the user's reference brackets (challonge.com/hv8as4nt, a 20-player single-elim Men's Singles U16). A third-place playoff is included by default: one extra match, two more people with a reason to stay.
2. **A category with five or fewer confirmed entries runs a ROUND ROBIN instead**, with the top two contesting a final. The user's own second reference (challonge.com/ocybfw8y) is a five-team U14 doubles category run as a round robin, because a five-team bracket hands out three byes and sends a team home after one match. `format: 'auto'` does this switch; an admin can force either format per category.
3. **Public code per category.** One shareable code per category, printed and posted. The code is the only gate on the entry form.
4. **One person enters both players for doubles.** Per player: name, contact number, IC/passport, representing club (optional, defaults "Free Agent"). The bracket label is "Player A & Player B", matching the reference.
5. **IC/passport is collected, encrypted and masked.** Required by default (age-graded categories need it); `event.requireIC` turns it off for an event that does not.
6. **Payment is manual.** The payment step shows the club's bank/DuitNow line; the entry stays `pending` until an admin confirms the money arrived. No gateway, no new dependency.

## Scope

### In Scope
- New state: `knockout: { event, categories[] }` in `api/state.js` `DEFAULT_STATE` + the GET normalizer, and in `server.js` defaults.
- Unauthenticated `knockoutLookup` / `submitKnockoutEntry` branches (self-building, never spreading `req.body`) in both servers.
- Sixteen admin actions: event settings, category CRUD + code rotation, entrant confirm/paid/withdraw/delete, walk-in entries, audited IC reveal, seeding, draw generate/clear, result set/clear, court assignment.
- `publicKnockout()` projection wired into `publicProjection()`; `teaser()` on the locked GET; `pollKnockout()` on the admin poll.
- Public UI: code box on the lockscreen and viewer, three-step Register/Confirmation/Payment modal with an "Add participants" repeater.
- Admin UI: a `knockout` tab (added to `AdminNav.TABS` and the accent-badge list), event card, category cards with codes/caps/fees/format, entrant review, drag-and-arrow seeding, score sheet.
- Viewer UI: the live bracket and round-robin standings, with an on-court pill.
- Tests: `scripts/test-knockout.js` (pure), `test-knockout-handler.js` (handlers, encryption, guardrails), `test-knockout-ui.js` (page wiring, the projection, and a whole event over HTTP). All wired into `npm test`.

### Out of Scope
- A payment gateway, and proof-of-payment uploads (the single-blob state is not an image store).
- Double elimination and consolation/plate brackets.
- Automatic court scheduling: an admin types the court number on a match.
- Notifying entrants (no email/SMS); the admin has their phone number.
- Linking entrants to roster players, points or the Monthly draw. A competition entrant is deliberately its own thing, because most of them are not members yet.

---

## Approach

**Draws are DERIVED, not mutated.** A draw stores only its skeleton (the seeded slot order and the match graph) plus a `results` map of `matchId -> {winner, score}`. `resolveDraw()` recomputes every participant from those two things on demand. Correcting a mis-typed score therefore invalidates everything downstream automatically: a later result whose participants no longer match is ignored rather than leaving a ghost name in a later round. There is no "advance the winner" mutation anywhere, so a bracket can never disagree with itself. The admin is told how many later results a change will clear and confirms that number.

**Why not extend `rounds`/`smartSchedule`:** the session engine is a flat rotation (everyone plays, rest gaps balance, rounds are independent). A bracket is a dependency graph and its court assignment is a queue. Sharing code between them would have meant bending both.

**Privacy.** Entrant IC/passport numbers are the most sensitive thing this app holds, and they arrive over an unauthenticated POST from strangers. An IC is encrypted with AES-256-GCM (`lib/crypto.js`, key in `ACCOUNT_ENC_KEY`) inside the handler, before it touches the state blob; what is stored is `{ icEnc, icLast4 }` and nothing else. `publicKnockout()` drops every phone, every IC, every unconfirmed entrant and every category code, keeping only what a screen in a hall needs (labels, seeds, clubs, matches, scores). `pollKnockout()` keeps the encrypted blobs off the 2-second admin poll. `knockoutRevealIC` decrypts one player at a time for an authenticated admin, writes an audit row naming who was looked at (never the number itself), and the UI auto-hides it after 30 seconds. A missing `ACCOUNT_ENC_KEY` never costs the club an entry: the last four are kept, the rest is dropped, and the admin card says so.

**Alternatives considered:**
- *Level-band categories* (rejected: the reference event's categories are gender/format/age, and free-text names are more flexible).
- *Groups-then-knockout for every category* (rejected by the user in favour of single elimination, kept only as the small-field fallback).
- *A separate Redis key for the competition* (rejected: breaks the single-blob `{...state, ...updates}` model the whole app relies on; the per-category `MAX_ENTRANTS` cap of 128 keeps growth bounded).
- *Storing full ICs in the clear* (rejected outright).

---

## Bugs found and fixed during the build

Both were caught by tests written alongside the code, and both are now covered by regression tests.

1. **The public projection was being undone.** `publicProjection()` ran the competition through `publicKnockout()` and then called `liteMonthlyLucky()`, which re-normalised it. Normalising a stripped projection rebuilds the fields it dropped, so the public GET was serving pending entrants and the stored entrant shape. Fixed by keeping the two apart: the poll shape is applied only on the admin ping, never after a public projection. Guarded by a direct `publicProjection()` unit test.
2. **The public bracket rendered every name as "TBC".** `viewOf()` built labels from `entrant.players`, which the public projection deliberately strips (phones and ICs live there); the public shape carries a precomputed `label` instead. Fixed with `labelOf()`/`clubOf()`, which read either shape, so the public and private brackets now render identically. Guarded by a test that builds a bracket from the public projection and compares it to the private one.

---

## Verification

`npm test` is green, including the pre-existing suite. New coverage: 183 pure tests, 100 handler tests, 85 page/HTTP tests (50 when no local server can be started, which is reported as a skip rather than silently passing).

The whole event was also run end to end against a real local server in a browser: an admin sets up, a stranger enters with only a code, the admin confirms/seeds/draws/scores, and the bracket renders on the viewer. At every step the public GET was checked for IC digits, encrypted blobs, phone numbers, category codes and unconfirmed entrants, and carried none of them.

Not covered and worth knowing: nothing has been run at real tournament scale (128 entrants across many categories) or against production Upstash.

## Follow-ups worth considering

- **Withdrawal after the draw** currently annotates the entrant and leaves the bracket alone, which means a walkover has to be recorded by picking the winner manually. A proper walkover state would be clearer on the display.
- **No connector lines between bracket rounds.** The columns read correctly but a bracket normally draws the lines.
- **No court auto-assignment.** With several categories running at once on limited courts, a queue that suggests the next match would save the organiser real time on the night.
- **Nothing links a competition entrant to the roster**, so a newcomer who enters and then starts coming to social games is typed in twice. A "add to roster" button on a confirmed entrant would close the loop the whole event exists to open.
