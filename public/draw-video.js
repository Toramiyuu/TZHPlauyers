/*
 * draw-video.js — shareable replay video of a Lucky Draw.
 *
 * Works for every draw kind: the automatic session draw (record from
 * public/session-draw.js: eligible names, seed, winners), the manual quick
 * draw (history entries that carry each winner's pool), the points-based
 * Monthly draw (public/monthly-lucky.js record: eligible names, seed, winners
 * + prizes). The replay is rendered
 * on a <canvas> in the viewer's browser and captured with MediaRecorder into an
 * MP4 (Safari, Chrome 126+) or WebM — nothing is uploaded or stored server-side,
 * and because the reel is driven by a seeded PRNG the same draw always produces
 * the same video.
 *
 * Pure (Node + browser, unit-tested): source builders, buildScript (the timed
 * replay), frameAt, month-calendar helpers, MIME / filename helpers.
 * Browser-only: paintFrame, play (+ record), saveBlob / shareBlob.
 *
 * Portrait 1080x1920 (9:16) — fills a phone screen and WhatsApp status.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.DrawVideo = api;                                            // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── config ───────────────────────────────────────────────────────────
  const WIDTH = 1080, HEIGHT = 1920, FPS = 30;
  // Reel timing mirrors the live picker (4.5 s spin, 45→330 ms swaps).
  const TIMING = { intro: 2200, reel: 4500, hold: 2800, outro: 3800 };
  const MIME_PREFS = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const CONFETTI_COLORS = ['#f0b429', '#16a55a', '#388bfd', '#8957e5', '#e05c5c', '#22c66e', '#58a6ff'];
  // Apple-minimal light theme (same values as the viewer's --a-* variables).
  const THEME = { bg: '#eef4fd', bg2: '#e2ecfa', card: '#ffffff', line: '#d4e2f5', line2: '#c0d4ee', ink: '#1d1d1f', ink2: '#5c6470', ink3: '#5f6b7a', blue: '#0071e3', blueTint: 'rgba(0,113,227,.14)', glow: 'rgba(0,113,227,.13)' };
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif';
  const SITE = 'tzhplayers.vercel.app';

  const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const MYT_OFFSET_MS = 8 * 3600 * 1000;

  // ── small helpers ────────────────────────────────────────────────────
  function isValidISO(s) { return typeof s === 'string' && ISO_RE.test(s); }
  function ordinal(n) { n = Number(n) || 0; const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function easeOut(p) { return 1 - Math.pow(1 - p, 3); }
  /** "Monday 7 September 2026" */
  function fmtLongDate(iso) {
    const m = ISO_RE.exec(String(iso || ''));
    if (!m) return String(iso || '');
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return WEEKDAY_LONG[d.getUTCDay()] + ' ' + (+m[3]) + ' ' + MONTHS_LONG[+m[2] - 1] + ' ' + m[1];
  }
  /** "Fri 11 Sep · 9:00 AM" (Malaysia time) */
  function fmtDrawTime(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return '';
    const d = new Date(Number(ms) + MYT_OFFSET_MS);
    const h = d.getUTCHours(), mi = d.getUTCMinutes();
    return WEEKDAY_SHORT[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS_SHORT[d.getUTCMonth()] + ' · ' + (h % 12 || 12) + ':' + String(mi).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
  function fmtBytes(n) { n = Number(n) || 0; if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB'; return (n / (1024 * 1024)).toFixed(1) + ' MB'; }

  // Seeded PRNG (cyrb128 + sfc32), same family as session-draw.js.
  function cyrb128(str) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0, k; i < str.length; i++) {
      k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
  }
  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }
  function prng(seed) {
    const w = cyrb128(String(seed == null ? '' : seed));
    const rng = sfc32(w[0], w[1], w[2], w[3]);
    for (let i = 0; i < 15; i++) rng();
    return rng;
  }

  // ── sources: what a replay is made from ──────────────────────────────
  /**
   * Automatic session draw → source. `view` is one item of the Lucky Draw page
   * payload (SessionDraw.viewOf, status 'done'). Null when there is nothing to
   * replay (pending, or no winners).
   */
  function sourceFromSession(view) {
    if (!view || view.status !== 'done') return null;
    const lists = view.lists || {};
    const pool = (lists.eligible || []).map((r) => String(r.name || r.id || '')).filter(Boolean);
    const winners = (lists.winners || []).map((w, i) => ({ rank: i + 1, name: String(w.name || w.id || '') })).filter((w) => w.name);
    if (!winners.length) return null;
    const c = view.counts || {};
    const eligible = Number(c.eligible) || pool.length;
    return {
      kind: 'session', date: view.date, key: 'session:' + view.date,
      title: 'Lucky Draw', subtitle: fmtLongDate(view.date) + ' session',
      when: view.drawnAt ? 'Drawn ' + fmtDrawTime(view.drawnAt) : '',
      pool, winners,
      seed: String(view.seed || ''),
      method: view.method === 'manual' ? 'Draw run by admin' : 'Automatic draw',
      note: eligible + ' eligible' + (view.verified ? ' · verified' : ''),
      verified: !!view.verified,
    };
  }
  /**
   * Manual quick draw → source. `entry` comes from manualEntriesOf(): a history
   * row or the live results, winners [{rank,name,pool?}]. Draws made before
   * pools were recorded have no pool and cannot be replayed → null.
   */
  function sourceFromManual(entry) {
    if (!entry || !isValidISO(entry.date)) return null;
    const winners = (entry.winners || []).filter((w) => w && w.name).slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
    if (!winners.length) return null;
    if (!winners.some((w) => Array.isArray(w.pool) && w.pool.length)) return null;
    const first = winners.find((w) => Array.isArray(w.pool) && w.pool.length);
    const pool = first.pool.map(String);
    const at = Number(entry.at) || 0;
    return {
      kind: 'manual', date: entry.date, key: entry.key || ('manual:' + entry.date + ':' + at),
      title: 'Lucky Draw', subtitle: fmtLongDate(entry.date),
      when: at ? 'Drawn ' + fmtDrawTime(at) : '',
      pool,
      winners: winners.map((w) => ({ rank: Number(w.rank) || 0, name: String(w.name), pool: Array.isArray(w.pool) && w.pool.length ? w.pool.map(String) : undefined })),
      seed: 'manual:' + entry.date + ':' + at + ':' + winners.map((w) => w.name).join('|'),
      method: 'Manual quick draw',
      note: pool.length + ' in the pool',
      verified: false,
    };
  }
  /**
   * Every manual quick draw the page can list, newest first: the live results
   * of the current draw (only winners already revealed, i.e. `at` <= nowMs) plus
   * the saved history. Each entry gets a stable `key`.
   */
  function manualEntriesOf(ld, nowMs) {
    const out = [];
    if (!ld || typeof ld !== 'object') return out;
    const now = nowMs != null ? Number(nowMs) : Date.now();
    const results = (Array.isArray(ld.results) ? ld.results : []).filter((r) => r && r.name && (Number(r.at) || 0) <= now);
    if (results.length && isValidISO(ld.drawDate)) {
      const at = Math.max.apply(null, results.map((r) => Number(r.at) || 0));
      out.push({ date: ld.drawDate, at, live: true, key: 'manual:' + ld.drawDate + ':' + at + ':live',
        winners: results.map((r) => ({ rank: r.rank, name: r.name, pool: Array.isArray(r.pool) ? r.pool.slice() : undefined })) });
    }
    (Array.isArray(ld.history) ? ld.history : []).forEach((h, i) => {
      if (!h || !isValidISO(h.date)) return;
      const at = Number(h.at) || 0;
      out.push({ date: h.date, at, live: false, key: 'manual:' + h.date + ':' + at + ':' + i,
        winners: (h.winners || []).filter((w) => w && w.name).map((w) => ({ rank: w.rank, name: w.name, pool: Array.isArray(w.pool) ? w.pool.slice() : undefined })) });
    });
    return out.sort((a, b) => (a.date === b.date ? b.at - a.at : (a.date < b.date ? 1 : -1)));
  }
  /**
   * Points-based Monthly draw → source. `view` is one month of the Lucky Draw
   * page payload (MonthlyLucky.viewOf / publicMonthView, status 'done'). Winners
   * carry the prize they won so the reel and results card can show it.
   */
  function sourceFromMonthly(view) {
    if (!view || view.status !== 'done') return null;
    const lists = view.lists || {};
    const pool = (lists.eligible || []).map((r) => String(r.name || r.id || '')).filter(Boolean);
    const winners = (lists.winners || []).slice().sort((a, b) => (a.rank || 0) - (b.rank || 0))
      .map((w, i) => ({ rank: Number(w.rank) || i + 1, name: String(w.name || w.id || ''), prize: String(w.prize || '') })).filter((w) => w.name);
    if (!winners.length) return null;
    const c = view.counts || {};
    const eligible = Number(c.eligible) || pool.length;
    const date = view.drawnAt ? new Date(Number(view.drawnAt) + MYT_OFFSET_MS).toISOString().slice(0, 10) : (view.drawDate || '');
    return {
      kind: 'monthly', date, month: view.month, key: 'monthly:' + view.month,
      title: 'Monthly Draw', subtitle: String(view.label || view.month || ''),
      when: view.drawnAt ? 'Drawn ' + fmtDrawTime(view.drawnAt) : '',
      pool, winners,
      seed: String(view.seed || ''),
      method: view.method === 'manual' ? 'Draw run by admin' : 'Automatic draw',
      note: eligible + ' reached ' + (Number(view.threshold) || 0) + ' points' + (view.verified ? ' · verified' : ''),
      verified: !!view.verified,
    };
  }
  // ── the replay script (pure, deterministic) ──────────────────────────
  /** Decelerating swap schedule like the live reel; a name never repeats back-to-back. */
  function reelSwaps(names, durationMs, rng) {
    const swaps = [];
    const N = names.length;
    let at = 0, last = -1;
    for (;;) {
      const tt = at / durationMs;
      const eased = 1 - Math.pow(1 - tt, 2);
      const next = at + 45 + 285 * eased;
      if (next >= durationMs) break;
      let idx = 0;
      if (N > 1) { do { idx = Math.floor(rng() * N); } while (idx === last); }
      last = idx;
      swaps.push({ at: Math.round(next), name: names[idx] });
      at = next;
    }
    return swaps;
  }
  function confettiFor(rng, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ x: rng(), delay: rng() * 0.6, dur: 1.6 + rng() * 1.4, size: 10 + Math.floor(rng() * 12),
        color: CONFETTI_COLORS[Math.floor(rng() * CONFETTI_COLORS.length)], spin: 360 + rng() * 720, drift: (rng() - 0.5) * 260 });
    }
    return out;
  }
  /**
   * Build the timed replay: intro (who is in) → one reel per winner (spin, lock,
   * confetti) → outro (results card). Timing is injectable for tests.
   */
  function buildScript(source, opts) {
    const o = opts || {};
    const T = Object.assign({}, TIMING, o.timing || {});
    const src = source || {};
    const rng = prng(src.seed || src.key || 'draw');
    const segments = [];
    let t = 0;
    segments.push({ type: 'intro', start: 0, end: T.intro });
    t = T.intro;
    let pool = (src.pool || []).map(String);
    (src.winners || []).forEach((w) => {
      const names = (Array.isArray(w.pool) && w.pool.length ? w.pool.map(String) : pool).slice();
      if (!names.includes(w.name)) names.push(w.name);
      const spinStart = t, lockAt = t + T.reel, end = lockAt + T.hold;
      segments.push({ type: 'reel', rank: w.rank, winner: w.name, prize: w.prize ? String(w.prize) : '', pool: names, start: t, spinStart, lockAt, end,
        swaps: reelSwaps(names, T.reel, rng), confetti: confettiFor(rng, 80) });
      t = end;
      pool = names.filter((n) => n !== w.name);
    });
    segments.push({ type: 'outro', start: t, end: t + T.outro });
    t += T.outro;
    return { width: WIDTH, height: HEIGHT, fps: FPS, durationMs: t, source: src, segments };
  }
  /** What is on screen at time t (ms): segment, phase and the name showing on the reel. */
  function frameAt(script, t) {
    const segs = script.segments;
    const tt = Math.max(0, Math.min(Number(t) || 0, script.durationMs));
    let seg = segs[segs.length - 1];
    for (const s of segs) { if (tt < s.end) { seg = s; break; } }
    const f = { type: seg.type, segment: seg, t: tt, local: tt - seg.start, progress: clamp01((tt - seg.start) / (seg.end - seg.start || 1)) };
    if (seg.type === 'reel') {
      if (tt >= seg.lockAt) { f.phase = 'locked'; f.name = seg.winner; f.sinceLock = tt - seg.lockAt; }
      else {
        f.phase = 'spin';
        let name = seg.pool[0];
        const rel = tt - seg.spinStart;
        for (const s of seg.swaps) { if (s.at <= rel) name = s.name; else break; }
        f.name = name;
        f.spinProgress = clamp01(rel / (seg.lockAt - seg.spinStart || 1));
      }
    }
    return f;
  }

  // ── month calendar (pure) ────────────────────────────────────────────
  function monthOf(iso) { const m = /^(\d{4})-(\d{2})/.exec(String(iso || '')); return m ? { year: +m[1], month0: +m[2] - 1 } : null; }
  function shiftMonth(year, month0, delta) { const d = new Date(Date.UTC(year, month0 + (Number(delta) || 0), 1)); return { year: d.getUTCFullYear(), month0: d.getUTCMonth() }; }
  function monthStartISO(year, month0) { return new Date(Date.UTC(year, month0, 1)).toISOString().slice(0, 10); }
  function monthLabel(year, month0) { return MONTHS_LONG[month0] + ' ' + year; }
  /** 6 x 7 grid, Monday-first by default (firstDay 0 = Sunday). */
  function monthGrid(year, month0, firstDay) {
    const fd = firstDay == null ? 1 : Number(firstDay);
    const first = new Date(Date.UTC(year, month0, 1));
    const lead = ((first.getUTCDay() - fd) % 7 + 7) % 7;
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(Date.UTC(year, month0, 1 - lead + i));
      cells.push({ iso: d.toISOString().slice(0, 10), day: d.getUTCDate(), inMonth: d.getUTCMonth() === month0, weekday: d.getUTCDay() });
    }
    const weekdays = [];
    for (let i = 0; i < 7; i++) weekdays.push(WEEKDAY_SHORT[(fd + i) % 7]);
    return { year, month0, label: monthLabel(year, month0), cells, weekdays };
  }
  /** {iso: {session: view|null, manual: [entries]}} for calendar marks and day filtering. */
  function indexDraws(sessions, manual) {
    const idx = {};
    const slot = (d) => (idx[d] = idx[d] || { session: null, manual: [] });
    (sessions || []).forEach((v) => { if (v && isValidISO(v.date)) slot(v.date).session = v; });
    (manual || []).forEach((e) => { if (e && isValidISO(e.date)) slot(e.date).manual.push(e); });
    return idx;
  }

  // ── output format ────────────────────────────────────────────────────
  function canRecord() {
    return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }
  /** First supported MIME in preference order (MP4 first). `isSupported` injectable for tests. */
  function pickMimeType(isSupported) {
    const f = typeof isSupported === 'function' ? isSupported
      : (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function' ? (m) => MediaRecorder.isTypeSupported(m) : () => false);
    for (const m of MIME_PREFS) { try { if (f(m)) return m; } catch (e) { /* ignore */ } }
    return '';
  }
  function extFor(mime) { return /mp4/i.test(String(mime || '')) ? 'mp4' : 'webm'; }
  function filenameFor(source, mime) {
    const s = source || {};
    if (s.kind === 'monthly') return 'TZH-Monthly-Draw-' + (s.month || (isValidISO(s.date) ? s.date : 'replay')) + '.' + extFor(mime);
    return 'TZH-Lucky-Draw-' + (isValidISO(s.date) ? s.date : 'replay') + (s.kind === 'manual' ? '-quick-draw' : '') + '.' + extFor(mime);
  }

  // ── canvas painting (browser) ────────────────────────────────────────
  function rr(ctx, x, y, w, h, r) {
    const rad = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }
  function fontStr(weight, px) { return weight + ' ' + px + 'px ' + FONT; }
  function setSpacing(ctx, v) { if ('letterSpacing' in ctx) ctx.letterSpacing = v || '0px'; }
  function text(ctx, str, x, y, o) {
    o = o || {};
    ctx.font = fontStr(o.weight || 400, o.px || 40);
    ctx.fillStyle = o.color || THEME.ink;
    ctx.textAlign = o.align || 'center';
    ctx.textBaseline = o.baseline || 'middle';
    setSpacing(ctx, o.spacing);
    ctx.fillText(String(str == null ? '' : str), x, y);
    setSpacing(ctx, '0px');
  }
  function fitFont(ctx, str, weight, maxPx, minPx, maxWidth) {
    let px = maxPx;
    ctx.font = fontStr(weight, px);
    while (px > minPx && ctx.measureText(str).width > maxWidth) { px -= 4; ctx.font = fontStr(weight, px); }
    return px;
  }
  /** Wrap chips into rows; returns placed chips + how many did not fit. */
  function chipLayout(measure, names, width, rowH, gap, padX, maxRows) {
    const chips = [];
    let cx = 0, cy = 0, row = 0;
    for (let i = 0; i < names.length; i++) {
      const w = Math.min(width, measure(names[i]) + padX * 2);
      if (cx > 0 && cx + w > width) { cx = 0; cy += rowH + gap; row++; }
      if (row >= maxRows) return { chips, overflow: names.length - i };
      chips.push({ name: names[i], x: cx, y: cy, w });
      cx += w + gap;
    }
    return { chips, overflow: 0 };
  }
  function paintBackground(ctx, W, H) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, THEME.bg); g.addColorStop(1, THEME.bg2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const rg = ctx.createRadialGradient(W / 2, 320, 40, W / 2, 320, 980);
    rg.addColorStop(0, THEME.glow); rg.addColorStop(1, 'rgba(0,113,227,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  }
  function paintHeader(ctx, W, src) {
    text(ctx, 'TZH BADMINTON', W / 2, 168, { weight: 700, px: 30, color: THEME.ink3, spacing: '8px' });
    text(ctx, src.title || 'Lucky Draw', W / 2, 272, { weight: 800, px: 106, color: THEME.ink });
    text(ctx, src.subtitle || '', W / 2, 364, { weight: 500, px: 42, color: THEME.ink2 });
    if (src.when) text(ctx, src.when, W / 2, 422, { weight: 400, px: 34, color: THEME.ink3 });
  }
  function paintFooter(ctx, W, H, src) {
    text(ctx, [src.method, src.note].filter(Boolean).join(' · '), W / 2, H - 150, { weight: 500, px: 30, color: THEME.ink3 });
    const seed = (src.kind === 'session' || src.kind === 'monthly') && src.seed ? 'Seed ' + String(src.seed).slice(0, 8) + ' · ' : '';
    text(ctx, seed + SITE, W / 2, H - 100, { weight: 400, px: 26, color: THEME.ink3 });
  }
  function card(ctx, x, y, w, h, r, stroke, lw) {
    ctx.fillStyle = THEME.card; ctx.strokeStyle = stroke || THEME.line; ctx.lineWidth = lw || 3;
    rr(ctx, x, y, w, h, r); ctx.fill(); ctx.stroke();
  }
  function paintIntro(ctx, f, W, H, src) {
    ctx.globalAlpha = clamp01(f.local / 350);
    const x = 80, y = 520, w = W - 160, maxH = 1130;
    const pool = src.pool || [];
    const px = 34, padX = 22, gap = 12, rowH = 66;
    ctx.font = fontStr(600, px);
    const inner = w - 80;
    const maxRows = Math.floor((maxH - 260) / (rowH + gap));
    let lay = chipLayout((s) => ctx.measureText(s).width, pool, inner, rowH, gap, padX, maxRows);
    if (lay.overflow) { // make room for a "+N more" chip on the last row
      lay.chips.pop();
      lay.overflow += 1;
      const last = lay.chips[lay.chips.length - 1];
      const label = '+' + lay.overflow + ' more';
      const lw = Math.min(inner, ctx.measureText(label).width + padX * 2);
      let nx = last ? last.x + last.w + gap : 0, ny = last ? last.y : 0;
      if (nx + lw > inner) { nx = 0; ny += rowH + gap; }
      lay.chips.push({ name: label, x: nx, y: ny, w: lw, more: true });
    }
    // The card hugs its content: heading + chip rows + padding.
    const rowsUsed = lay.chips.length ? Math.floor(lay.chips[lay.chips.length - 1].y / (rowH + gap)) + 1 : 0;
    const blockH = rowsUsed * rowH + Math.max(0, rowsUsed - 1) * gap;
    const h = Math.min(maxH, 210 + blockH + 60);
    card(ctx, x, y, w, h, 36);
    text(ctx, src.kind === 'manual' ? 'IN THE POOL' : 'IN THE DRAW', W / 2, y + 72, { weight: 700, px: 28, color: THEME.blue, spacing: '6px' });
    text(ctx, pool.length + ' player' + (pool.length === 1 ? '' : 's'), W / 2, y + 146, { weight: 800, px: 64, color: THEME.ink });
    const oy = y + 210;
    lay.chips.forEach((c) => {
      ctx.fillStyle = c.more ? THEME.blueTint : THEME.bg2;
      rr(ctx, x + 40 + c.x, oy + c.y, c.w, rowH, rowH / 2); ctx.fill();
      text(ctx, c.name, x + 40 + c.x + c.w / 2, oy + c.y + rowH / 2, { weight: 600, px, color: c.more ? THEME.blue : THEME.ink });
    });
    ctx.globalAlpha = 1;
  }
  function paintPill(ctx, label, rank, cx, cy) {
    ctx.font = fontStr(700, 34);
    const tw = ctx.measureText(label).width;
    const w = tw + 150, h = 84;
    card(ctx, cx - w / 2, cy - h / 2, w, h, h / 2, THEME.line2, 3);
    ctx.fillStyle = THEME.blue; ctx.beginPath(); ctx.arc(cx - w / 2 + 48, cy, 28, 0, Math.PI * 2); ctx.fill();
    text(ctx, String(rank), cx - w / 2 + 48, cy + 1, { weight: 800, px: 30, color: '#fff' });
    text(ctx, label, cx - w / 2 + 90 + tw / 2, cy + 1, { weight: 700, px: 34, color: THEME.ink, align: 'center' });
  }
  function paintConfetti(ctx, pieces, sinceMs, W, H) {
    for (const c of pieces) {
      const t = (sinceMs / 1000 - c.delay) / c.dur;
      if (t <= 0 || t >= 1) continue;
      const p = easeOut(t);
      ctx.save();
      ctx.globalAlpha = 1 - t * t * t;
      ctx.translate(c.x * W + c.drift * p, -40 + (H + 80) * p);
      ctx.rotate((c.spin * p * Math.PI) / 180);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.size / 2, -c.size / 2, c.size, c.size * 0.62);
      ctx.restore();
    }
  }
  function paintReel(ctx, f, W, H, src) {
    const seg = f.segment;
    const locked = f.phase === 'locked';
    paintPill(ctx, ordinal(seg.rank).toUpperCase() + ' WINNER', seg.rank, W / 2, 560);
    const x = 80, y = 660, w = W - 160, h = 600;
    card(ctx, x, y, w, h, 40, locked ? THEME.blue : THEME.line, locked ? 6 : 3);
    let scale = 1;
    if (locked) { const p = clamp01(f.sinceLock / 450); scale = 1 + 0.1 * Math.sin(p * Math.PI); }
    ctx.save();
    ctx.translate(W / 2, y + h / 2);
    ctx.scale(scale, scale);
    fitFont(ctx, f.name, 800, 128, 52, w - 110);
    ctx.fillStyle = locked ? THEME.blue : THEME.ink;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(f.name, 0, 0);
    ctx.restore();
    text(ctx, locked ? 'WINNER' : 'DRAWING A WINNER', W / 2, y + h + 72, { weight: 700, px: 28, color: locked ? THEME.blue : THEME.ink3, spacing: '6px' });
    if (seg.prize) { // what this rank wins (monthly draw)
      fitFont(ctx, seg.prize, 700, 40, 26, w - 80);
      ctx.fillStyle = locked ? THEME.ink : THEME.ink2; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(seg.prize, W / 2, y + h + (locked ? 130 : 200));
    }
    if (!locked) {
      const bw = w - 200, by = y + h + 130;
      ctx.fillStyle = THEME.line; rr(ctx, W / 2 - bw / 2, by, bw, 10, 5); ctx.fill();
      ctx.fillStyle = THEME.blue; rr(ctx, W / 2 - bw / 2, by, Math.max(10, bw * f.spinProgress), 10, 5); ctx.fill();
    }
    const prev = (src.winners || []).filter((wn) => wn.rank < seg.rank);
    if (prev.length) {
      const py = y + h + (seg.prize && !locked ? 260 : 210);
      text(ctx, 'Already drawn', W / 2, py, { weight: 700, px: 24, color: THEME.ink3, spacing: '4px' });
      prev.forEach((wn, i) => text(ctx, ordinal(wn.rank) + ' · ' + wn.name + (wn.prize ? ': ' + wn.prize : ''), W / 2, py + 52 + i * 46, { weight: 600, px: 34, color: THEME.ink2 }));
    }
    if (locked) paintConfetti(ctx, seg.confetti, f.sinceLock, W, H);
  }
  function paintOutro(ctx, f, W, H, src) {
    ctx.globalAlpha = clamp01(f.local / 350);
    const winners = src.winners || [];
    const x = 80, y = 520, w = W - 160, rowH = 150;
    const h = 150 + winners.length * rowH + 30;
    card(ctx, x, y, w, h, 36, THEME.blue, 5);
    text(ctx, 'WINNERS', W / 2, y + 72, { weight: 700, px: 28, color: THEME.blue, spacing: '6px' });
    winners.forEach((wn, i) => {
      const ry = y + 130 + i * rowH, rh = rowH - 20, mid = ry + rh / 2;
      ctx.fillStyle = THEME.blueTint; rr(ctx, x + 40, ry, w - 80, rh, 30); ctx.fill();
      ctx.fillStyle = THEME.blue; ctx.beginPath(); ctx.arc(x + 112, mid, 42, 0, Math.PI * 2); ctx.fill();
      text(ctx, String(wn.rank), x + 112, mid + 1, { weight: 800, px: 40, color: '#fff' });
      fitFont(ctx, wn.name, 800, 62, 34, w - 330);
      ctx.fillStyle = THEME.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(wn.name, x + 184, mid - (wn.prize ? 22 : 0));
      if (wn.prize) {
        fitFont(ctx, wn.prize, 600, 30, 22, w - 330);
        ctx.fillStyle = THEME.ink2; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(wn.prize, x + 184, mid + 30);
      }
    });
    text(ctx, 'Congratulations!', W / 2, y + h + 100, { weight: 700, px: 52, color: THEME.ink });
    text(ctx, 'See you on court', W / 2, y + h + 170, { weight: 500, px: 34, color: THEME.ink2 });
    ctx.globalAlpha = 1;
  }
  /** Paint the frame for time t (ms) onto a 2D context sized script.width x script.height. */
  function paintFrame(ctx, script, t) {
    const W = script.width, H = script.height, src = script.source || {};
    const f = frameAt(script, t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    paintBackground(ctx, W, H);
    paintHeader(ctx, W, src);
    if (f.type === 'intro') paintIntro(ctx, f, W, H, src);
    else if (f.type === 'reel') paintReel(ctx, f, W, H, src);
    else paintOutro(ctx, f, W, H, src);
    paintFooter(ctx, W, H, src);
    return f;
  }

  // ── play + record (browser) ──────────────────────────────────────────
  /**
   * Play the replay on `canvas` in real time; with opts.record also capture it.
   * Returns { done: Promise<{blob, mimeType, durationMs}>, stop() }. `blob` is
   * null when recording was not requested or is unsupported. stop() cancels
   * (the promise rejects with Error('cancelled')).
   */
  function play(canvas, script, opts) {
    const o = opts || {};
    const ctx = canvas.getContext('2d');
    canvas.width = script.width; canvas.height = script.height;
    let raf = null, stopped = false, recorder = null, start = null, mime = '';
    const chunks = [];
    let resolveDone, rejectDone;
    const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
    const finishWithoutRecorder = () => resolveDone({ blob: null, mimeType: '', durationMs: script.durationMs });
    if (o.record && canRecord()) {
      mime = o.mimeType || pickMimeType();
      try {
        const stream = canvas.captureStream(script.fps);
        recorder = new MediaRecorder(stream, Object.assign({ videoBitsPerSecond: o.bitrate || 6000000 }, mime ? { mimeType: mime } : {}));
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = () => {
          const type = recorder.mimeType || mime || (chunks[0] && chunks[0].type) || '';
          resolveDone({ blob: chunks.length ? new Blob(chunks, { type }) : null, mimeType: type, durationMs: script.durationMs });
        };
        recorder.onerror = (e) => rejectDone((e && e.error) || new Error('Recording failed'));
      } catch (e) { recorder = null; }
    }
    paintFrame(ctx, script, 0);
    if (recorder) { try { recorder.start(250); } catch (e) { recorder = null; } }
    const tick = (now) => {
      if (stopped) return;
      if (start == null) start = now;
      const t = now - start;
      paintFrame(ctx, script, Math.min(t, script.durationMs));
      if (typeof o.onProgress === 'function') o.onProgress(Math.min(t, script.durationMs), script.durationMs);
      if (t >= script.durationMs + 250) { // hold the final frame so the encoder flushes it
        stopped = true;
        if (recorder && recorder.state !== 'inactive') recorder.stop(); else finishWithoutRecorder();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return {
      done,
      get mimeType() { return mime; },
      stop() {
        if (stopped) return;
        stopped = true;
        if (raf) cancelAnimationFrame(raf);
        if (recorder && recorder.state !== 'inactive') { try { recorder.onstop = null; recorder.ondataavailable = null; recorder.stop(); } catch (e) { /* ignore */ } }
        rejectDone(new Error('cancelled'));
      },
    };
  }
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 4000);
  }
  function toFile(blob, filename) { return new File([blob], filename, { type: blob.type || 'video/mp4' }); }
  function canShareFile(blob, filename) {
    try {
      if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare || typeof File === 'undefined') return false;
      return navigator.canShare({ files: [toFile(blob, filename)] });
    } catch (e) { return false; }
  }
  function shareBlob(blob, filename, title) {
    return navigator.share({ files: [toFile(blob, filename)], title: title || 'TZH Lucky Draw' });
  }

  return {
    WIDTH, HEIGHT, FPS, TIMING, MIME_PREFS, CONFETTI_COLORS, THEME,
    isValidISO, ordinal, fmtLongDate, fmtDrawTime, fmtBytes, prng,
    sourceFromSession, sourceFromManual, manualEntriesOf, sourceFromMonthly,
    reelSwaps, buildScript, frameAt, chipLayout,
    monthOf, shiftMonth, monthStartISO, monthLabel, monthGrid, indexDraws,
    canRecord, pickMimeType, extFor, filenameFor,
    paintFrame, play, saveBlob, canShareFile, shareBlob,
  };
});
