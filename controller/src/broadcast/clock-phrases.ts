// The DJ's own aired lines are fed back into later prompts so the model avoids
// repeating itself, and small models copy the clock phrase in them ("just after
// ten") into lines that air an hour later. This module finds English clock
// phrases, strips them from prompt memory, and corrects a stated time that does
// not match the air time. English only: callers fail open for other languages.

export interface ClockPhrase {
  start: number;
  end: number;
  text: string;
  lo: number;
  hi: number;
}

export const CLOCK_TOLERANCE_MIN = 10;

export const CLOCK_CHECK_EXEMPT_KINDS: ReadonlySet<string> = new Set(['hourly-check', 'remember']);

// --- internals ---

const HW = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const HOUR = `(?:${HW}|1[0-2]|[1-9])`;
const OC = `(?:\\s+o[\\s']?clock)?`;
// What may follow the hour in "just after ten" / "approaching ten" for it to
// be a time at all: the end of a clause or a word that carries the sentence on
// ("on a Monday", "and", "here"). Without it, "back after two years" and
// "approaching ten thousand plays" read as clocks and would be "corrected",
// which is worse than missing one: a wrong edit changes a true line.
const TIME_FOLLOWER = `(?=\\s*(?:$|[,.;:!?|\u2014\u2013)]|\\s+-\\s|\\s*(?:on|in|at|and|here|there|now|this|tonight|already|sharp|so|but|with|as|or|where|when|while|which|that|we|you|i|it|it's|is|has|finds|feels|brings|sees|o[\\s']?clock|a\\.?m\\b|p\\.?m\\b)\\b))`;

function hourVal(w: string): number {
  const n = parseInt(w, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 12) return n;
  const m: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  return m[w.toLowerCase()] ?? NaN;
}

// Odd number of straight quotes (or more open-curly than close-curly) before
// the index means the match sits inside a title/quote and must be skipped.
function insideQuotes(text: string, index: number): boolean {
  let straight = 0;
  let open = 0;
  let close = 0;
  for (let i = 0; i < index; i++) {
    const c = text[i];
    if (c === '"') straight++;
    else if (c === '\u201c') open++;
    else if (c === '\u201d') close++;
  }
  return straight % 2 === 1 || open > close;
}

function normCirc(v: number): number {
  const r = v % 720;
  return r < 0 ? r + 720 : r;
}

function circDist(a: number, b: number): number {
  const d = Math.abs(normCirc(a) - normCirc(b));
  return Math.min(d, 720 - d);
}

function isInArc(t: number, lo: number, hi: number): boolean {
  const nlo = normCirc(lo);
  const nhi = normCirc(hi);
  const nt = normCirc(t);
  if (nlo <= nhi) return nt >= nlo && nt <= nhi;
  return nt >= nlo || nt <= nhi;
}

function tidy(s: string): string {
  s = s.replace(/ {2,}/g, ' ');
  s = s.replace(/ ([,.!?;])/g, '$1');
  s = s.replace(/,\s*,/g, ',');
  s = s.replace(/^,\s*/g, '');
  return s.trim();
}

interface Raw {
  start: number;
  end: number;
  text: string;
  lo: number;
  hi: number;
  pri: number;
}

// --- public API ---

export function isEnglishSpeech(language: unknown): boolean {
  if (language == null) return true;
  if (typeof language !== 'string') return false;
  const t = language.trim().toLowerCase();
  if (!t) return true;
  return t === 'en' || t.startsWith('en-') || t.startsWith('en_') || t.startsWith('english');
}

export function findClockPhrases(text: string): ClockPhrase[] {
  if (!text) return [];
  const raw: Raw[] = [];

  function add(re: RegExp, pri: number, win: (g: string[]) => [number, number] | null): void {
    const gre = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = gre.exec(text)) !== null) {
      if (m[0].length === 0) { gre.lastIndex++; continue; }
      const w = win(Array.from(m).slice(1));
      if (!w) continue;
      raw.push({ start: m.index, end: m.index + m[0].length, text: m[0], lo: w[0], hi: w[1], pri });
    }
  }

  // a. half past H / half-past H / half H -> [B+20, B+40]
  add(new RegExp(`\\bhalf(?:[-\\s]?past)?\\s+(${HOUR})\\b`, 'gi'), 0, (g) => {
    const H = hourVal(g[0]); if (!Number.isFinite(H)) return null;
    return [(H % 12) * 60 + 20, (H % 12) * 60 + 40];
  });

  // b. quarter past H -> [B+10, B+20]
  add(new RegExp(`\\bquarter\\s+past\\s+(${HOUR})\\b`, 'gi'), 1, (g) => {
    const H = hourVal(g[0]); if (!Number.isFinite(H)) return null;
    return [(H % 12) * 60 + 10, (H % 12) * 60 + 20];
  });

  // c. quarter to H -> [B-20, B-10]
  add(new RegExp(`\\bquarter\\s+to\\s+(${HOUR})\\b`, 'gi'), 2, (g) => {
    const H = hourVal(g[0]); if (!Number.isFinite(H)) return null;
    return [(H % 12) * 60 - 20, (H % 12) * 60 - 10];
  });

  // d. (just) gone|past|after H (o'clock) -> [B, B+25]
  add(new RegExp(`\\b(?:(?:just\\s+)?(?:gone|past|after)\\s+)(${HOUR})${OC}\\b${TIME_FOLLOWER}`, 'gi'), 3, (g) => {
    const H = hourVal(g[0]); if (!Number.isFinite(H)) return null;
    return [(H % 12) * 60, (H % 12) * 60 + 25];
  });

  // e. approaching|nearly|almost|coming up on|coming up to H (o'clock) -> [B-25, B]
  add(new RegExp(`\\b(?:(?:approaching|nearly|almost|coming\\s+up\\s+(?:on|to))\\s+)(${HOUR})${OC}\\b${TIME_FOLLOWER}`, 'gi'), 4, (g) => {
    const H = hourVal(g[0]); if (!Number.isFinite(H)) return null;
    return [(H % 12) * 60 - 25, (H % 12) * 60];
  });

  // f. H o'clock / H oclock -> [B-10, B+10]
  add(new RegExp(`\\b(${HOUR})\\s+o[\\s']?clock\\b`, 'gi'), 5, (g) => {
    const H = hourVal(g[0]); if (!Number.isFinite(H)) return null;
    return [(H % 12) * 60 - 10, (H % 12) * 60 + 10];
  });

  // h. qualified noon / midday / midnight
  add(new RegExp(`\\b(?:(?:approaching|nearly|almost)\\s+)(noon|midday|midnight)\\b`, 'gi'), 6, () => [-25, 0]);
  // "just" is required: a bare "after midnight" names a stretch of the night,
  // not a reading of the clock.
  add(new RegExp(`\\b(?:just\\s+(?:after|past|gone)\\s+)(noon|midday|midnight)\\b`, 'gi'), 6, () => [0, 25]);

  // i. H am/pm -> [B-10, B+59] only with deictic context
  add(new RegExp(`\\b(${HOUR})\\s*(?:a\\.?m\\.?|p\\.?m\\.?)\\b`, 'gi'), 7, (g) => {
    const H = hourVal(g[0]); if (!Number.isFinite(H)) return null;
    return [(H % 12) * 60 - 10, (H % 12) * 60 + 59];
  });

  // j. H:MM digits -> [B±5] only with "it's/at/around/now/clock" context
  add(new RegExp(`\\b(\\d{1,2}):(\\d{2})\\b`, 'g'), 8, (g) => {
    const H = parseInt(g[0], 10);
    const M = parseInt(g[1], 10);
    if (H < 0 || H > 23 || M < 0 || M > 59) return null;
    const B = (H % 12) * 60 + M;
    return [B - 5, B + 5];
  });

  // Overlaps are resolved BEFORE filtering: a rejected long match must take
  // its inner fragments with it ("since half past seven" must not leave
  // "past seven" behind). Earlier-listed pattern first, then earlier, longer.
  raw.sort((a, b) => a.pri - b.pri || a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const claimed: Raw[] = [];
  for (const r of raw) {
    if (!claimed.some((k) => r.start < k.end && k.start < r.end)) claimed.push(r);
  }

  // Then drop what is not a statement of the time now.
  const kept = claimed.filter((r) => {
    if (insideQuotes(text, r.start)) return false;
    // "since half past seven", "until nine o'clock": a time the line refers
    // BACK or ahead to, not a statement of the time now.
    if (/\b(?:since|from|until|till|before)\s+$/i.test(text.slice(Math.max(0, r.start - 12), r.start))) return false;
    if (r.pri === 7) {
      const ctx = text.slice(Math.max(0, r.start - 20), r.start).toLowerCase();
      if (!/(?:it's|it is|now|right now)/.test(ctx)) return false;
    }
    if (r.pri === 8) {
      const ctx = text.slice(0, r.start).replace(/\s+$/, '').toLowerCase();
      if (!/(?:it's|it is|at|around|now|clock)$/.test(ctx)) return false;
    }
    return true;
  });

  kept.sort((a, b) => a.start - b.start);
  return kept.map((r) => ({ start: r.start, end: r.end, text: r.text, lo: r.lo, hi: r.hi }));
}

export function stripClockPhrases(text: string): string {
  const phrases = findClockPhrases(text);
  if (phrases.length === 0) return text;

  let out = text;
  for (let i = phrases.length - 1; i >= 0; i--) {
    const p = phrases[i];
    let removeStart = p.start;
    const before = out.slice(0, p.start);
    // Remove one directly preceding preposition ("at", "around", "about", "by").
    const preM = before.match(/(at|around|about|by)\s*$/i);
    if (preM) {
      const preStart = p.start - preM[0].length;
      if (preStart === 0 || /\s/.test(out[preStart - 1])) {
        removeStart = preStart;
      }
    }
    out = out.slice(0, removeStart) + out.slice(p.end);
  }
  return tidy(out);
}

export function clockOffMinutes(phrase: ClockPhrase, hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const HH = parseInt(m[1], 10);
  const MM = parseInt(m[2], 10);
  if (HH < 0 || HH > 23 || MM < 0 || MM > 59) return null;
  const t = (HH % 12) * 60 + MM;
  if (isInArc(t, phrase.lo, phrase.hi)) return 0;
  return Math.min(circDist(t, phrase.lo), circDist(t, phrase.hi));
}

function sentenceStart(text: string, pos: number): number {
  let i = pos - 1;
  while (i >= 0) {
    if (/[.!?]/.test(text[i]) && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      return j;
    }
    i--;
  }
  return 0;
}

function sentenceEnd(text: string, pos: number): number {
  let i = pos;
  while (i < text.length) {
    if (/[.!?]/.test(text[i])) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      return j;
    }
    i++;
  }
  return text.length;
}

export function reconcileClockPhrases(text: string, opts: {
  airHhmm: string | null;
  supplied: string | null;
  toleranceMin?: number;
}): { text: string; changes: { from: string; to: string | null; offMin: number | null }[] } {
  const phrases = findClockPhrases(text);
  if (phrases.length === 0) return { text, changes: [] };

  const tolerance = opts.toleranceMin ?? CLOCK_TOLERANCE_MIN;
  let out = text;
  const changes: { from: string; to: string | null; offMin: number | null }[] = [];

  for (let i = phrases.length - 1; i >= 0; i--) {
    const p = phrases[i];
    const off = opts.airHhmm ? clockOffMinutes(p, opts.airHhmm) : null;
    if (off !== null && off < tolerance) continue;

    // Phrase may have been swallowed by a prior sentence removal.
    if (p.start >= out.length || out.slice(p.start, p.end) !== p.text) continue;

    if (opts.supplied && opts.supplied.trim()) {
      let repl = opts.supplied.trim();
      if (p.start === 0 || /[.!?]\s$/.test(out.slice(0, p.start))) {
        repl = repl.charAt(0).toUpperCase() + repl.slice(1);
      }
      out = out.slice(0, p.start) + repl + out.slice(p.end);
      changes.unshift({ from: p.text, to: repl, offMin: off });
    } else {
      const s0 = sentenceStart(out, p.start);
      const s1 = sentenceEnd(out, p.end);
      out = out.slice(0, s0) + out.slice(s1);
      changes.unshift({ from: p.text, to: null, offMin: off });
    }
  }

  return { text: tidy(out), changes };
}
