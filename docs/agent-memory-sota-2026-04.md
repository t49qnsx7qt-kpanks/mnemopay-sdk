# Agent Memory State-of-the-Art — Deep Research Pass (2026-04-20)

**Baseline**: MnemoPay @mnemopay/sdk v1.3.1 — 77.2% on LongMemEval Oracle (Sonnet-4 answerer, GPT-4o judge, 500q).
**Weakest category**: multi-session reasoning @ 66.9%.
**Goal**: Identify specific architectural deltas to close the gap to the 90–96% tier.

---

## Current MnemoPay stack (baseline to compare against)

- **Lexical**: SQLite FTS5
- **Vector**: bge-small-en-v1.5 (384-dim) cosine
- **Fusion**: `score = α·lexical + β·cosine + γ·recency + δ·importance`
- **Query expansion**: HyDE via Groq Llama-3.3-70B (3 hypotheticals), gated off for temporal + knowledge-update
- **Rerank**: Xenova/bge-reranker-base (110M ONNX, local), top-50 pool, `preserveRecency=ceil(topK*0.4)`
- **Top-K**: 20, chunks = individual message turns (no summarization, no entities, no graph)
- **Integrity**: Merkle-chain + HMAC receipts
- **Source layout**: `src/recall/{engine.ts,hyde.ts,rerank.ts,persistence/}`

---

## The LongMemEval leaderboard (as of Apr 2026, cleaned)

All numbers on `longmemeval_s` (500q), GPT-4o judge unless noted. "Real-retrieval" means system retrieves + answerer reasons; no oracle cheating.

| System | Overall | single-user | single-asst | single-pref | knowledge-upd | temporal | multi-session | Source |
|---|---|---|---|---|---|---|---|---|
| Agentmemory V4 (McCann) | **96.2%** | 100.0 | 96.4 | 96.7 | 97.4 | 96.2 | **93.2** | [dev.to writeup](https://dev.to/jordanmccann/how-i-built-a-memory-system-that-scores-962-on-longmemeval-1-in-the-world-41n), [repo](https://github.com/JordanMcCann/agentmemory) |
| Mastra Observational Memory (gpt-5-mini) | 94.87% | 95.7 | 94.6 | 100.0 | 96.2 | 95.5 | **87.2** | [mastra.ai/research](https://mastra.ai/research/observational-memory) |
| OMEGA | 95.4% | — | — | — | — | — | 83 | [omegamax.co/benchmarks](https://omegamax.co/benchmarks) |
| Mem0 (new token-efficient algo, 2026) | **92.0%** | 94.3 | 97.1 | 46.4 | 100.0 | 76.7 | **96.7** | [mem0.ai/research](https://mem0.ai/research), [blog](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm) |
| Memento bitemporal KG (n1n.ai) | 92.4% | — | — | — | — | — | — | [n1n.ai blog](https://explore.n1n.ai/blog/building-bitemporal-knowledge-graph-llm-agent-memory-longmemeval-2026-04-11) |
| Shane Farkas / Memento | 90.8% | 97.1 | 98.2 | 93.3 | 88.5 | 89.5 | 86.5 | [dev.to writeup](https://dev.to/shane-farkas/i-built-an-agent-memory-system-for-myself-and-got-908-end-to-end-on-longmemeval-3hfp) |
| Hindsight (OSS-120B) | 89.0% | 100.0 | 98.2 | 86.7 | 92.3 | 85.7 | 81.2 | [arxiv 2512.12818](https://arxiv.org/html/2512.12818v1) |
| Supermemory (GPT-4o) | 81.6% | 97.14 | 96.43 | 70.0 | 88.46 | 76.69 | 71.43 | [supermemory.ai/research](https://supermemory.ai/research/) |
| **MnemoPay v1.3.1** | **77.2%** | — | — | — | — | — | **66.9** | internal |
| Zep/Graphiti (GPT-4o) | 71.2% | 92.9 | 80.4 | 56.7 | 83.3 | 62.4 | 57.9 | [arxiv 2501.13956](https://arxiv.org/html/2501.13956v1) |
| Full-context baseline (GPT-4o, 115k tok) | 60.2% | 81.4 | 94.6 | 20.0 | 78.2 | 45.1 | 44.3 | [Zep paper](https://arxiv.org/html/2501.13956v1) |

Notes on integrity:
- **MemPalace 96.6%** is a ChromaDB score with zero MemPalace logic — debunked on GitHub issues [#214](https://github.com/milla-jovovich/mempalace/issues/214) and [#29](https://github.com/MemPalace/mempalace/issues/29). Palace modes (aaak/rooms) **regress** 7–12 pts vs raw. Do not cite as a target.
- **Letta/Cognee/LangMem have not published LongMemEval numbers**. Letta published 74.0% on **LoCoMo** only ([blog](https://www.letta.com/blog/benchmarking-ai-agent-memory)), beating Mem0 (68.5% on same setup) via filesystem + grep tools, not vector memory.

---

## Per-system teardowns

### 1. Mem0 (92.0% on LongMemEval, 96.7% multi-session)

Architecture (from [arxiv 2504.19413](https://arxiv.org/html/2504.19413v1) + [mem0.ai blog](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm)):
- **Extraction**: GPT-4o-mini single-pass **ADD-only** (new algo). Previous version did ADD/UPDATE/DELETE/NOOP tool calls; new algo generates independent records per fact, preserving historical state for temporal reasoning.
- **Entity linking**: proper nouns, quoted text, compound noun phrases embedded and stored in **separate lookup layer** for entity-ranked boosts.
- **Retrieval**: 3 parallel scorers (semantic / keyword / entity match) → rank-fusion. No cross-encoder rerank mentioned.
- **Embedding**: OpenAI text-embedding-3-small.
- **Graph variant (Mem0^g)**: Neo4j, directed labeled triples (v_s, r, v_d), entity embeddings, contradicted edges marked invalid (not deleted) for temporal replay. Graph variant is *worse* on multi-hop than flat Mem0 on LOCOMO (J=47.19 vs 51.15), better on temporal (58.13 vs 55.51).
- **Multi-session trick**: messages paired across sessions (m_{t-1}, m_t); **asynchronous summary generation** periodically refreshes a global conversation summary that rides with every extraction prompt. This is the single biggest multi-session lift.
- **Cost**: ~6,780 mean tokens per retrieval call. p95 latency 200ms (flat), 657ms (graph).
- **What they do we don't**: single-pass **ADD-only extraction into structured fact records with entity lookup layer**, plus rolling session summary fed into the extractor context.

### 2. Zep/Graphiti (71.2% on LongMemEval)

Architecture (from [arxiv 2501.13956](https://arxiv.org/html/2501.13956v1)):
- **Three-tier graph**: Episode subgraph (raw) → Semantic entity subgraph (extracted) → Community subgraph (Louvain clusters with summaries).
- **Extraction**: GPT-4o-mini-2024-07-18 with 4-message context window. Named entity recognition + LLM entity resolution.
- **Embedding**: BGE-m3 (1024-dim).
- **Retrieval**: three parallel search functions — φ_cos (cosine), φ_bm25 (Neo4j/Lucene), **φ_bfs (breadth-first n-hop graph traversal)** — fused with RRF + MMR + cross-encoder LLM rerank.
- **Bitemporal edges**: every fact has `t_valid` / `t_invalid` (event time) AND `t'_created` / `t'_expired` (system time). Contradictions invalidate edges rather than delete.
- **Multi-session score: 57.9% (GPT-4o)** — **worse than our 66.9%**. Graph traversal alone is not enough.
- **What they do we don't**: bitemporal validity intervals, entity/edge extraction, community subgraph, BFS over entity graph.

### 3. Letta / MemGPT

- **No published LongMemEval score.** LoCoMo-only: 74.0% (Letta Filesystem w/ gpt-4o-mini) vs Mem0-graph 68.5% ([letta.com blog](https://www.letta.com/blog/benchmarking-ai-agent-memory)).
- **Architecture**: core memory (always in-context, like RAM), recall memory (searchable conversation history), archival memory (vector store) — plus **filesystem tools** (`grep`, `search_files`, `open`, `close`).
- Key insight: **agent-driven iterative search with grep on raw files beats specialized memory tools**, because the answerer model can re-query until satisfied.
- **What they do we don't**: filesystem-backed memory with agent-callable `grep` + iterative search loop (answerer controls retrieval).

### 4. A-MEM (NeurIPS 2025, arxiv 2502.12110)

- Zettelkasten-inspired. Each note = {content, keywords, tags, category, context, timestamp (YYYYMMDDHHmm), **links to related memories**}.
- **Link generation**: on add, LLM analyzes historical memories, creates semantic links. Adding a new note can **trigger updates to existing notes' context/tags**.
- Embedding: all-MiniLM-L6-v2 via ChromaDB.
- **~1,200 tokens per memory op** (85-93% reduction vs baselines).
- **LongMemEval numbers not in repo** ([agiresearch/A-mem](https://github.com/agiresearch/A-mem) — they redirect to paper). LoCoMo temporal J=49.91 (mid-tier).
- **What they do we don't**: forward + backward link generation at write time, and *retroactive note mutation* when new evidence arrives.

### 5. LangMem (LangChain)

- Primitives: Memory Managers (extract/update/consolidate) + Prompt Optimizers. Works with any storage via `BaseStore`.
- **No published LongMemEval score.** LOCOMO p95 search latency: 59.82s (vs Mem0 0.2s) — unusable as-is.
- **What they do we don't**: background memory manager that consolidates memories async (also Mem0 has this).

### 6. Cognee

- Modular ECL (extract / cognify / load) pipeline. Vector + graph hybrid. Qdrant + any graph DB.
- **No published LongMemEval.** HotPotQA (24 multi-hop, n=45): human-like 0.93, DeepEval F1 0.84, EM 0.69 ([cognee.ai/research](https://www.cognee.ai/research-and-evaluation-results)). Not comparable to our benchmark.
- **What they do we don't**: pluggable cognify step where entities+chunks+types are all nodes, edges define relationships (denser graph than Zep's entity-only).

### 7. OpenAI ChatGPT persistent memory (inferred from public blog)

- Four-layer: User Profile Memory, Conversation History, Extracted Knowledge, Active Context. Toggleable in Settings ([openai.com/index/memory-and-new-controls](https://openai.com/index/memory-and-new-controls-for-chatgpt/)).
- **No benchmark numbers.** Implementation is closed.
- **What we can infer**: extraction into a structured profile JSON that rides in every system prompt, plus an opt-in full-history cross-session RAG (Apr 2025 launch).

### 8. Anthropic Claude memory tool (2026)

- **Client-side** file directory. Six ops: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. Storage is yours (file / S3 / DB) ([platform.claude.com memory-tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).
- Paired with **context editing** (client tool-result clearing) and **compaction** (server-side summarization near window limit).
- **No benchmark numbers.** This is a primitive, not a memory system.
- **What they do we don't**: actually nothing MnemoPay lacks — but their *compaction* primitive is a template for our multi-session summary layer.

### 9. Agentmemory V4 (Jordan McCann, #1 at 96.2%)

- **The template to copy.** Solo build, 16 days, $1k.
- **Six parallel weighted signals**: semantic 0.30, BM25 0.12, activation 0.18, **graph spreading 0.18**, importance 0.10, **temporal Gaussian 0.12**.
- Embedder: all-mpnet-base-v2 (768-dim, **larger than our 384**). HNSW (M=16, ef_construction=200, ef_search=100) with **SHA-256 level assignment** for determinism.
- Cross-encoder rerank: ms-marco-MiniLM-L-6-v2 (selective, 1,236 calls across 500 cases).
- Per-category token budgets: multi-session **7,500**, temporal 5,000, single-asst/pref 3,500, knowledge-update 2,500, single-user 1,500.
- Session ingestion with **`[Session date: YYYY-MM-DD]` temporal markers** for grounding.
- "Coreference hints" injected for cross-session references.
- Generator: Claude Opus 4.6 (temperature=0); judge GPT-4o (temperature=0, seed=42).
- **What they do we don't**: six-signal fusion (we have four), graph spreading activation, Gaussian temporal proximity, per-category token budgets, session-date markers, coreference-hint injection, deterministic HNSW.

### 10. Mastra Observational Memory (94.87%, 87.2% multi-session with gpt-5-mini)

- **Two background agents** (Observer + Reflector) = "subconscious mind."
- Three-tier compression: raw → **observations** (3-6× compression, dated, priority-tagged) → **reflections** (restructured, combined, obsolete-dropped).
- **Triple-date anchoring per observation**: creation date, referenced date, computed relative offset.
- Token-count triggers, not time/message triggers.
- Observer/Reflector: Gemini-2.5-flash.
- **What they do we don't**: asynchronous observation + reflection pipeline producing dated structured summaries of sessions.

### 11. Hindsight (89.0%, 81.2% multi-session)

- Four networks: World / Experience / Opinion / Observation.
- Four-way parallel retrieval (semantic/BM25/graph/temporal) → RRF → cross-encoder rerank.
- **Opinion reinforcement**: confidence scores adjusted on new evidence (reinforce / weaken / contradict / neutral).
- Runs on GPT-OSS-20B locally.
- **What they do we don't**: confidence scoring on memories + the opinion-vs-fact split.

### 12. Memento / n1n.ai (92.4%)

- **Bitemporal KG** (valid-time + system-time). Tiered entity resolution: exact → fuzzy → phonetic → embedding → LLM tiebreak.
- Extraction: Claude 3.5 Sonnet.
- **Adaptive retrieval**: classifies query as "Wide" (frequency) or "Narrow" (specific), adjusts params.
- **Context Dilution finding**: 8K context *degraded* performance vs 4K; top-K 20 → top-K 10 helped. More retrieval is not better.

---

## Synthesis

### 1. Top 5 architectural wins to port, ranked by expected LongMemEval lift × effort

Ranked by ( estimated pts / engineering-days ).

| # | Win | Expected lift | Effort | Specifics |
|---|---|---|---|---|
| **1** | **Rolling session summaries fed into extractor + retriever** (Mem0 + Mastra pattern) | +8–12 pts overall, +15–25 on multi-session | 3–5 days | Add `src/recall/summarizer.ts`. Groq Llama-3.3-70B summarizes each closed session into a 200-token dated digest: `{session_id, start_date, end_date, speakers, topics[], facts[], decisions[]}`. Store in new `session_summaries` SQLite table with FTS5 + vector index. On recall, retrieve top-3 summaries in addition to top-K turns; concatenate in prompt *before* raw turns. This directly targets the multi-session 66.9% gap — Mem0 gets 96.7% on this category almost entirely from the async session summary layer. |
| **2** | **Entity extraction pipeline + entity lookup layer** (Mem0, Zep, Agentmemory) | +4–7 pts overall, +5–10 on multi-session and temporal | 5–7 days | Add `src/recall/entities.ts`. On ingest, Groq Llama-3.3-70B extracts {entities[], relations[], mentions[]}. Store in new SQLite tables: `entities(id, name, type, canonical_name, embedding, first_seen, last_seen)`, `edges(src_id, rel, dst_id, t_valid, t_invalid, source_turn_id)`, `mentions(turn_id, entity_id, span)`. Entity canonicalization: exact → fuzzy (Levenshtein ≤ 2) → embedding cosine > 0.9 → LLM tiebreaker (Memento's tiered resolution). On retrieval, extract query entities and add **graph spreading activation** score: for each anchor entity, BFS 2 hops, score = decay^depth × edge_confidence. Wire into fusion as 6th signal `ε·graph_activation`. |
| **3** | **Bitemporal edge invalidation for knowledge updates** (Zep + Memento) | +3–5 pts, concentrated on knowledge-update + temporal | 2–3 days (after #2) | When entity extractor finds a contradictory triple `(e, r, v_new)` vs existing `(e, r, v_old)`, mark old edge `t_invalid = now()` rather than deleting. Retrieval filters by `t_invalid IS NULL OR t_invalid > query_time`. Pass `t_valid` ranges to answerer prompt as `[valid: 2025-03-01 → 2025-11-04]` spans. This is a free win once #2 lands. |
| **4** | **Per-category token budgets + context-dilution fix** (Agentmemory V4 + Memento) | +2–4 pts overall | 1 day | Classify query via lightweight zero-shot Groq call into {single-user, single-asst, single-pref, multi-session, temporal, knowledge-update}. Apply token budgets: multi-session 7,500, temporal 5,000, single-* 3,500, knowledge-update 2,500, single-user 1,500. Also drop default top-K from 20 → 10 for single-* questions (Memento: "more retrieval is not better retrieval," 8K→4K context gave +1.4pts). |
| **5** | **Upgrade embedder + session-date markers** (Agentmemory V4) | +2–3 pts | 1 day | Replace bge-small-en-v1.5 (384-dim) with bge-base-en-v1.5 (768-dim) or all-mpnet-base-v2. On ingest, prepend `[Session date: YYYY-MM-DD]` to every turn text. Cheap, deterministic, ships in an afternoon. Also: replace Math.random HNSW level assignment with SHA-256 of embedding (determinism fix). |

Total expected lift if all five land cleanly: **+19 to +31 points**, putting MnemoPay in the **90–95% range** and closing the multi-session gap from 66.9% to the 85–95% band.

### 2. The multi-session reasoning fix specifically

**Winners on this category:** Mem0 96.7%, Agentmemory 93.2%, Mastra 87.2%. All three share one pattern: **they do not retrieve raw turns alone.** They retrieve (a) extracted structured facts / entities, plus (b) per-session summaries that encode cross-session state.

**Port plan:**
1. **Session boundary detection** — close a session after N minutes of inactivity or when user starts a new topic (classifier). Store `session_id` on every turn.
2. **Offline summarizer worker** — when a session closes, Groq Llama-3.3-70B produces a dated digest (200 tokens): participants, topics, stated facts, decisions, preferences, unresolved threads. Schema matches Mastra's observations format.
3. **Reflection pass every K sessions** — collapse older overlapping summaries into higher-level "reflections" (Mastra's second tier). This keeps summary table bounded.
4. **Retrieval** — in addition to current turn-level top-K, pull top-3 session summaries by hybrid score. Concat into prompt as `<session_summaries>...</session_summaries>` block *above* raw turns.
5. **Coreference hint** — for queries flagged as multi-session (entity appears in 2+ sessions), inject a `<coreference>E1 appears in sessions S2, S7, S11</coreference>` block (Agentmemory V4 trick).

Expected: multi-session 66.9% → 85%+. This alone is +7 pts on overall LongMemEval.

### 3. The unique wedge (what MnemoPay still claims that none of these can)

After we port the top 5, all of the above will have **comparable retrieval quality**. The unique, defensible wedge is the stack the memory systems *don't* have:

1. **Payment rails integrated with memory** (Stripe/Lightning/Paystack live in v1.0+). Mem0, Zep, Letta, Cognee, Mastra, Agentmemory — **none** have payment hooks. Searched their docs and repos: zero mentions of a billable-action primitive tied to a recall event. This lets MnemoPay bill per recalled memory, per entity lookup, per session summary — turning memory into a metered utility.
2. **Agent FICO (300-850) + behavioral credit** (v1.0.0-beta.1). Memory + payments = credit. No other memory system emits a risk score from its own retrieval + transaction history. This is the "Agent Banking" thesis and the real moat.
3. **Proof-of-presence (GridStamp integration)** — spatial receipts are a GridStamp primitive, not a memory one, but MnemoPay's Merkle-chain + HMAC-signed recall receipts give **auditable memory**. No competitor produces a cryptographic receipt per recall that an insurer or regulator can verify. Under the EU AI Act (Aug 2 2026 deadline), this is a compliance primitive, not a nice-to-have.
4. **Offline-first mobile SDK** (SQLite). Mem0 needs Neo4j/Qdrant, Zep needs Postgres + Neo4j, Mastra needs a hosted backend. MnemoPay runs on-device.

**Pressure test**: I searched Mem0, Letta, Zep docs for "payment," "billing," "credit score," "receipt," "cryptographic." Mem0 has Stripe on *their platform's billing* but no SDK primitive for per-recall billing. Letta has no payment primitive. Zep has no payment primitive. The wedge holds.

### 4. The marketable number to chase

Two options, ranked:

**Option A (safer, HN-headline-grade)**: **"MnemoPay: first open-source agent memory stack to cross 90% on LongMemEval with sub-200ms p95 retrieval and cryptographic recall receipts, running on SQLite."**
- Targets: 90% overall (vs 77.2% today), p95 < 200ms (Mem0 territory), Merkle + HMAC receipts (unique).
- Story: beats Zep 71.2% by 19 pts, matches Mem0 92.0% overall, only stack with receipts.
- Effort: 2–3 weeks of the top-5 ports.

**Option B (riskier but bigger)**: **"MnemoPay is the first agent memory system to ship a credit score (Agent FICO) and payment rails on top of 90%+ LongMemEval retrieval — one SDK for memory, money, and trust."**
- Story: all the memory system folks solved retrieval. We're the only ones who turned it into a banking primitive.
- Headline risk: Mem0 could ship payments in a month. Get Agent FICO in production against 3+ live agents as a moat before claiming this.

**Recommended**: ship **Option A** as the technical landing page (appeals to engineers, verifiable), keep **Option B** for the investor / YC app narrative. They are complementary.

---

## Concrete next-week implementation roadmap

| Day | Task | File(s) |
|---|---|---|
| 1 | Upgrade embedder to bge-base-en-v1.5 + session-date markers + SHA-256 HNSW | `src/recall/engine.ts`, `src/recall/persistence/*` |
| 2 | Per-category query classifier + token budgets + top-K=10 for single-* | `src/recall/engine.ts`, new `src/recall/classifier.ts` |
| 3-5 | Session boundary detection + offline summarizer worker + summary table + summary retrieval | new `src/recall/summarizer.ts`, schema migration |
| 6-10 | Entity extraction pipeline + entity/edge/mention tables + tiered canonicalization + graph spreading activation score | new `src/recall/entities.ts`, `src/recall/graph.ts`, schema migration |
| 11-12 | Bitemporal edge invalidation + `[valid: X → Y]` context injection | `src/recall/entities.ts` |
| 13-14 | LongMemEval re-run with full 500q Oracle + per-category breakdown | existing eval harness |
| 15 | Write blog post + HN submission if ≥ 90% overall | `blog/longmemeval-90.md` |

---

## Sources

- [LongMemEval benchmark repo](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025)
- [Mem0 token-efficient algo blog](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm)
- [Mem0 research page](https://mem0.ai/research)
- [Mem0 architecture paper — arxiv 2504.19413](https://arxiv.org/html/2504.19413v1)
- [Zep/Graphiti paper — arxiv 2501.13956](https://arxiv.org/html/2501.13956v1)
- [Graphiti repo](https://github.com/getzep/graphiti)
- [A-MEM paper — arxiv 2502.12110](https://arxiv.org/abs/2502.12110)
- [A-MEM repo](https://github.com/agiresearch/A-mem)
- [Letta filesystem memory benchmarking](https://www.letta.com/blog/benchmarking-ai-agent-memory)
- [LangMem repo](https://github.com/langchain-ai/langmem)
- [Cognee research page](https://www.cognee.ai/research-and-evaluation-results)
- [Agentmemory V4 repo (96.2%)](https://github.com/JordanMcCann/agentmemory)
- [Agentmemory V4 writeup](https://dev.to/jordanmccann/how-i-built-a-memory-system-that-scores-962-on-longmemeval-1-in-the-world-41n)
- [Mastra Observational Memory](https://mastra.ai/research/observational-memory)
- [Supermemory research](https://supermemory.ai/research/)
- [Hindsight paper — arxiv 2512.12818](https://arxiv.org/html/2512.12818v1)
- [Shane Farkas Memento 90.8%](https://dev.to/shane-farkas/i-built-an-agent-memory-system-for-myself-and-got-908-end-to-end-on-longmemeval-3hfp)
- [n1n.ai bitemporal KG 92.4%](https://explore.n1n.ai/blog/building-bitemporal-knowledge-graph-llm-agent-memory-longmemeval-2026-04-11)
- [OpenAI memory announcement](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- [Anthropic memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [MemPalace benchmark controversy — issue #214](https://github.com/milla-jovovich/mempalace/issues/214)
- [LongMemEval MemoryAgentBench successor — arxiv 2507.05257](https://arxiv.org/abs/2507.05257)
