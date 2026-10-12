# HashPrints (experimental)

3,333 pixel prints pressed from proof-of-work on Ethereum. You grind for a hash, the hash becomes the plate, and the more work you put in the less you pay.

**Status:** tested and internally reviewed (see [SECURITY.md](SECURITY.md)), **not deployed and not professionally audited**. The website runs the mint as a simulation.

Live site: https://hashprints.vercel.app

## The mint: Grind → Press → Pull

| | |
|---|---|
| Supply | 3,333 = 10 runs × 333 public + 3 artist proofs (ids 1–3) |
| Floor | 0.000315 ETH (≈ $0.80 at ETH ≈ $2,540, Oct 12 2026) |
| Limit | 2 public prints per wallet |
| Work | `keccak256(abi.encode(contract, wallet, nonce))` needs ≥ 16 leading zero bits, +1 bit every two runs (up to 20) |
| Price | each run opens at 4× floor and cools linearly to floor over 33 min; **each extra zero bit halves the premium** |
| Rarity | +4 extra bits = Gold Leaf, +8 = Holo Foil |
| Gas | ≈ 133k per press (packed storage) |

When a run sells out, the next one opens hot at 4× again.

## Layout

- `contracts/HashPrints.sol`: ERC-721 (OpenZeppelin 5) with the press built in.
- `site/hashprints.js`: shared core with keccak256, grind, Dutch pricing and the print renderer. It mirrors the contract exactly.
- `site/index.html`, `site/app.js`, `site/grind-worker.js`: the website and simulator.
- `site/print.html`: single-print viewer, used as each token's `external_url`.
- `site/api/meta/[id].js`, `site/api/image.js`: stateless metadata and SVG endpoints (Vercel functions).
- `contracts/test/AttackMinter.sol`: test-only hostile minter for the re-entrancy and refund tests.
- `test/HashPrints.test.js`: contract tests, which also check that the JS hash and price maths match the contract.

## Develop

```sh
npm install
npm test            # fast suite (~10 s)
npm run test:slow   # + sells out two full runs with real grinding (~5 min)
npm run serve       # website at http://localhost:8080
```

## Metadata

`tokenURI(id)` returns `<baseURI><id>?seed=<on-chain seed>&d=<difficulty>`. With the base URI set to `https://hashprints.vercel.app/api/meta/`, the API renders the name, traits and an SVG image from the seed alone, with no chain reads and no database. Call `lockBaseURI()` once it's verified to freeze it for good.

Hardhat uses the solc-js compiler bundled in `node_modules` (see `hardhat.config.js`), so no compiler download is needed.
