/* seedworld golden-snapshot harness. Injected into the page; window.__SNAP.run(name) captures
   a canonical behavioral snapshot and POSTs it to /snap?name=. Deterministic: no wall-clock values stored. */
(() => {
  const S = window.__SNAP = { done: false, err: null, log: [] };
  const say = m => { S.log.push(m); };

  // ---- hashing: fnv1a-64 (as 2x32) over strings / typed arrays ----
  const fnv = (bytes, h0 = 0x811c9dc5, h1 = 0x01000193) => {
    let a = h0 >>> 0, b = 0xcbf29ce4 >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      a = Math.imul(a ^ bytes[i], 16777619) >>> 0;
      b = Math.imul(b ^ ((bytes[i] + i) & 255), 16777619) >>> 0;
    }
    return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'));
  };
  const hstr = s => { const e = new TextEncoder().encode(s); return fnv(e); };
  const hbuf = ta => fnv(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength));

  // ---- cycle-safe JSON with functions marked ----
  const jrep = () => { const seen = new WeakSet(); return function (k, v) {
    const orig = this && typeof this === 'object' ? this[k] : v;   // v is post-toJSON; this[k] is the real value
    if (typeof orig === 'function') return '[fn]';
    if (orig && typeof orig === 'object') {
      if (orig.isBufferGeometry) return '[geo:' + geoHash(orig) + ']';
      if (orig.isObject3D) return '[o3d]';
      if (ArrayBuffer.isView(orig)) return '[ta:' + hbuf(orig) + ']';
      if (seen.has(orig)) return '[cyc]';
      seen.add(orig);
    }
    return v;
  }; };
  const J = o => JSON.stringify(o, jrep());

  const geoHash = g => {
    const parts = [];
    for (const name of Object.keys(g.attributes).sort()) {
      const at = g.attributes[name];
      parts.push(name + ':' + at.itemSize + ':' + hbuf(at.array));
    }
    if (g.index) parts.push('idx:' + hbuf(g.index.array));
    return hstr(parts.join('|'));
  };

  // walk arbitrary value, collect every BufferGeometry hash (order-stable)
  const collectGeo = (v, out, seen) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (v.isBufferGeometry) { out.push(geoHash(v)); return; }
    if (v.isObject3D) { out.push('o3d[' + (v.children || []).length + ']'); if (v.geometry) out.push(geoHash(v.geometry)); (v.children || []).forEach(c => collectGeo(c, out, seen)); return; }
    if (Array.isArray(v)) { v.forEach(x => collectGeo(x, out, seen)); return; }
    for (const k of Object.keys(v)) collectGeo(v[k], out, seen);
  };

  const tag = x => {
    if (typeof x === 'number') return Math.round(x * 1e6) / 1e6;
    if (typeof x === 'string') return x;
    if (x == null) return x === undefined ? '[u]' : null;
    if (Array.isArray(x)) return x.map(tag);
    if (x.isBufferGeometry) return '[geo:' + geoHash(x) + ']';
    return '[obj]';
  };

  const g = n => { try { return (0, eval)(n); } catch (e) { return undefined; } };

  S.tables = () => {
    const out = {};
    const names = ['ITEMS', 'RECIPES', 'LOOT', 'NPC_TYPES', 'BOSSES', 'SPELLS', 'PRAYERS', 'LADDERS', 'WEAPON', 'SPEC',
      'EBOLT', 'ENCH', 'USPELLS', 'GUIDE', 'PLACES', 'TREES', 'ORES', 'BARS', 'FISH', 'HIDES', 'SHOP_KINDS', 'BAKES',
      'HF', 'ROOMS', 'CLUE_T', 'STAPLES', 'MK_ART', 'MARK_H', 'PICK_R', 'PICK_Y', 'OBJ_OPTS', 'TASKS', 'AGIL_N',
      'MAGIC_STATS', 'STYLES', 'RSTYLES', 'CSTYLES', 'REG', 'CROPS', 'POTS', 'DUN_THEMES', 'GATHER', 'MASTERS', 'STALLS', 'HUNT', 'BUILDS'];
    for (const n of names) { const v = g(n); if (v !== undefined) out[n] = J(v); }
    out.GLYPH_KEYS = JSON.stringify(Object.keys(g('GLYPH') || {}).sort());
    out.FSHAPE_KEYS = JSON.stringify(Object.keys(g('FSHAPE') || {}).sort());
    return out;
  };

  S.npcRigs = () => {
    const out = {};
    for (const t of g('NPC_TYPES') || []) {
      try { const geos = []; collectGeo(t.build(t.body), geos, new WeakSet()); out[t.k] = hstr(geos.join(',')); }
      catch (e) { out[t.k] = 'ERR:' + e.message; }
    }
    for (const b of g('BOSSES') || []) {
      try { if (b.build) { const geos = []; collectGeo(b.build(b.body || b.c || [0.5, 0.5, 0.5]), geos, new WeakSet()); out['boss:' + (b.k || b.id || b.n)] = hstr(geos.join(',')); } }
      catch (e) { out['boss:' + (b.k || b.id || b.n)] = 'ERR:' + e.message; }
    }
    return out;
  };

  S.fshape = () => {
    const out = {};
    const F = g('FSHAPE') || {};
    for (const k of Object.keys(F)) {
      const calls = [];
      const B = { add: (...a) => calls.push(a.map(tag)) };
      try { F[k](B, 1.25, 0.5, -2.75, 0, [0.82, 0.69, 0.45]); F[k](B, -3, 0.25, 4.5, 2, [0.31, 0.31, 0.34]); out[k] = hstr(JSON.stringify(calls)); }
      catch (e) { out[k] = 'ERR:' + e.message; }
    }
    return out;
  };

  S.icons = () => {
    const out = {};
    const ic = g('icon');
    const IT = g('ITEMS') || {};
    if (typeof ic !== 'function') return { err: 'no icon fn' };
    for (const id of Object.keys(IT)) {
      try { const r = ic(id); out[id] = hstr(typeof r === 'string' ? r : (r && r.src) || J(r)); }
      catch (e) { out[id] = 'ERR:' + e.message; }
    }
    return out;
  };

  S.shops = () => {
    const out = {};
    const sk = g('SHOP_KINDS'), fn = g('shopStock');
    if (!fn) return { err: 'no shopStock' };
    const kinds = Array.isArray(sk) ? sk.map(r => Array.isArray(r) ? r[0] : (r.k || r.id)) : Object.keys(sk || {});
    for (const k of kinds) for (let t = 0; t <= 3; t++) {
      try { out[k + ':' + t] = J(fn(k, t)); } catch (e) { out[k + ':' + t] = 'ERR:' + e.message; }
    }
    return out;
  };

  S.fields = () => {
    const H = g('heightAt'), SA = g('siteAt'), RA = g('regionAt');
    const spots = [[0, 0], [1024, 1024], [-2048, 512], [4096, -3072]];
    const hs = [];
    for (const [ox, oz] of spots) for (let dx = -60; dx <= 60; dx += 12) for (let dz = -60; dz <= 60; dz += 12)
      hs.push(Math.round(H(ox + dx, oz + dz) * 1e5) / 1e5);
    const sites = [];
    for (let x = -2048; x <= 2048; x += 128) for (let z = -2048; z <= 2048; z += 128) {
      try { const s = SA && SA(x, z); if (s) sites.push([x, z, s.k ?? s.kind ?? '?', s.t ?? '', Math.round((s.x ?? 0)), Math.round((s.z ?? 0))]); } catch (e) {}
    }
    const regs = [];
    for (let x = -4096; x <= 4096; x += 1024) for (let z = -4096; z <= 4096; z += 1024) {
      try { const r = RA && RA(x, z); regs.push(r ? (r.name || r.id || r.k || JSON.stringify(r).slice(0, 40)) : null); } catch (e) { regs.push('ERR'); }
    }
    return { h: hstr(hs.join(',')), sites: hstr(JSON.stringify(sites)), nSites: sites.length, regs: hstr(JSON.stringify(regs)) };
  };

  S.chunksHash = () => {
    const out = {};
    const C = g('chunks');
    if (!C || !C.forEach) return { err: 'no chunks' };
    const keys = [...C.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      const r = C.get(k);
      const parts = ['cx' + r.cx + 'cz' + r.cz + 's' + r.step];
      if (r.mesh && r.mesh.geometry) parts.push(geoHash(r.mesh.geometry));
      if (r.H) parts.push(ArrayBuffer.isView(r.H) ? hbuf(r.H) : hstr(JSON.stringify(r.H)));
      if (r.objs) parts.push(hstr(JSON.stringify(r.objs.map(o => [o.t, o.x, o.z, o.y, o.k, o.key, o.n].map(v => typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : (typeof v === 'string' ? v : null))))));
      if (r.roofs) parts.push('roofs' + r.roofs.length);
      out[k] = hstr(parts.join('|'));
    }
    return { n: keys.length, all: hstr(Object.entries(out).map(([k, v]) => k + '=' + v).join(';')), per: out };
  };

  S.poiRec = () => {
    const out = {};
    const SA = g('siteAt'), EP = g('emitPOI');
    if (!SA || !EP) return { err: 'missing siteAt/emitPOI' };
    const perKind = {};
    for (let x = -4096; x <= 4096; x += 96) for (let z = -4096; z <= 4096; z += 96) {
      try {
        const s = SA(x, z);
        if (!s) continue;
        const kk = 'k' + (s.k ?? '?');
        if ((perKind[kk] = (perKind[kk] || 0) + 1) > 3) continue;
        const calls = [];
        const B = { add: (...a) => calls.push(a.map(tag)) };
        const rec = { blk: [], objs: [], roofs: [] };
        const h = ((Math.imul(s.x | 0, 73856093) ^ Math.imul(s.z | 0, 19349663)) >>> 0);
        EP(B, s, rec, h);
        out[kk + ':' + s.x + ',' + s.z] = hstr(JSON.stringify([calls, rec.blk, rec.objs.map(o => [o.t, o.k, o.x, o.z, o.n, o.key])]));
      } catch (e) { out['ERRat' + x + ',' + z] = 'ERR:' + e.message; }
    }
    return out;
  };

  const sleepFrames = n => new Promise(res => {
    let i = 0;
    const F = g('frame');
    const t0 = performance.now();
    const iv = setInterval(() => {
      i += 10;
      try { for (let j = 0; j < 10; j++) F(t0 + (i - 10 + j) * 16.7); } catch (e) { clearInterval(iv); S.err = 'frame:' + e.message; res(); }
      if (i >= n) { clearInterval(iv); res(); }
    }, 5);
  });

  const travel = async (x, z) => {
    document.getElementById('wx').value = x;
    document.getElementById('wz').value = z;
    document.getElementById('go').click();
    await sleepFrames(900);
  };

  S.run = async name => {
    try {
      const snap = { name };
      say('tables'); snap.tables = S.tables();
      say('npcRigs'); snap.npcRigs = S.npcRigs();
      say('fshape'); snap.fshape = S.fshape();
      say('icons'); snap.icons = S.icons();
      say('shops'); snap.shops = S.shops();
      say('fields'); snap.fields = S.fields();
      say('poiRec'); snap.poiRec = S.poiRec();
      say('settle'); await sleepFrames(600);
      snap.loc = {};
      snap.loc.spawn = S.chunksHash();
      for (const [nm, x, z] of [['townE', 1024, 1024], ['far', -2048, 512], ['deep', 4096, -3072]]) {
        say('travel ' + nm); await travel(x, z);
        snap.loc[nm] = S.chunksHash();
      }
      say('post');
      const body = JSON.stringify(snap);
      const r = await fetch('/snap?name=' + name, { method: 'POST', body });
      S.done = true; S.result = await r.text(); say('done ' + body.length);
    } catch (e) { S.err = e.message + '\n' + (e.stack || '').slice(0, 300); S.done = true; }
  };
})();
