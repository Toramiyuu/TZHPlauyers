'use strict';
/*
 * monthly-lucky.js — server-side wiring for the points-based Monthly Lucky Draw.
 *
 * Pure rules (eligibility, month close, seeded shuffle, record shape, page view)
 * live in public/monthly-lucky.js and are shared with the browser + unit tests.
 * This module adds: the draw STORE (Redis hash `court-monthly-draws`, one field
 * per month, written with HSETNX so a month can never be drawn twice), the month
 * close applied IN PLACE to the state blob (points reset + snapshot), the
 * idempotent automatic sweep, the admin actions, and the JSON view.
 *
 * Results are permanent: nothing here deletes or rewrites a record.
 *
 * Actions (admin-password gated by api/state.js):
 *   getMonthlyDraws {}                       — closes a due month, sweeps, returns the admin view
 *   setMonthlySettings {auto?,winners?,threshold?}
 *   setMonthlyPrizes {prizes:[{id,name,qty,desc,photo}]}
 *   pullMonthlyPool {}                       — pool = roster at/above the threshold (current month)
 *   setMonthlyPoolRemoved {playerId,removed} — admin curation of the pulled pool
 *   runMonthlyDraw {month}                   — manual draw; refused once a record exists
 * NOTE: never reuse the field name `password` here — the dispatcher strips it as admin auth.
 */
const crypto = require('crypto');
const ML = require('../public/monthly-lucky.js');
const { memoryDrawStore, redisDrawStore } = require('./session-draw.js');
const { pushAudit } = require('./audit.js');

const MONTHLY_DRAWS_KEY = 'court-monthly-draws';
const MONTHLY_LUCKY_ADMIN_ACTIONS = new Set(['getMonthlyDraws', 'setMonthlySettings', 'setMonthlyPrizes', 'pullMonthlyPool', 'setMonthlyPoolRemoved', 'runMonthlyDraw']);

function offsetHours() { return parseFloat(process.env.TZ_OFFSET_HOURS || '8'); }
function todayISO(offset) {
  const off = offset == null ? offsetHours() : Number(offset);
  return new Date(Date.now() + off * 3600 * 1000).toISOString().slice(0, 10);
}
function newSeed() { return crypto.randomBytes(16).toString('hex'); }
function bad(msg) { return { status: 400, body: { error: msg }, changed: false }; }
function memoryMonthlyStore(initial) { return memoryDrawStore(initial); }
function redisMonthlyStore(client) { return redisDrawStore(client, MONTHLY_DRAWS_KEY); }

/**
 * Close any month behind `today` IN PLACE (roster points -> 0, snapshot kept).
 * Returns the closed month keys ([] when nothing changed). Audited.
 */
function applyMonthClose(state, today, nowMs) {
  const r = ML.closeIfDue(state, today, nowMs);
  if (!r.changed) return [];
  state.roster = r.state.roster;
  state.monthlyLucky = r.state.monthlyLucky;
  r.closedMonths.forEach((m) => {
    const snap = state.monthlyLucky.closed[m] || { points: {} };
    const t = ML.settingsOf(state).threshold;
    const reached = Object.keys(snap.points).filter((id) => (Number(snap.points[id]) || 0) >= t).length;
    pushAudit(state, { action: 'monthlyLucky.close', admin: 'system', at: nowMs,
      target: { type: 'monthlyLucky', id: m, label: 'Monthly draw ' + ML.monthLabel(m) },
      newValue: reached, note: 'Month closed · points reset to 0 · ' + reached + ' reached ' + t });
  });
  return r.closedMonths;
}

/**
 * Idempotent automatic sweep: draw every CLOSED month whose scheduled time has
 * passed and that has no record yet — only while `auto` is on. Never touches
 * `state`. Returns { drawn:[months], pending:[months], results:{month:rec} }.
 */
async function sweepMonthlyDraws(state, store, opts) {
  const o = opts || {};
  const now = o.nowMs != null ? Number(o.nowMs) : Date.now();
  const off = o.offsetHours != null ? o.offsetHours : offsetHours();
  const seedFn = typeof o.seedFn === 'function' ? o.seedFn : newSeed;
  const settings = ML.settingsOf(state);
  const results = await store.getAll();
  const drawn = [], pending = [];
  for (const c of ML.monthCandidates(state, off)) {
    if (results[c.month]) continue;                                    // already drawn — idempotent
    if (!c.closed) continue;                                           // the live month is never auto-drawn
    if (!settings.auto || !Number.isFinite(c.drawAt) || now < c.drawAt) { pending.push(c.month); continue; }
    const pf = ML.playersFor(state, c.month);
    const rec = ML.buildDrawResult({
      month: c.month, drawAt: c.drawAt, players: pf ? pf.players : [], threshold: settings.threshold,
      winnersWanted: settings.winners, prizes: settings.prizes, seed: seedFn(), nowMs: now, method: 'auto', source: 'closed',
    });
    if (await store.putIfAbsent(c.month, rec)) { drawn.push(c.month); results[c.month] = rec; }
    else results[c.month] = await store.get(c.month);                   // someone else won the race
  }
  return { drawn, pending, results };
}

/** The page payload (admin: full; the caller applies publicMonthView for players). */
async function buildMonthlyView(state, store, opts) {
  const o = opts || {};
  const now = o.nowMs != null ? Number(o.nowMs) : Date.now();
  const off = o.offsetHours != null ? o.offsetHours : offsetHours();
  const results = o.results || await store.getAll();
  return ML.buildView(state, results, { nowMs: now, offsetHours: off, limit: o.limit });
}

// ── admin actions ────────────────────────────────────────────────────
async function doGetMonthlyDraws(state, body, o) {
  const closed = applyMonthClose(state, o.today, o.nowMs);
  let results = null;
  try { results = (await sweepMonthlyDraws(state, o.store, { nowMs: o.nowMs, offsetHours: o.offsetHours, seedFn: o.seedFn })).results; } catch (e) { /* view still loads */ }
  const view = await buildMonthlyView(state, o.store, { results, nowMs: o.nowMs, offsetHours: o.offsetHours });
  const ml = ML.normalize(state.monthlyLucky, o.today);
  return { status: 200, body: Object.assign({ ok: true, closedMonths: closed, pool: ml.pool, serverTime: o.nowMs }, view), changed: closed.length > 0 };
}

function doSetMonthlySettings(state, body, o) {
  const cur = ML.settingsOf(state);
  const next = Object.assign({}, cur);
  const changes = [];
  if (body.auto !== undefined) { next.auto = !!body.auto; if (next.auto !== cur.auto) changes.push(['auto', cur.auto, next.auto]); }
  if (body.winners !== undefined) {
    const n = Number(body.winners);
    if (!ML.isWinnersCount(n)) return bad('Winners must be a whole number from 1 to ' + ML.MAX_WINNERS + '.');
    next.winners = n; if (n !== cur.winners) changes.push(['winners', cur.winners, n]);
  }
  if (body.threshold !== undefined) {
    const t = Number(body.threshold);
    if (!ML.isThreshold(t)) return bad('Points needed must be a whole number from 1 to ' + ML.MAX_THRESHOLD + '.');
    next.threshold = t; if (t !== cur.threshold) changes.push(['threshold', cur.threshold, t]);
  }
  if (!changes.length) return { status: 200, body: { ok: true, settings: cur, unchanged: true }, changed: false };
  state.monthlyLucky = Object.assign({}, ML.normalize(state.monthlyLucky, o.today), { auto: next.auto, winners: next.winners, threshold: next.threshold });
  changes.forEach(([k, p, n]) => pushAudit(state, { action: 'monthlyLucky.settings', admin: 'admin', at: o.nowMs,
    target: { type: 'monthlyLucky', id: k, label: 'Monthly draw ' + (k === 'auto' ? 'automatic' : k === 'winners' ? 'winners' : 'points needed') }, prevValue: p, newValue: n }));
  return { status: 200, body: { ok: true, settings: ML.settingsOf(state) }, changed: true };
}

function doSetMonthlyPrizes(state, body, o) {
  if (!Array.isArray(body.prizes)) return bad('Send the prize list.');
  if (body.prizes.length > ML.MAX_PRIZES) return bad('At most ' + ML.MAX_PRIZES + ' prizes.');
  for (const p of body.prizes) {
    if (!p || typeof p !== 'object') return bad('Invalid prize.');
    if (!String(p.name == null ? '' : p.name).trim()) return bad('Every prize needs a name.');
    if (String(p.name).trim().length > ML.MAX_PRIZE_NAME) return bad('Prize names are limited to ' + ML.MAX_PRIZE_NAME + ' characters.');
    if (p.qty != null && p.qty !== '' && !ML.isPrizeQty(Number(p.qty))) return bad('Quantity must be a whole number from ' + ML.MIN_PRIZE_QTY + ' to ' + ML.MAX_PRIZE_QTY + '.');
    if (p.desc != null && typeof p.desc !== 'string') return bad('Invalid prize description.');
    if (p.desc != null && String(p.desc).trim().length > ML.MAX_PRIZE_DESC) return bad('Prize descriptions are limited to ' + ML.MAX_PRIZE_DESC + ' characters.');
    if (p.photo != null && p.photo !== '' && !ML.isPhoto(p.photo)) return bad('A prize photo must be a JPEG/PNG/WebP under ' + Math.round(ML.MAX_PHOTO_BYTES / 1024) + ' KB.');
  }
  const prizes = ML.normalizePrizes(body.prizes);
  const prev = ML.settingsOf(state).prizes;
  state.monthlyLucky = Object.assign({}, ML.normalize(state.monthlyLucky, o.today), { prizes });
  pushAudit(state, { action: 'monthlyLucky.prizes', admin: 'admin', at: o.nowMs,
    target: { type: 'monthlyLucky', id: 'prizes', label: 'Monthly draw prizes' },
    prevValue: prev.map(ML.prizeLabel), newValue: prizes.map(ML.prizeLabel) });
  return { status: 200, body: { ok: true, prizes }, changed: true };
}

function doPullMonthlyPool(state, body, o) {
  const ml = ML.normalize(state.monthlyLucky, o.today);
  const pool = ML.buildPool(state, ml.pointsMonth, o.nowMs);
  state.monthlyLucky = Object.assign({}, ml, { pool });
  pushAudit(state, { action: 'monthlyLucky.pool', admin: 'admin', at: o.nowMs,
    target: { type: 'monthlyLucky', id: ml.pointsMonth, label: 'Monthly draw ' + ML.monthLabel(ml.pointsMonth) },
    newValue: pool.players.map((p) => p.name), note: pool.players.length + ' at ' + ML.settingsOf(state).threshold + '+ points' });
  return { status: 200, body: { ok: true, pool }, changed: true };
}

function doSetMonthlyPoolRemoved(state, body, o) {
  const id = String(body.playerId || '');
  if (!id) return bad('Which player?');
  const ml = ML.normalize(state.monthlyLucky, o.today);
  if (!ml.pool) return bad('Pull the eligible players first.');
  const removed = new Set(ml.pool.removed);
  if (body.removed) removed.add(id); else removed.delete(id);
  const pool = Object.assign({}, ml.pool, { removed: [...removed] });
  state.monthlyLucky = Object.assign({}, ml, { pool });
  const who = (ml.pool.players.find((p) => p.id === id) || {}).name || id;
  pushAudit(state, { action: 'monthlyLucky.pool', admin: 'admin', at: o.nowMs,
    target: { type: 'monthlyLucky', id: ml.pool.month, label: 'Monthly draw ' + ML.monthLabel(ml.pool.month) },
    newValue: who, note: body.removed ? 'removed from the pool' : 'put back in the pool' });
  return { status: 200, body: { ok: true, pool }, changed: true };
}

async function doRunMonthlyDraw(state, body, o) {
  const month = String(body.month || '');
  if (!ML.isMonthKey(month)) return bad('Invalid month.');
  const existing = await o.store.get(month);
  if (existing) return { status: 409, body: { error: 'This month has already been drawn.', result: existing }, changed: false };
  const ml = ML.normalize(state.monthlyLucky, o.today);
  const settings = ML.settingsOf(state);
  let changed = false;
  if (month === ml.pointsMonth && !(ml.pool && ml.pool.month === month && ml.pool.pulledAt)) {
    // Nothing pulled yet: pull now so the record matches what the admin would have seen.
    state.monthlyLucky = Object.assign({}, ml, { pool: ML.buildPool(state, month, o.nowMs) });
    changed = true;
  }
  const pf = ML.playersFor(state, month);
  if (!pf) return { status: 404, body: { error: 'No points are recorded for that month.' }, changed };
  if (!pf.players.length) return { status: 400, body: { error: 'Nobody has reached ' + settings.threshold + ' points' + (pf.source === 'live' ? ' yet' : '') + '.' }, changed };
  const rec = ML.buildDrawResult({
    month, drawAt: ML.scheduledDrawAt(month, o.offsetHours), players: pf.players, threshold: settings.threshold,
    winnersWanted: settings.winners, prizes: settings.prizes, seed: o.seedFn(), nowMs: o.nowMs, method: 'manual', source: pf.source,
  });
  if (!(await o.store.putIfAbsent(month, rec))) {
    return { status: 409, body: { error: 'This month has already been drawn.', result: await o.store.get(month) }, changed };
  }
  pushAudit(state, { action: 'monthlyLucky.draw', admin: 'admin', at: o.nowMs,
    target: { type: 'monthlyLucky', id: month, label: 'Monthly draw ' + ML.monthLabel(month) },
    newValue: ML.awardsOf(rec).map((a) => a.name + (a.prize ? ' — ' + a.prize : '')),
    note: 'manual · ' + rec.counts.eligible + ' eligible' + (rec.shortfall ? ' · short of ' + rec.winnersWanted : '') });
  return { status: 200, body: { ok: true, result: rec }, changed: true };
}

/** Dispatcher entry. `opts.store` is required; nowMs/today/seedFn/offsetHours are injectable for tests. */
async function handleMonthlyLuckyAdminAction(state, body, opts) {
  try {
    if (!state || typeof state !== 'object') return bad('Invalid request.');
    const o = opts || {};
    if (!o.store) return { status: 500, body: { error: 'Draw storage unavailable.' }, changed: false };
    const ctx = {
      store: o.store,
      nowMs: o.nowMs != null ? Number(o.nowMs) : Date.now(),
      offsetHours: o.offsetHours != null ? o.offsetHours : offsetHours(),
      seedFn: typeof o.seedFn === 'function' ? o.seedFn : newSeed,
    };
    ctx.today = o.today || (o.nowMs != null ? new Date(ctx.nowMs + ctx.offsetHours * 3600 * 1000).toISOString().slice(0, 10) : todayISO(ctx.offsetHours));
    const b = body || {};
    switch (b.action) {
      case 'getMonthlyDraws':       return await doGetMonthlyDraws(state, b, ctx);
      case 'setMonthlySettings':    return doSetMonthlySettings(state, b, ctx);
      case 'setMonthlyPrizes':      return doSetMonthlyPrizes(state, b, ctx);
      case 'pullMonthlyPool':       return doPullMonthlyPool(state, b, ctx);
      case 'setMonthlyPoolRemoved': return doSetMonthlyPoolRemoved(state, b, ctx);
      case 'runMonthlyDraw':        return await doRunMonthlyDraw(state, b, ctx);
      default:                      return bad('Unknown action.');
    }
  } catch (e) {
    return bad('Invalid request.');
  }
}

module.exports = {
  MONTHLY_DRAWS_KEY, MONTHLY_LUCKY_ADMIN_ACTIONS,
  newSeed, memoryMonthlyStore, redisMonthlyStore,
  applyMonthClose, sweepMonthlyDraws, buildMonthlyView, handleMonthlyLuckyAdminAction,
};
