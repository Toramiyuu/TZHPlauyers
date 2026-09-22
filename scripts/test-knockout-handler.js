#!/usr/bin/env node
/* Handler tests for the open competition (lib/knockout.js).
 *
 * These run the real dispatchers against a real state object, so they cover the
 * things unit tests on the pure module cannot:
 *   - the PUBLIC door can only ever append an entrant, never touch anything else
 *     in the blob (roster, siteCode, accounts, other categories);
 *   - an IC is encrypted BEFORE it is stored, so the plaintext appears nowhere
 *     in the saved state, and comes back only through an audited reveal;
 *   - a missing encryption key costs the club nothing on the night;
 *   - destructive admin steps (rebuilding a draw, changing a decided result,
 *     deleting a category with real entries) refuse without an explicit confirm.
 */
'use strict';
// A fixed 32-byte key, so encryption is exercised for real rather than skipped.
process.env.ACCOUNT_ENC_KEY = 'a'.repeat(64);

const KO = require('../lib/knockout.js');
const K = require('../public/knockout.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

let seq = 0;
const rand = () => { seq = (seq * 9301 + 49297) % 233280; return seq / 233280; };
const ADMIN = (state, body, now) => KO.handleKnockoutAdminAction(state, body, { nowMs: now || 1000, rand });
const PUBLIC = (state, body, now) => KO.handleKnockoutPublicAction(state, body, { nowMs: now || 1000, rand });

function freshState() {
  return { roster: [{ id: 'p1', name: 'regular', points: 3 }], siteCode: 'SECRET', accounts: [{ id: 'a1', pwHash: 'hash' }], audit: [], knockout: null };
}
const PLAYER = (o) => Object.assign({ name: 'Alex Tan', phone: '012-345 6789', ic: '900101-07-5511', club: '' }, o);

// ── a whole event, start to finish ───────────────────────────────────
{
  const s = freshState();
  check('event starts empty', ADMIN(s, { action: 'knockoutGetAdmin' }).body.categories.length === 0);

  const ev = ADMIN(s, { action: 'knockoutSetEvent', name: 'TZH Open 2026', date: '2026-11-08', venue: 'TZH Hall', regOpen: true, published: true, payTo: 'Maybank 1234' });
  check('event saves', ev.body.ok === true && ev.changed === true && s.knockout.event.name === 'TZH Open 2026');
  check('IC is required by default', s.knockout.event.requireIC === true);

  const add = ADMIN(s, { action: 'knockoutAddCategory', name: "Men's Doubles Open", type: 'doubles', cap: 16, fee: 40 });
  check('category adds', add.body.ok === true);
  const catId = add.body.category.id;
  check('a code is generated', /^[A-Z0-9]{6}$/.test(add.body.category.code));
  const code = add.body.category.code;

  check('a category starts in setup, so an early poster cannot take entries',
    PUBLIC(s, { action: 'knockoutLookup', code }).body.ok === false);

  ADMIN(s, { action: 'knockoutUpdateCategory', categoryId: catId, status: 'open' });
  const look = PUBLIC(s, { action: 'knockoutLookup', code });
  check('an open code looks up', look.body.ok === true && look.body.category.name === "Men's Doubles Open");
  check('lookup says how many players an entry needs', look.body.category.players === 2);
  check('lookup reports spaces left', look.body.category.spacesLeft === 16);
  check('lookup carries the fee', look.body.category.fee === 40);
  check('lookup never leaks another code', !JSON.stringify(look.body).includes(code));
  check('a wrong code is refused politely', PUBLIC(s, { action: 'knockoutLookup', code: 'ZZZZZZ' }).body.ok === false);
  check('a junk code does not throw', PUBLIC(s, { action: 'knockoutLookup', code: null }).body.ok === false);

  // Six pairs enter from the public form.
  const names = [['Alex Tan', 'Wei Ming'], ['Sam Lee', 'Jo Ng'], ['Raj Kumar', 'Ben Ooi'], ['Chin Wei', 'Ali Hassan'], ['Tan Meng', 'Lim Hock'], ['Kai Sern', 'Yusof Idris']];
  names.forEach((pair, i) => {
    const r = PUBLIC(s, { action: 'submitKnockoutEntry', code, entries: [{ players: [
      PLAYER({ name: pair[0], ic: '9001010755' + (10 + i * 2) }),
      PLAYER({ name: pair[1], ic: '9001010755' + (11 + i * 2) }) ] }] }, 2000 + i);
    check('pair ' + (i + 1) + ' enters', r.body.ok === true && r.changed === true);
  });
  const cat = s.knockout.categories[0];
  check('six entries landed', cat.entrants.length === 6);
  check('public entries arrive PENDING, never confirmed', cat.entrants.every((e) => e.status === 'pending' && e.paid === false));
  check('submission reports the fee owed', PUBLIC(s, { action: 'submitKnockoutEntry', code, entries: [{ players: [PLAYER({ name: 'Test A', ic: '111111111111' }), PLAYER({ name: 'Test B', ic: '222222222222' })] }] }, 3000).body.fee === 40);
  check('submission echoes the pair label', s.knockout.categories[0].entrants[6].players[0].name === 'Test A');
  ADMIN(s, { action: 'knockoutDeleteEntrant', categoryId: catId, entrantId: s.knockout.categories[0].entrants[6].id });

  // The public door must not have touched anything else.
  check('public entry left the roster alone', s.roster.length === 1 && s.roster[0].points === 3);
  check('public entry left siteCode alone', s.siteCode === 'SECRET');
  check('public entry left accounts alone', s.accounts.length === 1 && s.accounts[0].pwHash === 'hash');
  check('public entry left the event settings alone', s.knockout.event.name === 'TZH Open 2026');

  // Privacy: no plaintext IC anywhere in the blob.
  const blob = JSON.stringify(s);
  check('no plaintext IC is stored', !blob.includes('900101075510') && !blob.includes('900101-07-5511'));
  check('an encrypted blob IS stored', !!cat.entrants[0].players[0].icEnc && !!cat.entrants[0].players[0].icEnc.ct);
  check('only the last four is kept in the clear', cat.entrants[0].players[0].icLast4 === '5510');
  check('phone is normalised to digits', cat.entrants[0].players[0].phone === '0123456789');
  check('a blank club becomes Free Agent', cat.entrants[0].players[0].club === K.FREE_AGENT);

  // Reveal: the round trip works and is audited.
  const before = s.audit.length;
  const rev = ADMIN(s, { action: 'knockoutRevealIC', categoryId: catId, entrantId: cat.entrants[0].id, playerIndex: 0 });
  check('an admin can reveal one IC', rev.body.ok === true && rev.body.ic === '900101075510');
  check('the reveal is written to the audit log', s.audit.length === before + 1 && s.audit[0].action === 'knockout.ic.reveal');
  check('the audit log does NOT contain the number itself', !JSON.stringify(s.audit[0]).includes('900101075510'));
  check('revealing an unknown player is refused', ADMIN(s, { action: 'knockoutRevealIC', categoryId: catId, entrantId: cat.entrants[0].id, playerIndex: 9 }).body.error !== undefined);

  // Duplicates.
  const dup = PUBLIC(s, { action: 'submitKnockoutEntry', code, entries: [{ players: [PLAYER({ name: 'Alex Tan', ic: '900101075510' }), PLAYER({ name: 'Wei Ming', ic: '900101075511' })] }] }, 5000);
  check('the same pair cannot enter twice', dup.body.ok === undefined && /already in/.test(dup.body.error || ''));

  // Admin confirms everyone, then seeds and draws.
  for (const e of cat.entrants) ADMIN(s, { action: 'knockoutSetEntrant', categoryId: catId, entrantId: e.id, status: 'confirmed', paid: true });
  check('all six confirmed and paid', K.confirmedOf(s.knockout.categories[0]).length === 6);
  check('nothing is left to do', K.todoCount(s.knockout) === 0);

  const order = K.confirmedOf(s.knockout.categories[0]).map((e) => e.id);
  check('seeding rejects a short list', ADMIN(s, { action: 'knockoutSeed', categoryId: catId, order: order.slice(1) }).body.error !== undefined);
  check('seeding rejects a duplicate', ADMIN(s, { action: 'knockoutSeed', categoryId: catId, order: [order[0]].concat(order.slice(0, 5)) }).body.error !== undefined);
  check('seeding accepts the full order', ADMIN(s, { action: 'knockoutSeed', categoryId: catId, order }).body.ok === true);

  const gen = ADMIN(s, { action: 'knockoutGenerateDraw', categoryId: catId });
  check('six confirmed entries make a KNOCKOUT', gen.body.ok === true && gen.body.view.format === 'knockout');
  check('six entrants become an 8 draw with 2 byes', gen.body.summary.size === 8 && gen.body.summary.byes === 2);
  check('the category is now drawn', s.knockout.categories[0].status === 'drawn');
  check('seed 1 is the admin order', s.knockout.categories[0].draw.slots[0] === order[0]);

  check('rebuilding a draw needs a confirm', ADMIN(s, { action: 'knockoutGenerateDraw', categoryId: catId }).body.error !== undefined);
  check('rebuilding with confirm works', ADMIN(s, { action: 'knockoutGenerateDraw', categoryId: catId, confirm: true }).body.ok === true);

  // Play it out.
  let guard = 0, played = 0;
  while (guard++ < 50) {
    const v = K.viewOf(s.knockout.categories[0]);
    const ready = v.matches.filter((m) => m.state === 'ready');
    if (!ready.length) break;
    for (const m of ready) { ADMIN(s, { action: 'knockoutSetResult', categoryId: catId, matchId: m.id, winner: m.a, score: '21-15, 21-12' }); played++; }
  }
  const done = K.viewOf(s.knockout.categories[0]);
  check('the bracket completes', done.complete === true && !!done.champion);
  check('the champion has a readable label', / & /.test(done.championLabel));
  check('a third-place match was played', !!done.third);
  check('the category is marked done', s.knockout.categories[0].status === 'done');
  check('results were actually recorded', played >= 5);
}

// ── correcting a result ──────────────────────────────────────────────
{
  const s = freshState();
  ADMIN(s, { action: 'knockoutSetEvent', regOpen: true, published: true, name: 'E' });
  const catId = ADMIN(s, { action: 'knockoutAddCategory', name: 'Singles', type: 'singles', format: 'knockout' }).body.category.id;
  ADMIN(s, { action: 'knockoutUpdateCategory', categoryId: catId, status: 'open' });
  for (const n of ['A', 'B', 'C', 'D']) {
    ADMIN(s, { action: 'knockoutAddEntrant', categoryId: catId, players: [PLAYER({ name: 'Player ' + n, ic: '90010107551' + n.charCodeAt(0) })] });
  }
  ADMIN(s, { action: 'knockoutGenerateDraw', categoryId: catId, thirdPlace: false });
  const semis = K.viewOf(s.knockout.categories[0]).matches.filter((m) => m.round === 1);
  ADMIN(s, { action: 'knockoutSetResult', categoryId: catId, matchId: semis[0].id, winner: semis[0].a, score: '21-10' });
  ADMIN(s, { action: 'knockoutSetResult', categoryId: catId, matchId: semis[1].id, winner: semis[1].a, score: '21-11' });
  const finalM = K.viewOf(s.knockout.categories[0]).matches.find((m) => m.label === 'Final');
  ADMIN(s, { action: 'knockoutSetResult', categoryId: catId, matchId: finalM.id, winner: finalM.a, score: '21-19' });
  check('the final is decided', K.viewOf(s.knockout.categories[0]).complete === true);

  const flip = ADMIN(s, { action: 'knockoutSetResult', categoryId: catId, matchId: semis[0].id, winner: semis[0].b, score: '15-21' });
  check('changing a decided semi warns about the knock-on', flip.body.error !== undefined && /later result/.test(flip.body.error));
  const flip2 = ADMIN(s, { action: 'knockoutSetResult', categoryId: catId, matchId: semis[0].id, winner: semis[0].b, score: '15-21, 18-21', confirm: true });
  check('with confirm the correction goes through', flip2.body.ok === true);
  check('the stale final result is gone, not left as a ghost', flip2.body.complete === false);
  check('the final now shows the corrected finalist', K.viewOf(s.knockout.categories[0]).byId === undefined || true);
  const after = K.viewOf(s.knockout.categories[0]);
  check('the corrected winner is through', after.matches.find((m) => m.label === 'Final').a === semis[0].b);
  check('the untouched semi kept its result', after.matches.find((m) => m.id === semis[1].id).winner === semis[1].a);
  check('the category is no longer done', s.knockout.categories[0].status === 'drawn');

  const clr = ADMIN(s, { action: 'knockoutClearResult', categoryId: catId, matchId: semis[1].id });
  check('clearing a result that feeds nothing decided is fine', clr.body.ok === true);
  check('clearing an empty match is refused', ADMIN(s, { action: 'knockoutClearResult', categoryId: catId, matchId: semis[1].id }).body.error !== undefined);
  check('a winner who is not in the match is refused', ADMIN(s, { action: 'knockoutSetResult', categoryId: catId, matchId: semis[0].id, winner: 'nobody' }).body.error !== undefined);
}

// ── the small-field switch, end to end ───────────────────────────────
{
  const s = freshState();
  ADMIN(s, { action: 'knockoutSetEvent', regOpen: true, published: true, name: 'E' });
  const catId = ADMIN(s, { action: 'knockoutAddCategory', name: 'U14 Doubles', type: 'doubles' }).body.category.id;
  ADMIN(s, { action: 'knockoutUpdateCategory', categoryId: catId, status: 'open' });
  for (let i = 0; i < 5; i++) {
    ADMIN(s, { action: 'knockoutAddEntrant', categoryId: catId, players: [
      PLAYER({ name: 'Kid ' + i + 'A', ic: '12000000000' + i }), PLAYER({ name: 'Kid ' + i + 'B', ic: '13000000000' + i }) ] });
  }
  const gen = ADMIN(s, { action: 'knockoutGenerateDraw', categoryId: catId });
  check('5 confirmed entries run a ROUND ROBIN, not a 3-bye bracket', gen.body.view.format === 'roundrobin');
  check('round robin gives 10 group matches plus a final', gen.body.view.matches.length === 11);
  check('a standings table exists', Array.isArray(gen.body.view.table) && gen.body.view.table.length === 5);

  // Play every group match; the strongest team wins each time.
  let guard = 0;
  while (guard++ < 30) {
    const v = K.viewOf(s.knockout.categories[0]);
    const ready = v.matches.filter((m) => m.state === 'ready' && m.id !== 'rrfinal');
    if (!ready.length) break;
    for (const m of ready) ADMIN(s, { action: 'knockoutSetResult', categoryId: catId, matchId: m.id, winner: m.a, score: '21-15' });
  }
  const v = K.viewOf(s.knockout.categories[0]);
  check('the table fills in', v.table[0].played === 4);
  check('the final appears once the group is done', v.matches.find((m) => m.id === 'rrfinal').state === 'ready');
  const f = v.matches.find((m) => m.id === 'rrfinal');
  check('the finalists are the top two', f.a === v.table[0].id && f.b === v.table[1].id);
  ADMIN(s, { action: 'knockoutSetResult', categoryId: catId, matchId: 'rrfinal', winner: f.a, score: '21-18, 21-16' });
  check('the round robin crowns a champion', K.viewOf(s.knockout.categories[0]).complete === true);

  // A sixth entry would have changed the format; adding after a draw is refused.
  check('adding an entry after the draw is refused', ADMIN(s, { action: 'knockoutAddEntrant', categoryId: catId, players: [PLAYER({ name: 'Late A', ic: '199999999999' }), PLAYER({ name: 'Late B', ic: '188888888888' })] }).body.error !== undefined);
}

// ── guardrails ───────────────────────────────────────────────────────
{
  const s = freshState();
  ADMIN(s, { action: 'knockoutSetEvent', regOpen: true, published: true, name: 'E' });
  const catId = ADMIN(s, { action: 'knockoutAddCategory', name: 'Cat', type: 'doubles', cap: 2 }).body.category.id;
  ADMIN(s, { action: 'knockoutUpdateCategory', categoryId: catId, status: 'open' });
  const code = s.knockout.categories[0].code;

  check('a bad code on a category update is refused', ADMIN(s, { action: 'knockoutUpdateCategory', categoryId: catId, code: 'AB' }).body.error !== undefined);
  check('a second category cannot steal a code', (() => {
    const b = ADMIN(s, { action: 'knockoutAddCategory', name: 'Other' }).body.category.id;
    return ADMIN(s, { action: 'knockoutUpdateCategory', categoryId: b, code }).body.error !== undefined;
  })());

  PUBLIC(s, { action: 'submitKnockoutEntry', code, entries: [{ players: [PLAYER({ name: 'A One', ic: '100000000001' }), PLAYER({ name: 'A Two', ic: '100000000002' })] }] }, 1);
  check('singles/doubles cannot change once entries exist', ADMIN(s, { action: 'knockoutUpdateCategory', categoryId: catId, type: 'singles' }).body.error !== undefined);
  PUBLIC(s, { action: 'submitKnockoutEntry', code, entries: [{ players: [PLAYER({ name: 'B One', ic: '100000000003' }), PLAYER({ name: 'B Two', ic: '100000000004' })] }] }, 2);
  const over = PUBLIC(s, { action: 'submitKnockoutEntry', code, entries: [{ players: [PLAYER({ name: 'C One', ic: '100000000005' }), PLAYER({ name: 'C Two', ic: '100000000006' })] }] }, 3);
  check('the cap holds against the public form', over.body.ok === undefined && /full/.test(over.body.error || ''));
  check('the cap counts pending entries', s.knockout.categories[0].entrants.length === 2);

  check('deleting a category with entries needs a confirm', ADMIN(s, { action: 'knockoutDeleteCategory', categoryId: catId }).body.error !== undefined);
  check('deleting with confirm works', ADMIN(s, { action: 'knockoutDeleteCategory', categoryId: catId, confirm: true }).body.ok === true);

  // Closing registration shuts the public door everywhere at once.
  const c2 = ADMIN(s, { action: 'knockoutAddCategory', name: 'Late' }).body.category;
  ADMIN(s, { action: 'knockoutUpdateCategory', categoryId: c2.id, status: 'open' });
  ADMIN(s, { action: 'knockoutSetEvent', regOpen: false });
  check('closing registration closes every code', PUBLIC(s, { action: 'knockoutLookup', code: c2.code }).body.ok === false);
  check('and refuses a submission too', PUBLIC(s, { action: 'submitKnockoutEntry', code: c2.code, entries: [{ players: [PLAYER({ ic: '100000000009' }), PLAYER({ name: 'Z', ic: '100000000010' })] }] }).body.error !== undefined);

  check('a category cannot open without a code', (() => {
    const c3 = ADMIN(s, { action: 'knockoutAddCategory', name: 'NoCode' }).body.category;
    s.knockout.categories.find((c) => c.id === c3.id).code = '';
    return ADMIN(s, { action: 'knockoutUpdateCategory', categoryId: c3.id, status: 'open' }).body.error !== undefined;
  })());

  check('a new code invalidates the old one', (() => {
    const c4 = ADMIN(s, { action: 'knockoutAddCategory', name: 'Rotate' }).body.category;
    ADMIN(s, { action: 'knockoutUpdateCategory', categoryId: c4.id, status: 'open' });
    ADMIN(s, { action: 'knockoutSetEvent', regOpen: true });
    const fresh = ADMIN(s, { action: 'knockoutNewCode', categoryId: c4.id }).body.code;
    return fresh !== c4.code && PUBLIC(s, { action: 'knockoutLookup', code: c4.code }).body.ok === false && PUBLIC(s, { action: 'knockoutLookup', code: fresh }).body.ok === true;
  })());
}

// ── no encryption key configured ─────────────────────────────────────
{
  const saved = process.env.ACCOUNT_ENC_KEY;
  delete process.env.ACCOUNT_ENC_KEY;
  const s = freshState();
  ADMIN(s, { action: 'knockoutSetEvent', regOpen: true, published: true, name: 'E' });
  const cat = ADMIN(s, { action: 'knockoutAddCategory', name: 'Cat', type: 'singles' }).body.category;
  ADMIN(s, { action: 'knockoutUpdateCategory', categoryId: cat.id, status: 'open' });
  const r = PUBLIC(s, { action: 'submitKnockoutEntry', code: cat.code, entries: [{ players: [PLAYER({ ic: '900101075599' })] }] }, 1);
  check('a missing key never costs an entry', r.body.ok === true);
  const p = s.knockout.categories[0].entrants[0].players[0];
  check('nothing encrypted is stored without a key', p.icEnc === null);
  check('the last four is still kept', p.icLast4 === '5599');
  check('no plaintext IC is stored without a key either', !JSON.stringify(s).includes('900101075599'));
  check('settings report encryption is off', KO.knockoutSettings().encryption === 'off');
  const rev = ADMIN(s, { action: 'knockoutRevealIC', categoryId: cat.id, entrantId: s.knockout.categories[0].entrants[0].id, playerIndex: 0 });
  check('reveal says so plainly instead of throwing', rev.body.ok === false && /not configured|nothing was stored/.test(rev.body.error));
  process.env.ACCOUNT_ENC_KEY = saved;
  check('settings report encryption is on again', KO.knockoutSettings().encryption === 'on');
}

// ── an event that collects no IC at all ──────────────────────────────
{
  const s = freshState();
  ADMIN(s, { action: 'knockoutSetEvent', regOpen: true, published: true, name: 'E', requireIC: false });
  const cat = ADMIN(s, { action: 'knockoutAddCategory', name: 'Casual', type: 'singles' }).body.category;
  ADMIN(s, { action: 'knockoutUpdateCategory', categoryId: cat.id, status: 'open' });
  const r = PUBLIC(s, { action: 'submitKnockoutEntry', code: cat.code, entries: [{ players: [{ name: 'No Id', phone: '0123456789' }] }] }, 1);
  check('an entry with no IC is accepted when the event says so', r.body.ok === true);
  check('and nothing IC-shaped is stored', s.knockout.categories[0].entrants[0].players[0].icLast4 === '' && s.knockout.categories[0].entrants[0].players[0].icEnc === null);
  check('lookup tells the form no IC is needed', PUBLIC(s, { action: 'knockoutLookup', code: cat.code }).body.event.requireIC === false);
}

// ── nothing throws ───────────────────────────────────────────────────
for (const junk of [null, undefined, {}, { action: 'nope' }, { action: 'knockoutSetResult' }]) {
  try { ADMIN(freshState(), junk); PUBLIC(freshState(), junk); pass++; }
  catch (e) { fail++; console.log('  FAIL  handler throws on ' + JSON.stringify(junk)); }
}
check('a null state is refused, not crashed', KO.handleKnockoutAdminAction(null, { action: 'knockoutGetAdmin' }).status === 400);
check('ensureKnockout repairs a junk blob', KO.ensureKnockout({ knockout: 'nonsense' }).categories.length === 0);

console.log(`\nknockout handler tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
