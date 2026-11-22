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
#   * The half-bar case (grid-policy.ts decides whether to trust the bars): a
#     4/4 body whose downbeats split between beat 1 and beat 3 reports a
#     half-bar share near 1. Its bar line is the model's majority unless a
#     clear drop lands one or two beats after it (choose_phase), and a grid
#     that passes the agreement gate is never touched (place_half_bar). The
#     drop detector itself (drop_beat) needs scipy: those checks skip without
#     it (the host's python), and run in the analyzer image.

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

# Dense detections where the segment starts (hi-hats in an intro: beats AND
# offbeats for 16 beats), then the beat alone: the grid is the beat's, never
# the hi-hats' double time (measured: a 124 BPM techno track read 248).
beat = grid(124.0, 0.5, 600, jitter_ms=4, seed=6)
offbeats = beat[:16] + (60.0 / 124.0) / 2
f = aw.fit_grid(np.sort(np.concatenate([beat, offbeats])), downbeats_of(beat, 4, 0))
check("dense intro: the grid is the beat's tempo", abs(60 / f["segments"][0]["period_s"] - 124.0) < 0.1,
      [round(60 / s["period_s"], 2) for s in f["segments"]])
check("dense intro: one segment over the track", len(f["segments"]) == 1 and f["segments"][0]["last_k"] >= 590,
      [(round(60 / s["period_s"], 1), s["last_k"]) for s in f["segments"]])
# A real double-time track (every detection on the fast grid) stays fast.
fast = grid(174.0, 0.2, 500, jitter_ms=3, seed=7)
f = aw.fit_grid(fast, None)
check("a real 174 BPM track is not folded", abs(60 / f["segments"][0]["period_s"] - 174.0) < 0.1, 60 / f["segments"][0]["period_s"])
# Beats detected only every other beat (a sparse tracker) fold to that spacing:
# the grid follows the detections it has.
sparse = grid(124.0, 0.5, 600)[::2]
f = aw.fit_grid(sparse, None)
check("every-other-beat detections: their own spacing", abs(60 / f["segments"][0]["period_s"] - 62.0) < 0.1, 60 / f["segments"][0]["period_s"])

# The GPU memory rules (BeatGridder): the cache goes back after every track,
# and an out-of-memory answer reruns that track on the CPU with the same
# checkpoint. A stub torch stands in when the real one is absent.
import types  # noqa: E402

_real_torch = sys.modules.get("torch")
_stub = types.ModuleType("torch")
_freed = []


class _OOM(RuntimeError):
    pass


_stub.cuda = types.SimpleNamespace(OutOfMemoryError=_OOM, empty_cache=lambda: _freed.append(1))
sys.modules["torch"] = _stub
try:
    g = aw.BeatGridder()
    g.device, g.model = "cuda", "final0"
    g._run_gpu = lambda y, sr: ([0.5, 1.0], [0.5])
    out = g(np.zeros(100), 10)
    check("gpu: the cache is freed after a track", len(_freed) == 1, _freed)
    check("gpu: answers as before", list(out[0]) == [0.5, 1.0] and list(out[1]) == [0.5], out)

    def _boom(y, sr):
        raise _OOM("CUDA out of memory")

    cpu_calls = []
    g._run_gpu = _boom
    g._cpu = lambda y, sr: (cpu_calls.append(1) or ([0.25, 0.75], [0.25]))
    _freed.clear()
    out = g(np.zeros(100), 10)
    check("gpu out of memory: that track reruns on the cpu", cpu_calls == [1] and list(out[0]) == [0.25, 0.75], (cpu_calls, out))
    check("gpu out of memory: the cache is freed before the rerun and after", len(_freed) == 2, _freed)
    check("the cpu rerun keeps the model name (one model per library)", g.model == "final0", g.model)

    def _other(y, sr):
        raise ValueError("bad audio")

    g._run_gpu = _other
    try:
        g(np.zeros(100), 10)
        check("another error is not swallowed", False)
    except ValueError:
        check("another error is not swallowed", True)
finally:
    if _real_torch is not None:
        sys.modules["torch"] = _real_torch
    else:
        del sys.modules["torch"]

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
check("3/4: no half-bar score (4/4 only)", f["downbeat_halfbar"] is None, f["downbeat_halfbar"])

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

print("half-bar case")


def bar_downbeats(beats, phases):
    """One downbeat per bar j at beat 4j + phases[j]."""
    return np.asarray([beats[4 * j + ph] for j, ph in enumerate(phases) if 4 * j + ph < len(beats)])


# Clean 4/4: every downbeat on one phase.
b = grid(124.0, 0.48, 400, jitter_ms=4, seed=11)
f = aw.fit_grid(b, downbeats_of(b, 4, 1))
check("clean 4/4: half-bar 1.0", f["downbeat_halfbar"] == 1.0, f["downbeat_halfbar"])
check("clean 4/4: downbeat on beat 1", abs(f["segments"][0]["downbeat_s"] - b[1]) < 0.01, f["segments"][0]["downbeat_s"])

# 200 bars, five in eight on phase 2, the rest on phase 0: the fit keeps the
# majority (phase 2) and reports the half-bar share.
bars = 200
b = grid(124.0, 0.48, bars * 4, jitter_ms=4, seed=12)
phases = [2 if j % 8 < 5 else 0 for j in range(bars)]
f = aw.fit_grid(b, bar_downbeats(b, phases))
check("half-bar body: agreement under the bars gate", f["downbeat_agreement"] < 0.75, f["downbeat_agreement"])
check("half-bar body: half-bar 1.0", f["downbeat_halfbar"] == 1.0, f["downbeat_halfbar"])
check("half-bar body: the fit keeps the majority phase", abs(f["segments"][0]["downbeat_s"] - b[2]) < 0.01,
      f["segments"][0]["downbeat_s"])
check("half-bar body: main segment 0", f["main_segment"] == 0, f["main_segment"])

# A half-bar share under the threshold: a quarter of the 4-bar runs a beat off.
b = grid(124.0, 0.48, bars * 4, jitter_ms=4, seed=15)
phases = [[0, 2, 1, 2][(j // 4) % 4] for j in range(bars)]
f = aw.fit_grid(b, bar_downbeats(b, phases))
check("a beat off: half-bar under 0.9", f["downbeat_halfbar"] < aw.GRID_MIN_HALFBAR, f["downbeat_halfbar"])

print("choose_phase")
M = aw.GRID_DROP_MIN_DB
check("d 0: the majority, by the drop", aw.choose_phase(1, 9, M + 5, 4) == (1, "drop"), aw.choose_phase(1, 9, M + 5, 4))
check("d 1: the other half", aw.choose_phase(1, 10, M + 5, 4) == (3, "drop"), aw.choose_phase(1, 10, M + 5, 4))
check("d 2: the other half", aw.choose_phase(1, 11, M + 5, 4) == (3, "drop"), aw.choose_phase(1, 11, M + 5, 4))
check("d 3 (a beat early): the majority", aw.choose_phase(1, 12, M + 5, 4) == (1, "drop"), aw.choose_phase(1, 12, M + 5, 4))
check("d 1 from phase 3 wraps to 1", aw.choose_phase(3, 4, M, 4) == (1, "drop"), aw.choose_phase(3, 4, M, 4))
check("no drop: the majority", aw.choose_phase(2, None, None, 4) == (2, "majority"), aw.choose_phase(2, None, None, 4))
check("a weak drop: the majority", aw.choose_phase(2, 13, M - 0.1, 4) == (2, "majority"),
      aw.choose_phase(2, 13, M - 0.1, 4))
check("outside 4/4: the majority, no source", aw.choose_phase(1, 5, M + 5, 3) == (1, None), aw.choose_phase(1, 5, M + 5, 3))

print("place_half_bar gate")
SR = 22050
PERIOD = 0.5  # 120 BPM
NBEATS = 256  # 128 s
exact = PERIOD * np.arange(NBEATS)
silent = np.zeros(int(NBEATS * PERIOD * SR), dtype=np.float32)

# A grid that passes the agreement gate is never touched (no drop computed).
f = aw.fit_grid(exact, downbeats_of(exact, 4, 1))
before = dict(f["segments"][0])
aw.place_half_bar(f, silent, SR)
check("passing grid: untouched", f["segments"][0] == before, (f["segments"][0], before))
check("passing grid: no drop, no source", (f["downbeat_drop_db"], f["downbeat_phase"]) == (None, None),
      (f["downbeat_drop_db"], f["downbeat_phase"]))
# A half-bar share under 0.9 is not the case either.
phases = [[0, 2, 1, 2][(j // 4) % 4] for j in range(NBEATS // 4)]
f = aw.fit_grid(exact, bar_downbeats(exact, phases))
before = dict(f["segments"][0])
aw.place_half_bar(f, silent, SR)
check("half-bar under 0.9: untouched, no source", f["segments"][0] == before and f["downbeat_phase"] is None,
      (f["segments"][0], f["downbeat_phase"]))
# 3/4 is never the case.
f = aw.fit_grid(exact, downbeats_of(exact, 3, 0))
aw.place_half_bar(f, silent, SR)
check("not 4/4: no source", f["downbeat_phase"] is None, (f["beats_per_bar"], f["downbeat_phase"]))
# The answer carries both fields, null when not computed.
ans = aw.grid_answer(f, NBEATS, NBEATS * PERIOD, "final0")
check("answer: drop fields null outside the case", (ans["downbeat_drop_db"], ans["downbeat_phase"]) == (None, None),
      (ans["downbeat_drop_db"], ans["downbeat_phase"]))

try:
    import scipy.signal  # noqa: F401
    HAVE_SCIPY = True
except ImportError:
    HAVE_SCIPY = False

if not HAVE_SCIPY:
    print("  - skip: drop_beat and the drop placement need scipy (the analyzer image has it)")
else:
    print("drop_beat")

    def low_end(drop_k, low=0.05, high=0.5):
        """A 60 Hz decaying burst on every beat, `low` before beat drop_k and
        `high` from it (None: `low` throughout)."""
        n = len(silent)
        y = np.zeros(n, dtype=np.float64)
        L = int(0.1 * SR)
        burst = np.sin(2 * np.pi * 60 * np.arange(L) / SR) * np.exp(-np.arange(L) / (0.03 * SR))
        for i, t in enumerate(exact):
            a = int(round(t * SR))
            amp = high if drop_k is not None and i >= drop_k else low
            y[a:a + L] += amp * burst[:max(0, min(L, n - a))]
        return y.astype(np.float32)

    for k in (128, 127):
        k_hat, jump = aw.drop_beat(low_end(k), SR, exact)
        check(f"drop at beat {k}: found on it", k_hat == k, k_hat)
        check(f"drop at beat {k}: a 20 dB jump", jump is not None and abs(jump - 20.0) < 1.5, jump)
    k_hat, jump = aw.drop_beat(low_end(None), SR, exact)
    check("no drop: a jump near 0 dB", jump is not None and abs(jump) < 1.0, (k_hat, jump))
    short = exact[:120]  # 60 s: no beat 45 s from both ends
    check("too short: (None, None)", aw.drop_beat(low_end(None)[: int(60 * SR)], SR, short) == (None, None),
          aw.drop_beat(low_end(None)[: int(60 * SR)], SR, short))
    y = low_end(128)
    whole = aw.beat_low_db(y, SR, exact, block_s=1e9)
    blocks = aw.beat_low_db(y, SR, exact, block_s=10.0)
    check("block filtering reads as the whole signal (0.01 dB)", float(np.max(np.abs(whole - blocks))) < 0.01,
          float(np.max(np.abs(whole - blocks))))

    print("place_half_bar")
    # Majority on phase 0 (five bars in eight), the rest on phase 2.
    phases = [0 if j % 8 < 5 else 2 for j in range(NBEATS // 4)]
    for k, want, label in ((128, 0, "d 0: majority kept"), (129, 2, "d 1: moved two beats"),
                           (130, 2, "d 2: moved two beats"), (127, 0, "d 3: majority kept")):
        f = aw.fit_grid(exact, bar_downbeats(exact, phases))
        aw.place_half_bar(f, low_end(k), SR)
        m = f["segments"][0]
        got = int(round((m["downbeat_s"] - m["anchor_s"]) / m["period_s"]))
        check(f"{label} (phase {want})", got == want and f["downbeat_phase"] == "drop", (got, f["downbeat_phase"]))
        check(f"{label}: the jump reported", abs(f["downbeat_drop_db"] - 20.0) < 1.5, f["downbeat_drop_db"])
    f = aw.fit_grid(exact, bar_downbeats(exact, phases))
    aw.place_half_bar(f, low_end(None), SR)
    m = f["segments"][0]
    check("no clear drop: majority, source 'majority'",
          abs(m["downbeat_s"] - m["anchor_s"]) < 1e-9 and f["downbeat_phase"] == "majority",
          (m["downbeat_s"], f["downbeat_phase"]))
    ans = aw.grid_answer(f, NBEATS, NBEATS * PERIOD, "final0")
    check("answer: the weak jump to 1 place, source 'majority'",
          ans["downbeat_phase"] == "majority" and ans["downbeat_drop_db"] == round(f["downbeat_drop_db"], 1),
          (ans["downbeat_drop_db"], ans["downbeat_phase"]))

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
check("answer: half-bar to 3 places, no drop fields outside the case",
      (ans["downbeat_halfbar"], ans["downbeat_drop_db"], ans["downbeat_phase"]) == (1.0, None, None),
      (ans.get("downbeat_halfbar"), ans.get("downbeat_drop_db"), ans.get("downbeat_phase")))
# The main tempo is the segment spanning the most TIME, not the most beats.
a = grid(90.0, 0.0, 120)          # 80 s
c = grid(180.0, a[-1] + 1 / 3, 200)  # 66 s, more beats
f = aw.fit_grid(np.concatenate([a, c]), None)
ans = aw.grid_answer(f, 320, 150.0, "small0")
check("answer: main tempo by time span", abs(ans["bpm"] - 90.0) < 0.1, ans["bpm"])
check("answer: no downbeats, no scores", ans["downbeat_halfbar"] is None and ans["downbeat_phase"] is None,
      (ans["downbeat_halfbar"], ans["downbeat_phase"]))

if FAILED:
    print(f"\n{len(FAILED)} check(s) failed")
    sys.exit(1)
print("\n✓ analyzer_grid_test.py passed")
