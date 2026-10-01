// Diagnose the Dash Listeners "Country" column's GeoIP link. Read-only; runs
// inside the controller container, which ships this file:
//
//   docker exec <controller> node scripts/geoip-check.mjs <ip> [<ip>...]
//
// Prints which GeoIP path the controller will use (env vs settings), whether it
// can open the file, and what the database answers for each IP you pass
// (copy the IPs that show "—" from the Dash page).

import { createRequire } from 'node:module';
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const stateDir = process.env.STATE_DIR || '/var/sub-wave';
const ips = process.argv.slice(2);

// 1. Which path wins: GEOIP_DB_PATH env, then settings.stream.geoipDbPath.
const envPath = (process.env.GEOIP_DB_PATH || '').trim();
console.log(`GEOIP_DB_PATH env      : ${envPath || '(unset)'}`);

const settingsFiles = [join(stateDir, 'settings.json')];
const stationsDir = join(stateDir, 'stations');
if (existsSync(stationsDir)) {
  for (const d of readdirSync(stationsDir)) settingsFiles.push(join(stationsDir, d, 'settings.json'));
}
let settingPath = '';
for (const f of settingsFiles) {
  if (!existsSync(f)) continue;
  try {
    const v = String(JSON.parse(readFileSync(f, 'utf8'))?.stream?.geoipDbPath || '').trim();
    console.log(`setting in ${f}: ${v || '(empty)'}`);
    if (v && !settingPath) settingPath = v;
  } catch (e) {
    console.log(`setting in ${f}: unreadable (${e.message})`);
  }
}
const path = envPath || settingPath;
if (!path) {
  console.log('\n=> No GeoIP path configured: the database link never runs. Set Admin → Settings → Danger zone → Listener country → GeoIP database.');
  process.exit(0);
}
console.log(`\npath the controller uses: ${path}`);

// 2. Can this process open it? (Same user as the controller.)
let reader;
try {
  const st = statSync(path);
  console.log(`file: ${st.size} bytes, mode ${(st.mode & 0o777).toString(8)}, uid ${st.uid}, mtime ${st.mtime.toISOString()}`);
  const { Reader } = require('mmdb-lib');
  reader = new Reader(readFileSync(path));
  console.log(`opened OK: ${reader.metadata?.databaseType}, built ${reader.metadata?.buildEpoch?.toISOString?.() ?? '?'}`);
} catch (e) {
  console.log(`=> CANNOT OPEN: ${e.message}`);
  process.exit(1);
}

// 3. Lookups, normalising ::ffff:1.2.3.4 like the controller does.
if (!ips.length) console.log('\n(no IPs passed — add the ones showing "—" on the Dash page)');
for (const raw of ips) {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  const ip = m ? m[1] : raw;
  try {
    const r = reader.get(ip);
    const code = r?.country?.iso_code || r?.registered_country?.iso_code;
    console.log(`${raw.padEnd(40)} → ${code || 'NO ENTRY in database'}`);
  } catch (e) {
    console.log(`${raw.padEnd(40)} → lookup error: ${e.message}`);
  }
}
