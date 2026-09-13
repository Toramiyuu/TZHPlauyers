/*
 * draw-hub.js — pure view-model logic for the three-way Lucky Draw split.
 *
 * The Lucky Draw page is a hub of three separate draws, each with its own page:
 *
 *   session      — every session night. Play and pay within the window; winners
 *                  are drawn automatically at 09:00 MYT (see session-draw.js).
 *   monthly      — reach the points threshold in a calendar month (monthly-lucky.js).
 *   shuttlecock  — the ballot draw run by the admin once a month; players are
 *                  auto-enrolled by full attendance + payment of their regular day.
 *
 * Everything here is pure: inputs are the payloads the page already holds
 * (GET /api/draws, the public state poll, the member's own `accountDrawInfo`)
 * and `nowMs` is always injected, so every function is deterministic under test.
 * No DOM, no clock, no markup — index.html turns these view-models into HTML.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.DrawHub = api;                                             // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KINDS = ['session', 'monthly', 'shuttlecock'];
  // Display name + the one-line "how you get in" that rides every card and
  // header. Monthly and Shuttlecock BOTH run monthly, so the entry line is the
  // only thing that tells them apart at a glance — it is never optional.
  const META = {
    session: { key: 'session', name: 'Session Draw', short: 'Session', entry: 'Play and pay a session' },
    monthly: { key: 'monthly', name: 'Monthly Draw', short: 'Monthly', entry: 'Reach the points target in a month' },
    shuttlecock: { key: 'shuttlecock', name: 'Shuttlecock Draw', short: 'Shuttlecock', entry: 'Attend and pay every session of your regular day' },
  };

  const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;

  function arr(v) { return Array.isArray(v) ? v : []; }
  function num(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : (dflt || 0); }
  function isKind(k) { return KINDS.indexOf(String(k)) !== -1; }
  function kindName(k) { return (META[k] || {}).name || ''; }

  /** The entry line for a kind; Monthly folds in the live threshold when known. */
  function entryLine(kind, opts) {
    const o = opts || {};
    if (kind === 'monthly') {
      const t = num(o.threshold, 0);
      return t > 0 ? 'Reach ' + t + ' points in a month' : META.monthly.entry;
    }
    return (META[kind] || {}).entry || '';
  }

  // ── countdown ────────────────────────────────────────────────────────
  /**
   * "2d 14h" / "14h 03m" / "3m 20s" — the largest two units, so the string
   * never jitters in width mid-second. Empty when there is no scheduled time.
   */
  function countdownText(nowMs, atMs) {
    const at = Number(atMs);
    if (!Number.isFinite(at) || at <= 0) return '';
    const diff = at - num(nowMs, 0);
    if (diff <= 0) return 'any moment now';
    const d = Math.floor(diff / DAY);
    const h = Math.floor((diff % DAY) / HOUR);
    const m = Math.floor((diff % HOUR) / MINUTE);
    const s = Math.floor((diff % MINUTE) / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    if (d >= 1) return d + 'd ' + pad(h) + 'h';
    if (h >= 1) return h + 'h ' + pad(m) + 'm';
    return m + 'm ' + pad(s) + 's';
  }

  /** "12 in the draw" / "1 in the draw" / "" when the count is not known yet. */
  function poolLine(n, word) {
    const c = num(n, 0);
    if (c <= 0) return '';
    return c + ' ' + (word || 'in the draw');
  }

  // ── per-draw status (the "status first" card at the top of each page) ──
  /**
   * The session draw people are waiting on: the earliest un-drawn session still
   * ahead of `nowMs`, else the most recent one already past its draw time.
   */
  function nextSession(sessions, nowMs) {
    const now = num(nowMs, 0);
    const pending = arr(sessions).filter((s) => s && s.status !== 'done' && Number.isFinite(Number(s.drawAt)));
    pending.sort((a, b) => num(a.drawAt, 0) - num(b.drawAt, 0));
    return pending.find((s) => num(s.drawAt, 0) > now) || pending[pending.length - 1] || null;
  }

  /** The signed-in member's own standing in a given session night. Null when signed out. */
  function sessionMine(me, date) {
    if (!me) return null;
    const row = arr(me.weekly).find((r) => r && r.date === date);
    if (!row) return { tone: 'wait', text: 'Play this session to enter' };
    if (row.present && row.paid) return { tone: 'ok', text: 'You’re in' };
    if (row.present) return { tone: 'warn', text: 'Pay to enter' };
    return { tone: 'off', text: 'Not in this draw' };
  }

  function sessionStatus(view, me, nowMs) {
    const v = view || {};
    const now = num(nowMs, 0);
    const next = nextSession(v.sessions, now);
    return {
      kind: 'session',
      date: next ? next.date : '',
      drawAt: next ? num(next.drawAt, 0) : 0,
      due: !!(next && num(next.drawAt, 0) <= now),
      poolCount: next ? num(next.counts && next.counts.eligible, 0) : 0,
      winners: num(v.winnersPerDraw, 0),
      prize: typeof v.sessionPrize === 'string' ? v.sessionPrize : '',
      mine: next ? sessionMine(me, next.date) : (me ? { tone: 'wait', text: 'Play a session to enter' } : null),
    };
  }

  function monthlyStatus(monthly, myPoints, nowMs) {
    if (!monthly || typeof monthly !== 'object') return null;
    const months = arr(monthly.months);
    const live = months.find((v) => v && v.month === monthly.pointsMonth && v.status !== 'done') || null;
    const threshold = num(monthly.threshold, 0);
    let mine = null;
    if (myPoints != null) {
      const points = num(myPoints, 0);
      const toGo = Math.max(0, threshold - points);
      mine = toGo === 0
        ? { tone: 'ok', text: 'You’re in', points, threshold, toGo: 0 }
        : { tone: 'warn', text: toGo + ' more point' + (toGo === 1 ? '' : 's') + ' to enter', points, threshold, toGo };
    }
    return {
      kind: 'monthly',
      month: live ? live.month : (monthly.pointsMonth || ''),
      label: live ? live.label : '',
      // Only an automatic month has a real scheduled instant to count down to.
      drawAt: live && monthly.auto ? num(live.drawAt, 0) : 0,
      auto: !!monthly.auto,
      poolCount: live ? num(live.counts && live.counts.eligible, 0) : 0,
      threshold,
      prizes: arr(monthly.prizes),
      mine,
    };
  }

  /**
   * The Shuttlecock ballot. It has no scheduled instant — the admin runs it once
   * a month — so the card leads with enrolment instead of a countdown.
   */
  function shuttleStatus(md, meMonthly, nowMs) {
    const d = md && typeof md === 'object' ? md : {};
    const now = num(nowMs, 0);
    const drawn = arr(d.results).filter((r) => r && r.name && num(r.at, 0) > 0 && num(r.at, 0) <= now);
    let mine = null;
    if (meMonthly) {
      const attended = num(meMonthly.attendedCount, 0), required = num(meMonthly.requiredCount, 0);
      mine = meMonthly.eligible
        ? { tone: 'ok', text: 'Enrolled', attended, required, reason: '' }
        : { tone: 'warn', text: 'Not enrolled yet', attended, required, reason: meMonthly.reason || '' };
    }
    return {
      kind: 'shuttlecock',
      month: d.month || '',
      poolCount: arr(d.participants).filter((p) => p && p.name).length,
      drawnCount: drawn.length,
      prizes: arr(d.prizes),
      mine,
    };
  }

  // ── "last winner" for the hub cards ──────────────────────────────────
  /** "Ah Sheng" / "Ah Sheng + 2 more" — social proof that the draws pay out. */
  function winnerLine(names) {
    const list = arr(names).map((n) => String(n || '').trim()).filter(Boolean);
    if (!list.length) return '';
    return list.length === 1 ? list[0] : list[0] + ' + ' + (list.length - 1) + ' more';
  }

  function latestSessionWin(sessions) {
    const done = arr(sessions).filter((s) => s && s.status === 'done' && arr(s.lists && s.lists.winners).length);
    if (!done.length) return null;
    done.sort((a, b) => num(b.drawnAt, 0) - num(a.drawnAt, 0));
    const s = done[0];
    return { names: arr(s.lists.winners).map((w) => w && w.name).filter(Boolean), date: s.date, at: num(s.drawnAt, 0) };
  }

  function latestMonthlyWin(monthly) {
    const done = arr(monthly && monthly.months).filter((v) => v && v.status === 'done' && arr(v.lists && v.lists.winners).length);
    if (!done.length) return null;
    done.sort((a, b) => num(b.drawnAt, 0) - num(a.drawnAt, 0));
    const v = done[0];
    return { names: arr(v.lists.winners).map((w) => w && w.name).filter(Boolean), label: v.label || '', at: num(v.drawnAt, 0) };
  }

  function latestShuttleWin(entries) {
    const list = arr(entries).filter((e) => e && arr(e.winners).length);
    if (!list.length) return null;
    list.sort((a, b) => num(b.at, 0) - num(a.at, 0));
    const e = list[0];
    return { names: arr(e.winners).map((w) => w && w.name).filter(Boolean), label: e.label || '', at: num(e.at, 0) };
  }

  return {
    KINDS, META, MINUTE, HOUR, DAY,
    isKind, kindName, entryLine, countdownText, poolLine,
    nextSession, sessionMine, sessionStatus, monthlyStatus, shuttleStatus,
    winnerLine, latestSessionWin, latestMonthlyWin, latestShuttleWin,
  };
});
