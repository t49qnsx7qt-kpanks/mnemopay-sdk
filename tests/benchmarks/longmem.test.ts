/**
 * LongMem eval — long-term memory scale + recall quality (exact vs paraphrase).
 *
 * Run:
 *   npm run eval:longmem
 *   LONGMEM_N=1000 npm run eval:longmem
 *   LONGMEM_N=5000 LONGMEM_SAMPLES=80 LONGMEM_RECALL_LIMIT=60 npm run eval:longmem
 *   LONGMEM_EMBEDDINGS=semantic npm run eval:longmem   # Xenova MiniLM (needs @xenova/transformers)
 *
 * Env:
 *   LONGMEM_N              — memories to store (default 200; try 1000 / 5000 for ceiling)
 *   LONGMEM_SAMPLES        — query points spread across [0, N); default scales with N
 *   LONGMEM_RECALL_LIMIT   — `recall({ limit })`; vec kNN uses k = limit * 3 in MemoryStore
 *   LONGMEM_EMBEDDINGS     — set to `semantic` for real embeddings (optional peer dep)
 */
import { MnemoPay } from '../../src/index';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = path.join(__dirname, 'tmp-longmem');

function parseEnvInt(name: string, defaultVal: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultVal;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : defaultVal;
}

function p95(ms: number[]): number {
  if (ms.length === 0) return 0;
  const s = [...ms].sort((a, b) => a - b);
  return s[Math.floor(0.95 * (s.length - 1))];
}

/** Evenly spaced indices in [0, n), up to `count` points. */
function sampleIndices(n: number, count: number): number[] {
  if (count >= n) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let j = 0; j < count; j++) {
    out.push(Math.floor((j / Math.max(1, count - 1)) * (n - 1)));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function defaultSampleCount(n: number): number {
  if (n <= 300) return Math.min(n, 12);
  if (n <= 1500) return Math.min(n, 28);
  if (n <= 4000) return Math.min(n, 48);
  return Math.min(n, 64);
}

/** Default `recall.limit` so k = limit*3 scales with N (override LONGMEM_RECALL_LIMIT). */
function defaultRecallLimit(n: number): number {
  if (n <= 400) return 15;
  if (n <= 2000) return 35;
  if (n <= 6000) return 55;
  return 80;
}

/** Natural-language query that references fact `i` without copying the stored sentence. */
function paraphraseQuery(i: number): string {
  // Keep this semantically close to the stored sentence so MiniLM has enough lexical anchors.
  // Stored: "LongMem benchmark fact i: the secret token for index i is MEM-i-TOKEN"
  return `LongMem benchmark fact ${i}: what is the secret token for index ${i}?`;
}

describe('LongMem eval', () => {
  const agentId = 'longmem-bench-agent';
  const n = Math.max(10, parseEnvInt('LONGMEM_N', 200));
  const sampleCount = Math.min(n, parseEnvInt('LONGMEM_SAMPLES', defaultSampleCount(n)));
  const recallLimit = parseEnvInt('LONGMEM_RECALL_LIMIT', defaultRecallLimit(n));
  const useSemanticEmbeddings = process.env['LONGMEM_EMBEDDINGS'] === 'semantic';
  const vecKMult = parseEnvInt('LONGMEM_VEC_K_MULT', 3);
  let sdk: MnemoPay;

  beforeAll(() => {
    if (fs.existsSync(BENCH_DIR)) {
      try { fs.rmSync(BENCH_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    fs.mkdirSync(BENCH_DIR, { recursive: true });
    sdk = MnemoPay.create({
      agentId,
      persistDir: BENCH_DIR,
      vectorKMultiplier: vecKMult,
      ...(useSemanticEmbeddings
        ? { embeddings: 'semantic' as const, embeddingDimensions: 384 }
        : {}),
    });
  });

  afterAll(() => {
    if (sdk) sdk.close();
    try { fs.rmSync(BENCH_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('memory_vectors schema includes agent_id partition key', () => {
    const row = sdk.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'`,
    ).get() as { sql: string } | undefined;
    expect(row?.sql ?? '').toMatch(/agent_id\s+TEXT\s+PARTITION\s+KEY/i);
  });

  it('retain N memories; measure exact vs paraphrase recall (hash embedding ceiling)', async () => {
    const tRetain: number[] = [];
    const contents: string[] = [];
    // MemoryStore rate-limits writes (~200 / hour window in RateLimiter). Large N exceeds that in one run;
    // reset the in-process limiter between chunks (eval-only; production keeps limits).
    const rateLimiter = (sdk as unknown as { rateLimiter: { reset: (id: string) => void } }).rateLimiter;

    for (let i = 0; i < n; i++) {
      if (i > 0 && i % 200 === 0) rateLimiter.reset(agentId);
      const content = `LongMem benchmark fact ${i}: the secret token for index ${i} is MEM-${i}-TOKEN`;
      contents.push(content);
      const t0 = performance.now();
      await sdk.memory.retain(content, {
        source: 'observation',
        sessionId: 'longmem-session',
        tags: ['longmem', `i${i}`],
        importance: 0.5 + (i % 10) * 0.01,
      });
      tRetain.push(performance.now() - t0);
    }

    const idx = sampleIndices(n, sampleCount);

    // —— Exact query (same string as stored): expects ~100% until kNN / k budget breaks ——
    const tExact: number[] = [];
    let hits3 = 0;
    for (const i of idx) {
      const queryText = contents[i];
      const t0 = performance.now();
      const results = await sdk.memory.recall({
        text: queryText,
        limit: recallLimit,
        threshold: 0.0,
      });
      tExact.push(performance.now() - t0);
      if (results.slice(0, 3).some(r => r.memory.content === queryText)) hits3 += 1;
    }
    const exactHitRate = hits3 / idx.length;

    const exactSummary = {
      mode: 'exact_query',
      memories: n,
      recallLimit,
      vecKApprox: recallLimit * vecKMult,
      samples: idx.length,
      retainMsAvg: tRetain.reduce((a, b) => a + b, 0) / tRetain.length,
      retainMsP95: p95(tRetain),
      recallMsAvg: tExact.reduce((a, b) => a + b, 0) / tExact.length,
      recallMsP95: p95(tExact),
      hitAt3: exactHitRate,
    };
    console.log('\n[LongMem eval — exact query]', JSON.stringify(exactSummary, null, 2));

    // —— Paraphrase: production-realistic gap for hash embeddings ——
    const tPara: number[] = [];
    let hit5 = 0;
    let hit15 = 0;
    for (const i of idx) {
      const needle = `MEM-${i}-TOKEN`;
      const t0 = performance.now();
      const results = await sdk.memory.recall({
        text: paraphraseQuery(i),
        limit: recallLimit,
        // Avoid similarity-threshold filtering during eval; we want to measure retrieval quality
        // under a fixed candidate budget (k) and post-filters only.
        threshold: undefined,
      });
      tPara.push(performance.now() - t0);
      if (results.slice(0, 5).some(r => r.memory.content.includes(needle))) hit5 += 1;
      if (results.slice(0, 15).some(r => r.memory.content.includes(needle))) hit15 += 1;
    }

    const paraSummary = {
      mode: 'paraphrase_query',
      memories: n,
      recallLimit,
      vecKApprox: recallLimit * vecKMult,
      samples: idx.length,
      recallMsAvg: tPara.reduce((a, b) => a + b, 0) / tPara.length,
      recallMsP95: p95(tPara),
      hitAt5: hit5 / idx.length,
      hitAt15: hit15 / idx.length,
      note: useSemanticEmbeddings
        ? 'Xenova all-MiniLM-L6-v2 (384-d) semantic embeddings; rates depend on vec kNN budget and paraphrase wording.'
        : 'Hash-based embeddings are not semantic; low hit rates here are expected. ' +
          'Use embeddings: "semantic" or a custom embed() for paraphrase recall.',
    };
    console.log('\n[LongMem eval — paraphrase]', JSON.stringify(paraSummary, null, 2));

    // Same text → same hash embedding: stay high until index / k limits break.
    expect(exactHitRate).toBeGreaterThanOrEqual(0.85);
  }, 1_800_000);
});
