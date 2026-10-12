/* global ethers, HashPrints */
(function () {
  const HP = window.HashPrints;
  const $ = (id) => document.getElementById(id);
  const CHAINS = {
    1: { name: 'Ethereum mainnet', hex: '0x1', explorer: 'https://etherscan.io', main: true },
    11155111: { name: 'Sepolia testnet', hex: '0xaa36a7', explorer: 'https://sepolia.etherscan.io', main: false },
    31337: { name: 'Local dev chain', hex: '0x7a69', explorer: null, main: false },
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  let artifact, provider, signer, account, chainId, contract, info = {};

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

  function errMsg(e) {
    if (e?.code === 'ACTION_REJECTED' || e?.info?.error?.code === 4001) return 'rejected in wallet';
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

  async function send(label, makeTx) {
    if (!contract || !signer) return log(`${label}: connect a wallet and load a contract first`);
    try {
      log(`${label}: confirm in your wallet…`);
      const tx = await makeTx();
      log(`${label}: sent ${txLink(tx.hash)}`);
      const receipt = await tx.wait();
      log(`${label}: confirmed in block ${receipt.blockNumber}`);
      await refreshStatus();
      return receipt;
    } catch (e) {
      log(`${label} failed: ${errMsg(e)}`);
      return null;
    }
  }

  // ------------------------------------------------------------ wallet
  async function connect() {
    if (!window.ethereum) {
      log('No browser wallet found. Install MetaMask (or similar) and reload.');
      return;
    }
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    signer = await provider.getSigner();
    account = (await signer.getAddress()).toLowerCase();
    chainId = Number((await provider.getNetwork()).chainId);
    const c = chain();
    $('netPill').textContent = `${c.name} · ${short(account)}`;
    $('netPill').className = `pill ${c.main ? 'main' : 'test'}`;
    $('connectBtn').textContent = 'Connected';
    $('mainnetNotice').classList.toggle('hidden', !c.main);
    if (!CHAINS[chainId]) log(`Connected to unsupported chain ${chainId}. Switch to mainnet or Sepolia.`);
    else log(`Connected ${account} on ${c.name}`);
    renderSaved();
    const fromUrl = new URLSearchParams(location.search).get('c');
    if (fromUrl && ethers.isAddress(fromUrl)) await loadContract(fromUrl);
  }

  async function switchTo(id) {
    if (!window.ethereum) return log('No browser wallet found.');
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAINS[id].hex }] });
    } catch (e) {
      log(`Network switch failed: ${errMsg(e)}`);
    }
  }

  if (window.ethereum) {
    window.ethereum.on?.('chainChanged', () => location.reload());
    window.ethereum.on?.('accountsChanged', () => location.reload());
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
    ];
  }

  async function estimate() {
    if (!signer) { log('Connect a wallet first.'); return null; }
    try {
      const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
      const tx = await factory.getDeployTransaction(...ctorArgs());
      const gas = await provider.estimateGas({ ...tx, from: account });
      const fee = await provider.getFeeData();
      const perGas = fee.maxFeePerGas ?? fee.gasPrice;
      const cost = gas * perGas;
      const text = `Deploy ≈ ${gas.toLocaleString()} gas × ${ethers.formatUnits(perGas, 'gwei').slice(0, 6)} gwei ≈ ${ethers.formatEther(cost).slice(0, 9)} ETH (max) on ${chain().name}`;
      $('deployStatus').textContent = text;
      return { text, cost };
    } catch (e) {
      $('deployStatus').textContent = `Estimate failed: ${errMsg(e)}`;
      return null;
    }
  }

  async function deploy() {
    if (!signer) return log('Connect a wallet first.');
    if (!CHAINS[chainId]) return log('Switch to mainnet or Sepolia first.');
    let args;
    try { args = ctorArgs(); } catch (e) { return log(`Check the deploy fields: ${errMsg(e)}`); }
    const est = await estimate();
    const total = Number(args[4] * args[5] + args[6]);
    const ok = confirm(`Deploy "${args[0]}" (${args[1]}) with ${total} tokens at ${ethers.formatEther(args[2])} ETH each on ${chain().name}?\n\n${est ? est.text : 'Gas estimate unavailable.'}\n\nYour wallet will ask you to confirm.`);
    if (!ok) return;
    try {
      const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
      log('Deploy: confirm in your wallet…');
      const c = await factory.deploy(...args);
      const tx = c.deploymentTransaction();
      log(`Deploy: sent ${txLink(tx.hash)}`);
      $('deployStatus').textContent = 'Waiting for confirmation…';
      const receipt = await tx.wait();
      const address = (await c.getAddress()).toLowerCase();
      log(`Deploy: ${args[0]} at ${address} (block ${receipt.blockNumber}, ${receipt.gasUsed.toLocaleString()} gas)`);
      const saved = store.get('hpadmin.contracts', []);
      saved.unshift({ chainId, address, name: args[0], symbol: args[1], block: receipt.blockNumber, ctorArgs: factory.interface.encodeDeploy(args).slice(2) });
      store.set('hpadmin.contracts', saved);
      $('deployStatus').textContent = `Deployed at ${address}`;
      await loadContract(address);
    } catch (e) {
      $('deployStatus').textContent = '';
      log(`Deploy failed: ${errMsg(e)}`);
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
    if (!signer) return log('Connect a wallet first.');
    if (!ethers.isAddress(address)) return log('That is not a valid address.');
    const code = await provider.getCode(address);
    if (code === '0x') return log(`No contract at ${address} on ${chain().name}.`);
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
        ['Minting', open ? `<span class="ok">open</span> since ${new Date(Number(info.openedAt) * 1000).toLocaleString()}` : '<span class="bad">closed</span>'],
        ['Price', `${ethers.formatEther(info.price)} ETH + gas`],
        ['Minted', `${info.totalSupply} / ${info.MAX_SUPPLY} (public ${info.pressed}/${publicMax}, A/P ${info.artistProofsPressed}/${info.ARTIST_PROOFS})`],
        ['Run', info.pressed >= publicMax ? 'sold out' : `${info.currentRun + 1n} of ${info.RUNS} · ${info.difficulty} bits`],
        ['Contract balance', `${ethers.formatEther(info.balance)} ETH`],
        ['Base URI', info.baseURILocked ? '<span class="ok">locked</span>' : 'not locked'],
        ['Your mints', `${info.mine} / 2`],
      ];
      $('statusTable').innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
      $('openBtn').disabled = !info.isOwner || open;
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
    const receipt = await send('Mint', () => contract.press(found.nonce, { value: info.price }));
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
    await send('Artist proof', () => contract.pressArtistProof(found.nonce));
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

  // ------------------------------------------------------------ wiring
  $('connectBtn').onclick = () => connect().catch((e) => log(`Connect failed: ${errMsg(e)}`));
  $('switchMain').onclick = () => switchTo(1);
  $('switchSepolia').onclick = () => switchTo(11155111);
  $('preset').onchange = fillPreset;
  $('estimateBtn').onclick = estimate;
  $('deployBtn').onclick = deploy;
  $('loadBtn').onclick = () => loadContract($('loadAddr').value.trim());
  $('refreshBtn').onclick = (e) => { e.preventDefault(); refreshStatus(); loadTokens(); };
  $('openBtn').onclick = () => confirm(`Open minting on ${chain().name}? The price can't be changed afterwards.`) && send('Open minting', () => contract.openPress());
  $('priceBtn').onclick = () => {
    let wei;
    try { wei = ethers.parseEther($('newPrice').value.trim()); } catch { return log('Enter a price in ETH, e.g. 0.000315'); }
    send('Set price', () => contract.setPrice(wei));
  };
  $('baseBtn').onclick = () => send('Set base URI', () => contract.setBaseURI($('newBase').value.trim()));
  $('lockBtn').onclick = () => confirm('Lock the base URI permanently? This cannot be undone.') && send('Lock base URI', () => contract.lockBaseURI());
  $('apBtn').onclick = artistProof;
  $('withdrawBtn').onclick = () => {
    const to = $('withdrawTo').value.trim() || account;
    if (!ethers.isAddress(to)) return log('Withdraw: invalid address');
    if (confirm(`Withdraw ${ethers.formatEther(info.balance || 0n)} ETH to ${to}?`)) send('Withdraw', () => contract.withdraw(to));
  };
  $('transferBtn').onclick = () => {
    const to = $('newOwner').value.trim();
    if (!ethers.isAddress(to)) return log('Ownership: invalid address');
    if (confirm(`Propose ${to} as the new owner? They must accept from that wallet.`)) send('Propose owner', () => contract.transferOwnership(to));
  };
  $('acceptBtn').onclick = () => send('Accept ownership', () => contract.acceptOwnership());
  $('copyArgs').onclick = () => navigator.clipboard.writeText($('vArgs').value).then(() => log('Constructor args copied'), () => $('vArgs').select());
  $('mintBtn').onclick = () => testMint().catch((e) => log(`Test mint failed: ${errMsg(e)}`));

  ['openBtn', 'priceBtn', 'baseBtn', 'lockBtn', 'apBtn', 'withdrawBtn', 'transferBtn', 'acceptBtn', 'mintBtn'].forEach((id) => { $(id).disabled = true; });
  fillPreset();
  fetch('contract/HashPrints.json').then((r) => r.json()).then((a) => {
    artifact = a;
    $('vCompiler').textContent = `v${a.compiler.replace('.Emscripten.clang', '')} · optimizer on, 200 runs · EVM cancun`;
  }).catch((e) => log(`Could not load contract artifact: ${errMsg(e)}`));
})();
