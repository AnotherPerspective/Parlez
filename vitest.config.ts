import * as os from "node:os";
import * as path from "node:path";

import { defineConfig } from "vitest/config";

// Offline tests never touch the real mailbox: a fake heartbeat left there
// showed up as a second live After Effects to the server in use (2026-11-15,
// "untitled [t-24d6b6a9]", and every call without an instance got
// NO_INSTANCE). Only the E2E run, which talks to the real After Effects,
// keeps the default.
const testRuntime =
  process.env.AE_MCP_E2E === "1"
    ? {}
    : { AE_MCP_RUNTIME_DIR: path.join(os.tmpdir(), `parlez-test-${process.pid}`, "runtime") };

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // After Effects is a single shared instance driven through one
    // request/response file pair: run suites sequentially so concurrent
    // suites never race over runtime/request.json.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 60_000,
    globals: false,
    env: testRuntime,
    reporters: "default",
  },
});
