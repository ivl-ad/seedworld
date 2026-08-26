/* icons07-sync.mjs — ensure every icon referenced by icons07-map.csv exists in i07/ and c07/,
   copying missing ones from the local-only master sets i07-full/ and c07-full/ (not pushed to git).
   Rerun after adding rows to the map; already-present files are left alone.
   usage: node icons07-sync.mjs [--prune] [--map path]
     --prune   also delete i07/c07 files the map no longer references */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), PRUNE = args.includes('--prune');
const mi = args.indexOf('--map');
const MAP = path.resolve(HERE, mi >= 0 ? args[mi + 1] : 'icons07-map.csv');

/* icon is the last field and never quoted; only the name field can carry commas/quotes */
const want = { i07: new Set(), c07: new Set() };
let rows = 0, bad = 0;
for (const ln of fs.readFileSync(MAP, 'utf8').trim().split(/\r?\n/).slice(1)) {
  rows++;
  const icon = ln.slice(ln.lastIndexOf(',') + 1).trim();
  if (!icon) continue;
  const m = /^(i07|c07)\/([\w.$-]+\.png)$/.exec(icon);
  if (m) want[m[1]].add(m[2]); else { console.warn('malformed icon path: ' + ln); bad++; }
}

let copied = 0, present = 0, pruned = 0;
const missing = [], strays = [];
for (const dir of ['i07', 'c07']) {
  fs.mkdirSync(path.join(HERE, dir), { recursive: true });
  for (const f of want[dir]) {
    const dst = path.join(HERE, dir, f);
    if (fs.existsSync(dst)) { present++; continue; }
    const src = path.join(HERE, dir + '-full', f);
    if (!fs.existsSync(src)) { missing.push(dir + '/' + f); continue; }
    fs.copyFileSync(src, dst); copied++;
  }
  for (const f of fs.readdirSync(path.join(HERE, dir)))                  // files the map no longer references
    if (f.endsWith('.png') && !want[dir].has(f)) {
      if (PRUNE) { fs.unlinkSync(path.join(HERE, dir, f)); pruned++; } else strays.push(dir + '/' + f);
    }
}
if (missing.length) console.warn('MISSING FROM FULL SETS:\n  ' + missing.join('\n  '));
if (strays.length) console.log(strays.length + ' unreferenced file(s) in i07/c07 (rerun with --prune to remove): ' + strays.slice(0, 8).join(', ') + (strays.length > 8 ? ', ...' : ''));
console.log(rows + ' map rows -> ' + (want.i07.size + want.c07.size) + ' distinct icons (' + want.i07.size + ' i07, ' + want.c07.size + ' c07): '
  + copied + ' copied, ' + present + ' already present' + (pruned ? ', ' + pruned + ' pruned' : '') + (bad ? ', ' + bad + ' malformed' : ''));
if (missing.length || bad) process.exitCode = 1;
