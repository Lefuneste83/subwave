// A DJ never introduces another station presenter as himself on air.
//
// Noticed on air (Greek-speaking personas): the operator moved the live show
// "Friday Drive" from Manolo X to Esteban Tikanis mid-show. From then on every
// station ident by Esteban said "Southern Star Plakias Radio με τον Τομ Άβρο"
// ("with Tom Avro", a third persona, the previous show's host), seven times,
// on two models. The ident prompt's "You said these things on-air recently"
// block still carried Manolo X's greeting naming Tom Avro, and each wrong ident
// fed the next prompt as Esteban's own words. Two fixes, pinned here:
//
// (a) a mid-show host change is a prompt-memory boundary: the previous host's
//     lines leave every prompt (prompt-memory.ts heldByHostChange), and stay on
//     disk and in the booth;
// (b) a line naming a station persona who is not on the air, in any script,
//     never airs (util/host-name-policy.ts): the free-text writer regenerates
//     once (llm djText `speaker`), the speech gate drops what still names one
//     (queue.speakable, push, the pick link trim). Operator text is exempt.
//
// The only mocked component for the writer is the OpenAI-compatible HTTP
// boundary. Run: npm test -- host-name-guard

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chatCompletionResponse } from './test-utils/llm.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { weekFor } from './test-utils/fixtures.js';

const root = createTempDir(join(tmpdir(), 'subwave-host-name-guard-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { hostNameVerdict, wrongHostNames, nameKey } = await import('../src/util/host-name-policy.js');
const { promptMemoryEntries } = await import('../src/broadcast/prompt-memory.js');
const { trimLinkToIntro } = await import('../src/broadcast/dj-agent/enqueue.js');
const { generateStationId } = await import('../src/llm/internal/prompts/scripts.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');

const template = settings.get().personas[0];
const TOM = { ...template, id: 'p_tom', name: 'Tom Avro', language: 'Greek' };
const MANOLO = { ...template, id: 'p_default0', name: 'Manolo X', language: 'Greek' };
const ESTEBAN = { ...template, id: 'p_2484d1', name: 'Esteban Tikanis', language: 'Greek' };
const NOVA = { ...template, id: 'p_nova', name: 'Nova', language: 'English' };
const PROFESSOR = { ...template, id: 'p_prof', name: 'The Dead Professor', language: 'English' };
const COMPUTER = { ...template, id: 'p_mk', name: 'Main Computer MK-69', language: 'English' };
const UBER = { ...template, id: 'p_uber', name: 'Übermensch', language: 'German' };
const PERSONAS = [TOM, MANOLO, ESTEBAN, NOVA, PROFESSOR, COMPUTER, UBER];
const SHOW = 's_drive';
const AIRED = 'Southern Star Plakias Radio με τον Τομ Άβρο.';

const policy = (text: string, speaker: { id: string; name: string }, extra: Record<string, unknown> = {}) =>
  hostNameVerdict(text, { personas: PERSONAS, speaker, onAir: [speaker.id], kind: 'station-id', ...extra });

// ── (b) the policy ───────────────────────────────────────────────────────────

test('the ident that aired is rejected: Esteban "with Tom Avro", in Greek', () => {
  const v = policy(AIRED, ESTEBAN);
  assert.equal(v.action, 'drop');
  assert.deepEqual((v as any).named.map((n: any) => [n.personaId, n.said]), [['p_tom', 'Τομ Άβρο']]);
  assert.equal(policy(AIRED, ESTEBAN, { retry: true }).action, 'regenerate', 'a writer gets its one retry');
  // Inflected and other scripts are the same name.
  assert.equal(policy('Απόψε η εκπομπή του Τομ Άβρου συνεχίζεται.', ESTEBAN).action, 'drop');
  assert.equal(policy('Это Southern Star, с вами Том Авро.', ESTEBAN).action, 'drop');
  assert.equal(policy('Southern Star Plakias Radio with Tom Avro.', ESTEBAN).action, 'drop');
  assert.equal(policy('Καλησπέρα από τον Τικάνη, στον Πλακιά.', MANOLO).action, 'drop', 'an inflected surname');
  assert.equal(policy('Με τον Εστεμπάν Τικάνη απόψε.', MANOLO).action, 'drop', 'an inflected whole name');
  assert.equal(policy('Εδώ ο Ούμπερμενς, η νύχτα μας ανήκει.', NOVA).action, 'drop', 'Greek digraphs (ου, μπ)');
  assert.equal(nameKey('Άβρο'), nameKey('Avro'));
  assert.equal(nameKey('Εστεμπάν'), nameKey('Esteban'));
});

test('the speaker naming himself, in Greek or in Latin, airs', () => {
  for (const line of [
    'Southern Star Plakias Radio με τον Εστεμπάν Τικάνη.',
    'Είμαι ο Εστεμπάν Τικάνις, και συνεχίζουμε.',
    'Southern Star Plakias Radio with Esteban Tikanis.',
    'Ο Τικάνις εδώ, στον Πλακιά.',
  ]) assert.equal(policy(line, ESTEBAN).action, 'keep', line);
  // By id, whatever the name the caller holds; and a surname he shares with
  // another persona is his own.
  assert.equal(hostNameVerdict('Εστεμπάν Τικάνις εδώ.', { personas: PERSONAS, speaker: { id: ESTEBAN.id, name: 'Esteban' } }).action, 'keep');
  const MARIA = { id: 'p_maria', name: 'Maria Tikanis' };
  assert.equal(hostNameVerdict('Ο Τικάνις εδώ, στον Πλακιά.', { personas: [...PERSONAS, MARIA], speaker: ESTEBAN, onAir: [ESTEBAN.id] }).action, 'keep');
});

test('an English persona introducing another persona as the voice is rejected', () => {
  assert.equal(policy('This is Nova Radio with Tom Avro, stay close.', NOVA).action, 'drop');
  assert.equal(policy("I'm Esteban Tikanis and this is the late shift.", NOVA).action, 'drop');
  assert.equal(policy('You are listening to The Dead Professor on the night shift.', NOVA).action, 'drop');
  assert.equal(policy('Main Computer MK-69 here, keeping you company.', NOVA).action, 'drop');
  assert.equal(policy('Hier ist Übermensch, die Nacht gehört uns.', NOVA).action, 'drop');
  assert.equal(policy('Avro here, with the late records.', NOVA).action, 'drop', 'a two-token name by its surname');
});

test('the show handoff, the roster and the exchange cast may name the other host', () => {
  for (const kind of ['handoff', 'generateSignoff', 'generateHandoffGreeting']) {
    assert.equal(policy('Ευχαριστώ, Τομ Άβρο, για την εκπομπή σου.', ESTEBAN, { kind }).action, 'keep', kind);
  }
  assert.equal(policy('Μαζί μου απόψε ο Τομ Άβρο.', ESTEBAN, { onAir: [ESTEBAN.id, TOM.id] }).action, 'keep', 'an on-air guest');
});

test('a name supplied for the line is that name: an artist "Avro" airs, "Tom Avro" still does not', () => {
  const names = ['Avro', 'Lancaster Nights'];
  assert.equal(policy('Και τώρα οι Avro με το Lancaster Nights.', ESTEBAN, { names }).action, 'keep');
  assert.equal(policy('Και τώρα οι Άβρο, ζεστά και αργά.', ESTEBAN, { names }).action, 'keep', 'transliterated too');
  assert.equal(policy(AIRED, ESTEBAN, { names }).action, 'drop', 'only the words a supplied name holds are exempt');
});

test('scripts the tables cannot transliterate fail open', () => {
  assert.equal(policy('南方之星电台，和汤姆·阿夫罗一起。', ESTEBAN).action, 'keep');
  assert.equal(policy('راديو النجم الجنوبي مع توم أفرو', ESTEBAN).action, 'keep');
  assert.equal(policy('サザンスターラジオ、トム・アブロと一緒に。', ESTEBAN).action, 'keep');
  assert.equal(nameKey('東京'), null);
});

test('no false positive on ordinary Greek and English lines', () => {
  const greek = [
    'Αύριο θα έχει ήλιο, η αύρα του Νότου φτάνει ως τον Πλακιά.',
    'Μετά τις οχτώ, ο Πλακιάς ζεσταίνεται σιγά-σιγά με ένα νυχτερινό ποτό στα χέρια.',
    'Στον Πλακιά, ο Νεκρός Καθηγητής του τζαζ βάζει το επόμενο κομμάτι.',
    'Τον Τόμο αυτόν τον διαβάσαμε όλοι, και τώρα μουσική.',
    'Το τρίτο μέρος της νύχτας, με ένα τραγούδι για τον Μάνο.',
    'Είμαστε εδώ, στην καρδιά της νύχτας, με το Southern Star Plakias Radio.',
  ];
  const english = [
    'The professor of jazz is back, and the computer hums along in the main room.',
    'Tomorrow brings sun, so stay with us for the late records.',
    'A dead calm night, main street empty, the stars out over the bay.',
    'Superman never sounded this good on a Friday drive.',
    'Atom heart mother, and a long avenue of strings.',
    'In the novel the dead professor leaves a tape on the main computer mk-69 shelf.',
    'Next, Professor Longhair on the piano.',
    'Computer love, the way Kraftwerk meant it.',
  ];
  greek.push('Ένα αβρό τραγούδι για το βράδυ.');
  for (const line of greek) assert.equal(policy(line, ESTEBAN).action, 'keep', line);
  for (const line of english) assert.equal(policy(line, NOVA).action, 'keep', line);
  assert.deepEqual(wrongHostNames('', { personas: PERSONAS, speaker: NOVA }), []);
});

// ── (b) the gate ─────────────────────────────────────────────────────────────

type Seams = { _speak: (text: string) => Promise<string>; _airVoice: () => Promise<boolean> };
const seams = queue as unknown as Seams;
const realSpeak = seams._speak;
const realAirVoice = seams._airVoice;
let spoken: string[] = [];
const wav = join(root, 'host.wav');
await writeSilentWav(wav, 100);
const dropLogged = () => queue.djLog.filter((e: any) => /naming another presenter/.test(e.message));

function show(personaId: string, guests: string[] = []) {
  return { id: SHOW, name: 'Friday Drive', topic: 'driving music', personaId, energies: ['medium'], guestPersonaIds: guests };
}

await settings.update({
  personas: PERSONAS, activePersonaId: MANOLO.id,
  shows: [show(ESTEBAN.id)],
  schedule: weekFor(SHOW), scheduleOverride: null,
  station: 'Southern Star Plakias Radio',
  tts: { enabled: true },
  llm: { provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'http://127.0.0.1:9/v1', pickerAgent: false, fallback: { enabled: false } },
} as never);

beforeEach(async () => {
  spoken = [];
  queue.djLog = [];
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  seams._speak = async (text: string) => { spoken.push(text); return wav; };
  seams._airVoice = async () => true;
});

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  seams._speak = realSpeak;
  seams._airVoice = realAirVoice;
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await removeTempDir(root);
});

test('announce drops the aired ident before TTS, reports it as a stand-in drop, and logs the words once', async () => {
  const out = await queue.announce(AIRED, 'station-id', { persona: ESTEBAN as never });
  assert.equal(out.accepted, false);
  assert.equal(out.reason, 'stand-in', 'callers stand down exactly as for a stand-in');
  assert.deepEqual(spoken, []);
  assert.equal(dropLogged().length, 1);
  assert.match(dropLogged()[0].message, /"Τομ Άβρο"/);
  await queue.announceAtNextTrack(AIRED, 'station-id', { persona: ESTEBAN as never });
  assert.deepEqual(spoken, [], 'the deferred path too');
});

test('a clean line airs byte-identical, and a track artist sharing a name airs with it', async () => {
  const own = 'Southern Star Plakias Radio με τον Εστεμπάν Τικάνη.';
  assert.equal((await queue.announce(own, 'station-id', { persona: ESTEBAN as never })).accepted, true);
  queue.current = { track: { id: 'a', title: 'Lancaster Nights', artist: 'Avro' } } as never;
  const artist = 'Ακούμε τους Άβρο, με το Lancaster Nights.';
  assert.equal((await queue.announce(artist, 'link', { persona: ESTEBAN as never })).accepted, true);
  assert.deepEqual(spoken, [own, artist]);
  assert.equal(dropLogged().length, 0);
});

test('operator text is never judged', async () => {
  const out = await queue.announce('Με τον Τομ Άβρο, απόψε στις δέκα.', 'dj-say', { persona: ESTEBAN as never, meta: { verbatim: true } as never });
  assert.equal(out.accepted, true);
  assert.equal(dropLogged().length, 0);
});

test('an exchange may name its own voices, and a rostered guest may be named', async () => {
  await queue.announceExchange([
    { persona: NOVA as never, text: 'Thanks, Tom Avro, great pick.' },
    { persona: TOM as never, text: 'Cheers, Nova, here is another.' },
  ], 'banter', { castNames: [NOVA.name, TOM.name] });
  assert.deepEqual(spoken, ['Thanks, Tom Avro, great pick.', 'Cheers, Nova, here is another.']);
  await settings.update({ shows: [show(ESTEBAN.id, [TOM.id])] } as never);
  try {
    assert.equal((await queue.announce('Μαζί μου απόψε ο Τομ Άβρο.', 'station-id', { persona: ESTEBAN as never })).accepted, true);
  } finally {
    await settings.update({ shows: [show(ESTEBAN.id)] } as never);
  }
  assert.equal(dropLogged().length, 0);
});

test('the session\'s host counts as on the air while it leads the grid (a look-ahead roll)', async () => {
  session.start(context());
  const live = session.getSession()!;
  const was = live.persona;
  live.persona = { id: TOM.id, name: TOM.name };
  try {
    assert.equal((await queue.announce('Στη συνέχεια ο Τομ Άβρο.', 'station-id', { persona: ESTEBAN as never })).accepted, true);
  } finally {
    live.persona = was;
  }
});

test('push() queues the track without the intro and says so; the pick link trim drops it too', async () => {
  let dropped = 0;
  await queue.push({
    track: { id: 'pushed', title: 'Θάλασσα', artist: 'Some Band' } as never,
    introScript: 'Το Θάλασσα από τους Some Band, εδώ με τον Τομ Άβρο.',
    introPersona: ESTEBAN as never,
    onStandInDropped: () => { dropped++; },
  });
  const item = queue.upcoming.find(i => i.track.id === 'pushed')!;
  assert.ok(item, 'the track is still queued: music never stops for this');
  assert.equal(item.introScript, null);
  assert.equal(dropped, 1);
  const song = { id: 'l', title: 'Porcelain', artist: 'Moby' };
  assert.equal(trimLinkToIntro('Το Porcelain του Moby, με τον Τομ Άβρο.', song, ESTEBAN as never, queue as never), null);
  assert.equal(trimLinkToIntro('Το Porcelain του Moby, ζεστό και αργό.', song, ESTEBAN as never, queue as never), 'Το Porcelain του Moby, ζεστό και αργό.');
});

// ── (b) the writer's one retry ───────────────────────────────────────────────

let replies: string[] = [];
let prompts: string[] = [];
// Only the writer's chat calls take a reply: the queue's own background
// requests (the pushed track's lookups) must not consume one.
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (!String(url instanceof Request ? url.url : url).includes('/chat/completions')) return new Response('', { status: 404 });
  prompts.push(String(init?.body ?? ''));
  const content = replies.shift() ?? 'Καλησπέρα.';
  return chatCompletionResponse({ id: 'fixture', message: { role: 'assistant', content } });
}) as typeof fetch;

test('an ident naming an off-air presenter is regenerated once, and the clean retry comes back', async () => {
  replies = [AIRED, 'Southern Star Plakias Radio, με τον Εστεμπάν.'];
  prompts = [];
  const line = await generateStationId({ persona: ESTEBAN, context: {} });
  assert.equal(line, 'Southern Star Plakias Radio, με τον Εστεμπάν.');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /PRESENTER: a draft of this line named/);
});

test('a retry that names one again is not retried, and the gate drops it unrecorded', async () => {
  replies = [AIRED, 'Southern Star Plakias Radio, ο Τομ Άβρο εδώ.'];
  prompts = [];
  const line = await generateStationId({ persona: ESTEBAN, context: {} });
  assert.equal(prompts.length, 2, 'at most one retry: the default model is a slow homelab server');
  const out = await queue.announce(line, 'station-id', { persona: ESTEBAN as never });
  assert.equal(out.accepted, false);
  assert.deepEqual(spoken, []);
});

test('a clean line costs one call and comes back unchanged', async () => {
  replies = ['This is the night shift, stay with us.'];
  prompts = [];
  assert.equal(await generateStationId({ persona: NOVA, context: {} }), 'This is the night shift, stay with us.');
  assert.equal(prompts.length, 1);
});

// ── (a) prompt memory after a mid-show host change ───────────────────────────

function context(at = new Date()) {
  return {
    at: at.toISOString(),
    time: { period: 'night', vibe: 'late', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm', date: {}, clock: {}, listeners: 1,
    activeShow: { id: SHOW, name: 'Friday Drive', topic: 'driving music', moods: ['calm'] },
  } as any;
}

const GREETING = 'Το σκυλάκι αυτό του Τομ Άβρο μας άφησε ωραία μουσική.';
const MANOLO_IDENT = 'Southern Star Plakias Radio με τον Μανόλο.';
const UNATTRIBUTED = 'Ένα τραγούδι για τη Θάλασσα, απόψε.';
const ESTEBAN_IDENT = 'Southern Star Plakias Radio με τον Εστεμπάν, βράδυ Παρασκευής.';

function recapAndWindow() {
  const recap = queue.getDjRecap({ limit: 20, withinMinutes: 60, maxChars: 400 }) || '';
  const window = session.windowMessages().map(m => m.content).join('\n');
  const openers = queue.getRecentOpeners(10).join('\n');
  return { recap, window, openers };
}

test('after a mid-show host change the previous host\'s lines leave every prompt, and stay in the session', async () => {
  await settings.update({ shows: [show(MANOLO.id)] } as never);
  session.start(context());
  // The agent window opens on the user's side; a pick ask is that turn.
  session.appendTurn({ role: 'event', kind: 'pick', text: 'Pick the next track.' });
  session.appendTurn({ role: 'segment', kind: 'link', text: GREETING, meta: { personaId: MANOLO.id, personaName: MANOLO.name } });
  session.appendTurn({ role: 'segment', kind: 'station-id', text: MANOLO_IDENT, meta: { personaId: MANOLO.id, personaName: MANOLO.name } });
  session.appendTurn({ role: 'segment', kind: 'link', text: UNATTRIBUTED });
  await settings.update({ shows: [show(ESTEBAN.id)] } as never);
  assert.equal(session.getSession()?.persona?.id, ESTEBAN.id, 'the session refreshed its host');
  session.appendTurn({ role: 'segment', kind: 'station-id', text: ESTEBAN_IDENT, meta: { personaId: ESTEBAN.id, personaName: ESTEBAN.name } });

  const { recap, window, openers } = recapAndWindow();
  assert.ok(recap.includes(ESTEBAN_IDENT.slice(0, 30)), 'the new host\'s own line stays');
  assert.ok(window.includes(ESTEBAN_IDENT));
  for (const text of [recap, window, openers]) {
    assert.ok(!text.includes('Άβρο'), 'the previous host\'s greeting is gone');
    assert.ok(!text.includes('Μανόλο'), 'every line he is credited with');
  }
  assert.ok(recap.includes('Θάλασσα'), 'an unattributed line stays: nothing says whose it was');
  const messages = session.getSession()!.messages.map(m => m.text);
  assert.ok(messages.includes(GREETING) && messages.includes(MANOLO_IDENT), 'the turns stay in the session (booth, GET /session)');
});

test('with no host change the session\'s memory is unchanged', async () => {
  await settings.update({ shows: [show(MANOLO.id)] } as never);
  session.start(context());
  // The agent window opens on the user's side; a pick ask is that turn.
  session.appendTurn({ role: 'event', kind: 'pick', text: 'Pick the next track.' });
  session.appendTurn({ role: 'segment', kind: 'link', text: GREETING, meta: { personaId: MANOLO.id, personaName: MANOLO.name } });
  session.appendTurn({ role: 'segment', kind: 'station-id', text: MANOLO_IDENT });
  const { recap, window } = recapAndWindow();
  assert.ok(recap.includes('Άβρο') && recap.includes('Μανόλο'));
  assert.ok(window.includes(GREETING) && window.includes(MANOLO_IDENT));
});

test('A -> B -> A keeps A\'s first lines and withholds B\'s; a legacy change turn counts too', () => {
  const t = (i: number) => new Date(Date.now() - (60 - i) * 1000).toISOString();
  const seg = (i: number, text: string, personaId?: string) => ({ t: t(i), role: 'segment', kind: 'link', text, meta: personaId ? { personaId } : {} });
  const change = (i: number, meta: Record<string, unknown> = { hostChange: true }) => ({ t: t(i), role: 'event', kind: 'scenario', text: meta.hostChange ? 'Host change.' : 'Host changed from A to B while the show continues.', meta });
  const turns = [seg(1, 'a first', 'p_a'), change(2), seg(3, 'b line', 'p_b'), change(4), seg(5, 'a again', 'p_a'), seg(6, 'guest after', 'p_g')];
  assert.deepEqual(promptMemoryEntries(turns, 'p_a').map(e => e.message), ['another host: guest after', 'a again', 'a first'],
    'a guest heard after the change keeps its attributed place');
  const legacy = [seg(1, 'b before', 'p_b'), seg(2, 'nobody credited'), change(3, {}), seg(4, 'a after', 'p_a')];
  assert.deepEqual(promptMemoryEntries(legacy, 'p_a').map(e => e.message), ['a after', 'nobody credited']);
  const none = [seg(1, 'b guest', 'p_b'), seg(2, 'a own', 'p_a')];
  assert.deepEqual(promptMemoryEntries(none, 'p_a').map(e => e.message), ['a own', 'another host: b guest']);
});
