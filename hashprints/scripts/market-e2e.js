// End-to-end test of listings against real Seaport 1.6 code on a local chain:
// list → buy → sale shows up, list → cancel, plus the listings the API must refuse.
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

(async () => {
  const [owner, seller, buyer, stranger, royaltyWallet] = await ethers.getSigners();

  // Contracts: HashPrints (2 artist proofs so the seller can mint for free), Seaport 1.6.
  const nft = await ethers.deployContract('HashPrints', ['Test HashPrint', 'TESTPRINT', 315000000000000n, 'http://localhost/api/test/meta/', 5, 2, 2, seller.address]);
  await nft.waitForDeployment();
  const from = (await ethers.provider.getBlockNumber());
  let startNonce = 0;
  for (let i = 0; i < 2; i++) {
    const found = await HP.grind({ contract: await nft.getAddress(), minter: seller.address, difficulty: 16, startNonce });
    await (await nft.connect(seller).pressArtistProof(found.nonce)).wait();
    startNonce = found.nonce + 1;
  }
  const cc = await (await owner.sendTransaction({ data: '0x' + SP.conduitController })).wait();
  const spFactory = new ethers.ContractFactory([{ type: 'constructor', inputs: [{ name: 'conduitController', type: 'address' }] }], '0x' + SP.seaport, owner);
  const seaport = await spFactory.deploy(cc.contractAddress);
  await seaport.waitForDeployment();
  const SEAPORT = await seaport.getAddress();
  const collection = await nft.getAddress();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  // Point the API handlers at this chain, a temp listing store and this Seaport.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-market-'));
  process.env.HP_LOCAL_RPC = 'http://127.0.0.1:8545';
  process.env.MARKET_STORE_DIR = dir;
  process.env.HP_CONFIG = JSON.stringify({
    test: { chainId, address: collection, fromBlock: from },
    market: { seaport: SEAPORT, royaltyBps: 250, royaltyRecipient: royaltyWallet.address },
  });
  const market = require('../site/api/market.js');
  const collectionApi = require('../site/api/collection.js');
  const M = require('../site/market-core.js');
  const sp = new ethers.Contract(SEAPORT, M.SEAPORT_ABI, owner);
  const royalty = { bps: 250, recipient: royaltyWallet.address };
  const now = async () => (await ethers.provider.getBlock('latest')).timestamp;

  async function listing(signer, tokenId, priceEth, opts = {}) {
    const t = await now();
    const components = M.buildListing({
      collection, tokenId, seller: opts.as || signer.address, priceWei: ethers.parseEther(priceEth), royalty: opts.royalty === undefined ? royalty : opts.royalty,
      startTime: t - 60, endTime: t + 86400 * (opts.days || 7), counter: await sp.getCounter(opts.as || signer.address),
    });
    const signature = await signer.signTypedData(M.domain(chainId, SEAPORT), M.TYPES, components);
    return { components, signature };
  }
  const post = (b) => call(market, 'POST', { c: 'test' }, b);
  const get = async () => (await call(market, 'GET', { c: 'test' })).body;
  let r;

  // 1. Refused before approval.
  r = await post(await listing(seller, 1, '0.01'));
  assert.equal(r.status, 400); assert.match(r.body.error, /approved Seaport/);
  console.log('ok  refuses a listing before Seaport is approved');

  await (await nft.connect(seller).setApprovalForAll(SEAPORT, true)).wait();

  // 2. Refused: signed by someone else, tampered price, missing royalty, not the owner, too long.
  r = await post(await listing(stranger, 1, '0.01', { as: seller.address }));
  assert.equal(r.status, 400); assert.match(r.body.error, /signature/);
  const tampered = await listing(seller, 1, '0.01');
  tampered.components.consideration[0].startAmount = tampered.components.consideration[0].endAmount = '1';
  r = await post(tampered);
  assert.equal(r.status, 400);
  r = await post(await listing(seller, 1, '0.01', { royalty: null }));
  assert.equal(r.status, 400); assert.match(r.body.error, /royalty/);
  r = await post(await listing(stranger, 1, '0.01'));
  assert.equal(r.status, 400); assert.match(r.body.error, /no longer owns/);
  r = await post(await listing(seller, 1, '0.01', { days: 400 }));
  assert.equal(r.status, 400); assert.match(r.body.error, /at most/);
  console.log('ok  refuses forged, tampered, royalty-free, non-owner and over-long listings');

  // 3. A real listing is stored and shown.
  const good = await listing(seller, 1, '0.01');
  r = await post(good);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let list = await get();
  assert.equal(list.listings.length, 1);
  assert.equal(list.listings[0].price, ethers.parseEther('0.01').toString());
  console.log('ok  stores and lists a valid listing');

  // 4. Buyer fills it straight on Seaport: print moves, seller and royalty get paid.
  const before = { seller: await ethers.provider.getBalance(seller.address), royalty: await ethers.provider.getBalance(royaltyWallet.address) };
  const item = list.listings[0];
  await (await sp.connect(buyer).fulfillOrder(M.toOrder(item.components, item.signature), ethers.ZeroHash, { value: BigInt(item.price) })).wait();
  assert.equal(await nft.ownerOf(1), buyer.address);
  const fee = ethers.parseEther('0.01') * 250n / 10000n;
  assert.equal((await ethers.provider.getBalance(seller.address)) - before.seller, ethers.parseEther('0.01') - fee);
  assert.equal((await ethers.provider.getBalance(royaltyWallet.address)) - before.royalty, fee);
  console.log('ok  buyer fills it: print moves, seller gets 0.00975, royalty gets 0.00025');

  // 5. The filled listing disappears; a replayed copy is refused.
  list = await get();
  assert.equal(list.listings.length, 0);
  r = await post(good);
  assert.equal(r.status, 400);
  console.log('ok  filled listing is dropped and can\'t be re-posted');

  // 6. The sale shows up in the collection API with its price.
  const col = (await call(collectionApi, 'GET', { c: 'test' })).body;
  const sale = col.activity.find((a) => a.kind === 'sale');
  assert.ok(sale, JSON.stringify(col.activity));
  assert.equal(sale.price, ethers.parseEther('0.01').toString());
  assert.equal(col.volume, ethers.parseEther('0.01').toString());
  assert.equal(col.tokens.find((t) => t.id === 1).owner, buyer.address);
  console.log('ok  collection shows the sale, its price and the new owner');

  // 7. List and cancel on chain: the listing disappears.
  const two = await listing(seller, 2, '0.5');
  assert.equal((await post(two)).status, 200);
  assert.equal((await get()).listings.length, 1);
  await (await sp.connect(seller).cancel([two.components])).wait();
  assert.equal((await get()).listings.length, 0);
  console.log('ok  cancelled listing is dropped');

  // 8. Listing, then the seller moves the print elsewhere: dropped.
  const three = await listing(seller, 2, '0.4');
  assert.equal((await post(three)).status, 200);
  await (await nft.connect(seller).transferFrom(seller.address, stranger.address, 2)).wait();
  assert.equal((await get()).listings.length, 0);
  console.log('ok  listing is dropped when the print changes hands outside the sale');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('all market checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
