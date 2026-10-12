// Shared request validation for the metadata endpoints. The seed and difficulty come from
// HashPrints.tokenURI(), which embeds them straight from chain state.
const HP = require('../../hashprints.js');

function parsePrint(query) {
  const seed = String(query.seed || '').toLowerCase();
  const d = Number(query.d);
  if (!/^0x[0-9a-f]{64}$/.test(seed)) return { error: 'seed must be 0x + 64 hex characters' };
  if (!Number.isInteger(d) || d < 16 || d > 20) return { error: 'd must be an integer from 16 to 20' };
  if (HP.leadingZeroBits(HP.fromHex(seed)) < d) return { error: 'seed does not carry enough work for d' };
  return { seed, d, art: HP.render(seed, d) };
}

function fail(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: message }));
}

module.exports = { HP, parsePrint, fail };
