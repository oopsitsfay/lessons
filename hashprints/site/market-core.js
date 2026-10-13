/* Trading HashPrints on Seaport 1.6, the open exchange contract OpenSea also uses.
 *
 *  Listing          seller signs: give print #id, receive X ETH (minus fees, paid to the fee wallets).
 *                   A buyer fills it with fulfillOrder and pays X ETH.
 *  Offer            buyer signs: give X WETH, receive print #id (or any print, for a collection
 *                   offer), with the fees paid out of X. The owner accepts it with
 *                   matchAdvancedOrders, adding their own order (give the print, receive X minus fees);
 *                   Seaport skips the signature on that one because the owner sends the transaction.
 *  Fees             creator fee (and an optional marketplace fee) are part of every order, so Seaport
 *                   pays them in the same transaction. The site refuses orders without them.
 *
 * Shared by the browser and the server (api/market.js) so both build and check orders the same way.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('ethers').ethers);
  else root.HPMarket = factory(root.ethers);
})(typeof self !== 'undefined' ? self : this, function (ethers) {
  const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395'; // same address on Ethereum and Sepolia
  const WETH = {
    1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    11155111: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  };
  const ZERO = '0x0000000000000000000000000000000000000000';
  const ZERO32 = '0x' + '00'.repeat(32);
  const ITEM = { NATIVE: 0, ERC20: 1, ERC721: 2, ERC721_CRITERIA: 4 };
  const MAX_DAYS = 180;
  const MIN_PRICE = 10n ** 13n; // 0.00001 ETH: below this the fee rounds to nothing
  const MAX_PRICE = 10n ** 24n;

  const TYPES = {
    OrderComponents: [
      { name: 'offerer', type: 'address' },
      { name: 'zone', type: 'address' },
      { name: 'offer', type: 'OfferItem[]' },
      { name: 'consideration', type: 'ConsiderationItem[]' },
      { name: 'orderType', type: 'uint8' },
      { name: 'startTime', type: 'uint256' },
      { name: 'endTime', type: 'uint256' },
      { name: 'zoneHash', type: 'bytes32' },
      { name: 'salt', type: 'uint256' },
      { name: 'conduitKey', type: 'bytes32' },
      { name: 'counter', type: 'uint256' },
    ],
    OfferItem: [
      { name: 'itemType', type: 'uint8' },
      { name: 'token', type: 'address' },
      { name: 'identifierOrCriteria', type: 'uint256' },
      { name: 'startAmount', type: 'uint256' },
      { name: 'endAmount', type: 'uint256' },
    ],
    ConsiderationItem: [
      { name: 'itemType', type: 'uint8' },
      { name: 'token', type: 'address' },
      { name: 'identifierOrCriteria', type: 'uint256' },
      { name: 'startAmount', type: 'uint256' },
      { name: 'endAmount', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
  };

  const OFFER = 'tuple(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)';
  const CONS = 'tuple(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)';
  const COMPONENTS = `tuple(address offerer, address zone, ${OFFER}[] offer, ${CONS}[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 counter)`;
  const PARAMS = `tuple(address offerer, address zone, ${OFFER}[] offer, ${CONS}[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems)`;
  const ADVANCED = `tuple(${PARAMS} parameters, uint120 numerator, uint120 denominator, bytes signature, bytes extraData)`;
  const RESOLVER = 'tuple(uint256 orderIndex, uint8 side, uint256 index, uint256 identifier, bytes32[] criteriaProof)';
  const FULFILLMENT = 'tuple(tuple(uint256 orderIndex, uint256 itemIndex)[] offerComponents, tuple(uint256 orderIndex, uint256 itemIndex)[] considerationComponents)';
  const SEAPORT_ABI = [
    'function getCounter(address offerer) view returns (uint256)',
    `function getOrderHash(${COMPONENTS} order) view returns (bytes32)`,
    'function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)',
    `function validate(tuple(${PARAMS} parameters, bytes signature)[] orders) returns (bool)`,
    `function fulfillOrder(tuple(${PARAMS} parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool)`,
    `function matchAdvancedOrders(${ADVANCED}[] orders, ${RESOLVER}[] criteriaResolvers, ${FULFILLMENT}[] fulfillments, address recipient) payable returns (tuple(tuple(uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient) item, address offerer, bytes32 conduitKey)[] executions)`,
    `function cancel(${COMPONENTS}[] orders) returns (bool)`,
    'function incrementCounter() returns (uint256 newCounter)',
    'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, tuple(uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, tuple(uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
  ];
  const NFT_ABI = [
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
    'function safeTransferFrom(address from, address to, uint256 tokenId)',
  ];
  const WETH_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function deposit() payable',
    'function withdraw(uint256 amount)',
  ];
  const seaportInterface = new ethers.Interface(SEAPORT_ABI);
  const nftInterface = new ethers.Interface(NFT_ABI);
  const wethInterface = new ethers.Interface(WETH_ABI);

  const domain = (chainId, seaport = SEAPORT) => ({ name: 'Seaport', version: '1.6', chainId: Number(chainId), verifyingContract: seaport });
  const addr = (a) => ethers.getAddress(a);
  const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  // Fee schedule from mint-config.json's "market" block. Every fee is taken out of the price.
  function feesFrom(market) {
    const fees = [];
    if (market && Number(market.creatorFeeBps) > 0 && ethers.isAddress(market.creatorFeeRecipient || '')) {
      fees.push({ label: 'Creator fee', bps: Number(market.creatorFeeBps), recipient: addr(market.creatorFeeRecipient) });
    }
    if (market && Number(market.marketFeeBps) > 0 && ethers.isAddress(market.marketFeeRecipient || '')) {
      fees.push({ label: 'Marketplace fee', bps: Number(market.marketFeeBps), recipient: addr(market.marketFeeRecipient) });
    }
    return fees;
  }

  // How a price is split: each fee rounded down, the seller gets the rest.
  function split(priceWei, fees = []) {
    const price = BigInt(priceWei);
    const items = fees.map((f) => ({ ...f, amount: (price * BigInt(f.bps)) / 10000n }));
    const seller = items.reduce((left, f) => left - f.amount, price);
    return { price, items, seller };
  }

  const salt = () => BigInt(ethers.hexlify(ethers.randomBytes(16))).toString();
  const money = (itemType, token, amount, recipient) => ({ itemType, token, identifierOrCriteria: '0', startAmount: amount.toString(), endAmount: amount.toString(), recipient: addr(recipient) });

  function base(offerer, startTime, endTime, counter) {
    return { offerer: addr(offerer), zone: ZERO, orderType: 0, startTime: String(startTime), endTime: String(endTime), zoneHash: ZERO32, salt: salt(), conduitKey: ZERO32, counter: String(counter) };
  }
  const order = (b, offer, consideration) => ({
    offerer: b.offerer, zone: b.zone, offer, consideration, orderType: b.orderType, startTime: b.startTime, endTime: b.endTime,
    zoneHash: b.zoneHash, salt: b.salt, conduitKey: b.conduitKey, counter: b.counter,
  });

  // Listing: the seller gives the print and asks for ETH; fees come out of the price.
  function buildListing({ collection, tokenId, seller, priceWei, fees, startTime, endTime, counter }) {
    const s = split(priceWei, fees);
    return order(base(seller, startTime, endTime, counter),
      [{ itemType: ITEM.ERC721, token: addr(collection), identifierOrCriteria: String(tokenId), startAmount: '1', endAmount: '1' }],
      [money(ITEM.NATIVE, ZERO, s.seller, seller), ...s.items.map((f) => money(ITEM.NATIVE, ZERO, f.amount, f.recipient))]);
  }

  // Offer: the buyer gives WETH and asks for one print (tokenId) or any print (tokenId null).
  function buildOffer({ collection, tokenId, buyer, amountWei, fees, weth, startTime, endTime, counter }) {
    const s = split(amountWei, fees);
    const any = tokenId === null || tokenId === undefined;
    return order(base(buyer, startTime, endTime, counter),
      [{ itemType: ITEM.ERC20, token: addr(weth), identifierOrCriteria: '0', startAmount: s.price.toString(), endAmount: s.price.toString() }],
      [{ itemType: any ? ITEM.ERC721_CRITERIA : ITEM.ERC721, token: addr(collection), identifierOrCriteria: any ? '0' : String(tokenId), startAmount: '1', endAmount: '1', recipient: addr(buyer) },
        ...s.items.map((f) => money(ITEM.ERC20, weth, f.amount, f.recipient))]);
  }

  const priceOf = (c) => (Number(c.offer[0].itemType) === ITEM.ERC20
    ? BigInt(c.offer[0].startAmount)
    : c.consideration.reduce((sum, i) => sum + BigInt(i.startAmount), 0n));
  const isOffer = (c) => Number(c.offer[0].itemType) === ITEM.ERC20;

  function toOrder(components, signature) {
    const { counter, ...rest } = components;
    return { parameters: { ...rest, totalOriginalConsiderationItems: String(components.consideration.length) }, signature };
  }

  // Accepting an offer: the owner's own order (give the print, receive the offer minus fees in WETH),
  // matched against the buyer's signed offer. Returns the matchAdvancedOrders arguments.
  function acceptArgs({ offer, signature, tokenId, seller, sellerCounter, now }) {
    const weth = offer.offer[0].token;
    const fees = offer.consideration.slice(1);
    const net = fees.reduce((left, f) => left - BigInt(f.startAmount), BigInt(offer.offer[0].startAmount));
    const mine = order(base(seller, now - 60, now + 3600, sellerCounter),
      [{ itemType: ITEM.ERC721, token: addr(offer.consideration[0].token), identifierOrCriteria: String(tokenId), startAmount: '1', endAmount: '1' }],
      [money(ITEM.ERC20, weth, net, seller)]);
    const adv = (c, sig) => ({ parameters: toOrder(c, sig).parameters, numerator: 1, denominator: 1, signature: sig, extraData: '0x' });
    const orders = [adv(offer, signature), adv(mine, '0x')];
    const criteria = Number(offer.consideration[0].itemType) === ITEM.ERC721_CRITERIA
      ? [{ orderIndex: 0, side: 1, index: 0, identifier: String(tokenId), criteriaProof: [] }] : [];
    const fulfillments = [
      { offerComponents: [{ orderIndex: 1, itemIndex: 0 }], considerationComponents: [{ orderIndex: 0, itemIndex: 0 }] }, // print -> buyer
      { offerComponents: [{ orderIndex: 0, itemIndex: 0 }], considerationComponents: [{ orderIndex: 1, itemIndex: 0 }] }, // WETH -> seller
      ...fees.map((_, i) => ({ offerComponents: [{ orderIndex: 0, itemIndex: 0 }], considerationComponents: [{ orderIndex: 0, itemIndex: i + 1 }] })), // WETH -> fees
    ];
    return { orders, criteria, fulfillments, recipient: addr(seller), net, sellerOrder: mine };
  }

  function checkCommon(c, now) {
    if (!c || typeof c !== 'object' || !Array.isArray(c.offer) || !Array.isArray(c.consideration)) return 'missing order';
    if (!ethers.isAddress(c.offerer)) return 'bad offerer';
    if (c.zone !== ZERO || c.zoneHash !== ZERO32 || c.conduitKey !== ZERO32) return 'zone and conduit must be empty';
    if (Number(c.orderType) !== 0) return 'order type must be full open';
    for (const i of [...c.offer, ...c.consideration]) {
      if (String(i.startAmount) !== String(i.endAmount)) return 'amounts must be fixed';
      if (BigInt(i.startAmount) < 0n) return 'bad amount';
    }
    const start = Number(c.startTime), end = Number(c.endTime);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'bad times';
    if (start > now + 600) return 'starts in the future';
    if (end <= now + 60) return 'already expired';
    if (end - now > MAX_DAYS * 86400) return `can last at most ${MAX_DAYS} days`;
    BigInt(c.salt); BigInt(c.counter);
    return null;
  }

  // The fee items in an order must be exactly the configured fees on this price.
  function checkFees(items, price, fees, itemType, token) {
    const want = split(price, fees).items.filter((f) => f.amount > 0n);
    if (items.length !== want.length) return want.length ? `must include the ${want.map((f) => f.label.toLowerCase()).join(' and ')}` : 'unexpected extra payment';
    for (let i = 0; i < want.length; i++) {
      const it = items[i];
      if (Number(it.itemType) !== itemType || !same(it.token, token) || String(it.identifierOrCriteria) !== '0') return 'fee paid in the wrong currency';
      if (!same(it.recipient, want[i].recipient) || BigInt(it.startAmount) !== want[i].amount) return `${want[i].label.toLowerCase()} must be ${want[i].bps / 100}%`;
    }
    return null;
  }

  // Listing shape: exactly one print from this collection for a fixed ETH price with the fees.
  function checkListing(c, { collection, fees, now = Math.floor(Date.now() / 1000) }) {
    try {
      const common = checkCommon(c, now);
      if (common) return common;
      if (c.offer.length !== 1) return 'must offer exactly one print';
      const o = c.offer[0];
      if (Number(o.itemType) !== ITEM.ERC721 || !same(o.token, collection) || String(o.startAmount) !== '1') return 'offer must be one print from this collection';
      const first = c.consideration[0];
      if (!first || Number(first.itemType) !== ITEM.NATIVE || first.token !== ZERO || !same(first.recipient, c.offerer)) return 'the first payment must be ETH to the seller';
      const price = priceOf(c);
      if (price < MIN_PRICE || price > MAX_PRICE) return 'price out of range';
      return checkFees(c.consideration.slice(1), price, fees, ITEM.NATIVE, ZERO);
    } catch {
      return 'malformed order';
    }
  }

  // Offer shape: WETH for one print (or any print) from this collection, fees paid in WETH.
  function checkOffer(c, { collection, fees, weth, now = Math.floor(Date.now() / 1000) }) {
    try {
      const common = checkCommon(c, now);
      if (common) return common;
      if (c.offer.length !== 1 || Number(c.offer[0].itemType) !== ITEM.ERC20 || !same(c.offer[0].token, weth)) return 'offers must be in WETH';
      const amount = BigInt(c.offer[0].startAmount);
      if (amount < MIN_PRICE || amount > MAX_PRICE) return 'offer out of range';
      const want = c.consideration[0];
      const kind = Number(want?.itemType);
      if (!want || !same(want.token, collection) || !same(want.recipient, c.offerer) || String(want.startAmount) !== '1') return 'offer must ask for one print from this collection';
      if (kind === ITEM.ERC721_CRITERIA) { if (String(want.identifierOrCriteria) !== '0') return 'collection offers must accept any print'; } else if (kind !== ITEM.ERC721) return 'offer must ask for a print';
      return checkFees(c.consideration.slice(1), amount, fees, ITEM.ERC20, weth);
    } catch {
      return 'malformed order';
    }
  }

  return {
    SEAPORT, WETH, ZERO, ITEM, TYPES, SEAPORT_ABI, NFT_ABI, WETH_ABI, seaportInterface, nftInterface, wethInterface,
    MAX_DAYS, MIN_PRICE, domain, feesFrom, split, buildListing, buildOffer, acceptArgs, priceOf, isOffer, toOrder, checkListing, checkOffer, same,
  };
});
