// GET /api/admin/market-check → (admin only) proves the listing store works end to end: writes a
// small file, reads it back, deletes it. Also reports the fee settings and how many orders are stored.
const { COOKIE, verify, readCookie } = require('../../lib/admin-session.js');
const { store, backend } = require('../../lib/market-store.js');
const CONFIG = require('../../mint-config.json');
const M = require('../../market-core.js');

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  if (!verify(readCookie(req.headers.cookie, COOKIE))) return send(res, 401, { error: 'admin sign-in required' });
  const db = store();
  const fees = M.feesFrom(CONFIG.market).map((f) => ({ label: f.label, percent: f.bps / 100, recipient: f.recipient }));
  if (!db) return send(res, 200, { ok: false, backend: null, fees, error: 'No Blob store is connected to this project.' });
  const t = Date.now();
  try {
    const stamp = String(t);
    await db.put('main', 'health', 'ping', { stamp });
    const back = await db.all('main', 'health');
    await db.remove('main', 'health', 'ping');
    if (!back.some((r) => r && r.stamp === stamp)) throw new Error('wrote a file but could not read it back');
    const counts = {};
    for (const key of ['main', 'test']) {
      const [listings, offers] = await Promise.all([db.all(key, 'listings'), db.all(key, 'offers')]);
      counts[key] = { listings: listings.length, offers: offers.length };
    }
    send(res, 200, { ok: true, backend: backend(), roundTripMs: Date.now() - t, fees, stored: counts });
  } catch (e) {
    send(res, 200, { ok: false, backend: backend(), fees, error: e.message });
  }
};
