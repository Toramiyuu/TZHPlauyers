#!/usr/bin/env node
/* test-feedback-overview — the admin Feedback tab opens on "Just in" rather than
 * on a single night.
 *
 * Why the tab needed it: members rate ANY night they played, so a reply that
 * arrived this morning is usually about a night days or weeks back. A per-night
 * calendar can only show it to someone who already knows which date to look at,
 * which means new replies were invisible. The overview lists everything
 * SUBMITTED in the last 2 days, grouped under the night it is ABOUT, and each
 * group heading opens that night in full.
 *
 * Logic lives in Feedback.recentSubmissions (public/feedback.js); the DOM glue
 * is renderFbRecent / fbSelectDate / fbShowRecent in public/index.html. */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const FB = require('../public/feedback.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

console.log('\ntest-feedback-overview — Feedback tab opens on what just came in\n');

// ── fixtures ─────────────────────────────────────────────────────────
const H = 3600000, D = 86400000;
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0); // 2026-09-23 noon

// Three nights, replies sent at wildly different times from the night they are
// about — the case the calendar could not surface.
const rec = (name, at, over) => Object.assign({
  name, good: ['level'], bad: [], goodNote: '', badNote: '', at, updatedAt: at, awarded: true,
}, over || {});
const state = {
  feedback: {
    // last Friday's night: one reply sent that night, one sent this morning
    '2026-09-18': {
      p1: rec('Janice', NOW - 5 * D),
      p2: rec('Leslie', NOW - 3 * H),
    },
    // a night three weeks ago, rated only today
    '2026-09-01': { p3: rec('Eric', NOW - 20 * H) },
    // an old night rated at the time and never touched since
    '2026-08-11': { p4: rec('Desmond', NOW - 40 * D) },
  },
};

// ── the window is on the SUBMISSION, not the night ───────────────────
const view = FB.recentSubmissions(state, { nowMs: NOW });
check('default window is 2 days', view.days === 2 && FB.RECENT_DAYS === 2);
check('picks up replies sent inside the window', view.count === 2);
check('a reply sent 3h ago about a 5-day-old night is IN', view.rows.some(r => r.name === 'Leslie' && r.night === '2026-09-18'));
check('a reply sent 20h ago about a 3-week-old night is IN', view.rows.some(r => r.name === 'Eric' && r.night === '2026-09-01'));
check('a reply sent 5 days ago is OUT even though its night is recent', !view.rows.some(r => r.name === 'Janice'));
check('a reply sent 40 days ago is OUT', !view.rows.some(r => r.name === 'Desmond'));
check('nothing is flagged as a fallback while the window has rows', view.fallback === false);

// ── grouped under the night, newest night first ──────────────────────
check('one group per night', view.nights.length === 2);
check('newest night leads', view.nights[0].night === '2026-09-18');
check('older night follows', view.nights[1].night === '2026-09-01');
check('each group carries only its own rows',
  view.nights[0].rows.length === 1 && view.nights[0].rows[0].name === 'Leslie');

// ── newest submission first within the whole view ────────────────────
check('rows are newest-submission first', view.rows[0].name === 'Leslie' && view.rows[1].name === 'Eric');

// ── roster names win over the name stored on the record ──────────────
const renamed = FB.recentSubmissions(state, { nowMs: NOW, names: { p2: 'Leslie Tan' } });
check('live roster spelling wins', renamed.rows.some(r => r.name === 'Leslie Tan'));

// ── a quiet fortnight shows the latest rather than nothing ───────────
const quiet = FB.recentSubmissions(state, { nowMs: NOW + 10 * D });
check('quiet window falls back instead of going blank', quiet.fallback === true && quiet.count > 0);
check('fallback is capped', FB.RECENT_FALLBACK === 10 && quiet.count <= FB.RECENT_FALLBACK);
check('fallback is still newest first', quiet.rows[0].name === 'Leslie');
check('fallback still groups by night', quiet.nights[0].night === '2026-09-18');

// ── nothing at all ───────────────────────────────────────────────────
const empty = FB.recentSubmissions({ feedback: {} }, { nowMs: NOW });
check('an empty store is empty, not a fallback', empty.count === 0 && empty.fallback === false);
check('junk state never throws', FB.recentSubmissions(null, null).count === 0);
check('a junk night key is skipped', FB.recentSubmissions({ feedback: { nope: { p1: rec('X', NOW) } } }, { nowMs: NOW }).count === 0);

// ── empty records are not replies ────────────────────────────────────
const blank = { feedback: { '2026-09-18': { p9: { name: 'Blank', good: [], bad: [], goodNote: '', badNote: '', at: NOW, updatedAt: NOW } } } };
check('a contentless record is not listed', FB.recentSubmissions(blank, { nowMs: NOW }).count === 0);

// ── an edit moves a reply back into the window ───────────────────────
const edited = { feedback: { '2026-09-18': { p1: rec('Janice', NOW - 5 * D, { updatedAt: NOW - H }) } } };
const ev = FB.recentSubmissions(edited, { nowMs: NOW });
check('an edited old reply comes back into the window', ev.count === 1);
check('and is marked as edited', ev.rows[0].edited === true);

// ── allSubmissions is the unfiltered flatten ─────────────────────────
check('allSubmissions returns every real row', FB.allSubmissions(state).length === 4);
check('every row is stamped with its night', FB.allSubmissions(state).every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.night)));

// ── DOM glue in index.html ───────────────────────────────────────────
check('the tab has both panes', html.includes('id="fbNightPane"') && html.includes('id="fbRecentPane"'));
check('the view toggle is wired', html.includes('onclick="fbShowRecent()"') && html.includes('onclick="fbShowNight()"'));
check('the tab defaults to the overview', /let fbView = 'recent'/.test(html));
check('the overview renderer is called for the recent view', html.includes('if (recent) { renderFbRecent(); return; }'));
check('the overview asks for the recent window', html.includes('Feedback.recentSubmissions('));
check('a group heading opens that night', /class="fb-grp-head" onclick="fbSelectDate\(/.test(html));
check('picking a date leaves the overview', /function fbSelectDate[\s\S]{0,220}fbView = 'night'/.test(html));
check('picking the already-selected date still switches view',
  !/function fbSelectDate\(iso\) \{\s*if \(!iso \|\| iso === fbDate\) return;/.test(html));
check('both lists render rows through one helper',
  (html.match(/fbRowHtml/g) || []).length >= 3);
check('the overview pane is styled', html.includes('.fb-grp{') && html.includes('.fb-view-btn{'));

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail ? '\nRESULT: FAIL\n' : '\nRESULT: PASS — the Feedback tab opens on what just came in.\n');
process.exit(fail ? 1 : 0);
