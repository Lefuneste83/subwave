// Regenerates src/audio/rbnf/cldr-spellout.json from Unicode CLDR's RBNF data
// (the `cldr-rbnf` npm package, Unicode licence: src/audio/rbnf/LICENSE).
//
//   npm pack cldr-rbnf@<version> && tar xzf cldr-rbnf-<version>.tgz
//   npx tsx scripts/gen-rbnf-spellout.ts package
//
// Keeps only what the speech pass reads: the two public rule sets
// %spellout-numbering-year and %spellout-numbering, the rule sets they reach,
// and in each only the rules for whole numbers (the negative, fraction,
// infinity and NaN rules are dropped: the pass spells non-negative integers).
// Every locale file in the package is complete on its own, so no inheritance
// is resolved here. Run scripts/rbnf-spellout.test.ts afterwards: its golden
// table is ICU's own output and catches a rule the interpreter misreads.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['%spellout-numbering-year', '%spellout-numbering'];
const OUT = new URL('../src/audio/rbnf/cldr-spellout.json', import.meta.url);

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('usage: tsx scripts/gen-rbnf-spellout.ts <cldr-rbnf package dir>');
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version as string;

function parseSets(text: string): Map<string, string[]> {
  const sets = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const head = /^(%%?[\w-]+):\s*$/.exec(line);
    if (head) {
      current = [];
      sets.set(head[1], current);
      continue;
    }
    if (!current) throw new Error(`rule before any rule set: ${line}`);
    current.push(line);
  }
  return sets;
}

const NUMERIC = /^[\d,. ]+(?:\/[\d,. ]+)?>*:/;
const REF = /[<>=](%%?[\w-]+)[<>=]/g;

const locales: Record<string, string> = {};
for (const file of readdirSync(join(pkgDir, 'rbnf')).sort()) {
  const m = /^(.+)-SpelloutRules\.txt$/.exec(file);
  // root spells nothing: its rules write digits.
  if (!m || m[1] === 'root') continue;
  const sets = parseSets(readFileSync(join(pkgDir, 'rbnf', file), 'utf8'));
  if (!ROOTS.every((r) => sets.has(r))) continue;
  const keep: string[] = [];
  const queue = [...ROOTS];
  while (queue.length) {
    const name = queue.shift()!;
    if (keep.includes(name)) continue;
    const rules = sets.get(name);
    if (!rules) throw new Error(`${file}: ${name} is referenced but not defined`);
    keep.push(name);
    for (const rule of rules.filter((r) => NUMERIC.test(r))) {
      for (const ref of rule.matchAll(REF)) queue.push(ref[1]);
    }
  }
  locales[m[1].replace(/_/g, '-')] = keep
    .map((name) => `${name}:\n${sets.get(name)!.filter((r) => NUMERIC.test(r)).join('\n')}`)
    .join('\n');
}

writeFileSync(OUT, `${JSON.stringify({ cldr: version, locales }, null, 1)}\n`);
console.log(`cldr-rbnf ${version}: ${Object.keys(locales).length} locales → ${OUT.pathname}`);
