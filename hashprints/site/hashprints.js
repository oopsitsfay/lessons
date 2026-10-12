// HashPrints core: keccak256, proof-of-grind, Dutch pricing, and the print renderer.
// Shared by the website, the grind worker, and the Node tests. Mirrors contracts/HashPrints.sol.
(function (root) {
  // ---------------------------------------------------------------- keccak256
  // 64-bit lanes stored as [lo, hi] uint32 pairs. Lane i lives at s[2i], s[2i+1].
  const RC = [
    '0000000000000001', '0000000000008082', '800000000000808a', '8000000080008000',
    '000000000000808b', '0000000080000001', '8000000080008081', '8000000000008009',
    '000000000000008a', '0000000000000088', '0000000080008009', '000000008000000a',
    '000000008000808b', '800000000000008b', '8000000000008089', '8000000000008003',
    '8000000000008002', '8000000000000080', '000000000000800a', '800000008000000a',
    '8000000080008081', '8000000000008080', '0000000080000001', '8000000080008008',
  ].flatMap((h) => [parseInt(h.slice(8), 16) >>> 0, parseInt(h.slice(0, 8), 16) >>> 0]);
  const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
  const PI = new Array(25);
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);

  const B = new Uint32Array(50);
  const C = new Uint32Array(10);

  function keccakF(s) {
    for (let round = 0; round < 24; round++) {
      for (let x = 0; x < 5; x++) {
        C[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
        C[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
      }
      for (let x = 0; x < 5; x++) {
        const p = (x + 4) % 5, n = (x + 1) % 5;
        const lo = C[2 * p] ^ ((C[2 * n] << 1) | (C[2 * n + 1] >>> 31));
        const hi = C[2 * p + 1] ^ ((C[2 * n + 1] << 1) | (C[2 * n] >>> 31));
        for (let y = 0; y < 25; y += 5) {
          s[2 * (x + y)] ^= lo;
          s[2 * (x + y) + 1] ^= hi;
        }
      }
      for (let i = 0; i < 25; i++) {
        let lo = s[2 * i], hi = s[2 * i + 1], r = ROT[i];
        if (r >= 32) { const t = lo; lo = hi; hi = t; r -= 32; }
        const j = 2 * PI[i];
        if (r) {
          B[j] = (lo << r) | (hi >>> (32 - r));
          B[j + 1] = (hi << r) | (lo >>> (32 - r));
        } else {
          B[j] = lo;
          B[j + 1] = hi;
        }
      }
      for (let y = 0; y < 25; y += 5) {
        for (let x = 0; x < 5; x++) {
          const a = 2 * (y + x), b = 2 * (y + ((x + 1) % 5)), c = 2 * (y + ((x + 2) % 5));
          s[a] = B[a] ^ (~B[b] & B[c]);
          s[a + 1] = B[a + 1] ^ (~B[b + 1] & B[c + 1]);
        }
      }
      s[0] ^= RC[2 * round];
      s[1] ^= RC[2 * round + 1];
    }
  }

  const RATE = 136;
  function keccak256(bytes) {
    const s = new Uint32Array(50);
    const padded = new Uint8Array(Math.ceil((bytes.length + 1) / RATE) * RATE);
    padded.set(bytes);
    padded[bytes.length] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;
    const view = new DataView(padded.buffer);
    for (let off = 0; off < padded.length; off += RATE) {
      for (let i = 0; i < RATE / 4; i++) s[i] ^= view.getUint32(off + 4 * i, true);
      keccakF(s);
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(4 * i, s[i], true);
    return out;
  }

  const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const fromHex = (hex) => Uint8Array.from(hex.replace(/^0x/, '').match(/../g).map((h) => parseInt(h, 16)));

  function leadingZeroBits(bytes) {
    let n = 0;
    for (const b of bytes) {
      if (b === 0) { n += 8; continue; }
      return n + Math.clz32(b) - 24;
    }
    return n;
  }

  // ------------------------------------------------------------- the press
  const CONFIG = {
    name: 'HashPrints',
    maxSupply: 3333,
    artistProofs: 3,
    runSize: 333,
    runs: 10,
    baseDifficulty: 16,
    startMultiplier: 4,
    decaySeconds: 33 * 60,
    floorWei: 315000000000000n, // 0.000315 ETH ≈ $0.80 at ETH ≈ $2,540 (Oct 12, 2026)
    maxPerWallet: 2,
    ethUsdSnapshot: 2540,
    goldenBits: 4,
    mythicBits: 8,
  };

  const difficultyForRun = (run) => CONFIG.baseDifficulty + Math.floor(run / 2);

  // Mirrors HashPrints.priceFor(): premium cools linearly, each extra bit halves it.
  function priceFor(elapsedSeconds, extraBits) {
    const floor = CONFIG.floorWei;
    const remaining = BigInt(Math.max(0, CONFIG.decaySeconds - Math.floor(elapsedSeconds)));
    let premium = (floor * BigInt(CONFIG.startMultiplier - 1) * remaining) / BigInt(CONFIG.decaySeconds);
    premium = extraBits >= 256 ? 0n : premium >> BigInt(extraBits);
    return floor + premium;
  }

  const formatEth = (wei) => {
    const s = (Number(wei) / 1e18).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return `${s} ETH`;
  };
  const formatUsd = (wei) => `$${((Number(wei) / 1e18) * CONFIG.ethUsdSnapshot).toFixed(2)}`;

  // abi.encode(address contract, address minter, uint256 nonce) — 96 bytes.
  function proofInput(contract, minter) {
    const buf = new Uint8Array(96);
    buf.set(fromHex(contract), 12);
    buf.set(fromHex(minter), 44);
    return buf;
  }
  function writeNonce(buf, nonce) {
    let n = BigInt(nonce);
    for (let i = 95; i >= 64; i--) { buf[i] = Number(n & 0xffn); n >>= 8n; }
  }
  function proofHash(contract, minter, nonce) {
    const buf = proofInput(contract, minter);
    writeNonce(buf, nonce);
    return toHex(keccak256(buf));
  }

  // Grind nonces until the proof has `difficulty` leading zero bits.
  // `onProgress(nonce, bestHashHex)` is called every `chunk` tries; return false to stop.
  // Hot loop: the 96-byte input fits one keccak block, so absorb it straight into a reused state.
  const bswap = (w) => ((w & 0xff) << 24) | ((w & 0xff00) << 8) | ((w >>> 8) & 0xff00) | (w >>> 24);
  async function grind({ contract, minter, difficulty, startNonce = 0, chunk = 20000, onProgress, aim = 0 }) {
    const view = new DataView(proofInput(contract, minter).buffer);
    const words = new Uint32Array(24);
    for (let i = 0; i < 24; i++) words[i] = view.getUint32(4 * i, true);
    const s = new Uint32Array(50);
    const hashOf = () => {
      const out = new Uint8Array(32);
      for (let i = 0; i < 8; i++) new DataView(out.buffer).setUint32(4 * i, s[i], true);
      return toHex(out);
    };
    let nonce = startNonce;
    let best = { bits: -1 };
    for (;;) {
      for (let i = 0; i < chunk; i++, nonce++) {
        s.fill(0);
        s.set(words);
        // Nonce is big-endian in bytes 88..95 (words 22, 23); 2^53 is plenty.
        s[22] = bswap(Math.floor(nonce / 4294967296));
        s[23] = bswap(nonce >>> 0);
        s[24] = 0x01;
        s[33] = 0x80000000;
        keccakF(s);
        // Leading zero bits, reading the digest big-endian word by word.
        let bits = 0;
        for (let w = 0; w < 8; w++) {
          const v = bswap(s[w]);
          if (v === 0) { bits += 32; continue; }
          bits += Math.clz32(v);
          break;
        }
        if (bits > best.bits) best = { bits, nonce, hash: hashOf() };
        if (bits >= difficulty + aim) return { nonce, hash: hashOf(), bits, extraBits: bits - difficulty };
      }
      if (onProgress && (await onProgress(nonce, best)) === false) return null;
    }
  }

  // ------------------------------------------------------------- the print
  const SIZE = 32;
  const RISO = {
    'Fluorescent Pink': '#ff48b0', Blue: '#0078bf', Yellow: '#ffe800', Teal: '#00838a',
    'Bright Red': '#f15060', Green: '#00a95c', Orange: '#ff6c2f', Purple: '#765ba7',
    'Federal Blue': '#3d5588', Mint: '#82d8d5',
  };
  const NEON = {
    Acid: '#c6ff00', Laser: '#00ff9c', Hotline: '#ff2bd6', Ice: '#7df9ff',
    Volt: '#fff36b', Siren: '#ff1a4b', Ultra: '#8a5cff', Ember: '#ff6a00',
  };
  const PRESSES = ['Circuit', 'Zigzag', 'Shards', 'Rain', 'Weave', 'Bloom'];
  const SYMMETRY = ['None', 'Mirror', 'Quad', 'Rotational'];

  function hexToRgb(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
  function rgbToHex(rgb) { return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''); }
  const multiply = (a, b) => rgbToHex(hexToRgb(a).map((v, i) => (v * hexToRgb(b)[i]) / 255));
  const screen = (a, b) => rgbToHex(hexToRgb(a).map((v, i) => 255 - ((255 - v) * (255 - hexToRgb(b)[i])) / 255));

  // sfc32 seeded from the hash's tail (the head is mostly the zeros you ground for).
  function prng(hex) {
    let [a, b, c, d] = [32, 40, 48, 56].map((i) => parseInt(hex.slice(i, i + 8), 16) >>> 0);
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

  // Palette slots: 0 paper, 1 ink A, 2 ink B, 3 key/accent, 4 overprint (A∩B), 5 grain.
  function render(seedHex, difficulty = 0) {
    const hex = seedHex.replace(/^0x/, '').toLowerCase();
    const rand = prng(hex);
    const ri = (n) => Math.floor(rand() * n);
    const pick = (arr) => arr[ri(arr.length)];
    const bits = leadingZeroBits(fromHex(hex));
    const extraBits = Math.max(0, bits - difficulty);
    const rarity = extraBits >= CONFIG.mythicBits ? 'Mythic' : extraBits >= CONFIG.goldenBits ? 'Golden' : 'Common';

    const edition = rand() < 0.6 ? 'Paper' : 'Night';
    let inkNames, palette;
    if (edition === 'Paper') {
      const names = Object.keys(RISO);
      const a = pick(names);
      let b = pick(names);
      while (b === a) b = pick(names);
      inkNames = [a, b];
      const [A, Bk] = [RISO[a], RISO[b]];
      palette = ['#f4f0e6', A, Bk, '#1b1b1b', multiply(A, Bk), '#d9d2c1'];
      if (rarity !== 'Common') {
        inkNames = [rarity === 'Mythic' ? 'Holo Foil' : 'Gold Leaf', b];
        const gold = rarity === 'Mythic' ? '#9b7bff' : '#c9a227';
        palette = ['#f4f0e6', gold, Bk, '#1b1b1b', multiply(gold, Bk), '#d9d2c1'];
      }
    } else {
      const names = Object.keys(NEON);
      const a = pick(names);
      let b = pick(names);
      while (b === a) b = pick(names);
      inkNames = [a, b];
      const [A, Bk] = [NEON[a], NEON[b]];
      palette = ['#0b0b10', A, Bk, '#ffffff', screen(A, Bk), '#1a1a24'];
      if (rarity !== 'Common') {
        inkNames = [rarity === 'Mythic' ? 'Holo Foil' : 'Gold Leaf', b];
        const gold = rarity === 'Mythic' ? '#b49cff' : '#ffd700';
        palette = ['#0b0700', gold, Bk, '#fff4b0', screen(gold, Bk), '#1d1608'];
      }
    }

    const press = pick(PRESSES);
    const symmetry = pick(SYMMETRY);
    const drift = [[0, 0], [0, 0], [1, 0], [0, 1], [1, 1], [-1, 1]][ri(6)];
    const registration = drift[0] || drift[1] ? `Drift ${drift[0] > 0 ? '→' : drift[0] < 0 ? '←' : ''}${drift[1] ? '↓' : ''}` : 'Tight';

    const grid = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
    // Plate area leaves a 2px margin and room for the colophon strip at the bottom.
    const X0 = 2, Y0 = 2, X1 = 29, Y1 = 27;
    let inked = 0;
    const put = (x, y, c) => {
      if (x < X0 || y < Y0 || x > X1 || y > Y1) return;
      const e = grid[y][x];
      if (!e || e === 5) inked++;
      if (c === 3 || e === 3) grid[y][x] = 3;
      else if ((e === 1 && c === 2) || (e === 2 && c === 1) || e === 4) grid[y][x] = 4;
      else grid[y][x] = c;
    };
    const plot = (x, y, c) => {
      if (c === 2) { x += drift[0]; y += drift[1]; } // second ink drum is slightly off register
      const pts = [[x, y]];
      const mx = X0 + X1 - x, my = Y0 + Y1 - y;
      if (symmetry === 'Mirror' || symmetry === 'Quad') pts.push([mx, y]);
      if (symmetry === 'Quad') pts.push([x, my], [mx, my]);
      if (symmetry === 'Rotational') pts.push([mx, my]);
      for (const [px, py] of pts) put(px, py, c);
    };
    const rx = () => X0 + ri(X1 - X0 + 1);
    const ry = () => Y0 + ri(Y1 - Y0 + 1);
    const line = (x0, y0, x1, y1, c, dash = 0) => {
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy, i = 0;
      for (;;) {
        if (!dash || i++ % dash !== dash - 1) plot(x0, y0, c);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    };
    const DIRS4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const DIRS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const walk = (dirs, turn, c) => {
      let x = rx(), y = ry(), d = ri(dirs.length);
      for (let i = 0, steps = 30 + ri(90); i < steps; i++) {
        plot(x, y, c);
        if (rand() < 0.14) {
          d = (d + (rand() < 0.5 ? turn : dirs.length - turn)) % dirs.length;
          plot(x, y, 3);
        }
        x += dirs[d][0]; y += dirs[d][1];
        if (x < X0 || y < Y0 || x > X1 || y > Y1) break;
      }
    };

    const strokes = 3 + ri(8);
    for (let s = 0; s < strokes; s++) {
      const ink = 1 + (s % 2);
      if (press === 'Circuit') walk(DIRS4, 1, ink);
      else if (press === 'Zigzag') walk(DIRS8, 1 + ri(2), ink);
      else if (press === 'Shards') {
        let x = rx(), y = ry();
        for (let k = 0, n = 2 + ri(3); k < n; k++) {
          const nx = rx(), ny = ry();
          line(x, y, nx, ny, ink);
          x = nx; y = ny;
        }
        plot(x, y, 3);
      } else if (press === 'Rain') {
        for (let k = 0; k < 4; k++) {
          const x = rx(), y0 = ry(), len = 4 + ri(16);
          for (let y = y0; y < Math.min(Y1 + 1, y0 + len); y++) if (rand() > 0.15) plot(x, y, ink);
          plot(x, Math.min(Y1, y0 + len), 3);
        }
      } else if (press === 'Weave') {
        // Ink A runs horizontally, ink B vertically; crossings overprint.
        for (let k = 0; k < 2; k++) {
          const pos = ink === 1 ? ry() : rx();
          const dash = 2 + ri(4);
          if (ink === 1) line(X0, pos, X1, pos, 1, dash);
          else line(pos, Y0, pos, Y1, 2, dash);
        }
      } else {
        // Bloom: rays from a shared centre out to the plate edge.
        const cx = 15, cy = 14;
        for (let k = 0; k < 3; k++) {
          const t = rand() * 4;
          const [ex, ey] = t < 1 ? [X0 + Math.floor(t * 28), Y0] : t < 2 ? [X1, Y0 + Math.floor((t - 1) * 26)]
            : t < 3 ? [X0 + Math.floor((t - 2) * 28), Y1] : [X0, Y0 + Math.floor((t - 3) * 26)];
          line(cx, cy, ex, ey, ink, rand() < 0.5 ? 0 : 3);
        }
        plot(cx, cy, 3);
      }
    }

    // Glitch: a few plate rows slip sideways in the press.
    const glitchBands = rand() < 0.35 ? 1 + ri(3) : 0;
    for (let g = 0; g < glitchBands; g++) {
      const y0 = ry(), h = 1 + ri(3), shift = 2 + ri(8);
      for (let y = y0; y < Math.min(Y1 + 1, y0 + h); y++) {
        const row = grid[y].slice(X0, X1 + 1);
        const moved = row.slice(shift).concat(row.slice(0, shift));
        grid[y].splice(X0, moved.length, ...moved);
      }
    }

    // Paper grain / night noise in the empty plate.
    for (let y = Y0; y <= Y1; y++)
      for (let x = X0; x <= X1; x++) if (!grid[y][x] && rand() < 0.04) grid[y][x] = 5;

    // Colophon: the print carries the first 28 bits after its zero-run as a barcode.
    const tail = BigInt('0x' + hex) << BigInt(bits + 1);
    for (let i = 0; i < 28; i++) {
      const bit = (tail >> BigInt(255 - i)) & 1n;
      grid[30][X0 + i] = bit ? 3 : 5;
    }
    // Proof-of-work tick marks: one per zero bit ground, top margin.
    for (let i = 0; i < Math.min(28, bits); i++) grid[0][X0 + i] = i < bits - extraBits ? 5 : 1;

    const traits = {
      Edition: edition,
      Press: press,
      Inks: inkNames.join(' × '),
      Symmetry: symmetry,
      Registration: registration,
      Strokes: strokes,
      Glitch: glitchBands ? `${glitchBands} slip${glitchBands > 1 ? 's' : ''}` : 'Clean',
      Coverage: Math.round((inked / ((X1 - X0 + 1) * (Y1 - Y0 + 1))) * 100) + '%',
      Work: `${bits} bits${difficulty ? ` (+${extraBits})` : ''}`,
      Rarity: rarity,
    };
    return { size: SIZE, grid, palette, traits };
  }

  function toSVG(art, scale = 12) {
    const px = art.size * scale;
    let rects = `<rect width="${px}" height="${px}" fill="${art.palette[0]}"/>`;
    art.grid.forEach((row, y) => row.forEach((c, x) => {
      if (c) rects += `<rect x="${x * scale}" y="${y * scale}" width="${scale}" height="${scale}" fill="${art.palette[c]}"/>`;
    }));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" shape-rendering="crispEdges">${rects}</svg>`;
  }

  const api = {
    CONFIG, keccak256, toHex, fromHex, leadingZeroBits, difficultyForRun, priceFor, formatEth, formatUsd,
    proofHash, grind, render, toSVG, SIZE, RISO, NEON, PRESSES,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HashPrints = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
