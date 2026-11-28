// Prints the controller's cue-landing prediction for one file and one or more
// cues as JSON (one object per line), so scripts/stem-seam-test.sh `cuein` can
// compare it with real Liquidsoap renders. `rawLateSec` is the packet rule with
// no codec offset (reported for every codec, validated or not); `lateSec` is
// what the queue drain would stamp (null for a codec without a rule), and
// `stampCueSec` the liq_cue_in it would write for that landing. The mixer's
// version comes from CUE_LANDING_MIXER ("Liquidsoap 2.5.0-rc2", "2.4.6"; 2.4
// when unset), so the harness renders the cue the drain would send that mixer.
//   tsx scripts/cue-landing-cli.ts <file> <cue-sec> [<cue-sec> ...]
import { CODEC_RULES, RAW_PACKET_RULE, cueLateSec, cueSeekFor, probeCueLanding, probeCuePackets } from '../src/music/cue-landing.js';

const seek = cueSeekFor(process.env.CUE_LANDING_MIXER || '2.4');

const [source, ...cues] = process.argv.slice(2);
if (!source || !cues.length || cues.some(c => !Number.isFinite(Number(c)))) {
  throw new Error('usage: cue-landing-cli.ts <file> <cue-sec> [<cue-sec> ...]');
}
for (const cue of cues) {
  const cueSec = Number(cue);
  const { probe, reason } = await probeCuePackets(source, cueSec, { timeoutMs: 10000 });
  const landing = await probeCueLanding(source, cueSec, { timeoutMs: 10000, seek });
  console.log(JSON.stringify({
    cue: cueSec,
    codec: probe?.codec ?? null,
    sampleRate: probe?.sampleRate ?? null,
    startTimeSec: probe?.startTimeSec ?? null,
    rawLateSec: probe ? cueLateSec(probe.packets, cueSec, RAW_PACKET_RULE) : null,
    validated: probe ? probe.codec in CODEC_RULES : false,
    // The rule's prediction even where it is out of the stampable range (negative = early).
    ruleLateSec: probe && CODEC_RULES[probe.codec] ? (() => {
      const rule = CODEC_RULES[probe.codec];
      const raw = cueLateSec(probe.packets, cueSec, { ...rule, subtractStartTime: false });
      return raw == null ? null : raw - (rule.subtractStartTime ? probe.startTimeSec ?? 0 : 0);
    })() : null,
    lateSec: landing.ok ? landing.lateSec : null,
    seek,
    stampCueSec: landing.ok ? landing.cueInSec : null,
    reason: landing.ok ? 'ok' : (probe ? landing.reason : reason),
  }));
}
