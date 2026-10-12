/* global HashPrints */
(function () {
  const HP = window.HashPrints;
  const C = HP.CONFIG;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const eth = (wei) => (Number(wei) / 1e18).toFixed(6);
  const usd = (wei) => '$' + ((Number(wei) / 1e18) * C.ethUsdSnapshot).toFixed(2);

  // ------------------------------------------------------------ theme
  const root = document.documentElement;
  const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : systemDark());
  const syncToggle = () => { $('themeToggle').textContent = isDark() ? 'Paper' : 'Night'; };
  const savedTheme = store.get('hp.theme', null);
  if (savedTheme) root.dataset.theme = savedTheme;
  syncToggle();
  $('themeToggle').onclick = () => {
    root.dataset.theme = isDark() ? 'light' : 'dark';
    store.set('hp.theme', root.dataset.theme);
    syncToggle();
  };

  // ------------------------------------------------------------ painting
  function paint(canvas, art) {
    canvas.width = canvas.height = art.size;
    const ctx = canvas.getContext('2d');
    art.grid.forEach((row, y) => row.forEach((c, x) => {
      ctx.fillStyle = art.palette[c];
      ctx.fillRect(x, y, 1, 1);
    }));
  }
  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function downloadPng(art, name) {
    const c = document.createElement('canvas');
    c.width = c.height = art.size * 16;
    const ctx = c.getContext('2d');
    art.grid.forEach((row, y) => row.forEach((v, x) => {
      ctx.fillStyle = art.palette[v];
      ctx.fillRect(x * 16, y * 16, 16, 16);
    }));
    c.toBlob((b) => download(name + '.png', b));
  }

  // A seed with exactly `bits` leading zero bits, derived from a label.
  function sampleSeed(label, bits) {
    let h = BigInt('0x' + HP.toHex(HP.keccak256(new TextEncoder().encode(label))));
    h = (h >> BigInt(bits + 1)) | (1n << BigInt(255 - bits));
    return h.toString(16).padStart(64, '0');
  }
  function randomSeed() {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return HP.toHex(b);
  }
  function findSample(prefix, bits, test, limit = 400) {
    for (let i = 0; i < limit; i++) {
      const seed = sampleSeed(`${prefix}-${i}`, bits);
      const art = HP.render(seed, 16);
      if (test(art)) return { seed, art };
    }
    const seed = sampleSeed(prefix, bits);
    return { seed, art: HP.render(seed, 16) };
  }

  // ------------------------------------------------------------ hero
  (function hero() {
    const slots = [
      { canvas: $('heroPaper'), cap: $('heroPaperCap'), edition: 'Paper' },
      { canvas: $('heroNight'), cap: $('heroNightCap'), edition: 'Night' },
    ];
    let ticks = 0, nonce = 0;
    function candidate(edition) {
      for (;;) {
        const seed = randomSeed();
        const art = HP.render(seed, 0);
        if (art.traits.Edition === edition) return { seed, art };
      }
    }
    function frame(found) {
      for (const s of slots) {
        const { seed, art } = candidate(s.edition);
        paint(s.canvas, art);
        s.cap.textContent = found ? art.traits.Style : `0x${seed.slice(0, 8)}…`;
        if (!found) $('grindline').textContent = `nonce ${fmt(nonce)} · 0x${seed} · ${HP.leadingZeroBits(HP.fromHex(seed))} zero bits`;
      }
      if (found) $('grindline').textContent = `found a valid hash after ${fmt(nonce)} tries`;
    }
    if (reduceMotion) { frame(true); return; }
    setInterval(() => {
      ticks++;
      nonce += 3000 + Math.floor(Math.random() * 9000);
      const step = ticks % 16;
      if (step > 0 && step < 12) frame(false);
      else if (step === 0) { frame(true); nonce = 0; }
    }, 140);
  })();

  // ------------------------------------------------------------ art section
  const anatomy = findSample('anatomy', 18, (a) => a.traits.Edition === 'Paper' && a.traits.Registration !== 'Tight'
    && parseInt(a.traits.Coverage) > 18 && a.traits.Symmetry !== 'None');
  paint($('anatomyPrint'), anatomy.art);
  paint($('edPaper'), findSample('paper', 16, (a) => a.traits.Edition === 'Paper' && a.traits.Style === 'Circuit').art);
  paint($('edNight'), findSample('night', 16, (a) => a.traits.Edition === 'Night' && a.traits.Style === 'Bloom').art);
  $('risoSwatches').innerHTML = Object.entries(HP.RISO).map(([n, c]) => `<i title="${n}" style="background:${c}"></i>`).join('');
  $('neonSwatches').innerHTML = Object.entries(HP.NEON).map(([n, c]) => `<i title="${n}" style="background:${c}"></i>`).join('');

  const STYLE_NOTES = {
    Circuit: 'Right-angle paths with a dot at each turn.',
    Zigzag: '45° paths that change direction.',
    Shards: 'Straight lines between random points.',
    Rain: 'Short dashed vertical lines.',
    Weave: 'Horizontal and vertical dashed lines.',
    Bloom: 'Lines from the centre out to the edges.',
  };
  HP.PRESSES.forEach((style, i) => {
    const s = findSample(`press-${style}`, 16, (a) => a.traits.Style === style && a.traits.Edition === (i % 2 ? 'Night' : 'Paper'));
    const fig = document.createElement('figure');
    const c = document.createElement('canvas');
    c.className = 'print';
    paint(c, s.art);
    fig.appendChild(c);
    fig.insertAdjacentHTML('beforeend', `<figcaption>${style}<span>${STYLE_NOTES[style]}</span></figcaption>`);
    $('presses').appendChild(fig);
  });

  // Inspector dialog
  let inspected = null;
  function inspect(seed, difficulty, title, id) {
    const art = HP.render(seed, difficulty);
    inspected = { art, name: title.replace(/[^\w-]+/g, '-').toLowerCase() };
    $('inspectOpen').href = `print.html?${id ? `id=${id}&` : ''}seed=0x${seed}&d=${difficulty}`;
    paint($('inspectPrint'), art);
    const rows = [['Token', title], ...Object.entries(art.traits), ['Seed', `0x${seed.slice(0, 18)}…`]];
    $('inspectTable').innerHTML = rows.map(([k, v]) => `<tr><th style="border-bottom:1px solid var(--rule)">${k}</th><td class="num">${v}</td></tr>`).join('');
    $('inspect').showModal();
  }
  $('inspectClose').onclick = () => $('inspect').close();
  $('inspect').addEventListener('click', (e) => { if (e.target === $('inspect')) $('inspect').close(); });
  $('inspectPng').onclick = () => inspected && downloadPng(inspected.art, inspected.name);
  $('inspectSvg').onclick = () => inspected && download(inspected.name + '.svg', new Blob([HP.toSVG(inspected.art, 16)], { type: 'image/svg+xml' }));

  function thumb(container, { seed, difficulty, title, left, right, id }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Inspect ${title}`);
    const c = document.createElement('canvas');
    c.className = 'print';
    const art = HP.render(seed, difficulty);
    paint(c, art);
    b.appendChild(c);
    b.insertAdjacentHTML('beforeend', `<div class="cap"><span>${left}</span><span>${right}</span></div>`);
    b.onclick = () => inspect(seed, difficulty, title, id);
    b.dataset.edition = art.traits.Edition;
    b.dataset.rare = art.traits.Rarity !== 'Common';
    container.appendChild(b);
  }

  for (let i = 0; i < 24; i++) {
    const bits = i === 17 ? 24 : i % 9 === 4 ? 20 : 16 + (i % 3);
    const seed = sampleSeed(`gallery-${i}`, bits);
    const id = 4 + i * 139;
    const art = HP.render(seed, 16);
    thumb($('gallery'), { seed, difficulty: 16, id, title: `HashPrint #${id}`, left: `#${id}`, right: art.traits.Rarity === 'Common' ? art.traits.Style : art.traits.Rarity });
  }
  document.querySelectorAll('[data-filter]').forEach((chip) => {
    chip.onclick = () => {
      document.querySelectorAll('[data-filter]').forEach((c) => c.setAttribute('aria-pressed', c === chip));
      const f = chip.dataset.filter;
      $('gallery').querySelectorAll('button').forEach((b) => {
        b.hidden = !(f === 'all' || (f === 'rare' ? b.dataset.rare === 'true' : b.dataset.edition === f));
      });
    };
  });

  // ------------------------------------------------------------ run table
  const RATE = 150000;
  const humanTime = (s) => (s < 1 ? '< 1 s' : s < 90 ? `~${Math.round(s)} s` : s < 5400 ? `~${Math.round(s / 60)} min` : `~${(s / 3600).toFixed(1)} h`);
  $('runTable').innerHTML = `<table><thead><tr><th>Run</th><th>Token ids</th><th class="num">Difficulty</th><th class="num">Avg. time</th><th class="num">Gold Leaf</th></tr></thead><tbody>` +
    Array.from({ length: C.runs }, (_, r) => {
      const d = HP.difficultyForRun(r);
      const from = C.artistProofs + r * C.runSize + 1;
      return `<tr><td>${r + 1}</td><td>#${fmt(from)}–${fmt(from + C.runSize - 1)}</td><td class="num">${d} bits</td><td class="num">${humanTime(2 ** d / RATE)}</td><td class="num">${humanTime(2 ** (d + 4) / RATE)}</td></tr>`;
    }).join('') + '</tbody></table>';

  // ------------------------------------------------------------ simulator
  const SIM_CONTRACT = '0x' + '4a5b9a1e7c0de'.padEnd(36, '0') + '3333';
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
  const randomAddr = () => '0x' + HP.toHex(crypto.getRandomValues(new Uint8Array(20)));
  let myPrints = store.get('hp.prints.v2', []);
  let current = null;
  let worker = null;

  for (let r = 0; r < C.runs; r++) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = `Run ${r + 1} · ${HP.difficultyForRun(r)} bits`;
    $('run').appendChild(o);
  }
  $('wallet').value = store.get('hp.wallet', null) || randomAddr();
  $('roPrice').textContent = `${eth(C.priceWei)} ETH + gas`;

  const wallet = () => $('wallet').value.trim().toLowerCase();
  const mintedBy = (w) => myPrints.filter((p) => p.wallet === w).length;

  function refresh() {
    const d = HP.difficultyForRun(Number($('run').value));
    const aim = Number($('aim').value);
    $('roDiff').textContent = `${d} bits`;
    $('roWork').textContent = `${fmt(2 ** (d + aim))} hashes · ${humanTime(2 ** (d + aim) / RATE)}`;
    const w = wallet();
    const n = isAddr(w) ? mintedBy(w) : 0;
    $('walletCount').textContent = isAddr(w) ? `${n} / ${C.maxPerWallet} minted with this wallet` : 'Enter a 0x address (40 hex characters)';
    if (isAddr(w) && n >= C.maxPerWallet && !worker) $('walletCount').textContent += '. Limit reached, use New for another wallet';
    $('grindBtn').disabled = !!worker || !isAddr(w) || n >= C.maxPerWallet;
    if (current) showResult(current);
  }
  ['run', 'aim'].forEach((id) => $(id).addEventListener('input', refresh));
  $('wallet').addEventListener('input', () => { if (isAddr(wallet())) store.set('hp.wallet', wallet()); refresh(); });
  $('randWallet').onclick = () => { $('wallet').value = randomAddr(); store.set('hp.wallet', wallet()); refresh(); };

  function showResult(r) {
    const art = HP.render(r.hash, r.difficulty);
    paint($('simPrint'), art);
    $('simTraits').innerHTML = Object.entries(art.traits).map(([k, v]) =>
      `<span class="tag ${k === 'Rarity' && v !== 'Common' ? 'gold' : ''}">${k === 'Rarity' ? v : `${k}: ${v}`}</span>`).join('');
    $('resNonce').textContent = fmt(r.nonce);
    $('resBits').textContent = `${r.bits} (+${r.extraBits} extra)`;
    $('resPrice').innerHTML = `${eth(C.priceWei)} <small>ETH · ${usd(C.priceWei)} + gas</small>`;
    $('simResult').hidden = false;
    $('pressBtn').disabled = r.minted || mintedBy(r.wallet) >= C.maxPerWallet;
    $('pressBtn').textContent = r.minted ? `Minted #${r.tokenId}` : 'Mint (simulated)';
  }

  function finishSearch(result, seconds, params) {
    if (worker && worker.terminate) worker.terminate();
    worker = null;
    $('stopBtn').disabled = true;
    $('grindBtn').textContent = 'Start search';
    if (!result) {
      $('simStatus').textContent = 'Stopped.';
      refresh();
      return;
    }
    const nonces = store.get('hp.nonces', {});
    nonces[params.minter] = Math.max(nonces[params.minter] || 0, result.nonce + 1);
    store.set('hp.nonces', nonces);
    current = { ...result, difficulty: params.difficulty, wallet: params.minter, minted: false };
    $('simStatus').textContent = `Found in ${seconds.toFixed(1)} s · 0x${result.hash}`;
    refresh();
  }

  $('grindBtn').onclick = () => {
    const params = {
      contract: SIM_CONTRACT,
      minter: wallet(),
      difficulty: HP.difficultyForRun(Number($('run').value)),
      aim: Number($('aim').value),
      startNonce: store.get('hp.nonces', {})[wallet()] || 0,
    };
    current = null;
    $('simResult').hidden = true;
    $('grindBtn').textContent = 'Searching…';
    $('stopBtn').disabled = false;
    const onProgress = ({ nonce, best, sample, rate }) => {
      paint($('simPrint'), HP.render(sample, 0));
      $('simStatus').textContent = `nonce ${fmt(nonce)} · ${fmt(rate)} hashes/s · best so far ${best.bits} bits`;
    };
    try {
      worker = new Worker('grind-worker.js');
      worker.onmessage = (e) => {
        if (e.data.type === 'progress') onProgress(e.data);
        else finishSearch(e.data.result, e.data.seconds, params);
      };
      worker.onerror = () => { $('simStatus').textContent = 'Search worker failed. Try reloading the page.'; finishSearch(null, 0, params); };
      worker.postMessage({ type: 'start', params });
    } catch {
      // Workers can't load from file:// in some browsers; search on the main thread instead.
      let stop = false;
      worker = { postMessage: () => { stop = true; } };
      const t0 = performance.now();
      HP.grind({
        ...params,
        chunk: 3000,
        onProgress: async (nonce, best) => {
          onProgress({ nonce, best, sample: HP.proofHash(params.contract, params.minter, nonce), rate: (nonce - params.startNonce) / ((performance.now() - t0) / 1000) });
          await new Promise((r) => setTimeout(r, 0));
          return !stop;
        },
      }).then((r) => finishSearch(r, (performance.now() - t0) / 1000, params));
    }
    refresh();
  };
  $('stopBtn').onclick = () => worker && worker.postMessage({ type: 'stop' });

  $('pressBtn').onclick = () => {
    if (!current || current.minted || mintedBy(current.wallet) >= C.maxPerWallet) return;
    current.minted = true;
    current.tokenId = C.artistProofs + 1 + myPrints.length;
    myPrints.push({ tokenId: current.tokenId, wallet: current.wallet, hash: current.hash, difficulty: current.difficulty, nonce: current.nonce });
    store.set('hp.prints.v2', myPrints);
    renderMine();
    refresh();
  };
  $('pngBtn').onclick = () => current && downloadPng(HP.render(current.hash, current.difficulty), `hashprint-${current.tokenId || 'preview'}`);

  function renderMine() {
    const box = $('myPrints');
    box.innerHTML = '';
    if (!myPrints.length) {
      box.innerHTML = '<p style="color:var(--muted);grid-column:1/-1">None yet.</p>';
      return;
    }
    [...myPrints].reverse().forEach((p) => {
      const art = HP.render(p.hash, p.difficulty);
      thumb(box, {
        seed: p.hash, difficulty: p.difficulty, id: p.tokenId, title: `HashPrint #${p.tokenId} (simulated)`,
        left: `#${p.tokenId}`, right: art.traits.Rarity === 'Common' ? art.traits.Style : art.traits.Rarity,
      });
    });
  }

  paint($('simPrint'), HP.render(sampleSeed('sim-idle', 16), 16));
  renderMine();
  refresh();
})();
