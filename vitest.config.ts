import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Run typecheck/tests against package *source* (no pre-build needed). The real
// dist is produced by `tsc -b` for actual consumers.
export default defineConfig({
  resolve: {
    alias: {
      "@claude-telegram-hub/protocol": fileURLToPath(
        new URL("./packages/protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
  },
});
