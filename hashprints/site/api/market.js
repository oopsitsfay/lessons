// GET  /api/market?c=main|test → live listings, each re-checked against the chain.
// POST /api/market?c=main|test  { components, signature } → store a new signed listing.
//
// A listing is only stored or shown if, right now on chain: the seller owns the print, has
// approved Seaport, the order isn't cancelled or filled, the seller's Seaport counter still
// matches, and Seaport itself accepts the signature (checked with a read-only validate call).
// Anything that stops being true (sold, transferred, cancelled, expired) is dropped.
const { ethers } = require('ethers');
const CONFIG = process.env.HP_CONFIG ? JSON.parse(process.env.HP_CONFIG) : require('../mint-config.json');
const M = require('../market-core.js');
const { CHAINS, provider: providerFor } = require('./_lib/chains.js');
const { store } = require('../lib/market-store.js');

const MAX_BODY = 20000;

function setup(req) {
  const key = req.query.c === 'test' ? 'test' : 'main';
  const cfg = CONFIG[key] || {};
  const market = CONFIG.market || {};
  const royalty = market.royaltyBps > 0 && ethers.isAddress(market.royaltyRecipient || '')
    ? { bps: Number(market.royaltyBps), recipient: ethers.getAddress(market.royaltyRecipient) } : null;
  return { key, cfg, royalty, seaport: market.seaport || M.SEAPORT, db: store() };
}

function send(res, status, body, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(body));
}

// Chain checks shared by GET and POST. Returns { ok, orderHash, reason, permanent }.
async function check(provider, ctx, components, signature, withSignature) {
  const { cfg, seaport } = ctx;
  const nft = new ethers.Contract(cfg.address, M.NFT_ABI, provider);
  const sp = new ethers.Contract(seaport, M.SEAPORT_ABI, provider);
  const id = components.offer[0].identifierOrCriteria;
  const [owner, approved, counter, orderHash] = await Promise.all([
    nft.ownerOf(id).catch(() => null),
    nft.isApprovedForAll(components.offerer, seaport),
    sp.getCounter(components.offerer),
    sp.getOrderHash(components),
  ]);
  if (!owner || owner !== ethers.getAddress(components.offerer)) return { ok: false, reason: 'the seller no longer owns this print', permanent: true };
  if (counter.toString() !== String(components.counter)) return { ok: false, reason: 'the seller cancelled all their listings', permanent: true };
  const status = await sp.getOrderStatus(orderHash);
  if (status.isCancelled) return { ok: false, reason: 'this listing was cancelled', permanent: true };
  if (status.totalFilled > 0n) return { ok: false, reason: 'this listing was already filled', permanent: true };
  if (!approved) return { ok: false, reason: 'the seller hasn\'t approved Seaport to transfer their prints', permanent: true };
  if (withSignature) {
    try {
      const ok = await sp.validate.staticCall([M.toOrder(components, signature)]);
      if (!ok) return { ok: false, reason: 'Seaport rejected the signature' };
    } catch {
      return { ok: false, reason: 'Seaport rejected the signature' };
    }
  }
  return { ok: true, orderHash };
}

const view = (row, orderHash) => ({
  tokenId: Number(row.components.offer[0].identifierOrCriteria),
  price: M.priceOf(row.components).toString(),
  seller: row.components.offerer,
  endTime: Number(row.components.endTime),
  createdAt: row.createdAt,
  orderHash,
  components: row.components,
  signature: row.signature,
});

async function list(req, res, ctx) {
  const { key, cfg, royalty, seaport, db } = ctx;
  const base = { key, enabled: !!db && !!cfg.address, chainId: cfg.chainId, collection: cfg.address || null, seaport, royalty };
  if (!base.enabled) return send(res, 200, { ...base, listings: [] }, 'public, s-maxage=30');
  const provider = providerFor(cfg.chainId);
  const rows = await db.all(key);
  const live = [];
  await Promise.all(rows.map(async (row) => {
    const id = row?.components?.offer?.[0]?.identifierOrCriteria;
    const shapeError = M.checkShape(row.components, { collection: cfg.address, royalty });
    let result;
    try {
      result = shapeError ? { ok: false, permanent: true } : await check(provider, ctx, row.components, row.signature, false);
    } catch {
      result = { ok: false }; // node hiccup: hide this time, keep it
    }
    if (result.ok) live.push(view(row, result.orderHash));
    else if (result.permanent && id !== undefined) await db.remove(key, id);
  }));
  live.sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : a.tokenId - b.tokenId));
  send(res, 200, { ...base, listings: live }, 'public, s-maxage=10, stale-while-revalidate=30');
}

async function create(req, res, ctx) {
  const { key, cfg, royalty, db } = ctx;
  if (!db || !cfg.address) return send(res, 503, { error: 'Listings aren\'t switched on for this site yet.' });
  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > MAX_BODY) return send(res, 413, { error: 'request too large' });
    try { body = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid JSON' }); }
  }
  if (JSON.stringify(body || {}).length > MAX_BODY) return send(res, 413, { error: 'request too large' });
  const { components, signature } = body || {};
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{128,4000}$/.test(signature)) return send(res, 400, { error: 'missing or malformed signature' });
  const shapeError = M.checkShape(components, { collection: cfg.address, royalty });
  if (shapeError) return send(res, 400, { error: shapeError });
  const clean = JSON.parse(JSON.stringify(components)); // plain data only
  const provider = providerFor(cfg.chainId);
  const result = await check(provider, ctx, clean, signature, true);
  if (!result.ok) return send(res, 400, { error: result.reason });
  const row = { components: clean, signature, createdAt: Math.floor(Date.now() / 1000) };
  await db.put(key, clean.offer[0].identifierOrCriteria, row);
  send(res, 200, { ok: true, listing: view(row, result.orderHash) });
}

module.exports = async (req, res) => {
  const ctx = setup(req);
  try {
    if (req.method === 'GET') return await list(req, res, ctx);
    if (req.method === 'POST') return await create(req, res, ctx);
    res.setHeader('Allow', 'GET, POST');
    send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    send(res, 502, { error: `Couldn't reach the network: ${e.shortMessage || e.message}` });
  }
};
