/* global HashPrints */
// Artwork and live run chart around the mint panel. Purely visual: the mint itself lives in mint.js.
(function () {
  const HP = window.HashPrints;
  const $ = (id) => document.getElementById(id);
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function paint(canvas, art) {
    if (!canvas) return;
    canvas.width = canvas.height = art.size;
    const ctx = canvas.getContext('2d');
    art.grid.forEach((row, y) => row.forEach((v, x) => { ctx.fillStyle = art.palette[v]; ctx.fillRect(x, y, 1, 1); }));
  }
  // A seed with exactly `bits` leading zero bits, derived from a label (same scheme as the home page).
  function sampleSeed(label, bits) {
    let h = BigInt('0x' + HP.toHex(HP.keccak256(new TextEncoder().encode(label))));
    h = (h >> BigInt(bits + 1)) | (1n << BigInt(255 - bits));
    return h.toString(16).padStart(64, '0');
  }
  function sample(prefix, bits, test = () => true) {
    for (let i = 0; i < 300; i++) {
      const seed = sampleSeed(`${prefix}-${i}`, bits);
      const art = HP.render(seed, 16);
      if (test(art)) return { seed, art };
    }
    const seed = sampleSeed(prefix, bits);
    return { seed, art: HP.render(seed, 16) };
  }

  // Back plates behind the preview.
  paint($('plateA'), sample('mint-night', 17, (a) => a.traits.Edition === 'Night').art);
  paint($('plateB'), sample('mint-paper', 18, (a) => a.traits.Edition === 'Paper').art);

  // Finishes.
  const fins = [
    ['finCommon', 'capCommon', 17, 'Common'],
    ['finGold', 'capGold', 20, 'Gold Leaf'],
    ['finHolo', 'capHolo', 24, 'Holo Foil'],
  ];
  for (const [c, cap, bits, name] of fins) {
    const { seed, art } = sample(`mint-fin-${name}`, bits, (a) => a.traits.Rarity === name);
    paint($(c), art);
    if ($(cap)) $(cap).textContent = `0x${seed.slice(0, 10)}…`;
  }

  // Hash tape: what the search looks like, a few candidates at a time.
  const tape = $('tape');
  if (tape) {
    const lines = [...tape.querySelectorAll('span')];
    let nonce = Math.floor(Math.random() * 1e6);
    const tick = () => {
      for (let i = 0; i < lines.length - 1; i++) lines[i].textContent = lines[i + 1].textContent;
      nonce += 1 + Math.floor(Math.random() * 3000);
      const h = HP.toHex(HP.keccak256(new TextEncoder().encode(`tape-${nonce}`)));
      lines[lines.length - 1].textContent = `${String(nonce).padStart(8, '0')}  0x${h.slice(0, 40)}…`;
    };
    for (let i = 0; i < lines.length; i++) tick();
    if (!still) setInterval(tick, 140);
  }

  // Runs chart.
  const runs = $('runs');
  if (runs) {
    const key = new URLSearchParams(location.search).get('c') === 'test' ? 'test' : 'main';
    const shape = HP.COLLECTIONS[key] || { runSize: 333, runs: 10 };
    const size = shape.runSize || 333, count = shape.runs || 10;
    const cells = [];
    for (let i = 0; i < count; i++) {
      const d = 16 + Math.floor(i / 2);
      const el = document.createElement('div');
      el.className = 'run';
      el.innerHTML = `<div class="fill"><span></span></div><b>${String(i + 1).padStart(2, '0')}</b><em>${d} bits</em>`;
      runs.appendChild(el);
      cells.push(el);
    }
    fetch(`/api/collection?c=${key}`).then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (!s || !s.deployed) return;
      const pressed = Number(s.pressed) || 0;
      cells.forEach((el, i) => {
        const done = Math.max(0, Math.min(size, pressed - i * size));
        el.querySelector('.fill span').style.height = `${(100 * done) / size}%`;
        el.classList.toggle('done', done >= size);
        el.classList.toggle('now', s.live && i === Number(s.run));
      });
      const note = $('runNote');
      if (note) note.textContent = s.live ? `Run ${Number(s.run) + 1} of ${count} · ${s.difficulty} bits · ${pressed.toLocaleString('en-US')} public prints minted` : `Minting opens soon · ${pressed.toLocaleString('en-US')} public prints minted`;
    }).catch(() => {});
  }
})();
