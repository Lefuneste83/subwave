#!/usr/bin/env python3
"""Stem-seam render harness, Python half (driven by scripts/stem-seam-test.sh).

  stem-seam-test.py prepare <work-dir> <repo-dir>
      Writes two synthetic 120 BPM tracks (X, Y) as FLAC, fakes the stem cache
      for X's tail and Y's head, and renders the blend clip with the REAL
      worker (controller/scripts/analyze_worker.py render_transition). Prints
      the worker's blend_start_sec / in_cue_sec / clip_sec as JSON.

  stem-seam-test.py analyse <wav> <seam-x> <seam-y> [tolerance-ms]
      Finds the click onsets in a Liquidsoap render and checks the beat grid
      around the two clip seams. Exit 0 = every interval is one beat, within
      the tolerance (default 25 ms).

Why clicks: the script cannot hear a stutter, but a stutter on a beat grid is
an interval that is not one beat (a bar shortened by the seam overlap, a beat
played twice or not at all). Every source here — X's drums, the borrowed loop
the worker builds from them, Y's drums — sits on ONE continuous 0.5 s grid
when the seams are right, so any interval off 0.5 s is the seam's fault.
"""

import json
import os
import sys

import numpy as np
import soundfile as sf

SR = 44100
BEAT = 0.5          # 120 BPM
BAR = 4 * BEAT
X_DUR = 60.0
Y_DUR = 60.0
OUTRO_SECONDS = 20.0  # analyze_worker default: tail window = decoded dur - 20 s
HEAD_SECONDS = 40.0   # analyze_worker default ANALYZE_SECONDS
WIND_DOWN = 54.0      # X's outro "wind-down" start: the last usable bar ends here

SEAM_WINDOW = 2.5     # seconds either side of a seam that are checked


def click_train(dur, level_down=0.5, level_beat=0.35, freq=2000.0):
    """A decaying tone burst on every beat, accented on the downbeat."""
    n = int(dur * SR)
    out = np.zeros(n, np.float32)
    k = np.arange(int(0.04 * SR))
    burst = (np.sin(2 * np.pi * freq * k / SR) * np.exp(-k / (0.006 * SR))).astype(np.float32)
    t = 0.0
    i = 0
    while t < dur - 0.05:
        a = int(round(t * SR))
        m = min(burst.size, n - a)
        out[a:a + m] += burst[:m] * (level_down if i % 4 == 0 else level_beat)
        t += BEAT
        i += 1
    return out


def pad(dur, freq, level=0.08):
    t = np.arange(int(dur * SR)) / SR
    return (np.sin(2 * np.pi * freq * t) * level).astype(np.float32)


def stereo(x):
    return np.stack([x, x], axis=1)


def write_stems(dirpath, window, stems):
    os.makedirs(dirpath, exist_ok=True)
    for name, data in stems.items():
        sf.write(os.path.join(dirpath, f"{window}-{name}.flac"), stereo(data), SR, subtype="PCM_16", format="FLAC")


def prepare(work, repo):
    os.makedirs(work, exist_ok=True)
    # Full tracks = sum of their stems, exactly what the station would decode.
    x_st = {"drums": click_train(X_DUR), "other": pad(X_DUR, 110.0),
            "bass": np.zeros(int(X_DUR * SR), np.float32), "vocals": np.zeros(int(X_DUR * SR), np.float32)}
    y_st = {"drums": click_train(Y_DUR, freq=3000.0), "other": pad(Y_DUR, 165.0),
            "bass": np.zeros(int(Y_DUR * SR), np.float32), "vocals": np.zeros(int(Y_DUR * SR), np.float32)}
    sf.write(os.path.join(work, "x.flac"), stereo(sum(x_st.values())), SR, subtype="PCM_16", format="FLAC")
    sf.write(os.path.join(work, "y.flac"), stereo(sum(y_st.values())), SR, subtype="PCM_16", format="FLAC")

    tail_start = X_DUR - OUTRO_SECONDS
    a = int(tail_start * SR)
    write_stems(os.path.join(work, "stems-x"), "tail", {k: v[a:] for k, v in x_st.items()})
    with open(os.path.join(work, "stems-x", "tail-meta.json"), "w") as f:
        json.dump({"tail_start_sec": tail_start, "duration_sec": X_DUR}, f)
    h = int(HEAD_SECONDS * SR)
    write_stems(os.path.join(work, "stems-y"), "head", {k: v[:h] for k, v in y_st.items()})

    sys.path.insert(0, os.path.join(repo, "controller", "scripts"))
    import analyze_worker  # noqa: E402 — stdlib-only at import; numpy/soundfile inside the op

    out_bars = [int(round(b * 1000)) for b in np.arange(tail_start, X_DUR + 1e-9, BAR)]
    in_bars = [int(round(b * 1000)) for b in np.arange(0.0, HEAD_SECONDS - 1.0, BAR)]
    res = analyze_worker.render_transition({
        "out": {"stems_dir": os.path.join(work, "stems-x"), "duration_s": X_DUR,
                "outro": {"start_ms": int(WIND_DOWN * 1000), "bars": out_bars, "lufs": None},
                "gain_db": 0.0},
        "in": {"stems_dir": os.path.join(work, "stems-y"), "bars": in_bars, "gain_db": 0.0},
        "out_dir": work,
        "clip_name": "clip.wav",
        "target_lufs": -14,
    })
    if not res.get("ok"):
        print(json.dumps(res))
        sys.exit(1)
    print(json.dumps({k: res[k] for k in ("blend_start_sec", "in_cue_sec", "clip_sec")}))


def onsets(path):
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    x = data.mean(axis=1)
    # The clicks are 2-3 kHz bursts over 110/165 Hz pads: a first difference
    # keeps the bursts and all but removes the pads.
    d = np.abs(np.diff(x, prepend=x[:1]))
    w = int(0.002 * sr)
    env = np.convolve(d, np.ones(w, np.float32) / w, mode="same")
    thr = 0.15 * float(env.max())
    found = []
    i = 0
    refractory = int(0.12 * sr)
    while i < env.size:
        if env[i] > thr:
            found.append(i / sr)  # the attack: first crossing of the threshold
            i += refractory
        else:
            i += 1
    return found


def analyse(path, seam_x, seam_y, tol_ms):
    """Check the beat grid in a window around each seam. Only the seams: the
    clip's own interior has a deliberate ride-out fade on the borrowed loop,
    whose quietest clicks sit under the onset threshold."""
    tol = tol_ms / 1000.0
    ts = onsets(path)
    worst_all = 0.0
    bad = 0
    for label, seam in (("X -> clip", seam_x), ("clip -> Y", seam_y)):
        win = [t for t in ts if seam - SEAM_WINDOW <= t <= seam + SEAM_WINDOW]
        worst = 0.0
        print(f"  {label} (around {seam:.2f}s): {len(win)} onsets")
        for a, b in zip(win, win[1:]):
            err = (b - a) - BEAT
            worst = max(worst, abs(err))
            mark = ""
            if abs(err) > tol:
                bad += 1
                mark = "  <-- " + ("short: a bar cut" if err < 0 else "long: a beat late or lost")
            if abs(err) > 0.001 or abs(a - seam) < 0.6:
                print(f"    {a:8.3f}s -> {b:8.3f}s  {(b - a) * 1000:6.1f} ms  ({err * 1000:+6.1f}){mark}")
        if len(win) < 2 * SEAM_WINDOW / BEAT - 2:
            bad += 1
            print("    too few onsets: the render is shorter than expected or a seam went silent")
        print(f"    worst beat error at this seam: {worst * 1000:.1f} ms")
        worst_all = max(worst_all, worst)
    print(f"  worst beat error: {worst_all * 1000:.1f} ms (tolerance {tol_ms:.0f} ms)")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "prepare":
        prepare(sys.argv[2], sys.argv[3])
    elif cmd == "analyse":
        analyse(sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]) if len(sys.argv) > 5 else 25.0)
    else:
        print(__doc__)
        sys.exit(2)
