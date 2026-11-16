#!/usr/bin/env node
/*
 * test-admin-audit.js — regression guards for the 2026-11-10 admin audit
 * (Session, Courts, Payments, Accounts). Each block names the bug it locks down.
 * Pure helpers are pulled out of public/index.html by brace matching, the same
 * way the other suites do it; server pieces are required directly.
 * Exit 0 = green.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function extractFn(name, src) {
  for (const sig of [`async function ${name}(`, `function ${name}(`]) {
    const start = src.indexOf(sig);
    if (start === -1) continue;
    const braceOpen = src.indexOf('{', src.indexOf(')', start));
    let depth = 0;
    for (let i = braceOpen; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('missing function ' + name);
}
function loadFns(names, prelude) {
  const parts = names.map(n => extractFn(n, html));
  // eslint-disable-next-line no-new-func
  return new Function(`${prelude || ''}\n${parts.join('\n')}\nreturn {${names.join(',')}};`)();
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log('  FAIL  ' + name); } };

const COURT_STATUSES = (html.match(/const COURT_STATUSES = \[[^\]]*\];/) || [''])[0];
const C = loadFns([
  'gameIds', 'queueCourtOf', 'lastEndOnCourt', 'waitMinutes',
  'normalizeCourtNumbers', 'normalizeEndingSoon', 'normalizeCourtStatus', 'normalizeCourtLocks',
  'normalizeCourtLive', 'setCourtLiveAt', 'normalizeCourtWinner', 'setCourtWinnerAt', 'normalizeCourtGameBase',
  'applyCourtDrop', 'padRoundsToCourts', 'applyActiveCourts',
  'setCourtStatusAt', 'clearEndingSoonForCourt', 'liveCourtIds', 'gameReadiness', 'laneOf', 'nextInLane',
  'oneNextPerCourt', 'lastPlayedIndex', 'liveBoardRow', 'historicGamesOf', 'takeNextGame',
], COURT_STATUSES + '\nconst MAX_GAME_NUMBER = 99;');

// ── Courts: dropping a court shifts queue + played with it ───────────
{
  const g = (court, t1, t2, extra) => Object.assign({ id: 'g' + Math.random(), court, team1: t1, team2: t2 }, extra || {});
  const s = {
    numCourts: 3, courtRounds: [0, 0, 0],
    rounds: [{ courts: [
      { team1: ['a', 'b'], team2: ['c', 'd'] },
      { team1: ['e', 'f'], team2: ['g', 'h'] },
      { team1: ['i', 'j'], team2: ['k', 'l'] },
    ] }],
    queue: [g(0, ['q0', ''], ['', '']), g(1, ['q1', ''], ['', '']), g(2, ['q2', ''], ['', ''])],
    played: [g(0, ['a', 'b'], ['c', 'd'], { endedAt: 5 }), g(1, ['e', 'f'], ['g', 'h'], { endedAt: 6 }), g(2, ['i', 'j'], ['k', 'l'], { endedAt: 7 }), g(2, ['i', 'j'], ['k', 'l'], { endedAt: 8 })],
    courtLive: [0, 1000, 0],
  };
  const out = C.applyCourtDrop(s, 1, 9000);
  const laneOfQ = c => out.queue.filter(x => x.court === c).map(x => x.team1[0]);
  check('drop: court 1 keeps its own queue', laneOfQ(0).join() === 'q0');
  check('drop: the court that moves into slot 1 brings ITS queue (was court 2)', laneOfQ(1).join() === 'q2');
  check('drop: the dropped court\'s queue is parked past every live slot', out.queue.find(x => x.team1[0] === 'q1').court >= out.numCourts);
  const countOn = c => out.played.filter(x => x.court === c).length;
  check('drop: the moved court keeps its own game count', countOn(1) === 2);
  const rec = out.played.find(x => x.endedAt === 9000);
  check('drop: the game still on the dropped court is recorded, not lost', rec && rec.team1.join() === 'e,f' && rec.startedAt === 1000);
  check('drop: rounds lose the dropped court', out.rounds[0].courts.length === 2 && out.rounds[0].courts[1].team1[0] === 'i');
  check('drop: input untouched', s.queue[1].court === 1 && s.played.length === 4);
}

// ── Courts: Active courts keeps games on their physical court ────────
{
  const live = (a) => ({ team1: [a + '1', a + '2'], team2: [a + '3', a + '4'] });
  const base = () => ({
    numCourts: 2, courtNumbers: [3, 4], courtRounds: [0, 0],
    rounds: [{ courts: [live('c3'), live('c4')] }],
    queue: [{ id: 'q3', court: 0, team1: ['x', ''], team2: ['', ''] }, { id: 'q4', court: 1, team1: ['y', ''], team2: ['', ''] }],
    played: [], courtStatus: ['live', 'final'],
  });
  const at = (o, num) => o.courtNumbers.indexOf(num);
  // Tick 2 on a 3 & 4 night: 3 and 4 keep their games, 2 is added.
  let s = base();
  let out = C.applyActiveCourts(s, [2, 3, 4], 1);
  let m = Object.assign({}, s, out);
  check('active courts: adding court 2 keeps Court 3\'s game on Court 3', m.rounds[0].courts[at(m, 3)].team1[0] === 'c31');
  check('active courts: …and Court 4\'s on Court 4', m.rounds[0].courts[at(m, 4)].team1[0] === 'c41');
  check('active courts: the new court starts empty', m.rounds[0].courts[at(m, 2)].team1.join('') === '');
  check('active courts: queues stay with their court', m.queue.find(q => q.id === 'q4').court === at(m, 4));
  check('active courts: flags stay with their court', C.normalizeCourtStatus(m.courtStatus, m.numCourts)[at(m, 4)] === 'final');
  // A swapped order ([4,3] from the card chips) survives a Save with nothing changed.
  s = base(); s.courtNumbers = [4, 3];
  check('active courts: re-saving the same courts changes nothing', C.applyActiveCourts(s, [3, 4], 1) === null);
  // Unticking a court parks its queue and records its game; the other is untouched.
  s = base();
  out = C.applyActiveCourts(s, [4], 5);
  m = Object.assign({}, s, out);
  check('active courts: unticking court 3 leaves court 4 with its own game', m.numCourts === 1 && m.courtNumbers.join() === '4' && m.rounds[0].courts[0].team1[0] === 'c41');
  check('active courts: court 3\'s game is recorded', m.played.some(g => g.team1[0] === 'c31' && g.endedAt === 5));
  check('active courts: court 3\'s queue is parked, not handed to court 4', m.queue.find(q => q.id === 'q3').court >= 1 && m.queue.find(q => q.id === 'q4').court === 0);
  // Ticking court 3 back on returns its parked queue to it.
  out = C.applyActiveCourts(m, [3, 4], 7);
  const m2 = Object.assign({}, m, out);
  check('active courts: re-ticking court 3 brings its queue back to court 3', m2.queue.find(q => q.id === 'q3').court === m2.courtNumbers.indexOf(3)
    && m2.queue.find(q => q.id === 'q3').parkedFrom === undefined);
  // Swapping both courts for two new ones works even though every old court goes.
  s = base();
  out = C.applyActiveCourts(s, [1, 2], 5);
  m = Object.assign({}, s, out);
  check('active courts: 3 & 4 → 1 & 2 swaps the whole set', m.numCourts === 2 && m.courtNumbers.join() === '1,2');
}

// ── Courts: Put on court / Previous ──────────────────────────────────
{
  const players = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => ({ id }));
  const base = () => ({
    numCourts: 2, courtRounds: [0, 0], players,
    rounds: [{ courts: [{ team1: ['a', 'b'], team2: ['c', 'd'] }, { team1: ['', ''], team2: ['', ''] }] }],
    queue: [{ id: 'blank', court: 1, team1: ['', ''], team2: ['', ''] }, { id: 'q0', court: 0, team1: ['e', 'f'], team2: ['g', 'gone'] }],
    played: [], courtStatus: ['final', 'live'], endingSoon: [true, false], courtLive: [0, 0],
  });
  let r = C.takeNextGame(base(), 1, 100);
  check('next: a queued game with no names is refused, not put on', r && r.blank === true);
  r = C.takeNextGame(base(), 0, 100);
  check('next: a player no longer here tonight goes on as an empty seat', r.rounds[0].courts[0].team2.join() === 'g,');
  check('next: the new game is Live even if the last was marked Final', r.courtStatus[0] === 'live');
  check('next: ending soon is cleared for that court in the same save', r.endingSoon[0] === false);
  // A lane saved as a whole queue goes on one game at a time, and the rest go:
  // after Put on court the court's Next game is empty, not the old second game.
  const multi = base();
  multi.queue = [...multi.queue, { id: 'q0b', court: 0, team1: ['h', 'e'], team2: ['f', 'g'] }];
  r = C.takeNextGame(Object.assign({}, multi, { queue: C.oneNextPerCourt(multi.queue) }), 0, 100);
  check('put on court: an old multi-game lane leaves nothing queued behind it', C.laneOf(r.queue, 0).length === 0);
  check('put on court: other courts keep their own next game', C.laneOf(r.queue, 1).length === 1);
  check('put on court: the game that was on becomes that court\'s Previous',
    r.played[C.lastPlayedIndex(r.played, 0)].team1.join() === 'a,b');
  check('previous: a court with nothing finished has none', C.lastPlayedIndex(base().played, 1) === -1);
}

// ── Courts: wait times when no game carries a start stamp ────────────
{
  // Clocks stopped by a winner call leave startedAt 0 everywhere. The never-
  // played late arrival must still out-wait someone who has played.
  const played = [{ court: 0, team1: ['a', 'b'], team2: ['c', 'd'], startedAt: 0, endedAt: 60 * 60000 }];
  const w = C.waitMinutes(played, [{ id: 'a' }, { id: 'late' }], new Set(), 80 * 60000);
  check('waitMinutes: no start stamps → night starts at the first finish', w.a === 20 && w.late === 20);
  check('lastEndOnCourt: latest finish on that court only', C.lastEndOnCourt([{ court: 0, endedAt: 5 }, { court: 1, endedAt: 9 }, { court: 0, endedAt: 7 }], 0) === 7);
}

// ── Server: the winner call survives the played-list clean-up ────────
{
  const State = require(path.join(ROOT, 'api', 'state.js'));
  const out = State.normalizeGameList([{ id: 'x', court: 1, team1: ['a', 'b'], team2: ['c', 'd'], startedAt: 1, endedAt: 2, winner: 'blue' },
    { id: 'y', court: 0, team1: ['a', 'b'], team2: ['c', 'd'], winner: '<script>' }], 10, true);
  check('normalizeGameList keeps a red/blue winner on played games', out[0].winner === 'blue');
  check('normalizeGameList drops a junk winner', out[1].winner === undefined);
  const q = State.normalizeGameList([{ id: 'x', court: 1, team1: ['a', 'b'], team2: ['c', 'd'], winner: 'red' }], 10, false);
  check('queued games never carry a winner', q[0].winner === undefined);
}

// ── Accounts: a phone request for a member who only has a login code ──
{
  const A = require(path.join(ROOT, 'lib', 'accounts.js'));
  const state = { roster: [{ id: 'p1', name: 'Alex' }], accounts: [], audit: [] };
  A.handleAdminAccountAction(state, { action: 'adminAssignCodes' }, {});
  const codeAcc = state.accounts[0];
  // A pending phone request, shaped like doRegister makes it.
  state.accounts.push({ id: 'acc_req', v: 2, phone: '60123456789', phoneDisplay: '012-345 6789', status: 'pending',
    pwHash: 'h', pwSalt: 's', pwEnc: 'e', playerId: null, name: 'Alex', requestedAt: 5 });
  const r = A.handleAdminAccountAction(state, { action: 'adminApproveAccount', id: 'acc_req', playerId: 'p1' }, {});
  check('approve: a request for a code-only member is folded into their account', r.status === 200 && r.body.merged === true);
  check('approve: one account left, with the code AND the phone', state.accounts.length === 1 && state.accounts[0].id === codeAcc.id
    && state.accounts[0].code && state.accounts[0].phone === '60123456789' && state.accounts[0].pwHash === 'h' && state.accounts[0].status === 'active');
  // A second request for the same player now hits a real phone account: refused.
  state.accounts.push({ id: 'acc_req2', v: 2, phone: '60199999999', status: 'pending', pwHash: 'h2', playerId: null, name: 'Alex' });
  const r2 = A.handleAdminAccountAction(state, { action: 'adminApproveAccount', id: 'acc_req2', playerId: 'p1' }, {});
  check('approve: a player who already has a phone account is still refused', r2.status === 409);
  // Revealing with a mistyped admin password is 403, so the client keeps the admin signed in.
  const rv = A.handleAdminAccountAction(state, { action: 'adminRevealPassword', id: codeAcc.id, confirmPassword: 'nope' }, { adminPassword: 'TZH123' });
  check('reveal: a mistyped confirmation is 403, never 401', rv.status === 403);
  // Changing a code ends the old code's sessions.
  state.accounts[0].token = 'tok';
  A.handleAdminAccountAction(state, { action: 'adminSetCode', id: codeAcc.id, code: 'Alex#999' }, {});
  check('code change signs out the old code', state.accounts[0].token == null);
  check('names with markup are refused', A.validateName('x" onload="1').ok === false && A.validateName("O'Brien").ok === true);
  check('a photo must be ALL base64', A.validatePhoto('data:image/png;base64,AAAA" onerror="x').ok === false);
}

// ── Payments helpers ─────────────────────────────────────────────────
{
  const P = require(path.join(ROOT, 'public', 'payments.js'));
  const rec = (paid, fee) => ({ paid, payment: { fee, tier: '3h', method: paid ? 'cash' : null, paidAt: paid ? 1 : null } });
  const day = { entries: { a: Object.assign(rec(false, 0), { playerId: 'a', name: 'A' }), b: Object.assign(rec(false, 25), { playerId: 'b', name: 'B' }) } };
  check('RM0 owes nothing', P.owes(day.entries.a) === false && P.owes(day.entries.b) === true);
  check('RM0 is not counted Unpaid', P.summarize(day.entries).unpaid === 1);
  check('RM0 alone never keeps a night open', P.dayHasOutstanding({ entries: { a: day.entries.a } }) === false);
  check('By member agrees: RM0 is settled', P.memberSummary({ '2026-11-09': { entries: { a: day.entries.a } } }, 'a', 'A').unpaidCount === 0);
  // The tab opens on last week's debt, not on one from months ago.
  const att = { '2026-08-01': { entries: { b: day.entries.b } }, '2026-11-06': { entries: { a: Object.assign(rec(true, 25), { playerId: 'a' }) } } };
  check('nightToOpen ignores debts older than a week', P.nightToOpen(att, '2026-11-10') === '2026-11-10');
  check('nightToOpen still opens on a recent debt', P.nightToOpen({ '2026-11-08': { entries: { b: day.entries.b } } }, '2026-11-10') === '2026-11-08');
  // A mis-tap fixed within minutes keeps the original paid time (draw eligibility).
  let e = { paid: true, payment: { fee: 25, tier: '3h', method: 'cash', paidAt: 1000, markedBy: 'admin' } };
  e = P.applyPaid(e, false, 60000, 'admin');
  check('re-marking paid within minutes keeps the first paid time', P.applyPaid(e, true, 120000, 'admin').payment.paidAt === 1000);
  check('re-marking much later stamps a new time', P.applyPaid(e, true, 60000 + 11 * 60000, 'admin').payment.paidAt === 60000 + 11 * 60000);
}

// ── Phones, codes, night ────────────────────────────────────────────
{
  const Ph = require(path.join(ROOT, 'public', 'phone.js'));
  check('phone: +60 012-… (trunk 0 kept) is accepted', Ph.normalizeMalaysianPhone('+60 012-345 6789').canonical === '60123456789');
  check('phone: 0060 12-… is accepted', Ph.normalizeMalaysianPhone('0060 12-345 6789').canonical === '60123456789');
  const A = require(path.join(ROOT, 'lib', 'accounts.js'));
  check('code: Harvey-Ng#123 saves like sign-in reads it', A.validateCode('Harvey-Ng#123').value === 'HarveyNg#123');
  const N = require(path.join(ROOT, 'public', 'night.js'));
  // Sunday 20:15 MYT with the session still on Friday: the cron is late.
  const sun2015 = Date.UTC(2026, 10, 8, 12, 15);
  check('Start tonight is offered while the 20:00 cron is late', N.canStartTonight('2026-11-06', sun2015) === true);
}

// ── Server: sign-up phones never reach the public poll ───────────────
{
  const State = require(path.join(ROOT, 'api', 'state.js'));
  const pub = State.publicProjection({ signups: [{ name: 'X', phone: '0123456789', dates: [] }], roster: [], accounts: [] });
  check('public state carries no sign-ups', pub.signups === undefined);
  const html2 = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  check('the admin poll asks for them with its key', /'X-Admin-Key': pwd/.test(html2));
}

console.log(`admin audit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
