/* icons07-tint.mjs — sample worn-model tints (c/c2) from every item icon in icons07-map.csv and splice the
   TINT07 map into icons07.js between the TINT07-GEN sentinels. Replaces icons07-tint.ps1. Rerun after
   changing the map, the sprites, or icons07-glyphs.csv. `--json <path>` also writes an audit report.

   Region-aware: each glyph samples the icon band that feeds that part of the 3D model (a staff's c is its
   ORB, from the top of the icon — never the shaft), so the worn model matches what the icon reads as.
   Colors come from the densest quantized cluster (mode, not mean): no hue buckets, no brightness cuts, so
   white orbs stay white and black hats stay black. OVR pins hand colors (OSRS reference) over the sampler.

   icons07-glyphs.csv (id,g,slot) is dumped from the running game's registry — dev console:
   copy('id,g,slot\n'+Object.entries(ITEMS).map(([i,t])=>[i,t.g||'',t.slot||''].join(',')).join('\n')) */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---- tiny PNG reader: 8-bit palette / grey / rgb / rgba, no interlace ---- */
function readPng(file) {
  const b = fs.readFileSync(file);
  let o = 8, w = 0, h = 0, depth = 0, ct = 0, plte = null, trns = null;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), at = o + 8;
    if (type === 'IHDR') { w = b.readUInt32BE(at); h = b.readUInt32BE(at + 4); depth = b[at + 8]; ct = b[at + 9]; if (b[at + 12]) throw new Error('interlaced: ' + file); }
    else if (type === 'PLTE') plte = b.subarray(at, at + len);
    else if (type === 'tRNS') trns = b.subarray(at, at + len);
    else if (type === 'IDAT') idat.push(b.subarray(at, at + len));
    else if (type === 'IEND') break;
    o = at + len + 4;
  }
  if (depth !== 8) throw new Error('bit depth ' + depth + ': ' + file);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct], raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, px = Buffer.alloc(h * stride);
  for (let y = 0, p = 0; y < h; y++) {                       // undo per-row filters
    const f = raw[p++], row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[p++], a = x >= ch ? px[row + x - ch] : 0, up = y ? px[prev + x] : 0, ul = y && x >= ch ? px[prev + x - ch] : 0;
      let v = cur;
      if (f === 1) v = cur + a; else if (f === 2) v = cur + up; else if (f === 3) v = cur + ((a + up) >> 1);
      else if (f === 4) { const pa = Math.abs(up - ul), pb = Math.abs(a - ul), pc = Math.abs(a + up - 2 * ul); v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? up : ul); }
      px[row + x] = v;
    }
  }
  const out = [];                                            // -> [r,g,b,yRow] for pixels with alpha >= 200
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * stride + x * ch;
    let r, g, bl, al = 255;
    if (ct === 3) { const k = px[i]; r = plte[k * 3]; g = plte[k * 3 + 1]; bl = plte[k * 3 + 2]; al = trns && k < trns.length ? trns[k] : 255; }
    else if (ct === 2 || ct === 6) { r = px[i]; g = px[i + 1]; bl = px[i + 2]; al = ct === 6 ? px[i + 3] : 255; }
    else { r = g = bl = px[i]; al = ct === 4 ? px[i + 1] : 255; }
    if (al >= 200) out.push([r, g, bl, y]);
  }
  return out;
}

/* ---- hue-family color picking: gradient shades of one hue merge into a family, so a robe's blue
   outvotes its pale trim and a dragon's dark red keeps its hue; the pure-black outline sits apart ---- */
const lum = p => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
const chroma = p => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mean = px => { const s = [0, 0, 0]; for (const p of px) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; } return s.map(v => Math.round(v / px.length)); };
const darken = (c, k = 0.55) => c.map(v => Math.max(8, Math.round(v * k)));
const isBlack = p => lum(p) < 18 && chroma(p) < 26;
const cellKey = p => (p[0] >> 5) << 6 | (p[1] >> 5) << 3 | (p[2] >> 5);
function families(px) {
  const m = new Map();
  for (const p of px) {                                      // 32-step quantized cells first
    const k = cellKey(p);
    const c = m.get(k) || [0, 0, 0, 0];
    c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; c[3]++; m.set(k, c);
  }
  const fam = new Map();
  let blackN = 0;
  for (const [ck, c] of m) {                                 // cells -> hue-bucket / grey families
    const cm = [c[0] / c[3], c[1] / c[3], c[2] / c[3]], ch = chroma(cm);
    if (isBlack(cm)) { blackN += c[3]; continue; }
    let key = 'grey';
    if (ch >= 26) {
      const [r, g, b] = cm, mx = Math.max(r, g, b), h = mx === r ? ((g - b) / ch + 6) % 6 : mx === g ? (b - r) / ch + 2 : (r - g) / ch + 4;
      key = Math.floor(h * 60 / 30);
    }
    const f = fam.get(key) || { s: [0, 0, 0], n: 0, keys: new Set(), grey: key === 'grey' };
    f.s[0] += c[0]; f.s[1] += c[1]; f.s[2] += c[2]; f.n += c[3]; f.keys.add(ck); fam.set(key, f);
  }
  let list = [...fam.values()].map(f => ({ mean: f.s.map(v => v / f.n), n: f.n, keys: f.keys, grey: f.grey })).sort((a, b) => b.n - a.n);
  const kept = [];                                           // a hue split across adjacent buckets merges; grey stays apart
  for (const f of list) {
    const t = !f.grey && kept.find(k => !k.grey && dist(k.mean, f.mean) < 55);
    if (t) { t.mean = t.mean.map((v, i) => (v * t.n + f.mean[i] * f.n) / (t.n + f.n)); t.n += f.n; for (const k of f.keys) t.keys.add(k); }
    else kept.push(f);
  }
  return { list: kept.sort((a, b) => b.n - a.n), blackN };
}
function refine(px, f) {                                     // lit-side mean over exactly the family's own pixels
  const mem = px.filter(p => f.keys.has(cellKey(p)));
  if (!mem.length) return f.mean.map(Math.round);
  const cut = mem.map(lum).sort((a, b) => a - b)[Math.floor(mem.length * 0.4)];
  return mean(mem.filter(p => lum(p) >= cut));
}
function blackMean(px) {                                     // a black item still shows its lit shading; a coloured plume does not tint it
  const dk = px.filter(p => lum(p) < 70 && chroma(p) < 40), cut = dk.map(lum).sort((a, b) => a - b)[Math.floor(dk.length * 0.6)] || 0;
  return mean(dk.filter(p => lum(p) >= cut)).map(v => Math.min(255, Math.round(v * 1.3 + 6)));
}
function pick(px, opt = {}) {                                // dominant family of a pixel set
  if (!px.length) return null;
  const { list, blackN } = families(px);
  if (!list.length || blackN > px.length * 0.55 || blackN > list[0].n * 2.5) return blackMean(px);
  let cand = list;
  if (opt.avoid) { const far = list.filter(f => dist(f.mean, opt.avoid) >= 60); if (far.length) cand = far; }
  let top = cand[0];
  if (opt.preferChroma !== false && chroma(top.mean) < 26) { // a dyed item's identity beats its pale trim
    const c = cand.find(f => chroma(f.mean) >= 32 && f.n >= top.n * 0.7);
    if (c) top = c;
  }
  return refine(px, top);
}
function second(px, avoid) {                                 // biggest family clearly distinct from `avoid`
  const { list } = families(px);
  const tot = list.reduce((s, f) => s + f.n, 0);
  for (const f of list) if (f.n >= Math.max(3, tot * 0.05) && dist(f.mean, avoid) >= 70) return refine(px, f);
  return null;
}
function saturated(px, fallback, min = 0.06) {               // gem / potion-liquid rule: largest chromatic family
  const { list } = families(px);
  const tot = list.reduce((s, f) => s + f.n, 0);
  const best = list.find(f => f.n >= Math.max(4, tot * min) && chroma(f.mean) >= 40);
  return best ? refine(px, best) : fallback;
}

/* ---- per-glyph sampling regions, in fractions of the opaque bbox height; c/d mirror the WEAPON part map.
   HEAD glyphs read the business end and dodge the shaft's colour so a small spearhead beats the pole ---- */
const HEAD = (b, shaft) => ({ c: [0, b], d: 'band2', shaft: shaft || [0.5, 1] });
const BLADE = { c: [0, 0.62], d: [0.62, 1] };                // blade above, guard/pommel in the hilt band
const SAT = { c: 'sat', d: 'whole2' };
const RULES = {
  staff: HEAD(0.42), mace: HEAD(0.45), wham: HEAD(0.45), axe: HEAD(0.5), baxe: HEAD(0.5), pick: HEAD(0.45),
  spear: HEAD(0.35), halberd: HEAD(0.45), cbow: HEAD(0.35), claws: HEAD(0.6),
  trident: { c: [0.5, 1], d: 'band2', shaft: [0, 0.5] },     // the sprite carries its prongs low
  sword: BLADE, dagger: BLADE, lsword: BLADE, sword2h: BLADE, scim: { c: [0, 0.6], d: [0.6, 1] },
  wand: { c: [0.35, 1], d: [0, 0.35] },                      // shaft is c; the orb at the tip is d
  bow: { c: 'outer', d: 'mid' },                             // limbs vs grip wrap
  arrow: { c: [0, 0.35], d: 'whole2' }, bolt: { c: [0, 0.35], d: 'whole2' },
  knife: { c: [0, 0.55], d: 'whole2' }, dart: { c: [0, 0.4], d: 'whole2' },
  amulet: SAT, vial: SAT
};
for (const v of ['vial1', 'vial2', 'vial3', 'vial4'])        // a low dose leaves little liquid: read the vial's bottom
  RULES[v] = { c: 'sat', band: [0.4, 1], min: 0.025, d: 'whole2' };
/* hand colors (OSRS reference) that win over the sampler: id -> 'cccccc.dddddd' */
const OVR = {
  flax: '5bc0c4.074e0a',                                     // the blue flower is the identity, not the green stem
  ancestral_robe_top: '535578.a89671'                        // navy like the skirt; its shadow greys outvote the blue
};

const hex = c => c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
function tint(px, rule) {
  const y0 = Math.min(...px.map(p => p[3])), y1 = Math.max(...px.map(p => p[3])), H = y1 - y0 + 1;
  const band = ([a, b]) => px.filter(p => p[3] >= y0 + H * a && p[3] < y0 + H * b);
  const r = rule || { c: 'whole', d: 'whole2' };
  let c = r.c === 'whole' ? pick(px)
    : r.c === 'sat' ? saturated(r.band ? band(r.band) : px, pick(px), r.min)
    : r.c === 'outer' ? pick(band([0, 0.35]).concat(band([0.65, 1])))
    : pick(band(r.c), r.shaft ? { avoid: pick(band(r.shaft), { preferChroma: false }) } : {});
  if (!c) c = pick(px);
  let d = null;
  if (r.d === 'band2') d = second(Array.isArray(r.c) ? band(r.c) : px, c);
  else if (r.d === 'whole2') d = second(px, c);
  else if (r.d === 'mid') d = second(band([0.35, 0.65]), c);
  else if (Array.isArray(r.d)) {
    d = second(band(r.d), c);                                // a distinct hilt (a godsword's gold) first
    if (!d) { d = pick(band(r.d), { preferChroma: false }); if (d && dist(d, c) < 45) d = null; }
  }
  return hex(c) + '.' + hex(d || darken(c));
}

const csv = f => fs.readFileSync(path.join(HERE, f), 'utf8').trim().split(/\r?\n/).slice(1);
const glyph = {};
for (const ln of csv('icons07-glyphs.csv')) { const [id, g] = ln.split(','); glyph[id] = g; }
const entries = [], report = [];
let missing = 0;
for (const ln of csv('icons07-map.csv')) {
  if (!ln.startsWith('item,')) continue;
  const icon = ln.slice(ln.lastIndexOf(',') + 1).trim(), id = ln.slice(5, ln.indexOf(',', 5));
  const f = path.join(HERE, icon);
  if (!icon || !fs.existsSync(f)) { missing++; continue; }
  const px = readPng(f);
  if (!px.length) { missing++; continue; }
  const t = OVR[id] || tint(px, RULES[glyph[id]]);
  entries.push(id + ":'" + t + "'");
  report.push({ id, g: glyph[id] || '', icon, t, ovr: !!OVR[id] });
}
const block = 'const TINT07 = { ' + entries.join(', ') + ' };';
new Function('"use strict";' + block)();                     // refuse to splice a block that does not parse
const jsPath = path.join(HERE, 'icons07.js');
const js = fs.readFileSync(jsPath, 'utf8');
const re = /(\/\* TINT07-GEN start \*\/\n)[\s\S]*?(\n\/\* TINT07-GEN end \*\/)/;
if (!re.test(js)) throw new Error('TINT07-GEN sentinels not found in icons07.js');
fs.writeFileSync(jsPath, js.replace(re, (_, a, b) => a + block + b));
const ja = process.argv.indexOf('--json');
if (ja > -1) fs.writeFileSync(process.argv[ja + 1], JSON.stringify(report, null, 1));
console.log(entries.length + ' tints spliced (' + (block.length / 1024).toFixed(1) + ' KB), ' + missing + ' skipped');
