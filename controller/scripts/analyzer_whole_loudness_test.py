#!/usr/bin/env python3
# Unit tests for the whole-file loudness measurement (B13): the ebur128 summary
# parser, and the one-shot `analyze_worker.py --loudness <src>` mode the sidecar
# and the local backend both run per track.
# Run: `python3 scripts/analyzer_whole_loudness_test.py` (exit 0 = pass), and
# via scripts/analyzer-python.test.ts as part of `npm test`.
#
# Pure stdlib. The parser cases need nothing; the end-to-end cases generate
# their own audio with ffmpeg and are skipped (with a line saying so) where
# ffmpeg is absent, because the measurement IS ffmpeg.
#
# Why this is pinned:
#
#   * Loudness and true peak are ONE measurement. A summary with a loudness but
#     no usable peak must come back with neither: a loudness alone would let a
#     boost through with no ceiling, which is the failure this pass removes.
#   * Digital silence prints -70 LUFS and -inf peaks. That is "no loudness"
#     (unity gain), never a -70 LUFS track to be boosted by the full cap.
#   * The figures are the WHOLE file's: a quiet opening followed by a loud
#     passage must read as loud, which is exactly what the 40 s window got
#     wrong.

import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import analyze_worker as aw  # noqa: E402

failures = 0


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        failures += 1
        print(f"  ✗ {name}\n      {e}")


SUMMARY = """[Parsed_ebur128_0 @ 0x55] Summary:

  Integrated loudness:
    I:         -12.0 LUFS
    Threshold: -22.3 LUFS

  Loudness range:
    LRA:         7.4 LU
    Threshold: -32.4 LUFS
    LRA low:   -17.9 LUFS
    LRA high:  -10.5 LUFS

  Sample peak:
    Peak:       -0.5 dBFS

  True peak:
    Peak:       -0.3 dBFS
"""

SILENCE = """[Parsed_ebur128_0 @ 0x55] Summary:

  Integrated loudness:
    I:         -70.0 LUFS
    Threshold:   0.0 LUFS

  Loudness range:
    LRA:         0.0 LU

  Sample peak:
    Peak:       -inf dBFS

  True peak:
    Peak:       -inf dBFS
"""


def t_parses_summary():
    fig = aw.parse_ebur128_summary("frame lines...\n" + SUMMARY)
    assert fig == {"loudness_lufs": -12.0, "lra_lu": 7.4, "sample_peak_db": -0.5, "true_peak_db": -0.3}, fig


def t_silence_is_no_loudness():
    fig = aw.parse_ebur128_summary(SILENCE)
    assert fig["loudness_lufs"] is None and fig["true_peak_db"] is None, fig


def t_only_the_final_block_counts():
    early = SUMMARY.replace("-12.0 LUFS", "-40.0 LUFS")
    fig = aw.parse_ebur128_summary(early + "\n" + SUMMARY)
    assert fig["loudness_lufs"] == -12.0, fig


def t_missing_fields_read_none():
    fig = aw.parse_ebur128_summary("Summary:\n  nothing useful\n")
    assert all(v is None for v in fig.values()), fig


def run_cli(src):
    p = subprocess.run(
        [sys.executable, os.path.join(HERE, "analyze_worker.py"), "--loudness", src],
        capture_output=True, text=True, timeout=120,
    )
    lines = [l for l in p.stdout.strip().splitlines() if l.strip()]
    assert lines, f"no output (stderr: {p.stderr[-300:]})"
    return json.loads(lines[-1])


def gen(path, filtergraph, seconds):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", filtergraph, "-t", str(seconds), path],
        check=True,
    )


def with_ffmpeg(fn):
    def wrapped():
        if not shutil.which("ffmpeg"):
            print("      (skipped: ffmpeg not on PATH)")
            return
        tmp = tempfile.mkdtemp(prefix="sw-loud-")
        try:
            fn(tmp)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return wrapped


@with_ffmpeg
def t_cli_measures_whole_file(tmp):
    # 50 s at -30 dBFS, then 20 s at -6 dBFS: the 40 s window reads only the
    # quiet part; the whole file must read the loud ending's peak.
    quiet = os.path.join(tmp, "q.wav")
    loud = os.path.join(tmp, "l.wav")
    both = os.path.join(tmp, "both.flac")
    gen(quiet, "sine=frequency=1000:sample_rate=44100,volume=-30dB", 50)
    gen(loud, "sine=frequency=1000:sample_rate=44100,volume=-6dB", 20)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", quiet, "-i", loud, "-filter_complex",
         "[0:a][1:a]concat=n=2:v=0:a=1", both],
        check=True,
    )
    msg = run_cli(both)
    assert msg["ok"] is True, msg
    # ffmpeg's sine source is 1/8 of full scale (-18 dBFS); -6 dB more puts
    # the loud ending's peak at about -24 dBFS, the quiet opening's at -48.
    assert -25.5 < msg["true_peak_db"] < -22.5, msg
    assert msg["loudness_lufs"] is not None and msg["loudness_lufs"] > -40, msg
    assert isinstance(msg["seconds"], (int, float)), msg


@with_ffmpeg
def t_cli_silence(tmp):
    path = os.path.join(tmp, "s.flac")
    gen(path, "anullsrc=r=44100:cl=stereo", 5)
    msg = run_cli(path)
    assert msg["ok"] is True and msg["loudness_lufs"] is None and msg["true_peak_db"] is None, msg


@with_ffmpeg
def t_cli_reports_failure(tmp):
    msg = run_cli(os.path.join(tmp, "missing.flac"))
    assert msg["ok"] is False and "ffmpeg exited" in msg["error"], msg


test("parses the ebur128 summary", t_parses_summary)
test("digital silence reads as no loudness", t_silence_is_no_loudness)
test("only the final summary block counts", t_only_the_final_block_counts)
test("missing fields read None", t_missing_fields_read_none)
test("--loudness measures the whole file, not the opening", t_cli_measures_whole_file)
test("--loudness on silence returns neither figure", t_cli_silence)
test("--loudness reports a failure as ok:false, never a traceback", t_cli_reports_failure)

if failures:
    print(f"✗ {failures} failure(s)")
    sys.exit(1)
print("✓ analyzer_whole_loudness_test.py passed")
