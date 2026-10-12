#!/usr/bin/env node
// Usage:
//   node mint.js mint "gm world" [--minter alice] [--difficulty 4]
//   node mint.js show [index]
//   node mint.js verify
//   node mint.js preview <any text>     (render art for an arbitrary hash, no mining)
const fs = require('fs');
const path = require('path');
const PM = require('./pixelmint');

const LEDGER = path.join(__dirname, 'ledger.json');
const OUT = path.join(__dirname, 'out');

const loadChain = () => (fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : []);
const saveChain = (chain) => fs.writeFileSync(LEDGER, JSON.stringify(chain, null, 2) + '\n');

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
}

// Render two pixel rows per terminal line using the upper-half-block glyph.
function hslToRgb(str) {
  const [h, s, l] = str.match(/[\d.]+/g).map(Number);
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}
const toRgb = (c) => (c.startsWith('#') ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : hslToRgb(c));

function printArt(art) {
  const colors = art.palette.map(toRgb);
  for (let y = 0; y < art.size; y += 2) {
    let line = '  ';
    for (let x = 0; x < art.size; x++) {
      const [tr, tg, tb] = colors[art.grid[y][x]];
      const [br, bg, bb] = colors[art.grid[y + 1][x]];
      line += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m▀▀`;
    }
    console.log(line + '\x1b[0m');
  }
}

function describe(block) {
  const art = PM.generate(block.hash, block.difficulty);
  console.log(`\n#${block.index}  "${block.message}"  by ${block.minter}`);
  console.log(`hash   ${block.hash}`);
  console.log(`nonce  ${block.nonce}   difficulty ${block.difficulty}`);
  console.log(`traits ${Object.entries(art.traits).map(([k, v]) => `${k}=${v}`).join('  ')}\n`);
  printArt(art);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${String(block.index).padStart(4, '0')}-${block.hash.slice(0, 8)}.svg`);
  fs.writeFileSync(file, PM.toSVG(art));
  console.log(`\nsvg    ${path.relative(process.cwd(), file)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  const chain = loadChain();

  if (cmd === 'mint') {
    const minter = flag(args, 'minter', process.env.USER || 'anon');
    const difficulty = Number(flag(args, 'difficulty', 4));
    const message = args.join(' ') || 'untitled';
    const draft = PM.nextDraft(chain, minter, message, difficulty);
    const t0 = Date.now();
    const block = await PM.mine(draft, {
      onProgress: (n) => process.stdout.write(`\rmining… ${n.toLocaleString()} hashes`),
    });
    process.stdout.write(`\rmined in ${((Date.now() - t0) / 1000).toFixed(2)}s after ${(block.nonce + 1).toLocaleString()} hashes\n`);
    chain.push(block);
    saveChain(chain);
    describe(block);
  } else if (cmd === 'show') {
    const idx = args[0] === undefined ? chain.length - 1 : Number(args[0]);
    if (!chain[idx]) return console.error('no such block');
    describe(chain[idx]);
  } else if (cmd === 'verify') {
    const res = await PM.verifyChain(chain);
    console.log(res.ok ? `✔ chain valid (${chain.length} blocks)` : `✘ block #${res.at}: ${res.reason}`);
    process.exitCode = res.ok ? 0 : 1;
  } else if (cmd === 'preview') {
    const hash = await PM.sha256Hex(args.join(' '));
    console.log(`hash ${hash}`);
    const art = PM.generate(hash);
    console.log(art.traits);
    printArt(art);
  } else {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 7).join('\n').replace(/^\/\/ ?/gm, ''));
  }
}

main();
