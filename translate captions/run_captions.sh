#!/usr/bin/env bash
# Add target-language captions to an ALREADY-DUBBED video.
# Transcribes the dub's audio (so captions == exactly what's spoken) and burns TikTok-style captions.
#
# Usage:
#   FAL_KEY=your_key ./run_captions.sh <dubbed_video.mp4> <output.mp4> [scribe_lang=spa]
#   ENGINE=whisper   ./run_captions.sh <dubbed_video.mp4> <output.mp4> [whisper_lang=es]   # no fal needed
#
# ENGINE=scribe (default) -> fal Scribe (needs FAL_KEY).  ENGINE=whisper -> Modal Whisper (needs `modal` CLI).
set -euo pipefail
DUB="${1:?usage: run_captions.sh <dubbed_video.mp4> <output.mp4> [lang]}"
OUT="${2:?usage: run_captions.sh <dubbed_video.mp4> <output.mp4> [lang]}"
LANG="${3:-spa}"
ENGINE="${ENGINE:-scribe}"
PY="${PYTHON:-python3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"; AUDIO="$WORK/dub.mp3"; WORDS="$WORK/words.json"

echo "[1/3] extract dub audio"
ffmpeg -nostdin -v error -i "$DUB" -vn -c:a libmp3lame -q:a 2 "$AUDIO" -y

echo "[2/3] transcribe dub (verbatim + word timings) via $ENGINE"
if [ "$ENGINE" = "whisper" ]; then
  $PY -m modal run "$HERE/whisper_modal.py" --audio "$AUDIO" --out "$WORDS" --lang "$LANG"   # lang here = 2-letter (es)
else
  : "${FAL_KEY:?set FAL_KEY for Scribe (or use ENGINE=whisper)}"
  FAL_KEY="$FAL_KEY" AUDIO="$AUDIO" OUT="$WORDS" LANG_CODE="$LANG" $PY "$HERE/transcribe_scribe.py"  # lang here = Scribe code (spa)
fi

echo "[3/3] burn caption groups onto the dub"
WORDS="$WORDS" VIDEO="$DUB" OUT="$OUT" $PY "$HERE/burn_captions.py"
echo "DONE -> $OUT"
rm -rf "$WORK"
