#!/usr/bin/env python3
# The whole-track beat grid's FIT (analyze_worker.fit_grid / grid_answer).
# Run: `npm test -- analyzer-python` (one of the shim's SUITES), or
# `python3 scripts/analyzer_grid_test.py` (exit 0 = pass). numpy only: the
# model (Beat This!) is not needed, the fit is fed synthetic beat times.
#
# Why this is pinned:
#
#   * The grid is stored fitted (anchor + period per segment), not one value
#     per beat, so the fit decides what every later reader sees. It must keep
#     ONE segment through what a beat tracker does on real music: a few ms of
#     jitter, a missed beat, a stray detection between two beats, a breakdown
#     with no beats at all.
#   * It must open a new segment where the tempo really moves (a tempo change,
#     a DJ mix), and only there.
#   * The tempo is the measured beat spacing, never clamped into a BPM range
#     (octave-safe rule): a 70 BPM track stays 70, a 174 BPM one stays 174.
#   * Downbeats become a phase on the grid; beats per bar is read from the
#     downbeat spacing (4/4 and 3/4 both).

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
except ImportError:  # pragma: no cover — the shim installs numpy
    print("skip: numpy not installed")
    sys.exit(0)

import analyze_worker as aw  # noqa: E402

FAILED = []


def check(name, cond, detail: object = ""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name} {detail}")
        FAILED.append(name)


def grid(bpm, start, count, jitter_ms=0.0, seed=0):
    rng = np.random.default_rng(seed)
    p = 60.0 / bpm
    t = start + p * np.arange(count)
    if jitter_ms:
        t = t + rng.uniform(-jitter_ms, jitter_ms, size=count) / 1000.0
    return t


def downbeats_of(beats, bpb, phase):
    return np.asarray([b for i, b in enumerate(beats) if i % bpb == phase])


print("fit_grid")

# A steady 124 BPM track with ±6 ms jitter: one segment, the right tempo.
b = grid(124.0, 0.48, 400, jitter_ms=6)
f = aw.fit_grid(b, downbeats_of(b, 4, 0))
check("steady: one segment", f is not None and len(f["segments"]) == 1, f and len(f["segments"]))
p = f["segments"][0]["period_s"]
check("steady: period within 0.05 %", abs(60.0 / p - 124.0) < 0.062, 60.0 / p)
check("steady: every beat on the grid", f["coverage"] == 1.0, f["coverage"])
check("steady: residual is the jitter, not drift", f["residual_s"] < 0.006, f["residual_s"])
check("steady: 4 beats per bar, downbeat on beat 0",
      f["beats_per_bar"] == 4 and abs(f["segments"][0]["downbeat_s"] - b[0]) < 0.01,
      (f["beats_per_bar"], f["segments"][0]["downbeat_s"]))

# Missed beats and stray detections between beats do not split the grid.
b2 = np.delete(b, [20, 21, 90, 200, 201, 202])
strays = (b[[50, 150, 300]] + b[[51, 151, 301]]) / 2  # halfway between two beats
b2 = np.sort(np.concatenate([b2, strays]))
f = aw.fit_grid(b2, downbeats_of(b, 4, 0))
check("missed + stray beats: still one segment", len(f["segments"]) == 1, len(f["segments"]))
check("missed + stray beats: the strays are the only beats off the grid",
      abs(f["coverage"] - (len(b2) - 3) / len(b2)) < 1e-9, f["coverage"])

# A breakdown: 32 beats with no detection at all keep the same grid.
b3 = np.concatenate([b[:150], b[182:]])
f = aw.fit_grid(b3, None)
check("breakdown (no beats for 32): one segment across it", len(f["segments"]) == 1, len(f["segments"]))
check("breakdown: the grid's last index counts the silent beats", f["segments"][0]["last_k"] == 399,
      f["segments"][0]["last_k"])

# A breakdown where the tracker follows the OFFBEAT for 20 beats, then the beat
# comes back on the first grid (measured on real club tracks): one grid, the
# offbeat stretch dropped.
main = grid(112.0, 0.03, 700, jitter_ms=5, seed=4)
period = 60.0 / 112.0
off = main[330:350] + period / 2
b4 = np.sort(np.concatenate([main[:330], off, main[350:]]))
f = aw.fit_grid(b4, downbeats_of(main, 4, 0))
check("offbeat breakdown: one grid across it", len(f["segments"]) == 1, [round(s["anchor_s"], 2) for s in f["segments"]])
check("offbeat breakdown: the grid spans the whole track", f["segments"][0]["last_k"] == 699, f["segments"][0]["last_k"])
check("offbeat breakdown: only the offbeat stretch is off the grid", abs(f["coverage"] - 680 / 700) < 1e-9, f["coverage"])
# The same tempo coming back OFF the old grid (a new take, an edit) stays apart.
shifted = grid(112.0, main[340] + period * 0.4, 300, seed=5)
f = aw.fit_grid(np.concatenate([main[:340], shifted]), None)
check("same tempo, new phase: two segments", len(f["segments"]) == 2, len(f["segments"]))

# A tempo change 120 → 128 BPM: two segments, each with its own tempo.
a = grid(120.0, 0.0, 128)
c = grid(128.0, a[-1] + 60.0 / 128.0, 160)
f = aw.fit_grid(np.concatenate([a, c]), None)
segs = f["segments"]
check("tempo change: two segments", len(segs) == 2, len(segs))
check("tempo change: 120 then 128",
      len(segs) == 2 and abs(60 / segs[0]["period_s"] - 120) < 0.1 and abs(60 / segs[1]["period_s"] - 128) < 0.1,
      [round(60 / s["period_s"], 2) for s in segs])

# Octave-safe: slow and fast tempos are reported as measured, never folded.
for bpm in (70.0, 174.0, 52.5):
    f = aw.fit_grid(grid(bpm, 0.1, 200), None)
    check(f"octave-safe: {bpm} BPM stays {bpm}", abs(60 / f["segments"][0]["period_s"] - bpm) < 0.05,
          60 / f["segments"][0]["period_s"])

# 3/4: downbeat every third beat, phase 1.
b = grid(96.0, 0.2, 240, jitter_ms=4, seed=3)
f = aw.fit_grid(b, downbeats_of(b, 3, 1))
check("3/4: three beats per bar", f["beats_per_bar"] == 3, f["beats_per_bar"])
check("3/4: downbeat on beat 1", abs(f["segments"][0]["downbeat_s"] - b[1]) < 0.01, f["segments"][0]["downbeat_s"])
check("3/4: agreement 1.0", f["downbeat_agreement"] == 1.0, f["downbeat_agreement"])

# A grid that holds only part of the track still counts while it holds most
# beats: 300 steady beats then 100 of noise.
b = np.concatenate([grid(120.0, 0.0, 300), np.sort(np.random.default_rng(9).uniform(150.5, 200, size=100))])
f = aw.fit_grid(b, None)
check("steady then noise: the steady part is the grid", f is not None and abs(60 / f["segments"][0]["period_s"] - 120) < 0.05,
      f and [round(60 / s["period_s"], 2) for s in f["segments"]])

# Too few beats: no grid.
check("too few beats: None", aw.fit_grid(grid(120, 0, 10), None) is None)
# Random onsets (no pulse): no segment survives, so no grid.
rng = np.random.default_rng(7)
noise = np.sort(rng.uniform(0, 240, size=300))
check("no pulse: None", aw.fit_grid(noise, None) is None, aw.fit_grid(noise, None))

print("grid_answer")
b = grid(124.0, 0.48, 400, jitter_ms=6)
f = aw.fit_grid(b, downbeats_of(b, 4, 2))
ans = aw.grid_answer(f, len(b), 400 * 60 / 124 + 1.0, "final0")
check("answer: version, engine, model", (ans["grid_version"], ans["engine"], ans["model"]) == (1, "beat_this", "final0"), ans)
check("answer: bpm to 2 decimals", abs(ans["bpm"] - 124.0) < 0.07, ans["bpm"])
check("answer: integers in ms / us", all(isinstance(s["anchorMs"], int) and isinstance(s["periodUs"], int)
                                          for s in ans["segments"]), ans["segments"])
check("answer: downbeat on beat 2", abs(ans["segments"][0]["downbeatMs"] - round(b[2] * 1000)) <= 10,
      ans["segments"][0]["downbeatMs"])
check("answer: the main segment covers nearly the whole track", ans["main_share"] > 0.95, ans["main_share"])
check("answer: compact (a few hundred bytes)", len(str(ans)) < 600, len(str(ans)))
# The main tempo is the segment spanning the most TIME, not the most beats.
a = grid(90.0, 0.0, 120)          # 80 s
c = grid(180.0, a[-1] + 1 / 3, 200)  # 66 s, more beats
f = aw.fit_grid(np.concatenate([a, c]), None)
ans = aw.grid_answer(f, 320, 150.0, "small0")
check("answer: main tempo by time span", abs(ans["bpm"] - 90.0) < 0.1, ans["bpm"])

if FAILED:
    print(f"\n{len(FAILED)} check(s) failed")
    sys.exit(1)
print("\n✓ analyzer_grid_test.py passed")
