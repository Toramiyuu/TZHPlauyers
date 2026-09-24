# The shared game queue

24 September 2026. Replaces the round-based schedule on the Courts tab.

## The problem

The night was planned in **rounds**: one row of `state.rounds` held every court
playing at once, and `state.rounds[n].courts[i]` was court slot `i`'s game in
round `n`.

Court 2 goes to deuce and takes twenty minutes. Courts 3 and 4 finish in eight
and move on to round 2 without it. From that moment the word "round" is a lie:
the board says three courts are in round 2 when only two of them are, the "Up
Next" panel offers court 2 a game built for a different moment in the night, and
the people who happened to draw the slow court have played fewer games than
everyone else. Nothing in the app measured that, so nothing corrected it.

## The shape of the fix

Upcoming games are **one shared ordered queue belonging to no court**. Whichever
court frees up first takes the top game that can actually start. A long game
costs nobody anything but the four people in it.

Decisions taken with the owner, all settled:

| | |
|---|---|
| Queue shape | One shared list, not a lane per court |
| A player is still on another court | Skip that game, take the next that can start, say which was skipped and why |
| A game with an empty seat | Also skipped: four names or it is not a game |
| Generate | Stays, fills the queue with N games instead of N rounds |
| The old round list | Became the record of games played tonight |
| Prev / Next / Start Next Round | Gone, replaced by "Fill every free court" |
| Who has waited longest | Real minutes since their last game ended |

## The data model, and why `rounds` kept its name

Three keys, each with one job, instead of one key doing three.

- **`state.rounds` is now a single row**: the live board. `courtRounds` is
  `[0,0,…]` and court `i`'s live game is still `rounds[0].courts[i]`. A free
  court is the empty slot `{team1:['',''],team2:['','']}`, which every renderer
  already draws as TBD. Nothing appends to it any more.
- **`state.queue`** — `[{ id, team1, team2 }]`, upcoming, in order.
- **`state.played`** — append-only `[{ id, court, team1, team2, startedAt, endedAt }]`.

Keeping the live game at `rounds[courtRounds[i]].courts[i]` is what made this
cheap. Four independent readers use that address: the 2D viewer
(`index.html:renderViewer`), the admin cards (`renderCourtControls`), the slot
editors, and the 3D arena, which fetches `/api/state` itself and reimplements
the lookup in ES5. A one-row array is a shape all four already handled, so none
of them needed rewriting, and a night saved under the old model still renders.

**History had to live in its own key**, and this was the one real argument in
the design. Two paths would have destroyed it silently inside `rounds`:

- `applyCourtDrop` filters a court out of *every* row. Dropping a court at 10pm
  would have erased every game ever played on it, taking the repeat-pairing
  counts with it.
- `saveRound`, `applyNextUpEdits` and `Matchmaking.fillRound` all rebuild a
  court as a bare `{team1, team2}`, so any timestamp stored beside it would
  vanish the first time somebody pressed Save.

`state.courtLive[i]` was already the epoch-ms start of each court's game, so it
is reused as `startedAt`. Only `endedAt` is new.

## Migration

None needed, and that is a property of the design rather than a claim. The
meaning of a row never changed; we just stopped making more of them. An old
night restores with many rows and per-court pointers and renders correctly.

The first time a court on such a night takes its next game, `historicGamesOf`
folds the games it had already played into `state.played` before collapsing the
board to one row, so the record and the pairing counts survive. Those recovered
games carry `startedAt: 0, endedAt: 0`, because no clock was ever recorded and
inventing one would be worse than admitting it.

## What was deleted, and why it must stay deleted

Each of these promised something that is no longer knowable:

- `computeNextUp`, `nextCourtRounds`, `applyNextUpEdits` — "the round after the
  one this court is on". Which court takes a game is decided when a court frees
  up.
- `computeRestStreaks`, `restHeatLevel` — counted rounds sat out. Sitting
  through one long deuce game is a longer wait than two quick ones.
- `courtFirstRound`, `courtRoundLabel` — the "late-opening court" special case.
  Every court counts its own games now, so the special case is the only case.
- `restampCourtLive`, `clearEndingSoonForChangedCourts` — took whole arrays of
  round indices because an all-courts advance could move several at once.
- `applyLockedFirstRound` — generating used to replace round 1, which *was* the
  live games. Generating now only fills the queue and cannot touch a court that
  is playing, so a lock is honoured by construction.

Their tests assert they stay gone. Bringing any of them back means the round
model has crept in again.

## Tests

`scripts/test-game-queue.js` is new and holds the core: the skip rule, taking a
game, the undo, the collapse of an old night, and waiting in minutes. Proved by
planting a bug (removing the `exceptCourt` guard from `liveCourtIds`) and
watching two assertions go red.

Rewritten for the new model: `test-next-up.js`, `test-rest-streaks.js`,
`test-auto-fill.js`, `test-court-games.js`, `test-arena-data.js`, plus smaller
updates to `test-court-cards.js`, `test-ending-soon.js`, `test-pair-warnings.js`,
`test-court-bench.js` and `test-payments-ui.js`.

## Things found on the way

- **A court's own four must not block its next game.** They are walking off.
  Without the `exceptCourt` argument to `liveCourtIds`, a court could never be
  handed a game containing anybody who had just been on it.
- **`.q-why` used `flex-basis:100%` in a non-wrapping row.** `.round-row-header`
  is `nowrap`, and a 100%-basis child there does not move to a new line, it
  squeezes its siblings — collapsing `.rsummary` (which has `min-width:0`) to
  zero width. The queue showed a badge and a reason with no match between them.
  Found by looking at it in the browser, not by a test.
- **`verify-redesign` check (g) scans the raw file**, comments included, so a
  comment that quotes the rule it is explaining trips the rule.
- **`test-knockout-ui.js` has a flaky assertion**, unrelated to this work: it
  substring-searches the whole public JSON blob for `'5511'`, which can appear
  by chance inside a 13-digit timestamp. Seen failing once, then passing four
  runs in a row on the same tree.

## Still open

`publicProjection` in `api/state.js` does not strip `sessions`, so the 2-second
public poll ships up to 31 days of past nights to every hall screen and phone.
It was left alone deliberately: the admin reads `state.sessions` from that same
public poll, so stripping it needs the session history panel moved onto
`adminGetOps` first. Worth doing, but it is its own change.
