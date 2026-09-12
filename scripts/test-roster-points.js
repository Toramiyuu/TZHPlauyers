#!/usr/bin/env node
/* test-roster-points — manual points editing in the Players list (2026-09-12).
 *
 * Points normally accrue automatically (+2 a session) and are wiped at month
 * close, but the organiser needs to award and correct them by hand. Because
 * points decide Monthly-draw eligibility, the edit goes through a validated,
 * audited setRosterPoints action rather than the generic whole-roster merge —
 * a stale read clobbering the squad's totals would be expensive to undo. */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'state.js'), 'utf8');
const S = require('../api/state.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
function extractFn(name, s) {
  const start = s.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = s.indexOf('{', start);
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') d++;
    else if (s[i] === '}') { d--; if (d === 0) return s.slice(start, i + 1); }
  }
  return null;
}
const fn = (n) => extractFn(n, html) || '';
const B = S.buildRosterPointsUpdate;
const ROSTER = () => [
  { id: 'r1', name: 'Alex', points: 28 },
  { id: 'r2', name: 'Bea', points: 0 },
  { id: 'r3', name: 'Cy' },            // points field absent entirely
];

// ── setting an absolute total ──
check('sets the total outright', (() => { const r = B(ROSTER(), 'r1', { points: 50 }); return r.ok && r.next === 50 && r.prev === 28; })());
check('the updated roster carries the new total', B(ROSTER(), 'r1', { points: 50 }).roster.find(p => p.id === 'r1').points === 50);
check('other players are untouched', (() => {
  const r = B(ROSTER(), 'r1', { points: 50 });
  return r.roster.find(p => p.id === 'r2').points === 0 && r.roster.find(p => p.id === 'r3').points === undefined;
})());
check('zero is a legal total', B(ROSTER(), 'r1', { points: 0 }).ok);
check('MAX_POINTS is a legal total', B(ROSTER(), 'r1', { points: S.MAX_POINTS }).ok);
check('a negative total is refused', !B(ROSTER(), 'r1', { points: -1 }).ok);
check('past MAX_POINTS is refused', !B(ROSTER(), 'r1', { points: S.MAX_POINTS + 1 }).ok);
check('a fractional total is refused', !B(ROSTER(), 'r1', { points: 12.5 }).ok);
check('junk is refused, not coerced (Number(true)===1, Number([])===0)', !B(ROSTER(), 'r1', { points: 'abc' }).ok && !B(ROSTER(), 'r1', { points: true }).ok && !B(ROSTER(), 'r1', { points: [] }).ok && !B(ROSTER(), 'r1', { points: {} }).ok);
check('junk deltas are refused the same way', !B(ROSTER(), 'r1', { delta: true }).ok && !B(ROSTER(), 'r1', { delta: [] }).ok);
check('a numeric string still works (form inputs send strings)', (() => { const r = B(ROSTER(), 'r1', { points: '40' }); return r.ok && r.next === 40; })());

// ── delta (the − / + buttons) ──
check('a positive delta adds to the current total', B(ROSTER(), 'r1', { delta: 5 }).next === 33);
check('a negative delta subtracts', B(ROSTER(), 'r1', { delta: -8 }).next === 20);
check('a delta cannot drive a player negative — it clamps at zero', (() => { const r = B(ROSTER(), 'r2', { delta: -5 }); return r.ok && r.next === 0; })());
check('a delta clamps at MAX_POINTS', B(ROSTER(), 'r1', { delta: S.MAX_POINTS }).next === S.MAX_POINTS);
check('a missing points field counts as zero for a delta', (() => { const r = B(ROSTER(), 'r3', { delta: 3 }); return r.ok && r.prev === 0 && r.next === 3; })());
check('a fractional delta is refused', !B(ROSTER(), 'r1', { delta: 1.5 }).ok);

// ── guards ──
check('an unknown player is refused', !B(ROSTER(), 'nope', { points: 5 }).ok && /not on the roster/.test(B(ROSTER(), 'nope', { points: 5 }).error));
check('sending neither points nor delta is refused', !B(ROSTER(), 'r1', {}).ok);
check('sending BOTH points and delta is refused (ambiguous)', !B(ROSTER(), 'r1', { points: 5, delta: 2 }).ok);
check('an empty string is treated as "not supplied"', !B(ROSTER(), 'r1', { points: '', delta: '' }).ok);
check('a missing roster is handled, not crashed on', !B(null, 'r1', { points: 5 }).ok && !B(undefined, 'r1', { points: 5 }).ok);
check('the helper never mutates the roster it is given', (() => {
  const r = ROSTER();
  B(r, 'r1', { points: 999 });
  return r[0].points === 28;
})());
check('isPointsValue only accepts whole numbers in range', S.isPointsValue(0) && S.isPointsValue(S.MAX_POINTS) && !S.isPointsValue(-1) && !S.isPointsValue(1.5) && !S.isPointsValue(S.MAX_POINTS + 1));

// ── HTTP branch ──
check('setRosterPoints is dispatched before the unknown-action 400', src.indexOf("updates.action === 'setRosterPoints'") < src.indexOf("return res.status(400).json({ error: 'Unknown action.' });"));
check('a refused edit answers 400 with the reason', /setRosterPoints'\)[\s\S]{0,200}if \(!built\.ok\) return res\.status\(400\)\.json\(\{ error: built\.error \}\);/.test(src));
check('a real change is written to the audit log', /pushAudit\(state, \{\s*action: 'roster\.points'/.test(src) && src.includes('prevValue: built.prev') && src.includes('newValue: built.next'));
check('the audit entry names the player', src.includes("target: { type: 'player', id: built.player.id, label: built.player.name || built.player.id }"));
check('a no-op edit skips the write and the audit entry', src.includes('if (built.prev !== built.next) {'));
check('a failed KV write answers 500 rather than pretending to succeed', /KV write error \(setRosterPoints\)[\s\S]{0,140}res\.status\(500\)/.test(src));
check('the response returns the stored total (it may have been clamped)', src.includes('return res.json({ ok: true, playerId: built.player.id, points: built.next, roster: state.roster });'));
check('pushAudit is imported in api/state.js', src.includes("const { pushAudit } = require('../lib/audit.js');"));
check('server.js mirrors the branch', (() => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  return srv.includes("updates.action === 'setRosterPoints'") && srv.includes('buildRosterPointsUpdate');
})());

// ── client ──
const w = fn('writePlayerPoints'), sp = fn('setPlayerPoints'), bp = fn('bumpPlayerPoints');
check('the client uses the action, never a whole-roster POST', w.includes("apiPost({ action: 'setRosterPoints', playerId: id, ...body })") && !w.includes('apiPost({ roster })'));
check('a refused save is reported instead of a silent success', w.includes("notify(r.error || 'Could not save those points.', 'warn')"));
check('a refused save restores the real total from the server', w.includes('await refreshState();') && w.indexOf('await refreshState();') < w.indexOf('return notify(r.error'));
check('a 401 exits quietly — the password prompt is already up', w.includes('if (!r) return;'));
check('a network error is caught and reported', w.includes("catch(() => ({ error: 'Network error — points not saved.' }))"));
check('the client adopts the roster the server returned', w.includes('if (r.roster) state.roster = r.roster;'));
check('typing renders optimistically before the round trip', w.indexOf('renderPlayersSection();') < w.indexOf('await apiPost'));
check('typed edits send an absolute total', sp.includes('writePlayerPoints(id, { points: n }, n)'));
check('typed edits round and reject negatives', sp.includes('Math.round(Number(value))') && sp.includes("notify('Points must be 0 or more.', 'warn')"));
check('typing the same number does not fire a write', sp.includes('if (n === (cur.points || 0)) return;'));
check('the steppers send a DELTA so a concurrent session award is not clobbered', bp.includes('writePlayerPoints(id, { delta }, optimistic)') && bp.includes("delta"));
check('the stepper preview never shows a negative total', bp.includes('Math.max(0, (cur.points || 0) + delta)'));

// ── markup + CSS ──
const row = fn('renderRosterList');
check('the points cell holds a number input bound to setPlayerPoints', row.includes('class="rl-pts-inp"') && row.includes("onchange=\"setPlayerPoints('${rp.id}',this.value)\""));
check('the points input is labelled per player', row.includes('aria-label="Points for ${escHtml(rp.name)}"'));
check('tapping the points input never toggles the session or the drawer', row.includes('onclick="event.stopPropagation()"') && /rl-pt-step" onclick="event\.stopPropagation\(\);bumpPlayerPoints/.test(row));
check('focusing the box selects it so a new total overwrites cleanly', row.includes('onfocus="this.select()"'));
check('the − and + buttons are real buttons with labels', (row.match(/class="rl-pt-step"/g) || []).length === 2 && row.includes('aria-label="One point off') && row.includes('aria-label="One point on for'));
check('the minus uses the typographic &minus;, not a hyphen glyph', row.includes('>&minus;<'));
check('.rl-pts lays the editor out on one line', html.includes('.rl-pts{display:flex;align-items:center;justify-content:flex-end;gap:4px;'));
check('.rl-pts-inp has a focus ring and no !important', html.includes('.rl-pts-inp:focus{outline:none;border-color:var(--a-blue,#0071e3)}') && !/\.rl-pts-inp[^\n]*!important/.test(html));
check('.rl-pt-step is keyboard focusable with a visible ring', html.includes('.rl-pt-step:focus-visible{outline:2px solid var(--a-blue,#0071e3);outline-offset:1px}'));
check('phone: the 22px steppers are hidden and the box fills the column', html.includes('.rl-pt-step{display:none}') && html.includes('.rl-pts-inp{width:100%;padding:8px 2px}'));

console.log(`\ntest-roster-points: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
