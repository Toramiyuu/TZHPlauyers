'use strict';
/*
 * payments.js — server-side handlers for per-player session payments.
 *
 * Pure record logic lives in public/payments.js (shared with the browser + unit-tested);
 * this module wires it into the {status, body, changed} handler contract and the audit
 * log, exactly like api/weekly.js. Records live INSIDE the attendance entries
 * (state.attendance[date].entries[playerId].payment) so the weekly/monthly draws keep
 * reading the same `paid` flag and the same privacy projection applies. The 100-day retention
 * skips any night that still has an unpaid record (weekly.js pruneWeeklyState), so a debt is
 * never lost before it is settled.
 *
 * Actions (admin-password gated by api/state.js):
 *   generatePayments {date}                       — "End of the day": idempotent, one record per session player
 *   setPayment {date, playerId, paid?, method?, tier?, fee?, resetFee?}
 * NOTE: never reuse the field name `password` here — the dispatcher strips it as admin auth.
 */
const P = require('../public/payments.js');
const { pushAudit } = require('./audit.js');
const W = require('./weekly.js');

const PAYMENT_ADMIN_ACTIONS = new Set(['generatePayments', 'setPayment']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidISO(s) { return typeof s === 'string' && ISO_RE.test(s); }
function monthOf(iso) { return String(iso).slice(0, 7); }
function bad(msg) { return { status: 400, body: { error: msg }, changed: false }; }

function doGeneratePayments(state, body, now) {
  const date = body && body.date;
  if (!isValidISO(date)) return bad('Invalid date.');
  const players = W.sessionPlayersFor(state, date);
  if (!players.length) {
    return { status: 200, body: { ok: false, error: 'No players in this session yet.', created: 0, existed: 0, total: 0, date }, changed: false };
  }
  const tier = P.feeTierForDate(state, date);
  const day = W.ensureDay(state, date);
  const r = P.generateInto(day.entries, players, tier, now);
  day.entries = r.entries;
  if (r.created > 0) {
    if (!day.payments) day.payments = { tier, generatedAt: now, generatedBy: 'admin' };
    day.updatedAt = now;
    day.updatedBy = 'admin';
    pushAudit(state, { action: 'payments.generate', admin: 'admin', at: now,
      target: { type: 'attendance', id: date, label: 'Payments ' + date },
      newValue: { created: r.created, existed: r.existed, tier } });
    // New entries default to present — keep Monthly eligibility fresh (same as setAttendance).
    W.recomputeMonthlyInto(state, monthOf(date), 'admin');
  }
  return {
    status: 200,
    body: { ok: true, created: r.created, existed: r.existed, total: r.created + r.existed, date, tier, entries: day.entries },
    changed: r.created > 0,
  };
}

function semantic(e) {
  const p = e.payment || {};
  return [!!e.paid, p.tier, p.fee, p.method || null, !!p.feeOverridden].join('|');
}

function doSetPayment(state, body, now) {
  const date = body && body.date;
  const playerId = body && body.playerId;
  if (!isValidISO(date)) return bad('Invalid date.');
  if (!playerId) return bad('Missing player.');
  const day = state.attendance[date];
  const prev = day && day.entries && day.entries[playerId];
  if (!prev || !prev.payment) {
    return { status: 404, body: { error: 'No payment record yet — press End of the day first.' }, changed: false };
  }
  let next = prev;
  if (body.tier !== undefined) {
    if (!P.isTier(body.tier)) return bad('Invalid fee tier.');
    next = P.applyTier(next, body.tier, now);
  }
  if (body.resetFee) next = P.resetFee(next, now);
  if (body.fee !== undefined) {
    const v = Number(body.fee);
    if (!P.isValidFee(v)) return bad('Invalid amount.');
    next = P.applyFeeOverride(next, v, now);
  }
  if (body.method !== undefined) {
    if (body.method !== null && !P.isMethod(body.method)) return bad('Invalid payment method.');
    next = P.applyMethod(next, body.method, now);
  }
  if (body.paid !== undefined) next = P.applyPaid(next, !!body.paid, now, 'admin');

  if (semantic(prev) === semantic(next)) {
    return { status: 200, body: { ok: true, entry: prev, unchanged: true }, changed: false };
  }
  const target = { type: 'payment', id: date + ':' + playerId, label: (next.name || playerId) + ' ' + date };
  const pp = prev.payment, np = next.payment;
  if (prev.paid !== next.paid) {
    pushAudit(state, { action: 'payment.paid', admin: 'admin', at: now, target, prevValue: !!prev.paid, newValue: !!next.paid, note: np.method || '' });
  }
  if ((pp.method || null) !== (np.method || null)) {
    pushAudit(state, { action: 'payment.method', admin: 'admin', at: now, target, prevValue: pp.method || null, newValue: np.method || null });
  }
  if (pp.tier !== np.tier) {
    pushAudit(state, { action: 'payment.tier', admin: 'admin', at: now, target, prevValue: pp.tier, newValue: np.tier });
  }
  if (pp.fee !== np.fee) {
    pushAudit(state, { action: 'payment.fee', admin: 'admin', at: now, target, prevValue: pp.fee, newValue: np.fee, note: np.feeOverridden ? 'override' : 'tier' });
  }
  day.entries[playerId] = next;
  day.updatedAt = now;
  day.updatedBy = 'admin';
  // A paid change affects Monthly eligibility (present && paid) — same hook as setAttendance.
  if (prev.paid !== next.paid) W.recomputeMonthlyInto(state, monthOf(date), 'admin');
  return { status: 200, body: { ok: true, entry: next }, changed: true };
}

/** Dispatcher entry. `opts.nowMs` is injectable so tests can assert paidAt exactly. */
function handlePaymentAdminAction(state, body, opts) {
  try {
    if (!state || typeof state !== 'object') return bad('Invalid request.');
    W.ensureWeekly(state);
    const now = (opts && opts.nowMs != null) ? Number(opts.nowMs) : Date.now();
    switch (body && body.action) {
      case 'generatePayments': return doGeneratePayments(state, body, now);
      case 'setPayment':       return doSetPayment(state, body, now);
      default:                 return bad('Unknown action.');
    }
  } catch (e) {
    return bad('Invalid request.');
  }
}

module.exports = { PAYMENT_ADMIN_ACTIONS, handlePaymentAdminAction };
