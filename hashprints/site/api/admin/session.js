// GET /api/admin/session → whether this browser holds a valid admin session (no secrets returned).
const { COOKIE, verify, readCookie } = require('../../lib/admin-session.js');

module.exports = (req, res) => {
  const session = verify(readCookie(req.headers.cookie, COOKIE));
  res.statusCode = 200;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(session ? { signedIn: true, address: session.a } : { signedIn: false }));
};
