/**
 * Cross-platform helper: run LongMem eval with semantic embeddings (Xenova).
 * Usage: node scripts/run-longmem-semantic.cjs
 */
const { spawnSync } = require('child_process');
const path = require('path');

process.env.LONGMEM_EMBEDDINGS = 'semantic';
process.env.LONGMEM_VEC_K_MULT = process.env.LONGMEM_VEC_K_MULT || '12';

const jestBin = path.join(__dirname, '..', 'node_modules', 'jest', 'bin', 'jest.js');
const r = spawnSync(
  process.execPath,
  [
    '--experimental-vm-modules',
    jestBin,
    '--testPathPatterns=./tests/benchmarks/longmem',
    '--runInBand',
  ],
  { stdio: 'inherit', cwd: path.join(__dirname, '..'), env: process.env },
);

process.exit(r.status === null ? 1 : r.status);
