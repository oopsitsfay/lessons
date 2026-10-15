// GET  /api/market?c=main|test → fees, live listings and live offers, each re-checked on chain.
// POST /api/market?c=main|test  { kind: 'listing' | 'offer', components, signature } → store a new order.
//
// Nothing is stored or shown unless, right now on chain: the order has exactly the site's shape and
// fees (creator fee, plus the marketplace fee if one is set), it isn't cancelled or filled, the
// signer's Seaport counter still matches and Seaport itself accepts the signature (read-only
// validate). Listings also need the seller to own the print and have approved Seaport; offers need
// the buyer to hold and have approved enough WETH. Orders that can never fill again are deleted.
const { ethers } = require('ethers');
const CONFIG = process.env.HP_CONFIG ? JSON.parse(process.env.HP_CONFIG) : require('../mint-config.json');
const M = require('../market-core.js');
const { CHAINS, provider: providerFor } = require('./_lib/chains.js');
const { store } = require('../lib/market-store.js');

const MAX_BODY = 20000;
const MAX_OFFERS_PER_WALLET = 25;
const folder = (kind) => (kind === 'listing' ? 'listings' : 'offers');

function setup(req) {
  const key = req.query.c === 'test' ? 'test' : 'main';
  const cfg = CONFIG[key] || {};
  const market = CONFIG.market || {};
  const chainOk = !!CHAINS[cfg.chainId];
  return {
    key, cfg,
    fees: M.feesFrom(market),
    seaport: market.seaport || M.SEAPORT,
    weth: cfg.weth || M.WETH[cfg.chainId] || null,
    db: chainOk && cfg.address ? store() : null,
  };
}

function send(res, status, body, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(body));
}

const tokenOf = (c) => (M.isOffer(c)
  ? (Number(c.consideration[0].itemType) === M.ITEM.ERC721_CRITERIA ? null : Number(c.consideration[0].identifierOrCriteria))
  : Number(c.offer[0].identifierOrCriteria));

// On-chain checks. Returns { ok, orderHash } or { ok: false, reason, permanent }.
async function check(provider, ctx, kind, c, signature, withSignature) {
  const sp = new ethers.Contract(ctx.seaport, M.SEAPORT_ABI, provider);
  const nft = new ethers.Contract(ctx.cfg.address, M.NFT_ABI, provider);
  const [counter, orderHash] = await Promise.all([sp.getCounter(c.offerer), sp.getOrderHash(c)]);
  if (counter.toString() !== String(c.counter)) return { ok: false, reason: 'the signer cancelled all their orders', permanent: true };
  const status = await sp.getOrderStatus(orderHash);
  if (status.isCancelled) return { ok: false, reason: 'this order was cancelled', permanent: true };
  if (status.totalFilled > 0n) return { ok: false, reason: 'this order was already filled', permanent: true };

  if (kind === 'listing') {
    const [owner, approved] = await Promise.all([nft.ownerOf(tokenOf(c)).catch(() => null), nft.isApprovedForAll(c.offerer, ctx.seaport)]);
    if (!owner || !M.same(owner, c.offerer)) return { ok: false, reason: 'the seller no longer owns this print', permanent: true };
    if (!approved) return { ok: false, reason: 'the seller hasn\'t approved Seaport to transfer their prints', permanent: true };
  } else {
    const id = tokenOf(c);
    if (id !== null) {
      const owner = await nft.ownerOf(id).catch(() => null);
      if (!owner) return { ok: false, reason: 'that print doesn\'t exist', permanent: true };
      if (M.same(owner, c.offerer)) return { ok: false, reason: 'you already own this print' };
    }
    const weth = new ethers.Contract(ctx.weth, M.WETH_ABI, provider);
    const amount = BigInt(c.offer[0].startAmount);
    const [balance, allowance] = await Promise.all([weth.balanceOf(c.offerer), weth.allowance(c.offerer, ctx.seaport)]);
    if (balance < amount) return { ok: false, reason: 'the buyer doesn\'t hold enough WETH for this offer' };
    if (allowance < amount) return { ok: false, reason: 'the buyer hasn\'t approved enough WETH for Seaport' };
  }

  if (withSignature) {
    let ok = false;
    try { ok = await sp.validate.staticCall([M.toOrder(c, signature)]); } catch {}
    if (!ok) return { ok: false, reason: 'Seaport rejected the signature' };
  }
  return { ok: true, orderHash };
}

function view(kind, row, orderHash, fees) {
  const c = row.components;
  const price = M.priceOf(c);
  return {
    kind,
    tokenId: tokenOf(c),
    price: price.toString(),
    net: M.split(price, fees).seller.toString(),
    maker: c.offerer,
    endTime: Number(c.endTime),
    createdAt: row.createdAt,
    orderHash,
    components: c,
    signature: row.signature,
  };
}

const shapeError = (ctx, kind, c) => (kind === 'listing'
  ? M.checkListing(c, { collection: ctx.cfg.address, fees: ctx.fees })
  : M.checkOffer(c, { collection: ctx.cfg.address, fees: ctx.fees, weth: ctx.weth }));

async function live(provider, ctx, kind) {
  const rows = await ctx.db.all(ctx.key, folder(kind));
  const out = [];
  await Promise.all(rows.map(async (row) => {
    const c = row?.components;
    let result;
    try {
      result = shapeError(ctx, kind, c) ? { ok: false, permanent: true } : await check(provider, ctx, kind, c, row.signature, false);
    } catch {
      result = { ok: false }; // network hiccup: hide this time, keep it
    }
    if (result.ok) out.push(view(kind, row, result.orderHash, ctx.fees));
    else if (result.permanent && c) await ctx.db.remove(ctx.key, folder(kind), kind === 'listing' ? tokenOf(c) : row.orderHash || '');
  }));
  return out;
}

const byPrice = (dir) => (a, b) => {
  const x = BigInt(a.price), y = BigInt(b.price);
  return (x < y ? -dir : x > y ? dir : 0) || a.endTime - b.endTime;
};

async function list(req, res, ctx) {
  const { key, cfg, fees, seaport, weth, db } = ctx;
  const base = { key, enabled: !!db && !!weth, chainId: cfg.chainId, collection: cfg.address || null, seaport, weth, fees, maxDays: M.MAX_DAYS, minPrice: M.MIN_PRICE.toString() };
  if (!base.enabled) return send(res, 200, { ...base, listings: [], offers: [] }, 'public, s-maxage=30');
  const provider = providerFor(cfg.chainId);
  const [listings, offers] = await Promise.all([live(provider, ctx, 'listing'), live(provider, ctx, 'offer')]);
  // One listing per print: if an old and a new one are both still valid, the cheaper one shows.
  listings.sort(byPrice(1));
  const seen = new Set();
  const unique = listings.filter((l) => !seen.has(l.tokenId) && seen.add(l.tokenId));
  offers.sort(byPrice(-1));
  send(res, 200, { ...base, listings: unique, offers }, 'public, s-maxage=10, stale-while-revalidate=30');
}

async function create(req, res, ctx) {
  const { key, cfg, db } = ctx;
  if (!db || !ctx.weth) return send(res, 503, { error: 'Buying and selling isn\'t switched on for this site yet.' });
  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > MAX_BODY) return send(res, 413, { error: 'request too large' });
    try { body = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid JSON' }); }
  }
  if (JSON.stringify(body || {}).length > MAX_BODY) return send(res, 413, { error: 'request too large' });
  const { kind, components, signature } = body || {};
  if (kind !== 'listing' && kind !== 'offer') return send(res, 400, { error: 'kind must be listing or offer' });
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{128,4000}$/.test(signature)) return send(res, 400, { error: 'missing or malformed signature' });
  const c = JSON.parse(JSON.stringify(components || null)); // plain data only
  const bad = shapeError(ctx, kind, c);
  if (bad) return send(res, 400, { error: bad });
  const provider = providerFor(cfg.chainId);

  if (kind === 'offer') {
    const mine = (await db.all(key, 'offers')).filter((r) => M.same(r?.components?.offerer, c.offerer));
    if (mine.length >= MAX_OFFERS_PER_WALLET) return send(res, 429, { error: `A wallet can have at most ${MAX_OFFERS_PER_WALLET} open offers here. Cancel some first.` });
  }
  const result = await check(provider, ctx, kind, c, signature, true);
  if (!result.ok) return send(res, 400, { error: result.reason });
  const row = { components: c, signature, orderHash: result.orderHash, createdAt: Math.floor(Date.now() / 1000) };
  await db.put(key, folder(kind), kind === 'listing' ? tokenOf(c) : result.orderHash, row);
  send(res, 200, { ok: true, order: view(kind, row, result.orderHash, ctx.fees) });
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
