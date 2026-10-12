# HashPrints (experimental)

3,333 pixel prints pressed from proof-of-work on Ethereum. You grind for a hash, the hash becomes the plate, and the more work you put in the less you pay.

**Status:** tested and internally reviewed (see [SECURITY.md](SECURITY.md)), **not deployed and not professionally audited**. The website runs the mint as a simulation.

Live site: https://hashprints.vercel.app

## Mint

| | |
|---|---|
| Supply | 3,333 = 10 runs × 333 public + 3 artist proofs (ids 1–3) |
| Price | flat 0.000315 ETH (≈ $0.80 at ETH ≈ $2,540, Oct 12 2026), gas paid by the minter |
| Limit | 2 public mints per wallet |
| Work | `keccak256(abi.encode(contract, wallet, nonce))` needs ≥ 16 leading zero bits, +1 bit every two runs (up to 20) |
| Rarity | +4 extra bits = Gold Leaf, +8 = Holo Foil. Extra bits never change the price. |
| Gas | ≈ 124k per mint |

The supply shape is a constructor argument, so the same contract also deploys **Test HashPrint** (10 tokens, 2 runs × 5, no artist proofs) for a small live run before the main mint.

## Layout

- `contracts/HashPrints.sol`: ERC-721 (OpenZeppelin 5) with the press built in.
- `site/hashprints.js`: shared core with keccak256, the hash search, collection configs and the print renderer. It mirrors the contract exactly.
- `site/index.html`, `site/app.js`, `site/grind-worker.js`: the website and simulator.
- `site/print.html`: single-print viewer, used as each token's `external_url`.
- `site/admin.html`, `site/admin.js`: owner dashboard. Connect a wallet to deploy, open minting, test-mint, withdraw, lock metadata and transfer ownership.
- `site/contract/`: compiled ABI + bytecode the admin page deploys, and the standard JSON input for Etherscan verification (`npm run export` regenerates both).
- `site/api/meta/[id].js`, `site/api/test/meta/[id].js`, `site/api/image.js`: stateless metadata and SVG endpoints (Vercel functions).
- `contracts/test/AttackMinter.sol`: test-only hostile minter for the re-entrancy tests.
- `test/HashPrints.test.js`: contract tests, which also check that the JS hash and price maths match the contract.

## Develop

```sh
npm install
npm test            # contract tests (~30 s)
npm run export      # rebuild site/contract/ after changing the contract
npm run serve       # website at http://localhost:8080
```

## Running a mint (admin page)

Open `/admin.html` and connect the wallet that should own the contract.

1. Pick a preset (Test HashPrint or HashPrints), check the fields, then click **Estimate cost** and **Deploy**.
2. Verify the source on Etherscan using the values in the *Verify* panel.
3. **Open minting**. The price is locked from this point.
4. **Find hash and mint** runs a real mint from your wallet. Check the token on a marketplace, then **Lock base URI**.
5. **Withdraw** sends the mint revenue (the contract balance) to any address. It defaults to the owner wallet.

Owner-only actions are enforced by the contract. The page itself holds no keys.

## Metadata

`tokenURI(id)` returns `<baseURI><id>?seed=<on-chain seed>&d=<difficulty>`. With the base URI set to `https://hashprints.vercel.app/api/meta/`, the API renders the name, traits and an SVG image from the seed alone, with no chain reads and no database. Call `lockBaseURI()` once it's verified to freeze it for good.

Hardhat uses the solc-js compiler bundled in `node_modules` (see `hardhat.config.js`), so no compiler download is needed.
