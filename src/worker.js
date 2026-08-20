/* ===========================================================================
   SEEDWORLD — multiplayer relay
   ---------------------------------------------------------------------------
   One Durable Object per world seed. It does not simulate anything: clients
   own their own movement, the room takes deltas, clamps the obvious nonsense,
   and fans them out to whoever is close enough to care.

   The 600 ms synchronisation does NOT happen here. Clients derive their tick
   number from wall clock (Date.now() + offset), and this Worker's only role in
   that is echoing timestamps for the offset estimate. That is deliberate — a
   server-side tick loop would keep the Durable Object awake permanently and
   an empty world would cost money.

   The seed is the world. One account, one character per seed: `players` holds
   who you are, `characters` holds who you are *there*.
   =========================================================================== */

import { DurableObject } from 'cloudflare:workers';

const VIEW = 48;      // interest radius in tiles; render radius is ~7 chunks
const RATE = 25;      // client messages per second before we start dropping
const MAXSAVE = 8192; // save blob ceiling, enforced here not client-side
/* Two limits, because a save is a different animal from a chat line. The
   transport cap has to clear MAXSAVE plus its wrapper or a save can never
   arrive at all; movement and chat stay on a tight leash. A single cap of 512
   silently ate every save from a character with more than a few items in the
   pack, which is every character that has actually been played. */
const MAXMSG = MAXSAVE + 2048;   // hard transport ceiling
const MAXSMALL = 512;            // everything that is not a save

const encoder = new TextEncoder();
const toHex = b => [...new Uint8Array(b)].map(v => v.toString(16).padStart(2, '0')).join('');
const sha256 = async s => toHex(await crypto.subtle.digest('SHA-256', encoder.encode(s)));
const cleanSeed = s => (String(s || '').trim().toLowerCase().slice(0, 32)) || 'lumbridge';

/* Bumped whenever the wire contract changes. The client reads it out of the
   socket hello, because a stale Worker deployment is otherwise independently
   invisible from the browser: assets update instantly and the Worker does not,
   so the game looks new while the server is months old and silently dropping
   everything it does not understand. */
const BUILD = 4;

/* The clients' shared clock, mirrored so world deadlines can be sanity-checked
   and expired entries pruned. Same epoch, same 600 ms tick. */
const W_EPOCH = 1735689600000;
const wTick = () => Math.floor((Date.now() - W_EPOCH) / 600);

/* The 2007 xp curve, server side, so /characters can summarise a blob without
   trusting the client to report its own combat level. */
const XP_TABLE = new Float64Array(100);
for (let L = 2, acc = 0; L <= 99; L++) {
  acc += Math.floor((L - 1) + 300 * Math.pow(2, (L - 1) / 7));
  XP_TABLE[L] = Math.floor(acc / 4);
}
function levelFor(xp) {
  let L = 1;
  while (L < 99 && xp >= XP_TABLE[L + 1]) L++;
  return L;
}
/* Indices match the client's SKILLS array: attack 0, strength 1, defence 2,
   hitpoints 8. Anything else here is a silent wrong number on the menu. */
function summarise(save) {
  const xp = Array.isArray(save && save.xp) ? save.xp : [];
  let total = 0;
  const lv = [];
  for (let i = 0; i < 28; i++) { const L = levelFor(+xp[i] || 0); lv[i] = L; total += L; }
  const combat = Math.floor(0.25 * (lv[2] + lv[8]) + 0.325 * (lv[0] + lv[1])) || 3;
  return { combat, totalLevel: total };
}

/* =========================== THE ROOM ==================================== */

export class World extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.players = new Map();   // pid -> record
    this.pending = new Map();   // dedupe key -> message
    this.timer = null;

    /* Shared world state: nodes depleted and monsters dead, each a key mapped
       to the shared tick it comes back on. In memory only, self-expiring, and
       bounded by what players near each other have touched lately — if the
       object hibernates and loses them, the cost is a node reappearing a
       little early, which nobody will ever prove. */
    this.depleted = new Map();
    this.monDead = new Map();

    // With the hibernation API this object can be evicted between messages and
    // rebuilt. Per-connection state therefore lives on the socket, not here.
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a) this.players.set(a.pid, { ws, ...a, seen: new Set(), n: 0, t0: 0 });
    }
  }

  async fetch(req) {
    const u = new URL(req.url);

    // cheap population probe for the world-select screen; no socket involved
    if (u.pathname === '/count') {
      return new Response(JSON.stringify({ n: this.players.size }),
        { headers: { 'content-type': 'application/json' } });
    }

    const pid = u.searchParams.get('pid');
    const name = u.searchParams.get('name') || 'Adventurer';
    if (!pid) return new Response('no pid', { status: 400 });

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);          // NOT server.accept() — that kills hibernation

    const seed = cleanSeed(u.searchParams.get('seed'));

    /* A reconnecting pid is a new socket wearing an old name. If the previous
       close was missed — an abrupt tab kill, or this object hibernating in
       between — the survivors still list this pid as seen and will therefore
       never be sent an enter for it again. Forget it everywhere so the next
       flush rediscovers them. */
    const old = this.players.get(pid);
    if (old && old.ws !== server) { try { old.ws.close(1000); } catch {} }
    for (const q of this.players.values()) q.seen.delete(pid);

    const rec = { pid, name, seed, x: 0, z: 0, face: 0, flags: 0, eq: [] };
    server.serializeAttachment(rec);
    this.players.set(pid, { ws: server, ...rec, seen: new Set(), n: 0, t0: 0 });

    // extra fields appended, so older clients reading only [1] and [2] still work
    server.send(JSON.stringify([[0, pid, Date.now(), name, seed, BUILD]]));

    /* A late arrival must see the stumps and absences everyone else does.
       Snapshots go only to the joiner; live traffic covers everyone else. */
    this.pruneWorld();
    const snap = [];
    for (const [k, d] of this.depleted) snap.push([20, k, d]);
    for (const [k, d] of this.monDead) snap.push([22, k, d]);
    for (let i = 0; i < snap.length; i += 100) {
      try { server.send(JSON.stringify(snap.slice(i, i + 100))); } catch {}
    }

    /* Interest management only runs inside flush(), and flush only runs when
       somebody queues traffic. Without this, a join is invisible to a room
       where nobody happens to be moving. */
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 40);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment();
    if (!att) return;
    const me = this.players.get(att.pid);
    if (!me || typeof raw !== 'string') return;
    if (raw.length > MAXMSG) {
      console.log('over transport cap', raw.length, me.pid);
      try { ws.send(JSON.stringify([[7, 'save too large (' + raw.length + ' bytes)']])); } catch {}
      return;
    }

    const now = Date.now();
    if (now - me.t0 > 1000) { me.t0 = now; me.n = 0; }
    if (++me.n > RATE) return;

    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(m)) return;
    // Size is judged after the type is known, and a rejection is never silent:
    // a save that vanishes without a word is indistinguishable from one that
    // was never sent, which is exactly how this went unnoticed.
    if (m[0] !== 8 && raw.length > MAXSMALL) {
      console.log('oversize', m[0], raw.length, me.pid);
      return;
    }

    switch (m[0]) {

      case 1: {                                  // move
        const [, tick, x, z, face, flags] = m;
        if (!Number.isInteger(x) || !Number.isInteger(z)) return;
        if (Math.abs(x) > 1e6 || Math.abs(z) > 1e6) return;
        me.x = x; me.z = z;
        me.face = (face | 0) & 15;
        me.flags = (flags | 0) & 3;
        this.queue('1:' + me.pid, [1, [[me.pid, tick | 0, x, z, me.face, me.flags]]]);
        break;
      }

      case 2:                                    // action animation
        this.queue('2:' + me.pid, [2, me.pid, (m[2] | 0) & 255]);
        break;

      case 3:                                    // equipment
        me.eq = Array.isArray(m[1])
          ? m[1].slice(0, 6).map(v => (v == null ? null : String(v).slice(0, 32)))
          : [];
        this.queue('3:' + me.pid, [3, me.pid, me.eq]);
        break;

      case 19: {                                  // an arrow was loosed, and where
        this.queue('19:' + me.pid + ':' + now,
          [19, me.pid, m[1] | 0, m[2] | 0, (m[3] | 0) & 0xffffff]);
        break;
      }

      case 20:                                    // a node was depleted
      case 22: {                                  // a monster was killed
        const key = String(m[1] || '').slice(0, 48);
        const due = m[2] | 0, gt = wTick();
        if (!key || due <= gt || due > gt + 20000) return;
        (m[0] === 20 ? this.depleted : this.monDead).set(key, due);
        this.pruneWorld();
        this.queue(m[0] + ':' + key, [m[0], key, due, me.pid]);
        break;
      }

      case 21: {                                  // a live monster, owner-driven
        const key = String(m[1] || '').slice(0, 48);
        if (!key) return;
        this.queue('21:' + key,
          [21, key, m[2] | 0, m[3] | 0, (m[4] | 0) & 15, m[5] | 0,
           String(m[6] || '').slice(0, 40), (m[7] | 0) & 255, me.pid]);
        break;
      }

      case 18: {                                  // a spell was cast, and at what
        this.queue('18:' + me.pid + ':' + now,
          [18, me.pid, (m[1] | 0) & 31, m[2] | 0, m[3] | 0]);
        break;
      }

      case 13: {                                  // hitpoints, so onlookers can draw a bar
        const hp = m[1] | 0, mx = m[2] | 0;
        this.queue('13:' + me.pid, [13, me.pid, hp, mx]);
        break;
      }

      /* Trading is two private conversations, not a broadcast: only the other
         party hears an offer, and only they can answer it. */
      case 14: {                                  // trade signal
        const other = this.players.get(String(m[1] || ''));
        if (other) {
          try { other.ws.send(JSON.stringify([[14, me.pid, me.name, (m[2] | 0) & 7]])); } catch {}
        }
        return;
      }

      case 15: {                                  // trade offer
        const other = this.players.get(String(m[1] || ''));
        const offer = Array.isArray(m[2]) ? m[2].slice(0, 28).map(it => [
          String((it && it[0]) || '').slice(0, 32), Math.max(0, (it && it[1] | 0) || 0)
        ]) : [];
        if (other) {
          try { other.ws.send(JSON.stringify([[15, me.pid, offer]])); } catch {}
        }
        return;
      }

      case 11: {                                 // pvp hit, delivered to one player
        const target = this.players.get(String(m[1] || ''));
        if (target) {
          try { target.ws.send(JSON.stringify([[11, me.pid, (m[2] | 0) & 255]])); } catch {}
        }
        return;
      }

      case 12: {                                  // died here, dropped this
        const items = Array.isArray(m[3]) ? m[3].slice(0, 40) : [];
        this.queue('12:' + me.pid + ':' + now, [12, me.pid, m[1] | 0, m[2] | 0, items]);
        break;
      }

      case 4: {                                  // chat
        const text = String(m[1] ?? '').slice(0, 120);
        if (text) this.queue('4:' + me.pid + ':' + now, [4, me.pid, text]);
        break;
      }

      case 8: {                                  // save blob
        // New shape is [8, seed, blob]. The old [8, blob] still arrives from
        // account-test.html, so a non-string second element means legacy and
        // the connection's own seed applies.
        const legacy = typeof m[1] !== 'string';
        const seed = legacy ? (me.seed || 'lumbridge') : cleanSeed(m[1]);
        const payload = legacy ? m[1] : m[2];
        let blob;
        try { blob = JSON.stringify(payload); } catch { return; }
        if (!blob || blob.length > MAXSAVE) {
          try { ws.send(JSON.stringify([[7, 'blob over ' + MAXSAVE + ' bytes']])); } catch {}
          return;
        }
        if (!this.env.DB) {
          try { ws.send(JSON.stringify([[7, 'no D1 binding on the durable object']])); } catch {}
          return;
        }
        try {
          await this.env.DB.prepare(
            'INSERT INTO characters (pid, seed, save, created, updated) VALUES (?,?,?,?,?) ' +
            'ON CONFLICT(pid, seed) DO UPDATE SET save=excluded.save, updated=excluded.updated'
          ).bind(me.pid, seed, blob, now, now).run();
          // Remember the last world played so login can preselect it — but only
          // when it actually changes. Writing it on every flush doubled the D1
          // cost of a save for a column that changes once a session.
          if (me.savedSeed !== seed) {
            me.savedSeed = seed;
            await this.env.DB.prepare('UPDATE players SET seed=?, updated=? WHERE pid=?')
              .bind(seed, now, me.pid).run();
          }
          // confirm the write, so a client can tell "saved" from "swallowed"
          try { ws.send(JSON.stringify([[10, seed, blob.length]])); } catch {}
        } catch (e) {
          // Silence here is how a missing table costs somebody their session.
          const msg = String(e);
          console.log('save failed', me.pid, msg);
          try {
            ws.send(JSON.stringify([[7, /no such table/i.test(msg)
              ? 'the characters table does not exist' : msg.slice(0, 120)]]));
          } catch {}
        }
        return;                                  // no attachment change
      }

      case 9:                                    // clock ping
        ws.send(JSON.stringify([[9, m[1], Date.now()]]));
        return;

      default:
        return;
    }

    ws.serializeAttachment({
      pid: me.pid, name: me.name, seed: me.seed, x: me.x, z: me.z,
      face: me.face, flags: me.flags, eq: me.eq
    });
  }

  /* One-shot timer only, never a repeating alarm. A repeating alarm keeps the
     object awake forever and blocks hibernation, which is where the bill is. */
  pruneWorld() {
    const gt = wTick();
    for (const [k, d] of this.depleted) if (d <= gt) this.depleted.delete(k);
    for (const [k, d] of this.monDead) if (d <= gt) this.monDead.delete(k);
    // a runaway client cannot grow these without bound: oldest entries fall off
    while (this.depleted.size > 800) this.depleted.delete(this.depleted.keys().next().value);
    while (this.monDead.size > 800) this.monDead.delete(this.monDead.keys().next().value);
  }

  queue(key, msg) {
    this.pending.set(key, msg);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 40);
  }

  flush() {
    this.timer = null;
    const msgs = [...this.pending.values()];
    this.pending.clear();

    for (const p of this.players.values()) {
      const out = [];

      /* Reap anyone this player still thinks is here but who is not in the
         room any more. A missed close, or this object hibernating and losing
         its seen sets, would otherwise leave a ghost that never departs and
         that the client can never be told about. */
      for (const pid of p.seen) {
        if (!this.players.has(pid)) { p.seen.delete(pid); out.push([5, pid]); }
      }

      // interest management: emit enter/leave as people cross the view radius
      for (const q of this.players.values()) {
        if (q.pid === p.pid) continue;
        const near = Math.abs(q.x - p.x) <= VIEW && Math.abs(q.z - p.z) <= VIEW;
        if (near && !p.seen.has(q.pid)) {
          p.seen.add(q.pid);
          out.push([6, q.pid, q.name, q.x, q.z, q.eq]);
        } else if (!near && p.seen.has(q.pid)) {
          p.seen.delete(q.pid);
          out.push([5, q.pid]);
        }
      }

      for (const m of msgs) {
        /* A death spills loot and teleports the corpse away in the same breath.
           Judging that message by whether the dead player is still visible
           loses it exactly when it matters, so ground items are delivered by
           where they fell rather than by who dropped them. */
        if (m[0] === 12) {
          const dx = m[2] | 0, dz = m[3] | 0;
          if (m[1] !== p.pid && Math.abs(dx - p.x) <= VIEW && Math.abs(dz - p.z) <= VIEW) out.push(m);
          continue;
        }
        /* World state is room-wide: a stump matters to whoever walks up next,
           seen-set or not. Live monster frames only matter near the fight. */
        if (m[0] === 20 || m[0] === 22) {
          if (m[3] !== p.pid) out.push(m);
          continue;
        }
        if (m[0] === 21) {
          if (m[8] !== p.pid &&
              Math.abs((m[2] | 0) - p.x) <= VIEW * 2 && Math.abs((m[3] | 0) - p.z) <= VIEW * 2) out.push(m);
          continue;
        }
        const owner = m[0] === 1 ? m[1][0][0] : m[1];
        if (owner !== p.pid && p.seen.has(owner)) out.push(m);
      }

      if (out.length) { try { p.ws.send(JSON.stringify(out)); } catch {} }
    }
  }

  webSocketClose(ws) { this.drop(ws); }
  webSocketError(ws) { this.drop(ws); }

  drop(ws) {
    const a = ws.deserializeAttachment();
    if (!a) return;
    this.players.delete(a.pid);
    for (const p of this.players.values()) {
      if (p.seen.delete(a.pid)) {
        try { p.ws.send(JSON.stringify([[5, a.pid]])); } catch {}
      }
    }
  }
}

/* ============================ THE WORKER ================================= */

function cors(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  };
}

const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...cors(origin) }
});

async function population(env, u, origin) {
  const seed = cleanSeed(u.searchParams.get('seed'));
  try {
    const stub = env.WORLD.get(env.WORLD.idFromName('world:' + seed));
    const r = await stub.fetch(new Request('https://do/count'));
    const j = await r.json();
    return json({ seed, n: j.n | 0, build: BUILD }, 200, origin);
  } catch {
    // an empty world has never been instantiated; that is not an error
    return json({ seed, n: 0, build: BUILD }, 200, origin);
  }
}
async function characters(env, u, origin) {
  const auth = u.searchParams.get('auth') || '';
  if (!/^[0-9a-f]{64}$/.test(auth)) return json({ e: 'bad auth' }, 400, origin);
  let row;
  try {
    row = await env.DB.prepare('SELECT pid, name, seed FROM players WHERE auth_hash=?')
      .bind(await sha256('v1|' + auth)).first();
  } catch { return json({ e: 'db error' }, 500, origin); }
  if (!row) return json({ e: 'unknown key' }, 401, origin);

  let rows;
  try {
    rows = await env.DB.prepare(
      'SELECT seed, save, updated FROM characters WHERE pid=? ORDER BY updated DESC LIMIT 40'
    ).bind(row.pid).all();
  } catch {
    // no table yet: an account with no characters, not a server fault
    return json({ pid: row.pid, name: row.name, last: row.seed, characters: [], build: BUILD }, 200, origin);
  }
  const list = (rows?.results || []).map(r => {
    let save = {};
    try { save = JSON.parse(r.save || '{}'); } catch {}
    const s = summarise(save);
    return { seed: r.seed, updated: r.updated, combat: s.combat, totalLevel: s.totalLevel };
  });
  return json({ pid: row.pid, name: row.name, last: row.seed, characters: list, build: BUILD }, 200, origin);
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

    /* Browsers omit Origin entirely on same-origin GET requests, and always send
       it for POST and for anything cross-origin. So an absent Origin means the
       request is same-origin (or not from a browser at all, where an Origin
       check was never a security boundary anyway — it can simply be forged).
       An Origin equal to our own is same-origin by definition. */
    const originOk =
      !origin ||                       // same-origin GET
      origin === u.origin ||           // same-origin, header present
      list.length === 0 ||             // allow-list disabled
      list.includes(origin);           // explicitly permitted cross-origin

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: cors(originOk ? origin : 'null') });
    }

    /* Resolve an auth token to an account row. Every authed route needs this
       and every one of them wants the same 401 on failure. */
    const whoami = async auth => {
      if (!/^[0-9a-f]{64}$/.test(auth || '')) return { e: 'bad auth', code: 400 };
      let row;
      try {
        row = await env.DB.prepare('SELECT pid, name, seed FROM players WHERE auth_hash=?')
          .bind(await sha256('v1|' + auth)).first();
      } catch (e) { console.log('db error', String(e)); return { e: 'db error', code: 500 }; }
      if (!row) return { e: 'unknown key', code: 401 };
      return { row };
    };

    /* ---------------- /ws : the only hot path ---------------- */
    if (u.pathname === '/ws') {
      // WebSocket upgrades skip CORS preflight entirely, so check this yourself
      if (!originOk) return new Response('forbidden origin', { status: 403 });
      // case-insensitive: some proxies send "WebSocket"
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }

      const auth = u.searchParams.get('auth') || '';
      const seed = cleanSeed(u.searchParams.get('seed'));
      if (!/^[0-9a-f]{64}$/.test(auth)) return new Response('bad auth', { status: 400 });

      const who = await whoami(auth);
      if (who.e) return new Response(who.e, { status: who.code });

      const target = new URL(req.url);
      target.searchParams.set('pid', who.row.pid);
      target.searchParams.set('name', who.row.name || 'Adventurer');
      target.searchParams.set('seed', seed);

      const stub = env.WORLD.get(env.WORLD.idFromName('world:' + seed));
      return stub.fetch(new Request(target, req));
    }

    /* ---------------- /register ---------------- */
    if (u.pathname === '/register' && req.method === 'POST') {
      if (!originOk) return json({ e: 'origin' }, 403, 'null');

      let b;
      try { b = await req.json(); } catch { return json({ e: 'bad json' }, 400, origin); }
      const { auth, pid, name } = b || {};

      if (!/^[0-9a-f]{64}$/.test(auth || '')) return json({ e: 'bad auth' }, 400, origin);
      if (!/^[0-9a-f]{12}$/.test(pid || '')) return json({ e: 'bad pid' }, 400, origin);
      if (!/^[A-Za-z0-9 ]{2,12}$/.test(name || '')) return json({ e: 'bad name' }, 400, origin);

      const ipHash = await sha256('ip|' + (req.headers.get('cf-connecting-ip') || ''));
      const hourAgo = Date.now() - 3600e3;

      const authHash = await sha256('v1|' + auth);

      try {
        // Is this key already an account? Then the answer is "log in", not "error".
        const mine = await env.DB.prepare('SELECT pid, name FROM players WHERE auth_hash=?')
          .bind(authHash).first();
        if (mine) return json({ e: 'key_registered', pid: mine.pid, name: mine.name }, 409, origin);

        // Name uniqueness is case-insensitive, so Vlad and vlad cannot coexist.
        const taken = await env.DB.prepare(
          'SELECT 1 AS x FROM players WHERE name = ? COLLATE NOCASE'
        ).bind(name).first();
        if (taken) return json({ e: 'name_taken' }, 409, origin);

        const c = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM players WHERE ip_hash=? AND created>?'
        ).bind(ipHash, hourAgo).first();
        if ((c?.n ?? 0) >= 5) return json({ e: 'rate_limited' }, 429, origin);

        await env.DB.prepare(
          'INSERT INTO players (pid, auth_hash, name, ip_hash, created, updated) VALUES (?,?,?,?,?,?)'
        ).bind(pid, authHash, name, ipHash, Date.now(), Date.now()).run();
      } catch (e) {
        const msg = String(e);
        if (msg.includes('UNIQUE')) return json({ e: 'name_taken' }, 409, origin);
        console.log('register failed', msg);
        return json({ e: 'db error' }, 500, origin);
      }

      return json({ ok: 1, pid, name }, 200, origin);
    }

    /* ---------------- /name-check ---------------- */
    if (u.pathname === '/name-check' && req.method === 'GET') {
      if (!originOk) return json({ e: 'origin' }, 403, 'null');
      const name = (u.searchParams.get('name') || '').trim();
      if (!/^[A-Za-z0-9 ]{2,12}$/.test(name)) {
        return json({ valid: 0, e: 'Name must be 2-12 letters, digits or spaces.' }, 200, origin);
      }
      try {
        const taken = await env.DB.prepare(
          'SELECT 1 AS x FROM players WHERE name = ? COLLATE NOCASE'
        ).bind(name).first();
        return json({ valid: 1, available: taken ? 0 : 1, name }, 200, origin);
      } catch { return json({ e: 'db error' }, 500, origin); }
    }

    /* ---------------- /save : one character, per seed ---------------- */
    if (u.pathname === '/save' && req.method === 'GET') {
      if (!originOk) return json({ e: 'origin' }, 403, 'null');

      // ?pop=1 needs no account, so answer before authenticating
      if (u.searchParams.get('pop')) return population(env, u, origin);
      if (u.searchParams.get('list')) return characters(env, u, origin);

      const who = await whoami(u.searchParams.get('auth') || '');
      if (who.e) return json({ e: who.e }, who.code, origin);
      const row = who.row;

      // no seed given means "wherever I was last"
      const seed = cleanSeed(u.searchParams.get('seed') || row.seed);

      let ch = null, note = null;
      try {
        ch = await env.DB.prepare('SELECT save FROM characters WHERE pid=? AND seed=?')
          .bind(row.pid, seed).first();
      } catch (e) {
        /* Before the characters table exists there is still one legacy blob on
           the player row. Serving it keeps an account that predates per-seed
           characters from looking wiped. */
        note = 'characters table missing';
        try {
          const legacy = await env.DB.prepare('SELECT save FROM players WHERE pid=?')
            .bind(row.pid).first();
          if (legacy && legacy.save && legacy.save !== '{}') ch = legacy;
        } catch {}
      }

      let save = {};
      try { save = JSON.parse((ch && ch.save) || '{}'); } catch {}
      const body = { pid: row.pid, name: row.name, seed, save, isNew: ch ? 0 : 1 };
      if (note) body.note = note;
      return json(body, 200, origin);
    }

    /* ---------------- /characters and /population ---------------- */
    if (u.pathname === '/characters' && req.method === 'GET') {
      if (!originOk) return json({ e: 'origin' }, 403, 'null');
      return characters(env, u, origin);
    }
    if (u.pathname === '/population' && req.method === 'GET') {
      if (!originOk) return json({ e: 'origin' }, 403, 'null');
      return population(env, u, origin);
    }

    /* ---------------- /health ---------------- */
    if (u.pathname === '/health') {
      try {
        await env.DB.prepare('SELECT 1').first();
        return json({ ok: 1, db: 'up', now: Date.now(), build: BUILD }, 200, origin);
      } catch (e) {
        return json({ ok: 0, db: 'down', err: String(e) }, 500, origin);
      }
    }

    /* ---------------- /play : friendly alias for the game ---------------- */
    if (u.pathname === '/play' || u.pathname === '/play/') {
      return env.ASSETS.fetch(new Request(new URL('/seedworld.html', u), req));
    }

    /* ---------------- everything else: static files ----------------
       Your own index.html at the repo root is served at / untouched. */
    return env.ASSETS.fetch(req);
  }
};
