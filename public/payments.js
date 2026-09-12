/*
 * payments.js — pure logic for per-player session payments.
 * Loaded in the browser via <script src> (window.Payments) and required by lib/payments.js
 * and the Node tests. No dependencies, no DOM, no clock: `nowMs` is ALWAYS injected so every
 * function is deterministic under test.
 *
 * Model: ONE record per player per session night, nested as `payment` inside the existing
 * attendance entry — state.attendance[date].entries[playerId]. The map key IS the uniqueness
 * constraint. `entry.paid` stays the single paid flag the weekly + monthly draws already read;
 * `payment` adds fee / tier / method / paidAt / markedBy:
 *
 *   entry = { playerId, name, present, paid, source,
 *             payment: { fee, tier:'2h'|'3h', method:null|'cash'|'tng'|'duitnow', paidAt:null|ms(UTC),
 *                        markedBy:null|'admin', feeOverridden, createdAt, updatedAt } }
 *
 * Timestamps are epoch ms (UTC instants); display helpers render Asia/Kuala_Lumpur.
 * Future readers (lucky draw "paid within N days", member points) should use paidWithin() /
 * summarize() / rowsOf() rather than reaching into the record shape.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.Payments = api;                                             // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── enums / constants ────────────────────────────────────────────────
  const TIERS = ['2h', '3h'];
  const DEFAULT_TIER = '3h';
  const FEE_BY_TIER = { '2h': 20, '3h': 25 };
  // Add a method here (and a label) and the 3-state row control grows a segment.
  const METHODS = ['cash', 'tng', 'duitnow'];
  const METHOD_LABELS = { cash: 'Cash', tng: 'TnG', duitnow: 'DuitNow' };
  const MAX_FEE = 999;
  const DEFAULT_OFFSET_HOURS = 8; // Malaysia, no DST
  const TIME_ZONE = 'Asia/Kuala_Lumpur';
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function isTier(t) { return TIERS.indexOf(t) !== -1; }
  function isMethod(m) { return METHODS.indexOf(m) !== -1; }
  function tierOf(x) { return isTier(x) ? x : DEFAULT_TIER; }
  function feeForTier(tier) { return FEE_BY_TIER[tierOf(tier)]; }
  function methodLabel(m) { return METHOD_LABELS[m] || (m ? String(m) : ''); }
  function isValidFee(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_FEE; }
  function roundFee(v) { return Math.round(Number(v) * 100) / 100; }
  function ms(n) { return Number(n) || 0; }

  // ── record construction / transitions (all pure: return copies) ──────
  function newPayment(tier, nowMs) {
    const t = tierOf(tier);
    const at = ms(nowMs);
    return { fee: feeForTier(t), tier: t, method: null, paidAt: null, markedBy: null, feeOverridden: false, createdAt: at, updatedAt: at };
  }

  function clone(entry) {
    const e = Object.assign({}, entry || {});
    if (e.payment) e.payment = Object.assign({}, e.payment);
    return e;
  }

  /**
   * Flip the paid flag. With a payment record: stamps paidAt + markedBy on the way to paid
   * (an existing paidAt is preserved), and clears paidAt / markedBy / method on the way to
   * unpaid ("method is nullable until paid"). Without a record only the flag changes.
   */
  function applyPaid(entry, paid, nowMs, by) {
    const e = clone(entry);
    const next = !!paid;
    e.paid = next;
    if (e.payment) {
      const p = e.payment;
      if (next) {
        if (!p.paidAt) { p.paidAt = ms(nowMs); p.markedBy = by || 'admin'; }
      } else {
        p.paidAt = null; p.markedBy = null; p.method = null;
      }
      p.updatedAt = ms(nowMs);
    }
    return e;
  }

  function applyMethod(entry, method, nowMs) {
    const e = clone(entry);
    if (!e.payment) return e;
    e.payment.method = method == null ? null : method;
    e.payment.updatedAt = ms(nowMs);
    return e;
  }

  /** Change the tier; the amount follows the tier unless the admin overrode it. */
  function applyTier(entry, tier, nowMs) {
    const e = clone(entry);
    if (!e.payment) return e;
    const t = tierOf(tier);
    e.payment.tier = t;
    if (!e.payment.feeOverridden) e.payment.fee = feeForTier(t);
    e.payment.updatedAt = ms(nowMs);
    return e;
  }

  /** Manual amount for one player. Setting it back to the tier amount clears the override. */
  function applyFeeOverride(entry, fee, nowMs) {
    const e = clone(entry);
    if (!e.payment) return e;
    const v = roundFee(fee);
    e.payment.fee = v;
    e.payment.feeOverridden = v !== feeForTier(e.payment.tier);
    e.payment.updatedAt = ms(nowMs);
    return e;
  }

  function resetFee(entry, nowMs) {
    const e = clone(entry);
    if (!e.payment) return e;
    e.payment.fee = feeForTier(e.payment.tier);
    e.payment.feeOverridden = false;
    e.payment.updatedAt = ms(nowMs);
    return e;
  }

  /**
   * "End of the day": make sure every session player has a payment record at `tier`.
   * Idempotent — entries that already have a record are counted in `existed` and left
   * byte-for-byte untouched; a pre-existing attendance entry without a record keeps its
   * present/paid and only gains `payment` (paid-already entries get paidAt = now).
   * Returns a fresh entries map; the input is never mutated.
   */
  function generateInto(entries, players, tier, nowMs) {
    const out = Object.assign({}, entries || {});
    const t = tierOf(tier);
    const at = ms(nowMs);
    const seen = new Set();
    let created = 0, existed = 0;
    for (const p of (Array.isArray(players) ? players : [])) {
      const id = p && p.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const prev = out[id];
      if (prev && prev.payment) { existed++; continue; }
      const e = prev ? clone(prev) : { playerId: id, name: p.name || id, present: true, paid: false, source: 'session' };
      e.payment = newPayment(t, at);
      if (e.paid) { e.payment.paidAt = at; e.payment.markedBy = 'admin'; }
      out[id] = e;
      created++;
    }
    return { entries: out, created, existed };
  }

  /**
   * Second press of "End of the day": drop the records of players who were UNTICKED
   * from the line-up since the first press. Only records End of the day itself
   * created (source 'session') that are still unpaid are removed — a paid record
   * proves the player was there, and a manually marked attendance is admin intent.
   * Pure. Returns { entries, removed:[{id,name}], keptPaid:[{id,name}] }.
   */
  function reconcileInto(entries, players) {
    const out = Object.assign({}, entries || {});
    const inLineup = new Set((Array.isArray(players) ? players : []).map((p) => p && p.id).filter(Boolean));
    const removed = [], keptPaid = [];
    for (const id of Object.keys(out)) {
      const e = out[id];
      if (!e || !e.payment || inLineup.has(id) || e.source !== 'session') continue;
      if (e.paid) { keptPaid.push({ id, name: e.name || id }); continue; }
      removed.push({ id, name: e.name || id });
      delete out[id];
    }
    return { entries: out, removed, keptPaid };
  }

  // ── reads ────────────────────────────────────────────────────────────
  function listOf(entries) { return Array.isArray(entries) ? entries : Object.values(entries || {}); }
  function withPayment(entries) { return listOf(entries).filter((e) => e && e.payment); }

  /** Running totals for the list header. Only entries with a payment record count.
   *  expected = sum of every fee owed tonight; collected = the paid part; outstanding = the rest. */
  function summarize(entries) {
    let players = 0, paid = 0, collected = 0, expected = 0;
    for (const e of withPayment(entries)) {
      players++;
      const fee = Number(e.payment.fee) || 0;
      expected += fee;
      if (e.paid) { paid++; collected += fee; }
    }
    return { players, paid, unpaid: players - paid, collected: roundFee(collected), expected: roundFee(expected), outstanding: roundFee(expected - collected) };
  }

  /** List filters, in display order: all / unpaid / paid / one per method. */
  const FILTERS = ['all', 'unpaid', 'paid'].concat(METHODS);
  const FILTER_LABELS = { all: 'All', unpaid: 'Unpaid', paid: 'Paid' };
  function isFilter(f) { return FILTERS.indexOf(f) !== -1; }
  function filterLabel(f) { return FILTER_LABELS[f] || methodLabel(f); }
  function matchesFilter(e, f) {
    if (f === 'unpaid') return !e.paid;
    if (f === 'paid') return !!e.paid;
    if (isMethod(f)) return !!e.paid && e.payment.method === f;
    return true; // 'all' / unknown
  }

  function compareNames(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  }

  /** Rows for the list: unpaid first (so who still owes is at the top), paid sink to the bottom; name order within each group. */
  function rowsOf(entries, opts) {
    const f = opts && opts.unpaidOnly ? 'unpaid' : ((opts && opts.filter) || 'all');
    return withPayment(entries)
      .filter((e) => matchesFilter(e, f))
      .sort((a, b) => (!!a.paid - !!b.paid) || compareNames(a, b));
  }

  /** Paid players grouped by method, in METHODS order (+ 'other' when a paid row has no method). */
  function breakdownByMethod(entries) {
    const rows = METHODS.map((m) => ({ method: m, label: methodLabel(m), count: 0, amount: 0, names: [] }));
    const other = { method: 'other', label: 'Unspecified', count: 0, amount: 0, names: [] };
    for (const e of rowsOf(entries, { filter: 'paid' })) {
      const r = rows.find((x) => x.method === e.payment.method) || other;
      r.count++;
      r.amount = roundFee(r.amount + (Number(e.payment.fee) || 0));
      r.names.push(e.name || e.playerId);
    }
    return other.count ? rows.concat([other]) : rows;
  }

  /** Names of everyone with a record who hasn't paid, in name order. */
  function unpaidNames(entries) {
    return rowsOf(entries, { filter: 'unpaid' }).map((e) => e.name || e.playerId);
  }

  /** 3-state row control → server patch. tap ∈ 'unpaid' | one of METHODS. null = unknown tap. */
  function nextPaymentPatch(entry, tap) {
    if (tap === 'unpaid') return { paid: false, method: null };
    if (isMethod(tap)) return { paid: true, method: tap };
    return null;
  }

  /** True when applying `patch` to `entry` would change nothing (skip the round-trip). */
  function isNoopPatch(entry, patch) {
    if (!entry || !patch) return true;
    const p = entry.payment || {};
    if (patch.paid !== undefined && !!patch.paid !== !!entry.paid) return false;
    if (patch.method !== undefined && (patch.method || null) !== (p.method || null)) return false;
    if (patch.tier !== undefined && patch.tier !== p.tier) return false;
    if (patch.fee !== undefined && roundFee(patch.fee) !== p.fee) return false;
    if (patch.resetFee && (p.feeOverridden || p.fee !== feeForTier(p.tier))) return false;
    return true;
  }

  /** Session dates that have at least one payment record, newest first. */
  function datesWithPayments(attendance) {
    const att = attendance && typeof attendance === 'object' ? attendance : {};
    return Object.keys(att)
      .filter((d) => withPayment(att[d] && att[d].entries).length > 0)
      .sort()
      .reverse();
  }

  /** Step through a newest-first date list. dir +1 = newer, -1 = older. null at the ends. */
  function stepDate(dates, current, dir) {
    const list = Array.isArray(dates) ? dates : [];
    const i = list.indexOf(current);
    if (i === -1) return list[0] || null;
    const j = i - (Number(dir) || 0);
    return (j < 0 || j >= list.length) ? null : list[j];
  }

  /** The fee tier a session runs on: live setting for the current day, else the saved snapshot's. */
  function feeTierForDate(state, date) {
    const s = state || {};
    if (date && date === s.sessionDate) return tierOf(s.feeTier);
    const snap = s.sessions && s.sessions[date];
    return tierOf(snap && snap.feeTier);
  }

  // ── per-member ledger (Payments tab "By member" view) ────────────────
  /** True when any payment record on this attendance day is still unpaid. Such a night must
   *  never be pruned by the retention window — the debt would silently vanish. */
  function dayHasOutstanding(day) {
    return withPayment(day && day.entries).some((e) => !e.paid);
  }

  /** Every payment record for one player across all nights, newest first: { date, entry }. */
  function memberSessions(attendance, playerId) {
    const att = attendance && typeof attendance === 'object' ? attendance : {};
    const out = [];
    for (const d of Object.keys(att)) {
      const day = att[d];
      const e = day && day.entries && day.entries[playerId];
      if (e && e.payment) out.push({ date: d, entry: e });
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  /**
   * One player's ledger: the nights they still owe (newest first) and the nights they've
   * settled. `name` is the roster name; falls back to the name stored on the records.
   */
  function memberSummary(attendance, playerId, name) {
    const sessions = memberSessions(attendance, playerId);
    const owing = [], settled = [];
    let outstanding = 0, paidTotal = 0, nm = name || '';
    for (const s of sessions) {
      const e = s.entry, p = e.payment;
      const fee = Number(p.fee) || 0;
      if (!nm && e.name) nm = e.name;
      const row = { date: s.date, fee, tier: p.tier, feeOverridden: !!p.feeOverridden, method: p.method || null, paidAt: p.paidAt || null, paid: !!e.paid };
      if (e.paid) { settled.push(row); paidTotal += fee; } else { owing.push(row); outstanding += fee; }
    }
    return {
      playerId, name: nm || playerId, sessions: sessions.length, owing, settled,
      outstanding: roundFee(outstanding), paidTotal: roundFee(paidTotal), unpaidCount: owing.length, paidCount: settled.length,
    };
  }

  /** Owing first (largest debt on top), then settled members, then members with no records; name order within. */
  function compareMembers(a, b) {
    const ga = a.outstanding > 0 ? 0 : (a.sessions > 0 ? 1 : 2);
    const gb = b.outstanding > 0 ? 0 : (b.sessions > 0 ? 1 : 2);
    if (ga !== gb) return ga - gb;
    if (a.outstanding !== b.outstanding) return b.outstanding - a.outstanding;
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  }

  /**
   * The member list: every roster player (even with no records yet) plus anyone who still has a
   * payment record but has left the roster. Roster names win over the names stored on records.
   */
  function memberLedger(attendance, roster) {
    const att = attendance && typeof attendance === 'object' ? attendance : {};
    const names = new Map();
    for (const r of (Array.isArray(roster) ? roster : [])) if (r && r.id) names.set(r.id, r.name || r.id);
    for (const d of Object.keys(att)) {
      for (const e of withPayment(att[d] && att[d].entries)) {
        if (e.playerId && !names.has(e.playerId)) names.set(e.playerId, e.name || e.playerId);
      }
    }
    const out = [];
    names.forEach((name, id) => out.push(memberSummary(att, id, name)));
    return out.sort(compareMembers);
  }

  /** Member list filters, in display order. */
  const MEMBER_FILTERS = ['all', 'owing', 'settled'];
  const MEMBER_FILTER_LABELS = { all: 'All members', owing: 'Owing', settled: 'Settled' };
  function isMemberFilter(f) { return MEMBER_FILTERS.indexOf(f) !== -1; }
  function memberFilterLabel(f) { return MEMBER_FILTER_LABELS[f] || MEMBER_FILTER_LABELS.all; }
  function matchesMemberFilter(m, f) {
    if (f === 'owing') return m.outstanding > 0;
    if (f === 'settled') return m.outstanding === 0 && m.sessions > 0;
    return true; // 'all' / unknown
  }
  /** Narrow a ledger by filter + case-insensitive name search. Order is preserved. */
  function filterMembers(members, opts) {
    const f = (opts && opts.filter) || 'all';
    const q = String((opts && opts.query) || '').trim().toLowerCase();
    return (Array.isArray(members) ? members : [])
      .filter((m) => matchesMemberFilter(m, f) && (!q || String(m.name || '').toLowerCase().indexOf(q) !== -1));
  }
  /** Header tiles for the member view. */
  function ledgerTotals(members) {
    const list = Array.isArray(members) ? members : [];
    let owing = 0, outstanding = 0, withRecords = 0;
    for (const m of list) {
      if (m.sessions > 0) withRecords++;
      if (m.outstanding > 0) { owing++; outstanding += m.outstanding; }
    }
    return { members: list.length, withRecords, owing, outstanding: roundFee(outstanding) };
  }
  /** Right-hand label on a member row: "RM50 · 2 nights" / "Settled" / "No records yet". */
  function memberOweLabel(m) {
    if (!m) return '';
    if (m.outstanding > 0) return fmtRM(m.outstanding) + ' · ' + m.unpaidCount + ' night' + (m.unpaidCount === 1 ? '' : 's');
    return m.sessions > 0 ? 'Settled' : 'No records yet';
  }

  // ── time (Malaysia) ──────────────────────────────────────────────────
  function addDaysISO(iso, n) {
    const m = ISO_RE.exec(String(iso));
    if (!m) return String(iso);
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    dt.setUTCDate(dt.getUTCDate() + (Math.trunc(Number(n) || 0)));
    return dt.toISOString().slice(0, 10);
  }
  /** Epoch ms for 00:00 MYT on the day AFTER `iso` (i.e. the exclusive end of that day). */
  function endOfDayMs(iso, offsetHours) {
    const m = ISO_RE.exec(String(iso));
    if (!m) return NaN;
    const off = offsetHours == null ? DEFAULT_OFFSET_HOURS : Number(offsetHours);
    return Date.UTC(+m[1], +m[2] - 1, +m[3] + 1) - off * 3600 * 1000;
  }
  /**
   * Was this player's payment made within `days` days of the session (inclusive of the
   * whole last day, Malaysia time)? For the future "paid within 3 days" lucky draw.
   */
  function paidWithin(entry, sessionDate, days, offsetHours) {
    const p = entry && entry.payment;
    if (!entry || !entry.paid || !p || !p.paidAt) return false;
    const limit = endOfDayMs(addDaysISO(sessionDate, days), offsetHours);
    return Number.isFinite(limit) && Number(p.paidAt) < limit;
  }

  function mytParts(msValue) {
    const d = new Date(ms(msValue) + DEFAULT_OFFSET_HOURS * 3600 * 1000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
  }
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** "9:42 PM" in Asia/Kuala_Lumpur (Intl when available, fixed +8 fallback — same instant either way). */
  function fmtMYT(msValue) {
    if (!msValue) return '';
    try {
      return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TIME_ZONE }).format(new Date(ms(msValue)));
    } catch (e) {
      const t = mytParts(msValue);
      return (t.h % 12 || 12) + ':' + String(t.mi).padStart(2, '0') + ' ' + (t.h >= 12 ? 'PM' : 'AM');
    }
  }
  /** "9 Sep · 9:42 PM" in Asia/Kuala_Lumpur. */
  function fmtMYTDateTime(msValue) {
    if (!msValue) return '';
    const t = mytParts(msValue);
    return t.day + ' ' + MONTHS_SHORT[t.mo] + ' · ' + fmtMYT(msValue);
  }

  // ── presentation strings (shared so the UI has no business logic to test) ──
  function fmtRM(n) {
    const v = Number(n) || 0;
    return 'RM' + (Number.isInteger(v) ? String(v) : v.toFixed(2));
  }
  /** Fee chip on a payment row: "RM25" or "RM15 · custom" (the tier has its own control). */
  function feeLabel(payment) {
    if (!payment) return '';
    return fmtRM(payment.fee) + (payment.feeOverridden ? ' · custom' : '');
  }
  /** Compact one-liner with the tier: "RM25 · 3h" / "RM15 · custom". */
  function feeTierLabel(payment) {
    if (!payment) return '';
    return fmtRM(payment.fee) + ' · ' + (payment.feeOverridden ? 'custom' : (payment.tier || ''));
  }
  /** "Paid 9:42 PM · Cash" (formatter injectable for tests). */
  function paidLine(entry, fmt) {
    if (!entry || !entry.paid) return '';
    const p = entry.payment || {};
    const f = typeof fmt === 'function' ? fmt : fmtMYT;
    const when = p.paidAt ? f(p.paidAt) : '';
    return 'Paid' + (when ? ' ' + when : '') + (p.method ? ' · ' + methodLabel(p.method) : '');
  }
  /** "Generated 20 payment records, 0 already existed" */
  function eodSummaryText(created, existed, removed) {
    const c = Number(created) || 0, x = Number(existed) || 0, r = Number(removed) || 0;
    if (!c && !x && !r) return 'Nothing to generate — no players in the line-up.';
    return 'Generated ' + c + ' payment record' + (c === 1 ? '' : 's') + ', ' + x + ' already existed'
      + (r ? ', ' + r + ' removed (no longer in the line-up)' : '');
  }
  /** Courts-footer status: "20 records · 12 paid" / "20 records · all paid" / '' when none. */
  function eodStatusText(sum) {
    if (!sum || !sum.players) return '';
    return sum.players + ' record' + (sum.players === 1 ? '' : 's') + ' · ' + (sum.unpaid ? sum.paid + ' paid' : 'all paid');
  }
  /** "RM25" / "25" / "22.5" → number (2dp, 0..MAX_FEE); anything else → null. */
  function parseFeeInput(str) {
    const s = String(str == null ? '' : str).replace(/^\s*rm/i, '').trim();
    if (!s) return null;
    const v = Number(s);
    return isValidFee(v) ? roundFee(v) : null;
  }

  return {
    TIERS, DEFAULT_TIER, FEE_BY_TIER, METHODS, METHOD_LABELS, MAX_FEE, TIME_ZONE,
    isTier, isMethod, tierOf, feeForTier, methodLabel, isValidFee,
    newPayment, applyPaid, applyMethod, applyTier, applyFeeOverride, resetFee, generateInto,
    summarize, rowsOf, nextPaymentPatch, isNoopPatch, datesWithPayments, stepDate, feeTierForDate,
    FILTERS, isFilter, filterLabel, matchesFilter, breakdownByMethod, unpaidNames,
    dayHasOutstanding, memberSessions, memberSummary, memberLedger, compareMembers,
    MEMBER_FILTERS, isMemberFilter, memberFilterLabel, matchesMemberFilter, filterMembers, ledgerTotals, memberOweLabel,
    addDaysISO, endOfDayMs, paidWithin, fmtMYT, fmtMYTDateTime,
    fmtRM, feeLabel, feeTierLabel, paidLine, eodSummaryText, eodStatusText, parseFeeInput, reconcileInto,
  };
});
