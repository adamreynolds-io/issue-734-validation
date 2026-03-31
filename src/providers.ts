import { type MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { type MidnightWalletProvider } from './wallet.js';
import { type NetworkConfig } from './config.js';

export type TokenTransferCircuits =
  | 'mintAndReceive'
  | 'sendToUser'
  | 'receiveTokens'
  | 'receiveNightTokens'
  | 'sendNightTokensToUser'
  | 'receiveShieldedTokens'
  | 'sendShieldedToUser'
  | 'mintShieldedToSelf'
  | 'mintAndSendShielded';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TokenTransferProviders = MidnightProviders<any>;

export function buildProviders(
  wallet: MidnightWalletProvider,
  zkConfigPath: string,
  config: NetworkConfig,
): TokenTransferProviders {
  const zkConfigProvider = new NodeZkConfigProvider<TokenTransferCircuits>(zkConfigPath);

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `issue-734-${Date.now()}`,
      privateStoragePasswordProvider: () => 'Issue-734-Validation-1!',
      accountId: wallet.getCoinPublicKey(),
    }),
    publicDataProvider: indexerPublicDataProvider(
      config.indexer,
      config.indexerWS,
    ),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(
      config.proofServer,
      zkConfigProvider,
    ),
    walletProvider: wallet,
    midnightProvider: wallet,
  };
}
