#!/usr/bin/env python3
# Unit test for the bounded wait on a CUDA out-of-memory at model load
# (analyze_worker.retry_on_cuda_oom and the three loaders that use it). Pure
# stdlib: fake loaders raise OOM-shaped errors, the sleep is injected, so it
# runs anywhere, with or without torch or a GPU, and never really sleeps.
# Run: `python3 scripts/analyzer_oom_retry_test.py` (exit 0 = pass).
#
# What this pins down:
#   - a load that runs out of GPU memory, while another process on the card is
#     still giving its memory back, is retried after a short wait and loads:
#     one log line per retry, one when the retry succeeds, the sleeps follow
#     the named schedule and nothing really sleeps;
#   - the wait is bounded: an OOM on every attempt raises the ORIGINAL error
#     after len(schedule) + 1 attempts, so the loader's latch and its message
#     are exactly what they were before the retry existed;
#   - any other error is not retried (one attempt, no sleep), and torch's own
#     OutOfMemoryError type counts as OOM whatever its message;
#   - CLAP (get_embedder), Beat This! (get_gridder) and Demucs
#     (get_vocal_detector) each retry INSIDE their own error handling, before
#     the load failure is latched;
#   - the whole schedule stays well under the controller's analyze request
#     timeout (ANALYZE_REQUEST_TIMEOUT_MS, 120 s), even when the device
#     self-test's wait and a model load's wait stack in one request.

import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402

failures = 0

OOM = (
    "CUDA out of memory. Tried to allocate 148.00 MiB (GPU 0; 7.63 GiB total "
    "capacity; 14.31 MiB free)"
)


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 — a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {type(err).__name__}: {err}")


class Harness:
    """Swaps the worker's log and sleep for recorders, restoring them after."""

    def __enter__(self):
        self.lines, self.sleeps = [], []
        self._saved = (aw.log, aw._sleep)
        aw.log = self.lines.append
        aw._sleep = self.sleeps.append
        return self

    def __exit__(self, *_exc):
        aw.log, aw._sleep = self._saved
        return False


def scripted(errors, result="loaded"):
    """A loader that raises errors[i] on call i, then returns `result`."""
    calls = {"n": 0}

    def load():
        i = calls["n"]
        calls["n"] += 1
        if i < len(errors):
            raise errors[i]
        return result

    return load, calls


def retry_lines(lines):
    return [l for l in lines if "CUDA out of memory, retrying in" in l]


# ── The helper ──────────────────────────────────────────────────────────────

def oom_then_success():
    load, calls = scripted([RuntimeError(OOM), RuntimeError(OOM)])
    with Harness() as h:
        assert aw.retry_on_cuda_oom(load, "CLAP load") == "loaded"
    assert calls["n"] == 3, calls
    delays = list(aw.CUDA_OOM_RETRY_DELAYS_S)
    assert h.sleeps == delays[:2], h.sleeps
    retries = retry_lines(h.lines)
    total = len(delays) + 1
    assert retries == [
        f"CLAP load: CUDA out of memory, retrying in {delays[0]:g}s (attempt 2/{total})",
        f"CLAP load: CUDA out of memory, retrying in {delays[1]:g}s (attempt 3/{total})",
    ], h.lines
    ok = [l for l in h.lines if "succeeded" in l]
    assert len(ok) == 1 and ok[0].startswith("CLAP load: ") and "attempt 3" in ok[0], h.lines


def oom_forever_propagates_original():
    errors = [RuntimeError(f"{OOM} #{i}") for i in range(20)]
    load, calls = scripted(errors)
    total = len(aw.CUDA_OOM_RETRY_DELAYS_S) + 1
    with Harness() as h:
        try:
            aw.retry_on_cuda_oom(load, "CLAP load")
        except RuntimeError as ex:
            raised = ex
        else:
            raise AssertionError("an OOM on every attempt must propagate")
    assert calls["n"] == total, calls
    assert raised is errors[total - 1], f"not the last attempt's own error: {raised!r}"
    assert h.sleeps == list(aw.CUDA_OOM_RETRY_DELAYS_S), h.sleeps
    assert len(retry_lines(h.lines)) == total - 1, h.lines
    assert not any("succeeded" in l for l in h.lines), h.lines


def other_error_not_retried():
    for err in (OSError("Connection refused: huggingface.co"), ValueError("bad checkpoint"),
                RuntimeError("CUDA error: no kernel image is available")):
        load, calls = scripted([err])
        with Harness() as h:
            try:
                aw.retry_on_cuda_oom(load, "Demucs load")
            except type(err) as ex:
                assert ex is err
            else:
                raise AssertionError(f"{err!r} must propagate")
        assert calls["n"] == 1, (err, calls)
        assert h.sleeps == [] and h.lines == [], (err, h.sleeps, h.lines)


def base_exception_not_caught():
    """Demucs' fatal() raises SystemExit; the helper must pass it straight to
    the loader's own BaseException handler, untouched and unretried."""
    load, calls = scripted([SystemExit("demucs fatal")])
    with Harness() as h:
        try:
            aw.retry_on_cuda_oom(load, "Demucs load")
        except SystemExit:
            pass
        else:
            raise AssertionError("SystemExit must propagate")
    assert calls["n"] == 1 and h.sleeps == [], (calls, h.sleeps)


def torch_oom_type_counts():
    OutOfMemoryError = type("OutOfMemoryError", (RuntimeError,), {})
    load, calls = scripted([OutOfMemoryError("Tried to allocate 2.00 MiB")])
    with Harness() as h:
        assert aw.retry_on_cuda_oom(load, "Beat This! load") == "loaded"
    assert calls["n"] == 2 and len(h.sleeps) == 1, (calls, h.sleeps)


def first_try_is_silent():
    load, calls = scripted([])
    with Harness() as h:
        assert aw.retry_on_cuda_oom(load, "CLAP load") == "loaded"
    assert calls["n"] == 1 and h.sleeps == [] and h.lines == [], (calls, h.sleeps, h.lines)


def frees_cache_between_attempts():
    """The cache goes back to the card before each wait, through torch only
    when it is already imported (the librosa-only venv never imports it)."""
    freed = {"n": 0}
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(
        is_available=lambda: True,
        empty_cache=lambda: freed.__setitem__("n", freed["n"] + 1),
    )
    saved = sys.modules.get("torch")
    try:
        sys.modules["torch"] = torch
        load, _ = scripted([RuntimeError(OOM), RuntimeError(OOM)])
        with Harness():
            aw.retry_on_cuda_oom(load, "CLAP load")
        assert freed["n"] == 2, freed
        sys.modules.pop("torch", None)
        load, _ = scripted([RuntimeError(OOM)])
        with Harness():
            assert aw.retry_on_cuda_oom(load, "CLAP load") == "loaded"
        assert "torch" not in sys.modules, "the retry must never import torch itself"
    finally:
        if saved is None:
            sys.modules.pop("torch", None)
        else:
            sys.modules["torch"] = saved


def schedule_fits_request_budget():
    delays = aw.CUDA_OOM_RETRY_DELAYS_S
    assert delays and all(d > 0 for d in delays), delays
    total = sum(delays)
    # A request can stack the self-test's wait and one model load's wait;
    # both together must leave most of the controller's 120 s default
    # analyze request timeout for the load and the analysis themselves.
    assert 2 * total <= 60, f"{total}s twice exceeds half the 120 s request budget"


# ── The loaders retry before latching ──────────────────────────────────────

class LoaderHarness(Harness):
    """Resets the three loaders' singletons + latches and stubs their side
    effects (the idle-release thread, the grid capability probe)."""

    NAMES = ("_embedder", "_embed_failed", "_embed_error", "_gridder", "_gridder_failed",
             "_gridder_error", "_vocal_detector", "_vocal_failed", "_vocal_error",
             "ClapEmbedder", "BeatGridder", "VocalActivityDetector",
             "_maybe_start_idle_release", "grid_capable")

    def __enter__(self):
        super().__enter__()
        self._loader_saved = {n: getattr(aw, n) for n in self.NAMES}
        for n in ("_embedder", "_embed_error", "_gridder", "_gridder_error",
                  "_vocal_detector", "_vocal_error"):
            setattr(aw, n, None)
        for n in ("_embed_failed", "_gridder_failed", "_vocal_failed"):
            setattr(aw, n, False)
        aw._maybe_start_idle_release = lambda: None
        aw.grid_capable = lambda: True
        return self

    def __exit__(self, *exc):
        for n, v in self._loader_saved.items():
            setattr(aw, n, v)
        return super().__exit__(*exc)


def fake_model_class(errors):
    calls = {"n": 0}

    class Model:
        def load(self):
            i = calls["n"]
            calls["n"] += 1
            if i < len(errors):
                raise errors[i]

    return Model, calls


LOADERS = (
    # (label, class name, getter, failed flag, error attr, failure log)
    ("CLAP", "ClapEmbedder", lambda: aw.get_embedder(force=True), "_embed_failed",
     "_embed_error", "CLAP load failed"),
    ("Beat This!", "BeatGridder", lambda: aw.get_gridder(), "_gridder_failed",
     "_gridder_error", "Beat This! load failed"),
    ("Demucs", "VocalActivityDetector", lambda: aw.get_vocal_detector(force=True), "_vocal_failed",
     "_vocal_error", "Demucs load failed"),
)


def loader_recovers(label, cls, get, failed, _error, _log):
    with LoaderHarness() as h:
        Model, calls = fake_model_class([RuntimeError(OOM), RuntimeError(OOM)])
        setattr(aw, cls, Model)
        got = get()
        assert isinstance(got, Model), f"{label}: expected a loaded model, got {got!r}"
        assert calls["n"] == 3, calls
        assert getattr(aw, failed) is False, f"{label}: a recovered load must not latch"
        assert aw.capability_loss() == {}, aw.capability_loss()
        assert len(retry_lines(h.lines)) == 2, h.lines
        assert all(l.startswith(f"{label} load: ") for l in retry_lines(h.lines)), h.lines


def loader_latches_original(label, cls, get, failed, error, log_prefix):
    total = len(aw.CUDA_OOM_RETRY_DELAYS_S) + 1
    errors = [RuntimeError(OOM) for _ in range(total)]
    with LoaderHarness() as h:
        Model, calls = fake_model_class(errors)
        setattr(aw, cls, Model)
        assert get() is None
        assert calls["n"] == total, calls
        assert getattr(aw, failed) is True
        assert getattr(aw, error) == aw.summarize_load_error(errors[-1]), getattr(aw, error)
        latch = [l for l in h.lines if l.startswith(log_prefix)]
        assert len(latch) == 1 and f"({OOM})" in latch[0], h.lines
        # Latched: the next request does not try (or wait) again.
        sleeps = len(h.sleeps)
        assert get() is None and calls["n"] == total and len(h.sleeps) == sleeps


def loader_other_error_latches_at_once(label, cls, get, failed, error, _log):
    err = OSError("Connection refused: huggingface.co")
    with LoaderHarness() as h:
        Model, calls = fake_model_class([err])
        setattr(aw, cls, Model)
        assert get() is None
        assert calls["n"] == 1 and h.sleeps == [], (calls, h.sleeps)
        assert getattr(aw, failed) is True
        assert getattr(aw, error) == aw.summarize_load_error(err)


def main():
    print("bounded wait on a CUDA out-of-memory at model load (analyze_worker.retry_on_cuda_oom):")
    test("an OOM twice, then a load: loaded, two retries logged, sleeps injected", oom_then_success)
    test("an OOM on every attempt raises the last attempt's own error after the budget",
         oom_forever_propagates_original)
    test("any other error is not retried", other_error_not_retried)
    test("SystemExit (demucs fatal) passes through unretried", base_exception_not_caught)
    test("torch's OutOfMemoryError type counts as OOM", torch_oom_type_counts)
    test("a first-try load logs nothing and never sleeps", first_try_is_silent)
    test("the CUDA cache is emptied before each wait, torch never imported", frees_cache_between_attempts)
    test("the schedule, doubled, stays well under the analyze request timeout",
         schedule_fits_request_budget)
    for spec in LOADERS:
        label = spec[0]
        test(f"{label}: an OOM twice then a load is not latched", lambda s=spec: loader_recovers(*s))
        test(f"{label}: an OOM every time latches the original message after the budget",
             lambda s=spec: loader_latches_original(*s))
        test(f"{label}: a non-OOM load error latches at once, no wait",
             lambda s=spec: loader_other_error_latches_at_once(*s))
    print("PASS" if failures == 0 else f"FAIL ({failures})")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
