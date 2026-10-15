# HashPrints security review

**Scope:** `contracts/HashPrints.sol`, plus the metadata API in `site/api/`.
**Type:** internal review: manual reading, an adversarial test suite, and Slither static analysis.
**This is not a professional audit.** Before real money goes in, an independent auditor should review the contract.

## Summary

No critical or high-severity issues were found. The contract follows checks-effects-interactions, enforces supply and per-wallet limits with tests behind them, and binds every proof to the wallet that ground it. The remaining items are design trade-offs and launch-day operational notes.

## What was checked

| Area | Result | Evidence |
|---|---|---|
| Supply cap (set at deploy: 3,333 main, 10 test) | ✅ | `SoldOut` checks; Test HashPrint shape sold out fully in tests; bad shapes rejected with `BadConfig` |
| Max 2 per wallet, including via re-entrancy | ✅ | count updated before `_safeMint`; `AttackMinter` test re-enters for a 3rd print and the tx reverts |
| Same proof pressed twice | ✅ | wallet slot stores first seed; tested directly and via re-entry; A/P loop check tested |
| Proof theft from the mempool | ✅ | `keccak256(contract, msg.sender, nonce)`, so another address gets a different hash (tested) |
| Payment | ✅ | exactly `price()` or `WrongPayment` (tested at 0, ±1 wei, 4×); no refunds, so no refund path to attack |
| Re-entrancy | ✅ | all state written before `_safeMint`, the only external call in `press`; tested with a hostile receiver |
| Access control | ✅ | owner-only admin functions tested against a non-owner; `Ownable2Step` prevents mistyped transfers |
| Price changes | ✅ | only before `openPress()`; emits `PriceSet` |
| Metadata swap | ✅ | `lockBaseURI()` freezes it permanently (tested) |
| Withdraw | ✅ | owner-only, zero-address check |
| Storage packing | ✅ | `uint16 pressed` (max 3,330), `uint8` A/P (max 3), `uint64` timestamp; seeds keep ≥16 zero bits, so the wallet count in the top 8 bits never collides |

## Findings and notes

1. **Run-boundary race (Low, UX).** When a run sells out, the difficulty may rise by a bit. A transaction found at the old difficulty can then revert with `InsufficientWork`, and the sender pays gas for the failed transaction. *Mitigation:* near a boundary, the mint UI should search for one extra bit.
2. **Fixed ETH price (Informational).** The price is set in ETH and locked when minting opens, so its dollar value moves with the market.
3. **Sybil wallets (Informational, by design).** The 2-per-wallet limit applies per address. Each extra wallet needs its own grind, but nothing on-chain can stop one person from using many wallets. This is documented on the site.
4. **Fast hardware (Informational, by design).** GPUs grind far faster than browsers, so they reach Gold Leaf more easily. Price is unaffected.
5. **Cross-chain proofs (Informational).** The proof doesn't include `chainid`, but it does include the contract address. If the same address were deployed on two chains, a proof would be valid on both, which only produces separate collections. Harmless.
6. **Centralisation (Informational).** Until `lockBaseURI()` is called, the owner can change the metadata URL. The owner can withdraw funds at any time. *Recommendation:* make the owner a multisig, and lock the base URI after launch.
7. **No royalties (Informational).** ERC-2981 isn't implemented. Add it if royalties are wanted.

## Slither

`slither . --hardhat-ignore-compile --filter-paths "node_modules|contracts/test"` (Slither 0.11.6, 102 detectors): 9 results, no high or medium findings. These detectors fire, and all are expected:

- `timestamp`: `openedAt` records when minting opened. It isn't used for pricing.
- `incorrect-equality`: `openedAt == 0` is the "not open" marker, and `pressed % RUN_SIZE == 0` detects a run boundary. Both are exact counters, not balances.
- `weak-prng`: false positive. The `%` above is a run counter, not randomness.
- `naming-convention`: `RUN_SIZE`, `RUNS`, `ARTIST_PROOFS` and `MAX_SUPPLY` are deploy-time immutables, written in constant style. Style only.
- `low-level-calls`: `.call` in `withdraw` is deliberate (it forwards gas to smart-contract wallets). It checks the return value and is tested.

Both actionable suggestions were applied: an event on `setPrice`, and a zero-address check on `withdraw`.

## Metadata API

`/api/meta/:id` and `/api/image` are stateless. They render from the `seed` and `d` in the URL that the contract's `tokenURI` builds from chain state, and they reject seeds without enough zero bits or difficulties outside 16–20. Anyone can make the API draw an arbitrary valid seed, but marketplaces only follow the URL from `tokenURI`, so this can't misrepresent a real token.

## Market

The market adds no contract. Trades settle on Seaport 1.6, and the site's part is limited to storing signed orders and building transactions in the browser.

- **What people sign:** a seller signs "one HashPrint for X ETH, minus the 8% creator fee"; a buyer signs "X WETH for this print (or any print), with the 8% creator fee paid out of it". No zone, no conduit, a set end date (at most 180 days). The page shows the full split before anything is signed.
- **What the API accepts:** `api/market.js` rejects any order that doesn't have exactly that shape and those fees, then checks on chain (ownership or WETH balance and approval, counter, not cancelled or filled) and lets Seaport check the signature with a read-only `validate`. Someone else's signature, a changed price, a missing or smaller fee and offers in other tokens are refused (covered by `scripts/market-e2e.js`).
- **Accepting offers:** the owner's side is an order built in their own browser and sent by them, so Seaport doesn't need a signature for it. It asks for exactly the offer minus its fee items, so the match only goes through if every amount lines up.
- **What the store can't do:** a stored order can only ever be filled on its signer's terms. Deleting or altering the Blob store can hide orders but can't move a print or redirect a payment, because Seaport checks every signed field.
- **Cancelling:** removing an order from the site isn't enough, since anyone who saw it can still fill it. Cancel is always on chain (`cancel` for one order, `incrementCounter` for all of a wallet's orders), and the pages only offer that. "Change price" cancels the old listing first.
- **Approvals:** `setApprovalForAll(Seaport)` and WETH `approve(Seaport)` let Seaport move a wallet's prints or WETH only when one of that wallet's own signed orders is filled. They're the same approvals OpenSea asks for.
- **Abuse limits:** request bodies are capped at 20 KB, and a wallet can hold at most 25 open offers per collection.

## Protecting collectors from scams

- **No secrets, ever.** No page has a field for, or asks for, a recovery phrase, private key or password. Every public page says so next to the official contract address, and that HashPrints never messages people first.
- **Nothing blind to sign.** The site never uses `eth_sign`. Wallet requests are plain transactions to known contracts, Seaport orders shown field by field in the wallet (EIP-712), and the admin's plain-text sign-in.
- **Approvals are narrow.** `setApprovalForAll` is only ever requested for Seaport 1.6, and WETH approvals are capped at what an offer needs (current allowance + offer), never unlimited.
- **The page doesn't trust the server about contracts.** `market.js` pins Seaport and WETH, and requires the collection to match `mint-config.json`. If the API ever returned anything else (a compromised server or storage), trading pauses on the page. Every listing and offer is re-checked in the browser with the same rules the server uses (shape, exact fees, price), so a tampered order with a missing or redirected fee is dropped before anyone can sign or pay. Tested by feeding the page tampered responses.
- **Fake tokens can't be traded here.** Only the official HashPrints contract can be listed, offers must be in real WETH, and orders in any other token are refused by the API and the page. Sales in unknown tokens are labelled and left out of the volume.
- **No injected code.** A strict Content-Security-Policy allows scripts only from the site itself (no inline scripts, no third-party scripts, no eval). The site can't be framed by another page (clickjacking), and `/.well-known/security.txt` says where to report problems.

## Before mainnet

- [ ] Independent professional audit
- [ ] Deploy from, or transfer ownership to, a multisig
- [ ] `setBaseURI("https://hashprints.vercel.app/api/meta/")`, check one token on a marketplace testnet, then `lockBaseURI()`
- [ ] Run Test HashPrint end to end on mainnet from `/admin.html`
- [ ] Re-check the ETH/USD price and `setPrice` before `openPress()`
