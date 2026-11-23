"""
subwave-analyzer — acoustic-analysis sidecar for SUB/WAVE.

A thin FastAPI shim over a bounded pool of long-lived subprocesses: the SAME
stdio worker the controller runs in-process
(controller/scripts/analyze_worker.py), speaking one
JSON object per line ({"ready": true} once loaded, then one response per
request). run() supervises it — start → wait-for-exit → respawn — so a crash
(OOM, fatal model error) recovers without bouncing the container. No audio
over the wire: the worker reads tracks from a stream URL or a path on the
shared /var/sub-wave volume.

Endpoints:
  GET  /health   → {ok, engines, analyze_loaded, analyze_audio_capable, analyze_vocal_capable,
                     analyze_facets_capable, …}
  POST /analyze  → {ok, bpm, key, intro_ms, confidence, ...}
"""

import asyncio
import hashlib
import json
import re
import logging
import math
import os
import shutil
import threading
import time
import urllib.request
from contextlib import asynccontextmanager
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

ANALYZE_PYTHON = os.environ.get("ANALYZE_PYTHON", "/opt/analyzer/venv/bin/python")
ANALYZE_WORKER = os.environ.get("ANALYZE_WORKER", "/app/workers/analyze_worker.py")
# 40s is enough for stable BPM/key; keep in sync with analyze_worker.py and
# controller config.ts. Compose forwards ${ANALYZE_SECONDS:-} (empty = unset).
ANALYZE_SECONDS = os.environ.get("ANALYZE_SECONDS", "").strip() or "40"
# Only touched when CLAP is enabled without a local CLAP_MODEL_PATH; compose
# mounts a named volume over it so the weight download survives recreates.
ANALYZER_HF_HOME = os.environ.get("ANALYZER_HF_HOME", "/opt/analyzer/hf-cache")


def _bounded_env(name: str, default, minimum, maximum, parse, kind: str):
    """A bounded number from the environment: unset is the default, and a
    malformed or out-of-range value warns and falls back, never clamps."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = parse(raw)
    except ValueError:
        logging.getLogger("analyzer").warning(
            f"{name}={raw!r} is not {kind}; using {default}"
        )
        return default
    if value < minimum or value > maximum:
        logging.getLogger("analyzer").warning(
            f"{name}={raw!r} must be between {minimum} and {maximum}; using {default}"
        )
        return default
    return value


def _bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    return _bounded_env(name, default, minimum, maximum, int, "a whole number")


def _finite_float(raw: str) -> float:
    value = float(raw)
    if not math.isfinite(value):
        raise ValueError(raw)
    return value


def _bounded_float_env(name: str, default: float, minimum: float, maximum: float) -> float:
    return _bounded_env(name, default, minimum, maximum, _finite_float, "a finite number")


ANALYZE_CONCURRENCY = _bounded_int_env("ANALYZE_CONCURRENCY", 1, 1, 8)

# Whole-file facet requests (loudness v2, edges) in flight. Each is a one-shot
# worker process running one ffmpeg decode on ONE CPU thread with no model, so
# it runs outside the analyze pool (whose workers hold CLAP/Demucs) and can go
# much wider: a library's first whole-file pass reads every file once. The
# controller sends up to its own ANALYZE_WHOLE_FILE_CONCURRENCY; this caps
# what this host accepts.
WHOLE_FILE_CONCURRENCY = _bounded_int_env("ANALYZE_WHOLE_FILE_CONCURRENCY", 4, 1, 32)
# Wall-clock bound for one file, seconds: the worker's own bound and parse
# (30-7200, warn-and-fall-back), and this reading is what it is handed. A long
# DJ mix streamed from the music server is the slow case.
WHOLE_FILE_TIMEOUT_S = _bounded_float_env("ANALYZE_WHOLE_FILE_TIMEOUT_S", 900.0, 30.0, 7200.0)
WHOLE_FILE_FACETS = ("loudness", "edges")
# What the one-shot whole-file lane serves: the whole-file facets and the
# per-bar structure (its own decode, numpy/scipy, no model), so a structure
# pass runs as wide as a loudness pass and never queues behind CLAP/Demucs.
WHOLE_FILE_LANE_FACETS = WHOLE_FILE_FACETS + ("structure",)
# Facets that load a model (CLAP, Demucs, Beat This!): the residency tracking
# counts a request that names one as model use.
MODEL_FACETS = ("clap", "vocal", "stems", "grid")

# Run-scoped staged copies (StageCache below). A tagging run reads a new
# track's whole file up to three times (loudness + edges before the model
# lane, then the beat grid and the structure after it), each a full stream
# from the music server; asked to, this host keeps the first read on its own
# disk and serves the later ones from it. 0 turns it off. The copy is the
# stream's own bytes, so every decode of it is the decode of the stream.
STAGE_MAX_BYTES = int(_bounded_float_env("ANALYZE_STAGE_MAX_GB", 4.0, 0.0, 1024.0) * 1024 ** 3)
# In the container's own writable layer: the copies are this host's scratch,
# never the shared state mount.
STAGE_DIR = "/tmp/subwave-stage"
# A copy no request has read for this long is deleted (the controller
# releases its run's copies after the structure step; this catches a run that
# died first).
STAGE_TTL_S = 3600.0
# Never fill the disk: a copy is admitted only with this much left after it.
STAGE_MIN_FREE_BYTES = 1024 ** 3

# Idle worker recycle (#1204 follow-up). The worker's own idle release drops
# the CLAP/Demucs singletons, but ~1GB of librosa/numba/torch scratch stays
# resident — restarting the worker is the only full reclaim. After this many
# seconds without a request of any kind (a lean bpm/key pass holds ~500MB of
# that scratch too) the shim terminates it and run() respawns. Default sits
# above the worker's largest release window so the cheap release always fires
# first; 0 disables.
_RECYCLE_ENV = os.environ.get("ANALYZE_RECYCLE_IDLE_S", "").strip()
try:
    RECYCLE_IDLE_S = float(_RECYCLE_ENV) if _RECYCLE_ENV else 3600.0
except ValueError:
    logging.getLogger("analyzer").warning(
        f"ANALYZE_RECYCLE_IDLE_S={_RECYCLE_ENV!r} is not a number; using 3600"
    )
    RECYCLE_IDLE_S = 3600.0

# Mirror of the worker's env-default flags (same truthy set) — with either on,
# the worker loads models even for requests that don't ask, so every /analyze
# counts as heavy use.
def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes")


EMBED_DEFAULT = _env_flag("ANALYZE_AUDIO_EMBEDDING")
VOCAL_DEFAULT = _env_flag("ANALYZE_VOCAL_ACTIVITY")

# Max bytes of one worker stdout line. asyncio's default 64 KiB StreamReader
# limit is blown by a batch /embed-text response (~150 KB on one line) —
# readline() then raises LimitOverrunError and the endpoint 500s (#996).
WORKER_STDOUT_LIMIT = 16 * 1024 * 1024

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
log = logging.getLogger("analyzer")


class WorkerUnavailableError(RuntimeError):
    """A selected worker became unusable before accepting the request."""


class StdioWorker:
    """Async wrapper around a long-lived stdio worker subprocess.

    No multiplexing — one request in flight, gated by a lock. run() drives the
    lifecycle from the FastAPI lifespan.
    """

    START_BACKOFF_S = 5.0
    RUN_BACKOFF_S = 2.0

    def __init__(self, name: str, python: str, script: str, env_extra: dict[str, str] | None = None):
        self.name = name
        self.python = python
        self.script = script
        self.env_extra = env_extra or {}
        self.proc: asyncio.subprocess.Process | None = None
        self.lock = asyncio.Lock()
        self.ready = False
        self._reserved = False
        self._recycling = False
        self._state_listener: Callable[[], Awaitable[None]] | None = None
        # Ready message minus the `ready` flag — per-engine capability
        # metadata. Cleared on every restart cycle.
        self.ready_meta: dict[str, Any] = {}
        # Heavy-use bookkeeping for /health residency. The idle recycle has its
        # own clock, last_use, below.
        # last_heavy = monotonic time of the last completed model-using
        # request (None = none since this spawn); models_resident is
        # best-effort — set on a heavy completion, cleared when the worker's
        # idle-release log line goes by (_pump_stderr) or the worker restarts.
        self.last_heavy: float | None = None
        # Monotonic time of the last completed request of any kind. The recycle
        # clock: a lean bpm/key pass loads no models but still leaves ~500MB of
        # librosa/numba scratch resident, and only a respawn returns it. Every
        # op counts, render-transition included, so a worker serving stem
        # blends is not recycled between them (its respawn re-pays the torch
        # import, which would land on a live transition render).
        self.last_use: float | None = None
        self.models_resident = False
        self.recycles = 0
        # Capabilities the worker advertised at ready but LOST when the model
        # was actually asked to load — {"audio_embedding": "<why>"}, harvested
        # from every response (analyze_worker.capability_loss). Deliberately
        # NOT cleared by _reset(): the worker's own latch dies with the
        # process, and recycle_loop respawns that process every idle hour, so
        # an in-worker-only latch would reset itself and the controller would
        # re-widen its backfill to the same doomed tracks forever (#1300 bug
        # 3). Cleared only by restarting THIS container — which is also the
        # operator's retry after fixing the cause.
        self.capability_errors: dict[str, str] = {}

    def set_state_listener(self, listener: Callable[[], Awaitable[None]]) -> None:
        self._state_listener = listener

    async def _state_changed(self) -> None:
        if self._state_listener is not None:
            await self._state_listener()

    async def _set_ready(self, ready: bool) -> None:
        if self.ready == ready:
            return
        self.ready = ready
        await self._state_changed()

    async def _set_recycling(self, recycling: bool) -> None:
        if self._recycling == recycling:
            return
        self._recycling = recycling
        await self._state_changed()

    @property
    def available(self) -> bool:
        return self.ready and not self._recycling

    @property
    def recycling(self) -> bool:
        """This worker is mid-recycle: unselectable now, but coming back.

        recycle_loop's `finally` always clears the claim (bounded by its own
        180s respawn deadline), so a pool waiter blocked on this flag is
        guaranteed to be woken — see AnalyzerWorkerPool._acquire_worker.
        """
        return self._recycling

    def reserve_if_available(self) -> bool:
        # No await: selection and recycle's `_recycling = True` transition are
        # atomic relative to one another on the asyncio event loop.
        if not self.available or self._reserved:
            return False
        self._reserved = True
        return True

    def release_reservation(self) -> None:
        self._reserved = False

    async def run(self) -> None:
        """Keep the worker alive forever (or until cancelled)."""
        try:
            while True:
                try:
                    await self.start()
                except Exception as e:
                    log.error(f"[{self.name}] start failed: {e}")
                    await self._reset()
                    await asyncio.sleep(self.START_BACKOFF_S)
                    continue
                assert self.proc is not None
                code = await self.proc.wait()
                log.warning(
                    f"[{self.name}] worker exited with code={code}; restarting in {self.RUN_BACKOFF_S}s",
                )
                await self._reset()
                await asyncio.sleep(self.RUN_BACKOFF_S)
        except asyncio.CancelledError:
            await self._set_ready(False)
            self._terminate()
            raise

    async def _reset(self) -> None:
        await self._set_ready(False)
        self.proc = None
        self.ready_meta = {}
        # A fresh worker holds no models; clearing the clocks also stands the
        # recycle loop down until the next request.
        self.last_heavy = None
        self.last_use = None
        self.models_resident = False

    def _terminate(self) -> None:
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.terminate()
            except ProcessLookupError:
                pass

    async def start(self) -> None:
        log.info(f"[{self.name}] starting worker: {self.python} {self.script}")
        env = {**os.environ, **self.env_extra}
        self.proc = await asyncio.create_subprocess_exec(
            self.python,
            self.script,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            limit=WORKER_STDOUT_LIMIT,
        )
        # Pump stderr to our log so model load progress / fatal errors land in
        # the container logs. Exits when the worker closes stderr on death.
        asyncio.create_task(self._pump_stderr())

        # Read until {"ready": true}. A first-time CLAP/Demucs load (lazy
        # weight download) can take a while, so no timeout — run()'s restart
        # loop is the upstream safety net.
        try:
            msg = await self._await_message()
            if msg.get("fatal"):
                raise RuntimeError(f"[{self.name}] fatal: {msg.get('error')}")
            if not msg.get("ready"):
                raise RuntimeError(f"[{self.name}] expected ready, got: {msg}")
        except Exception:
            self._terminate()
            raise
        self.ready_meta = {k: v for k, v in msg.items() if k != "ready"}
        # A pre-warm (env-enabled) model load fails BEFORE ready, so the ready
        # line itself can already carry a loss.
        self._note_capability_loss(msg)
        log.info(f"[{self.name}] ready {self.ready_meta or ''}".rstrip())
        # With an env flag on, the worker pre-warms that model BEFORE ready —
        # count it as resident and as heavy use for /health, unless the
        # capability probe says the load failed. It is use for the recycle clock
        # too: a pre-warmed worker that never serves a request still holds the
        # weights and their scratch, and must give them back after the window.
        if (EMBED_DEFAULT and self.ready_meta.get("audio_embedding_capable")) or (
            VOCAL_DEFAULT and self.ready_meta.get("vocal_activity_capable")
        ):
            self.models_resident = True
            self.last_heavy = self.last_use = time.monotonic()
        await self._set_ready(True)

    async def _await_message(self) -> dict[str, Any]:
        """Read worker stdout until a parseable JSON object arrives."""
        assert self.proc and self.proc.stdout
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"[{self.name}] worker exited before message")
            text = line.decode().strip()
            if not text:
                continue
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                log.info(f"[{self.name}] non-JSON on stdout: {text!r}")
                continue
            return msg

    async def _pump_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        proc = self.proc
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            text = line.decode().rstrip()
            log.info(f"[{self.name}] {text}")
            # The worker announces its idle release on stderr (wording pinned
            # by a keep-in-sync note at analyze_worker._release_models).
            # Unsolicited stdout would corrupt the one-request-in-flight
            # protocol, so stderr is the only channel — best-effort by design.
            if "released" in text and "reloads on next use" in text:
                self.models_resident = False

    def _note_capability_loss(self, msg: dict[str, Any]) -> None:
        """Record a capability the worker just reported it can no longer do.

        First observation per capability is logged at WARNING — a load failure
        that only ever showed up as a missing field in an ok=true response is
        precisely how this went unnoticed for so long.
        """
        lost = msg.get("capability_loss")
        if not isinstance(lost, dict):
            return
        for name, why in lost.items():
            reason = str(why)[:400]
            if self.capability_errors.get(name) == reason:
                continue
            self.capability_errors[name] = reason
            log.warning(f"[{self.name}] {name} unavailable: {reason}")

    def capability(self, meta_key: str, loss_key: str) -> bool | None:
        """Advertised capability, corrected by anything observed since.

        `ready_meta` answers the question the worker could answer BEFORE
        loading anything ("are the libraries installed"); an observed load
        failure answers the one that matters ("can it actually produce this").
        The observation wins, and only ever downward — a capability the worker
        never claimed stays unclaimed."""
        if not self.ready:
            return None
        if loss_key in self.capability_errors:
            return False
        value = self.ready_meta.get(meta_key)
        return value if isinstance(value, bool) else None

    @staticmethod
    def _wants_models(payload: dict[str, Any]) -> bool:
        """Whether this request can load/use CLAP or Demucs. Texts always force
        CLAP; a render_transition mixes already-cached stems (no model); an
        analyze counts when it opts in per-request OR the worker's env default
        flags opt every request in."""
        if payload.get("texts") is not None:
            return True
        if payload.get("op"):
            return False
        facets = payload.get("facets")
        if isinstance(facets, list):
            # A facet request loads exactly the models its facets name.
            return bool(payload.get("tail_vocals")) or any(f in MODEL_FACETS for f in facets)
        return bool(
            payload.get("embed") or payload.get("vocal") or payload.get("stems_dir")
            or EMBED_DEFAULT or VOCAL_DEFAULT
        )

    @staticmethod
    def _used_models(msg: dict[str, Any]) -> bool:
        """Whether a response proves model use (flat or facet shape)."""
        if any(k in msg for k in ("audio_embedding", "vocal_ranges", "stems_cached")):
            return True
        facets = msg.get("facets")
        if isinstance(facets, dict):
            return any(
                # Failed model facets reached a loaded model too, including
                # a stems cache publication error after successful separation.
                # Missing/failed model loads answer unavailable instead.
                isinstance(facets.get(f), dict) and facets[f].get("status") in ("ok", "failed")
                for f in MODEL_FACETS
            )
        return False

    async def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            # Fail fast when the worker is down — the controller's client
            # falls through cleanly (analysis row stays NULL), preferable to
            # blocking on an unhealthy worker.
            if not self.ready or not self.proc or self.proc.returncode is not None:
                await self._set_ready(False)
                raise WorkerUnavailableError(f"[{self.name}] worker not ready")
            assert self.proc.stdin
            req = json.dumps(payload, ensure_ascii=False)
            self.proc.stdin.write((req + "\n").encode())
            await self.proc.stdin.drain()
            msg = await self._await_message()
            self.last_use = time.monotonic()
            self._note_capability_loss(msg)
            # Stamp heavy use from what actually came back, not what was
            # asked: an analyze whose CLAP load failed still answers ok=true
            # (graceful degrade) but carries no model-derived fields, and must
            # not read as "models resident".
            if self._wants_models(payload) and (
                (payload.get("texts") is not None and msg.get("ok"))
                or self._used_models(msg)
            ):
                self.last_heavy = time.monotonic()
                self.models_resident = True
            return msg

    def _idle_expired(self, idle_s: float) -> bool:
        """Has this worker been used, and then left alone for `idle_s`? A worker
        that has served nothing since it spawned has nothing to reclaim."""
        return self.last_use is not None and time.monotonic() - self.last_use >= idle_s

    async def recycle_loop(self, idle_s: float) -> None:
        """Terminate the worker after `idle_s` seconds without a request so
        run() respawns it fresh — the full-memory counterpart to the worker's
        own model release. A pool reservation wins over recycling; once recycle
        claims the worker, new requests route to another available member — or,
        when this IS the only member (the ANALYZE_CONCURRENCY=1 default), queue
        in _acquire_worker until the respawn re-readies it. Either way a racing
        request runs against the new worker instead of 500ing, which is what
        holding the request lock across the respawn used to buy."""
        while True:
            await asyncio.sleep(60)
            if not self.ready or not self._idle_expired(idle_s):
                continue
            # A pool reservation is made without yielding, as is this recycling
            # claim. Whichever happens first wins: admitted work completes on
            # this worker, or the pool sees it as unavailable and picks another.
            if self._reserved:
                continue
            await self._set_recycling(True)
            try:
                async with self.lock:
                    # Re-check under the lock: a request may have completed
                    # while we waited to acquire it.
                    if not self._idle_expired(idle_s):
                        continue
                    log.info(
                        f"[{self.name}] idle {int(idle_s)}s — recycling worker "
                        "for a full memory reclaim (re-pays imports on next request)"
                    )
                    self.recycles += 1
                    await self._set_ready(False)
                    self._terminate()
                    # Wait (bounded) for run() to respawn and re-ready before
                    # releasing the lock. The pool routes new requests to other
                    # available members during this window.
                    deadline = time.monotonic() + 180.0
                    while time.monotonic() < deadline and not self.ready:
                        await asyncio.sleep(0.5)
                    if not self.ready:
                        log.warning(f"[{self.name}] worker not back within 180s of recycle")
            finally:
                await self._set_recycling(False)


class AnalyzerWorkerPool:
    """Facade over independent single-flight stdio workers."""

    def __init__(self, workers: list[StdioWorker]):
        self.workers = workers
        self._available = asyncio.Condition()
        self._busy: set[StdioWorker] = set()
        self._next = 0
        for worker in self.workers:
            worker.set_state_listener(self._worker_state_changed)

    async def _worker_state_changed(self) -> None:
        async with self._available:
            self._available.notify_all()

    @property
    def ready_workers(self) -> list[StdioWorker]:
        return [worker for worker in self.workers if worker.available]

    @property
    def ready(self) -> bool:
        return bool(self.ready_workers)

    @property
    def recycling(self) -> bool:
        return any(worker.recycling for worker in self.workers)

    def capability(self, meta_key: str, loss_key: str) -> bool | None:
        # Aggregate across the SELECTABLE members only. A booting, crashed or
        # recycling member has no opinion — reading it would report `None` for
        # the whole pool every time one member cycles, and the controller's
        # tail-vocal backfill (which requires === true) would read a healthy
        # heavy pool as a stale analyzer image.
        #
        # A capability is `False` only when EVERY selectable member has lost it
        # — that is the lean-image case, where they all share one build. One
        # member latching a load failure (capability_errors survives its own
        # respawn by design) leaves the pool `None`: some member can still serve
        # it, so `True` would be a lie, and `False` would switch the feature off
        # station-wide over one worker's bad hour.
        ready = self.ready_workers
        if not ready:
            return None
        values = [worker.capability(meta_key, loss_key) for worker in ready]
        if all(value is True for value in values):
            return True
        if all(value is False for value in values):
            return False
        return None

    def capability_error(self, loss_key: str) -> str | None:
        # Selectable members only, matching capability() — a long-dead member's
        # latched reason is not why the pool is degraded now.
        errors = [
            worker.capability_errors[loss_key]
            for worker in self.ready_workers
            if loss_key in worker.capability_errors
        ]
        return errors[0] if errors else None

    async def _acquire_worker(self) -> StdioWorker:
        """Reserve one selectable member, waiting while the pool can recover.

        Three states, and the difference between the last two is load-bearing.
        A member is free → take it. Every member is busy → wait. NO member is
        selectable → it depends on why: a member that is merely RECYCLING is
        being respawned and will re-ready (or time out) within recycle_loop's
        own 180s budget, and its `finally` always clears the claim, so waiting
        here is bounded and the request is served by the fresh worker. This is
        what the single worker's request lock used to do implicitly — it was
        held across the respawn precisely so a racing request queued and then
        ran against the new worker instead of 500ing, and at the default
        ANALYZE_CONCURRENCY=1 that recycle window is the whole pool.

        Nothing ready and nothing recycling is the boot/crash case, where
        blocking would help no one: fail fast so the controller falls through
        cleanly (the analysis row stays NULL and is retried next pass).
        """
        async with self._available:
            while True:
                count = len(self.workers)
                for offset in range(count):
                    index = (self._next + offset) % count
                    worker = self.workers[index]
                    if worker not in self._busy and worker.reserve_if_available():
                        self._busy.add(worker)
                        self._next = (index + 1) % count
                        return worker
                if not self.ready and not self.recycling:
                    raise WorkerUnavailableError("[analyze] no worker ready")
                await self._available.wait()

    async def _release_worker(self, worker: StdioWorker) -> None:
        async with self._available:
            worker.release_reservation()
            self._busy.discard(worker)
            self._available.notify_all()

    async def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        while True:
            worker: StdioWorker | None = None
            try:
                worker = await self._acquire_worker()
                return await worker.request(payload)
            except WorkerUnavailableError:
                # Selection itself failing (worker is still None) is the pool's
                # considered verdict that nothing is ready and nothing is coming
                # back — retrying would spin on the same answer, so it rides out
                # to the caller as the single worker's "not ready" always did.
                if worker is None:
                    raise
                # Past selection, readiness can still change before the worker
                # lock (notably when recycle wins that race). Release the stale
                # reservation and pick another member instead of failing a
                # request the pool can still serve.
            finally:
                if worker is not None:
                    await self._release_worker(worker)


analyzer_workers = [
    StdioWorker(
        name=f"analyze-{index + 1}",
        python=ANALYZE_PYTHON,
        script=ANALYZE_WORKER,
        env_extra={"ANALYZE_SECONDS": ANALYZE_SECONDS, "HF_HOME": ANALYZER_HF_HOME},
    )
    for index in range(ANALYZE_CONCURRENCY)
]
analyzer_pool = AnalyzerWorkerPool(analyzer_workers)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Background task so uvicorn binds :8080 immediately — a cold CLAP/Demucs
    # load would otherwise block the bind and the controller's probe would see
    # "connection refused" during boot.
    tasks = []
    for index, worker in enumerate(analyzer_workers, start=1):
        tasks.append(asyncio.create_task(worker.run(), name=f"analyze-run-{index}"))
        if RECYCLE_IDLE_S > 0:
            tasks.append(
                asyncio.create_task(
                    worker.recycle_loop(RECYCLE_IDLE_S), name=f"analyze-recycle-{index}"
                )
            )
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="subwave-analyzer", lifespan=lifespan)

# Created lazily inside the running loop (an asyncio primitive must not be
# bound to an import-time loop).
_whole_file_sem: asyncio.Semaphore | None = None


def _whole_file_semaphore() -> asyncio.Semaphore:
    global _whole_file_sem
    if _whole_file_sem is None:
        _whole_file_sem = asyncio.Semaphore(WHOLE_FILE_CONCURRENCY)
    return _whole_file_sem


async def run_whole_file_once(payload: dict[str, Any]) -> dict[str, Any]:
    """One whole-file facet request in a one-shot worker process
    (`analyze_worker.py --whole-file`), bounded by its own semaphore so a bulk
    pass never queues behind CLAP/Demucs jobs. Answers like the pool does."""
    async with _whole_file_semaphore():
        proc = await asyncio.create_subprocess_exec(
            ANALYZE_PYTHON, ANALYZE_WORKER, "--whole-file",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "ANALYZE_WHOLE_FILE_TIMEOUT_S": str(WHOLE_FILE_TIMEOUT_S)},
        )
        try:
            out, err = await asyncio.wait_for(
                proc.communicate((json.dumps(payload) + "\n").encode()), timeout=WHOLE_FILE_TIMEOUT_S + 30
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return {"ok": False, "error": f"whole-file pass timed out after {WHOLE_FILE_TIMEOUT_S:.0f}s"}
    try:
        return json.loads((out or b"").decode("utf-8", "replace").strip().splitlines()[-1])
    except Exception:  # noqa: BLE001 — a worker that printed nothing usable
        # A stream URL carries the music server's credentials. The one-shot
        # worker writes its stderr through its own redact_urls (analyze_worker
        # RedactingStream), the one redaction rule, so its tail can be quoted.
        tail = (err or b"").decode("utf-8", "replace").strip()[-300:]
        return {"ok": False, "error": f"whole-file worker gave no result: {tail or 'no output'}"}


class StageRefused(Exception):
    """The copy is not kept (over budget, no length, not audio, short read):
    the request reads the stream itself, exactly as without staging."""


def _download_whole(url: str, dest: str, admit: Callable[[int], bool], timeout_s: float) -> int:
    """The whole response body of `url` into `dest`, or StageRefused. Only a
    200 with an audio body whose Content-Length is known, admitted by
    `admit(length)`, and read to exactly that length is kept."""
    req = urllib.request.Request(url, headers={"User-Agent": "subwave-analyzer-stage/1"})
    with urllib.request.urlopen(req, timeout=timeout_s) as res:  # noqa: S310 — the controller's own stream URL
        if res.status != 200:
            raise StageRefused(f"status {res.status}")
        ctype = (res.headers.get("Content-Type") or "").lower()
        if "json" in ctype or "xml" in ctype or ctype.startswith("text/"):
            raise StageRefused("not audio")
        try:
            length = int(res.headers.get("Content-Length") or "")
        except ValueError:
            raise StageRefused("no length") from None
        if length <= 0:
            raise StageRefused("no length")
        if not admit(length):
            raise StageRefused("over budget")
        read = 0
        part = dest + ".part"
        try:
            with open(part, "wb") as out:
                while True:
                    chunk = res.read(1024 * 1024)
                    if not chunk:
                        break
                    read += len(chunk)
                    if read > length:
                        raise StageRefused("longer than its length")
                    out.write(chunk)
            if read != length:
                raise StageRefused(f"short read ({read} of {length} bytes)")
            os.replace(part, dest)
        except BaseException:
            try:
                os.remove(part)
            except OSError:
                pass
            raise
        return length


class StageCache:
    """Whole-file copies kept on this host for the run that asked for them.

    A request names its copy with `stage_key` (the controller's run token and
    the track id). `keep` fetches the stream into the cache when the key is not
    there yet; without it the request only reuses a copy already there. Two
    requests for one key share one download. Anything that cannot be proven
    whole (no Content-Length, a short read, a non-audio answer) or does not fit
    (ANALYZE_STAGE_MAX_GB, or less than STAGE_MIN_FREE_BYTES left on the disk)
    is refused, and that request streams the URL as it always did. A copy in
    use is never deleted; idle ones go on release (the end of the run) or
    after STAGE_TTL_S."""

    def __init__(self, root: str, max_bytes: int, ttl_s: float, *, timeout_s: float = 900.0,
                 download: Callable[[str, str, Callable[[int], bool], float], int] = _download_whole,
                 clock: Callable[[], float] = time.monotonic, min_free: int = STAGE_MIN_FREE_BYTES):
        self.root = root
        self.max_bytes = max_bytes
        self.ttl_s = ttl_s
        self.timeout_s = timeout_s
        self.download = download
        self.clock = clock
        self.min_free = min_free
        self.entries: dict[str, dict[str, Any]] = {}
        self.pending: dict[str, asyncio.Future] = {}
        # Counted bytes: kept copies plus downloads admitted and running.
        # Touched from the download threads (admit), hence the lock.
        self._lock = threading.Lock()
        self.used_bytes = 0
        self.cleared = False

    @property
    def enabled(self) -> bool:
        return self.max_bytes > 0

    def _path(self, key: str) -> str:
        return os.path.join(self.root, hashlib.sha1(key.encode("utf-8")).hexdigest() + ".audio")

    # Only names this cache writes (40 hex + .audio, or its .part) are ever
    # deleted from the folder, whatever else ANALYZE_STAGE_DIR holds.
    OWN_NAME = re.compile(r"^[0-9a-f]{40}\.audio(\.part)?$")

    def _clear_root(self) -> None:
        # Copies left by an earlier container are nobody's: start empty.
        if self.cleared:
            return
        self.cleared = True
        os.makedirs(self.root, exist_ok=True)
        for name in os.listdir(self.root):
            if self.OWN_NAME.match(name):
                try:
                    os.remove(os.path.join(self.root, name))
                except OSError:
                    pass

    def _admit(self, length: int) -> bool:
        with self._lock:
            if self.used_bytes + length > self.max_bytes:
                return False
            try:
                free = shutil.disk_usage(self.root).free
            except OSError:
                return False
            if free - length < self.min_free:
                return False
            self.used_bytes += length
            return True

    def _forget(self, key: str) -> None:
        e = self.entries.pop(key, None)
        if not e:
            return
        try:
            os.remove(e["path"])
        except OSError:
            pass
        with self._lock:
            self.used_bytes -= e["bytes"]

    def sweep(self) -> int:
        now = self.clock()
        idle = [k for k, e in self.entries.items() if e["readers"] == 0 and now - e["used"] > self.ttl_s]
        for k in idle:
            self._forget(k)
        return len(idle)

    async def acquire(self, key: str, url: str, keep: bool) -> str | None:
        """A reader's path to the copy for `key` (call release_reader after),
        or None: read the stream."""
        if not self.enabled or not key:
            return None
        self.sweep()
        e = self.entries.get(key)
        if e is None and key in self.pending:
            await asyncio.shield(self.pending[key])
            e = self.entries.get(key)
        if e is None and keep:
            fut = asyncio.get_running_loop().create_future()
            self.pending[key] = fut
            try:
                self._clear_root()
                path = self._path(key)
                admitted = 0

                def admit(n: int) -> bool:
                    nonlocal admitted
                    ok = self._admit(n)
                    if ok:
                        admitted = n
                    return ok

                try:
                    size = await asyncio.to_thread(self.download, url, path, admit, self.timeout_s)
                    self.entries[key] = {"path": path, "bytes": size, "used": self.clock(), "readers": 0, "doomed": False}
                except StageRefused as err:
                    log.info(f"stage: not kept ({err}); the request reads the stream")
                    if admitted:
                        with self._lock:
                            self.used_bytes -= admitted
                except Exception as err:  # noqa: BLE001 — the stream read is the fallback
                    log.warning(f"stage: download failed ({type(err).__name__}); the request reads the stream")
                    if admitted:
                        with self._lock:
                            self.used_bytes -= admitted
            finally:
                self.pending.pop(key, None)
                fut.set_result(None)
            e = self.entries.get(key)
        if e is None or e["doomed"] or not os.path.isfile(e["path"]):
            return None
        e["readers"] += 1
        e["used"] = self.clock()
        return e["path"]

    def release_reader(self, key: str) -> None:
        e = self.entries.get(key)
        if not e:
            return
        e["readers"] = max(0, e["readers"] - 1)
        e["used"] = self.clock()
        if e["readers"] == 0 and e["doomed"]:
            self._forget(key)

    def release_prefix(self, prefix: str) -> int:
        """Drop every copy whose key starts with `prefix` (a run's token); one
        still being read goes when its reader is done."""
        if not prefix:
            return 0
        n = 0
        for k in [k for k in self.entries if k.startswith(prefix)]:
            n += 1
            if self.entries[k]["readers"] > 0:
                self.entries[k]["doomed"] = True
            else:
                self._forget(k)
        return n


stage_cache = StageCache(STAGE_DIR, STAGE_MAX_BYTES, STAGE_TTL_S, timeout_s=WHOLE_FILE_TIMEOUT_S)


@app.get("/health")
async def health():
    # `engines` lists engines *currently ready*, not the static set — the
    # controller's probe (analyzer.ts:sidecarReachable) keys readiness on
    # `engines.includes("analyze")`, so advertising it while booting/crashed
    # would cause failed /analyze calls instead of a clean fall-through.
    ready = analyzer_pool.ready_workers
    ready_engines: list[str] = ["analyze"] if ready else []
    heavy_times = [worker.last_heavy for worker in ready if worker.last_heavy is not None]
    use_times = [worker.last_use for worker in ready if worker.last_use is not None]
    return {
        "ok": True,
        "engines": ready_engines,
        "analyze_loaded": bool(ready),
        # CLAP "sounds-like" capability (WITH_CLAP=1 builds only) — the admin
        # UI warns to rebuild before a fruitless run. None until ready. Reads
        # through capability(), so a model that failed to LOAD reports false
        # here rather than the ready line's install-time guess.
        "analyze_audio_capable": analyzer_pool.capability(
            "audio_embedding_capable", "audio_embedding"
        ),
        # Demucs vocal-activity capability (WITH_DEMUCS=1). None until ready.
        "analyze_vocal_capable": analyzer_pool.capability(
            "vocal_activity_capable", "vocal_activity"
        ),
        # WHY a capability is false, when the reason is a failed load rather
        # than a lean build (null in every other case). The distinction is the
        # actionable part: "rebuild with the heavy image" and "give this host
        # reach to huggingface.co" are opposite instructions, and a bare false
        # can't tell them apart.
        "analyze_audio_error": analyzer_pool.capability_error("audio_embedding"),
        "analyze_vocal_error": analyzer_pool.capability_error("vocal_activity"),
        # Tail vocal ranges — a worker-version signal as much as a capability:
        # workers predating the feature never emit the key, so this stays None
        # on stale images and the controller's backfill widening (which
        # requires === true) can't churn against them. Demucs failing to load
        # takes the tail down with it — same model, same separation.
        "analyze_tail_vocal_capable": analyzer_pool.capability(
            "tail_vocal_capable", "vocal_activity"
        ),
        # CLAP text tower (same 512-d space as the audio vectors) — powers
        # "sounds like ..." search and zero-shot moods. Needs torch, so lean
        # images report false. Shares CLAP's load, so it shares its failure.
        "analyze_text_capable": analyzer_pool.capability(
            "text_embedding_capable", "audio_embedding"
        ),
        # Per-facet requests ({"facets": [...]}) — a worker-version signal:
        # older workers never emit the key, so this stays None and the
        # controller keeps sending flat requests to them.
        "analyze_facets_capable": analyzer_pool.capability("facets_capable", "facets"),
        # Tail-only facet requests may set `ranged` (same version-signal rule).
        "analyze_ranged_tail_capable": analyzer_pool.capability("ranged_tail_capable", "facets"),
        # Whole-file facets (loudness v2 over the whole file, silence edges and
        # the decoded length): needs ffmpeg in the worker image. None on older
        # workers, which never emit the key.
        "analyze_whole_file_capable": analyzer_pool.capability("whole_file_capable", "whole_file"),
        # Whole-file loudness answers carry the short-term loudness curve
        # (`loudness_curve`). None on older workers, which never emit the key.
        "analyze_loudness_curve_capable": analyzer_pool.capability("loudness_curve_capable", "whole_file"),
        # The whole-track beat grid (Beat This!, heavy images; the `grid`
        # facet). None on older workers, which never emit the key; false on a
        # lean image or after a failed model load (analyze_grid_error says why).
        "analyze_grid_capable": analyzer_pool.capability("grid_capable", "beat_grid"),
        "analyze_grid_error": analyzer_pool.capability_error("beat_grid"),
        # The per-bar structure on the beat grid (the `structure` facet:
        # numpy + scipy + ffmpeg, no model; true on every image that has
        # them). None on older workers, which never emit the key.
        "analyze_structure_capable": analyzer_pool.capability("structure_capable", "structure"),
        # Tail answers carry the tail's short-term loudness curve (tail v3).
        # None on older workers, which never emit the key.
        "analyze_tail_loudness_curve_capable": analyzer_pool.capability(
            "tail_loudness_curve_capable", "tail_loudness_curve"
        ),
        # How many whole-file requests this host runs at once (its own lane).
        "analyze_whole_file_concurrency": WHOLE_FILE_CONCURRENCY,
        # This host keeps a run's whole-file copies for the requests that
        # name one (`stage_key`), so a track is streamed once per run
        # (StageCache). False with ANALYZE_STAGE_MAX_GB=0; absent on older
        # images, which ignore the field.
        "analyze_stage_capable": stage_cache.enabled,
        # How many analysis workers this pool holds (ANALYZE_CONCURRENCY). The
        # controller's blend render reads it to tell whether a spare member can
        # serve it while a pick-time separation holds one (#2253), and uses the
        # smaller of this and its own setting.
        "analyze_concurrency": ANALYZE_CONCURRENCY,
        # Best-effort residency (#1204): whether CLAP/Demucs are believed
        # loaded right now — lets an operator confirm the idle release
        # without grepping logs. None while the worker is down.
        "analyze_models_resident": (
            all(worker.models_resident for worker in ready) if ready else None
        ),
        # Conservative pool aggregate: seconds since the most recently completed
        # heavy request on any ready member (null when none has run).
        "analyze_heavy_idle_s": (
            round(time.monotonic() - max(heavy_times), 1) if heavy_times else None
        ),
        # The recycle clock, which is not the heavy one: seconds since the most
        # recent request of any kind on any ready member (null when none has
        # run since its worker spawned). What analyze_worker_recycles counts
        # down from.
        "analyze_idle_s": (
            round(time.monotonic() - max(use_times), 1) if use_times else None
        ),
        "analyze_worker_recycles": sum(worker.recycles for worker in analyzer_workers),
    }


class AnalyzeRequest(BaseModel):
    # Remote stream url, or a local path on the shared volume the controller
    # pre-fetched into (overlaps network I/O with the sidecar's compute).
    url: str | None = None
    path: str | None = None
    # Per-request CLAP opt-in (the admin toggle); None keeps the worker's
    # env-driven default.
    embed: bool | None = None
    # Same, for Demucs vocal-activity ranges.
    vocal: bool | None = None
    # Whether `path` holds the COMPLETE file. False vetoes outro analysis (a
    # truncated file's "tail" is mid-song audio); None = unknown, the worker's
    # decode-length check guards.
    complete: bool | None = None
    # Stem-cache target dir (stem-blend transitions). When set, the worker
    # persists the Demucs stems it already computes as FLAC into this dir —
    # implies the separation pass even when `vocal` wasn't requested.
    stems_dir: str | None = None
    # Write stems only when the stems root (stems_dir's parent) carries the
    # .subwave-stems marker, so an unmounted share on this machine is not
    # written to as if it were the cache.
    stems_require_marker: bool | None = None
    # CLAP backfill for a track whose baseline analysis is already current.
    # Skips every non-embedding feature in the worker.
    embedding_only: bool = False
    # Per-facet request: compute ONLY these facets (head, loudness, tail,
    # clap, vocal, stems, edges, grid, structure) and answer {"facets": {...}, "source": {...}}.
    # Absent = the flat response above, unchanged. embed / vocal /
    # embedding_only are ignored when this is set: the facets say it all.
    facets: list[str] | None = None
    # With facets that read only the tail and a `url`: read just the end of
    # the file by HTTP Range (FLAC / MP3 with a provable length); anything
    # else falls back to the capped download, reported in source.fallback.
    ranged: bool = False
    # Tail facet also measures the outro's vocal ranges (one Demucs pass over
    # the tail window), as the flat response does when Demucs is loaded.
    tail_vocals: bool = False
    # Facet requests only: the music server's stream URL the whole-file facets
    # (loudness v2, edges) read when `path` is a capped copy. Never fetched
    # here; the worker's ffmpeg streams it.
    stream_url: str | None = None
    # Facet requests only: where the music stops ({end_ms, duration_ms}, from
    # the stored edges), so the tail window ends there instead of at the end
    # of the file. Passed through as is; the worker validates it.
    tail_window: dict[str, Any] | None = None
    # Facet requests only: which windows the `stems` facet separates ("head",
    # "tail"). Absent = both. Pick-time stems asks for the tail alone when the
    # head is cached (#2253); a worker that predates the field separates both.
    # Untyped here: the worker's parse_stems_windows judges it, and a malformed
    # value separates both windows there rather than a 422 refusing the request.
    stems_windows: Any = None
    # With stems_dir: the library's size for the file, which the worker stamps
    # on the stem windows it writes (#2238). Untyped like stems_windows: the
    # worker judges it, and a bad value stamps unknown rather than a 422.
    source_size: Any = None
    # Facet requests only: the beat grid the `structure` facet measures its
    # bars on ({beats_per_bar, decoded_ms, segments}), from the controller's
    # library (the worker never reads it). Untyped: the worker judges it.
    structure_grid: Any = None
    # Facet requests by URL that read the whole file (loudness, edges, grid,
    # structure): the run-scoped copy to read instead (StageCache), and
    # whether this request may fetch it (`stage_keep`) or only reuse it.
    stage_key: str | None = None
    stage_keep: bool | None = None


class StageReleaseRequest(BaseModel):
    # A run token: every copy whose key starts with it.
    prefix: str


@app.post("/stage/release")
async def stage_release(req: StageReleaseRequest):
    return {"ok": True, "released": stage_cache.release_prefix(req.prefix)}


def _reads_whole_file_only(facets: Any) -> bool:
    return bool(facets) and isinstance(facets, list) and all(f in WHOLE_FILE_LANE_FACETS or f == "grid" for f in facets)


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    if req.path:
        # A controller can reach this sidecar over HTTP without sharing its
        # state mount. Name that boundary failure before handing it to the
        # worker, so the controller can retry by URL without also retrying
        # genuine decode/model failures.
        if not os.path.isfile(req.path) or not os.access(req.path, os.R_OK):
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "path_unavailable",
                    "message": f"analyzer cannot read controller path: {req.path}",
                },
            )
        payload: dict[str, Any] = {"id": "1", "path": req.path}
    elif req.url:
        payload = {"id": "1", "url": req.url}
    else:
        raise HTTPException(400, "missing 'url' or 'path'")
    # A whole-file request by URL that names its run's copy reads the copy
    # (the stream's own bytes, complete), and the URL rides along as the
    # stream_url the worker would fall back to. Refused or absent: the URL.
    staged_key: str | None = None
    stage_key = getattr(req, "stage_key", None)
    if req.url and not req.path and isinstance(stage_key, str) and 0 < len(stage_key) <= 512 \
            and _reads_whole_file_only(getattr(req, "facets", None)):
        staged = await stage_cache.acquire(stage_key, req.url, keep=getattr(req, "stage_keep", None) is True)
        if staged:
            staged_key = stage_key
            payload = {"id": "1", "path": staged, "complete": True, "stream_url": req.url}
    try:
        return await _analyze_payload(req, payload)
    finally:
        if staged_key:
            stage_cache.release_reader(staged_key)


async def _analyze_payload(req: AnalyzeRequest, payload: dict[str, Any]):
    if req.embed is not None:
        payload["embed"] = req.embed
    if req.vocal is not None:
        payload["vocal"] = req.vocal
    if req.complete is not None:
        payload["complete"] = req.complete
    if req.stems_dir is not None:
        payload["stems_dir"] = req.stems_dir
    if req.stems_require_marker is not None:
        payload["stems_require_marker"] = req.stems_require_marker
    if req.stems_dir is not None and req.source_size is not None:
        payload["source_size"] = req.source_size
    if req.embedding_only:
        payload["embedding_only"] = True
    # A placed tail window (flat and facet requests alike) and the stream URL
    # the worker reads it from when the staged copy cannot prove it reaches it.
    if req.tail_window is not None:
        payload["tail_window"] = req.tail_window
        if req.stream_url and "url" not in payload:
            payload["stream_url"] = req.stream_url
    facets = getattr(req, "facets", None)
    if facets is not None:
        payload["facets"] = facets
        if getattr(req, "ranged", False):
            payload["ranged"] = True
        if getattr(req, "tail_vocals", False):
            payload["tail_vocals"] = True
        if req.stream_url and "url" not in payload:
            payload["stream_url"] = req.stream_url
        if req.stems_windows is not None:
            payload["stems_windows"] = req.stems_windows
        if req.structure_grid is not None:
            payload["structure_grid"] = req.structure_grid
    if facets and all(f in WHOLE_FILE_LANE_FACETS for f in facets):
        msg = await run_whole_file_once(payload)
    else:
        msg = await analyzer_pool.request(payload)
    if not msg.get("ok"):
        raise HTTPException(500, msg.get("error") or "analyze failed")
    if facets is not None:
        return {"ok": True, "facets": msg.get("facets") or {}, "source": msg.get("source")}
    out: dict[str, Any] = {
        "ok": True,
        "bpm": msg.get("bpm"),
        "key": msg.get("key"),
        "intro_ms": msg.get("intro_ms"),
        "confidence": msg.get("confidence"),
    }
    # Optional fields — passed through only when the worker computed them, so
    # the client maps omissions to null.
    for k in (
        "loudness_lufs", "peak_db", "sections", "vocal_ranges",
        "pace_curve", "beats", "bars", "key_ranges", "outro", "stems_cached",
        "tail_stems_landed",
        "lead_silence_ms", "tail_silence_ms", "tail_start_ms", "tail_window",
        "tail_curve_unavailable",
    ):
        if k in msg:
            out[k] = msg[k]
    if "audio_embedding" in msg:
        out["audio_embedding"] = msg["audio_embedding"]
    return out


class RenderTransitionRequest(BaseModel):
    # Stem-blend transition render. The controller supplies per-track
    # alignment data straight from library.db — the worker never re-detects.
    # Cache-hit-only: missing stems → ok=false.
    out: dict[str, Any]
    in_: dict[str, Any] = Field(alias="in")
    out_dir: str
    clip_name: str | None = None
    target_lufs: float | None = None

    model_config = {"populate_by_name": True}


@app.post("/render-transition")
async def render_transition(req: RenderTransitionRequest):
    """Mix a pre-rendered transition WAV from two tracks' cached stems onto
    the shared volume. Fast (a mix, not a separation) and bounded by the same
    pool, so an idle member can serve it without waiting behind every bulk job."""
    payload: dict[str, Any] = {
        "id": "1",
        "op": "render_transition",
        "out": req.out,
        "in": req.in_,
        "out_dir": req.out_dir,
    }
    if req.clip_name is not None:
        payload["clip_name"] = req.clip_name
    if req.target_lufs is not None:
        payload["target_lufs"] = req.target_lufs
    msg = await analyzer_pool.request(payload)
    if not msg.get("ok"):
        # A clean miss (stems absent, degenerate grids) is an expected
        # outcome, not a server fault — pass the reason through as 200 so the
        # controller can distinguish fallback from failure.
        return {"ok": False, "error": msg.get("error") or "render failed"}
    return {
        "ok": True,
        "path": msg.get("path"),
        "blend_start_sec": msg.get("blend_start_sec"),
        "in_cue_sec": msg.get("in_cue_sec"),
        "clip_sec": msg.get("clip_sec"),
    }


class EmbedTextRequest(BaseModel):
    # 1-64 non-empty strings (the worker enforces the same envelope). One
    # request = one worker round-trip, so mood-vocabulary batches go in one call.
    texts: list[str]


@app.post("/embed-text")
async def embed_text(req: EmbedTextRequest):
    """CLAP text-tower embeddings — 512-d vectors in the SAME space as the
    audio vectors ("sounds like ..." search, zero-shot mood scoring). 500s
    cleanly on a lean build (no torch); the controller treats any failure as
    "text embedding unavailable"."""
    if not req.texts:
        raise HTTPException(400, "missing 'texts'")
    msg = await analyzer_pool.request({"id": "1", "texts": req.texts})
    if not msg.get("ok"):
        raise HTTPException(500, msg.get("error") or "embed-text failed")
    return {"ok": True, "embeddings": msg.get("text_embeddings") or []}


