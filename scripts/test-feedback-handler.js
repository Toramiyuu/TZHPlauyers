#!/usr/bin/env node
/* test-feedback-handler — the server rules in lib/feedback.js: who may write feedback
 * about a night, WHICH nights they are offered (every one they played, newest first — the
 * client may pick from that list and nothing else), the once-per-night points award and
 * its latest-night-only rule, the audit trail, the settings action, and the API wiring in
 * api/state.js that keeps the records off the public poll and out of the generic admin
 * merge. Pure logic lives in public/feedback.js (test-feedback.js). */
'use strict';
const path = require('path');
const FBlib = require('../lib/feedback.js');
const FB = require('../public/feedback.js');
const Night = require('../public/night.js');
const State = require('../api/state.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

// Friday 2026-09-18, 22:00 Malaysia (14:00 UTC) — mid-session.
const FRI_NIGHT = '2026-09-18';
const NOW = Date.parse('2026-09-18T14:00:00Z');
const SAT_AFTERNOON = Date.parse('2026-09-19T06:00:00Z'); // 14:00 MYT Saturday
const opts = (nowMs) => ({ nowMs: nowMs || NOW, creditRosterPoints: State.creditRosterPoints });

function baseState(over) {
  const s = {
    roster: [{ id: 'p1', name: 'Kelvin', points: 10 }, { id: 'p2', name: 'Amy', points: 0 }],
    players: [{ id: 'p1', name: 'Kelvin' }],
    sessionDate: FRI_NIGHT,
    accounts: [
      { id: 'a1', token: 'tok1', status: 'active', playerId: 'p1', name: 'Kelvin' },
      { id: 'a2', token: 'tok2', status: 'active', playerId: 'p2', name: 'Amy' },
      { id: 'a3', token: 'tokPend', status: 'pending', playerId: null, name: 'New' },
      { id: 'a4', token: 'tokNoLink', status: 'active', playerId: null, name: 'Unlinked' },
    ],
    attendance: {}, audit: [], feedback: {},
  };
  State.ensureLifetimePoints(s);
  return Object.assign(s, over || {});
}
const submit = (s, body, nowMs) => FBlib.handleMemberFeedbackAction(s, Object.assign({ action: 'submitFeedback' }, body), opts(nowMs));

// ── the night is the server's decision ──
check('the current night is the game day that owns the instant', Night.currentNight(NOW, 8) === FRI_NIGHT);
check('Saturday afternoon still belongs to Friday night', Night.currentNight(SAT_AFTERNOON, 8) === FRI_NIGHT);
check('openNight agrees with Night.currentNight', FBlib.openNight(baseState(), NOW) === FRI_NIGHT);

// ── auth ──
check('a missing/unknown token is 401', submit(baseState(), { token: 'nope', good: ['level'] }).status === 401
  && submit(baseState(), { good: ['level'] }).status === 401);
check('a non-active account is 401', submit(baseState(), { token: 'tokPend', good: ['level'] }).status === 401);
check('an active account with no linked player is 403, not a crash',
  submit(baseState(), { token: 'tokNoLink', good: ['level'] }).status === 403);
check('a state with no accounts array is 401, never a throw',
  FBlib.handleMemberFeedbackAction({ roster: [] }, { token: 'x' }, opts()).status === 401);

// ── eligibility ──
check('a player in the live line-up may write', submit(baseState(), { token: 'tok1', good: ['level'] }).status === 200);
check('a player who neither played nor is marked present is refused', (() => {
  const r = submit(baseState(), { token: 'tok2', good: ['level'] });
  return r.status === 403 && /were there that night/i.test(r.body.error);
})());
check('the attendance record is the second way in (admin ticked them present)', (() => {
  const s = baseState({ players: [], sessionDate: '2026-09-21' });
  s.attendance[FRI_NIGHT] = { date: FRI_NIGHT, entries: { p2: { playerId: 'p2', name: 'Amy', present: true } } };
  return submit(s, { token: 'tok2', bad: ['long-wait'] }, SAT_AFTERNOON).status === 200;
})());
check('present:false in attendance is NOT a way in', (() => {
  const s = baseState({ players: [] });
  s.attendance[FRI_NIGHT] = { date: FRI_NIGHT, entries: { p2: { playerId: 'p2', present: false } } };
  return submit(s, { token: 'tok2', good: ['level'] }).status === 403;
})());
check('the live line-up only counts when sessionDate IS the night being written about', (() => {
  // A session scheduled ahead must not admit tonight's line-up to last night's record.
  const s = baseState({ sessionDate: '2026-09-21', players: [{ id: 'p1', name: 'Kelvin' }] });
  return submit(s, { token: 'tok1', good: ['level'] }).status === 403;
})());
check('playedThatNight is pure and guards junk',
  FBlib.playedThatNight(baseState(), FRI_NIGHT, 'p1', NOW) === true
  && FBlib.playedThatNight(baseState(), null, 'p1', NOW) === false
  && FBlib.playedThatNight(baseState(), FRI_NIGHT, null, NOW) === false);
check('an unpaid player is just as welcome as a paid one (attendance is the test, not money)', (() => {
  const s = baseState({ players: [] });
  s.attendance[FRI_NIGHT] = { date: FRI_NIGHT, entries: {
    p1: { playerId: 'p1', present: true, paid: true, payment: { fee: 15, paidAt: 1 } },
    p2: { playerId: 'p2', present: true, paid: false, payment: { fee: 15 } },
  } };
  return submit(s, { token: 'tok1', good: ['level'] }).status === 200
    && submit(s, { token: 'tok2', good: ['level'] }).status === 200;
})());

// ── the nights on offer ──
const nightsOf = (s, pid, nowMs) => FBlib.attendedNights(s, pid, nowMs || NOW);
check('the live line-up puts tonight on the list', JSON.stringify(nightsOf(baseState(), 'p1')) === JSON.stringify([FRI_NIGHT]));
check('a player with nothing to their name gets an empty list', nightsOf(baseState(), 'p2').length === 0);
check('attendance records stack up, newest night first', (() => {
  const s = baseState({ players: [] });
  for (const d of ['2026-09-07', '2026-09-13', '2026-09-11', FRI_NIGHT]) {
    s.attendance[d] = { date: d, entries: { p1: { playerId: 'p1', present: true } } };
  }
  // 2026-09-11 is a Friday, 09-13 a Sunday, 09-07 a Monday — all real game nights.
  return JSON.stringify(nightsOf(s, 'p1')) === JSON.stringify([FRI_NIGHT, '2026-09-13', '2026-09-11', '2026-09-07']);
})());
check('present:false is left off the list entirely', (() => {
  const s = baseState({ players: [] });
  s.attendance['2026-09-11'] = { date: '2026-09-11', entries: { p1: { playerId: 'p1', present: false } } };
  return nightsOf(s, 'p1').length === 0;
})());
check('a stray off-day record folds onto the night that owned it, without duplicating it', (() => {
  const s = baseState({ players: [] });
  // The ghost Saturday: a record written the morning after Friday's session.
  s.attendance['2026-09-12'] = { date: '2026-09-12', entries: { p1: { playerId: 'p1', present: true } } };
  s.attendance['2026-09-11'] = { date: '2026-09-11', entries: { p1: { playerId: 'p1', present: true } } };
  return JSON.stringify(nightsOf(s, 'p1')) === JSON.stringify(['2026-09-11']);
})());
check('a session scheduled ahead is never offered (it has not happened yet)', (() => {
  const s = baseState({ sessionDate: '2026-09-21', players: [{ id: 'p1' }] });
  s.attendance['2026-09-21'] = { date: '2026-09-21', entries: { p1: { playerId: 'p1', present: true } } };
  return nightsOf(s, 'p1').length === 0;
})());
check('nothing older than the prune cutoff is offered (the picker can never point at a ghost)', (() => {
  const s = baseState({ players: [] });
  const old = '2026-01-05';   // a Monday, ~8 months back
  s.attendance[old] = { date: old, entries: { p1: { playerId: 'p1', present: true } } };
  return !nightsOf(s, 'p1').includes(old);
})());
check('the list is capped, so the picker cannot grow without bound', (() => {
  const s = baseState({ players: [] });
  for (let i = 1; i <= 40; i++) {
    const d = require('../public/weekly-draw.js').addDaysISO(FRI_NIGHT, -i);
    if (!Night.isGameDay(d)) continue;
    s.attendance[d] = { date: d, entries: { p1: { playerId: 'p1', present: true } } };
  }
  const list = nightsOf(s, 'p1');
  return list.length === FBlib.MAX_PICKABLE_NIGHTS && list[0] === '2026-09-14';   // the Monday before
})());
check('attendedNights guards junk rather than throwing',
  nightsOf(baseState(), null).length === 0 && FBlib.attendedNights(null, 'p1', NOW).length === 0
  && nightsOf(baseState({ attendance: 'nope', players: null }), 'p1').length === 0);

// ── picking a night ──
function twoNights() {
  const s = baseState({ players: [] });
  s.attendance[FRI_NIGHT] = { date: FRI_NIGHT, entries: { p1: { playerId: 'p1', present: true } } };
  s.attendance['2026-09-13'] = { date: '2026-09-13', entries: { p1: { playerId: 'p1', present: true } } };
  return s;
}
check('no night named means their latest', (() => {
  const s = twoNights();
  return submit(s, { token: 'tok1', good: ['level'] }).body.night === FRI_NIGHT;
})());
check('a night they played is written where they asked', (() => {
  const s = twoNights();
  const r = submit(s, { token: 'tok1', bad: ['long-wait'], night: '2026-09-13' });
  return r.status === 200 && r.body.night === '2026-09-13'
    && s.feedback['2026-09-13'].p1.bad[0] === 'long-wait' && !s.feedback[FRI_NIGHT];
})());
check('a night they did NOT play is refused, never silently redirected', (() => {
  const s = twoNights();
  const r = submit(s, { token: 'tok1', good: ['level'], night: '2026-09-11' });
  return r.status === 403 && /not one of the nights you played/i.test(r.body.error) && !s.feedback['2026-09-11'];
})());
check('a junk or out-of-window night is refused too', (() => {
  const s = twoNights();
  return submit(s, { token: 'tok1', good: ['level'], night: 'tomorrow' }).status === 403
    && submit(s, { token: 'tok1', good: ['level'], night: '2026-09-21' }).status === 403
    && submit(s, { token: 'tok1', good: ['level'], night: '2020-01-06' }).status === 403;
})());
check('a non-string night falls back to the latest rather than throwing', (() => {
  const s = twoNights();
  return submit(s, { token: 'tok1', good: ['level'], night: { evil: 1 } }).body.night === FRI_NIGHT;
})());

// ── only the latest night pays ──
check('back-filling an older night earns nothing, but is still stored', (() => {
  const s = twoNights();
  const r = submit(s, { token: 'tok1', good: ['level'], night: '2026-09-13' });
  return r.status === 200 && r.body.awarded === 0 && s.roster[0].points === 10
    && s.feedback['2026-09-13'].p1.good[0] === 'level' && s.feedback['2026-09-13'].p1.awarded === false;
})());
check('the latest night still pays, whatever was back-filled before it', (() => {
  const s = twoNights();
  submit(s, { token: 'tok1', good: ['level'], night: '2026-09-13' });
  const r = submit(s, { token: 'tok1', good: ['level'] });
  return r.body.awarded === 5 && s.roster[0].points === 15;
})());
check('a night that paid nothing pays properly once it becomes their latest', (() => {
  // They answer Monday late (no points), then Monday IS their latest next time they look.
  const s = baseState({ players: [] });
  s.attendance[FRI_NIGHT] = { date: FRI_NIGHT, entries: { p1: { playerId: 'p1', present: true } } };
  s.attendance['2026-09-13'] = { date: '2026-09-13', entries: { p1: { playerId: 'p1', present: true } } };
  submit(s, { token: 'tok1', good: ['level'], night: '2026-09-13' });   // older — 0
  delete s.attendance[FRI_NIGHT];                                        // Friday struck off
  const r = submit(s, { token: 'tok1', good: ['level'], night: '2026-09-13' });
  return r.body.awarded === 5 && s.roster[0].points === 15;
})());

// ── the points award ──
check('a first submission credits the points once, on roster AND lifetime', (() => {
  const s = baseState();
  const r = submit(s, { token: 'tok1', good: ['level'], bad: ['long-wait'] });
  return r.status === 200 && r.body.awarded === 5
    && s.roster[0].points === 15 && s.lifetimePoints.p1 === 15
    && s.feedback[FRI_NIGHT].p1.awarded === true;
})());
check('editing never pays twice, however many times', (() => {
  const s = baseState();
  submit(s, { token: 'tok1', good: ['level'] });
  const second = submit(s, { token: 'tok1', good: ['level', 'variety'], badNote: 'more' });
  const third = submit(s, { token: 'tok1', bad: ['long-wait'] });
  return second.body.awarded === 0 && third.body.awarded === 0
    && s.roster[0].points === 15 && s.lifetimePoints.p1 === 15;
})());
check('an edit keeps the original timestamp and replaces the content', (() => {
  const s = baseState();
  submit(s, { token: 'tok1', good: ['level'] });
  submit(s, { token: 'tok1', bad: ['long-wait'] }, NOW + 60000);
  const rec = s.feedback[FRI_NIGHT].p1;
  return rec.at === NOW && rec.updatedAt === NOW + 60000
    && rec.good.length === 0 && rec.bad[0] === 'long-wait';
})());
check('points:0 stores the feedback, credits nothing, and still latches', (() => {
  const s = baseState({ feedbackSettings: { enabled: true, points: 0 } });
  const r = submit(s, { token: 'tok1', good: ['level'] });
  return r.status === 200 && r.body.awarded === 0 && s.roster[0].points === 10
    && s.feedback[FRI_NIGHT].p1.awarded === true;
})());
check('the record remembers what it actually paid, even after the rate changes', (() => {
  const s = baseState();
  submit(s, { token: 'tok1', good: ['level'] });                 // paid 5
  s.feedbackSettings = { enabled: true, points: 3 };             // organiser lowers it
  submit(s, { token: 'tok1', bad: ['long-wait'] });              // an edit
  const rec = s.feedback[FRI_NIGHT].p1;
  return rec.awardedPoints === 5 && s.roster[0].points === 15
    && FBlib.feedbackViewFor(s, s.accounts[0], NOW).mine.awardedPoints === 5;
})());
check('a custom points value is honoured', (() => {
  const s = baseState({ feedbackSettings: { enabled: true, points: 3 } });
  return submit(s, { token: 'tok1', good: ['level'] }).body.awarded === 3 && s.roster[0].points === 13;
})());
check('two different players each get their own award', (() => {
  const s = baseState({ players: [{ id: 'p1' }, { id: 'p2' }] });
  submit(s, { token: 'tok1', good: ['level'] });
  submit(s, { token: 'tok2', bad: ['long-wait'] });
  return s.roster[0].points === 15 && s.roster[1].points === 5
    && Object.keys(s.feedback[FRI_NIGHT]).length === 2;
})());
check('a refused submission credits nothing', (() => {
  const s = baseState();
  submit(s, { token: 'tok2', good: ['level'] });          // not eligible
  submit(s, { token: 'tok1', good: [], bad: [] });        // empty
  return s.roster[0].points === 10 && s.roster[1].points === 0 && !s.feedback[FRI_NIGHT];
})());
check('an unlatched record retries the award later (roster added after the fact)', (() => {
  const s = baseState({ roster: [] });                     // account linked, not on the roster
  const first = submit(s, { token: 'tok1', good: ['level'] });
  const rec = s.feedback[FRI_NIGHT].p1;
  s.roster = [{ id: 'p1', name: 'Kelvin', points: 0 }];
  const second = submit(s, { token: 'tok1', good: ['level'] });
  return first.body.awarded === 0 && rec.awarded === false && second.body.awarded === 5 && s.roster[0].points === 5;
})());

// ── switched off ──
check('feedback off refuses the write entirely', (() => {
  const s = baseState({ feedbackSettings: { enabled: false, points: 5 } });
  const r = submit(s, { token: 'tok1', good: ['level'] });
  return r.status === 403 && s.roster[0].points === 10 && !s.feedback[FRI_NIGHT];
})());

// ── audit ──
check('every accepted submission appends one audit row attributed to the member', (() => {
  const s = baseState();
  submit(s, { token: 'tok1', good: ['level'] });
  const e = s.audit[0];
  return s.audit.length === 1 && e.action === 'feedback.submit' && e.admin === 'member:Kelvin'
    && e.target.id === FRI_NIGHT + ':p1' && /\+5 points/.test(e.note);
})());
check('an edit is audited too, and marked as an edit', (() => {
  const s = baseState();
  submit(s, { token: 'tok1', good: ['level'] });
  submit(s, { token: 'tok1', bad: ['long-wait'] });
  return s.audit.length === 2 && s.audit[0].prevValue === 'edited' && s.audit[0].note === '';
})());
check('a refused submission writes no audit row', (() => {
  const s = baseState();
  submit(s, { token: 'tok2', good: ['level'] });
  return s.audit.length === 0;
})());

// ── changed flag (drives the kv.set in api/state.js) ──
check('changed is true only when something was written', (() => {
  const s = baseState();
  return submit(s, { token: 'tok1', good: ['level'] }).changed === true
    && submit(baseState(), { token: 'nope' }).changed === false
    && submit(baseState(), { token: 'tok2', good: ['level'] }).changed === false;
})());

// ── the response feeds the member card straight back ──
check('a successful reply carries the refreshed feedback view', (() => {
  const s = baseState();
  const r = submit(s, { token: 'tok1', good: ['level'], badNote: 'waited' });
  const v = r.body.feedback;
  return v && v.open === true && v.night === FRI_NIGHT && v.mine && v.mine.awarded === true
    && v.mine.good[0] === 'level' && v.mine.badNote === 'waited';
})());

// ── feedbackViewFor (the memberInfo block) ──
{
  const s = baseState();
  const acct = s.accounts[0], other = s.accounts[1];
  check('view: open for a player who was there, with the catalogue and the points',
    (() => { const v = FBlib.feedbackViewFor(s, acct, NOW); return v.open && v.points === 5 && v.goodOptions.length === 4 && v.badOptions.length === 4 && v.mine === null; })());
  check('view: closed for a player who was not there', FBlib.feedbackViewFor(s, other, NOW).open === false);
  check('view: closed when the feature is off',
    FBlib.feedbackViewFor(Object.assign(baseState(), { feedbackSettings: { enabled: false } }), acct, NOW).open === false);
  check('view: closed when there is no night at all (fresh install)',
    FBlib.feedbackViewFor(s, acct, Date.parse('2020-01-01T00:00:00Z')).open === false);
  check('view: the nights list leads with the one the card opens on', (() => {
    const v = FBlib.feedbackViewFor(twoNights(), acct, NOW);
    return v.nights.length === 2 && v.nights[0].date === FRI_NIGHT && v.nights[0].latest === true
      && v.nights[1].date === '2026-09-13' && v.nights[1].latest === false && v.night === v.nights[0].date;
  })());
  check('view: only the latest night is marked awardable', (() => {
    const v = FBlib.feedbackViewFor(twoNights(), acct, NOW);
    return v.nights[0].awardable === true && v.nights[1].awardable === false;
  })());
  check('view: a night already paid for stops being awardable', (() => {
    const t = twoNights();
    submit(t, { token: 'tok1', good: ['level'] });
    const v = FBlib.feedbackViewFor(t, t.accounts[0], NOW);
    return v.nights[0].awardable === false && v.nights[0].mine.awarded === true;
  })());
  check('view: nothing is awardable when the reward is switched down to zero', (() => {
    const t = twoNights(); t.feedbackSettings = { enabled: true, points: 0 };
    return FBlib.feedbackViewFor(t, t.accounts[0], NOW).nights.every(n => n.awardable === false);
  })());
  check('view: each night carries its own answer, and the older one is untouched', (() => {
    const t = twoNights();
    submit(t, { token: 'tok1', goodNote: 'friday words' });
    const v = FBlib.feedbackViewFor(t, t.accounts[0], NOW);
    return v.nights[0].mine.goodNote === 'friday words' && v.nights[1].mine === null;
  })());
  check('view: an account with no nights gets an empty list, not a phantom card', (() => {
    const v = FBlib.feedbackViewFor(s, other, NOW);
    return v.open === false && Array.isArray(v.nights) && v.nights.length === 0 && v.night === '';
  })());
  check('view: an existing record comes back as `mine`', (() => {
    const t = baseState();
    submit(t, { token: 'tok1', good: ['level'], goodNote: 'fun' });
    const v = FBlib.feedbackViewFor(t, t.accounts[0], NOW);
    return v.mine && v.mine.good[0] === 'level' && v.mine.goodNote === 'fun' && v.mine.awarded === true;
  })());
  check('view: never leaks another player\'s record', (() => {
    const t = baseState({ players: [{ id: 'p1' }, { id: 'p2' }] });
    submit(t, { token: 'tok1', goodNote: 'kelvin secret' });
    const v = FBlib.feedbackViewFor(t, t.accounts[1], NOW);
    return v.mine === null && !JSON.stringify(v).includes('kelvin secret');
  })());
}

// ── admin settings action ──
const admin = (s, body) => FBlib.handleFeedbackAdminAction(s, Object.assign({ action: 'setFeedbackSettings' }, body));
check('points can be set and are persisted', (() => {
  const s = baseState();
  const r = admin(s, { points: 3 });
  return r.status === 200 && r.changed === true && s.feedbackSettings.points === 3 && FB.settingsOf(s).points === 3;
})());
check('out-of-range / fractional / non-numeric points are refused',
  admin(baseState(), { points: 51 }).status === 400 && admin(baseState(), { points: -1 }).status === 400
  && admin(baseState(), { points: 2.5 }).status === 400 && admin(baseState(), { points: 'five' }).status === 400);
check('enabled must be a real boolean', admin(baseState(), { enabled: 'yes' }).status === 400
  && admin(baseState(), { enabled: 1 }).status === 400);
check('the switch flips and keeps the points value', (() => {
  const s = baseState({ feedbackSettings: { enabled: true, points: 7 } });
  admin(s, { enabled: false });
  return s.feedbackSettings.enabled === false && s.feedbackSettings.points === 7;
})());
check('a no-op save reports changed:false (nothing written to Redis)',
  admin(baseState({ feedbackSettings: { enabled: true, points: 5 } }), { points: 5 }).changed === false);
check('a settings change is audited', (() => {
  const s = baseState();
  admin(s, { points: 2 });
  return s.audit[0] && s.audit[0].action === 'feedback.settings' && s.audit[0].admin === 'admin';
})());
check('an unknown admin action is refused', FBlib.handleFeedbackAdminAction(baseState(), { action: 'nope' }).status === 400);
check('setFeedbackSettings is the only admin action on this surface',
  FBlib.FEEDBACK_ADMIN_ACTIONS.size === 1 && FBlib.FEEDBACK_ADMIN_ACTIONS.has('setFeedbackSettings'));

// ── creditRosterPoints (the shared helper in api/state.js) ──
check('creditRosterPoints moves roster + lifetime together and reports the move', (() => {
  const s = baseState();
  const r = State.creditRosterPoints(s, 'p1', 5);
  return r.prev === 10 && r.next === 15 && s.roster[0].points === 15 && s.lifetimePoints.p1 === 15;
})());
check('creditRosterPoints is a no-op for an unknown player or a zero/junk delta', (() => {
  const s = baseState();
  const a = State.creditRosterPoints(s, 'ghost', 5);
  const b = State.creditRosterPoints(s, 'p1', 0);
  const c = State.creditRosterPoints(s, 'p1', 'lots');
  return a.prev === a.next && b.prev === b.next && c.prev === c.next && s.roster[0].points === 10;
})());
check('creditRosterPoints clamps at the ceiling and never goes negative', (() => {
  const s = baseState({ roster: [{ id: 'p1', name: 'K', points: State.MAX_POINTS }] });
  const hi = State.creditRosterPoints(s, 'p1', 10);
  const s2 = baseState({ roster: [{ id: 'p1', name: 'K', points: 2 }] });
  State.creditRosterPoints(s2, 'p1', -50);
  return hi.prev === hi.next && s2.roster[0].points === 0;
})());
check('creditRosterPoints replaces the roster array (never mutates the caller\'s entries)', (() => {
  const s = baseState();
  const before = s.roster;
  State.creditRosterPoints(s, 'p1', 5);
  return s.roster !== before && before[0].points === 10;
})());

// ── api/state.js wiring ──
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'api', 'state.js'), 'utf8');
  check('the public GET strips the feedback records', /const \{[^}]*\bfeedback,[^}]*\} = redactState\(current\)/.test(src));
  check('publicProjection really drops it', (() => {
    const s = baseState();
    submit(s, { token: 'tok1', goodNote: 'private words' });
    const pub = State.publicProjection(s);
    return !('feedback' in pub) && !JSON.stringify(pub).includes('private words');
  })());
  check('the settings DO ride the public poll (the card needs the number)',
    State.publicProjection(baseState({ feedbackSettings: { enabled: true, points: 4 } })).feedbackSettings.points === 4);
  check('the generic admin merge refuses both new keys', src.includes("error: 'Feedback is written by members.'")
    && src.includes("error: 'Use the setFeedbackSettings action.'"));
  check('submitFeedback is its own public branch, before the admin password check',
    src.indexOf("b.action === 'submitFeedback'") > -1
    && src.indexOf("b.action === 'submitFeedback'") < src.indexOf('password !== ADMIN_PASSWORD'));
  check('the public branch seeds the lifetime ledger before crediting', (() => {
    const i = src.indexOf("b.action === 'submitFeedback'");
    const slice = src.slice(i, i + 1200);
    return slice.includes('ensureLifetimePoints(s)') && slice.indexOf('ensureLifetimePoints(s)') < slice.indexOf('handleMemberFeedbackAction');
  })());
  check('the public branch persists only when the handler reports a change', (() => {
    const i = src.indexOf("b.action === 'submitFeedback'");
    const slice = src.slice(i, i + 1200);
    return slice.includes('if (result.changed)') && slice.includes('kv.set(STATE_KEY, s)');
  })());
  check('the admin settings action is wired behind the password',
    src.includes('FEEDBACK_ADMIN_ACTIONS.has(updates.action)')
    && src.indexOf('FEEDBACK_ADMIN_ACTIONS.has(updates.action)') > src.indexOf('password !== ADMIN_PASSWORD'));
  check('adminGetOps serves the records to the admin', /feedback: state\.feedback \|\| \{\}/.test(src));
  check('feedback is pruned on read like attendance', src.includes('pruneFeedback(current, todayISO())'));
  check('api/ still holds only the four real endpoints (Vercel 12-function cap)',
    require('fs').readdirSync(path.join(__dirname, '..', 'api')).filter(f => f.endsWith('.js')).length === 4);
}

// ── memberInfo carries the block ──
{
  const M = require('../lib/member.js');
  const s = baseState();
  const info = M.buildMemberInfo(s, s.accounts[0], { nowMs: NOW });
  check('the member page payload carries the feedback block', !!info.feedback && info.feedback.open === true);
}

console.log('\nfeedback (handler): ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
