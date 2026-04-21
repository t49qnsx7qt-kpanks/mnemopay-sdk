#!/usr/bin/env bash
# Validation run: fixed retrieval stack on 100Q oracle.
# Same config as the regressed 74.6 run, except:
#   - reranker now reserves ceil(20 * 0.4) = 8 recency-preserved slots
#   - HyDE is gated off on temporal / knowledge-update / count-of-time-units questions
# Expected direction: knowledge-update + temporal-reasoning should recover toward
# the 77.2 baseline, single-session gains should hold.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

set -a
source ../../.env
set +a

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="results/oracle_fixed_100q_${STAMP}.jsonl"
LOG="results/oracle_fixed_100q_${STAMP}.log"

echo "=== Fixed retrieval stack — 100Q oracle validation ==="

npx tsx evaluate.ts \
  --data data/longmemeval_oracle.json \
  --out "$OUT" \
  --recall-limit 20 \
  --recall-strategy hybrid \
  --embeddings bge \
  --hyde --hyde-provider groq --hyde-n 3 \
  --rerank --rerank-model Xenova/bge-reranker-base --rerank-pool 50 \
  --model claude-sonnet-4-20250514 \
  --concurrency 3 \
  --max 100 2>&1 | tee "$LOG"

echo ""
echo "=== Judge ==="
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python3 longmemeval-repo/src/evaluation/evaluate_qa.py gpt-4o "$OUT" data/longmemeval_oracle.json 2>&1 | tee -a "$LOG"

echo ""
echo "=== Metrics ==="
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python3 longmemeval-repo/src/evaluation/print_qa_metrics.py "${OUT}.eval-results-gpt-4o" data/longmemeval_oracle.json 2>&1 | tee -a "$LOG"
