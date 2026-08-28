/* diff two snap files: node snapdiff.js a.json b.json  → prints differing paths (max 60)
   tables.ITEMS is compared with per-item keys sorted (own-key order is unobservable in the game),
   EXCEPT req objects, whose key order is behavior (first failing requirement speaks). */
const fs = require('fs');
const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
const canonItem = (v, inReq) => {
  if (Array.isArray(v)) return v.map(x => canonItem(x, false));
  if (v && typeof v === 'object') {
    const keys = inReq ? Object.keys(v) : Object.keys(v).sort();
    const o = {};
    for (const k of keys) o[k] = canonItem(v[k], k === 'req' ? true : false);
    return o;
  }
  return v;
};
for (const s of [a, b]) {
  if (s.tables && s.tables.ITEMS) {
    const items = JSON.parse(s.tables.ITEMS);
    const entries = Object.keys(items).map(id => [id, canonItem(items[id], false)]);   // dict order preserved
    s.tables.ITEMS = JSON.stringify(entries);
  }
}
const diffs = [];
const walk = (x, y, p) => {
  if (diffs.length >= 60) return;
  if (typeof x !== typeof y) return diffs.push(p + ' TYPE ' + typeof x + '!=' + typeof y);
  if (x && typeof x === 'object') {
    const ks = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of ks) {
      if (!(k in x)) { diffs.push(p + '.' + k + ' ONLY-IN-B'); continue; }
      if (!(k in y)) { diffs.push(p + '.' + k + ' ONLY-IN-A'); continue; }
      walk(x[k], y[k], p + '.' + k);
    }
    return;
  }
  if (x !== y) {
    let d = p + ' DIFF';
    if (typeof x === 'string' && x.length > 40) {
      let i = 0; while (i < Math.min(x.length, y.length) && x[i] === y[i]) i++;
      d += ' @' + i + ' a="…' + String(x).slice(Math.max(0, i - 40), i + 60) + '…" b="…' + String(y).slice(Math.max(0, i - 40), i + 60) + '…"';
    } else d += ' a=' + JSON.stringify(x).slice(0, 80) + ' b=' + JSON.stringify(y).slice(0, 80);
    diffs.push(d);
  }
};
walk(a, b, '');
if (!diffs.length) console.log('IDENTICAL');
else { console.log(diffs.length + (diffs.length >= 60 ? '+ (capped)' : '') + ' diffs:'); diffs.forEach(d => console.log(' ' + d.slice(0, 400))); }
