// GET /api/image?seed=0x…&d=16 → the print as a crisp SVG.
const { HP, parsePrint, fail } = require('./_lib/params.js');

module.exports = (req, res) => {
  const p = parsePrint(req.query);
  if (p.error) return fail(res, 400, p.error);
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(HP.toSVG(p.art, 24));
};
