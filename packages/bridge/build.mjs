import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Bundle the bridge into one self-contained dist/main.cjs, like the channel: the
// MCP SDK, ws, zod and the workspace packages (protocol, channel's HubClient) are
// inlined from source, so the image needs no runtime node_modules for it.
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

await build({
  entryPoints: [here("./src/main.ts")],
  outfile: here("./dist/main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
  external: ["bufferutil", "utf-8-validate"],
  alias: {
    "@claude-telegram-hub/protocol": here("../protocol/src/index.ts"),
    "@claude-telegram-hub/channel": here("../channel/src/index.ts"),
  },
  logLevel: "info",
});
