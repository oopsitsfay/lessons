// POST /api/admin/login {message, signature} → sets the admin session cookie.
// The message is signed with the wallet (no transaction, no gas). It names this site's domain and a
// timestamp, so a signature can't be reused on another site or replayed after a few minutes.
const { verifyMessage } = require('ethers');
const { COOKIE, TTL_SECONDS, adminWallets, sign, secret } = require('../../lib/admin-session.js');

const MAX_AGE_MS = 5 * 60 * 1000;

function reply(res, status, body, cookie) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.end(JSON.stringify(body));
}

function parse(message) {
  const lines = String(message).split('\n');
  if (lines[0] !== 'HashPrints admin sign-in') return null;
  const field = (name) => (lines.find((l) => l.startsWith(`${name}: `)) || '').slice(name.length + 2);
  return { domain: field('Domain'), address: field('Address').toLowerCase(), issued: Date.parse(field('Issued')) };
}

module.exports = (req, res) => {
  if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' });
  if (!secret() || adminWallets().length === 0) {
    return reply(res, 503, { error: 'Admin sign-in is not configured on the server (ADMIN_WALLETS / ADMIN_SESSION_SECRET).' });
  }
  const { message, signature } = req.body || {};
  const m = message && parse(message);
  if (!m || !signature) return reply(res, 400, { error: 'Malformed sign-in message.' });

  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (m.domain !== host) return reply(res, 400, { error: 'Sign-in message is for a different site.' });
  const age = Date.now() - m.issued;
  if (!Number.isFinite(age) || age > MAX_AGE_MS || age < -60 * 1000) return reply(res, 400, { error: 'Sign-in message expired. Try again.' });

  let signer;
  try { signer = verifyMessage(message, signature).toLowerCase(); } catch { return reply(res, 400, { error: 'Invalid signature.' }); }
  if (signer !== m.address) return reply(res, 400, { error: 'Signature does not match the address in the message.' });
  if (!adminWallets().includes(signer)) return reply(res, 403, { error: 'This wallet is not an admin.' });

  const token = sign({ a: signer, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS });
  const cookie = `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL_SECONDS}`;
  return reply(res, 200, { ok: true, address: signer }, cookie);
};
