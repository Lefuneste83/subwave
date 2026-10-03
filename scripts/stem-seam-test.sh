#!/usr/bin/env bash
# Stem-seam render harness: does a rendered stem blend keep the beat across its
# two clip seams (X → clip → Y)? An objective stand-in for listening.
#
#   scripts/stem-seam-test.sh
#
# What it does:
#   1. Builds two synthetic 120 BPM click tracks (X, Y), fakes the stem cache for
#      X's tail and Y's head, and renders the blend clip with the REAL worker
#      (controller/scripts/analyze_worker.py render_transition).
#   2. Takes the cue points two ways:
#        verbatim   — the worker's blend_start / in_cue stamped as is (the
#                     behaviour before fix/stem-seam-overlap);
#        controller — whatever controller/src/broadcast/stem-seam.ts in THIS
#                     checkout stamps (what the station airs).
#   3. Plays X → clip → Y through Liquidsoap with the station's seam: cue_cut,
#      then a 0.3 s `cross` whose fades span the buffered length (as radio.liq's
#      dj_transition does), and records the result.
#   4. Finds every click onset and checks the beat grid around both seams. All
#      sources sit on one continuous 0.5 s grid, so an interval that is not
#      500 ms (± the tolerance below) is a stutter: a bar shortened by the
#      overlap, or a beat lost or doubled.
#
# Residual: `cross` checks a track's remaining time once per audio frame, so it
# starts a transition up to one frame AFTER the point it was asked for and the
# overlap comes out short by that much (the `overlap buffered` lines). The
# incoming side then lands that much late. The controller cannot know the frame
# phase when it stamps the cues, so a fixed checkout still shows a beat error
# of at most one frame: measured +40 ms / +17 ms on Liquidsoap 2.2.4 (0.04 s
# frames). Production's 2.4.5 is the version that matters, hence the default
# image, and SEAM_TOLERANCE_MS (default 25) sets what passes. The bug this
# guards against is about 200 ms.
#
# Verdict: PASS when the controller mode keeps the grid. The verbatim mode is
# the before picture, printed for comparison: it is expected to show a beat
# about 200 ms late at each seam. (Copied into a checkout without
# stem-seam.ts, only verbatim runs, which is then that checkout's behaviour.)
#
# Needs: python3 with numpy + soundfile (or ANALYZER_IMAGE=<an analyzer image>,
# which has both); Node >= 22.6 or the controller's node_modules (tsx) for the
# controller cues; and Liquidsoap: docker with LIQ_IMAGE (default
# savonet/liquidsoap:v2.4.5, production's version), or LIQ_BIN=<path> for a
# local binary (add LIQ_NATIVE_CUES=1 on 2.2, whose cue_cut differs).
#
# Output: scripts/.fx-render/stemseam/ (gitignored with the other renders).

set -euo pipefail

IMAGE="${LIQ_IMAGE:-savonet/liquidsoap:v2.4.5}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK="$HERE/.fx-render/stemseam"
mkdir -p "$WORK"
SEAM_TS="$ROOT/controller/src/broadcast/stem-seam.ts"

liq() { # liq <script.liq> — W is the work dir as the script sees it
  if [ -n "${LIQ_BIN:-}" ]; then
    W="$WORK" "$LIQ_BIN" "$WORK/$1" 2>&1
  else
    docker run --rm --user "$(id -u):$(id -g)" -v "$WORK":/work -e W=/work "$IMAGE" "/work/$1" 2>&1
  fi
}

py() { # py <args…> — paths are passed as /work and /repo, mapped either way
  if [ -z "${ANALYZER_IMAGE:-}" ] && python3 -c 'import numpy, soundfile' 2>/dev/null; then
    local args=() a
    for a in "$@"; do a="${a//\/work/$WORK}"; args+=("${a//\/repo/$ROOT}"); done
    python3 "$HERE/stem-seam-test.py" "${args[@]}"
  elif [ -n "${ANALYZER_IMAGE:-}" ]; then
    docker run --rm --user "$(id -u):$(id -g)" -v "$WORK":/work -v "$ROOT":/repo:ro \
      --entrypoint python3 "$ANALYZER_IMAGE" /repo/scripts/stem-seam-test.py "$@"
  else
    echo "need python3 with numpy + soundfile (pip install numpy soundfile), or ANALYZER_IMAGE=<analyzer image>" >&2
    return 1
  fi
}

controller_cues() { # controller_cues <blend_start> <in_cue> → "<out_cue> <in_cue>"
  local js="import('$SEAM_TS').then(m => { const c = m.clipSeamCues({ blendStartSec: +process.argv[1], inCueSec: +process.argv[2] }); console.log(c.outCueSec, c.inCueSec); })"
  if node --experimental-strip-types --no-warnings -e "$js" "$1" "$2" 2>/dev/null; then return 0; fi
  local tsx="$ROOT/controller/node_modules/.bin/tsx"
  [ -x "$tsx" ] || { echo "need Node ≥ 22.6 or controller/node_modules (npm ci in controller/)" >&2; return 1; }
  "$tsx" -e "$js" "$1" "$2"
}

# radio.liq calls cue_cut on the music source; Liquidsoap 2.2 cuts requests
# natively and its cue_cut takes other arguments, so LIQ_NATIVE_CUES=1 skips it.
if [ "${LIQ_NATIVE_CUES:-0}" = 1 ]; then CUE_CUT_LINE="q"; else CUE_CUT_LINE="cue_cut(q)"; fi

render_mode() { # render_mode <name> <x_cue_out> <y_cue_in>
  cat > "$WORK/seam-$1.liq" <<LIQ
settings.log.stdout := true
settings.log.level := 3
settings.init.allow_root := true
w = environment.get(default="/work", "W")
q = request.queue(id="q")
list.iter(fun (p) -> ignore(q.push(request.create(p))), [
  'annotate:title="X",liq_cue_out="$2":#{w}/x.flac',
  'annotate:title="clip",subwave_clip="1":#{w}/clip.wav',
  'annotate:title="Y",liq_cue_in="$3":#{w}/y.flac'
])
music = ${CUE_CUT_LINE}
# radio.liq dj_transition's plain branch: fade over what is actually buffered.
def t(a, b) =
  buffered = min(source.remaining(a.source), source.remaining(b.source))
  d = if buffered > 0. and buffered < 600. then buffered else 0.3 end
  log("SEAM: #{a.metadata['title']} -> #{b.metadata['title']} d=#{d}")
  add(normalize=false, [fade.out(duration=d, a.source), fade.in(duration=d, b.source)])
end
music = cross(duration=0.3, t, music)
output.file(%wav, fallible=true, "#{w}/seam-$1.wav", music)
clock.assign_new(sync="none", [music])
thread.run(delay=20., fun() -> shutdown())
LIQ
  rm -f "$WORK/seam-$1.wav"
  local log
  log=$(liq "seam-$1.liq") || { echo "$log" | tail -20; echo "Liquidsoap failed ($1)"; return 1; }
  # d = the overlap Liquidsoap actually buffered. The cues assume 0.3; the
  # shortfall (0.3 - d) is the residual beat error after that seam.
  echo "$log" | grep -E "SEAM: (X|clip) ->" | sed 's/^.*SEAM:/    overlap buffered:/' || true
  [ -s "$WORK/seam-$1.wav" ] || { echo "$log" | tail -20; echo "no render for $1"; return 1; }
}

echo "== preparing synthetic tracks + rendering the clip with analyze_worker.render_transition"
plan=$(py prepare /work /repo) || { echo "$plan"; echo "STEMSEAM FAIL — worker render failed"; exit 1; }
echo "   worker: $plan"
read -r blend in_cue clip_sec < <(python3 -c 'import json,sys; p=json.loads(sys.argv[1]); print(p["blend_start_sec"], p["in_cue_sec"], p["clip_sec"])' "$plan")
seam_y=$(awk -v a="$blend" -v b="$clip_sec" 'BEGIN { print a + b }')

modes=("verbatim $blend $in_cue")
if [ -f "$SEAM_TS" ]; then
  read -r c_out c_in < <(controller_cues "$blend" "$in_cue")
  modes+=("controller $c_out $c_in")
else
  echo "   (no controller/src/broadcast/stem-seam.ts in this checkout: it stamps verbatim)"
fi

verdict=0
for m in "${modes[@]}"; do
  read -r name out_cue y_cue <<<"$m"
  echo
  echo "== $name: X liq_cue_out=$out_cue, Y liq_cue_in=$y_cue"
  render_mode "$name" "$out_cue" "$y_cue"
  if py analyse "/work/seam-$name.wav" "$blend" "$seam_y" "${SEAM_TOLERANCE_MS:-25}"; then
    echo "   $name: beat grid intact across both seams"
  else
    echo "   $name: STUTTER — the beat grid breaks at a seam"
    # verbatim is the known-bad reference when the fix is present; on its own
    # (a pre-fix checkout) it is the checkout's real behaviour, so it fails.
    if [ "$name" = controller ] || [ "${#modes[@]}" -eq 1 ]; then verdict=1; fi
  fi
done

echo
if [ "$verdict" = 0 ]; then
  echo "STEMSEAM PASS — the cues this checkout stamps keep the beat across both clip seams"
else
  echo "STEMSEAM FAIL — the cues this checkout stamps break the beat at a clip seam"
fi
echo "Renders: $WORK/seam-*.wav"
exit "$verdict"
