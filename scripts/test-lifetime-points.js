#!/usr/bin/env node
/* test-lifetime-points — the permanent, admin-only points ledger (2026-09-12).
 *
 * Two rules, and they pull in opposite directions:
 *   1. Monthly points reset to 0 for EVERYONE at month close — whether or not
 *      they reached the threshold, whether or not they won. That is the Monthly
 *      draw's premise (ML.closeIfDue).
 *   2. `state.lifetimePoints` is the running total of everything a player has
 *      ever earned. The month close must never touch it, and it must never
 *      leave the server without the admin password.
 *
 * It lives OFF the roster entries on purpose: the client posts its whole roster
 * copy back for name/level/photo edits, so a field there would be clobbered by
 * any stale copy. These tests pin both the arithmetic and that isolation. */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'state.js'), 'utf8');
const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const S = require('../api/state.js');
const ML = require('../public/monthly-lucky.js');
const Member = require('../lib/member.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
function extractFn(name, s) {
  const start = s.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = s.indexOf('{', start);
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') d++;
    else if (s[i] === '}') { d--; if (d === 0) return s.slice(start, i + 1); }
  }
  return null;
}
const fn = (n) => extractFn(n, html) || '';
const A = S.addLifetimePoints, E = S.ensureLifetimePoints, L = S.lifetimeOf;

// ── lifetimeOf: a tolerant reader ──
check('reads a stored total', L({ r1: 42 }, 'r1') === 42);
check('an unknown player reads 0', L({ r1: 42 }, 'r2') === 0);
check('a missing map reads 0', L(null, 'r1') === 0 && L(undefined, 'r1') === 0 && L([], 'r1') === 0);
check('junk and negatives read 0, never NaN', L({ r1: 'abc' }, 'r1') === 0 && L({ r1: -5 }, 'r1') === 0 && L({ r1: null }, 'r1') === 0);
check('a fractional stored value floors', L({ r1: 7.9 }, 'r1') === 7);
check('a stored value past the cap reads as the cap', L({ r1: S.MAX_LIFETIME_POINTS + 500 }, 'r1') === S.MAX_LIFETIME_POINTS);

// ── addLifetimePoints: the only way the number moves ──
check('a positive delta adds', A({ r1: 10 }, 'r1', 2).r1 === 12);
check('a first credit creates the entry', A({}, 'r1', 2).r1 === 2);
check('a negative delta subtracts (a mis-typed award can be taken back)', A({ r1: 10 }, 'r1', -4).r1 === 6);
check('a negative delta clamps at zero, never below', A({ r1: 3 }, 'r1', -99).r1 === 0);
check('a delta clamps at the cap', A({ r1: 10 }, 'r1', S.MAX_LIFETIME_POINTS).r1 === S.MAX_LIFETIME_POINTS);
check('a zero delta is a no-op that returns the SAME map', (() => { const m = { r1: 10 }; return A(m, 'r1', 0) === m; })());
check('junk deltas are refused, not coerced', (() => {
  const m = { r1: 10 };
  return A(m, 'r1', 'abc') === m && A(m, 'r1', true) === m && A(m, 'r1', []) === m && A(m, 'r1', NaN) === m;
})());
check('a missing player id is a no-op', (() => { const m = { r1: 10 }; return A(m, '', 5) === m && A(m, null, 5) === m; })());
check('it never mutates the map it is given', (() => { const m = { r1: 10 }; A(m, 'r1', 5); return m.r1 === 10; })());
check('other players are untouched', (() => { const n = A({ r1: 10, r2: 4 }, 'r1', 5); return n.r2 === 4; })());
check('a missing map is handled, not crashed on', A(null, 'r1', 3).r1 === 3 && A(undefined, 'r1', 3).r1 === 3);

// ── ensureLifetimePoints: seeding an existing deployment ──
check('seeds from what everyone holds right now', (() => {
  const s = { roster: [{ id: 'r1', points: 25 }, { id: 'r2', points: 4 }] };
  E(s);
  return s.lifetimePoints.r1 === 25 && s.lifetimePoints.r2 === 4;
})());
check('adds every closed-month snapshot we still keep (they are disjoint from the live total)', (() => {
  const s = {
    roster: [{ id: 'r1', points: 25 }],
    monthlyLucky: { closed: { '2026-07': { points: { r1: 80 } }, '2026-08': { points: { r1: 60 } } } },
  };
  E(s);
  return s.lifetimePoints.r1 === 165;
})());
check('a player who only appears in a snapshot still gets a total', (() => {
  const s = { roster: [], monthlyLucky: { closed: { '2026-08': { points: { gone: 30 } } } } };
  E(s);
  return s.lifetimePoints.gone === 30;
})());
check('an EXISTING map is never re-seeded — real totals survive a later read', (() => {
  const s = { roster: [{ id: 'r1', points: 25 }], lifetimePoints: { r1: 500 } };
  E(s);
  return s.lifetimePoints.r1 === 500;
})());
check('an existing map has its junk values coerced to 0', (() => {
  const s = { lifetimePoints: { r1: 'abc', r2: -9, r3: 12.7 } };
  E(s);
  return s.lifetimePoints.r1 === 0 && s.lifetimePoints.r2 === 0 && s.lifetimePoints.r3 === 12;
})());
check('a non-object lifetimePoints (array / string / null) is replaced by a seed', (() => {
  const s = { roster: [{ id: 'r1', points: 7 }], lifetimePoints: [1, 2] };
  E(s);
  return !Array.isArray(s.lifetimePoints) && s.lifetimePoints.r1 === 7;
})());
check('an empty / missing blob is handled, not crashed on', (() => {
  const s = {}; E(s);
  return s.lifetimePoints && Object.keys(s.lifetimePoints).length === 0 && Object.keys(E(null)).length === 0;
})());
check('the seed is capped like everything else', (() => {
  const s = { roster: [{ id: 'r1', points: S.MAX_LIFETIME_POINTS }], monthlyLucky: { closed: { '2026-08': { points: { r1: 999 } } } } };
  E(s);
  return s.lifetimePoints.r1 === S.MAX_LIFETIME_POINTS;
})());

// ── the +2 a session lands on BOTH totals ──
const SESSION_STATE = () => ({
  roster: [{ id: 'r1', name: 'Alex', points: 10 }, { id: 'r2', name: 'Bea', points: 0 }, { id: 'r3', name: 'Cy', points: 5 }],
  players: [{ id: 'r1' }, { id: 'r2' }, { id: 'g1', guest: true }],
  awardedSessions: [],
  lifetimePoints: { r1: 100, r2: 0, r3: 40 },
});
check('everyone who played gains +2 lifetime as well as +2 monthly', (() => {
  const a = S.awardSessionPoints(SESSION_STATE(), '2026-09-12');
  return a.lifetimePoints.r1 === 102 && a.lifetimePoints.r2 === 2;
})());
check('a player who sat out gains neither', (() => {
  const a = S.awardSessionPoints(SESSION_STATE(), '2026-09-12');
  return a.lifetimePoints.r3 === 40 && a.roster.find(r => r.id === 'r3').points === 5;
})());
check('guests earn nothing — they are not on the roster', (() => {
  const a = S.awardSessionPoints(SESSION_STATE(), '2026-09-12');
  return a.lifetimePoints.g1 === undefined;
})());
check('an already-awarded night pays out once, not twice', (() => {
  const s = SESSION_STATE(); s.awardedSessions = ['2026-09-12'];
  const a = S.awardSessionPoints(s, '2026-09-12');
  return a.lifetimePoints === s.lifetimePoints;
})());
check('a night nobody on the roster played changes nothing', (() => {
  const s = SESSION_STATE(); s.players = [{ id: 'g1', guest: true }];
  return S.awardSessionPoints(s, '2026-09-12').lifetimePoints === s.lifetimePoints;
})());
check('the award never mutates the map it was given', (() => {
  const s = SESSION_STATE();
  S.awardSessionPoints(s, '2026-09-12');
  return s.lifetimePoints.r1 === 100;
})());
check('a blob with no ledger yet still awards (starts from zero)', (() => {
  const s = SESSION_STATE(); delete s.lifetimePoints;
  return S.awardSessionPoints(s, '2026-09-12').lifetimePoints.r1 === 2;
})());
check('closing the day carries the new ledger onto the state', (() => {
  const s = Object.assign(SESSION_STATE(), { sessionDate: '2026-09-12', sessions: {} });
  const t = S.applySessionDateChange(s, '2026-09-15', '2026-09-15');
  return t.ok && t.state.lifetimePoints.r1 === 102;
})());

// ── THE POINT OF THE FEATURE: month close resets one total, not the other ──
check('month close zeroes every roster total — reached the threshold or not', (() => {
  const s = {
    roster: [{ id: 'r1', points: 100 }, { id: 'r2', points: 12 }],
    monthlyLucky: { pointsMonth: '2026-08', closed: {} },
  };
  const r = ML.closeIfDue(s, '2026-09-01', 1);
  return r.changed && r.state.roster.every(p => p.points === 0);
})());
check('month close leaves the lifetime ledger exactly as it was', (() => {
  const s = {
    roster: [{ id: 'r1', points: 100 }, { id: 'r2', points: 12 }],
    lifetimePoints: { r1: 340, r2: 12 },
    monthlyLucky: { pointsMonth: '2026-08', closed: {} },
  };
  const r = ML.closeIfDue(s, '2026-09-01', 1);
  return r.state.lifetimePoints.r1 === 340 && r.state.lifetimePoints.r2 === 12;
})());
check('a month closed BEFORE the ledger existed is not lost — the snapshot seeds it', (() => {
  const s = { roster: [{ id: 'r1', points: 100 }], monthlyLucky: { pointsMonth: '2026-08', closed: {} } };
  const closed = ML.closeIfDue(s, '2026-09-01', 1).state;
  E(closed);                                   // first sight of the ledger is AFTER the reset
  return closed.roster[0].points === 0 && closed.lifetimePoints.r1 === 100;
})());

// ── it never leaves the server without the admin password ──
const FULL = () => ({
  roster: [{ id: 'r1', name: 'Alex', points: 10 }],
  accounts: [{ id: 'a1' }], attendance: { '2026-09-12': {} }, audit: [{ action: 'x' }],
  lifetimePoints: { r1: 400 },
});
check('publicProjection strips the ledger', S.publicProjection(FULL()).lifetimePoints === undefined);
check('publicProjection still returns the roster (only the ledger is private)', (() => {
  const p = S.publicProjection(FULL());
  return Array.isArray(p.roster) && p.roster[0].points === 10;
})());
check('the ledger is not smuggled onto the roster entries', (() => {
  const p = S.publicProjection(FULL());
  return p.roster[0].lifetimePoints === undefined && p.roster[0].lifetime === undefined;
})());
check('the admin auth ping strips it too — adminGetOps is the single source', /function liteMonthlyLucky[\s\S]{0,260}const \{ lifetimePoints, \.\.\.rest \} = s \|\| \{\};/.test(src));
check("a member's own page never carries a lifetime figure", (() => {
  const info = Member.buildMemberInfo(FULL(), { id: 'a1', playerId: 'r1', name: 'Alex' }, {});
  return JSON.stringify(info).indexOf('lifetime') === -1 && info.points.points === 10;
})());
check('adminGetOps returns it (api + local dev server)', src.includes('lifetimePoints: state.lifetimePoints || {}') && srv.includes('lifetimePoints: state.lifetimePoints || {}'));

// ── it can never be written by a client ──
check('the generic merge refuses a lifetimePoints key (api + local dev server)', (() => {
  const re = /if \(updates\.lifetimePoints !== undefined\) \{\s*return res\.status\(400\)\.json\(\{ error: 'Lifetime points are kept by the server\.' \}\);/;
  return re.test(src) && re.test(srv);
})());
check('the refusal is checked before the merge writes state', src.indexOf('updates.lifetimePoints !== undefined') < src.indexOf('state = { ...state, ...updates };'));
check('the ledger is seeded once, before any admin branch can credit points', (() => {
  const seed = src.indexOf('ensureLifetimePoints(state);\n\n    // Auth-only ping');
  return seed !== -1 && seed < src.indexOf("updates.action === 'setRosterPoints'");
})());
check('the crons seed it before the day close and before the month close', (() => {
  const roll = extractFn('rolloverSessionDate', src) || '';
  const sweep = extractFn('runMonthlyDrawSweep', src) || '';
  return roll.indexOf('ensureLifetimePoints(state)') !== -1 && roll.indexOf('ensureLifetimePoints(state)') < roll.indexOf('applySessionDateChange')
    && sweep.indexOf('ensureLifetimePoints(state)') !== -1 && sweep.indexOf('ensureLifetimePoints(state)') < sweep.indexOf('applyMonthClose');
})());
check('the roster default carries a points field but no lifetime field', !/DEFAULT_ROSTER[\s\S]{0,900}lifetime/.test(src));

// ── setRosterPoints moves both numbers by the same signed amount ──
check('a manual award adds the same amount to the lifetime total', (() => {
  const re = /state\.lifetimePoints = addLifetimePoints\(state\.lifetimePoints, built\.player\.id, built\.next - built\.prev\);/;
  return re.test(src) && re.test(srv);
})());
check('a no-op edit moves neither', src.includes('if (built.prev !== built.next) {'));
check('the response hands the new lifetime total back to the client', src.includes('lifetime: lifetimeOf(state.lifetimePoints, built.player.id)'));

// ── client ──
check('the ops cache starts with lifetimePoints null — "not fetched", not zero', html.includes("let adminOps = { attendance: {}, drawSettings: null, monthlyEligibility: null, audit: [], lifetimePoints: null };"));
check('loadAdminOps stores what the server sent', fn('loadAdminOps').includes('lifetimePoints: res.lifetimePoints || {}'));
check('an unfetched ledger renders an em-dash, not a wrong 0', (() => {
  const f = fn('lifetimePointsFor'), l = fn('lifetimePointsLabel');
  return f.includes('if (!lifetimePointsLoaded()) return null;') && l.includes("n === null ? '&mdash;'");
})());
check('a missing / junk entry reads 0', fn('lifetimePointsFor').includes('Number.isFinite(n) && n > 0 ? Math.floor(n) : 0'));
check('opening the Session tab fetches the ledger and repaints the list', html.includes("if (name === 'session') loadAdminOps().then(() => { renderPlayersSection(); renderEodStatus(); updateAdminNavBadges(); });"));
check('showAdmin does not fetch the ops cache twice for the Session tab', html.includes("currentAdminTab !== 'payments' && currentAdminTab !== 'courts' && currentAdminTab !== 'session'"));
check('a points edit updates the cached lifetime total in place', fn('writePlayerPoints').includes("if (typeof r.lifetime === 'number' && lifetimePointsLoaded()) adminOps.lifetimePoints[id] = r.lifetime;"));

// ── client: the Grid card no longer bypasses the ledger ──
check('the Grid card steppers go through the audited action, not a whole-roster POST', (() => {
  const a = fn('adjustPoints'), p = fn('setPoints');
  return a.includes('await bumpPlayerPoints(id, delta);') && !a.includes('apiPost({ roster })')
    && p.includes('await setPlayerPoints(id, n);') && !p.includes('apiPost({ roster })');
})());

// ── client: markup ──
const row = fn('renderRosterList');
check('the List view has a read-only Life cell per player', row.includes('class="rl-life"') && row.includes('class="rl-life-n">${lifetimePointsLabel(rp.id)}'));
check('the Life cell has no input and no click handler — it is a record, not a setting', (() => {
  const cell = row.slice(row.indexOf('class="rl-life"'), row.indexOf('class="rl-more"'));
  return !/<input/.test(cell) && !/onclick=/.test(cell);
})());
check('the Life cell is labelled and explained on hover', row.includes('aria-label="Lifetime points for ${escHtml(rp.name)}"') && row.includes('never reset at the end of the month. Admin only.'));
check('the header row gained a Life column between Mixed and Pts', row.includes('<span>Mixed</span><span>Life</span><span>Pts</span>'));
check('the desktop grid has six columns', html.includes('.rl-head,.rl-row{display:grid;grid-template-columns:1fr auto 52px 72px 64px 108px;'));
check('Life and Pts are both right-aligned in the header', html.includes('.rl-head span:nth-child(5),.rl-head span:nth-child(6){text-align:right}'));
check('phone: Life folds into the drawer with the other attributes, Pts stays on the row', (() => {
  return html.includes('.rl-head span:nth-child(2),.rl-head span:nth-child(3),.rl-head span:nth-child(4),.rl-head span:nth-child(5){display:none}')
    && html.includes('.rl-head span:nth-child(6){grid-column:3}')
    && html.includes('.rl-row.open .rl-life{grid-area:5/1/auto/-1;padding-bottom:4px}')
    && html.includes(".rl-life::before{content:'Lifetime points'}");
})());
check('the phone drawer hint names the lifetime figure', row.includes('title="Tap for level, girl, mixed and lifetime points"'));

// ── client: the other two admin surfaces ──
check('the Payments member popup shows Points · Lifetime · Outstanding', (() => {
  const m = fn('renderPmMemberModal');
  return m.includes("<b>' + lifetimePointsLabel(pmMemPid) + '</b><span>Lifetime</span>") && m.indexOf('Lifetime') < m.indexOf('Outstanding');
})());
check('the hero grid is three across', html.includes('.pm-mem-hero{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));'));
check('an Accounts row shows the lifetime total next to the monthly one', fn('acctFinanceHtml').includes('Lifetime <b>${lifetimePointsLabel(a.playerId)}</b>'));

// ── help text ──
check('the Session help explains the reset and who can see the lifetime total', (() => {
  const i = html.indexOf('<summary>Session</summary>');
  const sec = html.slice(i, i + 1400);
  return /goes back to zero for <b>everyone<\/b>/.test(sec) && /Members never see it/.test(sec);
})());
check('the Monthly draw help says the reset hits everyone', (() => {
  const i = html.indexOf('<summary>Lucky Draw &mdash; Monthly draws</summary>');
  return /zero for <b>everyone<\/b> when the month ends/.test(html.slice(i, i + 900));
})());

console.log(`\ntest-lifetime-points: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
