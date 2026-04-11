#!/usr/bin/env bash
# End-to-end LongMemEval benchmark for MnemoPay.
#
# Usage:
#   bash run.sh              # Default: oracle dataset
#   bash run.sh oracle       # Oracle (only evidence sessions)
#   bash run.sh s            # Small (~40 sessions)
#   bash run.sh m            # Medium (~500 sessions)
#
# Environment:
#   ANTHROPIC_API_KEY  — Required for answer generation
#   OPENAI_API_KEY     — Required for GPT-4o evaluation judge
#   RECALL_LIMIT       — Memories to recall per query (default: 20)
#   RECALL_STRATEGY    — score | vector | hybrid (default: score)
#   MODEL              — Claude model (default: claude-sonnet-4-20250514)
#   MAX_QUESTIONS      — Limit questions for testing (default: 0 = all)
#   CONCURRENCY        — Parallel API calls (default: 4)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Dataset Selection ────────────────────────────────────────────────────────

VARIANT="${1:-oracle}"
case "$VARIANT" in
  oracle) DATA_FILE="data/longmemeval_oracle.json" ;;
  s)      DATA_FILE="data/longmemeval_s_cleaned.json" ;;
  m)      DATA_FILE="data/longmemeval_m_cleaned.json" ;;
  *)
    echo "Unknown variant: $VARIANT"
    echo "Usage: bash run.sh [oracle|s|m]"
    exit 1
    ;;
esac

# ─── Config ───────────────────────────────────────────────────────────────────

RECALL_LIMIT="${RECALL_LIMIT:-20}"
RECALL_STRATEGY="${RECALL_STRATEGY:-score}"
MODEL="${MODEL:-claude-sonnet-4-20250514}"
MAX_QUESTIONS="${MAX_QUESTIONS:-0}"
CONCURRENCY="${CONCURRENCY:-4}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_DIR="results/${VARIANT}_${TIMESTAMP}"
HYP_FILE="${OUTPUT_DIR}/hypothesis.jsonl"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║     MnemoPay x LongMemEval Benchmark                    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Dataset:         ${VARIANT} (${DATA_FILE})"
echo "  Recall limit:    ${RECALL_LIMIT}"
echo "  Recall strategy: ${RECALL_STRATEGY}"
echo "  Model:           ${MODEL}"
echo "  Max questions:   ${MAX_QUESTIONS:-all}"
echo "  Concurrency:     ${CONCURRENCY}"
echo "  Output:          ${OUTPUT_DIR}/"
echo ""

# ─── Preflight Checks ────────────────────────────────────────────────────────

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY is not set."
  exit 1
fi

if [ ! -f "$DATA_FILE" ]; then
  echo "Data file not found: $DATA_FILE"
  echo "Downloading..."
  bash scripts/download-data.sh
  if [ ! -f "$DATA_FILE" ]; then
    echo "ERROR: Download failed. Get data manually from:"
    echo "  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned"
    exit 1
  fi
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

mkdir -p "$OUTPUT_DIR"

# ─── Save Run Config ─────────────────────────────────────────────────────────

cat > "${OUTPUT_DIR}/config.json" <<EOFCONFIG
{
  "variant": "${VARIANT}",
  "dataFile": "${DATA_FILE}",
  "recallLimit": ${RECALL_LIMIT},
  "recallStrategy": "${RECALL_STRATEGY}",
  "model": "${MODEL}",
  "maxQuestions": ${MAX_QUESTIONS},
  "concurrency": ${CONCURRENCY},
  "timestamp": "${TIMESTAMP}"
}
EOFCONFIG

# ─── Step 1: Evaluate (ingest + recall + generate answers) ───────────────────

echo ""
echo "=== Step 1/2: Ingest + Recall + Generate Answers ==="
echo ""

MAX_ARG=""
if [ "$MAX_QUESTIONS" -gt 0 ] 2>/dev/null; then
  MAX_ARG="--max $MAX_QUESTIONS"
fi

npx tsx evaluate.ts \
  --data "$DATA_FILE" \
  --out "$HYP_FILE" \
  --recall-limit "$RECALL_LIMIT" \
  --recall-strategy "$RECALL_STRATEGY" \
  --model "$MODEL" \
  --concurrency "$CONCURRENCY" \
  $MAX_ARG

echo ""

# ─── Step 2: Run Official LongMemEval Evaluation ─────────────────────────────

echo "=== Step 2/2: GPT-4o Judge Evaluation ==="
echo ""

EVAL_SCRIPT="longmemeval-repo/src/evaluation/evaluate_qa.py"
METRICS_SCRIPT="longmemeval-repo/src/evaluation/print_qa_metrics.py"

if [ ! -f "$EVAL_SCRIPT" ]; then
  echo "WARNING: LongMemEval evaluation scripts not found."
  echo "Clone the repo: git clone https://github.com/xiaowu0162/LongMemEval.git longmemeval-repo"
  echo ""
  echo "You can run evaluation manually:"
  echo "  python3 $EVAL_SCRIPT gpt-4o $HYP_FILE $DATA_FILE"
  echo ""
  echo "Hypothesis file saved: $HYP_FILE"
  exit 0
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "WARNING: OPENAI_API_KEY not set. GPT-4o judge evaluation skipped."
  echo ""
  echo "To run evaluation manually:"
  echo "  export OPENAI_API_KEY=your-key"
  echo "  python3 $EVAL_SCRIPT gpt-4o $HYP_FILE $DATA_FILE"
  echo ""
  echo "Hypothesis file saved: $HYP_FILE"
  exit 0
fi

python3 "$EVAL_SCRIPT" gpt-4o "$HYP_FILE" "$DATA_FILE"

EVAL_RESULTS="${HYP_FILE}.eval-results-gpt-4o"
if [ -f "$EVAL_RESULTS" ]; then
  echo ""
  echo "=== Final Metrics ==="
  python3 "$METRICS_SCRIPT" "$EVAL_RESULTS" "$DATA_FILE"

  # Copy eval results to output dir
  cp "$EVAL_RESULTS" "${OUTPUT_DIR}/eval-results.jsonl"
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║     Benchmark Complete                                   ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Results: ${OUTPUT_DIR}/"
echo "  Hypotheses: ${HYP_FILE}"
echo "  Config: ${OUTPUT_DIR}/config.json"
echo ""
