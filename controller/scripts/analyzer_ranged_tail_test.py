#!/usr/bin/env python3
# Ranged tail reads (RangedTailSource) against a local HTTP server, compared
# with the flat analysis of the same file read whole. Needs the analyzer
# runtime (librosa, soundfile, ffmpeg) like analyzer_characterisation_test.py,
# so it runs inside the analyzer image, not in the npm shim:
#
#   docker exec -u 0 subwave-analyzer mkdir -p /tmp/rt
#   tar cf - analyze_worker.py analyzer_characterisation_test.py analyzer_ranged_tail_test.py \
#     | docker exec -i -u 0 subwave-analyzer tar xf - -C /tmp/rt
#   docker exec subwave-analyzer /opt/analyzer/venv/bin/python /tmp/rt/analyzer_ranged_tail_test.py
#
# What it pins:
#   * FLAC (plain, ID3v2-prefixed, with cover art) and MP3 (LAME VBR, CBR
#     without a header): the ranged tail facet equals the flat tail within one
#     analysis frame, and reads a small fraction of the file;
#   * what can't be proven falls back to the capped download, with the reason:
#     VBR MP3 without a header, WAV, a server that ignores Range;
#   * a request whose facets read more than the tail never goes ranged;
#   * a file smaller than the tail fetch is decoded whole, as it is: a sparse
#     106 s FLAC with ~220 KB of cover art (shaped like a production file that
#     failed) measures ranged, and a whole file decoding shorter than its
#     header falls back instead of failing.

import http.server
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import analyzer_characterisation_test as ct  # noqa: E402  (fixture audio + runtime checks)
import analyze_worker as aw  # noqa: E402
import librosa  # noqa: E402
import numpy as np  # noqa: E402

TOL_MS = 30
failures = 0


def check(name, ok, detail=""):
    global failures
    print(f"  {'✓' if ok else '✗'} {name}{'' if ok else '  ' + detail}")
    if not ok:
        failures += 1


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    ignore_range = False

    def log_message(self, *_a):
        pass

    def do_GET(self):
        path = self.translate_path(self.path.split("?")[0])
        if not os.path.isfile(path):
            self.send_error(404)
            return
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        with open(path, "rb") as f:
            if not rng or self.ignore_range:
                self.send_response(200)
                self.send_header("Content-Length", str(size))
                self.end_headers()
                try:
                    shutil.copyfileobj(f, self.wfile)
                except (ConnectionResetError, BrokenPipeError):
                    pass  # the client hung up on a 200, as it should
                return
            spec = rng.split("=", 1)[1]
            a, b = spec.split("-", 1)
            if a == "":
                start, end = max(0, size - int(b)), size - 1
            else:
                start, end = int(a), (int(b) if b else size - 1)
            end = min(end, size - 1)
            f.seek(start)
            body = f.read(end - start + 1)
        self.send_response(206)
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class IgnoringHandler(RangeHandler):
    ignore_range = True


def serve(directory, handler):
    h = lambda *a, **k: handler(*a, directory=directory, **k)  # noqa: E731
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), h)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def make_fixtures(d):
    music = np.vstack([ct._noise_music(170, 11), ct._silence(4)])  # 174 s, 4 s dead air
    fx = {}

    def enc(name, args, x=music):
        p = os.path.join(d, name)
        ct._write(p, x, args)
        return p

    fx["flac"] = enc("plain.flac", ["-c:a", "flac"])
    # ID3v2 before fLaC (seen on 6 production files) + embedded cover art.
    art = os.path.join(d, "cover.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=600x600",
                    "-frames:v", "1", art], check=True)
    with_art = os.path.join(d, "art.flac")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", fx["flac"], "-i", art, "-map", "0:a", "-map", "1",
                    "-c:a", "copy", "-disposition:v", "attached_pic", with_art], check=True)
    fx["flac_art"] = with_art
    id3 = os.path.join(d, "id3.flac")
    with open(id3, "wb") as out, open(fx["flac"], "rb") as src:
        payload = b"\0" * 2000
        size = len(payload)
        syncsafe = bytes([(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F])
        out.write(b"ID3\x04\x00\x00" + syncsafe + payload + src.read())
    fx["flac_id3"] = id3
    fx["mp3_lame_vbr"] = enc("lame.mp3", ["-c:a", "libmp3lame", "-q:a", "0"])
    fx["mp3_cbr_noxing"] = enc("cbr.mp3", ["-c:a", "libmp3lame", "-b:a", "320k", "-write_xing", "0"])
    fx["mp3_vbr_noxing"] = enc("vbr_noxing.mp3", ["-c:a", "libmp3lame", "-q:a", "2", "-write_xing", "0"])
    fx["wav"] = enc("plain.wav", ["-c:a", "pcm_s16le"], x=np.vstack([ct._music(40, 3), ct._silence(3)]))
    fx["flac_small_art"], fx["flac_short_decode"] = small_fixtures(d)
    return fx


def small_fixtures(d):
    """Two FLACs smaller than the ranged fetch, so the whole file comes back.

    small_art: 106.48 s of a faint tone (~25 KB of audio) plus ~220 KB of
    incompressible cover art. With the synthetic header prepended, ffmpeg
    decoded it to 0 s. short_decode: the same audio without art, its
    STREAMINFO sample count doubled, so the header claims 213 s."""
    audio = os.path.join(d, "sparse.flac")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "sine=f=200:r=44100:d=106.48,volume=0.00005,aformat=channel_layouts=stereo",
                    "-c:a", "flac", "-sample_fmt", "s16", "-compression_level", "8", audio], check=True)
    art = os.path.join(d, "noise.png")
    w = 270  # 270*270*3 = 219 KB of noise: PNG cannot shrink it
    rgb = np.random.default_rng(7).integers(0, 256, size=(w, w, 3), dtype=np.uint8)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{w}",
                    "-i", "-", "-frames:v", "1", art], input=rgb.tobytes(), check=True)
    small_art = os.path.join(d, "sparse_art.flac")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", audio, "-i", art, "-map", "0:a", "-map", "1:v",
                    "-c", "copy", "-disposition:v", "attached_pic", small_art], check=True)
    with open(audio, "rb") as f:
        b = bytearray(f.read())
    total = ((b[21] & 0x0F) << 32) | int.from_bytes(b[22:26], "big")  # STREAMINFO at 8: samples at si[13:18]
    total *= 2
    b[21] = (b[21] & 0xF0) | ((total >> 32) & 0x0F)
    b[22:26] = (total & 0xFFFFFFFF).to_bytes(4, "big")
    short_decode = os.path.join(d, "short_decode.flac")
    with open(short_decode, "wb") as f:
        f.write(bytes(b))
    return small_art, short_decode


def flat_tail(path):
    r = aw.analyze(librosa, path=path, embed=False, vocal=False, complete=True)
    return r.get("tail_start_ms"), r.get("tail_silence_ms"), (r.get("outro") or {}).get("ending")


def facet_request(url, **extra):
    return aw.analyze_facet_request(librosa, {"url": url, "facets": ["tail"], "ranged": True, **extra})


def main():
    d = tempfile.mkdtemp(prefix="sw-ranged-")
    try:
        fx = make_fixtures(d)
        srv, base = serve(d, RangeHandler)
        nosrv, nobase = serve(d, IgnoringHandler)
        print("ranged tail vs whole-file analysis:")
        for name in ("flac", "flac_art", "flac_id3", "mp3_lame_vbr", "mp3_cbr_noxing"):
            path = fx[name]
            want_start, want_gap, want_end = flat_tail(path)
            r = facet_request(f"{base}/{os.path.basename(path)}")
            src, tail = r["source"], r["facets"]["tail"]
            ok = tail["status"] == "ok" and src["kind"] == "ranged"
            got = tail.get("data", {})
            d_start = abs((got.get("tail_start_ms") or 0) - (want_start or 0))
            d_gap = abs((got.get("tail_silence_ms") or 0) - (want_gap or 0))
            frac = src.get("bytes_read", 0) / max(1, src.get("size", 1))
            check(
                f"{name}: ranged, tail start Δ{d_start} ms, gap Δ{d_gap} ms, read {frac:.0%} of the file",
                ok and d_start <= TOL_MS and d_gap <= TOL_MS
                and got.get("outro", {}).get("ending") == want_end and frac < 0.35,
                f"{src} {tail} want start={want_start} gap={want_gap} ending={want_end}",
            )
        print("falls back to the capped download, with the reason:")
        for name, needle in (("mp3_vbr_noxing", "VBR MP3"), ("wav", "")):
            r = facet_request(f"{base}/{os.path.basename(fx[name])}")
            check(f"{name}: fallback ({r['source'].get('fallback')})",
                  r["source"]["kind"] != "ranged" and "fallback" in r["source"]
                  and needle in r["source"]["fallback"], str(r["source"]))
        print("a file smaller than the tail fetch is decoded whole:")
        path = fx["flac_small_art"]
        size = os.path.getsize(path)
        check(f"flac_small_art fixture: {size} bytes, under the {aw.RANGED_TAIL_MIN_BYTES}-byte fetch",
              size < aw.RANGED_TAIL_MIN_BYTES)
        want_start, want_gap, want_end = flat_tail(path)
        r = facet_request(f"{base}/{os.path.basename(path)}")
        src, tail = r["source"], r["facets"]["tail"]
        got = tail.get("data", {})
        d_start = abs((got.get("tail_start_ms") or 0) - (want_start or 0))
        # The tail is near-silent, so the flat analysis may find no tail start
        # either: what matters is that both paths reach the same answer, and
        # that the ranged one answers instead of failing.
        same = (tail["status"] == "unmeasurable" and want_start is None) or (
            tail["status"] == "ok" and d_start <= TOL_MS and got.get("outro", {}).get("ending") == want_end)
        check(f"flac_small_art: ranged whole-file read, {tail['status']} "
              f"({tail.get('reason') or f'tail start Δ{d_start} ms'}), same as the flat analysis",
              src["kind"] == "ranged" and same, f"{src} {tail} want start={want_start} ending={want_end}")
        r = facet_request(f"{base}/{os.path.basename(fx['flac_short_decode'])}")
        # Only the fallback is pinned: this fixture's header lies to every
        # reader, so the capped download may fail on it too (libsndfile seeks
        # past the end). What must not happen is a ranged read of a window
        # that starts before the decoded audio.
        check(f"header longer than the decoded file: fallback ({r['source'].get('fallback')})",
              r["source"]["kind"] != "ranged" and "decodes shorter" in r["source"].get("fallback", ""), str(r))
        r = facet_request(f"{nobase}/{os.path.basename(fx['flac'])}")
        check(f"server ignoring Range: fallback ({r['source'].get('fallback')})",
              r["source"]["kind"] != "ranged" and "200" in r["source"].get("fallback", ""), str(r["source"]))
        r = aw.analyze_facet_request(librosa, {"url": f"{base}/{os.path.basename(fx['flac'])}",
                                               "facets": ["head", "tail"], "ranged": True})
        check("head + tail never goes ranged", r["source"]["kind"] != "ranged", str(r["source"]))
        srv.shutdown()
        nosrv.shutdown()
    finally:
        shutil.rmtree(d, ignore_errors=True)
    if failures:
        print(f"✗ analyzer_ranged_tail_test.py: {failures} failure(s)")
        sys.exit(1)
    print("✓ analyzer_ranged_tail_test.py passed")


if __name__ == "__main__":
    main()
