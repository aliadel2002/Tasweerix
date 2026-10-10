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

echo "Starting the studio"
node_modules/.bin/tasweerix studio . --entry hello.ts --port 4873 > studio.log 2>&1 &
for _ in $(seq 60); do curl -sf http://127.0.0.1:4873/studio.js -o studio.js && break; sleep 1; done
test -s studio.js || { cat studio.log; echo "✖ studio did not serve its UI"; exit 1; }
curl -sf http://127.0.0.1:4873/api/state | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
if (s.error) { console.error(`✖ studio preview failed: ${s.error}`); process.exit(1); }'
curl -sf http://127.0.0.1:4873/api/preview.js -o preview.js && test -s preview.js
echo "✔ studio serves its UI and preview"
echo "Packed packages work outside the monorepo"
