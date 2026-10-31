#!/usr/bin/env bash
# Builds and packs every package the way `pnpm publish` would, installs the tarballs into a fresh
# project outside the monorepo and checks that the published entry points, the CLI and the studio work.
set -euo pipefail
cd "$(dirname "$0")/.."
WORK=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK"' EXIT
mkdir -p "$WORK/tgz" "$WORK/app/assets/fonts"

pnpm -r build
for p in packages/*/; do (cd "$p" && pnpm pack --pack-destination "$WORK/tgz" >/dev/null); done

cp examples/hello/index.ts "$WORK/app/hello.ts"
cp examples/generative-poster/index.ts "$WORK/app/poster.ts"
cp examples/beat-viz/beat.ts "$WORK/app/beat.ts"
cp assets/fonts/Cairo-Bold.ttf "$WORK/app/assets/fonts/"
cd "$WORK/app"
# Every @tasweerix/* dependency must come from the local tarballs, not the registry.
node -e '
const fs = require("fs");
const tgz = Object.fromEntries(fs.readdirSync("../tgz").map((f) => [JSON.parse(require("child_process").execSync(`tar xzf ../tgz/${f} -O package/package.json`)).name, `file:../tgz/${f}`]));
fs.writeFileSync("package.json", JSON.stringify({ name: "packed-check", private: true, type: "module", dependencies: tgz, overrides: tgz }, null, 2));'
npm install --no-audit --no-fund --loglevel=error

echo "Importing every published entry point"
node --input-type=module -e '
import { readFileSync } from "node:fs";
const deps = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).dependencies);
for (const name of deps) {
  const { exports } = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8"));
  for (const sub of Object.keys(exports).filter((k) => k !== "./package.json")) await import(name + sub.slice(1));
}
const { loadReference } = await import("@tasweerix/ai/node");
if (!loadReference().includes("<doc name=")) throw new Error("@tasweerix/ai shipped without its API docs");
const { bundledPluginHost } = await import("@tasweerix/audio/node");
bundledPluginHost();
console.log(`✔ ${deps.length} packages import`);'

npx tasweerix still hello.ts -f 45 -o hello.png
npx tasweerix svg poster.ts -o poster.svg
npx tasweerix audio beat.ts -o beat.wav

echo "Checking the MCP server"
node --input-type=module -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "packed-check", version: "0" });
await client.connect(new StdioClientTransport({ command: "node_modules/.bin/tasweerix-mcp" }));
const docs = await client.callTool({ name: "read_docs", arguments: { topic: "guide" } });
if (!docs.content[0].text.includes("# Guide")) throw new Error("read_docs returned no guide");
const still = await client.callTool({ name: "render_still", arguments: { entry: "hello.ts", frame: 45, output: "mcp.png" } });
if (still.isError || !still.content.some((c) => c.type === "image")) throw new Error(`render_still failed: ${JSON.stringify(still.content)}`);
await client.close();
console.log("✔ MCP server reads the docs and renders a frame");'

echo "Starting the studio"
node_modules/.bin/tasweerix studio . --entry hello.ts --port 4873 > studio.log 2>&1 &
# The studio prints a link with its access token once it listens.
for _ in $(seq 60); do grep -q 'token=' studio.log && break; sleep 1; done
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' studio.log | head -1 | cut -d= -f2)
test -n "$TOKEN" || { cat studio.log; echo "✖ studio did not print its link"; exit 1; }
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4873/studio.js)" = 401 || { echo "✖ studio served a request without its token"; exit 1; }
AUTH=(-H "x-tasweerix-token: $TOKEN")
curl -sf "${AUTH[@]}" http://127.0.0.1:4873/studio.js -o studio.js
test -s studio.js || { cat studio.log; echo "✖ studio did not serve its UI"; exit 1; }
curl -sf "${AUTH[@]}" http://127.0.0.1:4873/api/state | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
if (s.error) { console.error(`✖ studio preview failed: ${s.error}`); process.exit(1); }'
curl -sf "${AUTH[@]}" http://127.0.0.1:4873/api/preview.js -o preview.js && test -s preview.js
echo "✔ studio serves its UI and preview, and only with its token"
echo "Packed packages work outside the monorepo"
