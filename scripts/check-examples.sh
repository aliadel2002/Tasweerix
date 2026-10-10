#!/usr/bin/env bash
# Renders one representative frame (and the audio mix where relevant) of every example.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${OUT:-out/examples}
mkdir -p "$OUT"
tx() { node packages/cli/bin/tasweerix.mjs "$@"; }
tx still examples/hello/index.ts -f 45 -o "$OUT/hello.png"
tx still examples/promo/index.ts -f 150 -o "$OUT/promo.png"
tx still examples/beat-viz/index.ts -f 60 -o "$OUT/beat-viz.png"
tx still examples/arabic-kinetic/index.ts --root . -f 90 -o "$OUT/arabic-kinetic.png"
tx still examples/photo-retouch/index.ts -o "$OUT/photo-retouch.jpg"
tx still examples/generative-poster/index.ts --root . -o "$OUT/generative-poster.png"
tx svg examples/generative-poster/index.ts --root . -o "$OUT/generative-poster.svg"
tx still examples/smart-edit/index.ts -f 60 -o "$OUT/smart-edit.png"
tx still examples/data-viz/index.ts -f 150 -o "$OUT/data-viz.png"
tx audio examples/podcast/index.ts -o "$OUT/podcast.mp3"
tx audio examples/beat-viz/beat.ts -o "$OUT/beat.wav"
echo "All examples rendered to $OUT"
