import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests in child processes so we can pass --expose-gc without affecting
    // the parent process. This allows trackHeap() to call gc() for accurate
    // live-object measurements (excluding dead-but-not-yet-collected old-space).
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--expose-gc"],
      },
    },
  },
});
