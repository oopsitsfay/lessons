// POST /api/admin/logout → clears the admin session cookie.
const { COOKIE } = require('../../lib/admin-session.js');

module.exports = (req, res) => {
  res.statusCode = 200;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  res.setHeader('Content-Type', 'application/json');
  res.end('{"ok":true}');
};
