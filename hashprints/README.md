# HashPrints (experimental)

3,333 pixel prints pressed from proof-of-work on Ethereum. You grind for a hash, the hash becomes the plate, and the more work you put in the less you pay.

**Status:** the contract is written and tested but **not deployed and not audited**. The website runs the mint as a simulation.

## The mint: Grind → Press → Pull

| | |
|---|---|
| Supply | 3,333 = 10 runs × 333 public + 3 artist proofs (ids 1–3) |
| Floor | 0.000315 ETH (≈ $0.80 at ETH ≈ $2,540, Oct 12 2026) |
| Limit | 2 public prints per wallet |
| Work | `keccak256(abi.encode(contract, wallet, nonce))` needs ≥ 16 leading zero bits, +1 bit every two runs (up to 20) |
| Price | each run opens at 4× floor and cools linearly to floor over 33 min; **each extra zero bit halves the premium** |
| Rarity | +4 extra bits = Gold Leaf, +8 = Holo Foil |
| Gas | ≈ 198k per press |

When a run sells out, the next one opens hot at 4× again.

## Layout

- `contracts/HashPrints.sol`: ERC-721 (OpenZeppelin 5) with the press built in.
- `site/hashprints.js`: shared core with keccak256, grind, Dutch pricing and the print renderer. It mirrors the contract exactly.
- `site/index.html`, `site/app.js`, `site/grind-worker.js`: the website and simulator.
- `test/HashPrints.test.js`: contract tests, which also check that the JS hash and price maths match the contract.

## Develop

```sh
npm install
npm test            # fast suite (~10 s)
npm run test:slow   # + sells out two full runs with real grinding (~5 min)
npm run serve       # website at http://localhost:8080
```

Hardhat uses the solc-js compiler bundled in `node_modules` (see `hardhat.config.js`), so no compiler download is needed.
