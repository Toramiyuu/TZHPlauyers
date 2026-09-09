'use strict';
/*
 * weekly.js — server-side handlers for per-session attendance records, plus the
 * Monthly eligibility recompute (it depends on the same attendance records).
 * The Weekly Lucky Draw that used to live here was retired in 2026-09 in favour
 * of the automatic per-session draw (api/session-draw.js).
 *
 * Pure helpers live in public/weekly-draw.js (candidate list, ISO date maths) and
 * public/monthly-eligibility.js (shared with the browser + unit-tested). This
 * module wires those into the {status, body, changed} handler contract and the
 * audit log. Requiring the public modules by static path is traced + bundled by
 * Vercel's builder.
 */
const WD = require('../public/weekly-draw.js');
const ME = require('../public/monthly-eligibility.js');
const P = require('../public/payments.js');
const { pushAudit } = require('./audit.js');

const ATTENDANCE_RETENTION_DAYS = 100; // keep long enough for a whole prior month

const WEEKLY_ADMIN_ACTIONS = new Set([
  'setAttendance', 'seedAttendance',
  'recomputeMonthly', 'setMonthlyOverride',
]);

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function offsetHours() { return parseFloat(process.env.TZ_OFFSET_HOURS || '8'); }
function nowMs() { return Date.now(); }
function todayISO() {
  const d = new Date(Date.now() + offsetHours() * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function monthOf(iso) { return String(iso).slice(0, 7); }
function isValidISO(s) { return typeof s === 'string' && ISO_RE.test(s); }

function ensureWeekly(state) {
  if (!state.attendance || typeof state.attendance !== 'object' || Array.isArray(state.attendance)) state.attendance = {};
  if (!Array.isArray(state.roster)) state.roster = [];
  if (!state.regulars || typeof state.regulars !== 'object' || Array.isArray(state.regulars)) state.regulars = {};
}

/**
 * Prune attendance entries older than the retention window. Pure-ish.
 * A night that still has an UNPAID payment record is kept regardless of age: the debt stays
 * visible in the Payments "By member" ledger until it is settled, and only then falls away.
 * (Session draw results are permanent and live in their own store — never pruned.)
 */
function pruneWeeklyState(state, today) {
  today = today || todayISO();
  const cutoff = WD.addDaysISO(today, -ATTENDANCE_RETENTION_DAYS);
  const obj = state && state.attendance;
  if (obj && typeof obj === 'object') {
    for (const d of Object.keys(obj)) {
      if (d >= cutoff) continue;
      if (P.dayHasOutstanding(obj[d])) continue;
      delete obj[d];
    }
  }
  return state;
}

// ── attendance day helpers ───────────────────────────────────────────
function ensureDay(state, date) {
  if (!state.attendance[date]) {
    state.attendance[date] = { date, weekday: WD.isoWeekday(date), updatedAt: 0, entries: {} };
  }
  return state.attendance[date];
}

// Session players for a date: the live players if it's the current day, else the
// saved session snapshot. Used to seed the candidate list.
function sessionPlayersFor(state, date) {
  if (date === state.sessionDate) return Array.isArray(state.players) ? state.players : [];
  const snap = state.sessions && state.sessions[date];
  return snap && Array.isArray(snap.players) ? snap.players : [];
}

// Roster ids whose signup covers this date (matched by name, case-insensitive).
function signupIdsFor(state, date) {
  const signups = Array.isArray(state.signups) ? state.signups : [];
  const roster = Array.isArray(state.roster) ? state.roster : [];
  const byName = new Map(roster.map((r) => [String(r.name || '').trim().toLowerCase(), r.id]));
  const ids = [];
  for (const s of signups) {
    if (!s || !Array.isArray(s.dates) || s.dates.indexOf(date) === -1) continue;
    const id = byName.get(String(s.name || '').trim().toLowerCase());
    if (id) ids.push(id);
  }
  return ids;
}

// ── Monthly eligibility recompute (shared) ───────────────────────────
function recomputeMonthlyInto(state, month, by) {
  if (!MONTH_RE.test(String(month || ''))) return false;
  const prev = state.monthlyEligibility && state.monthlyEligibility.month === month
    ? state.monthlyEligibility.players : [];
  const elig = ME.computeMonthEligibility({
    roster: state.roster, regulars: state.regulars, attendance: state.attendance,
    month, todayISO: todayISO(), prevPlayers: prev, computedBy: by || 'admin', nowMs: nowMs(),
  });
  state.monthlyEligibility = elig;
  // Feed the existing ballot: merge auto-eligible players into participants.
  if (state.monthlyDraw && typeof state.monthlyDraw === 'object') {
    // Only auto-merge into the CURRENT open month to avoid clobbering a closed draw.
    if (!state.monthlyDraw.month || state.monthlyDraw.month === month) {
      state.monthlyDraw = {
        ...state.monthlyDraw,
        participants: ME.mergeEligibilityIntoParticipants(state.monthlyDraw.participants, elig.players),
      };
    }
  }
  return true;
}

// ── action handlers ──────────────────────────────────────────────────
function doSetAttendance(state, body) {
  const date = body && body.date;
  const playerId = body && body.playerId;
  if (!isValidISO(date)) return { status: 400, body: { error: 'Invalid date.' }, changed: false };
  if (!playerId) return { status: 400, body: { error: 'Missing player.' }, changed: false };
  const day = ensureDay(state, date);
  const prev = day.entries[playerId] || { playerId, name: body.name || playerId, present: false, paid: false, source: 'manual' };
  let next = {
    playerId,
    name: body.name || prev.name || playerId,
    present: body.present !== undefined ? !!body.present : !!prev.present,
    paid: body.paid !== undefined ? !!body.paid : !!prev.paid,
    source: prev.source || 'manual',
  };
  // The payment record (api/payments.js) rides along with the entry — never drop it —
  // and a paid flip from this checkbox stamps/clears paidAt so the Payments tab agrees.
  if (prev.payment) {
    next.payment = prev.payment;
    if (!!prev.paid !== next.paid) next = P.applyPaid(next, next.paid, nowMs(), 'admin');
  }
  day.entries[playerId] = next;
  day.updatedAt = nowMs();
  day.updatedBy = 'admin';
  if (prev.present !== next.present) {
    pushAudit(state, { action: 'attendance.present', admin: 'admin', at: nowMs(),
      target: { type: 'attendance', id: date + ':' + playerId, label: next.name + ' ' + date },
      prevValue: prev.present, newValue: next.present });
  }
  if (prev.paid !== next.paid) {
    pushAudit(state, { action: 'attendance.paid', admin: 'admin', at: nowMs(),
      target: { type: 'attendance', id: date + ':' + playerId, label: next.name + ' ' + date },
      prevValue: prev.paid, newValue: next.paid });
  }
  // Corrections auto-recompute this date's month so Monthly eligibility stays fresh.
  recomputeMonthlyInto(state, monthOf(date), 'admin');
  return { status: 200, body: { ok: true, entry: next }, changed: true };
}

function doSeedAttendance(state, body) {
  const date = body && body.date;
  if (!isValidISO(date)) return { status: 400, body: { error: 'Invalid date.' }, changed: false };
  const weekday = WD.isoWeekday(date);
  const candidates = WD.candidateList(state.regulars, weekday, sessionPlayersFor(state, date), state.roster, signupIdsFor(state, date));
  const day = ensureDay(state, date);
  let added = 0;
  for (const c of candidates) {
    if (day.entries[c.playerId]) continue; // never overwrite an existing record
    day.entries[c.playerId] = {
      playerId: c.playerId, name: c.name,
      present: c.source === 'session', // showed up in the session = present by default
      paid: false, source: c.source,
    };
    added++;
  }
  day.updatedAt = nowMs();
  pushAudit(state, { action: 'attendance.seed', admin: 'admin', at: nowMs(),
    target: { type: 'attendance', id: date, label: 'Seed ' + date }, newValue: added });
  return { status: 200, body: { ok: true, added, entries: day.entries }, changed: true };
}

function doRecomputeMonthly(state, body) {
  const month = (body && body.month) || monthOf(todayISO());
  if (!recomputeMonthlyInto(state, month, 'admin')) {
    return { status: 400, body: { error: 'Invalid month.' }, changed: false };
  }
  pushAudit(state, { action: 'monthly.recompute', admin: 'admin', at: nowMs(),
    target: { type: 'monthlyEligibility', id: month, label: 'Monthly eligibility ' + month } });
  return { status: 200, body: { ok: true, monthlyEligibility: state.monthlyEligibility }, changed: true };
}

function doSetMonthlyOverride(state, body) {
  const month = body && body.month;
  const playerId = body && body.playerId;
  if (!MONTH_RE.test(String(month || '')) || !playerId) {
    return { status: 400, body: { error: 'Invalid override.' }, changed: false };
  }
  if (!state.monthlyEligibility || state.monthlyEligibility.month !== month) {
    recomputeMonthlyInto(state, month, 'admin');
  }
  const rec = state.monthlyEligibility && state.monthlyEligibility.players.find((p) => p.playerId === playerId);
  if (!rec) return { status: 404, body: { error: 'Player not in eligibility list.' }, changed: false };
  const prev = rec.override ? rec.override.eligible : null;
  rec.override = (body.eligible === null || body.eligible === undefined)
    ? null
    : { eligible: !!body.eligible, by: 'admin', at: nowMs(), reason: body.reason || '' };
  // Re-merge participants to reflect the override.
  if (state.monthlyDraw && (!state.monthlyDraw.month || state.monthlyDraw.month === month)) {
    state.monthlyDraw = {
      ...state.monthlyDraw,
      participants: ME.mergeEligibilityIntoParticipants(state.monthlyDraw.participants, state.monthlyEligibility.players),
    };
  }
  pushAudit(state, { action: 'monthly.override', admin: 'admin', at: nowMs(),
    target: { type: 'monthlyEligibility', id: month + ':' + playerId, label: (rec.name || playerId) + ' ' + month },
    prevValue: prev, newValue: rec.override ? rec.override.eligible : null, note: body.reason || '' });
  return { status: 200, body: { ok: true, player: rec }, changed: true };
}

function handleWeeklyAdminAction(state, body) {
  try {
    if (!state || typeof state !== 'object') return { status: 400, body: { error: 'Invalid request.' }, changed: false };
    ensureWeekly(state);
    switch (body && body.action) {
      case 'setAttendance':     return doSetAttendance(state, body);
      case 'seedAttendance':    return doSeedAttendance(state, body);
      case 'recomputeMonthly':  return doRecomputeMonthly(state, body);
      case 'setMonthlyOverride':return doSetMonthlyOverride(state, body);
      default:                  return { status: 400, body: { error: 'Unknown action.' }, changed: false };
    }
  } catch (e) {
    return { status: 400, body: { error: 'Invalid request.' }, changed: false };
  }
}

module.exports = {
  ATTENDANCE_RETENTION_DAYS,
  WEEKLY_ADMIN_ACTIONS, handleWeeklyAdminAction,
  pruneWeeklyState, recomputeMonthlyInto,
  // exposed for tests
  ensureWeekly, ensureDay, sessionPlayersFor, signupIdsFor,
};
