#!/usr/bin/env python3
# The per-bar structure measure (analyze_worker.facet_structure and its pure
# core measure_structure): kick level and count, bass, mids, highs, whole-band
# level and melody per bar of the track's own beat grid, which the controller
# sends in the request (the worker never reads the DB).
# Run: `npm test -- analyzer-python` (one of the shim's SUITES), or
# `python3 scripts/analyzer_structure_test.py` (exit 0 = pass). Needs numpy
# and scipy (skips cleanly without them: the host's python has neither); the
# real-ffmpeg cases skip without ffmpeg.
#
# Why this is pinned (the operator's DJ recipe reads these arrays through
# controller/src/music/structure-policy.ts):
#   * a 4-on-the-floor track with a low-beat intro (kick 10 dB down, no bass,
#     a noise-like mid) then the hard kick with bass and a tonal mid line reads
#     as such per bar: kick -10 then 0 dB, bass absent then present, and the
#     tonal bars score a higher melody than the noise bars;
#   * the bars follow the grid's own downbeat phase and segments; a bar the
#     audio does not hold whole is left out;
#   * files over 30 minutes are `too-long` (DJ sets are no transition
#     material), from the grid's length without a decode, or from the decode;
#   * no grid in the request is `no-grid`; an ffmpeg failure names no URL
#     credentials;
#   * a structure-only request never opens the capped download and runs in
#     the one-shot --whole-file lane.

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
    import scipy.signal  # noqa: F401
except ImportError:  # pragma: no cover — the analyzer image has both
    print("skip: numpy/scipy not installed")
    sys.exit(0)

import analyze_worker as aw  # noqa: E402

FAILED = []


def check(name, cond, detail: object = ""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name} {detail}")
        FAILED.append(name)


SR = 22050
BPM = 120.0
PER = 60.0 / BPM          # 0.5 s a beat
BAR = 4 * PER             # 2 s a bar
T0 = 0.25                 # the first downbeat
INTRO, MAIN = 8, 16       # bars
rng = np.random.default_rng(7)


def kick(amp):
    n = int(0.15 * SR)
    t = np.arange(n) / SR
    f = 50 + 60 * np.exp(-t * 30)  # a pitch drop, like a real kick
    return amp * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 25)


def band_noise(n, lo, hi, amp):
    sos = scipy.signal.butter(4, [lo, hi], "bandpass", fs=SR, output="sos")
    x = scipy.signal.sosfilt(sos, rng.standard_normal(n))
    return amp * x / (np.sqrt(np.mean(x ** 2)) + 1e-12)


def synth():
    """INTRO bars of a soft kick (-10 dB) over band-limited noise in the mids,
    then MAIN bars of the hard kick, a 60 Hz bass between the kicks, noise
    above 6 kHz and a two-note tonal line in the mids, then a short tail."""
    dur = T0 + (INTRO + MAIN) * BAR + 0.3
    y = np.zeros(int(dur * SR))
    for b in range(INTRO + MAIN):
        main = b >= INTRO
        b0 = T0 + b * BAR
        for j in range(4):
            c = int((b0 + j * PER) * SR)
            k = kick(1.0 if main else 10 ** (-10 / 20))
            y[c:c + len(k)] += k
            if main:
                # bass between the kicks (beat fraction 0.4-0.9)
                s0, s1 = int((b0 + (j + 0.4) * PER) * SR), int((b0 + (j + 0.9) * PER) * SR)
                t = np.arange(s1 - s0) / SR
                y[s0:s1] += 0.5 * np.sin(2 * np.pi * 60 * t) * np.hanning(s1 - s0)
        i0, i1 = int(b0 * SR), int((b0 + BAR) * SR)
        t = np.arange(i1 - i0) / SR
        if main:
            y[i0:i1] += band_noise(i1 - i0, 6000, 10000, 0.08)  # hats/air
            note = 440.0 if b % 2 else 660.0
            y[i0:i1] += 0.2 * np.sin(2 * np.pi * note * t) + 0.1 * np.sin(2 * np.pi * 2 * note * t)
        else:
            y[i0:i1] += band_noise(i1 - i0, 300, 3000, 0.12)
    return (y / np.max(np.abs(y)) * 0.8).astype(np.float32)


def grid_req(beats=None, downbeat_ms=None, decoded_ms=None, bpb=4):
    beats = beats if beats is not None else (INTRO + MAIN) * 4
    return {
        "beats_per_bar": bpb,
        "decoded_ms": decoded_ms,
        "segments": [{"anchorMs": int(T0 * 1000), "periodUs": int(PER * 1e6), "beats": beats,
                      "downbeatMs": int(T0 * 1000) if downbeat_ms is None else downbeat_ms}],
    }


def write_wav(path, y):
    pcm = (np.clip(y, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


y = synth()

print("measure_structure")
ans = aw.measure_structure(y, SR, aw.parse_structure_grid(grid_req()))
check("an answer", ans is not None)
assert ans is not None
n = INTRO + MAIN
check("one bar per grid bar the audio holds", ans and len(ans["kick"]) == n, ans and len(ans["kick"]))
check("every array the same length",
      ans and all(len(ans[k]) == n for k in ("kick", "kicks", "bass", "mid", "high", "level", "melody")))
check("one run from the first downbeat", ans and ans["runs"] == [[250, 2_000_000, n]], ans and ans["runs"])
check("the version", ans and ans["structure_version"] == aw.STRUCTURE_VERSION)
check("rounded to 0.5 dB", ans and all((v * 2) == int(v * 2) for k in ("kick", "bass", "mid", "high", "level") for v in ans[k]))
intro_k, main_k = ans["kick"][:INTRO], ans["kick"][INTRO:]
check("intro kick about -10 dB", all(-11.5 <= v <= -8.5 for v in intro_k), intro_k)
check("main kick at full strength", all(-1.5 <= v <= 1.0 for v in main_k), main_k)
check("four kicks a bar in the main part", all(v == 4 for v in ans["kicks"][INTRO:]), ans["kicks"])
check("no bass in the intro", all(v < -20 for v in ans["bass"][:INTRO]), ans["bass"][:INTRO])
check("bass in the main part", all(v > -3 for v in ans["bass"][INTRO:]), ans["bass"][INTRO:])
check("highs only in the main part", max(ans["high"][:INTRO]) < min(ans["high"][INTRO:]) - 10, ans["high"])
check("the tonal bars score a higher melody than the noise bars",
      min(ans["melody"][INTRO:]) > max(ans["melody"][:INTRO]) + 3, ans["melody"])
check("melody of noise bars near 0 dB", all(0 <= v < 4 for v in ans["melody"][:INTRO]), ans["melody"][:INTRO])
check("the decoded length", ans["decoded_ms"] == int(round(len(y) / SR * 1000)))
# The full section from the rules' point of view: bars 9+ pass every threshold.
full = [ans["kick"][i] >= -4 and ans["bass"][i] > -12 and ans["mid"][i] >= -5.5 and ans["kicks"][i] >= 3 for i in range(n)]
check("the rules see the full section from bar 9", full == [False] * INTRO + [True] * MAIN, full)

# The downbeat phase is the grid's: a downbeat one beat later shifts every bar.
late = aw.measure_structure(y, SR, aw.parse_structure_grid(grid_req(downbeat_ms=int((T0 + PER) * 1000))))
check("bars on the grid's downbeat phase", late and late["runs"][0][0] == int((T0 + PER) * 1000), late and late["runs"])
check("a bar the audio does not hold whole is left out", late and len(late["kick"]) == n - 1, late and len(late["kick"]))
# A grid of two segments at different tempos: two runs.
two = aw.parse_structure_grid({"beats_per_bar": 4, "segments": [
    {"anchorMs": 250, "periodUs": 500000, "beats": 32, "downbeatMs": 250},
    {"anchorMs": 16250, "periodUs": 480000, "beats": 40, "downbeatMs": 16250}]})
two_ans = aw.measure_structure(y, SR, two)
check("one run per segment", two_ans and [r[1] for r in two_ans["runs"]] == [2_000_000, 1_920_000], two_ans and two_ans["runs"])
check("a segment without a downbeat gives no bars", aw.measure_structure(y, SR, aw.parse_structure_grid(
    {"beats_per_bar": 4, "segments": [{"anchorMs": 250, "periodUs": 500000, "beats": 96, "downbeatMs": None}]})) is None)
check("silence has bars at the floor, not a crash",
      (lambda a: a is not None and all(v == 0 for v in a["melody"]))(aw.measure_structure(np.zeros_like(y), SR, aw.parse_structure_grid(grid_req()))))

# The filters run block by block (bounded memory): the same bars as one
# block over the whole track.
block = aw.STRUCTURE_BLOCK_S
try:
    aw.STRUCTURE_BLOCK_S = 10.0
    small = aw.measure_structure(y, SR, aw.parse_structure_grid(grid_req()))
    aw.STRUCTURE_BLOCK_S = 1e9
    whole = aw.measure_structure(y, SR, aw.parse_structure_grid(grid_req()))
finally:
    aw.STRUCTURE_BLOCK_S = block
check("blocks of bars read as the whole track", small == whole,
      [(k, small[k], whole[k]) for k in small if small[k] != whole[k]][:2])

print("parse_structure_grid")
check("no grid is None", aw.parse_structure_grid(None) is None)
check("no segments is None", aw.parse_structure_grid({"beats_per_bar": 4, "segments": []}) is None)
check("a bad metre is None", aw.parse_structure_grid({**grid_req(), "beats_per_bar": 11}) is None)
check("a bad period is None", aw.parse_structure_grid({"beats_per_bar": 4, "segments": [
    {"anchorMs": 0, "periodUs": 0, "beats": 8, "downbeatMs": 0}]}) is None)

print("facet_structure")
check("no source", aw.facet_structure(None, grid_req()) == {"status": "unmeasurable", "reason": "no-whole-file-source"})
check("no grid", aw.facet_structure("/x.flac", None) == {"status": "unmeasurable", "reason": "no-grid"})
long_grid = grid_req(decoded_ms=int(aw.STRUCTURE_MAX_SECONDS * 1000) + 60_000)
check("a grid over 30 min is too-long without a decode",
      aw.facet_structure("http://music.example/rest/stream?u=x&t=SECRET", long_grid) == {"status": "unmeasurable", "reason": "too-long"})

if shutil.which("ffmpeg"):
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "t.wav")
        write_wav(p, y)
        real = aw.facet_structure(p, grid_req())
        check("real ffmpeg: ok", real.get("status") == "ok", real)
        if real.get("status") == "ok":
            d = real["data"]
            check("real ffmpeg: the same bars as the array path", len(d["kick"]) == n and d["kicks"] == ans["kicks"])
            check("real ffmpeg: kick levels within 0.5 dB of the array path",
                  max(abs(a - b) for a, b in zip(d["kick"], ans["kick"])) <= 0.5, (d["kick"], ans["kick"]))
        # The decode guard: a cap below the file's length reads it as too long.
        cap = aw.STRUCTURE_MAX_SECONDS
        aw.STRUCTURE_MAX_SECONDS = 20.0
        try:
            check("real ffmpeg: the decoded length guard", aw.facet_structure(p, grid_req()) == {"status": "unmeasurable", "reason": "too-long"})
        finally:
            aw.STRUCTURE_MAX_SECONDS = cap
        bad = aw.facet_structure("http://127.0.0.1:9/rest/stream.view?u=admin&t=SECRETTOKEN&s=salt", grid_req())
        check("an unreachable stream fails", bad.get("status") == "failed", bad)
        check("its reason names no credentials", "SECRET" not in json.dumps(bad) and "admin" not in json.dumps(bad), bad)

        # The facet request path: structure alone never opens the capped
        # download (librosa None would crash if it did), and the one-shot lane
        # serves it.
        req = {"id": "1", "path": p, "complete": True, "facets": ["structure"], "structure_grid": grid_req()}
        out = aw.analyze_facet_request(None, req)
        check("analyze_facet_request: structure alone, whole-file source",
              out["source"]["kind"] == "whole-file" and out["facets"]["structure"]["status"] == "ok", out.get("source"))
        sin, sout = io.StringIO(json.dumps(req) + "\n"), io.StringIO()
        aw.whole_file_once(sin, sout)
        once = json.loads(sout.getvalue())
        check("--whole-file serves structure", once.get("ok") is True and once["facets"]["structure"]["status"] == "ok", once.get("error"))
        sin, sout = io.StringIO(json.dumps({**req, "facets": ["structure", "edges"]}) + "\n"), io.StringIO()
        aw.whole_file_once(sin, sout)
        both = json.loads(sout.getvalue())
        check("--whole-file serves structure with edges", both.get("ok") is True and set(both["facets"]) == {"structure", "edges"}, both.get("error"))
        # A real one-shot process, as the sidecar runs it.
        proc = subprocess.run([sys.executable, aw.__file__, "--whole-file"], input=json.dumps(req) + "\n",
                              capture_output=True, text=True, timeout=120)
        line = json.loads(proc.stdout.strip().splitlines()[-1])
        check("a --whole-file process answers structure", line.get("ok") is True and line["facets"]["structure"]["status"] == "ok", proc.stderr[-300:])
else:
    print("  (skip: ffmpeg not on PATH — the real-decode cases)")

print("capability")
check("structure_capable is numpy + scipy + ffmpeg", aw.structure_capable() == (shutil.which("ffmpeg") is not None))
check("structure is a facet name", "structure" in aw.FACET_NAMES)
check("structure rides the whole-file lane", "structure" in aw.WHOLE_FILE_LANE_FACETS)

if FAILED:
    print(f"\n✗ {len(FAILED)} failed: {', '.join(FAILED)}")
    sys.exit(1)
print("\n✓ analyzer_structure_test.py passed")
