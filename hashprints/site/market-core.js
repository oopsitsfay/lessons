/* Listings for HashPrints on Seaport 1.6, the open exchange contract OpenSea also uses.
 *
 * A listing is a Seaport order the seller signs for free: "give one HashPrint, receive X ETH".
 * Buyers fill it by calling Seaport directly and paying the ETH; Seaport moves the token and
 * the money in the same transaction. The site only stores signed orders and never holds funds.
 *
 * Shared by the browser (print/collection pages) and the server (api/market.js), so both
 * build and check orders the same way.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('ethers').ethers);
  else root.HPMarket = factory(root.ethers);
})(typeof self !== 'undefined' ? self : this, function (ethers) {
  // Same address on Ethereum and Sepolia (deployed with a deterministic deployer).
  const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const ZERO32 = '0x' + '00'.repeat(32);
  const ITEM = { NATIVE: 0, ERC721: 2 };
  const MAX_DAYS = 180;

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
  const SEAPORT_ABI = [
    'function getCounter(address offerer) view returns (uint256)',
    `function getOrderHash(${COMPONENTS} order) view returns (bytes32)`,
    'function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)',
    `function validate(tuple(${PARAMS} parameters, bytes signature)[] orders) returns (bool)`,
    `function fulfillOrder(tuple(${PARAMS} parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool)`,
    `function cancel(${COMPONENTS}[] orders) returns (bool)`,
    'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, tuple(uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, tuple(uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
  ];
  const NFT_ABI = [
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
  ];
  const seaportInterface = new ethers.Interface(SEAPORT_ABI);
  const nftInterface = new ethers.Interface(NFT_ABI);

  const domain = (chainId, seaport = SEAPORT) => ({ name: 'Seaport', version: '1.6', chainId: Number(chainId), verifyingContract: seaport });

  // Royalty taken from the price, rounded down. bps = basis points (250 = 2.5%).
  function split(priceWei, royalty) {
    const price = BigInt(priceWei);
    const bps = BigInt(royalty?.bps || 0);
    const fee = royalty?.recipient && bps > 0n ? (price * bps) / 10000n : 0n;
    return { price, fee, seller: price - fee };
  }

  // Everything except the signature: these are the exact fields the seller signs.
  function buildListing({ collection, tokenId, seller, priceWei, royalty, startTime, endTime, counter, salt }) {
    const { fee, seller: toSeller } = split(priceWei, royalty);
    const consideration = [{ itemType: ITEM.NATIVE, token: ZERO, identifierOrCriteria: '0', startAmount: toSeller.toString(), endAmount: toSeller.toString(), recipient: ethers.getAddress(seller) }];
    if (fee > 0n) consideration.push({ itemType: ITEM.NATIVE, token: ZERO, identifierOrCriteria: '0', startAmount: fee.toString(), endAmount: fee.toString(), recipient: ethers.getAddress(royalty.recipient) });
    return {
      offerer: ethers.getAddress(seller),
      zone: ZERO,
      offer: [{ itemType: ITEM.ERC721, token: ethers.getAddress(collection), identifierOrCriteria: String(tokenId), startAmount: '1', endAmount: '1' }],
      consideration,
      orderType: 0, // FULL_OPEN: anyone can fill it, all at once
      startTime: String(startTime),
      endTime: String(endTime),
      zoneHash: ZERO32,
      salt: salt || BigInt(ethers.hexlify(ethers.randomBytes(16))).toString(),
      conduitKey: ZERO32, // the seller approves Seaport itself, no conduit
      counter: String(counter),
    };
  }

  const priceOf = (components) => components.consideration.reduce((sum, c) => sum + BigInt(c.startAmount), 0n);

  function toOrder(components, signature) {
    const { counter, ...rest } = components;
    return { parameters: { ...rest, totalOriginalConsiderationItems: String(components.consideration.length) }, signature };
  }

  // Structural checks that need no chain access. Returns an error string or null.
  function checkShape(c, { collection, royalty, now = Math.floor(Date.now() / 1000) }) {
    try {
      if (!c || typeof c !== 'object') return 'missing order';
      if (!ethers.isAddress(c.offerer)) return 'bad offerer';
      if (c.zone !== ZERO || c.zoneHash !== ZERO32 || c.conduitKey !== ZERO32) return 'zone and conduit must be empty';
      if (Number(c.orderType) !== 0) return 'order type must be full open';
      if (!Array.isArray(c.offer) || c.offer.length !== 1) return 'must offer exactly one print';
      const o = c.offer[0];
      if (Number(o.itemType) !== ITEM.ERC721 || ethers.getAddress(o.token) !== ethers.getAddress(collection)) return 'offer must be a print from this collection';
      if (String(o.startAmount) !== '1' || String(o.endAmount) !== '1') return 'offer amount must be 1';
      if (!Array.isArray(c.consideration) || c.consideration.length < 1 || c.consideration.length > 2) return 'unexpected payment items';
      for (const item of c.consideration) {
        if (Number(item.itemType) !== ITEM.NATIVE || item.token !== ZERO || String(item.identifierOrCriteria) !== '0') return 'payment must be in ETH';
        if (String(item.startAmount) !== String(item.endAmount)) return 'price must be fixed';
        if (BigInt(item.startAmount) < 0n) return 'bad amount';
      }
      const first = c.consideration[0];
      if (ethers.getAddress(first.recipient) !== ethers.getAddress(c.offerer)) return 'first payment must go to the seller';
      const total = priceOf(c);
      if (total <= 0n || total > 10n ** 24n) return 'price out of range';
      const want = split(total, royalty);
      if (want.fee > 0n) {
        const r = c.consideration[1];
        if (!r || ethers.getAddress(r.recipient) !== ethers.getAddress(royalty.recipient) || BigInt(r.startAmount) < want.fee) return 'creator royalty missing';
      } else if (c.consideration.length !== 1) {
        return 'unexpected extra payment';
      }
      const start = Number(c.startTime), end = Number(c.endTime);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'bad times';
      if (start > now + 600) return 'listing starts in the future';
      if (end <= now + 60) return 'listing already expired';
      if (end - now > MAX_DAYS * 86400) return `listings can last at most ${MAX_DAYS} days`;
      BigInt(c.salt); BigInt(c.counter);
      return null;
    } catch (e) {
      return 'malformed order';
    }
  }

  return { SEAPORT, ZERO, TYPES, SEAPORT_ABI, NFT_ABI, seaportInterface, nftInterface, domain, split, buildListing, priceOf, toOrder, checkShape, MAX_DAYS };
});
