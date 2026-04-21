#!/usr/bin/env bash
# 3x 50Q ablation to isolate the source of the 77.2 → 74.6 regression.
# Each run locks two dimensions to the 77.2 baseline and flips exactly one.
#
#   A: hybrid + no HyDE + no rerank  — isolates strategy swap (score → hybrid)
#   B: score  + HyDE  + no rerank    — isolates HyDE hypothesis pollution
#   C: score  + no HyDE + rerank     — isolates reranker breadth compression
#
# Baseline for comparison: 77.2% on 500Q with {score, no HyDE, no rerank}.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

set -a
source ../../.env
set +a

DATA="data/longmemeval_oracle.json"
JUDGE="longmemeval-repo/src/evaluation/evaluate_qa.py"
METRICS="longmemeval-repo/src/evaluation/print_qa_metrics.py"
MODEL="claude-sonnet-4-20250514"
CONC=3
N=50
STAMP=$(date +%Y%m%d-%H%M%S)
RESDIR="results/ablation_${STAMP}"
mkdir -p "$RESDIR"

run_one() {
  local label="$1"; shift
  local out="${RESDIR}/${label}.jsonl"
  local log="${RESDIR}/${label}.log"
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  Ablation: ${label}"
  echo "  Flags: $@"
  echo "═══════════════════════════════════════════════════════════"
  npx tsx evaluate.ts \
    --data "$DATA" \
    --out "$out" \
    --recall-limit 20 \
    --embeddings bge \
    --model "$MODEL" \
    --concurrency "$CONC" \
    --max "$N" \
    "$@" 2>&1 | tee "$log"
  echo ""
  echo "--- Judging ${label} ---"
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python3 "$JUDGE" gpt-4o "$out" "$DATA" 2>&1 | tee -a "$log"
  if [ -f "${out}.eval-results-gpt-4o" ]; then
    echo ""
    echo "--- Metrics: ${label} ---" | tee -a "$log"
    PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python3 "$METRICS" "${out}.eval-results-gpt-4o" "$DATA" 2>&1 | tee -a "$log"
  fi
}

run_one "A_hybrid_only" \
  --recall-strategy hybrid

run_one "B_hyde_only" \
  --recall-strategy score \
  --hyde --hyde-provider groq --hyde-n 3

run_one "C_rerank_only" \
  --recall-strategy score \
  --rerank --rerank-model Xenova/bge-reranker-base --rerank-pool 50

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  All ablations complete. Results: ${RESDIR}/"
echo "═══════════════════════════════════════════════════════════"
