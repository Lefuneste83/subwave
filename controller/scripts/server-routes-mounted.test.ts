// Every router module under src/routes/ is mounted by server.ts.
//
// A router that exists but is never `app.use`d answers nothing: its endpoints
// fall through to the catch-all 404 with no error anywhere, and the panel
// calling it just reads as empty. An upstream sync that resolved server.ts by
// taking upstream's side did exactly that to the fork's Stems page routes
// (`/stems/orphans`, the stem-cache routes). Pure source check: no server boots.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const server = readFileSync(join(src, 'server.ts'), 'utf8');

test('every top-level router module is imported and mounted', () => {
  const missing: string[] = [];
  for (const file of readdirSync(join(src, 'routes'))) {
    if (!file.endsWith('.ts')) continue;
    if (!/export const router\b/.test(readFileSync(join(src, 'routes', file), 'utf8'))) continue;
    const mod = file.replace(/\.ts$/, '');
    const imp = server.match(new RegExp(`import \\{ router as (\\w+) \\} from '\\./routes/${mod}\\.js';`));
    if (!imp) { missing.push(`${file}: not imported`); continue; }
    if (!new RegExp(`app\\.use\\(${imp[1]}\\)`).test(server)) missing.push(`${file}: imported as ${imp[1]} but never app.use'd`);
  }
  assert.deepEqual(missing, []);
});
