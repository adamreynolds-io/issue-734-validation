/**
 * gsd-wallet#10 / midnight-js#734 Validation
 *
 * Validates that balanceUnsealedTransaction hangs for contract call
 * transactions. The SDK's submitCallTx does prove->balance in-process
 * and works. The DApp connector serializes the proven tx across a
 * boundary then balances — this is where the hang occurs.
 *
 * Test strategy:
 * 1. Deploy via submitCallTx — control (matches gsd-wallet#10 deploy success)
 * 2. mintAndReceive via submitCallTx — SDK path works
 * 3. Decomposed: createUnprovenCallTx -> proveTx -> balanceTx (in-process)
 * 4. Serialization roundtrip: prove -> serialize -> deserialize -> balance
 *    with 60s timeout to detect hang (DApp connector simulation)
 *
 * Run: MIDNIGHT_NETWORK=local yarn test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  createUnprovenCallTx,
  deployContract,
  submitCallTx,
} from '@midnight-ntwrk/midnight-js-contracts';
import { Transaction } from '@midnight-ntwrk/ledger-v8';
import type { ContractAddress } from '@midnight-ntwrk/compact-runtime';
import pino from 'pino';
import * as Rx from 'rxjs';

import { getConfig } from '../config.js';
import { MidnightWalletProvider, syncWallet } from '../wallet.js';
import { buildProviders, type TokenTransferProviders } from '../providers.js';
import {
  CompiledTokenTransfersContract,
  zkConfigPath,
} from '../../contract/index.js';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';

// Required for GraphQL subscriptions in Node.js
// @ts-expect-error WebSocket global assignment for apollo
globalThis.WebSocket = WebSocket;

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
  console.error('Promise:', promise);
});

const LOCAL_DEV_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';

const MINT_AMOUNT = 1_000_000n;

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: { target: 'pino-pretty' },
});

function elapsed(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

async function timed<T>(
  label: string,
  fn: () => Promise<T>,
  heartbeatMs = 10_000,
): Promise<T> {
  const start = Date.now();
  logger.info(`[${label}] starting...`);
  const heartbeat = setInterval(() => {
    logger.info(`[${label}] still running... ${elapsed(start)} elapsed`);
  }, heartbeatMs);
  try {
    const result = await fn();
    logger.info(`[${label}] completed in ${elapsed(start)}`);
    return result;
  } catch (err) {
    logger.error(`[${label}] FAILED after ${elapsed(start)}: ${err}`);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

async function waitForService(
  name: string,
  url: string,
  opts: RequestInit,
  maxWaitMs = 180_000,
  intervalMs = 3_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status >= 200 && res.status < 400) {
        logger.info(`[health] ${name}: OK (${res.status}) in ${elapsed(start)}`);
        return;
      }
      logger.debug(`[health] ${name}: HTTP ${res.status}, retrying...`);
    } catch {
      logger.debug(
        `[health] ${name}: not ready (${elapsed(start)} elapsed), retrying...`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${name} not healthy after ${maxWaitMs / 1000}s`);
}

async function checkHealth(
  config: { proofServer: string; indexer: string },
): Promise<void> {
  await waitForService('proof-server', `${config.proofServer}/version`, {
    method: 'GET',
  });
  await waitForService('indexer', config.indexer, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ __typename }' }),
  });
  logger.info('[health] All services healthy');
}

function extractFullError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current) {
    if (current instanceof Error) {
      parts.push(`${current.constructor.name}: ${current.message}`);
      if (current.stack) parts.push(current.stack);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      current = (current as any).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join('\n--- cause ---\n');
}

/**
 * Race a promise against a timeout. Returns { result, timedOut }.
 */
async function withTimeout<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ result?: T; timedOut: boolean; elapsedMs: number }> {
  const start = Date.now();
  const timeout = new Promise<'TIMEOUT'>((resolve) =>
    setTimeout(() => resolve('TIMEOUT'), timeoutMs),
  );
  const outcome = await Promise.race([
    promise.then((r) => ({ tag: 'ok' as const, value: r })),
    timeout.then(() => ({ tag: 'timeout' as const })),
  ]);
  const elapsedMs = Date.now() - start;
  if (outcome.tag === 'timeout') {
    logger.warn(
      `[${label}] TIMED OUT after ${(elapsedMs / 1000).toFixed(1)}s`,
    );
    return { timedOut: true, elapsedMs };
  }
  logger.info(
    `[${label}] completed in ${(elapsedMs / 1000).toFixed(1)}s`,
  );
  return { result: outcome.value, timedOut: false, elapsedMs };
}

describe('gsd-wallet#10 / midnight-js#734: balanceUnsealedTransaction hang', () => {
  let wallet: MidnightWalletProvider;
  let providers: TokenTransferProviders;
  let contractAddress: ContractAddress;

  const config = getConfig();
  const seed = LOCAL_DEV_SEED;

  const BALANCE_TIMEOUT_MS = 60_000;

  beforeAll(async () => {
    logger.info('=== gsd-wallet#10 / midnight-js#734 Validation ===');
    logger.info(`Network: ${config.networkId}`);
    logger.info(`SDK: midnight-js 4.0.2, ledger-v8 8.0.3`);
    logger.info(`Mint amount: ${MINT_AMOUNT}`);
    logger.info(`Balance timeout: ${BALANCE_TIMEOUT_MS / 1000}s`);
    setNetworkId(config.networkId);

    await timed('health-check', () => checkHealth(config));

    const envConfig: EnvironmentConfiguration = {
      walletNetworkId: config.networkId,
      networkId: config.networkId,
      indexer: config.indexer,
      indexerWS: config.indexerWS,
      node: config.node,
      nodeWS: config.nodeWS,
      faucet: config.faucet,
      proofServer: config.proofServer,
    };

    wallet = await timed('wallet-build', () =>
      MidnightWalletProvider.build(logger, envConfig, seed),
    );
    await timed('wallet-start', () => wallet.start());
    await timed('wallet-sync', () =>
      syncWallet(logger, wallet.wallet, 600_000),
    );

    providers = buildProviders(wallet, zkConfigPath, config);
    logger.info('Providers initialized. Ready to test.');
  }, 15 * 60_000);

  afterAll(async () => {
    if (wallet) {
      logger.info('Stopping wallet...');
      await wallet.stop();
    }
  });

  it('log wallet state', async () => {
    const state = await Rx.firstValueFrom(wallet.wallet.state());
    logger.info('--- Wallet Balance Snapshot ---');
    logger.info(
      `Shielded progress: ${JSON.stringify(state.shielded.state.progress)}`,
    );
    logger.info(
      `Unshielded progress: ${JSON.stringify(state.unshielded.progress)}`,
    );
    logger.info(
      `Dust progress: ${JSON.stringify(state.dust.state.progress)}`,
    );
    logger.info('--- End Balance Snapshot ---');
  }, 60_000);

  // ── Test 1: Deploy via submitCallTx ──────────────────────────────
  // Control test. Deploys work in both SDK and DApp connector paths.
  // gsd-wallet#10 shows deploy balancing completes in 53ms.

  it('deploy via submitCallTx — control', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deployed: any = await timed('deploy', () =>
      (deployContract as any)(providers, {
        compiledContract: CompiledTokenTransfersContract,
      }),
    );

    contractAddress = deployed.deployTxData.public.contractAddress;
    logger.info(`Contract deployed at: ${contractAddress}`);
    expect(contractAddress).toBeDefined();
    expect(contractAddress.length).toBeGreaterThan(0);
  }, 10 * 60_000);

  // ── Test 2: mintAndReceive via submitCallTx ──────────────────────
  // SDK path: prove -> balance happens in-process inside submitCallTx.
  // This works. Proves the balancing logic itself is correct.

  it('mintAndReceive via submitCallTx — SDK path works', async () => {
    expect(contractAddress).toBeDefined();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txData: any = await timed('mintAndReceive-sdk', () =>
      (submitCallTx as any)(providers, {
        compiledContract: CompiledTokenTransfersContract,
        contractAddress,
        circuitId: 'mintAndReceive',
        args: [MINT_AMOUNT],
      }),
    );

    logger.info(`mintAndReceive (SDK): status=${txData.public.status}`);
    expect(txData.public.status).toBe('SucceedEntirely');
  }, 10 * 60_000);

  // ── Test 3: Decomposed prove -> balance (in-process) ────────────
  // Same flow as submitCallTx but manually decomposed:
  //   createUnprovenCallTx -> proveTx -> balanceTx
  // Confirms the balancing works when called separately in-process.

  it('decomposed prove -> balance in-process', async () => {
    expect(contractAddress).toBeDefined();

    // Step 1: Create unproven call transaction
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callData: any = await timed('createUnprovenCallTx', () =>
      (createUnprovenCallTx as any)(providers, {
        compiledContract: CompiledTokenTransfersContract,
        contractAddress,
        circuitId: 'mintAndReceive',
        args: [MINT_AMOUNT],
      }),
    );

    const unprovenTx = callData.private.unprovenTx;
    logger.info('Unproven tx created');
    logger.info(`Unproven tx toString:\n${unprovenTx.toString(true)}`);

    // Step 2: Prove
    const provenTx = await timed('proveTx', () =>
      providers.proofProvider.proveTx(unprovenTx),
    );
    logger.info('Transaction proven');
    logger.info(`Proven tx toString:\n${provenTx.toString(true)}`);

    // Step 3: Balance (in-process, no serialization)
    const finalized = await timed('balanceTx-inprocess', () =>
      wallet.balanceTx(provenTx),
    );

    expect(finalized).toBeDefined();
    logger.info('Decomposed prove -> balance: SUCCESS (in-process)');
  }, 10 * 60_000);

  // ── Test 4: Serialization roundtrip (DApp connector simulation) ─
  // The critical test. Simulates what the DApp connector does:
  //   prove -> serialize to hex -> deserialize -> balance
  // If this hangs, the serialization roundtrip is the culprit.
  // If this works, the bug is in the browser/extension context.

  it('serialization roundtrip — DApp connector simulation', async () => {
    expect(contractAddress).toBeDefined();

    // Step 1: Create unproven call transaction
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callData: any = await timed('createUnprovenCallTx-serde', () =>
      (createUnprovenCallTx as any)(providers, {
        compiledContract: CompiledTokenTransfersContract,
        contractAddress,
        circuitId: 'mintAndReceive',
        args: [MINT_AMOUNT],
      }),
    );
    const unprovenTx = callData.private.unprovenTx;

    // Step 2: Prove
    const provenTx = await timed('proveTx-serde', () =>
      providers.proofProvider.proveTx(unprovenTx),
    );

    // Step 3: Serialize (what the DApp does before sending to wallet)
    const serialized = provenTx.serialize();
    const hex = Buffer.from(serialized).toString('hex');
    logger.info(
      `Serialized proven tx: ${serialized.length} bytes, ${hex.length} hex chars`,
    );

    // Step 4: Deserialize (what the wallet does after receiving from DApp)
    // UnboundTransaction = Transaction<SignatureEnabled, Proof, PreBinding>
    // Marker values are string literals matching the instance property types
    const deserialized = Transaction.deserialize(
      'signature' as const,
      'proof' as const,
      'pre-binding' as const,
      new Uint8Array(serialized),
    );
    logger.info('Deserialized proven tx from bytes');
    logger.info(`Deserialized tx toString:\n${deserialized.toString(true)}`);

    // Step 5: Balance the deserialized tx (with timeout for hang detection)
    // This is exactly what the wallet's balanceUnsealedTransaction does
    // after deserializing the hex from the DApp connector.
    const balancePromise = wallet.balanceTx(deserialized);
    const { result, timedOut, elapsedMs } = await withTimeout(
      'balanceTx-after-serde',
      balancePromise,
      BALANCE_TIMEOUT_MS,
    );

    if (timedOut) {
      logger.error(
        `BUG REPRODUCED: balanceTx hung for ${(elapsedMs / 1000).toFixed(1)}s ` +
        `after serialization roundtrip. This matches gsd-wallet#10 / midnight-js#734.`,
      );
      logger.error(
        'The serialization roundtrip causes the hang — ' +
        'the same balance call works in-process (test 3).',
      );
      // Fail the test to record the hang
      expect.fail(
        `balanceTx hung for ${BALANCE_TIMEOUT_MS / 1000}s after ` +
        `serialization roundtrip (DApp connector simulation)`,
      );
    } else {
      logger.info(
        `balanceTx after serde: completed in ${(elapsedMs / 1000).toFixed(1)}s`,
      );
      logger.info(
        'Serialization roundtrip did NOT cause hang in Node.js. ' +
        'Bug is likely browser/extension-context-specific.',
      );
      expect(result).toBeDefined();
    }
  }, 10 * 60_000);

  // ── Test 5: Second mintAndReceive via submitCallTx ───────────────
  // Verifies the wallet is still healthy after the serialization test.
  // If test 4 timed out, the wallet may be in a bad state.

  it('post-serde mintAndReceive via submitCallTx — wallet health check', async () => {
    expect(contractAddress).toBeDefined();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txData: any = await timed('mintAndReceive-post-serde', () =>
      (submitCallTx as any)(providers, {
        compiledContract: CompiledTokenTransfersContract,
        contractAddress,
        circuitId: 'mintAndReceive',
        args: [MINT_AMOUNT],
      }),
    );

    logger.info(`mintAndReceive (post-serde): status=${txData.public.status}`);
    expect(txData.public.status).toBe('SucceedEntirely');
  }, 10 * 60_000);

  // ── Test 6: Concurrent state access during balance ──────────────
  // Simulates the browser environment where facade.state() subscription
  // and sync operations run concurrently with balancing.
  // The hypothesis: SubscriptionRef semaphore contention causes the hang.

  it('balance with concurrent state reads — contention simulation', async () => {
    expect(contractAddress).toBeDefined();

    // Simulate what the browser does: continuously read wallet state
    // while a balanceUnboundTransaction is in progress.
    // This creates contention on the SubscriptionRef semaphores.
    let stateReadCount = 0;
    const statePoller = setInterval(async () => {
      try {
        const state = await Rx.firstValueFrom(wallet.wallet.state());
        stateReadCount++;
        // Simulate the serialization work the browser does on each emission
        JSON.stringify({
          shielded: state.shielded.state.progress,
          unshielded: state.unshielded.progress,
          dust: state.dust.state.progress,
        });
      } catch {
        // Ignore errors during polling
      }
    }, 50); // Poll every 50ms — aggressive, simulating continuous subscription

    try {
      // Create, prove, serialize, deserialize — full DApp connector simulation
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callData: any = await timed('createUnprovenCallTx-contention', () =>
        (createUnprovenCallTx as any)(providers, {
          compiledContract: CompiledTokenTransfersContract,
          contractAddress,
          circuitId: 'mintAndReceive',
          args: [MINT_AMOUNT],
        }),
      );
      const unprovenTx = callData.private.unprovenTx;

      const provenTx = await timed('proveTx-contention', () =>
        providers.proofProvider.proveTx(unprovenTx),
      );

      const serialized = provenTx.serialize();
      const deserialized = Transaction.deserialize(
        'signature' as const,
        'proof' as const,
        'pre-binding' as const,
        new Uint8Array(serialized),
      );

      logger.info(
        `Starting balance with ${stateReadCount} concurrent state reads so far`,
      );

      // Balance with timeout — if contention causes hang, this will detect it
      const balancePromise = wallet.balanceTx(deserialized);
      const { result, timedOut, elapsedMs } = await withTimeout(
        'balanceTx-with-contention',
        balancePromise,
        BALANCE_TIMEOUT_MS,
      );

      logger.info(`Concurrent state reads during balance: ${stateReadCount}`);

      if (timedOut) {
        logger.error(
          `BUG REPRODUCED: balanceTx hung for ${(elapsedMs / 1000).toFixed(1)}s ` +
          `with concurrent state reads (${stateReadCount} reads). ` +
          `This confirms SubscriptionRef semaphore contention hypothesis.`,
        );
        expect.fail(
          `balanceTx hung for ${BALANCE_TIMEOUT_MS / 1000}s with concurrent ` +
          `state reads — semaphore contention (${stateReadCount} reads)`,
        );
      } else {
        logger.info(
          `balanceTx with contention: completed in ${(elapsedMs / 1000).toFixed(1)}s ` +
          `(${stateReadCount} concurrent reads). No hang — contention alone ` +
          `doesn't reproduce. Browser-specific scheduler behavior may be required.`,
        );
        expect(result).toBeDefined();
      }
    } finally {
      clearInterval(statePoller);
      logger.info(`Total state reads during test: ${stateReadCount}`);
    }
  }, 10 * 60_000);
});
