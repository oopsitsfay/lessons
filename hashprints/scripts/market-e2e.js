// End-to-end test of the market against real Seaport 1.6 code on a local chain: listings, offers
// on one print, collection offers, fees, cancelling, and the orders the API must refuse.
//   npx hardhat node                                   (in one terminal)
//   npx hardhat run --network localhost scripts/market-e2e.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { ethers } = require('hardhat');

const SP = require('../test/fixtures/seaport-1.6.json');
const HP = require('../site/hashprints.js');

function call(handler, method, query, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(b) { resolve({ status: this.statusCode, body: JSON.parse(b) }); },
    };
    Promise.resolve(handler({ method, query, body }, res)).catch((e) => resolve({ status: 500, body: { error: e.message } }));
  });
}

const ok = (msg) => console.log(`ok  ${msg}`);

(async () => {
  const [deployer, seller, buyer, stranger, creator, platform, buyer2] = await ethers.getSigners();

  // HashPrints with 3 artist proofs minted to the seller, WETH, Seaport 1.6.
  const nft = await ethers.deployContract('HashPrints', ['Test HashPrint', 'TESTPRINT', 315000000000000n, 'http://localhost/api/test/meta/', 5, 2, 3, seller.address]);
  await nft.waitForDeployment();
  const collection = await nft.getAddress();
  const fromBlock = await ethers.provider.getBlockNumber();
  let startNonce = 0;
  for (let i = 0; i < 3; i++) {
    const f = await HP.grind({ contract: collection, minter: seller.address, difficulty: 16, startNonce });
    await (await nft.connect(seller).pressArtistProof(f.nonce)).wait();
    startNonce = f.nonce + 1;
  }
  const weth = await ethers.deployContract('WETH9');
  const WETH = await weth.getAddress();
  const cc = await (await deployer.sendTransaction({ data: '0x' + SP.conduitController })).wait();
  const seaport = await new ethers.ContractFactory([{ type: 'constructor', inputs: [{ name: 'c', type: 'address' }] }], '0x' + SP.seaport, deployer).deploy(cc.contractAddress);
  await seaport.waitForDeployment();
  const SEAPORT = await seaport.getAddress();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-market-'));
  process.env.HP_LOCAL_RPC = 'http://127.0.0.1:8545';
  process.env.MARKET_STORE_DIR = dir;
  const SITE = path.join(__dirname, '../site');
  function load(market) {
    process.env.HP_CONFIG = JSON.stringify({ test: { chainId, address: collection, fromBlock, weth: WETH }, market: { seaport: SEAPORT, ...market } });
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(SITE, 'api'))) delete require.cache[k];
    return { market: require(path.join(SITE, 'api/market.js')), collectionApi: require(path.join(SITE, 'api/collection.js')) };
  }
  // Creator fee 8% plus a 1% marketplace fee, so both fee paths are exercised.
  let api = load({ creatorFeeBps: 800, creatorFeeRecipient: creator.address, marketFeeBps: 100, marketFeeRecipient: platform.address });
  const M = require(path.join(SITE, 'market-core.js'));
  let FEES = M.feesFrom({ creatorFeeBps: 800, creatorFeeRecipient: creator.address, marketFeeBps: 100, marketFeeRecipient: platform.address });

  const sp = new ethers.Contract(SEAPORT, M.SEAPORT_ABI, deployer);
  const now = async () => (await ethers.provider.getBlock('latest')).timestamp;
  const sign = (signer, c) => signer.signTypedData(M.domain(chainId, SEAPORT), M.TYPES, c);
  const post = (kind, b) => call(api.market, 'POST', { c: 'test' }, { kind, ...b });
  const get = async () => (await call(api.market, 'GET', { c: 'test' })).body;
  const wethOf = (a) => weth.balanceOf(a);
  const ethOf = (a) => ethers.provider.getBalance(a);

  async function listing(signer, tokenId, price, opts = {}) {
    const t = await now();
    const offerer = opts.as || signer.address;
    const c = M.buildListing({ collection, tokenId, seller: offerer, priceWei: ethers.parseEther(price), fees: opts.fees || FEES, startTime: t - 60, endTime: t + 86400 * (opts.days || 7), counter: await sp.getCounter(offerer) });
    return { components: c, signature: await sign(signer, c) };
  }
  async function offer(signer, tokenId, amount, opts = {}) {
    const t = await now();
    const c = M.buildOffer({ collection, tokenId, buyer: signer.address, amountWei: ethers.parseEther(amount), fees: opts.fees || FEES, weth: opts.weth || WETH, startTime: t - 60, endTime: t + 86400 * 3, counter: await sp.getCounter(signer.address) });
    return { components: c, signature: await sign(signer, c) };
  }
  async function accept(signer, o, tokenId) {
    const a = M.acceptArgs({ offer: o.components, signature: o.signature, tokenId, seller: signer.address, sellerCounter: await sp.getCounter(signer.address), now: await now() });
    return (await sp.connect(signer).matchAdvancedOrders(a.orders, a.criteria, a.fulfillments, a.recipient)).wait();
  }
  let r;

  // ------------------------------------------------------------------ listings
  r = await post('listing', await listing(seller, 1, '0.01'));
  assert.equal(r.status, 400); assert.match(r.body.error, /approved Seaport/);
  ok('refuses a listing before Seaport is approved');
  await (await nft.connect(seller).setApprovalForAll(SEAPORT, true)).wait();

  r = await post('listing', await listing(stranger, 1, '0.01', { as: seller.address }));
  assert.equal(r.status, 400); assert.match(r.body.error, /signature/);
  const tampered = await listing(seller, 1, '0.01');
  tampered.components.consideration[0].startAmount = tampered.components.consideration[0].endAmount = (BigInt(tampered.components.consideration[0].startAmount) + 1n).toString();
  r = await post('listing', tampered);
  assert.equal(r.status, 400);
  r = await post('listing', await listing(seller, 1, '0.01', { fees: [] }));
  assert.equal(r.status, 400); assert.match(r.body.error, /creator fee/);
  r = await post('listing', await listing(seller, 1, '0.01', { fees: [{ ...FEES[0], bps: 700 }, FEES[1]] }));
  assert.equal(r.status, 400); assert.match(r.body.error, /creator fee must be 8%/);
  r = await post('listing', await listing(seller, 1, '0.01', { fees: [FEES[0]] }));
  assert.equal(r.status, 400); assert.match(r.body.error, /marketplace fee/);
  r = await post('listing', await listing(stranger, 1, '0.01'));
  assert.equal(r.status, 400); assert.match(r.body.error, /no longer owns/);
  r = await post('listing', await listing(seller, 1, '0.01', { days: 400 }));
  assert.equal(r.status, 400); assert.match(r.body.error, /at most/);
  ok('refuses forged, tampered, fee-less, wrong-fee, non-owner and over-long listings');

  const good = await listing(seller, 1, '0.01');
  r = await post('listing', good);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let m = await get();
  assert.equal(m.listings.length, 1);
  assert.equal(m.fees[0].bps, 800);
  ok('stores a listing with the 8% creator fee and 1% marketplace fee');

  let before = { seller: await ethOf(seller.address), creator: await ethOf(creator.address), platform: await ethOf(platform.address) };
  const item = m.listings[0];
  await (await sp.connect(buyer).fulfillOrder(M.toOrder(item.components, item.signature), ethers.ZeroHash, { value: BigInt(item.price) })).wait();
  assert.equal(await nft.ownerOf(1), buyer.address);
  assert.equal((await ethOf(seller.address)) - before.seller, ethers.parseEther('0.0091'));
  assert.equal((await ethOf(creator.address)) - before.creator, ethers.parseEther('0.0008'));
  assert.equal((await ethOf(platform.address)) - before.platform, ethers.parseEther('0.0001'));
  ok('buy: print moves, seller gets 0.0091, creator 0.0008 (8%), marketplace 0.0001 (1%)');

  assert.equal((await get()).listings.length, 0);
  assert.equal((await post('listing', good)).status, 400);
  ok('filled listing is dropped and can\'t be re-posted');

  const col = (await call(api.collectionApi, 'GET', { c: 'test' })).body;
  const sale = col.activity.find((a) => a.kind === 'sale');
  assert.ok(sale); assert.equal(sale.price, ethers.parseEther('0.01').toString()); assert.equal(sale.currency, 'ETH');
  ok('collection shows the sale and its price');

  const two = await listing(seller, 2, '0.5');
  assert.equal((await post('listing', two)).status, 200);
  await (await sp.connect(seller).cancel([two.components])).wait();
  assert.equal((await get()).listings.length, 0);
  ok('cancelled listing is dropped');

  // ------------------------------------------------------------------ offers on one print
  r = await post('offer', await offer(buyer2, 3, '0.02'));
  assert.equal(r.status, 400); assert.match(r.body.error, /enough WETH/);
  await (await weth.connect(buyer2).deposit({ value: ethers.parseEther('1') })).wait();
  r = await post('offer', await offer(buyer2, 3, '0.02'));
  assert.equal(r.status, 400); assert.match(r.body.error, /approved enough WETH/);
  await (await weth.connect(buyer2).approve(SEAPORT, ethers.MaxUint256)).wait();
  r = await post('offer', await offer(buyer2, 3, '0.02', { fees: [] }));
  assert.equal(r.status, 400); assert.match(r.body.error, /creator fee/);
  r = await post('offer', await offer(buyer2, 3, '0.02', { weth: collection }));
  assert.equal(r.status, 400); assert.match(r.body.error, /WETH/);
  r = await post('offer', await offer(seller, 3, '0.02'));
  assert.equal(r.status, 400);
  ok('refuses offers without WETH, without approval, without fees, in another token, or on your own print');

  const o3 = await offer(buyer2, 3, '0.02');
  r = await post('offer', o3);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  m = await get();
  assert.equal(m.offers.length, 1); assert.equal(m.offers[0].tokenId, 3);
  assert.equal(m.offers[0].net, ethers.parseEther('0.0182').toString());
  ok('stores an offer on print #3 (seller would net 0.0182 WETH)');

  before = { seller: await wethOf(seller.address), creator: await wethOf(creator.address), platform: await wethOf(platform.address), buyer: await wethOf(buyer2.address) };
  await accept(seller, m.offers[0], 3);
  assert.equal(await nft.ownerOf(3), buyer2.address);
  assert.equal((await wethOf(seller.address)) - before.seller, ethers.parseEther('0.0182'));
  assert.equal((await wethOf(creator.address)) - before.creator, ethers.parseEther('0.0016'));
  assert.equal((await wethOf(platform.address)) - before.platform, ethers.parseEther('0.0002'));
  assert.equal(before.buyer - (await wethOf(buyer2.address)), ethers.parseEther('0.02'));
  assert.equal((await get()).offers.length, 0);
  ok('accept offer: print moves, seller gets 0.0182 WETH, creator 0.0016, marketplace 0.0002, offer dropped');

  // ------------------------------------------------------------------ collection offers
  const any = await offer(buyer2, null, '0.03');
  r = await post('offer', any);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  m = await get();
  assert.equal(m.offers[0].tokenId, null);
  // Print #2 is still the seller's; accept the collection offer with it.
  await accept(seller, m.offers[0], 2);
  assert.equal(await nft.ownerOf(2), buyer2.address);
  assert.equal((await get()).offers.length, 0);
  ok('collection offer accepted with print #2; it can\'t be used twice');

  const col2 = (await call(api.collectionApi, 'GET', { c: 'test' })).body;
  const wethSales = col2.activity.filter((x) => x.kind === 'sale' && x.currency === 'WETH');
  assert.equal(wethSales.length, 2, JSON.stringify(col2.activity));
  assert.equal(col2.volume, ethers.parseEther('0.06').toString());
  ok('accepted offers count as WETH sales: 3 sales, 0.06 volume');

  // ------------------------------------------------------------------ cancelling
  await (await weth.connect(buyer).deposit({ value: ethers.parseEther('1') })).wait();
  await (await weth.connect(buyer).approve(SEAPORT, ethers.MaxUint256)).wait();
  const oc = await offer(buyer, 3, '0.05');
  assert.equal((await post('offer', oc)).status, 200);
  await (await sp.connect(buyer).cancel([oc.components])).wait();
  assert.equal((await get()).offers.length, 0);
  ok('cancelled offer is dropped');

  // buyer owns #1: list it and make a collection offer, then cancel everything at once.
  await (await nft.connect(buyer).setApprovalForAll(SEAPORT, true)).wait();
  assert.equal((await post('listing', await listing(buyer, 1, '0.2'))).status, 200);
  assert.equal((await post('offer', await offer(buyer, null, '0.01'))).status, 200);
  m = await get();
  assert.equal(m.listings.length + m.offers.length, 2);
  await (await sp.connect(buyer).incrementCounter()).wait();
  m = await get();
  assert.equal(m.listings.length + m.offers.length, 0);
  ok('"cancel all" (incrementCounter) drops every listing and offer of that wallet');

  // An offer whose buyer spends the WETH is hidden but kept, and comes back when funded again.
  const ob = await offer(buyer2, 1, '0.5');
  assert.equal((await post('offer', ob)).status, 200);
  const keep = await wethOf(buyer2.address);
  await (await weth.connect(buyer2).withdraw(keep)).wait();
  assert.equal((await get()).offers.length, 0);
  await (await weth.connect(buyer2).deposit({ value: ethers.parseEther('0.6') })).wait();
  assert.equal((await get()).offers.length, 1);
  ok('underfunded offer is hidden, then shown again once the buyer has the WETH');

  // ------------------------------------------------------------------ creator fee only (the live setup)
  api = load({ creatorFeeBps: 800, creatorFeeRecipient: creator.address });
  FEES = M.feesFrom({ creatorFeeBps: 800, creatorFeeRecipient: creator.address });
  await (await nft.connect(buyer2).setApprovalForAll(SEAPORT, true)).wait();
  const l = await listing(buyer2, 2, '1');
  r = await post('listing', l);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  before = { s: await ethOf(buyer2.address), c: await ethOf(creator.address) };
  await (await sp.connect(stranger).fulfillOrder(M.toOrder(l.components, l.signature), ethers.ZeroHash, { value: ethers.parseEther('1') })).wait();
  assert.equal((await ethOf(buyer2.address)) - before.s, ethers.parseEther('0.92'));
  assert.equal((await ethOf(creator.address)) - before.c, ethers.parseEther('0.08'));
  ok('with only the creator fee: a 1 ETH sale pays 0.92 to the seller and 0.08 (8%) to the creator');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('all market checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
