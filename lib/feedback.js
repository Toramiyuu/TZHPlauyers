'use strict';
/*
 * feedback.js — server-side handlers for per-session member feedback.
 *
 * Two entry points:
 *   - submitFeedback        public, TOKEN-gated (a signed-in member writing about their
 *                           own night). The only feedback path that writes a record.
 *   - setFeedbackSettings   admin, password-gated (on/off + points per submission).
 *
 * Pure helpers live in public/feedback.js (option catalogue, sanitising, tallies).
 * This module wires those into the {status, body, changed} handler contract, the
 * eligibility rules and the audit log. Requiring the public modules by static path is
 * traced + bundled by Vercel's builder.
 *
 * Security notes:
 *   - The record is SELF-BUILT by FB.buildSubmission; req.body is never spread, so this
 *     path can only ever touch state.feedback[night][theirOwnId] and that player's points.
 *   - The night is decided by the SERVER clock (Night.currentNight), never by the client,
 *     so a member cannot back-date feedback onto an old night to farm points.
 *   - Points are credited through the injected creditRosterPoints, latched by the
 *     record's `awarded` flag: once per player per night, however many times they edit.
 */
const FB = require('../public/feedback.js');
const Night = require('../public/night.js');
const WD = require('../public/weekly-draw.js');
const { findByToken } = require('./accounts.js');
const { pushAudit } = require('./audit.js');

const FEEDBACK_ADMIN_ACTIONS = new Set(['setFeedbackSettings']);

function offsetHours() { return parseFloat(process.env.TZ_OFFSET_HOURS || '8'); }
function isPlainMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function ensureFeedback(state) {
  if (!isPlainMap(state.feedback)) state.feedback = {};
  return state.feedback;
}

/**
 * The night a member may write about right now, or null when there is none.
 * A night stays open until the NEXT game night takes over (Night.currentNight), which
 * gives a Monday player until Friday 20:00 to get round to it.
 */
function openNight(state, nowMs) {
  return Night.currentNight(nowMs, offsetHours());
}

/**
 * May this player write about this night?
 *
 * Two ways in, because attendance is often not ticked until the next day and a player
 * walking off court should not hit a wall:
 *   1. they are in the live line-up for that night (state.players). Gated on
 *      sessionDate === night so a session scheduled ahead can't admit the wrong people.
 *   2. they are marked present in the attendance record — the same `present` test the
 *      session draw uses.
 * Pure.
 */
function playedThatNight(state, night, playerId) {
  if (!night || !playerId) return false;
  if (state.sessionDate === night) {
    const live = Array.isArray(state.players) ? state.players : [];
    if (live.some((p) => p && p.id === playerId)) return true;
  }
  const day = isPlainMap(state.attendance) ? state.attendance[night] : null;
  const entries = day && isPlainMap(day.entries) ? day.entries : null;
  const entry = entries ? entries[playerId] : null;
  return !!(entry && entry.present);
}

/** The roster name for a player, falling back to the account's. Pure. */
function nameFor(state, playerId, account) {
  const roster = Array.isArray(state.roster) ? state.roster : [];
  const p = roster.find((r) => r && r.id === playerId);
  return (p && p.name) || (account && account.name) || playerId;
}

/**
 * What the member page needs to draw its card, for one account. Read-only.
 * `open` false means the card is not shown at all — either feedback is switched off,
 * there is no current night, or they did not play it.
 * Pure given `nowMs`.
 */
function feedbackViewFor(state, account, nowMs) {
  const settings = FB.settingsOf(state);
  const playerId = account && account.playerId;
  const night = openNight(state, nowMs);
  const base = {
    open: false, night: night || '', points: settings.points,
    goodOptions: FB.GOOD_OPTIONS, badOptions: FB.BAD_OPTIONS, mine: null,
  };
  if (!settings.enabled || !night || !playerId) return base;
  if (!playedThatNight(state, night, playerId)) return base;
  const rec = FB.recordFor(state, night, playerId);
  return Object.assign(base, {
    open: true,
    mine: FB.hasContent(rec) ? {
      good: FB.cleanOptions(rec.good, FB.GOOD_IDS),
      bad: FB.cleanOptions(rec.bad, FB.BAD_IDS),
      goodNote: FB.cleanNote(rec.goodNote),
      badNote: FB.cleanNote(rec.badNote),
      at: Number(rec.at) || 0,
      updatedAt: Number(rec.updatedAt) || 0,
      awarded: !!rec.awarded,
      awardedPoints: Math.max(0, Math.trunc(Number(rec.awardedPoints)) || 0),
    } : null,
  });
}

/**
 * POST { action:'submitFeedback', token, good[], bad[], goodNote, badNote }.
 * opts = { nowMs, creditRosterPoints } — creditRosterPoints is injected rather than
 * required, because lib/ must not reach back into api/state.js.
 */
function doSubmitFeedback(state, body, opts) {
  const o = opts || {};
  const now = Number(o.nowMs) || Date.now();

  const account = findByToken(state.accounts, body && body.token);
  if (!account || account.status !== 'active') {
    return { status: 401, body: { error: 'Session expired.' }, changed: false };
  }
  const playerId = account.playerId;
  if (!playerId) {
    return { status: 403, body: { error: 'Your account is not linked to a player yet. Ask the organiser.' }, changed: false };
  }

  const settings = FB.settingsOf(state);
  if (!settings.enabled) {
    return { status: 403, body: { error: 'Feedback is closed right now.' }, changed: false };
  }
  const night = openNight(state, now);
  if (!night) {
    return { status: 400, body: { error: 'There is no session to give feedback on yet.' }, changed: false };
  }
  if (!playedThatNight(state, night, playerId)) {
    return { status: 403, body: { error: 'Feedback is for the players who were there that night.' }, changed: false };
  }

  const name = nameFor(state, playerId, account);
  const prev = FB.recordFor(state, night, playerId);
  const built = FB.buildSubmission(body, { nowMs: now, playerId, name }, prev);
  if (!built.ok) return { status: 400, body: { error: built.error }, changed: false };

  const all = ensureFeedback(state);
  if (!isPlainMap(all[night])) all[night] = {};

  // The points latch: pay on the FIRST submission for this player and night only. An
  // edit rewrites the record with awarded still true, so it can never pay again.
  let awarded = 0;
  if (!built.record.awarded) {
    if (settings.points === 0) {
      built.record.awarded = true;            // nothing on offer — latch it anyway
    } else if (typeof o.creditRosterPoints === 'function') {
      const credit = o.creditRosterPoints(state, playerId, settings.points);
      // Only latch on a credit that actually moved the total. A guest who is not on the
      // roster (or a player already at the ceiling) stays unlatched, so they are paid
      // properly the day the situation is fixed rather than silently skipped forever.
      if (credit && credit.next > credit.prev) {
        awarded = credit.next - credit.prev;
        built.record.awarded = true;
        built.record.awardedPoints = awarded;
      }
    }
  }

  all[night][playerId] = built.record;

  pushAudit(state, {
    action: 'feedback.submit',
    admin: 'member:' + name,
    at: now,
    target: { type: 'feedback', id: night + ':' + playerId, label: name + ' ' + night },
    prevValue: prev ? 'edited' : null,
    newValue: built.record.good.length + ' good / ' + built.record.bad.length + ' bad',
    note: awarded > 0 ? ('+' + awarded + ' points') : '',
  });

  return {
    status: 200,
    body: { ok: true, night, awarded, record: built.record, feedback: feedbackViewFor(state, account, now) },
    changed: true,
  };
}

/** Admin: POST { action:'setFeedbackSettings', enabled, points }. */
function doSetFeedbackSettings(state, body) {
  const b = body || {};
  const prev = FB.settingsOf(state);
  const next = { enabled: prev.enabled, points: prev.points };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { status: 400, body: { error: 'Invalid setting.' }, changed: false };
    next.enabled = b.enabled;
  }
  if (b.points !== undefined) {
    const n = Number(b.points);
    if (!FB.isPointsValue(n)) {
      return { status: 400, body: { error: 'Points must be a whole number from 0 to ' + FB.MAX_POINTS_PER + '.' }, changed: false };
    }
    next.points = n;
  }
  if (next.enabled === prev.enabled && next.points === prev.points) {
    return { status: 200, body: { ok: true, settings: next }, changed: false };
  }
  state.feedbackSettings = next;
  pushAudit(state, {
    action: 'feedback.settings', admin: 'admin', at: Date.now(),
    target: { type: 'settings', id: 'feedback', label: 'Session feedback' },
    prevValue: prev.enabled + ' / ' + prev.points, newValue: next.enabled + ' / ' + next.points,
  });
  return { status: 200, body: { ok: true, settings: next }, changed: true };
}

function handleFeedbackAdminAction(state, body) {
  try {
    if (!state || typeof state !== 'object') return { status: 400, body: { error: 'Invalid request.' }, changed: false };
    switch (body && body.action) {
      case 'setFeedbackSettings': return doSetFeedbackSettings(state, body);
      default: return { status: 400, body: { error: 'Unknown action.' }, changed: false };
    }
  } catch (e) {
    return { status: 400, body: { error: 'Invalid request.' }, changed: false };
  }
}

function handleMemberFeedbackAction(state, body, opts) {
  try {
    if (!state || typeof state !== 'object') return { status: 400, body: { error: 'Invalid request.' }, changed: false };
    if (!Array.isArray(state.accounts)) return { status: 401, body: { error: 'Session expired.' }, changed: false };
    return doSubmitFeedback(state, body, opts);
  } catch (e) {
    return { status: 400, body: { error: 'Invalid request.' }, changed: false };
  }
}

/** Drop nights past the retention window — wired next to pruneWeeklyState. */
function pruneFeedback(state, today) {
  return FB.pruneFeedback(state, today, WD.addDaysISO);
}

module.exports = {
  FEEDBACK_ADMIN_ACTIONS,
  handleFeedbackAdminAction, handleMemberFeedbackAction,
  feedbackViewFor, pruneFeedback,
  // exposed for tests
  playedThatNight, openNight, ensureFeedback, nameFor,
};
