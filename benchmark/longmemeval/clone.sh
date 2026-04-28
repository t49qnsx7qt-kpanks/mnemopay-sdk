#!/usr/bin/env bash
# Clone-on-demand for the LongMemEval benchmark repo.
#
# Why this script exists: a previous workflow `git clone`d the upstream
# LongMemEval repo straight into `benchmark/longmemeval/longmemeval-repo/`,
# which embedded a full `.git` directory inside this repo. That made every
# fresh clone of `mnemopay-sdk` 2.3 MB heavier and confused tooling that
# walked the working tree.
#
# Fix: keep `longmemeval-repo/` out of source control (it's already in
# `.gitignore`), and clone it on demand with this script. Run before any
# benchmark session.
#
# Usage:
#   bash benchmark/longmemeval/clone.sh

set -euo pipefail

cd "$(dirname "$0")"
DIR="longmemeval-repo"

if [ -d "$DIR/.git" ]; then
  echo "[longmemeval] $DIR already cloned. Pulling latest…"
  git -C "$DIR" pull --rebase --autostash
else
  echo "[longmemeval] cloning fresh…"
  git clone --depth 1 https://github.com/xiaowu0162/LongMemEval.git "$DIR"
fi

echo "[longmemeval] ready: $(realpath "$DIR")"
