/* global ethers, HashPrints */
(function () {
  const HP = window.HashPrints;
  const $ = (id) => document.getElementById(id);
  const CHAINS = {
    1: { name: 'Ethereum mainnet', hex: '0x1', rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io' },
    11155111: { name: 'Sepolia testnet', hex: '0xaa36a7', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io' },
    31337: { name: 'Local dev chain', hex: '0x7a69', rpc: 'http://127.0.0.1:8545', explorer: null },
  };
  const POLL_MS = 15000;

  const q = new URLSearchParams(location.search);
  const key = q.get('c') === 'test' ? 'test' : 'main';
  const shape = HP.COLLECTIONS[key];
  if (key === 'test') document.getElementById('navCollection').href = 'collection.html?c=test';

  let artifact, address, chainId, chain, reader, readContract;
  let browser, signer, account, walletChain, wallet1193;
  let status = null;
  let minting = false;
  let worker = null;

  // ------------------------------------------------------------ ui helpers
  const say = (text, isErr = false) => { $('msg').textContent = text; $('msg').className = isErr ? 'msg err' : 'msg'; };
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const txLink = (h) => (chain.explorer ? `<a href="${chain.explorer}/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>` : short(h));

  function paint(art) {
    const c = $('canvas');
    c.width = c.height = art.size;
    const ctx = c.getContext('2d');
    art.grid.forEach((row, y) => row.forEach((v, x) => { ctx.fillStyle = art.palette[v]; ctx.fillRect(x, y, 1, 1); }));
  }

  function setBadge(kind, text) {
    $('badge').className = `badge ${kind}`;
    $('badgeText').textContent = text;
  }

  function errMsg(e) {
    if (e?.code === 'ACTION_REJECTED' || e?.code === 4001 || e?.info?.error?.code === 4001) return 'You cancelled the transaction in your wallet.';
    const inner = e?.error?.message || e?.info?.error?.message || e?.data?.message;
    if (/coalesce/.test(e?.shortMessage || e?.message || '') && inner) return inner;
    let name = e?.revert?.name;
    const data = e?.data || e?.info?.error?.data?.data || e?.error?.data;
    if (!name && data && artifact) {
      try { name = new ethers.Interface(artifact.abi).parseError(data)?.name; } catch {}
    }
    const friendly = {
      PressClosed: "Minting isn't live yet.",
      SoldOut: 'Sold out.',
      WalletLimitReached: 'This wallet has already minted the maximum of 2.',
      InsufficientWork: 'The difficulty went up while you were searching (a new run started). Search again.',
      ProofAlreadyUsed: 'That hash was already used by this wallet. Search again.',
      WrongPayment: 'The payment amount was wrong. Reload the page and try again.',
    };
    if (name && friendly[name]) return friendly[name];
    return e?.shortMessage || e?.message || String(e);
  }

  // ------------------------------------------------------------ status
  async function readStatus() {
    const c = account && walletChain === chainId ? new ethers.Contract(address, artifact.abi, browser) : readContract;
    const [openedAt, total, max, pressed, runSize, runs, difficulty, price] = await Promise.all([
      c.openedAt(), c.totalSupply(), c.MAX_SUPPLY(), c.pressed(), c.RUN_SIZE(), c.RUNS(), c.difficulty(), c.price(),
    ]);
    const mine = account ? await c.pressedBy(account) : 0n;
    return { live: openedAt > 0n, total, max, pressed, publicMax: runSize * runs, difficulty, price, mine };
  }

  function render() {
    if (!address) {
      setBadge('off', 'Not live');
      $('notLive').classList.remove('hidden');
      $('mintBox').classList.add('hidden');
      return;
    }
    const s = status;
    $('fPrice').textContent = `${ethers.formatEther(s.price)} ETH + gas`;
    $('fMinted').textContent = `${s.total.toLocaleString()} / ${s.max.toLocaleString()}`;
    $('bar').style.width = `${Number((s.total * 1000n) / (s.max || 1n)) / 10}%`;
    $('fDiff').textContent = `${s.difficulty} zero bits`;
    $('fWallet').textContent = account ? `${s.mine} / 2 minted` : '2 max';
    const soldOut = s.pressed >= s.publicMax;
    if (!s.live) {
      setBadge('off', 'Not live');
      $('notLive').classList.remove('hidden');
      $('mintBox').classList.add('hidden');
    } else if (soldOut) {
      setBadge('', 'Sold out');
      $('notLive').classList.add('hidden');
      $('mintBox').classList.add('hidden');
      if (!minting) say('All prints have been minted.');
    } else {
      setBadge('live', 'Live');
      $('notLive').classList.add('hidden');
      $('mintBox').classList.remove('hidden');
      $('connectBtn').classList.toggle('hidden', !!account);
      $('mintControls').classList.toggle('hidden', !account);
      $('mintBtn').disabled = minting || s.mine >= 2n;
      const justMinted = !$('result').classList.contains('hidden');
      if (account && s.mine >= 2n && !minting && !justMinted) say('This wallet has minted the maximum of 2.');
    }
  }

  async function refresh() {
    if (!address || minting) return render();
    try {
      status = await readStatus();
      render();
    } catch (e) {
      setBadge('', 'Unknown');
      if (!account) {
        // Public node unreachable: let the visitor read through their own wallet instead.
        $('notLive').classList.add('hidden');
        $('mintBox').classList.remove('hidden');
        $('connectBtn').classList.remove('hidden');
        $('mintControls').classList.add('hidden');
        say("Couldn't reach the network. Connect your wallet to check the mint status.", true);
      } else {
        say(`Couldn't read the contract: ${errMsg(e)}`, true);
      }
    }
  }

  // ------------------------------------------------------------ wallet
  async function useWallet(w) {
    if (w.chainId !== chainId) {
      say(`Switch your wallet to ${chain.name}…`);
      await HPWallet.switchChain(w.provider, chain.hex, chain.name); // reloads the page on success
      return;
    }
    wallet1193 = w.provider;
    browser = new ethers.BrowserProvider(w.provider);
    signer = await browser.getSigner(w.address);
    account = w.address;
    walletChain = w.chainId;
    say(`Connected ${short(account)}`);
    await refresh();
  }

  async function connect() {
    try {
      const w = await HPWallet.connect();
      if (w) await useWallet(w);
    } catch (e) {
      say(errMsg(e), true);
    }
  }

  // ------------------------------------------------------------ mint
  function search(difficulty, aim) {
    return new Promise((resolve) => {
      worker = new Worker('grind-worker.js');
      $('stopBtn').disabled = false;
      worker.onmessage = (e) => {
        if (e.data.type === 'progress') {
          paint(HP.render(e.data.sample, 0));
          say(`Searching… ${Math.round(e.data.rate).toLocaleString()} hashes/s · best so far ${e.data.best.bits} of ${difficulty + aim} bits`);
        } else {
          worker.terminate();
          worker = null;
          $('stopBtn').disabled = true;
          resolve(e.data.result);
        }
      };
      worker.onerror = () => { worker = null; $('stopBtn').disabled = true; resolve(null); };
      const startNonce = crypto.getRandomValues(new Uint32Array(1))[0];
      worker.postMessage({ type: 'start', params: { contract: address, minter: account, difficulty, aim, startNonce } });
    });
  }

  async function mint() {
    if (minting) return;
    minting = true;
    $('mintBtn').disabled = true;
    $('result').classList.add('hidden');
    try {
      status = await readStatus();
      if (!status.live) throw new Error("Minting isn't live yet.");
      if (status.mine >= 2n) throw new Error('This wallet has already minted the maximum of 2.');
      const difficulty = Number(status.difficulty);
      const found = await search(difficulty, Number($('aim').value));
      if (!found) { say('Search stopped.'); return; }
      say(`Found a ${found.bits}-bit hash. Confirm the mint in your wallet: ${ethers.formatEther(status.price)} ETH + gas.`);
      const c = new ethers.Contract(address, artifact.abi, signer);
      // Handed straight to the wallet; the wallet decides gas.
      const req = await c.press.populateTransaction(found.nonce, { value: status.price });
      const hash = await wallet1193.request({ method: 'eth_sendTransaction', params: [{
        from: account, to: address, data: req.data, value: ethers.toQuantity(status.price),
      }] });
      say('Transaction sent. Waiting for confirmation…');
      const receipt = await browser.waitForTransaction(hash);
      if (!receipt || receipt.status !== 1) throw new Error('The mint transaction failed on-chain.');
      const ev = receipt.logs.map((l) => { try { return c.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === 'Pressed');
      const id = ev.args.tokenId;
      const art = HP.render(ev.args.seed, difficulty);
      paint(art);
      const page = `print.html?${key === 'test' ? 'c=test&' : ''}id=${id}&seed=${ev.args.seed}&d=${difficulty}`;
      $('resultTable').innerHTML = [
        ['Token', `${shape.name} #${id}`],
        ['Rarity', `<span class="pill ${art.traits.Rarity === 'Holo Foil' ? 'holo' : art.traits.Rarity === 'Gold Leaf' ? 'gold' : ''}"><i></i>${art.traits.Rarity}</span>`],
        ['Style', art.traits.Style],
        ['Edition', art.traits.Edition],
        ['Transaction', txLink(receipt.hash)],
        ['Page', `<a href="${page}" target="_blank" rel="noopener">View print</a> · <a href="collection.html?${key === 'test' ? 'c=test&' : ''}owner=${account}">Your prints</a>`],
      ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
      $('result').classList.remove('hidden');
      say(`Minted ${shape.name} #${id}.`);
    } catch (e) {
      say(errMsg(e), true);
    } finally {
      minting = false;
      await refresh();
    }
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    $('title').textContent = `Mint ${shape.name}`;
    document.title = `Mint ${shape.name}`;
    paint(HP.render('0000' + '8'.repeat(4) + HP.toHex(HP.keccak256(new TextEncoder().encode(key))).slice(8), 16));
    $('connectBtn').onclick = connect;
    $('mintBtn').onclick = mint;
    $('stopBtn').onclick = () => worker && worker.postMessage({ type: 'stop' });

    const [config, art] = await Promise.all([
      fetch('mint-config.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
      fetch('contract/HashPrints.json').then((r) => r.json()),
    ]);
    artifact = art;
    const fromLink = q.get('address');
    address = fromLink && ethers.isAddress(fromLink) ? fromLink : config[key]?.address || '';
    chainId = Number(q.get('chain') || config[key]?.chainId || 1);
    chain = CHAINS[chainId] || CHAINS[1];
    $('fNet').textContent = chain.name;
    if (address) {
      reader = new ethers.JsonRpcProvider(chain.rpc, chainId, { staticNetwork: true });
      readContract = new ethers.Contract(address, artifact.abi, reader);
    }
    const back = await HPWallet.reconnect().catch(() => null); // returning visitor: no popup
    if (back && back.chainId === chainId) await useWallet(back);
    await refresh();
    setInterval(refresh, POLL_MS);
  }

  boot().catch((e) => say(`Couldn't load the mint: ${errMsg(e)}`, true));
})();
