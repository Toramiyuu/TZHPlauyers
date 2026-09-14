#!/usr/bin/env node
/* Lucky Draw replay video + calendar (public/draw-video.js) — pure-logic tests
 * plus static assertions on public/index.html wiring. No DOM: the canvas
 * painter and MediaRecorder path are covered by the headless-Chrome check. */
'use strict';
const fs = require('fs');
const path = require('path');
const DV = require('../public/draw-video.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
function extractFn(name, src) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) return '';
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (!depth) break; } }
  return src.slice(i, j + 1);
}
const fn = (n) => extractFn(n, html);

// ── fixtures ──
const doneView = {
  date: '2026-09-07', status: 'done', method: 'auto', drawnAt: Date.UTC(2026, 8, 11, 1, 0), seed: 'abcdef0123456789abcdef0123456789', verified: true,
  counts: { attended: 5, paid: 4, eligible: 4, winners: 2 },
  lists: {
    attended: [{ id: 'p1', name: 'Alex' }, { id: 'p2', name: 'Bao' }, { id: 'p3', name: 'Celine' }, { id: 'p4', name: 'Desmond' }, { id: 'p5', name: 'Eve' }],
    paid: [], eligible: [{ id: 'p1', name: 'Alex' }, { id: 'p2', name: 'Bao' }, { id: 'p3', name: 'Celine' }, { id: 'p4', name: 'Desmond' }],
    winners: [{ id: 'p3', name: 'Celine' }, { id: 'p1', name: 'Alex' }],
  },
};
const pendingView = { date: '2026-09-11', status: 'pending', lists: { eligible: [{ id: 'p1', name: 'Alex' }], winners: [] } };

// ── sources ──
const s = DV.sourceFromSession(doneView);
check('session source: kind/date/key', s && s.kind === 'session' && s.date === '2026-09-07' && s.key === 'session:2026-09-07');
check('session source: pool = eligible names, winners ranked in stored order', s.pool.join(',') === 'Alex,Bao,Celine,Desmond' && s.winners.map(w => w.rank + ':' + w.name).join(',') === '1:Celine,2:Alex');
check('session source: subtitle/when/method/note', s.subtitle === 'Monday 7 September 2026 session' && s.when === 'Drawn Fri 11 Sep · 9:00 AM' && s.method === 'Automatic draw' && s.note === '4 eligible · verified');
check('session source: pending or no-winner views are not replayable', DV.sourceFromSession(pendingView) === null && DV.sourceFromSession(Object.assign({}, doneView, { lists: Object.assign({}, doneView.lists, { winners: [] }) })) === null);
check('session source: "Run draw now" records are labelled', DV.sourceFromSession(Object.assign({}, doneView, { method: 'manual' })).method === 'Draw run by admin');
check('session source: test draws are labelled and flagged', (() => { const t = DV.sourceFromSession(Object.assign({}, doneView, { test: true })); return t.test === true && t.method === 'Test draw' && /not a real result/.test(t.note) && DV.sourceFromSession(doneView).test === false; })());

const manualEntry = { date: '2026-09-06', at: Date.UTC(2026, 8, 6, 15, 5), key: 'manual:x', winners: [{ rank: 2, name: 'Kenn', pool: ['Yau', 'Kenn'] }, { rank: 1, name: 'Seng', pool: ['Yau', 'Kenn', 'Seng'] }] };
const m = DV.sourceFromManual(manualEntry);
check('manual source: sorted by rank, per-winner pools kept', m && m.kind === 'manual' && m.winners.map(w => w.name).join(',') === 'Seng,Kenn' && m.winners[1].pool.join(',') === 'Yau,Kenn' && m.pool.join(',') === 'Yau,Kenn,Seng');
check('manual source: label + note', m.method === 'Manual quick draw' && m.note === '3 in the pool' && m.subtitle === 'Sunday 6 September 2026' && m.when === 'Drawn Sun 6 Sep · 11:05 PM');
check('manual source: legacy history without pools is not replayable', DV.sourceFromManual({ date: '2026-08-30', at: 1, winners: [{ rank: 1, name: 'Yau' }] }) === null);
check('manual source: rejects bad dates / empty winners', DV.sourceFromManual({ date: 'nope', winners: [{ rank: 1, name: 'A', pool: ['A'] }] }) === null && DV.sourceFromManual({ date: '2026-09-06', winners: [] }) === null);

// ── manualEntriesOf: live results (revealed only) + history, newest first ──
const NOW = Date.UTC(2026, 8, 10, 12, 0);
const ld = {
  drawDate: '2026-09-10',
  results: [{ rank: 1, name: 'Alex', at: NOW - 1000, pool: ['Alex', 'Bao'] }, { rank: 2, name: 'Bao', at: NOW + 4000, pool: ['Bao'] }],
  history: [{ date: '2026-09-04', at: NOW - 6 * 864e5, winners: [{ rank: 1, name: 'Celine', pool: ['Celine', 'Eve'] }] }, { date: '2026-09-07', at: NOW - 3 * 864e5, winners: [{ rank: 1, name: 'Eve' }] }],
};
const ents = DV.manualEntriesOf(ld, NOW);
check('manualEntriesOf: order newest first, live entry first for today', ents.map(e => e.date).join(',') === '2026-09-10,2026-09-07,2026-09-04' && ents[0].live === true);
check('manualEntriesOf: live entry hides winners not yet revealed', ents[0].winners.length === 1 && ents[0].winners[0].name === 'Alex');
check('manualEntriesOf: keys are unique and stable', new Set(ents.map(e => e.key)).size === 3 && /^manual:2026-09-04:\d+:0$/.test(ents[2].key));
check('manualEntriesOf: tolerates junk', DV.manualEntriesOf(null).length === 0 && DV.manualEntriesOf({ history: 'x', results: 5 }).length === 0);
check('manualEntriesOf: entry without pool → card but no replay', DV.sourceFromManual(ents[1]) === null && !!DV.sourceFromManual(ents[2]));

// ── replay script ──
const sc = DV.buildScript(s);
check('script: portrait 1080x1920 @30fps', sc.width === 1080 && sc.height === 1920 && sc.fps === 30);
check('script: intro + one reel per winner + outro', sc.segments.map(x => x.type).join(',') === 'intro,reel,reel,outro');
check('script: contiguous, total = sum of timings', sc.segments.every((x, i) => i === 0 ? x.start === 0 : x.start === sc.segments[i - 1].end) && sc.durationMs === DV.TIMING.intro + 2 * (DV.TIMING.reel + DV.TIMING.hold) + DV.TIMING.outro);
const r1 = sc.segments[1], r2 = sc.segments[2];
check('script: reel 1 spins over the full pool, reel 2 without the first winner', r1.pool.join(',') === 'Alex,Bao,Celine,Desmond' && r2.pool.join(',') === 'Alex,Bao,Desmond' && r1.winner === 'Celine' && r2.winner === 'Alex');
check('script: swaps decelerate (45 ms → ~330 ms), strictly increasing, all before the lock', r1.swaps.length > 15 && r1.swaps.every((x, i) => i === 0 || x.at > r1.swaps[i - 1].at) && r1.swaps[r1.swaps.length - 1].at < DV.TIMING.reel && (r1.swaps[1].at - r1.swaps[0].at) < 60 && (r1.swaps[r1.swaps.length - 1].at - r1.swaps[r1.swaps.length - 2].at) > 250);
check('script: no name repeats back-to-back on the reel', r1.swaps.every((x, i) => i === 0 || x.name !== r1.swaps[i - 1].name));
check('script: every reel name is from the pool', r1.swaps.every(x => r1.pool.includes(x.name)));
check('script: deterministic for the same seed, different for another', JSON.stringify(DV.buildScript(s).segments[1].swaps) === JSON.stringify(r1.swaps) && JSON.stringify(DV.buildScript(Object.assign({}, s, { seed: 'other' })).segments[1].swaps) !== JSON.stringify(r1.swaps));
check('script: confetti pieces are seeded and bounded', r1.confetti.length === 80 && r1.confetti.every(c => c.x >= 0 && c.x < 1 && c.dur >= 1.6 && DV.CONFETTI_COLORS.includes(c.color)));
const ms = DV.buildScript(m);
check('script (manual): uses each winner\'s own pool', ms.segments[1].pool.join(',') === 'Yau,Kenn,Seng' && ms.segments[2].pool.join(',') === 'Yau,Kenn' && ms.segments[2].winner === 'Kenn');
check('script: winner missing from a pool is appended, never dropped', DV.buildScript({ pool: ['A', 'B'], winners: [{ rank: 1, name: 'Z' }] }).segments[1].pool.join(',') === 'A,B,Z');
check('script: custom timing is honoured', DV.buildScript(s, { timing: { intro: 100, reel: 200, hold: 50, outro: 10 } }).durationMs === 100 + 2 * 250 + 10);

// ── frameAt ──
const fIntro = DV.frameAt(sc, 100), fSpin = DV.frameAt(sc, r1.spinStart + 1000), fLock = DV.frameAt(sc, r1.lockAt + 10), fOut = DV.frameAt(sc, sc.durationMs - 1), fEnd = DV.frameAt(sc, sc.durationMs + 9999);
check('frameAt: intro', fIntro.type === 'intro' && fIntro.progress > 0 && fIntro.progress < 0.1);
check('frameAt: spinning shows the scheduled reel name and progress', fSpin.type === 'reel' && fSpin.phase === 'spin' && r1.pool.includes(fSpin.name) && fSpin.spinProgress > 0.2 && fSpin.spinProgress < 0.25);
check('frameAt: name follows the swap schedule exactly', (() => { const sw = r1.swaps[5]; const f = DV.frameAt(sc, r1.spinStart + sw.at); const g = DV.frameAt(sc, r1.spinStart + sw.at - 1); return f.name === sw.name && g.name === r1.swaps[4].name; })());
check('frameAt: locked = winner with sinceLock', fLock.phase === 'locked' && fLock.name === 'Celine' && fLock.sinceLock === 10);
check('frameAt: outro at the end, clamps past the end', fOut.type === 'outro' && fEnd.type === 'outro' && fEnd.t === sc.durationMs);
check('frameAt: before the first swap shows pool[0]', DV.frameAt(sc, r1.spinStart).name === r1.pool[0]);

// ── calendar helpers ──
const g = DV.monthGrid(2026, 8, 1); // September 2026 starts on a Tuesday
check('monthGrid: 42 cells, Monday-first, label', g.cells.length === 42 && g.cells[0].iso === '2026-08-31' && g.cells[1].iso === '2026-09-01' && g.label === 'September 2026' && g.weekdays.join('') === 'MonTueWedThuFriSatSun');
check('monthGrid: inMonth flags + weekday', g.cells.filter(c => c.inMonth).length === 30 && g.cells[0].inMonth === false && g.cells[1].weekday === 2);
check('monthGrid: Sunday-first option', DV.monthGrid(2026, 8, 0).cells[0].iso === '2026-08-30');
check('shiftMonth wraps years', JSON.stringify(DV.shiftMonth(2026, 11, 1)) === '{"year":2027,"month0":0}' && JSON.stringify(DV.shiftMonth(2026, 0, -1)) === '{"year":2025,"month0":11}');
check('monthOf / monthStartISO', JSON.stringify(DV.monthOf('2026-09-07')) === '{"year":2026,"month0":8}' && DV.monthOf('x') === null && DV.monthStartISO(2026, 8) === '2026-09-01');
const idx = DV.indexDraws([doneView, pendingView], ents);
check('indexDraws: session + manual marks per date', idx['2026-09-07'].session === doneView && idx['2026-09-07'].manual.length === 1 && idx['2026-09-11'].session === pendingView && idx['2026-09-10'].manual.length === 1 && idx['2026-09-10'].session === null && !idx['2026-09-08']);

// ── output helpers ──
check('pickMimeType prefers MP4, falls back to WebM, empty when nothing', DV.pickMimeType(t => /mp4/.test(t)) === 'video/mp4;codecs=avc1.42E01E' && DV.pickMimeType(t => t === 'video/webm') === 'video/webm' && DV.pickMimeType(() => false) === '');
check('extFor / filenameFor', DV.extFor('video/mp4;codecs=avc1') === 'mp4' && DV.extFor('video/webm') === 'webm' && DV.filenameFor(s, 'video/mp4') === 'TZH-Lucky-Draw-2026-09-07.mp4' && DV.filenameFor(m, 'video/webm') === 'TZH-Lucky-Draw-2026-09-06-quick-draw.webm');
check('fmtBytes', DV.fmtBytes(512) === '1 KB' && DV.fmtBytes(3.2 * 1024 * 1024) === '3.2 MB');
check('chipLayout wraps and reports overflow', (() => { const l = DV.chipLayout(() => 100, ['a', 'b', 'c', 'd', 'e'], 250, 40, 10, 10, 2); return l.chips.length === 4 && l.overflow === 1 && l.chips[2].y === 50 && l.chips[1].x === 130; })());
check('canRecord is false in Node', DV.canRecord() === false);

// ── index.html wiring ──
check('draw-video.js is loaded after session-draw.js', html.indexOf('<script src="/draw-video.js"></script>') > html.indexOf('<script src="/session-draw.js"></script>'));
check('calendar containers on the public page and the admin list', html.includes('id="drawPageCal"') && html.includes('id="sdAdminCal"'));
check('public page: "Record" eyebrow sits between How-it-works and the calendar', (() => { const a = html.indexOf('id="drawPageHow"'), b = html.indexOf('class="md-sec-title sd-record-title">Record<'), c = html.indexOf('id="drawPageCal"'); return a > -1 && a < b && b < c; })());
check('admin: Sessions card is titled "Record" with a pick-a-date hint above the calendar', (() => { const a = html.indexOf('</svg></span> Record</span>'), b = html.indexOf('Pick a date to see who won that night.'), c = html.indexOf('id="sdAdminCal"'); return a > -1 && a < b && b < c; })());
check('record eyebrow has no double gap under the how-it-works box', html.includes('.sd-record-title{margin-top:0}'));
check('video modal markup', html.includes('id="drawVideoModal"') && html.includes('id="dvCanvas"') && html.includes('id="dvDownload"') && html.includes('id="dvShare"') && html.includes('id="dvReplay"'));
check('drawn session cards get Play / Download', fn('sdCardHtml').includes("if (w.length) html += sdVideoRowHtml(v.test ? 'test' : 'session', v.date);") && fn('sdVideoRowHtml').includes('Download video') && fn('sdVideoRowHtml').includes('Play replay'));
check('manual quick draw cards rendered by the shared list', fn('renderDrawList').includes("i.kind === 'manual' ? qdCardHtml(i.e)") && fn('qdCardHtml').includes('DrawVideo.sourceFromManual(e)') && fn('qdCardHtml').includes('No replay'));
check('Session Draw page renders the calendar + its own items', fn('renderSessionDraw').includes("renderDrawCalendar(document.getElementById('drawPageCal'), sdPublic, false)") && fn('renderSessionDraw').includes('sdListItems(sdPublic, false)'));
check('admin list renders through renderSessionDrawsAdminView', fn('loadAdminDraws').includes('renderSessionDrawsAdminView();') && fn('renderSessionDrawsAdminView').includes("renderDrawCalendar(document.getElementById('sdAdminCal'), sdAdmin, true)"));
check('calendar day picks filter, month nav pages older sessions in', fn('sdCalPick').includes('cs.sel = (iso && cs.sel !== iso) ? iso : null') && fn('sdEnsureMonthLoaded').includes('await loadDrawPage(true)') && fn('sdEnsureMonthLoaded').includes('await loadAdminDraws(true)'));
check('manual draws older than the loaded range wait for paging', fn('sdListItems').includes('manual.filter(e => e.date >= oldest)'));
check('spinDraw stores the reel pool with each result', fn('spinDraw').includes('pool: [...names]'));
check('startNewDraw carries the pool into history', fn('startNewDraw').includes('pool: r.pool'));
check('openDrawVideo records when supported and auto-saves on Download', fn('openDrawVideo').includes('record: canRec') && fn('openDrawVideo').includes('if (dvAutoSave) dvSave();') && fn('openDrawVideo').includes('DrawVideo.buildScript(src)'));
check('closeDrawVideo stops playback and is in the Escape registry', fn('closeDrawVideo').includes('dvCtl.stop()') && fn('closeOpenOverlays').includes("isOpen('drawVideoModal')"));
check('CSS: calendar + modal styles present, portrait canvas', /\.sdc-grid\{display:grid;grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/.test(html) && /#drawVideoModal\.open\{display:flex\}/.test(html) && /#dvCanvas\{[^}]*aspect-ratio:9\/16/.test(html));

// ── monthly (points) draw source ──
const monthlyView = { month: '2026-09', label: 'September 2026', status: 'done', method: 'auto', drawnAt: Date.UTC(2026, 9, 1, 1, 0), drawDate: '2026-10-01', seed: 'abcdef0123456789abcdef0123456789', verified: true, threshold: 80,
  counts: { eligible: 3, winners: 2 }, lists: { eligible: [{ id: 'p1', name: 'Alex' }, { id: 'p2', name: 'Bao' }, { id: 'p3', name: 'Celine' }], winners: [{ rank: 2, name: 'Alex', prize: '' }, { rank: 1, name: 'Celine', prize: 'Racket' }] } };
const mo = DV.sourceFromMonthly(monthlyView);
check('monthly source: kind/key/date (draw day in MYT)/title/subtitle', mo && mo.kind === 'monthly' && mo.key === 'monthly:2026-09' && mo.date === '2026-10-01' && mo.title === 'Monthly Draw' && mo.subtitle === 'September 2026' && mo.when === 'Drawn Thu 1 Oct · 9:00 AM');
check('monthly source: pool = eligible names, winners sorted by rank with prizes', mo.pool.join(',') === 'Alex,Bao,Celine' && mo.winners.map(w => w.rank + ':' + w.name + ':' + w.prize).join(',') === '1:Celine:Racket,2:Alex:');
check('monthly source: note/method/verified, pending or winnerless months not replayable', mo.note === '3 reached 80 points · verified' && mo.method === 'Automatic draw' && DV.sourceFromMonthly(Object.assign({}, monthlyView, { status: 'pending' })) === null && DV.sourceFromMonthly(Object.assign({}, monthlyView, { lists: { eligible: [], winners: [] } })) === null && DV.sourceFromMonthly(Object.assign({}, monthlyView, { method: 'manual' })).method === 'Draw run by admin');
const moScript = DV.buildScript(mo);
check('script carries the prize into each reel segment', moScript.segments.filter(x => x.type === 'reel').map(x => x.prize).join('|') === 'Racket|');
check('filenames per kind', DV.filenameFor(mo, 'video/mp4') === 'TZH-Monthly-Draw-2026-09.mp4' && DV.filenameFor(s, 'video/webm') === 'TZH-Lucky-Draw-2026-09-07.webm');
// ── Shuttlecock ballot replays removed with the draw (2026-09) ──
check('no Shuttlecock source or entry builder survives', DV.sourceFromShuttlecock === undefined && DV.shuttlecockEntriesOf === undefined);
check('indexDraws takes only sessions + quick draws now', DV.indexDraws.length === 2 && (() => {
  const i = DV.indexDraws([doneView], DV.manualEntriesOf(ld, NOW));
  return i['2026-09-07'].session === doneView && i['2026-09-07'].shuttle === undefined && Array.isArray(i['2026-09-10'].manual);
})());
check('outro/reel painters read the prize (static)', /wn\.prize/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'draw-video.js'), 'utf8')) && /seg\.prize/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'draw-video.js'), 'utf8')));

console.log('\ndraw video: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
