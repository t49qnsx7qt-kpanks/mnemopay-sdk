# LongMemEval Benchmark for MnemoPay

Benchmark adapter for [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025), evaluating MnemoPay's memory system on 500 long-term conversation memory questions across 5 cognitive abilities.

## What It Tests

| Ability | Questions | What's Measured |
|---------|-----------|-----------------|
| Information Extraction | ~150 | Single-session fact recall (user facts, assistant content, preferences) |
| Multi-Session Reasoning | ~80 | Cross-session inference and synthesis |
| Temporal Reasoning | ~80 | Date-aware ordering and duration calculations |
| Knowledge Updates | ~80 | Handling contradictory/updated information |
| Abstention | ~110 | Correctly refusing when info is insufficient |

## Quick Start

```bash
cd benchmark/longmemeval

# 1. Install deps
npm install

# 2. Download LongMemEval data + evaluation scripts
npm run download

# 3. Set API keys
export ANTHROPIC_API_KEY=your-key      # Answer generation (Claude)
export OPENAI_API_KEY=your-key         # GPT-4o judge (LongMemEval standard)

# 4. Run (oracle dataset, fastest)
npm run bench:oracle
```

## Dataset Variants

| Variant | Sessions/Question | Tokens/Question | Best For |
|---------|-------------------|-----------------|----------|
| `oracle` | 1-5 (evidence only) | ~2K | Development, debugging recall quality |
| `s` | ~40 | ~115K | Testing needle-in-haystack with moderate noise |
| `m` | ~500 | ~1M+ | Full benchmark — realistic long-term memory load |

## How It Works

1. **Ingest**: Each question's conversation history (haystack sessions) is loaded into a dedicated MnemoPay agent via `agent.remember()`. Sessions are stored as formatted text blocks with date/ID tags.

2. **Recall**: For each question, `agent.recall(query, limit)` retrieves the top-K most relevant memories using MnemoPay's scoring engine (importance x recency x frequency, optionally with vector search).

3. **Generate**: Retrieved memories are passed as context to Claude, which generates a concise answer.

4. **Evaluate**: Output JSONL is scored by GPT-4o using LongMemEval's official evaluation prompts (different rubrics per question type).

## Configuration

Via environment variables or CLI flags:

```bash
# Environment variables
RECALL_LIMIT=30         # Memories per query (default: 20)
RECALL_STRATEGY=score   # score | vector | hybrid (default: score)
MODEL=claude-sonnet-4-20250514  # Claude model for answers
MAX_QUESTIONS=10        # Limit for testing (default: 0 = all)
CONCURRENCY=4           # Parallel API calls (default: 4)

# Run with overrides
RECALL_LIMIT=30 RECALL_STRATEGY=hybrid bash run.sh oracle
```

CLI flags for evaluate.ts directly:

```bash
npx tsx evaluate.ts \
  --data data/longmemeval_oracle.json \
  --out results/my-test.jsonl \
  --recall-limit 30 \
  --recall-strategy hybrid \
  --model claude-sonnet-4-20250514 \
  --max 10 \
  --concurrency 2
```

## Output Structure

```
results/
  oracle_20260410-143000/
    config.json          # Run parameters
    hypothesis.jsonl     # {question_id, hypothesis} per line
    eval-results.jsonl   # With autoeval_label after GPT-4o judging
```

## Running Evaluation Separately

If you only want to re-run the GPT-4o judge on existing hypotheses:

```bash
export OPENAI_API_KEY=your-key

python3 longmemeval-repo/src/evaluation/evaluate_qa.py \
  gpt-4o \
  results/oracle_*/hypothesis.jsonl \
  data/longmemeval_oracle.json

python3 longmemeval-repo/src/evaluation/print_qa_metrics.py \
  results/oracle_*/hypothesis.jsonl.eval-results-gpt-4o \
  data/longmemeval_oracle.json
```

## Comparing Recall Strategies

```bash
# Score-based (default, fast, no embeddings needed)
RECALL_STRATEGY=score bash run.sh oracle

# Vector-based (requires OpenAI embeddings)
RECALL_STRATEGY=vector OPENAI_API_KEY=your-key bash run.sh oracle

# Hybrid (score + vector weighted blend)
RECALL_STRATEGY=hybrid OPENAI_API_KEY=your-key bash run.sh oracle
```

## File Overview

| File | Purpose |
|------|---------|
| `ingest.ts` | Standalone ingestion (for pre-loading, debugging) |
| `evaluate.ts` | Full pipeline: ingest + recall + Claude answer gen + JSONL output |
| `run.sh` | End-to-end: download check, evaluate, GPT-4o judge, metrics |
| `types.ts` | TypeScript types matching LongMemEval's data schema |
| `scripts/download-data.sh` | Download dataset + clone eval repo |

## Requirements

- Node.js 18+
- Python 3.8+ (for LongMemEval's evaluation scripts)
- `ANTHROPIC_API_KEY` for answer generation
- `OPENAI_API_KEY` for GPT-4o judge evaluation
- ~500MB disk for the medium dataset
