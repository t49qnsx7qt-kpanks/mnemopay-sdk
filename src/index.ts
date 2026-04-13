// @mnemopay/mobile-sdk — on-device Memory + AgentPay + GridStamp
// USD_CENTS only. Ed25519 + AES-256-GCM. SQLite + sqlite-vec.

export { MnemoPay } from './core/sdk';

// Types
export type {
  Memory, MemoryMetadata, MemoryQuery, MemoryRecallResult,
  AgentWallet, Transaction, EscrowContract, EscrowCondition,
  SpatialProof, SpatialProofResult,
  MnemoPayConfig, SecurityContext, Permission,
  FraudSignal, FraudType,
  EmbeddingBackend, EmbeddingFn,
} from './types/index';

// Security primitives
export { PlatformCrypto, NodeCrypto, generateId } from './security/crypto';
export { PermissionGuard, SecurityError, buildContext } from './security/permissions';
export { RateLimiter } from './security/rate-limiter';
export { FraudDetector } from './security/fraud-detector';

// Subsystems (for advanced use / testing)
export { MemoryStore } from './memory/store';
export { WalletEngine } from './payments/wallet';
export { SpatialProver } from './gridstamp/spatial-prover';
export { EncryptedSync } from './sync/encrypted-sync';

// Platform bridges
export {
  embedHash, embed, createAsyncEmbedder, SEMANTIC_EMBEDDING_DIM,
} from './memory/embeddings';
export {
  NodeBridge, AndroidBridge, IOSBridge,
} from './platform/index';
export type { PlatformBridge, DeviceInfo, DeviceAttestation } from './platform/index';
