#!/usr/bin/env bash
# Revised Caption Removal — end-to-end runner.
#
# Removes burned-in captions from a short vertical video and writes a clean copy.
#
# Usage:
#   FAL_KEY=your_fal_key ./run_pipeline.sh <input_video.mp4> <output_video.mp4>
#
# Requires: ffmpeg/ffprobe on PATH, and a python with the `modal` CLI installed & authenticated
# (`pip install modal && modal token new`). Set PYTHON to point at that interpreter if needed.
set -euo pipefail

IN="${1:?usage: run_pipeline.sh <input.mp4> <output.mp4>}"
OUT="${2:?usage: run_pipeline.sh <input.mp4> <output.mp4>}"
: "${FAL_KEY:?set FAL_KEY to your fal.ai API key}"
PY="${PYTHON:-python3}"          # a python that has the `modal` CLI
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
CFR="$WORK/cfr.mp4"; MASK="$WORK/mask.mp4"

echo "[1/3] normalize -> 30fps constant-frame-rate (LTX + mask assume 30fps)"
ffmpeg -nostdin -v error -i "$IN" -r 30 -c:v libx264 -crf 18 -pix_fmt yuv420p -an "$CFR" -y

echo "[2/3] locate caption box + build fixed-box mask   (Modal L4, sampled OCR — seconds)"
$PY -m modal run "$HERE/boxmask_v4.py" --video "$CFR" --out "$MASK"
#   For a tighter / moving-object-aware box (slower, OCRs every frame) use instead:
#   $PY -m modal run "$HERE/boxmask_v3.py" --video "$CFR" --out "$MASK"

echo "[3/3] LTX-2.3 inpaint (fal) + mask-only fade composite + remux original audio"
FAL_KEY="$FAL_KEY" VIDEO="$CFR" MASK="$MASK" AUDIO_SRC="$IN" OUT="$OUT" $PY "$HERE/ltx_run_fade.py"

echo "DONE -> $OUT"
rm -rf "$WORK"
