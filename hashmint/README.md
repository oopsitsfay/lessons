# HashMint (experimental)

Proof-of-work pixel mints. Each mint is a tiny block; its SHA-256 hash seeds a 32×32 neon line drawing.

- **Mining:** search for a nonce so `sha256(index|prevHash|timestamp|minter|message|difficulty|nonce)` starts with *difficulty* zero hex digits.
- **Chain:** each block commits to the previous block's hash, so editing any block breaks verification.
- **Art:** the hash seeds a PRNG that picks a style (Circuit, Zigzag, Shards, Rain), a neon palette, a symmetry, a stroke count, and glitch bands. Pixel walkers then trace lines on the grid.
- **Rarity:** a hash with more leading zeros than the difficulty required comes out **Golden** (24K palette). Two or more extra zeros make it **Mythic**.

Nothing touches a real blockchain. It's all local.

## Browser

Open `index.html` directly. The ledger lives in localStorage. Each mint can be downloaded as a PNG or SVG, and the ledger can be exported or imported as JSON.

## CLI

```sh
node mint.js mint "gm frens" --minter fay --difficulty 4   # mine, print art in terminal, write out/*.svg
node mint.js show [index]                                  # re-render a block
node mint.js verify                                        # check hashes, links, work
node mint.js preview anything                              # art for sha256("anything"), no mining
```

The CLI ledger is `ledger.json`. Both front ends share `pixelmint.js`, so the same hash renders the same art in both.
