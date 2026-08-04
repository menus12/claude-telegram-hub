import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Bundle the channel into a single self-contained dist/main.js so the installed
// plugin has NO runtime node_modules dependency. Third-party deps (MCP SDK, ws)
// and the workspace package @claude-telegram-hub/protocol are inlined; only Node
// built-ins stay external. Protocol is aliased to its source so this build needs
// no prior tsc emit.
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

await build({
  entryPoints: [here("./src/main.ts")],
  outfile: here("./dist/main.cjs"),
  bundle: true,
  platform: "node",
  // CommonJS output: bundled deps mix ESM (MCP SDK) and CJS (ws, which does
  // dynamic `require` of Node built-ins). CJS gives a native `require`, avoiding
  // ESM-interop shims. The plugin runs it via `node …/main.cjs`.
  format: "cjs",
  target: "node18",
  sourcemap: true,
  // esbuild preserves the entry file's shebang (main.ts) on line 1.
  // ws optional native accelerators — not required; ws falls back without them.
  external: ["bufferutil", "utf-8-validate"],
  alias: {
    "@claude-telegram-hub/protocol": here("../protocol/src/index.ts"),
  },
  logLevel: "info",
});
