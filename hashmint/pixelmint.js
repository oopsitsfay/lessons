// pixelmint — shared core for the browser page and the Node CLI.
// A "mint" is a tiny proof-of-work block; its SHA-256 hash seeds a pixel-art sprite.
(function (root) {
  const SIZE = 32;

  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function blockPayload(b) {
    return [b.index, b.prevHash, b.timestamp, b.minter, b.message, b.difficulty, b.nonce].join('|');
  }

  // Search for a nonce whose hash starts with `difficulty` zero hex digits.
  // Yields every `chunk` tries so the browser stays responsive.
  async function mine(draft, { onProgress, chunk = 2000 } = {}) {
    const target = '0'.repeat(draft.difficulty);
    const block = { ...draft, nonce: 0 };
    for (;;) {
      for (let i = 0; i < chunk; i++, block.nonce++) {
        const hash = await sha256Hex(blockPayload(block));
        if (hash.startsWith(target)) return { ...block, hash };
      }
      if (onProgress) onProgress(block.nonce);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // sfc32 PRNG seeded from the first 128 bits of the hash.
  function prngFromHash(hash) {
    let [a, b, c, d] = [0, 8, 16, 24].map((i) => parseInt(hash.slice(i, i + 8), 16) >>> 0);
    const next = () => {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      const t = (a + b + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 12; i++) next();
    return next;
  }

  // Neon palettes: [background, ...ink]. Golden mints get the 24K palette.
  const PALETTES = {
    Acid: ['#0a0a0a', '#c6ff00', '#00ff9c', '#f5f5f5'],
    Vapor: ['#12002b', '#ff4ecd', '#00e5ff', '#fff36b'],
    Toxic: ['#05140a', '#39ff14', '#b4ff00', '#ff00a0'],
    Blood: ['#0d0000', '#ff1a1a', '#ff6a00', '#ffd1d1'],
    Ice: ['#00101a', '#7df9ff', '#2979ff', '#ffffff'],
    Rug: ['#111111', '#ff0055', '#ffffff', '#00ff66'],
    Moon: ['#000814', '#ffd60a', '#ffc300', '#e0e1dd'],
    Void: ['#000000', '#ffffff', '#7a7a7a', '#ff2bd6'],
  };
  const GOLD = ['#0b0700', '#ffd700', '#fff4b0', '#ff9f00'];
  const STYLES = ['Circuit', 'Zigzag', 'Shards', 'Rain'];
  const SYMMETRY = ['None', 'Mirror', 'Quad', 'Rotational'];

  // Pixel lines traced by hash-seeded walkers. Palette index 0 is background.
  function generate(hash, difficulty = 0) {
    const rand = prngFromHash(hash);
    const ri = (n) => Math.floor(rand() * n);
    const pick = (arr) => arr[ri(arr.length)];
    const leadingZeros = hash.match(/^0*/)[0].length;
    const bonusZeros = Math.max(0, leadingZeros - difficulty);

    const paletteName = bonusZeros > 0 ? '24K' : pick(Object.keys(PALETTES));
    const palette = bonusZeros > 0 ? GOLD : PALETTES[paletteName];
    const style = pick(STYLES);
    const symmetry = pick(SYMMETRY);
    const grid = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
    const M = SIZE - 1;
    let inked = 0;

    const set = (x, y, c) => {
      if (x < 0 || y < 0 || x > M || y > M) return;
      if (!grid[y][x]) inked++;
      grid[y][x] = c;
    };
    const plot = (x, y, c) => {
      set(x, y, c);
      if (symmetry === 'Mirror' || symmetry === 'Quad') set(M - x, y, c);
      if (symmetry === 'Quad') { set(x, M - y, c); set(M - x, M - y, c); }
      if (symmetry === 'Rotational') set(M - x, M - y, c);
    };
    const line = (x0, y0, x1, y1, c) => {
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        plot(x0, y0, c);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    };
    const DIRS4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const DIRS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const walk = (dirs, turnStep, c) => {
      let x = ri(SIZE), y = ri(SIZE), d = ri(dirs.length);
      const steps = 30 + ri(90);
      for (let i = 0; i < steps; i++) {
        plot(x, y, c);
        if (rand() < 0.14) {
          d = (d + (rand() < 0.5 ? turnStep : dirs.length - turnStep)) % dirs.length;
          plot(x, y, 3); // accent "solder joint" at each turn
        }
        x += dirs[d][0]; y += dirs[d][1];
        if (x < 0 || y < 0 || x > M || y > M) break;
      }
    };

    const strokes = 3 + ri(8);
    for (let s = 0; s < strokes; s++) {
      const ink = 1 + ri(2);
      if (style === 'Circuit') walk(DIRS4, 1, ink);
      else if (style === 'Zigzag') walk(DIRS8, 1 + ri(2), ink);
      else if (style === 'Shards') {
        let [x, y] = [ri(SIZE), ri(SIZE)];
        for (let k = 0; k < 2 + ri(3); k++) {
          const [nx, ny] = [ri(SIZE), ri(SIZE)];
          line(x, y, nx, ny, ink);
          [x, y] = [nx, ny];
        }
        plot(x, y, 3);
      } else {
        // Rain: dashed vertical drips with a bright head.
        for (let k = 0; k < 4; k++) {
          const x = ri(SIZE), y0 = ri(SIZE), len = 4 + ri(16);
          for (let y = y0; y < Math.min(SIZE, y0 + len); y++) if (rand() > 0.15) plot(x, y, ink);
          plot(x, Math.min(M, y0 + len), 3);
        }
      }
    }

    // Glitch: shift a few horizontal bands sideways.
    const glitchBands = rand() < 0.45 ? 1 + ri(3) : 0;
    for (let g = 0; g < glitchBands; g++) {
      const y0 = ri(SIZE), h = 1 + ri(3), shift = 2 + ri(8);
      for (let y = y0; y < Math.min(SIZE, y0 + h); y++)
        grid[y] = grid[y].slice(shift).concat(grid[y].slice(0, shift));
    }

    const traits = {
      style,
      palette: paletteName,
      symmetry,
      strokes,
      glitch: glitchBands ? `${glitchBands}x` : 'Clean',
      ink: Math.round((inked / (SIZE * SIZE)) * 100) + '%',
      rarity: bonusZeros > 1 ? 'Mythic' : bonusZeros > 0 ? 'Golden' : 'Common',
    };
    return { size: SIZE, grid, palette, traits };
  }

  function toSVG(art, scale = 12) {
    const px = art.size * scale;
    let rects = `<rect width="${px}" height="${px}" fill="${art.palette[0]}"/>`;
    art.grid.forEach((row, y) =>
      row.forEach((c, x) => {
        if (c) rects += `<rect x="${x * scale}" y="${y * scale}" width="${scale}" height="${scale}" fill="${art.palette[c]}"/>`;
      })
    );
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" shape-rendering="crispEdges">${rects}</svg>`;
  }

  async function verifyChain(chain) {
    for (let i = 0; i < chain.length; i++) {
      const b = chain[i];
      const prev = i === 0 ? GENESIS_PREV : chain[i - 1].hash;
      if (b.index !== i) return { ok: false, at: i, reason: 'bad index' };
      if (b.prevHash !== prev) return { ok: false, at: i, reason: 'broken link to previous block' };
      if ((await sha256Hex(blockPayload(b))) !== b.hash) return { ok: false, at: i, reason: 'hash mismatch (tampered?)' };
      if (!b.hash.startsWith('0'.repeat(b.difficulty))) return { ok: false, at: i, reason: 'insufficient work' };
    }
    return { ok: true };
  }

  const GENESIS_PREV = '0'.repeat(64);

  function nextDraft(chain, minter, message, difficulty) {
    const last = chain[chain.length - 1];
    return {
      index: chain.length,
      prevHash: last ? last.hash : GENESIS_PREV,
      timestamp: Date.now(),
      minter,
      message,
      difficulty,
    };
  }

  const api = { SIZE, sha256Hex, blockPayload, mine, generate, toSVG, verifyChain, nextDraft, GENESIS_PREV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PixelMint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
