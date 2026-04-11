#!/usr/bin/env bash
# Download LongMemEval dataset from HuggingFace.
# Run from the benchmark/longmemeval/ directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$BASE_DIR/data"

HF_BASE="https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main"

echo "=== Downloading LongMemEval dataset ==="
echo "Target: $DATA_DIR"
echo ""

mkdir -p "$DATA_DIR"

download_file() {
  local filename="$1"
  local url="$HF_BASE/$filename"
  local dest="$DATA_DIR/$filename"

  if [ -f "$dest" ]; then
    echo "[skip] $filename already exists ($(du -h "$dest" | cut -f1))"
    return
  fi

  echo "[download] $filename ..."
  if command -v curl &>/dev/null; then
    curl -L --progress-bar -o "$dest" "$url"
  elif command -v wget &>/dev/null; then
    wget --show-progress -q -O "$dest" "$url"
  else
    echo "ERROR: Neither curl nor wget found. Install one and retry."
    exit 1
  fi
  echo "[done] $filename ($(du -h "$dest" | cut -f1))"
}

# Oracle version (smallest, best for initial benchmarking — only evidence sessions)
download_file "longmemeval_oracle.json"

# Small version (~115k tokens, ~40 sessions per instance)
download_file "longmemeval_s_cleaned.json"

# Medium version (~500 sessions per instance — full haystack)
download_file "longmemeval_m_cleaned.json"

echo ""
echo "=== Download complete ==="
echo ""
echo "Files:"
ls -lh "$DATA_DIR"/*.json 2>/dev/null || echo "(no files found)"
echo ""
echo "Also cloning LongMemEval repo for evaluation scripts..."

REPO_DIR="$BASE_DIR/longmemeval-repo"
if [ -d "$REPO_DIR" ]; then
  echo "[skip] Repo already cloned at $REPO_DIR"
else
  git clone --depth 1 https://github.com/xiaowu0162/LongMemEval.git "$REPO_DIR"
  echo "[done] Cloned to $REPO_DIR"
fi

echo ""
echo "Setup complete. Install Python deps for evaluation:"
echo "  pip install openai numpy tqdm backoff"
echo ""
echo "Run the benchmark:"
echo "  npm run bench:oracle   # Oracle (smallest, fastest)"
echo "  npm run bench:small    # ~40 sessions per question"
echo "  npm run bench:medium   # ~500 sessions per question"
