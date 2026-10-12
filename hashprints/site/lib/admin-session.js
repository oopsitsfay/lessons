// Admin session tokens: "<base64url payload>.<base64url HMAC-SHA256>", signed with ADMIN_SESSION_SECRET.
// Shared by middleware.js (gate) and api/admin/login.js (issuer).
const crypto = require('node:crypto');

const COOKIE = 'hp_admin';
const TTL_SECONDS = 12 * 60 * 60;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function secret() {
  const s = process.env.ADMIN_SESSION_SECRET || '';
  return s.length >= 32 ? s : null; // fail closed without a strong secret
}

function adminWallets() {
  return (process.env.ADMIN_WALLETS || '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
}

function sign(payload) {
  const key = secret();
  if (!key) return null;
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', key).update(body).digest());
  return `${body}.${mac}`;
}

function verify(token) {
  const key = secret();
  if (!key || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(mac || '', 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!payload || payload.exp < Math.floor(Date.now() / 1000)) return null;
  // Removing a wallet from ADMIN_WALLETS revokes its sessions immediately.
  if (!adminWallets().includes(payload.a)) return null;
  return payload;
}

function readCookie(header, name = COOKIE) {
  for (const part of (header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

module.exports = { COOKIE, TTL_SECONDS, adminWallets, sign, verify, readCookie, secret };
