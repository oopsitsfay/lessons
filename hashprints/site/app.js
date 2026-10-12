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
    let tries = 0, nonce = 0;
    function candidate(edition) {
      for (;;) {
        const seed = randomSeed();
        const art = HP.render(seed, 0);
        if (art.traits.Edition === edition) return { seed, art };
      }
    }
    function frame(lock) {
      for (const s of slots) {
        const { seed, art } = candidate(s.edition);
        paint(s.canvas, art);
        s.cap.textContent = lock ? `#${fmt(4 + (nonce % 3330))} · ${art.traits.Press}` : `0x${seed.slice(0, 8)}…`;
        if (!lock) $('grindline').textContent = `nonce ${fmt(nonce)} → 0x${seed} · ${HP.leadingZeroBits(HP.fromHex(seed))} zero bits`;
      }
      if (lock) $('grindline').textContent = `✓ plate found after ${fmt(nonce)} tries · pressed`;
    }
    if (reduceMotion) { frame(true); return; }
    setInterval(() => {
      tries++;
      nonce += 3000 + Math.floor(Math.random() * 9000);
      const lock = tries % 16 === 0;
      if (tries % 16 > 0 && tries % 16 < 12) frame(false);
      else if (lock) { frame(true); nonce = 0; }
    }, 140);
  })();

  // ------------------------------------------------------------ art section
  const anatomy = findSample('anatomy', 18, (a) => a.traits.Edition === 'Paper' && a.traits.Registration !== 'Tight'
    && parseInt(a.traits.Coverage) > 18 && a.traits.Symmetry !== 'None');
  paint($('anatomyPrint'), anatomy.art);
  paint($('edPaper'), findSample('paper', 16, (a) => a.traits.Edition === 'Paper' && a.traits.Press === 'Circuit').art);
  paint($('edNight'), findSample('night', 16, (a) => a.traits.Edition === 'Night' && a.traits.Press === 'Bloom').art);
  $('risoSwatches').innerHTML = Object.entries(HP.RISO).map(([n, c]) => `<i title="${n}" style="background:${c}"></i>`).join('');
  $('neonSwatches').innerHTML = Object.entries(HP.NEON).map(([n, c]) => `<i title="${n}" style="background:${c}"></i>`).join('');

  const PRESS_NOTES = {
    Circuit: 'Right-angle walkers with solder joints at each turn.',
    Zigzag: '45° walkers that swerve and double back.',
    Shards: 'Straight cuts between random points.',
    Rain: 'Dashed drips with a bright head.',
    Weave: 'Ink A runs across, ink B down, and they overprint where they cross.',
    Bloom: 'Rays burst from the centre to the plate edge.',
  };
  $('presses').innerHTML = '';
  HP.PRESSES.forEach((press, i) => {
    const s = findSample(`press-${press}`, 16, (a) => a.traits.Press === press && a.traits.Edition === (i % 2 ? 'Night' : 'Paper'));
    const fig = document.createElement('figure');
    const c = document.createElement('canvas');
    c.className = 'print';
    paint(c, s.art);
    fig.appendChild(c);
    fig.insertAdjacentHTML('beforeend', `<figcaption>${press}<span>${PRESS_NOTES[press]}</span></figcaption>`);
    $('presses').appendChild(fig);
  });

  // Inspector dialog
  let inspected = null;
  function inspect(seed, difficulty, title) {
    const art = HP.render(seed, difficulty);
    inspected = { art, name: title.replace(/[^\w-]+/g, '-').toLowerCase() };
    paint($('inspectPrint'), art);
    const rows = [['Print', title], ...Object.entries(art.traits), ['Seed', `0x${seed.slice(0, 18)}…`]];
    $('inspectTable').innerHTML = rows.map(([k, v]) => `<tr><th style="border-bottom:1px solid var(--rule)">${k}</th><td class="num">${v}</td></tr>`).join('');
    $('inspect').showModal();
  }
  $('inspectClose').onclick = () => $('inspect').close();
  $('inspect').addEventListener('click', (e) => { if (e.target === $('inspect')) $('inspect').close(); });
  $('inspectPng').onclick = () => inspected && downloadPng(inspected.art, inspected.name);
  $('inspectSvg').onclick = () => inspected && download(inspected.name + '.svg', new Blob([HP.toSVG(inspected.art, 16)], { type: 'image/svg+xml' }));

  function thumb(container, { seed, difficulty, title, left, right }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Inspect ${title}`);
    const c = document.createElement('canvas');
    c.className = 'print';
    const art = HP.render(seed, difficulty);
    paint(c, art);
    b.appendChild(c);
    b.insertAdjacentHTML('beforeend', `<div class="cap"><span>${left}</span><span>${right}</span></div>`);
    b.onclick = () => inspect(seed, difficulty, title);
    b.dataset.edition = art.traits.Edition;
    b.dataset.rare = art.traits.Rarity !== 'Common';
    container.appendChild(b);
  }

  const samples = Array.from({ length: 24 }, (_, i) => {
    const bits = i === 17 ? 24 : i % 9 === 4 ? 20 : 16 + (i % 3);
    return { seed: sampleSeed(`gallery-${i}`, bits), id: 4 + i * 139 };
  });
  samples.forEach(({ seed, id }) => {
    const art = HP.render(seed, 16);
    thumb($('gallery'), { seed, difficulty: 16, title: `HashPrint #${id}`, left: `#${id}`, right: art.traits.Rarity === 'Common' ? art.traits.Press : art.traits.Rarity });
  });
  document.querySelectorAll('[data-filter]').forEach((chip) => {
    chip.onclick = () => {
      document.querySelectorAll('[data-filter]').forEach((c) => c.setAttribute('aria-pressed', c === chip));
      const f = chip.dataset.filter;
      $('gallery').querySelectorAll('button').forEach((b) => {
        b.hidden = !(f === 'all' || (f === 'rare' ? b.dataset.rare === 'true' : b.dataset.edition === f));
      });
    };
  });

  // ------------------------------------------------------------ price chart
  const SERIES = [
    { extra: 0, name: 'First proof', color: 'var(--s1)' },
    { extra: 1, name: '+1 bit', color: 'var(--s2)' },
    { extra: 2, name: '+2 bits', color: 'var(--s3)' },
    { extra: 4, name: '+4 bits (gold)', color: 'var(--s4)' },
  ];
  const eth = (wei) => Number(wei) / 1e18;
  const ethStr = (wei) => eth(wei).toFixed(6);
  const usdStr = (wei) => '$' + (eth(wei) * C.ethUsdSnapshot).toFixed(2);

  (function chart() {
    const W = 960, H = 320, m = { l: 72, r: 20, t: 16, b: 40 };
    const maxMin = 40, yMax = eth(C.floorWei) * 4.3;
    const x = (min) => m.l + (min / maxMin) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - v / yMax) * (H - m.t - m.b);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Press price falls from 4x the floor to the floor over 33 minutes; each extra zero bit halves the premium.">`;
    for (let i = 0; i <= 4; i++) {
      const v = (yMax / 4) * i;
      svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--rule)" stroke-width="1"/>`;
      svg += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(5)}</text>`;
    }
    for (let t = 0; t <= maxMin; t += 5) svg += `<text x="${x(t)}" y="${H - m.b + 20}" text-anchor="middle">${t}m</text>`;
    svg += `<line x1="${x(33)}" x2="${x(33)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--muted)" stroke-dasharray="3 4"/>`;
    svg += `<text x="${x(33) + 6}" y="${m.t + 12}">cooled · 33m</text>`;
    svg += `<text x="${W - m.r}" y="${y(eth(C.floorWei)) + 16}" text-anchor="end" class="lbl">floor ${ethStr(C.floorWei)} ETH ≈ ${usdStr(C.floorWei)}</text>`;
    for (const s of SERIES) {
      const pts = [];
      for (let t = 0; t <= maxMin; t += 0.5) pts.push(`${x(t).toFixed(1)},${y(eth(HP.priceFor(t * 60, s.extra))).toFixed(1)}`);
      svg += `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
      const v0 = eth(HP.priceFor(0, s.extra));
      svg += `<text x="${x(0.6)}" y="${y(v0) - 6}" class="lbl">${s.name}</text>`;
    }
    svg += `<g id="hover" style="display:none"><line id="hoverLine" y1="${m.t}" y2="${H - m.b}" stroke="var(--ink)" stroke-width="1"/>`;
    SERIES.forEach((s, i) => { svg += `<circle id="hoverDot${i}" r="5" fill="${s.color}" stroke="var(--paper)" stroke-width="2"/>`; });
    svg += `</g><rect id="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg>`;
    $('chart').innerHTML = svg;
    $('legend').innerHTML = SERIES.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('');

    const svgEl = $('chart').querySelector('svg');
    const tip = $('tooltip');
    const move = (clientX) => {
      const r = svgEl.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * W;
      const min = Math.max(0, Math.min(maxMin, ((px - m.l) / (W - m.l - m.r)) * maxMin));
      $('hover').style.display = '';
      $('hoverLine').setAttribute('x1', x(min));
      $('hoverLine').setAttribute('x2', x(min));
      SERIES.forEach((s, i) => {
        const d = $('hoverDot' + i);
        d.setAttribute('cx', x(min));
        d.setAttribute('cy', y(eth(HP.priceFor(min * 60, s.extra))));
      });
      tip.innerHTML = `<b>${min.toFixed(1)} min into the run</b><br>` + SERIES.map((s) => {
        const p = HP.priceFor(min * 60, s.extra);
        return `<i style="background:${s.color}"></i>${s.name}: ${ethStr(p)} ETH (${usdStr(p)})`;
      }).join('<br>');
      tip.style.opacity = 1;
      const box = $('chart').parentElement.getBoundingClientRect();
      const left = clientX - box.left + 16;
      tip.style.left = Math.min(left, box.width - tip.offsetWidth - 8) + 'px';
      tip.style.top = (r.top - box.top + 24) + 'px';
    };
    const hide = () => { $('hover').style.display = 'none'; tip.style.opacity = 0; };
    $('hit').addEventListener('mousemove', (e) => move(e.clientX));
    $('hit').addEventListener('touchmove', (e) => move(e.touches[0].clientX), { passive: true });
    $('hit').addEventListener('mouseleave', hide);
    $('hit').addEventListener('touchend', hide);

    const mins = [0, 5, 10, 20, 33];
    $('priceTable').innerHTML = `<table><thead><tr><th>Minutes in</th>${SERIES.map((s) => `<th class="num">${s.name}</th>`).join('')}</tr></thead><tbody>` +
      mins.map((t) => `<tr><td>${t}</td>${SERIES.map((s) => { const p = HP.priceFor(t * 60, s.extra); return `<td class="num">${ethStr(p)} ETH<br><span style="color:var(--muted)">${usdStr(p)}</span></td>`; }).join('')}</tr>`).join('') +
      '</tbody></table>';
  })();

  // ------------------------------------------------------------ run table
  const RATE = 150000;
  const humanTime = (s) => (s < 1 ? '< 1 s' : s < 90 ? `~${Math.round(s)} s` : s < 5400 ? `~${Math.round(s / 60)} min` : `~${(s / 3600).toFixed(1)} h`);
  $('runTable').innerHTML = `<table><thead><tr><th>Run</th><th>Token ids</th><th class="num">Difficulty</th><th class="num">Avg. hashes</th><th class="num">Laptop time</th><th class="num">Gold Leaf time</th></tr></thead><tbody>` +
    Array.from({ length: C.runs }, (_, r) => {
      const d = HP.difficultyForRun(r);
      const from = C.artistProofs + r * C.runSize + 1;
      return `<tr><td>${r + 1}</td><td>#${fmt(from)}–${fmt(from + C.runSize - 1)}</td><td class="num">${d} bits</td><td class="num">${fmt(2 ** d)}</td><td class="num">${humanTime(2 ** d / RATE)}</td><td class="num">${humanTime(2 ** (d + 4) / RATE)}</td></tr>`;
    }).join('') + '</tbody></table>';

  // ------------------------------------------------------------ simulator
  const SIM_CONTRACT = '0x' + '4a5b9a1e7c0de'.padEnd(36, '0') + '3333';
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
  const randomAddr = () => '0x' + HP.toHex(crypto.getRandomValues(new Uint8Array(20)));
  let myPrints = store.get('hp.prints', []);
  let current = null;
  let worker = null;

  for (let r = 0; r < C.runs; r++) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = `Run ${r + 1} · ${HP.difficultyForRun(r)} bits`;
    $('run').appendChild(o);
  }
  $('wallet').value = store.get('hp.wallet', null) || randomAddr();

  const wallet = () => $('wallet').value.trim().toLowerCase();
  const pressedBy = (w) => myPrints.filter((p) => p.wallet === w).length;

  function refresh() {
    const run = Number($('run').value);
    const d = HP.difficultyForRun(run);
    const aim = Number($('aim').value);
    const mins = Number($('minutes').value);
    $('minutesOut').textContent = mins;
    $('roDiff').textContent = `${d} bits`;
    $('roWork').textContent = `${fmt(2 ** (d + aim))} hashes · ${humanTime(2 ** (d + aim) / RATE)}`;
    const base = HP.priceFor(mins * 60, 0);
    $('roBase').textContent = `${ethStr(base)} ETH · ${usdStr(base)}`;
    const w = wallet();
    const n = isAddr(w) ? pressedBy(w) : 0;
    $('walletCount').textContent = isAddr(w) ? `${n} / ${C.maxPerWallet} pressed with this wallet` : 'Enter a 0x… address (40 hex characters)';
    const grinding = !!worker;
    $('grindBtn').disabled = grinding || !isAddr(w) || n >= C.maxPerWallet;
    if (isAddr(w) && n >= C.maxPerWallet && !grinding) $('walletCount').textContent += ' · limit reached, generate a new wallet';
    if (current) showResult(current);
  }
  ['run', 'aim', 'minutes'].forEach((id) => $(id).addEventListener('input', refresh));
  $('wallet').addEventListener('input', () => { if (isAddr(wallet())) store.set('hp.wallet', wallet()); refresh(); });
  $('randWallet').onclick = () => { $('wallet').value = randomAddr(); store.set('hp.wallet', wallet()); refresh(); };

  function showResult(r) {
    const art = HP.render(r.hash, r.difficulty);
    paint($('simPrint'), art);
    const mins = Number($('minutes').value);
    const price = HP.priceFor(mins * 60, r.extraBits);
    const base = HP.priceFor(mins * 60, 0);
    r.price = price.toString();
    $('simTraits').innerHTML = Object.entries(art.traits).map(([k, v]) =>
      `<span class="tag ${k === 'Rarity' && v !== 'Common' ? 'gold' : ''}">${k === 'Rarity' ? v : `${k}: ${v}`}</span>`).join('');
    $('resNonce').textContent = fmt(r.nonce);
    $('resBits').textContent = `${r.bits} (+${r.extraBits} extra)`;
    $('resPrice').innerHTML = `${ethStr(price)} <small>ETH · ${usdStr(price)}</small>`;
    $('resSaved').textContent = base > price ? `${ethStr(base - price)} ETH vs. first proof` : 'nothing (price has cooled to the floor)';
    $('simResult').hidden = false;
    $('pressBtn').disabled = r.pressed || pressedBy(r.wallet) >= C.maxPerWallet;
    $('pressBtn').textContent = r.pressed ? `PRESSED #${r.tokenId}` : 'PRESS (simulated)';
  }

  function finishGrind(result, seconds, params) {
    worker && worker.terminate && worker.terminate();
    worker = null;
    $('stopBtn').disabled = true;
    $('grindBtn').textContent = 'GRIND';
    if (!result) {
      $('simStatus').textContent = 'Stopped.';
      refresh();
      return;
    }
    const nonces = store.get('hp.nonces', {});
    nonces[params.minter] = Math.max(nonces[params.minter] || 0, result.nonce + 1);
    store.set('hp.nonces', nonces);
    current = { ...result, difficulty: params.difficulty, wallet: params.minter, pressed: false };
    $('simStatus').textContent = `✓ Plate found in ${seconds.toFixed(1)} s · 0x${result.hash}`;
    refresh();
  }

  $('grindBtn').onclick = () => {
    const run = Number($('run').value);
    const params = {
      contract: SIM_CONTRACT,
      minter: wallet(),
      difficulty: HP.difficultyForRun(run),
      aim: Number($('aim').value),
      startNonce: store.get('hp.nonces', {})[wallet()] || 0,
    };
    current = null;
    $('simResult').hidden = true;
    $('grindBtn').textContent = 'GRINDING…';
    $('stopBtn').disabled = false;
    const onProgress = ({ nonce, best, sample, rate }) => {
      paint($('simPrint'), HP.render(sample, 0));
      $('simStatus').textContent = `nonce ${fmt(nonce)} · ${fmt(rate)} H/s · best ${best.bits} bits`;
    };
    try {
      worker = new Worker('grind-worker.js');
      worker.onmessage = (e) => {
        if (e.data.type === 'progress') onProgress(e.data);
        else finishGrind(e.data.result, e.data.seconds, params);
      };
      worker.onerror = () => { $('simStatus').textContent = 'Worker failed. Try reloading.'; finishGrind(null, 0, params); };
      worker.postMessage({ type: 'start', params });
    } catch {
      // Workers can't load from file:// in some browsers; grind on the main thread instead.
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
      }).then((r) => finishGrind(r, (performance.now() - t0) / 1000, params));
    }
    refresh();
  };
  $('stopBtn').onclick = () => worker && worker.postMessage({ type: 'stop' });

  $('pressBtn').onclick = () => {
    if (!current || current.pressed || pressedBy(current.wallet) >= C.maxPerWallet) return;
    current.pressed = true;
    current.tokenId = C.artistProofs + 1 + myPrints.length;
    myPrints.push({ tokenId: current.tokenId, wallet: current.wallet, hash: current.hash, difficulty: current.difficulty, nonce: current.nonce, price: current.price });
    store.set('hp.prints', myPrints);
    renderMine();
    refresh();
  };
  $('pngBtn').onclick = () => current && downloadPng(HP.render(current.hash, current.difficulty), `hashprint-${current.tokenId || 'proof'}`);

  function renderMine() {
    const box = $('myPrints');
    box.innerHTML = '';
    if (!myPrints.length) {
      box.innerHTML = '<p style="color:var(--muted);grid-column:1/-1">Nothing pressed yet.</p>';
      return;
    }
    [...myPrints].reverse().forEach((p) => thumb(box, {
      seed: p.hash, difficulty: p.difficulty, title: `HashPrint #${p.tokenId} (simulated)`,
      left: `#${p.tokenId}`, right: `${ethStr(BigInt(p.price))} Ξ`,
    }));
  }

  paint($('simPrint'), HP.render(sampleSeed('sim-idle', 16), 16));
  renderMine();
  refresh();
})();
