'use strict';
/*
 * crypto.js — reversible password encryption for the admin password-reveal helper.
 *
 * Why reversible (not one-way like the login hash): the club admin must be able
 * to READ a player's password to help someone who forgot it, WITHOUT Gmail/SMS/
 * WhatsApp OTP (each of which costs money per message). So alongside the one-way
 * scrypt LOGIN hash, we keep an AES-256-GCM encrypted copy that only the server,
 * holding the key, can decrypt — and only for an authenticated admin.
 *
 * Security posture (prototype, documented for the user):
 *   - Key lives ONLY in the server env var ACCOUNT_ENC_KEY (32 bytes, hex or
 *     base64). It is never sent to the browser, never written to state/logs.
 *   - A leaked state blob still needs the key: plaintext is never stored.
 *   - Login NEVER needs this key (it uses the scrypt hash), so losing/rotating
 *     the key degrades password-REVEAL only — it can never lock anyone out.
 *   - Blobs carry a key-version `k` so a future rotation (ACCOUNT_ENC_KEY_OLD)
 *     can decrypt old blobs and re-encrypt on the next password change.
 *
 * This must be replaceable later by a proper reset/OTP flow — it is intentionally
 * a small, self-contained module.
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const KEY_VERSION = 1;

// Thrown when no usable key is configured. Callers treat this as "reveal
// unavailable" — they still store the login hash so sign-in keeps working.
class NoKeyError extends Error {
  constructor(msg) { super(msg || 'Encryption key not configured'); this.name = 'NoKeyError'; this.noKey = true; }
}

/** Parse a 32-byte key from a hex (64 chars) or base64 env string. */
function parseKey(env) {
  if (!env || typeof env !== 'string') throw new NoKeyError();
  const s = env.trim();
  let buf;
  if (/^[0-9a-f]{64}$/i.test(s)) buf = Buffer.from(s, 'hex');
  else { try { buf = Buffer.from(s, 'base64'); } catch { throw new NoKeyError('Bad key encoding'); } }
  if (buf.length !== 32) throw new NoKeyError('Key must be 32 bytes');
  return buf;
}

/** True when a usable key is configured — lets callers show "reveal available". */
function hasKey(env) {
  try { parseKey(env == null ? process.env.ACCOUNT_ENC_KEY : env); return true; } catch { return false; }
}

/**
 * encryptPassword(plaintext, [env]) -> { iv, ct, tag, k }  (all base64 except k).
 * Throws NoKeyError when no key is configured — the caller decides to proceed
 * with pwEnc=null so registration/login is never blocked by a missing key.
 */
function encryptPassword(plaintext, env) {
  const key = parseKey(env == null ? process.env.ACCOUNT_ENC_KEY : env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    k: KEY_VERSION,
  };
}

/**
 * decryptPassword(blob, [env], [oldEnv]) -> plaintext string.
 * Tries the current key first, then the optional rotation key (ACCOUNT_ENC_KEY_OLD).
 * Throws NoKeyError if no key works, or a generic Error if the blob is malformed
 * or authentication fails (tampered / wrong key).
 */
function decryptPassword(blob, env, oldEnv) {
  if (!blob || typeof blob !== 'object' || !blob.iv || !blob.ct || !blob.tag) {
    throw new Error('No encrypted password stored');
  }
  const candidates = [];
  const cur = env == null ? process.env.ACCOUNT_ENC_KEY : env;
  const old = oldEnv == null ? process.env.ACCOUNT_ENC_KEY_OLD : oldEnv;
  for (const e of [cur, old]) { try { candidates.push(parseKey(e)); } catch { /* skip */ } }
  if (!candidates.length) throw new NoKeyError();

  let lastErr;
  for (const key of candidates) {
    try {
      const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(blob.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
      const pt = Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]);
      return pt.toString('utf8');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Decryption failed');
}

module.exports = {
  ALGO, KEY_VERSION, NoKeyError,
  parseKey, hasKey, encryptPassword, decryptPassword,
};
