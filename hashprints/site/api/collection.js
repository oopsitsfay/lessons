// GET /api/collection?c=main|test → contract status, every minted print and recent activity,
// read straight from the chain (Pressed + Transfer logs). No database: the CDN caches the answer
// for a few seconds and a warm instance only fetches logs for blocks it hasn't seen yet.
const { ethers } = require('ethers');
const CONFIG = process.env.HP_CONFIG ? JSON.parse(process.env.HP_CONFIG) : require('../mint-config.json');
const HP = require('../hashprints.js');
const M = require('../market-core.js');

const { CHAINS, provider: providerFor } = require('./_lib/chains.js');
const ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Pressed(uint256 indexed tokenId, address indexed minter, bytes32 seed, uint256 run, uint256 difficulty, uint256 extraBits)',
  'function totalSupply() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function pressed() view returns (uint256)',
  'function openedAt() view returns (uint256)',
  'function price() view returns (uint256)',
  'function difficulty() view returns (uint256)',
  'function currentRun() view returns (uint256)',
];
const IFACE = new ethers.Interface(ABI);
const TOPICS = [IFACE.getEvent('Transfer').topicHash, IFACE.getEvent('Pressed').topicHash];
const ZERO = ethers.ZeroAddress;
const ACTIVITY_LIMIT = 200;
const EXACT_TIMES = 40; // newest blocks that get a real timestamp; older ones are estimated

const SALE_LOOKUPS = 300; // receipts read per request at most; the rest wait for the next one

// Per warm instance: logs already fetched, block timestamps and sale lookups already done.
const scans = new Map();
const times = new Map();
const sales = new Map(); // tx hash -> [{ id, price, currency }]

async function fetchLogs(provider, address, from, to) {
  const out = [];
  let step = 50000;
  for (let start = from; start <= to;) {
    const end = Math.min(start + step - 1, to);
    try {
      out.push(...(await provider.getLogs({ address, fromBlock: start, toBlock: end, topics: [TOPICS] })));
      start = end + 1;
    } catch (e) {
      if (step <= 1000) throw e;
      step = Math.floor(step / 5); // the node limits range or result size: ask for less
    }
  }
  return out;
}

// The block the contract was created in: mint-config.json's fromBlock, or looked up once.
async function startBlock(cfg) {
  if (cfg.fromBlock) return Number(cfg.fromBlock);
  const api = CHAINS[cfg.chainId].blockscout;
  const info = await (await fetch(`${api}/addresses/${cfg.address}`)).json();
  const tx = await (await fetch(`${api}/transactions/${info.creation_transaction_hash}`)).json();
  if (!Number.isInteger(tx.block_number)) throw new Error('could not find the deploy block; set fromBlock in mint-config.json');
  return tx.block_number;
}

async function scan(provider, key, cfg, latest) {
  const id = `${key}:${cfg.chainId}:${cfg.address.toLowerCase()}`;
  let s = scans.get(id);
  if (!s) s = { next: await startBlock(cfg), logs: [] };
  if (latest >= s.next) {
    const logs = await fetchLogs(provider, cfg.address, s.next, latest);
    s = { next: latest + 1, logs: s.logs.concat(logs) };
    scans.set(id, s);
  }
  return s.logs;
}

async function blockTimes(provider, blocks, head) {
  const wanted = [...new Set(blocks)].sort((a, b) => b - a).slice(0, EXACT_TIMES).filter((b) => !times.has(b));
  await Promise.all(wanted.map(async (b) => {
    const blk = await provider.getBlock(b).catch(() => null);
    if (blk) times.set(b, blk.timestamp);
  }));
  // Slots are 12 s on both chains; missed slots make the estimate a little early.
  return (b) => times.get(b) ?? head.timestamp - (head.number - b) * 12;
}

// A transfer is a sale when Seaport (the exchange OpenSea and this site use) settled it in the
// same transaction. The price is what the buyer paid: ETH for a listing, WETH for an accepted offer.
async function findSales(provider, cfg, txs) {
  const seaport = ((CONFIG.market && CONFIG.market.seaport) || M.SEAPORT).toLowerCase();
  const collection = cfg.address.toLowerCase();
  const todo = [...new Set(txs)].filter((h) => !sales.has(h)).slice(0, SALE_LOOKUPS);
  await Promise.all(todo.map(async (hash) => {
    const receipt = await provider.getTransactionReceipt(hash).catch(() => null);
    if (!receipt) return;
    const found = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== seaport) continue;
      let ev = null;
      try { ev = M.seaportInterface.parseLog(log); } catch {}
      if (!ev || ev.name !== 'OrderFulfilled') continue;
      const isPrint = (i) => [2, 4].includes(Number(i.itemType)) && i.token.toLowerCase() === collection;
      const money = (items) => items.filter((i) => Number(i.itemType) <= 1);
      let item = ev.args.offer.find(isPrint);
      let paid = item ? money(ev.args.consideration) : null;
      if (!item) {
        item = ev.args.consideration.find(isPrint);
        paid = item ? money(ev.args.offer) : null;
      }
      if (!item || !paid || !paid.length) continue;
      const token = paid[0].token.toLowerCase();
      const weth = (cfg.weth || M.WETH[cfg.chainId] || '').toLowerCase();
      const currency = token === ethers.ZeroAddress ? 'ETH' : token === weth ? 'WETH' : 'token';
      found.push({ id: Number(item.identifier), price: paid.reduce((sum, i) => sum + i.amount, 0n).toString(), currency });
    }
    sales.set(hash, found);
  }));
  return (tx, id) => (sales.get(tx) || []).find((x) => x.id === id) || null;
}

function build(logs) {
  const tokens = new Map();
  const activity = [];
  const sorted = logs.slice().sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  for (const log of sorted) {
    const ev = IFACE.parseLog(log);
    if (!ev) continue;
    const at = { block: log.blockNumber, tx: log.transactionHash };
    if (ev.name === 'Pressed') {
      const id = Number(ev.args.tokenId);
      const t = tokens.get(id) || { id };
      Object.assign(t, {
        seed: ev.args.seed,
        d: Number(ev.args.difficulty),
        extra: Number(ev.args.extraBits),
        minter: ev.args.minter,
        ...at,
      });
      tokens.set(id, t);
    } else {
      const id = Number(ev.args.tokenId);
      const t = tokens.get(id) || { id };
      t.owner = ev.args.to;
      tokens.set(id, t);
      activity.push({ kind: ev.args.from === ZERO ? 'mint' : 'transfer', id, from: ev.args.from, to: ev.args.to, ...at });
    }
  }
  return { tokens: [...tokens.values()].filter((t) => t.seed).sort((a, b) => a.id - b.id), activity: activity.reverse() };
}

module.exports = async (req, res) => {
  const key = req.query.c === 'test' ? 'test' : 'main';
  const cfg = CONFIG[key] || {};
  const chain = CHAINS[cfg.chainId];
  const shape = HP.COLLECTIONS[key];
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!cfg.address || !chain) {
    res.setHeader('Cache-Control', 'public, s-maxage=30');
    return res.end(JSON.stringify({ key, deployed: false, name: shape.name }));
  }
  try {
    const provider = providerFor(cfg.chainId);
    const c = new ethers.Contract(cfg.address, ABI, provider);
    const head = await provider.getBlock('latest');
    const [total, max, pressed, openedAt, price, difficulty, run, logs] = await Promise.all([
      c.totalSupply(), c.MAX_SUPPLY(), c.pressed(), c.openedAt(), c.price(), c.difficulty(), c.currentRun(),
      scan(provider, key, cfg, head.number),
    ]);
    const { tokens, activity } = build(logs);
    const saleOf = await findSales(provider, cfg, activity.filter((a) => a.kind === 'transfer').map((a) => a.tx));
    let volume = 0n;
    let saleCount = 0;
    const byId = new Map(tokens.map((t) => [t.id, t]));
    for (const a of activity.slice().reverse()) {
      if (a.kind !== 'transfer') continue;
      const sale = saleOf(a.tx, a.id);
      if (!sale) continue;
      Object.assign(a, { kind: 'sale', price: sale.price, currency: sale.currency });
      if (sale.currency !== 'token') { volume += BigInt(sale.price); saleCount++; }
      const t = byId.get(a.id);
      if (t) t.lastSale = { price: sale.price, currency: sale.currency, block: a.block };
    }
    const recent = activity.slice(0, ACTIVITY_LIMIT);
    const timeOf = await blockTimes(provider, recent.map((a) => a.block).concat(tokens.slice(-EXACT_TIMES).map((t) => t.block)), head);
    for (const t of tokens) t.time = timeOf(t.block);
    for (const a of recent) a.time = timeOf(a.block);

    res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=120');
    res.end(JSON.stringify({
      key,
      deployed: true,
      name: shape.name,
      chainId: cfg.chainId,
      address: cfg.address,
      explorer: chain.explorer,
      live: openedAt > 0n,
      openedAt: Number(openedAt),
      total: Number(total),
      max: Number(max),
      pressed: Number(pressed),
      publicMax: shape.runSize * shape.runs,
      artistProofs: shape.artistProofs,
      runSize: shape.runSize,
      runs: shape.runs,
      run: Number(run),
      difficulty: Number(difficulty),
      price: price.toString(),
      block: head.number,
      tokens,
      activity: recent,
      activityTotal: activity.length,
      volume: volume.toString(),
      sales: saleCount,
    }));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: `Couldn't read the chain: ${e.shortMessage || e.message}` }));
  }
};
