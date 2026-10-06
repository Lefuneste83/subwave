#!/usr/bin/env python3
"""Stems share marker on the analyzer side (controller music/stem-cache.ts).

An analyzer on another machine mounts the stems share itself. If that mount is
missing, the mount point is still there and stems written into it fill the
local disk while the controller sees nothing. With stems_require_marker the
worker writes only when the cache root carries the .subwave-stems marker, and
the sidecar forwards the flag (pinned in analyzer_sidecar_contract_test.py).
Pure stdlib: no numpy, librosa or models.
"""

import os
import sys
import tempfile
import types

sys.modules.setdefault("numpy", types.ModuleType("numpy"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402

failures = 0


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 - a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err}")


root = tempfile.mkdtemp(prefix="subwave-stems-marker-")
track_dir = os.path.join(root, "track-1")


def no_marker():
    path = os.path.join(root, aw.STEMS_MARKER)
    if os.path.exists(path):
        os.remove(path)


def with_marker():
    with open(os.path.join(root, aw.STEMS_MARKER), "w") as f:
        f.write("{}\n")


def t_marked():
    with_marker()
    assert aw.stems_root_marked(track_dir)
    assert aw.stems_root_marked(track_dir + "/")  # trailing slash
    assert aw.stems_dir_to_write(track_dir, True) == track_dir


def t_unmarked_refused():
    no_marker()
    assert not aw.stems_root_marked(track_dir)
    assert aw.stems_dir_to_write(track_dir, True) is None


def t_old_controller_unchanged():
    # An older controller never sends the flag and never creates a marker:
    # its writes must keep working.
    no_marker()
    assert aw.stems_dir_to_write(track_dir, False) == track_dir
    assert aw.stems_dir_to_write(track_dir, None) == track_dir


def t_no_stems_requested():
    assert aw.stems_dir_to_write(None, True) is None


print("analyzer stems marker")
test("marked root: stems written", t_marked)
test("unmarked root with require_marker: no stems written", t_unmarked_refused)
test("no flag (older controller): unchanged", t_old_controller_unchanged)
test("no stems_dir: nothing to write", t_no_stems_requested)

if failures:
    print(f"\n{failures} analyzer stems marker test(s) failed")
    sys.exit(1)
print("\nall analyzer stems marker tests passed")
