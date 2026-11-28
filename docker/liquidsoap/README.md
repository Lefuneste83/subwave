# Liquidsoap 2.5

Both the broadcast and AIO images run the stock upstream
`savonet/liquidsoap:v2.5.0-rc2` image, pinned by its multi-platform manifest
digest. The release candidate is a stage, not a destination: the 2.5.0 final
replaces it, pinned the same way, once the checks below pass on the final.
Keep the `liquidsoap` stage identical in both Dockerfiles; CI compares the two
executables.

`radio.liq` needs 2.5: switch settings live on each child source, `cross`
takes one duration, and shared state is updated in `atomic` sections. The
port keeps every 2.4 behaviour 2.5 changed by default; `liquidsoap/CLAUDE.md`
("Switching and concurrency") lists them. 2.4.x is sunset upstream.

What travels with the image:

- **Icecast-KH still comes through deb-multimedia.** The stock 2.4.6 and 2.5
  images ship no deb-multimedia source, so the runtime's `apt-get install
  icecast2` would install Debian's plain Icecast 2.4.4, which parses the
  `<x-forwarded-for>` trusted-proxy list but ignores it: behind the edge proxy
  every listener would be recorded with the proxy's container address and
  countries would disappear. Both Dockerfiles add the DMO source explicitly
  (keyring hash-checked) and pin it to `icecast2` alone, and the build fails if
  the installed Icecast is not KH. The keyring pin needs a manual bump when DMO
  rotates its keyring: their pool keeps only the current
  `deb-multimedia-keyring` package, so a source build fails at the `ADD` until
  the URL and both hashes are updated.
- **The codec stack is the 2.4.6 one.** The executable bundles a static FFmpeg 8
  and fdk-aac and loads Debian's libmp3lame0, libopus0, libflac and libvorbis at
  run time (measured in `/proc/<pid>/maps` while encoding, on 2.4.6 and 2.5
  alike; they are not `NEEDED` entries), so the image's apt state is still part
  of the MP3, Opus and FLAC encoders. DMO also ships libmp3lame0
  (`1:3.100-dmo3`), and the DMO pin above keeps it on Debian's build
  (`3.100-6`), as it does the AIO's CLI `ffmpeg`. Against 2.4.6 the base image
  drops libfaad2 and lilv (2.5 removed the faad decoder) and adds theora, speex,
  cairo and fontconfig. Opus stays hard CBR: 10 s of silence, noise and a tone
  encode to the same byte count on both versions.
- **More memory.** In the smoke test the broadcast container (Icecast and four
  encoders included) settles at ~190-210 MiB on 2.5 against ~100-115 MiB on
  2.4.6 (OCaml 5 runtime, more threads); CPU is within a few points.

Known differences on 2.5.0-rc2, all measured against 2.4.6:

- **`liq_cue_in` lands up to one codec packet earlier** (savonet/liquidsoap#5324
  decodes the pre-roll before a seek target): FLAC and ALAC 4,096 samples, AAC
  1,024-2,048, MP3 0 or 1,152, PCM WAV 1,570 samples or more; Vorbis and Opus are
  unchanged. `controller/src/music/cue-landing.ts` predicts the 2.4.6 landings,
  so `scripts/stem-seam-test.sh cuein` fails, and a stem-blend clip seam's
  clip → Y side airs 69-82 ms off (a flam). The controller's rules must learn the
  2.5 landings before this image ships.
- **A mixer start fades in.** The stdlib `smooth_add` runs its release on its
  first selection, so the programme rises from −23.6 dB (the two default duck
  depths) over 0.8 s after every mixer start; the ducks are then bit-identical.
- **A restart may open on a stinger.** Requests resolve in parallel, so with
  the mixer's own rotate the stinger can be ready before the first song.

Why not 2.4.5 or older (the history behind the old 2.4.6 minimum):

- **Unifier growth** ([savonet/liquidsoap#5257](https://github.com/savonet/liquidsoap/pull/5257),
  with #5336 and #5342). On 2.4.5 a long-running station spends an increasing
  share of CPU walking unifier reference chains, and a restart clears the chains
  without fixing their growth. Earlier SUB/WAVE images rebuilt 2.4.5 from source
  with #5257 backported; 2.4.6 shipped it.
- **Lost partial frame after `cross`** (#5296). On 2.4.5, `sequence` drops the
  first chunk of the incoming source when the source before it ends partway
  through a 20 ms frame. Every `dj_transition` ends in a `sequence`, so the
  track after a crossfade lost up to one frame, which put up to 20 ms of beat
  error on a stem-blend clip seam (#1933). `scripts/stem-seam-test.sh` sweeps
  the predecessor across a frame and measures 0.3 ms at every phase on 2.4.6,
  and 0.2 ms on the P → X seam on 2.5.0-rc2.

Moving to a new release: run `scripts/fx-render-test.sh` and
`scripts/stem-seam-test.sh` with `LIQ_IMAGE` set to it, check `radio.liq` with
`liquidsoap --check`, then follow the validation below.

## Validation

The [v1.18.0 validation report](../../docs/validation/liquidsoap-1.18.0/README.md)
records published-image identity checks, broadcast and AIO smoke results, and
the shortened endurance comparison. It also lists the checks still unverified.

From the repository root:

```sh
docker build -f docker/Dockerfile.broadcast -t subwave-test/broadcast:smoke .
docker build -f docker/Dockerfile.aio --target liquidsoap \
  -t subwave-test/aio-liquidsoap:smoke .
python3 scripts/liquidsoap-image-smoke.py subwave-test/broadcast:smoke
python3 scripts/liquidsoap-image-smoke.test.py -v
python3 scripts/liquidsoap-resume-fallback.py subwave-test/broadcast:smoke   # resume into another show airs the new fallback
```

The smoke test uses a unique container, an ephemeral loopback port, disposable
state and generated tones. It runs the baked `radio.liq`, checks repeated track
changes, both voice channels and a manual jingle, then decodes non-silent MP3,
Opus, AAC and FLAC captures. It retains logs and per-minute Docker CPU/memory
samples and removes its container on exit, including SIGTERM. Containers default
to 2 CPUs, 512 MiB, 128 processes and bounded Docker logs; `--cpus` and `--memory`
can override those resource limits. It needs Docker, Python 3 and ffmpeg.
It does not start a controller or connect to a music library.

Music gets a 30-second startup allowance. Thereafter the generated tracks must
produce at least three new starts in every 60-second interval, and the latest
`now-playing.json` timestamp must remain at most 30 seconds old. Re-reading an
unchanged marker never refreshes it. Future/backwards timestamps and markers
for anything other than the generated music are rejected. Missing/partially
written files may recover only while the last valid timestamp remains fresh.
Healthy emergency audio cannot satisfy these music-progress checks. The
deterministic CLI tests include the old false-pass case, normal progress and
delayed startup, without needing Docker or sleeping in real time.

The AIO target above validates its Liquidsoap stage, not the complete
AIO application. Full AIO builds remain part of release validation.

Before production rollout, run a 24–48-hour soak with frequent transitions:

```sh
python3 scripts/liquidsoap-image-smoke.py subwave-test/broadcast:smoke \
  --seconds 86400 --evidence-dir /real-disk/new-soak-directory \
  --test-source-sha "$(git rev-parse HEAD)" --image-source-sha BUILD_COMMIT
```

Use a durable supervisor such as a dedicated systemd service for a day-long
run, with stdout/stderr redirected to a persistent log. Do not hold a shared
build/test resource lock for the duration. Give that service a stop timeout and
an independent cleanup action for the unique container name in `status.json`,
so forced termination also removes only its disposable container.

`--evidence-dir` must be new or empty. `status.json` is atomically updated with
the immutable image ID, supplied image/test commit SHAs, runner SHA-256, UTC
start/deadline, resource limits, progress heartbeat, final result and cleanup
status. `stats.jsonl` retains per-minute CPU/memory samples plus track counts
and marker age; `intervals.jsonl` records successful music-progress intervals.
Both Docker and Liquidsoap's file diagnostics are retained and checked during
the run, so a warning cannot disappear unnoticed when Docker logs rotate.
Timestamped clock catch-up warnings inside the same 30-second startup allowance
are retained in `status.json` as `startup_latency_warnings`. Any later warning,
or one whose timestamp cannot be parsed, fails the run. The container uses UTC
for these comparisons. This allows the observed stock and patched cold-boot
catch-up without excusing latency during steady operation.

Review the retained CPU samples for growth and both logs for latency warnings.
Passing the short smoke test or structural regression does not establish
long-uptime production behaviour. Deploy the tested broadcast image during a
quiet period, retain the previous image for rollback and monitor CPU over the
following weeks.
