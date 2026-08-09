'use strict';
/*
 * audit.js — the durable admin audit log (state.audit[]).
 *
 * Every admin change to attendance, payment, eligibility, a draw result, or an
 * account (status/approval/rejection/lock/suspend/link/password/temp-password/
 * password-reveal) appends one entry here so there is a permanent record of who
 * changed what, when. Shared by api/accounts.js and api/weekly.js.
 *
 * Security: a password REVEAL is logged as an event only — the decrypted
 * password is NEVER written into an audit entry (prevValue/newValue stay null).
 */
const crypto = require('crypto');

const AUDIT_MAX = 2000; // bounded — oldest entries drop off past this cap

/**
 * Append an audit entry to state.audit (creating it if needed) and return the
 * entry. Mutates state.audit in place; caller persists as part of its own change.
 *   entry = { action, admin, target:{type,id,label}, prevValue?, newValue?, note?, at? }
 * `at` is injected by the caller (Date.now()) so this stays testable.
 */
function pushAudit(state, entry) {
  if (!state || typeof state !== 'object') return null;
  if (!Array.isArray(state.audit)) state.audit = [];
  const e = {
    id: 'au_' + crypto.randomBytes(8).toString('hex'),
    at: (entry && entry.at) || Date.now(),
    action: (entry && entry.action) || 'unknown',
    admin: (entry && entry.admin) || 'admin',
    target: (entry && entry.target) || null,
    prevValue: entry && entry.prevValue !== undefined ? entry.prevValue : null,
    newValue: entry && entry.newValue !== undefined ? entry.newValue : null,
    note: (entry && entry.note) || '',
  };
  // newest first; hard cap
  state.audit = [e, ...state.audit].slice(0, AUDIT_MAX);
  return e;
}

/** Admin-facing view of the audit log (already redaction-safe — no secrets stored). */
function auditView(state, limit) {
  const list = Array.isArray(state && state.audit) ? state.audit : [];
  const n = Number(limit) || 200;
  return list.slice(0, n);
}

module.exports = { AUDIT_MAX, pushAudit, auditView };
