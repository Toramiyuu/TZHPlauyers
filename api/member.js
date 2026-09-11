'use strict';
/*
 * member.js — the signed-in member's own page: points toward the Monthly draw,
 * what they owe (the Payments ledger), and every lucky-draw prize they have won.
 *
 * Token-gated (an active account session from api/accounts.js) and strictly
 * SELF-only: it reads one player's rows out of attendance/payments and the draw
 * records and never returns anyone else's data. Read-only — never persists.
 *
 * Wins are gathered from all four draw records:
 *   - Session draws   (Redis hash `court-draws`,          matched by roster id)
 *   - Monthly draws   (Redis hash `court-monthly-draws`,  matched by roster id)
 *   - Shuttlecock     (state.monthlyDraw results/history,  matched by NAME — its
 *                      participants are CSV-imported and carry no roster id)
 *   - Quick draws     (state.luckyDraw results/history,    matched by NAME)
 */
const P = require('../public/payments.js');
const ML = require('../public/monthly-lucky.js');
const { findByToken, ensureAccountsV2 } = require('./accounts.js');

const MAX_WINS = 50;
const MAX_SETTLED = 12;

function nameKey(n) { return String(n == null ? '' : n).trim().toLowerCase().replace(/\s+/g, ' '); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/** Every prize this player has won, newest first. Pure. */
function winsFor(state, playerId, name, drawResults, monthlyResults) {
  const s = state || {};
  const out = [];
  const nk = nameKey(name);
  const pid = String(playerId || '');

  for (const rec of Object.values(drawResults || {})) {
    if (!rec || !Array.isArray(rec.winners)) continue;
    const i = rec.winners.map(String).indexOf(pid);
    if (i === -1) continue;
    out.push({ kind: 'session', title: 'Session draw', date: rec.date || '', at: num(rec.drawnAt) || num(rec.drawAt), rank: i + 1, prize: '' });
  }
  for (const rec of Object.values(monthlyResults || {})) {
    if (!rec || !Array.isArray(rec.winners)) continue;
    const a = ML.awardsOf(rec).find((w) => String(w.id) === pid);
    if (!a) continue;
    out.push({ kind: 'monthly', title: 'Monthly draw', month: rec.month || '', label: rec.label || ML.monthLabel(rec.month), at: num(rec.drawnAt), rank: a.rank, prize: a.prize || '' });
  }
  if (nk) {
    const md = s.monthlyDraw && typeof s.monthlyDraw === 'object' ? s.monthlyDraw : {};
    for (const r of (Array.isArray(md.results) ? md.results : [])) {
      if (!r || nameKey(r.name) !== nk || !(num(r.at) > 0)) continue;
      out.push({ kind: 'shuttlecock', title: 'Shuttlecock draw', month: md.month || '', label: ML.monthLabel(md.month), at: num(r.at), rank: num(r.rank) || 1, prize: r.prize || '' });
    }
    for (const h of (Array.isArray(md.history) ? md.history : [])) {
      for (const w of ((h && Array.isArray(h.winners)) ? h.winners : [])) {
        if (!w || nameKey(w.name) !== nk) continue;
        out.push({ kind: 'shuttlecock', title: 'Shuttlecock draw', month: h.month || '', label: h.label || ML.monthLabel(h.month), at: num(h.at), rank: num(w.rank) || 1, prize: w.prize || '' });
      }
    }
    const ld = s.luckyDraw && typeof s.luckyDraw === 'object' ? s.luckyDraw : {};
    for (const r of (Array.isArray(ld.results) ? ld.results : [])) {
      if (!r || nameKey(r.name) !== nk) continue;
      out.push({ kind: 'quick', title: 'Lucky draw', date: ld.drawDate || '', at: num(r.at), rank: num(r.rank) || 1, prize: '' });
    }
    for (const h of (Array.isArray(ld.history) ? ld.history : [])) {
      for (const w of ((h && Array.isArray(h.winners)) ? h.winners : [])) {
        if (!w || nameKey(w.name) !== nk) continue;
        out.push({ kind: 'quick', title: 'Lucky draw', date: h.date || '', at: num(h.at), rank: num(w.rank) || 1, prize: '' });
      }
    }
  }
  out.sort((a, b) => (b.at - a.at) || String(b.date || b.month || '').localeCompare(String(a.date || a.month || '')));
  return out.slice(0, MAX_WINS);
}

/** Points + Monthly-draw progress for one roster player. Pure. */
function pointsFor(state, player) {
  const s = state || {};
  const settings = ML.settingsOf(s);
  const ml = ML.normalize(s.monthlyLucky);
  const points = player ? num(player.points) : 0;
  const threshold = settings.threshold;
  return {
    points, threshold, month: ml.pointsMonth || '', monthLabel: ML.monthLabel(ml.pointsMonth),
    inDraw: points >= threshold, toGo: Math.max(0, threshold - points),
  };
}

/** The member's own ledger rows, trimmed for the phone screen. Pure. */
function paymentsFor(state, playerId, name) {
  const m = P.memberSummary((state && state.attendance) || {}, playerId, name);
  const row = (x) => ({ date: x.date, fee: x.fee, tier: x.tier || '', feeOverridden: !!x.feeOverridden, method: x.method || null, paidAt: x.paidAt || null });
  return {
    outstanding: m.outstanding, unpaidCount: m.unpaidCount, paidTotal: m.paidTotal, paidCount: m.paidCount, sessions: m.sessions,
    owing: m.owing.map(row), settled: m.settled.slice(0, MAX_SETTLED).map(row),
  };
}

/** The whole page payload for an active account. Pure given the draw records. */
function buildMemberInfo(state, account, ctx) {
  const s = state || {};
  const c = ctx || {};
  const roster = Array.isArray(s.roster) ? s.roster : [];
  const player = roster.find((r) => r && r.id === account.playerId) || null;
  const name = (player && player.name) || account.name || '';
  return {
    ok: true,
    member: { id: account.id, playerId: account.playerId || null, name, code: account.code || '', hasPassword: !!account.pwHash, phone: account.phoneDisplay || '', onRoster: !!player },
    points: pointsFor(s, player),
    payments: paymentsFor(s, account.playerId, name),
    wins: winsFor(s, account.playerId, name, c.drawResults, c.monthlyResults),
    serverTime: c.nowMs != null ? Number(c.nowMs) : Date.now(),
  };
}

/** Dispatcher entry: POST { action:'memberInfo', token }. Never writes. */
async function handleMemberInfo(state, body, opts) {
  const o = opts || {};
  if (!state || typeof state !== 'object') return { status: 400, body: { error: 'Invalid request.' }, changed: false };
  ensureAccountsV2(state);
  const account = findByToken(state.accounts, body && body.token);
  if (!account || account.status !== 'active') return { status: 401, body: { error: 'Session expired.' }, changed: false };
  let drawResults = {}, monthlyResults = {};
  try { if (o.drawStore) drawResults = (await o.drawStore.getAll()) || {}; } catch (e) { drawResults = {}; }
  try { if (o.monthlyStore) monthlyResults = (await o.monthlyStore.getAll()) || {}; } catch (e) { monthlyResults = {}; }
  return { status: 200, body: buildMemberInfo(state, account, { drawResults, monthlyResults, nowMs: o.nowMs }), changed: false };
}

module.exports = { winsFor, pointsFor, paymentsFor, buildMemberInfo, handleMemberInfo, nameKey };
