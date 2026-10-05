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
#   * WAV (16/24-bit, float, RF64, tag chunks before and after the audio),
#     AIFF, AIFC float and DSF: the same, the tail cut on the frame grid;
#   * what can't be proven falls back to the capped download, with the reason:
#     VBR MP3 without a header, ADPCM WAV, a file in none of the read
#     formats, a server that ignores Range;
#   * a silent ending longer than the 20 s window (45 s on a FLAC, 100 s on a
#     WAV) is found by widening the ranged read: music end and gap within
#     150 ms; a gap wider than the widest search stays "silent-tail-window";
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
    fx["wav_adpcm"] = enc("adpcm.wav", ["-c:a", "adpcm_ms"], x=np.vstack([ct._music(40, 3), ct._silence(3)]))
    fx.update(pcm_fixtures(d))
    junk = os.path.join(d, "junk.mp3")  # named .mp3, holds no audio at all
    with open(junk, "wb") as f:
        f.write(np.random.default_rng(3).integers(0, 255, size=2 * 1024 * 1024, dtype=np.uint8).tobytes())
    fx["junk"] = junk
    # Silent endings longer than the 20 s tail window (hidden tracks, long
    # fades, DJ sets): the tail is searched wider, by range.
    fx["flac_silent_end"] = enc("silent_end.flac", ["-c:a", "flac"],
                                x=np.vstack([ct._noise_music(150, 21), ct._silence(45)]))
    fx["wav_silent_end"] = enc("silent_end.wav", ["-c:a", "pcm_s16le"],
                               x=np.vstack([ct._noise_music(150, 22), ct._silence(100)]))
    fx["flac_small_art"], fx["flac_short_decode"] = small_fixtures(d)
    fx.update(tag_fixtures(d, fx))
    return fx


PCM_SECONDS = 100  # + 4 s of dead air: long enough that a 22 s tail is a small read


def _riff_chunk(cid, body):
    return cid + len(body).to_bytes(4, "little") + body + (b"\0" if len(body) & 1 else b"")


def _wav_with_chunks(src, dst, before=b"", after=b""):
    """Rewrite a WAV with extra chunks before 'data' and after it, the way
    taggers leave them (a LIST/bext block in front, an 'id3 ' chunk at the
    end), fixing the RIFF size."""
    with open(src, "rb") as f:
        b = f.read()
    at, chunks = 12, []
    while at + 8 <= len(b):
        cid, size = b[at:at + 4], int.from_bytes(b[at + 4:at + 8], "little")
        chunks.append((cid, b[at + 8:at + 8 + size]))
        at += 8 + size + (size & 1)
    body = b"WAVE"
    for cid, data in chunks:
        if cid == b"data":
            body += before
        body += _riff_chunk(cid, data)
    body += after
    with open(dst, "wb") as f:
        f.write(b"RIFF" + len(body).to_bytes(4, "little") + body)


def write_dsf(path, x, sr, dsd_rate=2822400, block=4096):
    """A DSF (1-bit, LSB first, block-interleaved) of `x` (n, ch) at `sr`,
    from a first-order sigma-delta modulator: crude, but its noise sits far
    above the audio band, which the decoder's low-pass removes."""
    up = dsd_rate // sr
    x = x / (np.max(np.abs(x)) or 1.0) * 0.5
    n, ch = x.shape
    total = n * up
    per_ch = []
    for c in range(ch):
        carry, out = 0.0, []
        for i in range(0, n, sr):
            seg = np.repeat((x[i:i + sr, c] + 1.0) / 2.0, up)
            s_ = carry + np.cumsum(seg)
            fl = np.floor(s_)
            prev = np.concatenate(([np.floor(carry)], fl[:-1]))
            out.append((fl - prev).astype(np.uint8))
            carry = s_[-1]
        bits = np.concatenate(out)
        pad = (-len(bits)) % (block * 8)
        bits = np.concatenate([bits, np.zeros(pad, np.uint8)])
        per_ch.append(np.packbits(bits.reshape(-1, 8), axis=1, bitorder="little").reshape(-1, block))
    groups = per_ch[0].shape[0]
    data = np.stack(per_ch, axis=1).reshape(groups * ch * block).tobytes()
    le = lambda v, k: int(v).to_bytes(k, "little")  # noqa: E731
    fmt = (b"fmt " + le(52, 8) + le(1, 4) + le(0, 4) + le(2 if ch == 2 else 1, 4) + le(ch, 4)
           + le(dsd_rate, 4) + le(1, 4) + le(total, 8) + le(block, 4) + le(0, 4))
    head = b"DSD " + le(28, 8) + le(28 + 52 + 12 + len(data), 8) + le(0, 8)
    with open(path, "wb") as f:
        f.write(head + fmt + b"data" + le(12 + len(data), 8) + data)


def pcm_fixtures(d):
    """Uncompressed and DSD files, the formats behind most of the ~620
    production tails still refused as capped downloads (5 Oct 2026)."""
    x = np.vstack([ct._noise_music(PCM_SECONDS, 13), ct._silence(4)])
    fx = {}

    def enc(name, args):
        p = os.path.join(d, name)
        ct._write(p, x, args)
        return p

    fx["wav_s16"] = enc("s16.wav", ["-c:a", "pcm_s16le"])
    s24 = enc("s24_src.wav", ["-c:a", "pcm_s24le"])  # WAVE_FORMAT_EXTENSIBLE
    fx["wav_s24_tagged"] = os.path.join(d, "s24_tagged.wav")
    # A 300 KB LIST chunk in front of the audio (past the head fetch) and an
    # ID3 chunk behind it.
    _wav_with_chunks(s24, fx["wav_s24_tagged"], before=_riff_chunk(b"LIST", b"INFO" + b"\x01" * 300_001),
                     after=_riff_chunk(b"id3 ", _id3(4000)))
    fx["wav_f32"] = enc("f32.wav", ["-c:a", "pcm_f32le"])
    fx["wav_rf64"] = enc("rf64.wav", ["-c:a", "pcm_s16le", "-rf64", "always"])
    fx["aiff_s16"] = enc("s16.aiff", ["-c:a", "pcm_s16be"])
    fx["aifc_f32"] = enc("f32.aiff", ["-c:a", "pcm_f32be"])
    fx["dsf"] = os.path.join(d, "dsd64.dsf")
    write_dsf(fx["dsf"], x, ct.SR)
    fx["dsf_ref"] = fx["wav_s16"]
    return fx


def _id3(payload_size):
    """An ID3v2.3 tag of exactly 10 + payload_size bytes (zero padding)."""
    s = payload_size
    syncsafe = bytes([(s >> 21) & 0x7F, (s >> 14) & 0x7F, (s >> 7) & 0x7F, s & 0x7F])
    return b"ID3\x03\x00\x00" + syncsafe + b"\0" * s


def _strip_id3(data):
    n = aw._id3v2_size(data)
    return data[n:]


def tag_fixtures(d, fx):
    """MP3s shaped like production files the ranged reader refused (5 Oct
    2026, 70 tracks reported as "not FLAC or MP3"):
      * tag_127k: one ID3 tag ending just under the 128 KB head fetch
        (130,147 bytes, like "Awka – Arya"), so under 1 KB of audio follows;
      * two_tags: two ID3 tags in a row (104,621 + 28,721 bytes);
      * big_tag: one 415 KB tag, past the head fetch, on a CBR MP3 without a
        Xing header, so the length comes from the audio's byte offset;
      * junk_head: ~230 KB of UTF-16 text and no ID3 header before the first
        frame (a damaged tag)."""
    out = {}
    with open(fx["mp3_lame_vbr"], "rb") as f:
        vbr = _strip_id3(f.read())
    with open(fx["mp3_cbr_noxing"], "rb") as f:
        cbr = _strip_id3(f.read())
    junk = ("﻿" + "Summer of love, a long comment that was never closed. " * 2200).encode("utf-16-le")
    junk = b"\xff\xfe" + junk[2:][: 230 * 1024]
    for name, data in (
        ("mp3_tag127k", _id3(130_147 - 10) + vbr),
        ("mp3_two_tags", _id3(104_621 - 10) + _id3(28_721 - 10) + vbr),
        ("mp3_big_tag_cbr", _id3(415_175 - 10) + cbr),
        ("mp3_junk_head", junk + vbr),
    ):
        p = os.path.join(d, name + ".mp3")
        with open(p, "wb") as f:
            f.write(data)
        out[name] = p
    return out


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
        # A tagged fixture is the same audio as its source with bytes in front,
        # so its tail must equal the SOURCE's whole-file tail (the flat analysis
        # of the tagged file itself can stumble on a 400 KB tag; that is not
        # what is being pinned here).
        reference = {"mp3_tag127k": "mp3_lame_vbr", "mp3_two_tags": "mp3_lame_vbr",
                     "mp3_big_tag_cbr": "mp3_cbr_noxing", "mp3_junk_head": "mp3_lame_vbr",
                     "wav_s24_tagged": "wav_s16", "dsf": "wav_s16"}
        for name in ("flac", "flac_art", "flac_id3", "mp3_lame_vbr", "mp3_cbr_noxing",
                     "mp3_tag127k", "mp3_two_tags", "mp3_big_tag_cbr", "mp3_junk_head",
                     "wav_s16", "wav_s24_tagged", "wav_f32", "wav_rf64", "aiff_s16", "aifc_f32", "dsf"):
            path = fx[name]
            want_start, want_gap, want_end = flat_tail(fx[reference.get(name, name)])
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
        print("a silent ending longer than the tail window is searched wider:")
        for name, music_s, gap_s in (("flac_silent_end", 150, 45), ("wav_silent_end", 150, 100)):
            r = facet_request(f"{base}/{os.path.basename(fx[name])}")
            src, tail = r["source"], r["facets"]["tail"]
            got = tail.get("data", {})
            d_end = abs((got.get("tail_start_ms") or 0) - music_s * 1000)
            d_gap = abs((got.get("tail_silence_ms") or 0) - gap_s * 1000)
            frac = src.get("bytes_read", 0) / max(1, src.get("size", 1))
            outro = got.get("outro", {})
            check(f"{name}: ranged, music end Δ{d_end} ms, gap {got.get('tail_silence_ms')} ms "
                  f"(Δ{d_gap}), outro {outro.get('ending')}, read {frac:.0%} of the file",
                  tail["status"] == "ok" and src["kind"] == "ranged" and d_end <= 150 and d_gap <= 150
                  and outro.get("startMs", 0) <= music_s * 1000 and "_searched" not in outro,
                  f"{src} {tail}")
        saved = aw.TAIL_SEARCH_SECONDS
        aw.TAIL_SEARCH_SECONDS = (60.0,)  # narrower than the 100 s gap
        try:
            r = facet_request(f"{base}/{os.path.basename(fx['wav_silent_end'])}")
            check(f"gap wider than the widest search: still {r['facets']['tail'].get('reason')}",
                  r["facets"]["tail"].get("reason") == "silent-tail-window", str(r))
        finally:
            aw.TAIL_SEARCH_SECONDS = saved
        print("falls back to the capped download, with the reason:")
        for name, needle in (("mp3_vbr_noxing", "VBR MP3"), ("wav_adpcm", "not PCM"),
                             ("junk", "no FLAC, WAV, AIFF or DSF header and no MP3 frames")):
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
