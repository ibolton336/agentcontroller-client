#!/usr/bin/env bash
# to-gif.sh <in.webm> <out.gif> [speed] [fps] [width] [trim-lead-seconds]
# Palette-method ffmpeg conversion; speed >1 compresses wall-clock waits.
set -euo pipefail
IN="$1"; OUT="$2"; SPEED="${3:-1.0}"; FPS="${4:-14}"; WIDTH="${5:-1000}"; TRIM="${6:-0}"
PAL="$(mktemp -t pal).png"
VF="setpts=PTS/${SPEED},fps=${FPS},scale=${WIDTH}:-1:flags=lanczos"
ffmpeg -loglevel error -y -ss "$TRIM" -i "$IN" -vf "${VF},palettegen=stats_mode=diff" "$PAL"
ffmpeg -loglevel error -y -ss "$TRIM" -i "$IN" -i "$PAL" \
  -filter_complex "[0:v]${VF}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  "$OUT"
rm -f "$PAL"
ls -la "$OUT"
