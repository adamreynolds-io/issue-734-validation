# Issue 734 Validation: `balanceUnsealedTransaction` hang for contract calls

Reproduces [adamreynolds-io/gsd-wallet#10](https://github.com/adamreynolds-io/gsd-wallet/issues/10) / [midnightntwrk/midnight-js#734](https://github.com/midnightntwrk/midnight-js/issues/734): `balanceUnsealedTransaction` hangs indefinitely when balancing contract call transactions via the DApp connector.

## Key Discovery

Reading the SDK source reveals that `submitCallTx` internally does:

```
createUnprovenCallTx -> proveTx -> balanceTx -> submitTx
```

This is **prove first, then balance** — the same order as the DApp connector flow. Since `submitCallTx` works in Node.js, the hang must be caused by either:

1. The **serialization/deserialization roundtrip** across the DApp connector boundary
2. The **browser/extension context** (Chrome service worker, message passing)

This suite isolates which by running the same flow with and without serialization.

## Quick Start

```bash
yarn install
docker compose up -d --wait
MIDNIGHT_NETWORK=local yarn test
docker compose down
```

**Prerequisites:** Node.js >= 22, Yarn 1.x, Docker (compose v2)

## Test Strategy

| Test | What it does | Expected |
|------|-------------|----------|
| deploy via submitCallTx | Control — deploys work everywhere | pass |
| mintAndReceive via submitCallTx | SDK path (in-process prove→balance) | pass |
| decomposed prove→balance in-process | Manual prove then balance, no serialization | pass |
| **serialization roundtrip** | prove→serialize→deserialize→balance (60s timeout) | **hang or pass** |
| post-serde wallet health check | Verify wallet still works after serde test | pass |

### Interpreting Results

**If test 4 hangs (times out at 60s):**
The serialization roundtrip causes the hang. The same `balanceTx` call works in-process (test 3) but fails after serialize→deserialize. This means the `Transaction.deserialize` output is subtly different from the original proven transaction object — possibly missing internal state that `balanceUnboundTransaction` depends on.

**If test 4 passes:**
The serialization roundtrip works in Node.js. The bug is specific to the browser/extension context — Chrome service worker lifecycle, DApp connector message passing, or the wallet's deserialization path in the browser bundle (which may differ from the Node.js path).

## DApp Connector Flow (What Hangs)

```
DApp                              Wallet (browser extension)
─────                             ──────────────────────────
1. Build call tx
2. proveTx (ZK proof, ~90s)
3. serialize to hex ──────────→   4. deserialize from hex
                                  5. balanceUnsealedTransaction ← HANGS
                                     (never resolves or rejects)
```

## SDK Flow (What Works)

```
submitCallTx (Node.js, in-process)
─────────────────────────────────
1. createUnprovenCallTx
2. proveTx (ZK proof)
3. balanceTx ← WORKS (same order as DApp connector)
4. submitTx
```

## Diagnostic Evidence from gsd-wallet#10

**Deploy (works):** balancing completes in 53ms
```
balanceUnsealed: balancing
balanceUnsealed: balanced            elapsed: 53ms
```

**Contract call (hangs):** balancing never returns
```
balanceUnsealed: balancing
... (never returns, service worker killed by Chrome ~30s later)
```

## Contract

Uses `token-transfers.compact` with `mintAndReceive` — the same circuit that triggers the hang in gsd-wallet#10. This circuit calls `mintUnshieldedToken()` to create a new custom-color token (pure unshielded operation, no shielded involvement).

## Stack Versions

```
@midnight-ntwrk/midnight-js-*: 4.0.2
@midnight-ntwrk/ledger-v8: 8.0.3
@midnight-ntwrk/compact-runtime: 0.15.0
@midnight-ntwrk/wallet-sdk-facade: 3.0.0
proof-server: 8.0.3
indexer-standalone: 4.0.0
midnight-node: 0.22.3
```

## Related Issues

- [adamreynolds-io/gsd-wallet#10](https://github.com/adamreynolds-io/gsd-wallet/issues/10) — GSD wallet issue with full diagnostics
- [midnightntwrk/midnight-js#734](https://github.com/midnightntwrk/midnight-js/issues/734) — Upstream: hang after Lace approval
- [midnightntwrk/midnight-js#731](https://github.com/midnightntwrk/midnight-js/issues/731) — Related: shielded+unshielded combo failure (different bug, produces errors not hang)
