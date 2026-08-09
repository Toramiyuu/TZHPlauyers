'use strict';
/*
 * weekly.js — server-side handlers for the Weekly Lucky Draw + attendance/payment,
 * plus the auto-draw sweep used by the cron. Also owns Monthly eligibility recompute
 * (it depends on the same attendance records).
 *
 * Pure draw/eligibility logic lives in public/weekly-draw.js and public/monthly-
 * eligibility.js (shared with the browser + unit-tested). This module wires those
 * into the {status, body, changed} handler contract and the audit log. Requiring the
 * public modules by static path is traced + bundled by Vercel's builder.
 */
const WD = require('../public/weekly-draw.js');
const ME = require('../public/monthly-eligibility.js');
const { pushAudit } = require('./audit.js');

const ATTENDANCE_RETENTION_DAYS = 100; // keep long enough for a whole prior month
const DEFAULT_WEEKLY_SETTINGS = {
  enabled: true,
  cutoff: { weekday: 3, time: '17:00' }, // Wed 17:00 MYT
  draw: { weekday: 3, time: '20:00' },   // Wed 20:00 MYT
};

const WEEKLY_ADMIN_ACTIONS = new Set([
  'setAttendance', 'seedAttendance', 'weeklyDraw', 'weeklyDrawSettings',
  'recomputeMonthly', 'setMonthlyOverride',
]);

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  if (!state.weeklyDraws || typeof state.weeklyDraws !== 'object' || Array.isArray(state.weeklyDraws)) state.weeklyDraws = {};
  if (!state.weeklySettings || typeof state.weeklySettings !== 'object') state.weeklySettings = { ...DEFAULT_WEEKLY_SETTINGS };
  if (!Array.isArray(state.roster)) state.roster = [];
  if (!state.regulars || typeof state.regulars !== 'object' || Array.isArray(state.regulars)) state.regulars = {};
}

/** Prune attendance + weeklyDraws entries older than the retention window. Pure-ish. */
function pruneWeeklyState(state, today) {
  today = today || todayISO();
  const cutoff = WD.addDaysISO(today, -ATTENDANCE_RETENTION_DAYS);
  for (const key of ['attendance', 'weeklyDraws']) {
    const obj = state && state[key];
    if (obj && typeof obj === 'object') {
      for (const d of Object.keys(obj)) { if (d < cutoff) delete obj[d]; }
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
  const next = {
    playerId,
    name: body.name || prev.name || playerId,
    present: body.present !== undefined ? !!body.present : !!prev.present,
    paid: body.paid !== undefined ? !!body.paid : !!prev.paid,
    source: prev.source || 'manual',
  };
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

function doWeeklyDraw(state, body) {
  const date = body && body.date;
  if (!isValidISO(date)) return { status: 400, body: { error: 'Invalid date.' }, changed: false };
  const day = state.attendance[date];
  const entries = (day && day.entries) || {};
  const existing = state.weeklyDraws[date] || null;

  // Rerun of a completed draw needs explicit confirmation.
  if (existing && existing.status === 'drawn' && !body.confirm) {
    return { status: 409, body: { error: 'This draw is already complete. Confirm to rerun.', needsConfirm: true }, changed: false };
  }

  const eligible = WD.eligibleFromAttendance(entries);
  if (!eligible.length) {
    return { status: 200, body: { ok: false, error: 'No eligible entries to draw.' }, changed: false };
  }
  const winner = WD.pickWinner(eligible, Math.random);
  const settings = WD.settingsOf(state.weeklySettings);
  const at = nowMs();
  const prevHistory = (existing && Array.isArray(existing.history)) ? existing.history : [];
  const rec = {
    date, weekday: WD.isoWeekday(date), status: 'drawn',
    closesAt: WD.closesAt(date, settings, offsetHours()),
    drawsAt: WD.drawsAt(date, settings, offsetHours()),
    eligible, eligibleCount: eligible.length,
    winner, drawnAt: at, drawnBy: 'admin',
    rerunCount: existing ? (existing.rerunCount || 0) + (existing.status === 'drawn' ? 1 : 0) : 0,
    history: [...prevHistory, { winner, at, by: 'admin', note: body.note || '' }],
    // Live-reveal descriptor for the viewer overlay (consumed client-side).
    spin: { id: 'wd_' + date + '_' + at, kind: 'weekly', date, winnerId: winner.playerId, winnerName: winner.name,
            entries: eligible.map((e) => e.name), startAt: at, durationMs: 4000 },
  };
  state.weeklyDraws[date] = rec;
  pushAudit(state, { action: 'weekly.draw', admin: 'admin', at,
    target: { type: 'weeklyDraw', id: date, label: 'Weekly draw ' + date },
    prevValue: existing && existing.winner ? existing.winner.name : null, newValue: winner.name,
    note: rec.rerunCount ? ('rerun #' + rec.rerunCount) : '' });
  return { status: 200, body: { ok: true, result: rec }, changed: true };
}

function doWeeklyDrawSettings(state, body) {
  ensureWeekly(state);
  const s = { ...state.weeklySettings };
  if (body.enabled !== undefined) s.enabled = !!body.enabled;
  for (const key of ['cutoff', 'draw']) {
    if (body[key] && typeof body[key] === 'object') {
      const cur = s[key] || {};
      const wd = body[key].weekday;
      const time = body[key].time;
      s[key] = {
        weekday: (wd !== undefined && Number.isInteger(Number(wd)) && wd >= 0 && wd <= 6) ? Number(wd) : cur.weekday,
        time: (typeof time === 'string' && TIME_RE.test(time)) ? time : cur.time,
      };
    }
  }
  state.weeklySettings = s;
  pushAudit(state, { action: 'weekly.settings', admin: 'admin', at: nowMs(),
    target: { type: 'weeklySettings', id: 'weekly', label: 'Weekly schedule' }, newValue: s });
  return { status: 200, body: { ok: true, weeklySettings: s }, changed: true };
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
      case 'weeklyDraw':        return doWeeklyDraw(state, body);
      case 'weeklyDrawSettings':return doWeeklyDrawSettings(state, body);
      case 'recomputeMonthly':  return doRecomputeMonthly(state, body);
      case 'setMonthlyOverride':return doSetMonthlyOverride(state, body);
      default:                  return { status: 400, body: { error: 'Unknown action.' }, changed: false };
    }
  } catch (e) {
    return { status: 400, body: { error: 'Invalid request.' }, changed: false };
  }
}

/**
 * Idempotent auto-draw sweep (called by the cron). Draws every session date whose
 * draw time has passed and that isn't already drawn, with >=1 eligible entry. Also
 * refreshes Monthly eligibility for the current month. Mutates `state`; returns
 * { drawn:[dates], changed }. Deterministic randomness/clock are injectable for tests.
 */
function sweepWeeklyDraws(state, opts) {
  opts = opts || {};
  ensureWeekly(state);
  const now = opts.nowMs != null ? opts.nowMs : nowMs();
  const off = opts.offsetHours != null ? opts.offsetHours : offsetHours();
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const settings = WD.settingsOf(state.weeklySettings);
  if (settings.enabled === false) return { drawn: [], changed: false };

  const dates = Object.keys(state.attendance || {}).sort();
  const drawn = [];
  let changed = false;
  for (const date of dates) {
    const existing = state.weeklyDraws[date];
    if (existing && existing.status === 'drawn') continue;        // idempotent
    if (!WD.isDrawable(date, settings, now, off)) continue;        // draw time not reached
    const entries = (state.attendance[date] && state.attendance[date].entries) || {};
    const eligible = WD.eligibleFromAttendance(entries);
    if (!eligible.length) continue;                                // nothing to draw; leave for admin
    const winner = WD.pickWinner(eligible, rng);
    const prevHistory = (existing && Array.isArray(existing.history)) ? existing.history : [];
    state.weeklyDraws[date] = {
      date, weekday: WD.isoWeekday(date), status: 'drawn',
      closesAt: WD.closesAt(date, settings, off), drawsAt: WD.drawsAt(date, settings, off),
      eligible, eligibleCount: eligible.length, winner, drawnAt: now, drawnBy: 'cron',
      rerunCount: existing ? (existing.rerunCount || 0) : 0,
      history: [...prevHistory, { winner, at: now, by: 'cron', note: '' }],
      spin: { id: 'wd_' + date + '_' + now, kind: 'weekly', date, winnerId: winner.playerId,
              winnerName: winner.name, entries: eligible.map((e) => e.name), startAt: now, durationMs: 4000 },
    };
    pushAudit(state, { action: 'weekly.draw', admin: 'cron', at: now,
      target: { type: 'weeklyDraw', id: date, label: 'Auto draw ' + date }, newValue: winner.name });
    drawn.push(date);
    changed = true;
  }
  // Keep Monthly eligibility current — but only when something actually warrants
  // it (a draw happened, or the cached eligibility is missing/for a stale month),
  // so an idle daily run stays a true no-op instead of rewriting state every day.
  const curMonth = monthOf(todayISO());
  const staleMonthly = !state.monthlyEligibility || state.monthlyEligibility.month !== curMonth;
  if ((drawn.length || staleMonthly) && recomputeMonthlyInto(state, curMonth, 'cron')) changed = true;
  return { drawn, changed };
}

module.exports = {
  ATTENDANCE_RETENTION_DAYS, DEFAULT_WEEKLY_SETTINGS,
  WEEKLY_ADMIN_ACTIONS, handleWeeklyAdminAction,
  sweepWeeklyDraws, pruneWeeklyState, recomputeMonthlyInto,
  // exposed for tests
  ensureWeekly, sessionPlayersFor, signupIdsFor,
};
