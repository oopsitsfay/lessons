/* global ethers, HPMarket, HPWallet */
// Browser side of the market: list, buy, make and accept offers, cancel, transfer, wrap/unwrap.
// Transactions go straight from the wallet to Seaport (or WETH / the collection); the wallet
// picks the gas. Also builds the price forms the print and collection pages share.
(function () {
  const M = window.HPMarket;
  const CHAINS = {
    1: { name: 'Ethereum mainnet', hex: '0x1', explorer: 'https://etherscan.io' },
    11155111: { name: 'Sepolia testnet', hex: '0xaa36a7', explorer: 'https://sepolia.etherscan.io' },
    31337: { name: 'Local dev chain', hex: '0x7a69', explorer: '' },
  };

  let wallet = null; // { provider, address, chainId }

  const eth = (wei, unit = 'ETH', digits = 6) => `${(Number(BigInt(wei)) / 1e18).toLocaleString('en-US', { maximumFractionDigits: digits })} ${unit}`;
  const now = () => Math.floor(Date.now() / 1000);

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
  async function send(market, to, data, value, onStatus, step = '') {
    const { provider, from } = ensure(market);
    const tx = { from, to, data };
    if (value) tx.value = ethers.toQuantity(value);
    onStatus?.(`${step}Confirm in your wallet…`);
    const hash = await wallet.provider.request({ method: 'eth_sendTransaction', params: [tx] });
    onStatus?.(`${step}Waiting for the transaction…`);
    const receipt = await provider.waitForTransaction(hash);
    if (!receipt || receipt.status !== 1) throw new Error('The transaction failed on chain.');
    return receipt;
  }

  async function post(market, kind, components, signature) {
    const r = await fetch(`/api/market?c=${market.key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, components, signature }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body.order;
  }

  async function signOrder(market, components) {
    const { provider, from } = ensure(market);
    const signer = await provider.getSigner(from);
    return signer.signTypedData(M.domain(market.chainId, market.seaport), M.TYPES, components);
  }

  // Seaport needs approval once per wallet to move a seller's prints when one of their orders fills.
  async function approvePrints(market, onStatus, step) {
    const { provider, from } = ensure(market);
    const nft = new ethers.Contract(market.collection, M.NFT_ABI, provider);
    if (await nft.isApprovedForAll(from, market.seaport)) return false;
    onStatus?.(`${step}Allow Seaport to transfer your HashPrints when you sell. `);
    await send(market, market.collection, M.nftInterface.encodeFunctionData('setApprovalForAll', [market.seaport, true]), null, onStatus, step);
    return true;
  }

  async function list(market, { tokenId, priceWei, days, onStatus }) {
    const { provider, from } = ensure(market);
    const nft = new ethers.Contract(market.collection, M.NFT_ABI, provider);
    if (!M.same(await nft.ownerOf(tokenId), from)) throw new Error('This wallet doesn\'t own this print.');
    const needs = !(await nft.isApprovedForAll(from, market.seaport));
    if (needs) await approvePrints(market, onStatus, 'Step 1 of 2: ');
    const sp = new ethers.Contract(market.seaport, M.SEAPORT_ABI, provider);
    const t = now();
    const components = M.buildListing({ collection: market.collection, tokenId, seller: from, priceWei, fees: market.fees, startTime: t - 60, endTime: t + days * 86400, counter: await sp.getCounter(from) });
    onStatus?.(`${needs ? 'Step 2 of 2: ' : ''}Sign the listing in your wallet. Signing is free.`);
    const signature = await signOrder(market, components);
    onStatus?.('Saving the listing…');
    return post(market, 'listing', components, signature);
  }

  async function buy(market, listing, onStatus) {
    const { provider, from } = ensure(market);
    const balance = await provider.getBalance(from);
    if (balance < BigInt(listing.price)) throw new Error(`This wallet has ${eth(balance)}; the print costs ${eth(listing.price)} plus gas.`);
    const data = M.seaportInterface.encodeFunctionData('fulfillOrder', [M.toOrder(listing.components, listing.signature), ethers.ZeroHash]);
    return send(market, market.seaport, data, BigInt(listing.price), onStatus);
  }

  // Offer: wrap ETH into WETH if needed, approve WETH for Seaport if needed, then sign (free).
  async function offer(market, { tokenId, amountWei, days, onStatus }) {
    const { provider, from } = ensure(market);
    const weth = new ethers.Contract(market.weth, M.WETH_ABI, provider);
    const [balance, allowance] = await Promise.all([weth.balanceOf(from), weth.allowance(from, market.seaport)]);
    const steps = [];
    if (balance < amountWei) steps.push('wrap');
    if (allowance < amountWei) steps.push('approve');
    steps.push('sign');
    const label = (name) => (steps.length > 1 ? `Step ${steps.indexOf(name) + 1} of ${steps.length}: ` : '');
    if (balance < amountWei) {
      const missing = amountWei - balance;
      const ethBalance = await provider.getBalance(from);
      if (ethBalance < missing) throw new Error(`Offers are paid in WETH. This wallet has ${eth(balance, 'WETH')} and ${eth(ethBalance)}, not enough for ${eth(amountWei, 'WETH')}.`);
      onStatus?.(`${label('wrap')}Wrap ${eth(missing)} into WETH (offers are paid in WETH; you can unwrap it any time). `);
      await send(market, market.weth, M.wethInterface.encodeFunctionData('deposit', []), missing, onStatus, label('wrap'));
    }
    if (allowance < amountWei) {
      onStatus?.(`${label('approve')}Allow Seaport to use your WETH, only for offers you sign. `);
      await send(market, market.weth, M.wethInterface.encodeFunctionData('approve', [market.seaport, ethers.MaxUint256]), null, onStatus, label('approve'));
    }
    const sp = new ethers.Contract(market.seaport, M.SEAPORT_ABI, provider);
    const t = now();
    const components = M.buildOffer({ collection: market.collection, tokenId, buyer: from, amountWei, fees: market.fees, weth: market.weth, startTime: t - 60, endTime: t + days * 86400, counter: await sp.getCounter(from) });
    onStatus?.(`${label('sign')}Sign the offer in your wallet. Signing is free.`);
    const signature = await signOrder(market, components);
    onStatus?.('Saving the offer…');
    return post(market, 'offer', components, signature);
  }

  // Accept: the owner sends one transaction that matches their own order against the buyer's offer.
  async function accept(market, offerRow, tokenId, onStatus) {
    const { provider, from } = ensure(market);
    const nft = new ethers.Contract(market.collection, M.NFT_ABI, provider);
    if (!M.same(await nft.ownerOf(tokenId), from)) throw new Error('This wallet doesn\'t own this print.');
    const needs = !(await nft.isApprovedForAll(from, market.seaport));
    if (needs) await approvePrints(market, onStatus, 'Step 1 of 2: ');
    const sp = new ethers.Contract(market.seaport, M.SEAPORT_ABI, provider);
    const a = M.acceptArgs({ offer: offerRow.components, signature: offerRow.signature, tokenId, seller: from, sellerCounter: await sp.getCounter(from), now: now() });
    const data = M.seaportInterface.encodeFunctionData('matchAdvancedOrders', [a.orders, a.criteria, a.fulfillments, a.recipient]);
    return send(market, market.seaport, data, null, onStatus, needs ? 'Step 2 of 2: ' : '');
  }

  const cancel = (market, row, onStatus) => send(market, market.seaport, M.seaportInterface.encodeFunctionData('cancel', [[row.components]]), null, onStatus);
  const cancelAll = (market, onStatus) => send(market, market.seaport, M.seaportInterface.encodeFunctionData('incrementCounter', []), null, onStatus);
  const transfer = (market, tokenId, to, onStatus) => send(market, market.collection, M.nftInterface.encodeFunctionData('safeTransferFrom', [wallet.address, ethers.getAddress(to), tokenId]), null, onStatus);
  const unwrap = (market, amountWei, onStatus) => send(market, market.weth, M.wethInterface.encodeFunctionData('withdraw', [amountWei]), null, onStatus);

  async function wethBalance(market) {
    const { provider, from } = ensure(market);
    return new ethers.Contract(market.weth, M.WETH_ABI, provider).balanceOf(from);
  }

  function friendly(e) {
    if (e?.code === 4001 || e?.code === 'ACTION_REJECTED' || e?.info?.error?.code === 4001) return 'You cancelled it in your wallet.';
    return e?.info?.error?.message || e?.shortMessage || e?.message || String(e);
  }

  // ---------------------------------------------------------------- shared form
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (k === 'class') n.className = v; else if (k.startsWith('on')) n[k] = v; else n.setAttribute(k, v);
    n.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
    return n;
  };

  // Price + duration form with a live fee breakdown. mode: 'list' | 'offer'.
  function priceForm(market, { mode, submitLabel, initial, onSubmit, onBack, note }) {
    const unit = mode === 'offer' ? 'WETH' : 'ETH';
    const price = el('input', { type: 'text', inputmode: 'decimal', placeholder: '0.01', 'aria-label': `Amount in ${unit}`, autocomplete: 'off' });
    if (initial) price.value = initial;
    const days = el('select', { 'aria-label': 'Length' },
      ...[[1, '1 day'], [3, '3 days'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [180, '180 days']].map(([v, t]) => {
        const o = el('option', { value: v }, t);
        if (v === (mode === 'offer' ? 7 : 30)) o.selected = true;
        return o;
      }));
    const split = el('div', { class: 'split' });
    const submit = el('button', { type: 'submit', class: 'primary' }, submitLabel);
    const parse = () => {
      const v = price.value.trim();
      if (!/^\d*\.?\d+$/.test(v)) return null;
      try { return ethers.parseEther(v); } catch { return null; }
    };
    const update = () => {
      const wei = parse();
      const min = BigInt(market.minPrice || '0');
      submit.disabled = !wei || wei < min;
      if (!wei) { split.textContent = `Enter an amount in ${unit}.`; return; }
      if (wei < min) { split.textContent = `The minimum is ${eth(min, unit)}.`; return; }
      const s = M.split(wei, market.fees);
      const fees = s.items.map((f) => `${f.label} ${f.bps / 100}%: ${eth(f.amount, unit)}`);
      split.replaceChildren(
        el('div', {}, mode === 'offer' ? `You offer ${eth(s.price, unit)}` : `Buyer pays ${eth(s.price, unit)}`),
        ...fees.map((f) => el('div', {}, f)),
        el('div', {}, el('b', {}, mode === 'offer' ? `Owner receives ${eth(s.seller, unit)}` : `You receive ${eth(s.seller, unit)}`)));
    };
    price.oninput = update;
    update();
    const form = el('form', { onsubmit: (e) => { e.preventDefault(); const wei = parse(); if (wei) onSubmit({ wei, days: Number(days.value) }); } },
      el('div', { class: 'two' }, el('label', {}, `${mode === 'offer' ? 'Offer' : 'Price'} (${unit})`, price), el('label', {}, mode === 'offer' ? 'Offer lasts' : 'Listed for', days)),
      split,
      note ? el('div', { class: 'note' }, note) : null,
      el('div', { class: 'acts' }, submit, onBack ? el('button', { type: 'button', onclick: onBack }, 'Back') : null));
    form.setBusy = (b) => { submit.disabled = b || !parse(); };
    setTimeout(() => price.focus(), 0);
    return form;
  }

  window.HPTrade = {
    load, connect, list, buy, offer, accept, cancel, cancelAll, transfer, unwrap, wethBalance, friendly, eth, el, priceForm, CHAINS,
    get wallet() { return wallet; },
  };
})();
