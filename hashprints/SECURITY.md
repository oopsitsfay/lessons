# HashPrints security review

**Scope:** `contracts/HashPrints.sol`, plus the metadata API in `site/api/`.
**Type:** internal review: manual reading, an adversarial test suite, and Slither static analysis.
**This is not a professional audit.** Before real money goes in, an independent auditor should review the contract.

## Summary

No critical or high-severity issues were found. The contract follows checks-effects-interactions, enforces supply and per-wallet limits with tests behind them, and binds every proof to the wallet that ground it. The remaining items are design trade-offs and launch-day operational notes.

## What was checked

| Area | Result | Evidence |
|---|---|---|
| Supply cap (3,330 public + 3 A/P = 3,333, ids 1–3,333 unique) | ✅ | `SoldOut` checks; sellout test presses two full runs |
| Max 2 per wallet, including via re-entrancy | ✅ | count updated before `_safeMint`; `AttackMinter` test re-enters for a 3rd print and the tx reverts |
| Same proof pressed twice | ✅ | wallet slot stores first seed; tested directly and via re-entry; A/P loop check tested |
| Proof theft from the mempool | ✅ | `keccak256(contract, msg.sender, nonce)`, so another address gets a different hash (tested) |
| Price maths / Dutch curve | ✅ | contract matches JS model at 6 timestamps × 5 extra-bit values; no overflow (`uint128` floor × 3 × 1,980) |
| Refunds | ✅ | exact overpayment returned (balance-checked test); a reverting receiver only blocks its own tx |
| Re-entrancy | ✅ | all state written before `_safeMint` and the refund call; tested with a hostile receiver |
| Access control | ✅ | owner-only admin functions tested against a non-owner; `Ownable2Step` prevents mistyped transfers |
| Floor price changes | ✅ | only before `openPress()`; emits `FloorPriceSet` |
| Metadata swap | ✅ | `lockBaseURI()` freezes it permanently (tested) |
| Withdraw | ✅ | owner-only, zero-address check |
| Storage packing | ✅ | `uint16 pressed` (max 3,330), `uint8` A/P (max 3), `uint64` timestamp; seeds keep ≥16 zero bits, so the wallet count in the top 8 bits never collides |

## Findings and notes

1. **Run-boundary race (Low, UX).** When a run sells out, the price jumps back to 4× and the difficulty may rise. A transaction sent at the old price can then revert with `Underpaid` or `InsufficientWork`, and the sender pays gas for the failed transaction. *Mitigation:* the mint UI should send the 4× price (the excess is refunded in the same transaction), and near a boundary it should grind one extra bit.
2. **Validator timestamp drift (Informational).** Validators can shift `block.timestamp` by a few seconds. Over a 33-minute decay, 12 seconds moves the price by about 1.8% of the floor. Accepted.
3. **Sybil wallets (Informational, by design).** The 2-per-wallet limit applies per address. Each extra wallet needs its own grind, but nothing on-chain can stop one person from using many wallets. This is documented on the site.
4. **Fast hardware (Informational, by design).** GPUs grind far faster than browsers, so they can reach Gold Leaf or skip the Dutch premium cheaply. That's the "work as currency" experiment, and it's documented.
5. **Cross-chain proofs (Informational).** The proof doesn't include `chainid`, but it does include the contract address. If the same address were deployed on two chains, a proof would be valid on both, which only produces separate collections. Harmless.
6. **Centralisation (Informational).** Until `lockBaseURI()` is called, the owner can change the metadata URL. The owner can withdraw funds at any time. *Recommendation:* make the owner a multisig, and lock the base URI after launch.
7. **No royalties (Informational).** ERC-2981 isn't implemented. Add it if royalties are wanted.

## Slither

`slither . --hardhat-ignore-compile --filter-paths "node_modules|contracts/test"` (Slither 0.11.6, 102 detectors): 9 results, no high or medium findings. These detectors fire, and all are expected:

- `timestamp`: the Dutch auction uses `block.timestamp` by design (see note 2).
- `incorrect-equality`: `runStartedAt == 0` is the "press not open" marker, and `pressed % RUN_SIZE == 0` detects a run boundary. Both are exact counters, not balances.
- `weak-prng`: false positive. The `%` above is a run counter, not randomness.
- `low-level-calls`: `.call` for the refund and for `withdraw` is deliberate (it forwards gas to smart-contract wallets). Both check the return value and are tested.

Both actionable suggestions were applied: an event on `setFloorPrice`, and a zero-address check on `withdraw`.

## Metadata API

`/api/meta/:id` and `/api/image` are stateless. They render from the `seed` and `d` in the URL that the contract's `tokenURI` builds from chain state, and they reject seeds without enough zero bits or difficulties outside 16–20. Anyone can make the API draw an arbitrary valid seed, but marketplaces only follow the URL from `tokenURI`, so this can't misrepresent a real token.

## Before mainnet

- [ ] Independent professional audit
- [ ] Deploy from, or transfer ownership to, a multisig
- [ ] `setBaseURI("https://hashprints.vercel.app/api/meta/")`, check one token on a marketplace testnet, then `lockBaseURI()`
- [ ] Re-check the ETH/USD price and `setFloorPrice` before `openPress()`
- [ ] Build a mint UI that sends the 4× price and handles run boundaries (note 1)
