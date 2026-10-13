/* global ethers, HPMarket, HPWallet */
// Browser side of buying and selling: connect, list (approve + sign), buy and cancel.
// Transactions go straight from the wallet to Seaport; the wallet picks the gas.
(function () {
  const M = window.HPMarket;
  const CHAINS = {
    1: { name: 'Ethereum mainnet', hex: '0x1', explorer: 'https://etherscan.io' },
    11155111: { name: 'Sepolia testnet', hex: '0xaa36a7', explorer: 'https://sepolia.etherscan.io' },
    31337: { name: 'Local dev chain', hex: '0x7a69', explorer: '' },
  };

  let wallet = null; // { provider, address, chainId }

  const eth = (wei, digits = 6) => `${(Number(BigInt(wei)) / 1e18).toLocaleString('en-US', { maximumFractionDigits: digits })} ETH`;

  async function load(key) {
    const r = await fetch(`/api/market?c=${key}`, { cache: 'no-store' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  async function connect(chainId, silent) {
    const w = silent ? await HPWallet.reconnect() : await HPWallet.connect();
    if (!w) return null;
    wallet = w;
    if (!silent && w.chainId !== chainId) {
      const chain = CHAINS[chainId];
      await HPWallet.switchChain(w.provider, chain.hex, chain.name); // the page reloads when it switches
      return null;
    }
    return w;
  }

  function ensure(market) {
    if (!wallet) throw new Error('Connect your wallet first.');
    if (wallet.chainId !== market.chainId) throw new Error(`Switch your wallet to ${CHAINS[market.chainId]?.name || 'the right network'}.`);
    return { provider: new ethers.BrowserProvider(wallet.provider), from: wallet.address };
  }

  // Send a transaction without a gas field and wait for it to be mined.
  async function send(market, to, data, value, onStatus) {
    const { provider, from } = ensure(market);
    const tx = { from, to, data };
    if (value) tx.value = ethers.toQuantity(value);
    onStatus?.('Confirm in your wallet…');
    const hash = await wallet.provider.request({ method: 'eth_sendTransaction', params: [tx] });
    onStatus?.('Waiting for the transaction…');
    const receipt = await provider.waitForTransaction(hash);
    if (!receipt || receipt.status !== 1) throw new Error('The transaction failed on chain.');
    return receipt;
  }

  // List: approve Seaport once per wallet, then sign the order (free), then hand it to the site.
  async function list(market, { tokenId, priceWei, days, onStatus }) {
    const { provider, from } = ensure(market);
    const nft = new ethers.Contract(market.collection, M.NFT_ABI, provider);
    const sp = new ethers.Contract(market.seaport, M.SEAPORT_ABI, provider);
    if ((await nft.ownerOf(tokenId)).toLowerCase() !== from.toLowerCase()) throw new Error('This wallet doesn\'t own this print.');
    if (!(await nft.isApprovedForAll(from, market.seaport))) {
      onStatus?.('Step 1 of 2: allow Seaport to transfer your HashPrints when they sell. Confirm in your wallet…');
      await send(market, market.collection, M.nftInterface.encodeFunctionData('setApprovalForAll', [market.seaport, true]), null, (s) => onStatus?.(`Step 1 of 2: ${s}`));
    }
    const now = Math.floor(Date.now() / 1000);
    const components = M.buildListing({
      collection: market.collection, tokenId, seller: from, priceWei, royalty: market.royalty,
      startTime: now - 60, endTime: now + days * 86400, counter: await sp.getCounter(from),
    });
    onStatus?.('Step 2 of 2: sign the listing in your wallet. Signing is free.');
    const signer = await provider.getSigner(from);
    const signature = await signer.signTypedData(M.domain(market.chainId, market.seaport), M.TYPES, components);
    onStatus?.('Saving the listing…');
    const r = await fetch(`/api/market?c=${market.key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ components, signature }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body.listing;
  }

  async function buy(market, listing, onStatus) {
    const { provider, from } = ensure(market);
    const balance = await provider.getBalance(from);
    if (balance < BigInt(listing.price)) throw new Error(`This wallet has ${eth(balance)}; the print costs ${eth(listing.price)} plus gas.`);
    const data = M.seaportInterface.encodeFunctionData('fulfillOrder', [M.toOrder(listing.components, listing.signature), ethers.ZeroHash]);
    return send(market, market.seaport, data, BigInt(listing.price), onStatus);
  }

  async function cancel(market, listing, onStatus) {
    const data = M.seaportInterface.encodeFunctionData('cancel', [[listing.components]]);
    return send(market, market.seaport, data, null, onStatus);
  }

  function friendly(e) {
    if (e?.code === 4001 || e?.code === 'ACTION_REJECTED' || e?.info?.error?.code === 4001) return 'You cancelled it in your wallet.';
    return e?.info?.error?.message || e?.shortMessage || e?.message || String(e);
  }

  window.HPTrade = { load, connect, list, buy, cancel, friendly, eth, get wallet() { return wallet; }, CHAINS };
})();
