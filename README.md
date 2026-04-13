# MnemoPay Mobile SDK

On-device persistent memory (encrypted SQLite + `sqlite-vec`), agent-to-agent payments, and spatial proofs. TypeScript / Node 20+.

## Development

```bash
npm ci
npm run lint    # tsc --noEmit
npm test        # unit tests (excludes tests/benchmarks/)
npm run build   # emits dist/
```

## Crypto keys and migration

`MnemoPay.create()` wires `NodeCrypto` with:

- **`encryptionKey`** — AES-GCM; defaults to `SHA256("mnemopay:" + agentId)` when omitted.
- **`hmacKey`** — memory integrity HMAC; defaults to `SHA256("mnemopay:mac:" + agentId)`.
- **`signingKey`** — Ed25519 seed; defaults to `SHA256("mnemopay:sign:" + agentId)`.

Older builds only fixed the encryption key and drew **random** HMAC/signing material per process. That broke cross-device sync and manifest signatures. If you open an existing database after upgrading:

- **Same device, same code**: keys are now deterministic per `agentId`, so behavior is stable.
- **Existing rows** written under random HMAC keys may **fail integrity verification** on recall unless you still have the old keys. For production, set `encryptionKey`, `hmacKey`, and `signingKey` explicitly and store them in the platform keystore.

See `MnemoPayConfig` in `src/types/index.ts` for optional overrides.

## Memory embeddings

`MemoryStore` / `EncryptedSync` use one async embedder, configured on `MnemoPayConfig`:

| Option | Behavior |
|--------|----------|
| *(default)* | **Hash** — `embedHash()` (SHA-256 expanded + L2 normalize). Fast, deterministic, not semantic. |
| `embeddings: 'semantic'` | **Xenova** [`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2) via ONNX Runtime (384-d, mean pooling, normalized). Requires optional peer **`@xenova/transformers`**. Also set `embeddingDimensions: 384` (default). |
| `embed: (text, dim) => …` | **Custom** — sync or async; overrides `embeddings`. Vector length must match `dim` / `memory_vectors` (384). |

Install semantic backend when you need it:

```bash
npm install @xenova/transformers
```

```typescript
MnemoPay.create({
  agentId: 'agent-1',
  embeddings: 'semantic',
  embeddingDimensions: 384,
});
```

## LongMem eval (memory scale + recall)

```bash
npm run eval:longmem              # default hash embeddings
npm run eval:longmem:semantic     # same benchmark with Xenova MiniLM (peer dep installed)
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `LONGMEM_N` | `200` | How many memories to retain |
| `LONGMEM_SAMPLES` | scales with N | How many query points (spread across indices) |
| `LONGMEM_RECALL_LIMIT` | scales with N | `recall({ limit })`; sqlite-vec uses `k ≈ limit × 3` internally |
| `LONGMEM_EMBEDDINGS` | *(unset)* | Set to `semantic` to match `eval:longmem:semantic` |

Examples:

```bash
LONGMEM_N=1000 npm run eval:longmem
LONGMEM_N=5000 LONGMEM_SAMPLES=64 LONGMEM_RECALL_LIMIT=60 npm run eval:longmem
```

The benchmark resets the in-process memory write rate limiter every 200 retains so `LONGMEM_N=5000` can finish in one run. Production apps still enforce normal limits.

The eval prints two JSON blocks:

1. **exact query** — recall text identical to the stored line. With **hash** embeds this stays near **100%** hit@3 at large N unless `k` is too small; with **semantic** embeds it should also stay very high for identical strings.
2. **paraphrase query** — natural-language question referencing the fact index **without** copying the stored string. **Hash** embeds yield near-zero hit@5/hit@15; **semantic** embeds should improve this materially (run `npm run eval:longmem:semantic` to measure).

**Observed locally (hash, default `LONGMEM_RECALL_LIMIT`):** exact **hit@3 = 1.0** for `LONGMEM_N` through 5000; paraphrase **hit@5 ≈ 0** (occasional hit@15). Raise `LONGMEM_RECALL_LIMIT` if exact recall starts missing at huge N.

The first semantic run downloads model weights into the Hugging Face cache (can take a minute on CI — default CI keeps hash-only eval).

This repo’s Jest config uses **`jest-environment-node-single-context`** so `onnxruntime-node`’s `instanceof Float32Array` checks succeed under Jest (the default VM-isolated environment breaks typed-array identity).

## CI

GitHub Actions runs `npm test` and `npm run eval:longmem` (with a small `LONGMEM_N`) on push and pull requests. See `.github/workflows/ci.yml`.

## License

MIT — see `package.json`.
