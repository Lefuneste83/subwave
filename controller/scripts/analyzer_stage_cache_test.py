"""The sidecar's run-scoped whole-file copies (docker/analyzer/server.py
StageCache) and the /analyze wiring that reads them.

Pinned here:
  - two requests for one key share one download; a reuse-only request never
    downloads; a refused or failed download leaves the request on the URL and
    counts no bytes;
  - the byte budget is an admission rule (a copy that does not fit is not
    kept, nothing kept is evicted for it), and a release by run prefix frees
    it; a copy being read is deleted only once its reader is done; idle
    copies expire;
  - the real download keeps only a complete audio body of known length (no
    length, a text answer, a short body: refused, no file left), byte for byte;
  - /analyze hands the worker the copy (complete, the URL as stream_url) only
    for a whole-file request by URL naming a key, and releases its reader;
  - the whole-file figures, the grid decode and the structure read off the
    copy equal the ones read off the stream URL (needs ffmpeg, numpy, scipy:
    the analyzer image; skipped elsewhere).
Run in the analyzer image (see references/running-gates.md), or plain python3
for everything but the last case.
"""

import asyncio
import http.server
import importlib.util
import os
import shutil
import sys
import tempfile
import threading
import types
from pathlib import Path


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


class FastAPI:
    def __init__(self, **_kwargs):
        pass

    def get(self, _path):
        return lambda fn: fn

    def post(self, _path):
        return lambda fn: fn


class BaseModel:
    def __init__(self, **values):
        for key, value in values.items():
            setattr(self, key, value)


fastapi = types.ModuleType("fastapi")
fastapi.FastAPI = FastAPI
fastapi.HTTPException = HTTPException
pydantic = types.ModuleType("pydantic")
pydantic.BaseModel = BaseModel
pydantic.Field = lambda **_kwargs: None
sys.modules.setdefault("fastapi", fastapi)
sys.modules.setdefault("pydantic", pydantic)

server_path = Path(__file__).parents[2] / "docker" / "analyzer" / "server.py"
spec = importlib.util.spec_from_file_location("subwave_analyzer_server_stage", server_path)
assert spec and spec.loader
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

MB = 1024 * 1024


def fake_download(sizes, calls, delay=0.05, refuse=()):
    """A download that writes `sizes[url]` bytes, after asking admit()."""
    import time

    def download(url, dest, admit, _timeout):
        calls.append(url)
        time.sleep(delay)
        if url in refuse:
            raise server.StageRefused("not audio")
        n = sizes[url]
        if not admit(n):
            raise server.StageRefused("over budget")
        with open(dest, "wb") as f:
            f.write(b"\0" * n)
        return n
    return download


def cache(root, max_bytes=100 * MB, calls=None, sizes=None, refuse=(), clock=None, delay=0.05):
    return server.StageCache(
        root, max_bytes, 3600.0, download=fake_download(sizes or {}, calls if calls is not None else [], delay, refuse),
        clock=clock or (lambda: 0.0), min_free=0,
    )


def test_one_download_per_key_and_reuse_only():
    root = tempfile.mkdtemp()
    calls = []
    c = cache(root, calls=calls, sizes={"u1": 10})

    async def go():
        assert await c.acquire("run/a", "u1", keep=False) is None, "reuse-only never downloads"
        assert calls == []
        a, b = await asyncio.gather(c.acquire("run/a", "u1", keep=True), c.acquire("run/a", "u1", keep=True))
        assert a and a == b and os.path.isfile(a)
        assert calls == ["u1"], calls
        c.release_reader("run/a")
        c.release_reader("run/a")
        again = await c.acquire("run/a", "u1", keep=False)
        assert again == a, "a later read reuses the copy"
        c.release_reader("run/a")
        assert c.used_bytes == 10
    asyncio.run(go())
    shutil.rmtree(root)
    print("✓ one download per key; reuse-only never downloads")


def test_refused_download_reads_the_stream_and_counts_nothing():
    root = tempfile.mkdtemp()
    c = cache(root, sizes={"u1": 10}, refuse=("u1",))

    async def go():
        assert await c.acquire("run/a", "u1", keep=True) is None
        assert c.used_bytes == 0 and c.entries == {}
    asyncio.run(go())
    shutil.rmtree(root)
    print("✓ a refused download leaves the request on the URL")


def test_budget_is_admission_and_release_frees_it():
    root = tempfile.mkdtemp()
    c = cache(root, max_bytes=15, sizes={"u1": 10, "u2": 10})

    async def go():
        a = await c.acquire("run/a", "u1", keep=True)
        c.release_reader("run/a")
        assert a
        assert await c.acquire("run/b", "u2", keep=True) is None, "does not fit: not kept"
        assert "run/a" in c.entries, "nothing kept is evicted for it"
        assert c.used_bytes == 10
        assert c.release_prefix("run/") == 1
        assert c.used_bytes == 0 and not os.path.exists(a)
        assert await c.acquire("run2/b", "u2", keep=True), "fits once released"
    asyncio.run(go())
    shutil.rmtree(root)
    print("✓ the budget admits, never evicts; a release frees it")


def test_copy_in_use_survives_release_until_read():
    root = tempfile.mkdtemp()
    c = cache(root, sizes={"u1": 10})

    async def go():
        a = await c.acquire("run/a", "u1", keep=True)
        c.release_prefix("run/")
        assert os.path.isfile(a), "still being read"
        assert await c.acquire("run/a", "u1", keep=False) is None, "released: no new reader"
        c.release_reader("run/a")
        assert not os.path.exists(a) and c.used_bytes == 0
    asyncio.run(go())
    shutil.rmtree(root)
    print("✓ a copy being read goes when its reader is done")


def test_idle_copies_expire():
    root = tempfile.mkdtemp()
    now = [0.0]
    c = cache(root, sizes={"u1": 10, "u2": 10}, clock=lambda: now[0])

    async def go():
        a = await c.acquire("run/a", "u1", keep=True)
        c.release_reader("run/a")
        now[0] = 3601.0
        await c.acquire("run/b", "u2", keep=True)
        assert not os.path.exists(a) and "run/a" not in c.entries
    asyncio.run(go())
    shutil.rmtree(root)
    print("✓ idle copies expire")


def test_only_own_files_are_cleared():
    root = tempfile.mkdtemp()
    keep = os.path.join(root, "operator-notes.txt")
    old = os.path.join(root, "a" * 40 + ".audio")
    for p in (keep, old):
        Path(p).write_text("x")
    c = cache(root, sizes={"u1": 10})
    asyncio.run(c.acquire("run/a", "u1", keep=True))
    assert os.path.exists(keep), "never a file it did not write"
    assert not os.path.exists(old), "a copy left by an earlier container"
    shutil.rmtree(root)
    print("✓ only the cache's own names are ever deleted")


class _Handler(http.server.BaseHTTPRequestHandler):
    routes = {}

    def do_GET(self):  # noqa: N802
        status, headers, body = self.routes[self.path]
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the refused cases hang up mid-body on purpose

    def log_message(self, *_a):
        pass


def serve(routes):
    _Handler.routes = routes
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


def test_real_download_keeps_only_a_complete_audio_body():
    body = os.urandom(3 * MB + 123)
    httpd, base = serve({
        "/ok": (200, {"Content-Type": "audio/flac", "Content-Length": str(len(body))}, body),
        "/nolen": (200, {"Content-Type": "audio/flac"}, body[:1000]),
        "/text": (200, {"Content-Type": "text/xml", "Content-Length": "5"}, b"<err>"),
        "/short": (200, {"Content-Type": "audio/flac", "Content-Length": str(len(body) + 10)}, body),
    })
    root = tempfile.mkdtemp()
    try:
        dest = os.path.join(root, "x.audio")
        assert server._download_whole(base + "/ok", dest, lambda n: True, 10) == len(body)
        assert Path(dest).read_bytes() == body, "byte for byte"
        for path in ("/nolen", "/text", "/short"):
            d = os.path.join(root, path.strip("/") + ".audio")
            try:
                server._download_whole(base + path, d, lambda n: True, 10)
                raise AssertionError(f"{path} kept")
            except server.StageRefused:
                pass
            except Exception as e:  # noqa: BLE001 — a short body may surface as IncompleteRead
                assert path == "/short", f"{path}: {e!r}"
            assert not os.path.exists(d) and not os.path.exists(d + ".part"), path
        refused = os.path.join(root, "refused.audio")
        try:
            server._download_whole(base + "/ok", refused, lambda n: False, 10)
            raise AssertionError("over budget kept")
        except server.StageRefused:
            pass
        assert not os.path.exists(refused)
    finally:
        httpd.shutdown()
        httpd.server_close()
        shutil.rmtree(root)
    print("✓ the download keeps only a complete audio body, byte for byte")


def test_analyze_reads_the_copy_only_for_named_whole_file_requests():
    root = tempfile.mkdtemp()
    saved = server.stage_cache, server.run_whole_file_once, server.analyzer_pool.request
    seen = []

    async def once(payload):
        seen.append(("lane", dict(payload)))
        return {"ok": True, "facets": {}, "source": {"kind": "whole-file"}}

    async def pool(payload):
        seen.append(("pool", dict(payload)))
        return {"ok": True, "facets": {}, "source": {"kind": "whole-file"}}

    server.stage_cache = cache(root, sizes={"http://nd/s?id=1": 10})
    server.run_whole_file_once = once
    server.analyzer_pool.request = pool

    def req(**kw):
        base = dict(url="http://nd/s?id=1", path=None, embed=None, vocal=None, complete=None, stems_dir=None,
                    stems_require_marker=None, source_size=None, embedding_only=None, tail_window=None,
                    stream_url=None, facets=None, ranged=False, tail_vocals=False, stems_windows=None,
                    structure_grid=None, stage_key=None, stage_keep=None)
        base.update(kw)
        return server.AnalyzeRequest(**base)

    async def go():
        await server.analyze(req(facets=["loudness", "edges"], stage_key="run/1", stage_keep=True))
        lane, p = seen[-1]
        assert lane == "lane" and p["path"].startswith(root) and p["complete"] is True
        assert p["stream_url"] == "http://nd/s?id=1" and "url" not in p
        assert server.stage_cache.entries["run/1"]["readers"] == 0, "reader released"
        await server.analyze(req(facets=["grid"], stage_key="run/1"))
        lane, p = seen[-1]
        assert lane == "pool" and p["path"].startswith(root), "the grid reads the same copy"
        await server.analyze(req(facets=["loudness", "edges"]))
        assert seen[-1][1]["url"] == "http://nd/s?id=1" and "path" not in seen[-1][1], "no key: the URL"
        await server.analyze(req(facets=["head", "loudness"], stage_key="run/1"))
        assert "path" not in seen[-1][1], "a window read never takes the copy"
    try:
        asyncio.run(go())
    finally:
        server.stage_cache, server.run_whole_file_once, server.analyzer_pool.request = saved
        shutil.rmtree(root)
    print("✓ /analyze hands the copy only to named whole-file requests")


def test_figures_off_the_copy_equal_the_stream():
    if not shutil.which("ffmpeg"):
        print("- skipped: ffmpeg unavailable (run in the analyzer image)")
        return
    try:
        import numpy as np
        sys.path.insert(0, str(Path(__file__).parent))
        import analyze_worker as w
    except Exception as e:  # noqa: BLE001
        print(f"- skipped: worker imports unavailable ({e})")
        return
    import subprocess
    work = tempfile.mkdtemp()
    try:
        flac = os.path.join(work, "t.flac")
        mp3 = os.path.join(work, "t.mp3")
        src = ("aevalsrc='0.6*sin(2*PI*55*t)*exp(-20*mod(t,60/124))+0.1*sin(2*PI*440*t)+0.05*(random(0)-0.5)|"
               "0.6*sin(2*PI*55*t)*exp(-20*mod(t,60/124))+0.1*sin(2*PI*660*t)':s=44100:d=95")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", src, "-af", "adelay=1500|1500,apad=pad_dur=2",
                        "-c:a", "flac", flac], check=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", flac, "-c:a", "libmp3lame", "-b:a", "192k", mp3], check=True)
        routes = {}
        for name, path, ctype in (("/t.flac", flac, "audio/flac"), ("/t.mp3", mp3, "audio/mpeg")):
            data = Path(path).read_bytes()
            routes[name] = (200, {"Content-Type": ctype, "Content-Length": str(len(data))}, data)
        httpd, base = serve(routes)
        per = 60 / 124
        grid = {"beats_per_bar": 4, "decoded_ms": 98500, "segments": [
            {"anchorMs": 1500.0, "periodUs": per * 1e6, "beats": int(95 / per) - 2, "downbeatMs": 1500.0}]}
        try:
            for name in routes:
                url = base + name
                copy = os.path.join(work, "copy" + Path(name).suffix)
                server._download_whole(url, copy, lambda n: True, 30)
                assert w.whole_file_input(copy, True, url) == copy
                a = w.whole_file_facets(url, ["loudness", "edges"])
                b = w.whole_file_facets(copy, ["loudness", "edges"])
                assert a == b, f"{name}: {a} != {b}"
                assert a["edges"]["status"] == "ok" and a["loudness"]["status"] == "ok", a
                ya, _ = w.decode_mono(url)
                yb, _ = w.decode_mono(copy)
                assert np.array_equal(ya, yb), f"{name}: grid decode differs"
                assert w.facet_structure(url, grid) == w.facet_structure(copy, grid), f"{name}: structure differs"
        finally:
            httpd.shutdown()
            httpd.server_close()
    finally:
        shutil.rmtree(work)
    print("✓ loudness, edges, the grid decode and the structure off the copy equal the stream's (FLAC, MP3)")


if __name__ == "__main__":
    test_one_download_per_key_and_reuse_only()
    test_refused_download_reads_the_stream_and_counts_nothing()
    test_budget_is_admission_and_release_frees_it()
    test_copy_in_use_survives_release_until_read()
    test_idle_copies_expire()
    test_only_own_files_are_cleared()
    test_real_download_keeps_only_a_complete_audio_body()
    test_analyze_reads_the_copy_only_for_named_whole_file_requests()
    test_figures_off_the_copy_equal_the_stream()
