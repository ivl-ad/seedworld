/* mapgen.mjs — regenerate MAP.md: the fixed header below + one line per `/* ---- ` section banner in index.html.
   Rerun after adding, renaming or removing a section banner. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
const secs = [];
for (const line of html.split('\n')) {
  const m = /^\s*\/\* ---- (.*)$/.exec(line);
  if (!m) continue;
  let t = m[1].replace(/ ?-{2,}\s*\*?\/?\s*$/, '').trim();
  if (t.length > 118) t = t.slice(0, 118).replace(/\s+\S*$/, '') + '…';
  secs.push('- ' + t);
}
const head = [
  '# Seedworld map',
  '',
  'Navigation for index.html (~810KB, one `<script>`): CSS, a short HTML shell, then every game system in banner-marked',
  'sections. **Never read the file whole.** Grep a banner phrase from the list below (e.g. `rg "24. ACTIONS" index.html`),',
  'then read that range. Regenerate this file with `node mapgen.mjs`.',
  '',
  '## Rules of the road',
  '- All game code lives in index.html; src/worker.js is the Cloudflare Worker (D1 + Durable Objects). Deploy both together on any wire change.',
  '- icons07.js is GENERATED single-line data (sprite + tint maps, ~72KB): never hand-edit, read or grep it.',
  '  Regenerate with `node icons07-genmap.mjs` (after editing icons07-map.csv) / `node icons07-tint.mjs` (after sprite or glyph changes).',
  '  New-item icon workflow: csv row -> `node icons07-sync.mjs` -> `node icons07-genmap.mjs`; then `node icons07-tint.mjs` for worn tints.',
  '- .rgignore hides the generated/data files (icons07.js, the csvs, sound/, i07/, c07/) from ripgrep on purpose.',
  '- Data tables are positional where rows repeat: NPC_TYPES rows are `[k, n, lv, hp, atk, str, def, abon, sz, body, build, rest?]`',
  '  via NPC_ROW (fills db 0, spd 4); BOSSES and LADDERS carry their own column schemas — each table\'s comment block is the authority.',
  '- Bump SPAWN_REV on any spawn-side change; wiki numbers stay wiki-true; wire message ids are append-only.',
  '- Test: launch config `see-static` (:8933) -> Play offline -> Enter this world. `POST /shot?name=x` saves a screenshot to the scratchpad.',
  '',
  '## Sections, in file order (grep the phrase, not a line number)',
  ''
].join('\n');
fs.writeFileSync(path.join(HERE, 'MAP.md'), head + secs.join('\n') + '\n');
console.log('MAP.md: ' + secs.length + ' sections');
