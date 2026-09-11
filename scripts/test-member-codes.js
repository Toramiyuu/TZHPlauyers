#!/usr/bin/env node
/* test-member-codes — login codes (api/accounts.js) + the member page payload
 * (api/member.js). 2026-09: the organiser pre-assigns every roster player a code
 * like "HarveyNg#123"; typing it signs the member in and shows their points,
 * what they owe and their draw wins. Covers: code helpers, assign-all (idempotent,
 * creates accounts), set/clear, lenient matching, the shared-name cooldown, status
 * gating, and wins gathered from all four draw records. */
'use strict';
const A = require('../api/accounts.js');
const M = require('../api/member.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

function freshState() {
  return {
    roster: [
      { id: 'p0', name: 'Harvey Ng', photo: null, points: 12 },
      { id: 'p1', name: 'Ah Sheng', photo: null, points: 95 },
      { id: 'p2', name: 'Harvey', photo: null, points: 0 },
    ],
    accounts: [], audit: [], attendance: {},
    monthlyLucky: { auto: true, winners: 3, threshold: 80, prizes: [{ id: 'pz1', name: 'Racket bag' }], pointsMonth: '2026-09', pool: null, closed: {} },
    monthlyDraw: { month: '2026-09', prizes: [], participants: [], results: [], spin: null, history: [] },
    luckyDraw: { entries: [], paid: [], drawDate: '2026-09-08', spin: null, results: [], history: [] },
  };
}
const admin = (s, body) => A.handleAdminAccountAction(s, body, { adminPassword: 'TZH123' });
const login = (s, code, nowMs) => A.handleAccountAction(s, { action: 'loginCode', code }, { nowMs });

// ── helpers ──
check('codeNameOf drops spaces/punctuation, keeps letters', A.codeNameOf('Harvey Ng') === 'HarveyNg' && A.codeNameOf('Ah Sheng') === 'AhSheng' && A.codeNameOf("O'Neil-2") === 'ONeil');
check('codeNameOf falls back for empty names and caps length', A.codeNameOf('') === 'Member' && A.codeNameOf('a'.repeat(40)).length === 24);
check('codeKeyOf is case/space/# insensitive', A.codeKeyOf('HarveyNg#123') === 'harveyng123' && A.codeKeyOf(' harvey ng 123 ') === 'harveyng123' && A.codeKeyOf('Harvey-Ng_123') === 'harveyng123');
check('validateCode normalises to Name#digits', A.validateCode('harvey 123').value === 'harvey#123' && A.validateCode('AhSheng#0042').ok);
check('validateCode rejects short digits, digits-first, empty', !A.validateCode('Harvey#12').ok && !A.validateCode('123Harvey').ok && !A.validateCode('').ok && !A.validateCode('Harvey#1234567').ok);
{
  const taken = new Set();
  const codes = [];
  for (let i = 0; i < 30; i++) { const c = A.makeCode('Harvey Ng', taken); taken.add(A.codeKeyOf(c)); codes.push(c); }
  check('makeCode produces Name#3digits, unique against the taken set', codes.every(c => /^HarveyNg#\d{3}$/.test(c)) && new Set(codes).size === 30);
}

// ── assign codes to everyone ──
{
  const s = freshState();
  let r = admin(s, { action: 'adminAssignCodes' });
  check('assign-all: 200, one code per roster player, accounts created', r.status === 200 && r.body.assigned === 3 && r.body.created === 3 && s.accounts.length === 3);
  check('assign-all: accounts are active, code-only, linked to their player', s.accounts.every(a => a.status === 'active' && a.source === 'code' && a.playerId && a.code && a.codeKey && !a.pwHash && a.phone === ''));
  check('assign-all: roster players carry accountId', s.roster.every(p => p.accountId));
  check('assign-all: codes are unique by key', new Set(s.accounts.map(a => a.codeKey)).size === 3);
  check('assign-all: code uses the player name', /^HarveyNg#\d{3}$/.test(s.accounts.find(a => a.playerId === 'p0').code) && /^AhSheng#\d{3}$/.test(s.accounts.find(a => a.playerId === 'p1').code));
  check('assign-all: audited without the codes themselves', s.audit.some(e => e.action === 'account.codes_assign') && !JSON.stringify(s.audit).includes(s.accounts[0].code));
  const before = s.accounts.map(a => a.code).join(',');
  r = admin(s, { action: 'adminAssignCodes' });
  check('assign-all again: idempotent (0 assigned, 3 kept, unchanged=false)', r.body.assigned === 0 && r.body.kept === 3 && r.changed === false && s.accounts.map(a => a.code).join(',') === before);
  s.roster.push({ id: 'p3', name: 'Celine', photo: null, points: 5 });
  r = admin(s, { action: 'adminAssignCodes' });
  check('assign-all after a new roster member: only the newcomer gets a code', r.body.assigned === 1 && r.body.created === 1 && /^Celine#\d{3}$/.test(s.accounts.find(a => a.playerId === 'p3').code));
  r = admin(s, { action: 'adminAssignCodes', regenerate: true, playerIds: ['p0'] });
  check('assign with regenerate + playerIds: only that player changes', r.body.assigned === 1 && s.accounts.find(a => a.playerId === 'p0').code !== before.split(',')[0]);
  check('admin list exposes code + codeUpdatedAt, never codeKey/hash', (() => { const l = admin(s, { action: 'adminListAccounts' }).body.accounts[0]; return l.code && l.codeUpdatedAt && l.codeKey === undefined && l.pwHash === undefined; })());
}

// ── phone account keeps its identity when given a code ──
{
  const s = freshState();
  const c = admin(s, { action: 'adminCreateAccount', phone: '0123456789', playerId: 'p0', newPassword: 'secret1' });
  check('setup: phone account for p0', c.status === 200);
  const r = admin(s, { action: 'adminAssignCodes' });
  check('assign-all reuses the existing phone account for p0 (no duplicate)', r.body.created === 2 && s.accounts.length === 3 && s.accounts.filter(a => a.playerId === 'p0').length === 1);
  const acc = s.accounts.find(a => a.playerId === 'p0');
  check('phone account now has a code AND its password', acc.code && acc.pwHash && acc.phone === '60123456789');
  const byCode = login(s, acc.code, 1000);
  const byPhone = A.handleAccountAction(s, { action: 'loginAccount', phone: '0123456789', password: 'secret1' });
  check('code login and phone login share one token', byCode.status === 200 && byPhone.status === 200 && byCode.body.token === byPhone.body.token);
  check('publicAccount carries code + hasPassword for the client', byCode.body.account.code === acc.code && byCode.body.account.hasPassword === true);
}

// ── set / clear one code ──
{
  const s = freshState();
  let r = admin(s, { action: 'adminSetCode', playerId: 'p1' });
  check('setCode by playerId creates the account and generates a code', r.status === 200 && /^AhSheng#\d{3}$/.test(r.body.account.code) && s.accounts.length === 1);
  const id = r.body.account.id;
  r = admin(s, { action: 'adminSetCode', id, code: 'ahsheng 007' });
  check('setCode typed: normalised to Name#digits', r.status === 200 && r.body.account.code === 'ahsheng#007');
  r = admin(s, { action: 'adminSetCode', id, code: 'Ah Sheng#12' });
  check('setCode typed: invalid format -> 400', r.status === 400);
  admin(s, { action: 'adminSetCode', playerId: 'p0', code: 'HarveyNg#123' });
  r = admin(s, { action: 'adminSetCode', id, code: 'harvey ng 123' });
  check('setCode typed: duplicate of another member (any format) -> 409', r.status === 409);
  r = admin(s, { action: 'adminSetCode', id, code: 'ahsheng#007' });
  check('setCode typed: same code again -> unchanged, no write', r.status === 200 && r.body.unchanged === true && r.changed === false);
  r = admin(s, { action: 'adminSetCode', id });
  check('setCode blank: regenerates a different code', r.status === 200 && r.body.account.code !== 'ahsheng#007' && /^AhSheng#\d{3}$/.test(r.body.account.code));
  r = admin(s, { action: 'adminClearCode', id });
  check('clearCode removes code + key', r.status === 200 && r.body.account.code === '' && s.accounts.find(a => a.id === id).codeKey === null);
  check('cleared account can no longer sign in by code', login(s, 'AhSheng#007', 1).status === 401);
  check('setCode unknown id -> 404', admin(s, { action: 'adminSetCode', id: 'nope' }).status === 404);
  check('setCode unknown player -> 400', admin(s, { action: 'adminSetCode', playerId: 'nope' }).status === 400);
}

// ── login by code ──
{
  const s = freshState();
  admin(s, { action: 'adminSetCode', playerId: 'p0', code: 'HarveyNg#123' });
  admin(s, { action: 'adminSetCode', playerId: 'p2', code: 'Harvey#456' });
  let r = login(s, 'HarveyNg#123', 1000);
  check('login: exact code -> token + account', r.status === 200 && r.body.ok && typeof r.body.token === 'string' && r.body.account.playerId === 'p0' && r.body.viaCode === true);
  const token = r.body.token;
  check('login: lenient on case, spaces and missing #', login(s, ' harvey ng 123 ', 1001).body.token === token && login(s, 'HARVEYNG#123', 1002).body.token === token);
  check('login: lastLoginAt + codeLastLoginAt stamped', s.accounts[0].lastLoginAt === 1002 && s.accounts[0].codeLastLoginAt === 1002);
  check('login: garbage -> 400', login(s, '###', 1).status === 400 && login(s, '', 1).status === 400 && login(s, '123', 1).status === 400);
  check('login: unknown name -> 401, nothing counted', login(s, 'Nobody#123', 1).status === 401 && s.accounts.every(a => !a.codeFails));
  r = login(s, 'HarveyNg#999', 2000);
  check('login: wrong digits -> 401 and counts against that name only', r.status === 401 && r.changed === true && s.accounts[0].codeFails === 1 && !s.accounts[1].codeFails);
  for (let i = 0; i < 4; i++) login(s, 'HarveyNg#00' + i, 2001 + i);
  check('login: 5 misses -> cooldown', s.accounts[0].codeFails === 5);
  r = login(s, 'HarveyNg#123', 3000);
  check('login: during cooldown even the RIGHT code is refused (429 with retryInMs)', r.status === 429 && r.body.retryInMs > 0 && /Too many attempts/.test(r.body.error));
  check('login: a different name is unaffected by the cooldown', login(s, 'Harvey#456', 3001).status === 200);
  r = login(s, 'HarveyNg#123', 3000 + A.CODE_COOLDOWN_MS);
  check('login: after the cooldown the right code works and the counter resets', r.status === 200 && s.accounts[0].codeFails === 0);
  // token/session plumbing already used by the phone flow keeps working
  const sess = A.handleAccountAction(s, { action: 'accountSession', token: r.body.token });
  check('login: accountSession validates the code-issued token', sess.status === 200 && sess.body.account.code === 'HarveyNg#123');
  // locked / suspended accounts are steered to the status screen, never signed in
  admin(s, { action: 'adminLockAccount', id: s.accounts[0].id });
  r = login(s, 'HarveyNg#123', 9e9);
  check('login: locked account -> blocked status view, no token', r.status === 200 && r.body.blocked === true && r.body.token === undefined && r.body.account.status === 'locked');
  admin(s, { action: 'adminUnlockAccount', id: s.accounts[0].id });
  check('login: unlocked again -> ok', login(s, 'HarveyNg#123', 9e9 + 1).status === 200);
}

// ── member page payload ──
{
  const s = freshState();
  admin(s, { action: 'adminSetCode', playerId: 'p0', code: 'HarveyNg#123' });
  const acc = s.accounts[0];
  s.attendance = {
    '2026-09-08': { entries: { p0: { playerId: 'p0', name: 'Harvey Ng', present: true, paid: false, payment: { fee: 25, tier: '3h', method: null, paidAt: null } } } },
    '2026-09-05': { entries: { p0: { playerId: 'p0', name: 'Harvey Ng', present: true, paid: true, payment: { fee: 20, tier: '2h', method: 'cash', paidAt: 5 } }, p1: { playerId: 'p1', name: 'Ah Sheng', present: true, paid: false, payment: { fee: 25, tier: '3h' } } } },
    '2026-09-01': { entries: { p0: { playerId: 'p0', name: 'Harvey Ng', present: true, paid: false, payment: { fee: 15, tier: '2h', feeOverridden: true } } } },
  };
  s.monthlyDraw.results = [{ rank: 1, id: 'mp2', name: 'harvey ng', prize: '1 Tube of new G2 Shuttlecock', at: 4000 }];
  s.monthlyDraw.history = [{ month: '2026-08', label: 'August 2026', at: 3000, winners: [{ rank: 2, name: 'Harvey Ng', prize: 'Premium Sports Socks' }, { rank: 1, name: 'Ah Sheng', prize: 'Tube' }] }];
  s.luckyDraw.results = [{ rank: 1, name: 'Harvey Ng', at: 2000 }];
  s.luckyDraw.history = [{ date: '2026-08-20', at: 1000, winners: [{ rank: 1, name: 'Ah Sheng' }] }];
  const drawResults = {
    '2026-09-07': { date: '2026-09-07', drawnAt: 5000, winners: ['p1', 'p0'], names: { p0: 'Harvey Ng', p1: 'Ah Sheng' } },
    '2026-09-04': { date: '2026-09-04', drawnAt: 4500, winners: ['p1'], names: { p1: 'Ah Sheng' } },
  };
  const monthlyResults = {
    '2026-08': { kind: 'monthly', month: '2026-08', label: 'August 2026', drawnAt: 6000, winners: ['p0', 'p1'], names: { p0: 'Harvey Ng', p1: 'Ah Sheng' }, prizes: [{ id: 'pz1', name: 'Racket bag' }] },
  };
  const info = M.buildMemberInfo(s, acc, { drawResults, monthlyResults, nowMs: 7000 });
  check('member: identity', info.ok && info.member.name === 'Harvey Ng' && info.member.code === 'HarveyNg#123' && info.member.hasPassword === false && info.member.onRoster === true);
  check('member: points + progress toward the Monthly draw', info.points.points === 12 && info.points.threshold === 80 && info.points.toGo === 68 && info.points.inDraw === false && info.points.month === '2026-09' && info.points.monthLabel === 'September 2026');
  check('member: owing total + nights (newest first), settled history', info.payments.outstanding === 40 && info.payments.unpaidCount === 2 && info.payments.owing.map(x => x.date).join(',') === '2026-09-08,2026-09-01' && info.payments.owing[1].feeOverridden === true && info.payments.paidTotal === 20 && info.payments.settled[0].method === 'cash');
  check('member: never includes another player\'s rows', !JSON.stringify(info.payments).includes('Ah Sheng') && !JSON.stringify(info.payments).includes('p1'));
  const kinds = info.wins.map(w => w.kind + ':' + w.at).join(' ');
  check('member: wins from all four sources, newest first', kinds === 'monthly:6000 session:5000 shuttlecock:4000 shuttlecock:3000 quick:2000');
  check('member: monthly win carries its prize by rank', info.wins[0].prize === 'Racket bag' && info.wins[0].label === 'August 2026');
  check('member: session win has date + no prize', info.wins[1].date === '2026-09-07' && info.wins[1].prize === '' && info.wins[1].rank === 2);
  check('member: shuttlecock matched by name, case-insensitive, with prize', info.wins[2].prize === '1 Tube of new G2 Shuttlecock' && info.wins[3].prize === 'Premium Sports Socks');
  check('member: quick draw matched by name', info.wins[4].title === 'Lucky draw' && info.wins[4].date === '2026-09-08');
  const other = M.buildMemberInfo(s, { id: 'x', playerId: 'p1', name: 'Ah Sheng' }, { drawResults, monthlyResults });
  check('member: the other player sees only their own wins/owing', other.wins.length === 5 && other.payments.outstanding === 25 && other.points.inDraw === true && other.points.toGo === 0);
  const nobody = M.buildMemberInfo(s, { id: 'y', playerId: 'gone', name: '' }, {});
  check('member: unlinked/empty is safe', nobody.ok && nobody.wins.length === 0 && nobody.payments.outstanding === 0 && nobody.member.onRoster === false);
}

// ── handleMemberInfo (async, token-gated, store failures tolerated) ──
(async () => {
  const s = freshState();
  admin(s, { action: 'adminSetCode', playerId: 'p0', code: 'HarveyNg#123' });
  const token = login(s, 'HarveyNg#123', 1).body.token;
  const okStore = { getAll: async () => ({ '2026-09-07': { date: '2026-09-07', drawnAt: 5, winners: ['p0'], names: { p0: 'Harvey Ng' } } }) };
  const badStore = { getAll: async () => { throw new Error('redis down'); } };
  let r = await M.handleMemberInfo(s, { token }, { drawStore: okStore, monthlyStore: badStore, nowMs: 9 });
  check('handleMemberInfo: 200 with wins from the working store, the failing one is empty', r.status === 200 && r.body.wins.length === 1 && r.body.serverTime === 9 && r.changed === false);
  r = await M.handleMemberInfo(s, { token: 'bogus' }, { drawStore: okStore, monthlyStore: okStore });
  check('handleMemberInfo: bad token -> 401', r.status === 401);
  admin(s, { action: 'adminSuspendAccount', id: s.accounts[0].id });
  r = await M.handleMemberInfo(s, { token }, {});
  check('handleMemberInfo: suspended account -> 401', r.status === 401);
  console.log(`\nmember codes: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
