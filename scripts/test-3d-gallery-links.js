#!/usr/bin/env node
/*
 * test-3d-gallery-links.js — guard for the /3d gallery's relative-link resolution.
 *
 * BUG this reproduces: the gallery (public/3d/index.html) links to its arena
 * previews with RELATIVE urls, e.g. `href="arena-webgl.html"` and
 * `data-src="arena-webgl.html"`. Vercel serves the gallery at `/3d` WITHOUT
 * redirecting to `/3d/`. With no trailing slash the document's base url is
 * `/3d` (a file, not a directory), so the browser resolves `arena-webgl.html`
 * to `/arena-webgl.html` (root) → 404. All 13 cards break; only the first one
 * is visible because the rest lazy-load below the fold.
 *
 * FIX: a single `<base href="/3d/">` in <head> forces every relative url to
 * resolve against `/3d/` regardless of trailing slash.
 *
 * This test emulates the browser's url-resolution algorithm exactly:
 *   effective base = <base href> resolved against the document url, else the
 *   document url itself; each link is then resolved against that base. We use
 *   the worst case document url (`/3d`, no trailing slash) and assert every
 *   arena link + asset resolves under `/3d/` and points at a file that exists.
 *
 * Exit 0 = green, exit 1 = red.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(path.resolve(__dirname, '..'), 'public', '3d');
const HTML_PATH = path.join(DIR, 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// Worst-case document url: served at /3d with no trailing slash (Vercel default).
const DOC_URL = 'https://tzhplayers.vercel.app/3d';

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
}

// ── effective base url (mirrors the HTML <base> algorithm) ──────────
const baseMatch = html.match(/<base\b[^>]*\bhref="([^"]+)"/i);
const baseHref = baseMatch ? baseMatch[1] : null;
const baseURL = baseHref ? new URL(baseHref, DOC_URL).href : DOC_URL;

// ── collect every relative url the gallery depends on ──────────────
const refs = [];
const attrRe = /\b(?:href|src|data-src)="([^"]+)"/gi;
let m;
while ((m = attrRe.exec(html)) !== null) {
  const url = m[1];
  // skip absolute urls (http/https), protocol-relative, anchors, data uris
  if (/^(?:https?:)?\/\//i.test(url) || url.startsWith('#') || url.startsWith('data:')) continue;
  refs.push(url);
}

check(refs.length > 0, 'no relative urls found in gallery — parser likely broken');

// ── every relative url must resolve under /3d/ AND exist on disk ────
for (const ref of refs) {
  const resolved = new URL(ref, baseURL).pathname; // e.g. /3d/arena-webgl.html
  check(
    resolved.startsWith('/3d/'),
    `"${ref}" resolves to ${resolved} (expected under /3d/) — relative link breaks when /3d is opened without a trailing slash; add <base href="/3d/">`
  );
  // map the resolved /3d/... path back to a file on disk and confirm it exists
  const rel = resolved.replace(/^\/3d\//, '');
  if (rel && resolved.startsWith('/3d/')) {
    check(
      fs.existsSync(path.join(DIR, rel)),
      `"${ref}" resolves to ${resolved} but no such file exists in public/3d/`
    );
  }
}

// ── the 13 arena cards must all be present and reachable ───────────
const arenaRefs = refs.filter((r) => /^arena-|\.html$/.test(r) && r.endsWith('.html'));
check(
  arenaRefs.length >= 13 * 2, // each card: one <a href> + one iframe data-src
  `expected >=26 arena .html references (13 cards x href+data-src), found ${arenaRefs.length}`
);

if (failures.length) {
  console.error('FAIL test-3d-gallery-links:');
  for (const f of failures) console.error('  - ' + f);
  console.error(`\nbase href = ${baseHref === null ? '(none)' : baseHref}; document url = ${DOC_URL}`);
  process.exit(1);
}
console.log(`PASS test-3d-gallery-links: ${refs.length} relative urls resolve under /3d/ (base href="${baseHref}")`);
process.exit(0);
