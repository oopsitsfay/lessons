// GET /api/meta/:id?seed=0x…&d=16 → ERC-721 metadata JSON.
const { parsePrint, fail } = require('../_lib/params.js');

module.exports = (req, res) => {
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id < 1 || id > 3333) return fail(res, 400, 'id must be 1-3333');
  const p = parsePrint(req.query);
  if (p.error) return fail(res, 400, p.error);

  const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const qs = `seed=${p.seed}&d=${p.d}`;
  const ap = id <= 3;
  const body = {
    name: ap ? `HashPrints A/P ${id}` : `HashPrint #${id}`,
    description: 'A 32×32 pixel print pressed from proof-of-work. The hash its minter ground for became the plate: it decides every ink, line and glitch. https://hashprints.vercel.app',
    image: `${origin}/api/image?${qs}`,
    external_url: `${origin}/print.html?id=${id}&${qs}`,
    background_color: p.art.palette[0].slice(1),
    attributes: [
      ...Object.entries(p.art.traits).map(([trait_type, value]) =>
        typeof value === 'number' ? { trait_type, value, display_type: 'number' } : { trait_type, value }),
      { trait_type: 'Run', value: ap ? 'Artist Proof' : String(Math.floor((id - 4) / 333) + 1) },
      { trait_type: 'Difficulty', value: p.d, display_type: 'number' },
    ],
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
};
