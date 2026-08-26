/* icons07-genmap.mjs — regenerate index.html's 07-icon lookup maps from icons07-map.csv.
   Rerun after editing the map; rewrites only the block between the ICON07-GEN sentinels.
   ICON07: item id -> i07 name (or 'c07/name'); SK07/PR07/SP07 by k; US07 by display name; MK07 by MK_ART key. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(HERE, 'index.html');
const maps = { item: {}, skill: {}, prayer: {}, spell: {}, uspell: {}, marker: {} };
for (const ln of fs.readFileSync(path.join(HERE, 'icons07-map.csv'), 'utf8').trim().split(/\r?\n/).slice(1)) {
  const icon = ln.slice(ln.lastIndexOf(',') + 1).trim();
  if (!icon) continue;
  const kind = ln.slice(0, ln.indexOf(',')), rest = ln.slice(kind.length + 1);
  const id = rest.slice(0, rest.indexOf(',')), name = rest.slice(id.length + 1, rest.lastIndexOf(','));
  const m = /^(i07|c07)\/(.+)\.png$/.exec(icon);
  if (!m || !maps[kind]) { console.warn('skipped row: ' + ln); continue; }
  if (kind === 'item') maps.item[id] = m[1] === 'i07' ? m[2] : 'c07/' + m[2];
  else if (kind === 'uspell') maps.uspell[name.replace(/^"|"$/g, '').replace(/""/g, '"')] = m[2];
  else if (kind === 'marker') maps.marker[id.slice(2)] = m[2];
  else maps[kind][id] = m[2];
}
const key = k => /^[A-Za-z_$][\w$]*$/.test(k) || /^\d+$/.test(k) ? k : "'" + k.replace(/'/g, "\\'") + "'";
const lit = o => '{ ' + Object.entries(o).map(([k, v]) => key(k) + ": '" + v + "'").join(', ') + ' }';
const block = "const ICON07 = " + lit(maps.item) + ";\n"
  + "const SK07 = " + lit(maps.skill) + ", PR07 = " + lit(maps.prayer) + ", SP07 = " + lit(maps.spell) + ";\n"
  + "const US07 = " + lit(maps.uspell) + ", MK07 = " + lit(maps.marker) + ";";
new Function('"use strict";' + block)();                    // refuse to write a block that does not parse

const html = fs.readFileSync(HTML, 'utf8');
const re = /(\/\* ICON07-GEN start \*\/\n)[\s\S]*?(\n\/\* ICON07-GEN end \*\/)/;
if (!re.test(html)) throw new Error('ICON07-GEN sentinels not found in index.html');
const out = html.replace(re, '$1' + block + '$2');
fs.writeFileSync(HTML, out);
const n = k => Object.keys(maps[k]).length;
console.log('maps: ' + n('item') + ' items, ' + n('skill') + ' skills, ' + n('prayer') + ' prayers, ' + n('spell') + ' spells, '
  + n('uspell') + ' uspells, ' + n('marker') + ' markers; block ' + (block.length / 1024).toFixed(1) + ' KB; index.html ' + (out.length / 1024).toFixed(0) + ' KB');
