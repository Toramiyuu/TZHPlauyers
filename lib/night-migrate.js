'use strict';
/*
 * night-migrate.js — fold the phantom off-day records back into the night that
 * owned them. One-time cleanup for the data the old 00:00 rollover created.
 *
 * The bug: a Friday session still on court at 12:30am had its date flipped to
 * Saturday by a midnight cron, so "End of the day" and every payment ticked
 * after midnight landed on a SATURDAY attendance record — a day nobody plays
 * on, and one the draw schedule ignores entirely. Same shape for a Monday night
 * bleeding into Tuesday. See public/night.js for the rule that replaced it.
 *
 * planNightMerge() is PURE and decides everything; applyNightMerge() does the
 * mutation. Split that way so `scripts/migrate-nights.js --dry-run` can print
 * the exact plan and the operator can read it before a single byte is written.
 *
 * What it deliberately does NOT do: recompute past draws. Session draw results
 * are permanent (HSETNX, lib/session-draw.js) and some were decided from an
 * incomplete paid list because the late payment was sitting on a ghost
 * Saturday. The user's call is that announced winners stand — moving the
 * payment data fixes the accounting, not the history.
 */
const Night = require('../public/night.js');

/** A payment record actually exists on this entry (vs a bare attendance tick). */
function hasPayment(e) { return !!(e && e.payment); }

/**
 * Decide what a merge would do, touching nothing. Returns
 *   { merges: [{ from, to, entries: [{playerId, name, action, reason}], carriedPayments }],
 *     drops: [{ date, reason }], warnings: [string], strayDates: [string] }
 *
 * `action` is one of:
 *   move        — the night has no record for this player; the ghost's record IS the record
 *   adopt-paid  — both exist, only the ghost's is paid (the after-midnight tick) → take the payment
 *   skip        — the night already has an equal-or-better record; drop the ghost's
 */
function planNightMerge(state) {
  const s = state || {};
  const attendance = (s.attendance && typeof s.attendance === 'object') ? s.attendance : {};
  const sessions = (s.sessions && typeof s.sessions === 'object') ? s.sessions : {};
  const plan = { merges: [], drops: [], warnings: [], strayDates: [], sessionDate: null };

  // The live session date is itself a casualty: the midnight cron parked it on
  // whatever calendar day it last fired on, which is usually an off day. Left
  // alone it would keep the ghost alive (and the merge below would delete the
  // attendance out from under the live day), so it moves back to its night too.
  if (Night.isStrayDate(s.sessionDate)) {
    plan.sessionDate = { from: s.sessionDate, to: Night.owningNight(s.sessionDate) };
  }

  for (const date of Object.keys(attendance).sort()) {
    if (!Night.isStrayDate(date)) continue;         // a real game night stays put
    const to = Night.owningNight(date);
    if (!to) { plan.warnings.push(date + ': no game night precedes it — left alone'); continue; }
    plan.strayDates.push(date);

    const from = attendance[date] || {};
    const fromEntries = (from.entries && typeof from.entries === 'object') ? from.entries : {};
    const target = attendance[to] || null;
    const targetEntries = (target && target.entries && typeof target.entries === 'object') ? target.entries : {};

    const entries = [];
    for (const pid of Object.keys(fromEntries).sort()) {
      const src = fromEntries[pid];
      if (!src) continue;
      const dst = targetEntries[pid];
      const name = (src && src.name) || (dst && dst.name) || pid;
      if (!dst) {
        entries.push({ playerId: pid, name, action: 'move', reason: 'no record on ' + to });
      } else if (hasPayment(src) && src.paid && !dst.paid) {
        entries.push({ playerId: pid, name, action: 'adopt-paid', reason: 'paid after midnight, landed on ' + date });
      } else {
        entries.push({ playerId: pid, name, action: 'skip', reason: dst.paid ? 'already paid on ' + to : 'duplicate of ' + to });
      }
    }
    plan.merges.push({
      from: date, to, entries,
      targetExists: !!target,
      carriedPayments: !!(from.payments && !(target && target.payments)),
      moved: entries.filter((e) => e.action === 'move').length,
      adopted: entries.filter((e) => e.action === 'adopt-paid').length,
      skipped: entries.filter((e) => e.action === 'skip').length,
    });

    // The ghost day usually also left a session snapshot. An empty one (the
    // fresh day the rollover created) is junk; one with real rounds played on
    // it is NOT — that would be an actual off-day game, so flag it for a human.
    const snap = sessions[date];
    if (snap) {
      const rounds = Array.isArray(snap.rounds) ? snap.rounds.length : 0;
      if (rounds === 0) plan.drops.push({ date, reason: 'empty session snapshot created by the midnight rollover' });
      else plan.warnings.push(date + ': session snapshot has ' + rounds + ' round(s) — a real game was played, left alone for review');
    }
  }
  return plan;
}

/**
 * Apply a plan produced by planNightMerge. Mutates `state` in place and returns
 * a summary. Re-planning after this returns an empty plan (idempotent).
 */
function applyNightMerge(state, plan) {
  const s = state || {};
  const attendance = s.attendance || (s.attendance = {});
  const sessions = s.sessions || {};
  const summary = { mergedDates: [], movedEntries: 0, adoptedPayments: 0, droppedSnapshots: 0, sessionDate: null };

  if (plan && plan.sessionDate && plan.sessionDate.to) {
    s.sessionDate = plan.sessionDate.to;
    summary.sessionDate = plan.sessionDate.from + ' → ' + plan.sessionDate.to;
  }

  for (const m of (plan && plan.merges) || []) {
    const from = attendance[m.from];
    if (!from) continue;
    const fromEntries = from.entries || {};
    if (!attendance[m.to]) attendance[m.to] = { entries: {} };
    const target = attendance[m.to];
    if (!target.entries) target.entries = {};

    for (const e of m.entries) {
      const src = fromEntries[e.playerId];
      if (!src) continue;
      if (e.action === 'move') {
        target.entries[e.playerId] = src;
        summary.movedEntries++;
      } else if (e.action === 'adopt-paid') {
        // Keep the night's own record but take the payment that was ticked
        // after midnight — that money was really collected for THIS night.
        target.entries[e.playerId] = Object.assign({}, target.entries[e.playerId], {
          paid: true,
          payment: src.payment,
        });
        summary.adoptedPayments++;
      }
    }
    if (m.carriedPayments && from.payments && !target.payments) target.payments = from.payments;
    if (from.updatedAt && (!target.updatedAt || from.updatedAt > target.updatedAt)) {
      target.updatedAt = from.updatedAt;
      target.updatedBy = from.updatedBy || target.updatedBy;
    }
    delete attendance[m.from];
    summary.mergedDates.push(m.from + ' → ' + m.to);
  }

  for (const d of (plan && plan.drops) || []) {
    if (sessions[d.date]) { delete sessions[d.date]; summary.droppedSnapshots++; }
  }
  return summary;
}

module.exports = { planNightMerge, applyNightMerge };
