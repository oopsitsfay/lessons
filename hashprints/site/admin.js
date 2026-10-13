/* global ethers, HashPrints */
(function () {
  const HP = window.HashPrints;
  const $ = (id) => document.getElementById(id);
  const CHAINS = {
    1: { name: 'Ethereum mainnet', hex: '0x1', explorer: 'https://etherscan.io', main: true },
    11155111: { name: 'Sepolia testnet', hex: '0xaa36a7', explorer: 'https://sepolia.etherscan.io', main: false },
    31337: { name: 'Local dev chain', hex: '0x7a69', explorer: null, main: false },
  };
  // Arachnid's deterministic deployment proxy: same address on mainnet, Sepolia and most chains.
  const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  let artifact, provider, signer, account, chainId, contract, wallet1193, info = {};

  // ------------------------------------------------------------ helpers
  const chain = () => CHAINS[chainId] || { name: `chain ${chainId}`, explorer: null, main: false };
  const txLink = (h) => (chain().explorer ? `${chain().explorer}/tx/${h}` : h);
  const addrLink = (a) => (chain().explorer ? `${chain().explorer}/address/${a}` : '#');
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function log(msg) {
    const t = new Date().toLocaleTimeString();
    $('log').textContent = `[${t}] ${msg}\n` + $('log').textContent;
  }
  const notify = (msg, kind = 'info') => { log(msg); HPWallet.toast(msg.replace(/https?:\/\/\S+\/tx\//, ''), kind); };

  function errMsg(e) {
    if (e?.code === 'ACTION_REJECTED' || e?.code === 4001 || e?.info?.error?.code === 4001) return 'rejected in wallet';
    // Wallets that answer in a non-standard shape make ethers say "could not coalesce error";
    // the wallet's own message is inside.
    const inner = e?.error?.message || e?.info?.error?.message || e?.data?.message;
    if (/coalesce/.test(e?.shortMessage || e?.message || '') && inner) return inner;
    if (e?.revert?.name) return `${e.revert.name}(${(e.revert.args || []).map(String).join(', ')})`;
    const data = e?.data || e?.info?.error?.data?.data || e?.error?.data;
    if (data && artifact) {
      try {
        const parsed = new ethers.Interface(artifact.abi).parseError(data);
        if (parsed) return `${parsed.name}(${parsed.args.map(String).join(', ')})`;
      } catch {}
    }
    return e?.shortMessage || e?.reason || e?.message || String(e);
  }

  // Hands the transaction straight to the wallet (eth_sendTransaction). No gas field: the wallet decides gas.
  async function sendTx({ to, data, value = 0n, gas }) {
    const tx = { from: account, data, value: ethers.toQuantity(BigInt(value || 0)) };
    if (to) tx.to = to;
    if (gas) tx.gas = ethers.toQuantity(gas);
    const hash = await wallet1193.request({ method: 'eth_sendTransaction', params: [tx] });
    log(`sent ${txLink(hash)}`);
    HPWallet.toast('Sent. Waiting for confirmation…');
    const receipt = await provider.waitForTransaction(hash);
    if (!receipt || receipt.status !== 1) throw new Error(`Transaction failed on-chain: ${txLink(hash)}`);
    return receipt;
  }

  // Deploys are the one case where the page sets the gas limit: some networks (e.g. Sepolia's newer
  // gas rules, ~16.4M for this contract vs ~2.4M on mainnet) need more than wallets pick by default,
  // and a short limit fails the deploy. Uses the network's own figure plus a small margin, capped at
  // the protocol's per-transaction maximum. The wallet still sets the gas price.
  const TX_GAS_CAP = 16777216n;
  async function deployGasLimit(req) {
    try {
      const needed = await provider.estimateGas({ from: account, ...req });
      const withMargin = needed + needed / 50n + 50000n; // +2% + 50k
      return withMargin > TX_GAS_CAP ? (needed <= TX_GAS_CAP ? TX_GAS_CAP : undefined) : withMargin;
    } catch {
      return undefined; // let the wallet decide if the network can't say
    }
  }

  async function send(label, makeTx) {
    if (!contract || !signer) return notify('Connect your wallet and load a contract first.', 'error');
    try {
      notify(`${label}: confirm in your wallet…`);
      const receipt = await sendTx(await makeTx());
      notify(`${label}: done ✓`);
      await refreshStatus();
      return receipt;
    } catch (e) {
      notify(`${label} failed: ${errMsg(e)}`, 'error');
      return null;
    }
  }

  // ------------------------------------------------------------ wallet
  async function useWallet(w) {
    wallet1193 = w.provider;
    provider = new ethers.BrowserProvider(w.provider);
    signer = await provider.getSigner(w.address);
    account = w.address;
    chainId = w.chainId;
    const c = chain();
    $('netPill').textContent = `${c.name} · ${short(account)}`;
    $('netPill').className = `pill ${c.main ? 'main' : 'test'}`;
    $('connectBtn').classList.add('hidden');
    // Network picker: switches the wallet (adding Sepolia if needed); the page reloads on change.
    const sel = $('netSelect');
    sel.classList.toggle('hidden', chainId === 31337);
    if (!CHAINS[chainId] || chainId === 31337) {
      if (!sel.querySelector('option[value="other"]')) sel.insertAdjacentHTML('afterbegin', `<option value="other">Other network (${chainId})</option>`);
    }
    sel.value = CHAINS[chainId] && chainId !== 31337 ? String(chainId) : 'other';
    sel.onchange = async () => {
      const id = Number(sel.value);
      if (!CHAINS[id]) return;
      notify(`Switching your wallet to ${CHAINS[id].name}…`);
      const ok = await HPWallet.switchChain(w.provider, CHAINS[id].hex, CHAINS[id].name);
      if (!ok) sel.value = CHAINS[chainId] ? String(chainId) : 'other';
    };
    log(`Connected ${account} on ${c.name}`);
    if (!CHAINS[chainId]) notify('Your wallet is on another network. Pick Ethereum mainnet or Sepolia at the top.', 'error');
    renderSaved();
    const fromUrl = new URLSearchParams(location.search).get('c');
    if (fromUrl && ethers.isAddress(fromUrl)) await loadContract(fromUrl);
  }

  async function connect() {
    const w = await HPWallet.connect();
    if (w) await useWallet(w);
  }

  // ------------------------------------------------------------ deploy
  function fillPreset() {
    const c = HP.COLLECTIONS[$('preset').value];
    $('cName').value = c.name;
    $('cSymbol').value = c.symbol;
    $('cPrice').value = ethers.formatEther(c.priceWei);
    $('cRunSize').value = c.runSize;
    $('cRuns').value = c.runs;
    $('cAP').value = c.artistProofs;
    $('cBase').value = c.baseURI;
  }

  function ctorArgs() {
    return [
      $('cName').value.trim(),
      $('cSymbol').value.trim(),
      ethers.parseEther($('cPrice').value.trim() || '0'),
      $('cBase').value.trim(),
      BigInt($('cRunSize').value),
      BigInt($('cRuns').value),
      BigInt($('cAP').value),
      account, // owner: the connected wallet, not the deployer contract
    ];
  }

  async function deploy() {
    if (!signer) return notify('Connect a wallet first.', 'error');
    if (!CHAINS[chainId]) return notify('Pick Ethereum mainnet or Sepolia at the top first.', 'error');
    let args;
    try { args = ctorArgs(); } catch (e) { return notify(`Check the deploy fields: ${errMsg(e)}`, 'error'); }
    try {
      const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
      notify('Deploy: confirm in your wallet…');
      $('deployStatus').textContent = 'Confirm in your wallet…';
      const { data: initcode } = await factory.getDeployTransaction(...args);
      let receipt, address;
      if ((await provider.getCode(CREATE2_DEPLOYER)) !== '0x') {
        // Ordinary transaction to the public CREATE2 deployer, which creates the contract.
        // Works in wallets that can't send contract-creation transactions (e.g. Zerion).
        const salt = ethers.hexlify(crypto.getRandomValues(new Uint8Array(32)));
        address = ethers.getCreate2Address(CREATE2_DEPLOYER, salt, ethers.keccak256(initcode)).toLowerCase();
        const deployData = ethers.concat([salt, initcode]);
        receipt = await sendTx({ to: CREATE2_DEPLOYER, data: deployData, gas: await deployGasLimit({ to: CREATE2_DEPLOYER, data: deployData }) });
        if ((await provider.getCode(address)) === '0x') throw new Error('The deploy transaction confirmed but no contract was created.');
      } else {
        receipt = await sendTx({ data: initcode, gas: await deployGasLimit({ data: initcode }) });
        address = receipt.contractAddress.toLowerCase();
      }
      notify(`Deployed ${args[0]} at ${short(address)} ✓`); log(`Deploy: ${args[0]} at ${address} (block ${receipt.blockNumber}, ${receipt.gasUsed.toLocaleString()} gas)`);
      const saved = store.get('hpadmin.contracts', []);
      saved.unshift({ chainId, address, name: args[0], symbol: args[1], block: receipt.blockNumber, ctorArgs: factory.interface.encodeDeploy(args).slice(2) });
      store.set('hpadmin.contracts', saved);
      $('deployStatus').textContent = `Deployed at ${address}`;
      await loadContract(address);
    } catch (e) {
      $('deployStatus').textContent = '';
      notify(`Deploy failed: ${errMsg(e)}`, 'error');
    }
  }

  function renderSaved() {
    const saved = store.get('hpadmin.contracts', []).filter((s) => s.chainId === chainId);
    $('savedList').innerHTML = saved.length
      ? 'Deployed from this browser: ' + saved.map((s) => `<a href="#" data-addr="${s.address}">${escapeHtml(s.name)} ${short(s.address)}</a>`).join(' · ')
      : '';
    $('savedList').querySelectorAll('a').forEach((a) => { a.onclick = (e) => { e.preventDefault(); loadContract(a.dataset.addr); }; });
  }

  // ------------------------------------------------------------ status
  async function loadContract(address) {
    if (!signer) return notify('Connect a wallet first.', 'error');
    if (!ethers.isAddress(address)) return notify('That is not a valid address.', 'error');
    const code = await provider.getCode(address);
    if (code === '0x') return notify(`No contract at ${address} on ${chain().name}.`, 'error');
    contract = new ethers.Contract(address, artifact.abi, signer);
    const url = new URL(location.href);
    url.searchParams.set('c', address);
    history.replaceState(null, '', url);
    $('loadAddr').value = address;
    const rec = store.get('hpadmin.contracts', []).find((s) => s.address === address.toLowerCase() && s.chainId === chainId);
    $('vArgs').value = rec ? rec.ctorArgs : 'Not deployed from this browser. Encode the constructor args yourself.';
    log(`Loaded ${address}`);
    await refreshStatus();
    await loadTokens();
  }

  async function refreshStatus() {
    if (!contract) return;
    try {
      const keys = ['name', 'symbol', 'owner', 'pendingOwner', 'price', 'openedAt', 'pressed', 'artistProofsPressed',
        'MAX_SUPPLY', 'RUN_SIZE', 'RUNS', 'ARTIST_PROOFS', 'currentRun', 'difficulty', 'baseURILocked', 'totalSupply'];
      const vals = await Promise.all(keys.map((k) => contract[k]()));
      info = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
      info.address = (await contract.getAddress()).toLowerCase();
      info.balance = await provider.getBalance(info.address);
      info.mine = await contract.pressedBy(account);
      info.isOwner = info.owner.toLowerCase() === account;
      const publicMax = info.RUN_SIZE * info.RUNS;
      const open = info.openedAt > 0n;
      const rows = [
        ['Collection', `${escapeHtml(info.name)} (${escapeHtml(info.symbol)})`],
        ['Address', `<a href="${addrLink(info.address)}" target="_blank" rel="noopener">${info.address}</a>`],
        ['Owner', `${info.owner}${info.isOwner ? ' <span class="ok">(you)</span>' : ''}`],
        ...(info.pendingOwner !== ethers.ZeroAddress ? [['Pending owner', info.pendingOwner]] : []),
        ['Status', open ? `<span class="ok">Live</span> since ${new Date(Number(info.openedAt) * 1000).toLocaleString()}` : '<span class="bad">Not live</span> (mints are rejected until you press Go live)'],
        ['Price', `${ethers.formatEther(info.price)} ETH + gas`],
        ['Minted', `${info.totalSupply} / ${info.MAX_SUPPLY} (public ${info.pressed}/${publicMax}, A/P ${info.artistProofsPressed}/${info.ARTIST_PROOFS})`],
        ['Run', info.pressed >= publicMax ? 'sold out' : `${info.currentRun + 1n} of ${info.RUNS} · ${info.difficulty} bits`],
        ['Contract balance', `${ethers.formatEther(info.balance)} ETH`],
        ['Base URI', info.baseURILocked ? '<span class="ok">locked</span>' : 'not locked'],
        ['Your mints', `${info.mine} / 2`],
      ];
      $('statusTable').innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
      $('openBtn').disabled = !info.isOwner || open;
      $('openBtn').textContent = open ? 'Live' : 'Go live';
      const pub = `mint.html?${info.symbol === HP.COLLECTIONS.test.symbol ? 'c=test&' : ''}chain=${chainId}&address=${info.address}`;
      $('publicLink').innerHTML = `Public mint page for this contract: <a href="${pub}" target="_blank" rel="noopener">${location.origin}/${pub}</a>`;
      $('priceBtn').disabled = !info.isOwner || open;
      $('baseBtn').disabled = !info.isOwner || info.baseURILocked;
      $('lockBtn').disabled = !info.isOwner || info.baseURILocked;
      $('apBtn').disabled = !info.isOwner || info.artistProofsPressed >= info.ARTIST_PROOFS;
      $('withdrawBtn').disabled = !info.isOwner || info.balance === 0n;
      $('transferBtn').disabled = !info.isOwner;
      $('acceptBtn').disabled = info.pendingOwner.toLowerCase() !== account;
      $('mintBtn').disabled = !open || info.pressed >= publicMax || info.mine >= 2n;
      if (!$('newBase').value) {
        const preset = Object.values(HP.COLLECTIONS).find((c) => c.symbol === info.symbol);
        if (preset) $('newBase').value = preset.baseURI;
      }
    } catch (e) {
      log(`Status read failed: ${errMsg(e)}`);
    }
  }

  // ------------------------------------------------------------ hash search
  let worker = null;
  function search(minter, difficulty, aim, statusEl) {
    return new Promise((resolve) => {
      worker = new Worker('grind-worker.js');
      $('stopBtn').disabled = false;
      const startNonce = crypto.getRandomValues(new Uint32Array(1))[0]; // avoid re-finding an earlier hash
      worker.onmessage = (e) => {
        if (e.data.type === 'progress') {
          statusEl.textContent = `searching · ${Math.round(e.data.rate).toLocaleString()} hashes/s · best ${e.data.best.bits} bits`;
        } else {
          worker.terminate();
          worker = null;
          $('stopBtn').disabled = true;
          resolve(e.data.result ? { ...e.data.result, seconds: e.data.seconds } : null);
        }
      };
      worker.onerror = () => { worker = null; $('stopBtn').disabled = true; statusEl.textContent = 'Search worker failed.'; resolve(null); };
      worker.postMessage({ type: 'start', params: { contract: info.address, minter, difficulty, aim, startNonce } });
    });
  }
  $('stopBtn').onclick = () => worker && worker.postMessage({ type: 'stop' });

  function printUrl(id, seed, d) {
    const test = info.symbol === HP.COLLECTIONS.test.symbol ? 'c=test&' : '';
    return `print.html?${test}id=${id}&seed=${seed}&d=${d}`;
  }

  async function testMint() {
    $('mintStatus').textContent = 'Starting search…';
    $('mintOut').classList.add('hidden');
    $('mintBtn').disabled = true;
    await refreshStatus();
    const d = Number(info.difficulty);
    const aim = Number($('aim').value);
    const found = await search(account, d, aim, $('mintStatus'));
    if (!found) { $('mintStatus').textContent = 'Search stopped.'; await refreshStatus(); return; }
    $('mintStatus').textContent = `Found ${found.bits}-bit hash in ${found.seconds.toFixed(1)} s. Confirm the mint in your wallet (${ethers.formatEther(info.price)} ETH + gas).`;
    const receipt = await send('Mint', () => contract.press.populateTransaction(found.nonce, { value: info.price }));
    if (!receipt) { $('mintStatus').textContent = 'Mint not completed. See the log.'; return; }
    const ev = receipt.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === 'Pressed');
    const id = ev.args.tokenId;
    const seed = ev.args.seed;
    const art = HP.render(seed, d);
    paintCanvas($('mintCanvas'), art);
    const uri = await contract.tokenURI(id);
    $('mintTable').innerHTML = [
      ['Token', `#${id}`],
      ['Rarity', art.traits.Rarity],
      ['Zero bits', `${found.bits} (+${found.extraBits})`],
      ['Transaction', `<a href="${txLink(receipt.hash)}" target="_blank" rel="noopener">${short(receipt.hash)}</a>`],
      ['Gas used', receipt.gasUsed.toLocaleString()],
      ['Metadata', `<a href="${escapeHtml(uri)}" target="_blank" rel="noopener">tokenURI</a>`],
      ['Page', `<a href="${printUrl(id, seed, d)}" target="_blank" rel="noopener">view print</a>`],
    ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
    $('mintOut').classList.remove('hidden');
    $('mintStatus').textContent = `Minted #${id}.`;
    await loadTokens();
  }

  async function artistProof() {
    const found = await search(account, HP.CONFIG.baseDifficulty, 0, $('mintStatus'));
    if (!found) return;
    $('mintStatus').textContent = `Found A/P hash in ${found.seconds.toFixed(1)} s.`;
    await send('Artist proof', () => contract.pressArtistProof.populateTransaction(found.nonce));
    await loadTokens();
  }

  // ------------------------------------------------------------ tokens
  function paintCanvas(canvas, art) {
    canvas.width = canvas.height = art.size;
    const ctx = canvas.getContext('2d');
    art.grid.forEach((row, y) => row.forEach((c, x) => { ctx.fillStyle = art.palette[c]; ctx.fillRect(x, y, 1, 1); }));
  }

  let tokensSeq = 0;
  async function loadTokens() {
    if (!contract) return;
    const seq = ++tokensSeq; // overlapping refreshes: only the latest one renders
    try {
      const rec = store.get('hpadmin.contracts', []).find((s) => s.address === info.address && s.chainId === chainId);
      const from = rec ? rec.block : Math.max(0, (await provider.getBlockNumber()) - 45000);
      // Raw eth_getLogs: ethers caches the block number for a few seconds, which can hide a mint that just landed.
      const topic = contract.interface.getEvent('Pressed').topicHash;
      const logs = await provider.send('eth_getLogs', [{ address: info.address, topics: [topic], fromBlock: ethers.toQuantity(from), toBlock: 'latest' }]);
      const events = logs.map((l) => contract.interface.parseLog(l));
      if (seq !== tokensSeq) return;
      const box = document.createDocumentFragment();
      if (!events.length) { $('tokens').innerHTML = '<span class="mono" style="color:var(--muted)">Nothing yet.</span>'; return; }
      for (const ev of events) {
        const { tokenId, minter, seed, difficulty } = ev.args;
        const art = HP.render(seed, Number(difficulty));
        const a = document.createElement('a');
        a.href = printUrl(tokenId, seed, difficulty);
        a.target = '_blank';
        a.rel = 'noopener';
        const c = document.createElement('canvas');
        paintCanvas(c, art);
        a.appendChild(c);
        a.insertAdjacentHTML('beforeend', `<span><b>#${tokenId}</b>${short(minter)}</span><span>${art.traits.Rarity}</span>`);
        box.appendChild(a);
      }
      $('tokens').replaceChildren(box);
    } catch (e) {
      log(`Could not load events: ${errMsg(e)}`);
    }
  }

  // ------------------------------------------------------------ market storage check
  async function marketCheck() {
    const box = $('marketCheck');
    box.textContent = 'Checking…';
    try {
      const r = await fetch('/api/admin/market-check', { credentials: 'same-origin', cache: 'no-store' });
      const j = await r.json();
      const fees = (j.fees || []).map((f) => `${f.label} ${f.percent}% → ${f.recipient.slice(0, 6)}…${f.recipient.slice(-4)}`).join(', ') || 'none';
      const stored = j.stored ? Object.entries(j.stored).map(([k, v]) => `${k}: ${v.listings} listings, ${v.offers} offers`).join(' · ') : '';
      box.innerHTML = '';
      const line = (t, cls) => { const d = document.createElement('div'); d.textContent = t; if (cls) d.className = cls; box.appendChild(d); };
      line(j.ok ? `Storage working (${j.backend}, write + read + delete in ${j.roundTripMs} ms)` : `Storage not working: ${j.error || r.status}`, j.ok ? 'ok' : 'bad');
      line(`Fees: ${fees}`);
      if (stored) line(`Stored: ${stored}`);
    } catch (e) {
      box.textContent = `Could not run the check: ${e.message}`;
    }
  }
  $('marketCheckBtn').onclick = marketCheck;
  marketCheck();

  // ------------------------------------------------------------ wiring
  $('signOutBtn').onclick = () => fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }).finally(() => { location.href = '/admin-login.html'; });
  $('connectBtn').onclick = () => connect().catch((e) => notify(HPWallet.friendly(e), 'error'));
  $('preset').onchange = fillPreset;
  $('deployBtn').onclick = deploy;
  $('loadBtn').onclick = () => loadContract($('loadAddr').value.trim());
  $('refreshBtn').onclick = (e) => { e.preventDefault(); refreshStatus(); loadTokens(); };
  $('openBtn').onclick = () => confirm(`Go live on ${chain().name}? Anyone can mint from this moment. This can't be undone and the price is fixed from now on.`) && send('Go live', () => contract.openPress.populateTransaction());
  $('priceBtn').onclick = () => {
    let wei;
    try { wei = ethers.parseEther($('newPrice').value.trim()); } catch { return notify('Enter a price in ETH, e.g. 0.000315', 'error'); }
    send('Set price', () => contract.setPrice.populateTransaction(wei));
  };
  $('baseBtn').onclick = () => send('Set base URI', () => contract.setBaseURI.populateTransaction($('newBase').value.trim()));
  $('lockBtn').onclick = () => confirm('Lock the base URI permanently? This cannot be undone.') && send('Lock base URI', () => contract.lockBaseURI.populateTransaction());
  $('apBtn').onclick = artistProof;
  $('withdrawBtn').onclick = () => {
    const to = $('withdrawTo').value.trim() || account;
    if (!ethers.isAddress(to)) return notify('Withdraw: invalid address', 'error');
    if (confirm(`Withdraw ${ethers.formatEther(info.balance || 0n)} ETH to ${to}?`)) send('Withdraw', () => contract.withdraw.populateTransaction(to));
  };
  $('transferBtn').onclick = () => {
    const to = $('newOwner').value.trim();
    if (!ethers.isAddress(to)) return notify('Ownership: invalid address', 'error');
    if (confirm(`Propose ${to} as the new owner? They must accept from that wallet.`)) send('Propose owner', () => contract.transferOwnership.populateTransaction(to));
  };
  $('acceptBtn').onclick = () => send('Accept ownership', () => contract.acceptOwnership.populateTransaction());
  $('copyArgs').onclick = () => navigator.clipboard.writeText($('vArgs').value).then(() => log('Constructor args copied'), () => $('vArgs').select());
  $('mintBtn').onclick = () => testMint().catch((e) => log(`Test mint failed: ${errMsg(e)}`));

  ['openBtn', 'priceBtn', 'baseBtn', 'lockBtn', 'apBtn', 'withdrawBtn', 'transferBtn', 'acceptBtn', 'mintBtn'].forEach((id) => { $(id).disabled = true; });
  fillPreset();
  fetch('contract/HashPrints.json').then((r) => r.json()).then((a) => {
    artifact = a;
    $('vCompiler').textContent = `v${a.compiler.replace('.Emscripten.clang', '')} · optimizer on, 200 runs · EVM cancun`;
    // You signed in with a wallet to get here, so reconnect it without another popup.
    return HPWallet.reconnect().then((w) => w && useWallet(w));
  }).catch((e) => log(`Could not load contract artifact: ${errMsg(e)}`));
})();
