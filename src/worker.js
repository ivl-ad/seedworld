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

/* The one distance test outside flush(): ops 11, 14 and 15 are delivered straight
   to one socket by pid, bypassing interest management — unchecked, a trade request
   or a pvp hit crossed the whole map. */
const near = (a, b) => Math.abs(a.x - b.x) <= VIEW && Math.abs(a.z - b.z) <= VIEW;

const encoder = new TextEncoder();
const toHex = b => [...new Uint8Array(b)].map(v => v.toString(16).padStart(2, '0')).join('');
const sha256 = async s => toHex(await crypto.subtle.digest('SHA-256', encoder.encode(s)));
const cleanSeed = s => (String(s || '').trim().toLowerCase().slice(0, 32)) || 'lumbridge';

/* Bumped whenever the wire contract changes. The client reads it out of the
   socket hello, because a stale Worker deployment is otherwise independently
   invisible from the browser: assets update instantly and the Worker does not,
   so the game looks new while the server is months old and silently dropping
   everything it does not understand. */
const BUILD = 8;   // 6: player houses (op 23); 7: wider house lane, size refusal echoed as op 24; 8: houses stand only while their owner is connected

/* The spawn-table revision this deployment expects, echoed in the socket hello
   (element 6). A client whose own SPAWN_REV differs keeps its world private
   rather than sharing keys that name different monsters. Keep in step with the
   client's SPAWN_REV when deploying both. */
const SPAWN_REV = 7;

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
   ranged 3, prayer 4, magic 5, hitpoints 8; 24-27 are locked reserved slots the
   client's totalLevel() skips. The formula mirrors the client's combatLevel()
   exactly — prayer half-counts, and ranged/magic builds take the best branch. */
function summarise(save) {
  const xp = Array.isArray(save && save.xp) ? save.xp : [];
  let total = 0;
  const lv = [];
  for (let i = 0; i < 28; i++) { const L = levelFor(+xp[i] || 0); lv[i] = L; if (i < 24) total += L; }
  const base = 0.25 * (lv[2] + lv[8] + Math.floor(lv[4] / 2));
  const melee = 0.325 * (lv[0] + lv[1]);
  const range = 0.325 * Math.floor(lv[3] * 1.5), mage = 0.325 * Math.floor(lv[5] * 1.5);
  const combat = Math.floor(base + Math.max(melee, range, mage)) || 3;
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

    /* Player houses: pid -> {x, z, d} where d is the client's compact house
       object. Loaded from D1 once per object lifetime, written back only when
       an edit has sat for a few seconds — a build session costs one read and
       a handful of writes, not a write per wall. */
    this.houses = null;          // null until loadHouses has run
    this.hDirty = new Set();
    this.hFlushT = 0;

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
    /* The older socket is told why it is going: 4001 means "your account
       just arrived on another connection". A client that hears it stands
       down rather than reconnecting — otherwise the two windows kick each
       other off every second for as long as both stay open. */
    const old = this.players.get(pid);
    if (old && old.ws !== server) { try { old.ws.close(4001, 'replaced'); } catch {} }
    for (const q of this.players.values()) q.seen.delete(pid);

    // savedSeed starts as what the players row already says, so a session in
    // the same world never rewrites it — that UPDATE used to fire once per
    // connection (and again after every hibernation wake) for nothing.
    /* A reconnecting pid keeps its last known position and gear, and `pos` — has this
       connection ever reported a position — rides the record so nobody is announced,
       or seated at 0,0, before a real move arrives. */
    const rec = { pid, name, seed, x: (old && old.x) | 0, z: (old && old.z) | 0,
                  pos: (old && old.pos) ? 1 : 0, face: 0, flags: 0, eq: (old && old.eq) || [],
                  savedSeed: u.searchParams.get('last') || null };
    server.serializeAttachment(rec);
    this.players.set(pid, { ws: server, ...rec, seen: new Set(), n: 0, t0: 0 });

    // extra fields appended, so older clients reading only [1] and [2] still work
    server.send(JSON.stringify([[0, pid, Date.now(), name, seed, BUILD, SPAWN_REV]]));

    /* A late arrival must see the stumps and absences everyone else does.
       Snapshots go only to the joiner; live traffic covers everyone else. */
    this.pruneWorld(1);
    const snap = [];
    for (const [k, d] of this.depleted) snap.push([20, k, d]);
    for (const [k, d] of this.monDead) snap.push([22, k, d]);
    for (let i = 0; i < snap.length; i += 100) {
      try { server.send(JSON.stringify(snap.slice(i, i + 100))); } catch {}
    }
    // every standing house, in pages — and a house stands only while its owner is connected,
    // so the joiner sees just the living (their own record they ignore client-side)
    await this.loadHouses(seed);
    const hs = [];
    for (const [hp, h] of this.houses) if (this.players.has(hp)) hs.push([23, hp, h.d]);
    for (let i = 0; i < hs.length; i += 20) {
      try { server.send(JSON.stringify(hs.slice(i, i + 20))); } catch {}
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

    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(m)) return;
    // Size is judged after the type is known, and a rejection is never silent:
    // a save that vanishes without a word is indistinguishable from one that
    // was never sent, which is exactly how this went unnoticed.
    /* Build 5 clients pack a tick's routine traffic into ONE socket send — an
       array of messages instead of a message — so a fighting player costs one
       billable request a tick instead of several. Inner messages still count
       against the rate, and saves never ride a batch (their own size lane). */
    const batch = Array.isArray(m[0]);
    const msgs = batch ? m.slice(0, 16) : [m];
    if ((me.n += msgs.length) > RATE) return;
    if (m[0] !== 8 && m[0] !== 23 && raw.length > (batch ? MAXSMALL * 4 : MAXSMALL)) {   // 23 has its own 4000-byte lane in handle()
      console.log('oversize', batch ? 'batch' : m[0], raw.length, me.pid);
      return;
    }
    for (const one of msgs) if (Array.isArray(one)) await this.handle(me, ws, one, now);
  }

  saveAtt(ws, me) {
    try {
      ws.serializeAttachment({
        pid: me.pid, name: me.name, seed: me.seed, x: me.x, z: me.z, pos: me.pos ? 1 : 0,
        face: me.face, flags: me.flags, eq: me.eq, savedSeed: me.savedSeed || null
      });
    } catch {}
  }

  async handle(me, ws, m, now) {
    switch (m[0]) {

      case 1: {                                  // move
        const [, tick, x, z, face, flags] = m;
        if (!Number.isInteger(x) || !Number.isInteger(z)) return;
        if (Math.abs(x) > 1e6 || Math.abs(z) > 1e6) return;
        const jump = Math.abs(x - me.x) + Math.abs(z - me.z);
        const first = !me.pos;
        me.x = x; me.z = z; me.pos = 1;
        me.face = (face | 0) & 15;
        me.flags = (flags | 0) & 3;
        this.queue('1:' + me.pid, [1, [[me.pid, tick | 0, x, z, me.face, me.flags]]]);
        /* The attachment refreshes every 16th step: a walk needs no precision across a
           hibernation wake — the next move fixes it. A teleport is not a step: hibernate
           before the next boundary and the object wakes holding the pre-respawn position,
           and flush() hands out an enter for a player who is towns away (the ghost). So a
           jump past a walk's reach, and the first move of a session, write through now. */
        me.mvN = ((me.mvN || 0) + 1) & 15;
        if (first || jump > VIEW || me.mvN === 0) this.saveAtt(ws, me);
        return;
      }

      case 2:                                    // action animation
        this.queue('2:' + me.pid, [2, me.pid, (m[2] | 0) & 255]);
        return;

      case 3:                                    // equipment — 11 slots as of the armoury expansion
        me.eq = Array.isArray(m[1])
          ? m[1].slice(0, 12).map(v => (v == null ? null : String(v).slice(0, 32)))
          : [];
        this.queue('3:' + me.pid, [3, me.pid, me.eq]);
        this.saveAtt(ws, me);                    // gear matters across a wake: onlookers dress you from it
        return;

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
        const act = (m[2] | 0) & 7;
        // act 2 is "called off" and must always land, or the other party is stranded in an open trade window
        if (other && (act === 2 || near(me, other))) {
          try { other.ws.send(JSON.stringify([[14, me.pid, me.name, act]])); } catch {}
        }
        return;
      }

      case 15: {                                  // trade offer
        const other = this.players.get(String(m[1] || ''));
        const offer = Array.isArray(m[2]) ? m[2].slice(0, 28).map(it => [
          String((it && it[0]) || '').slice(0, 32), Math.max(0, (it && it[1] | 0) || 0)
        ]) : [];
        if (other && near(me, other)) {
          try { other.ws.send(JSON.stringify([[15, me.pid, offer]])); } catch {}
        }
        return;
      }

      case 11: {                                 // pvp hit, delivered to one player
        /* Attacker-authoritative by design, but budgeted: a single hit is capped at 60
           and a rolling four-tick window at 110, which clears any legitimate spec chain
           and shuts the 25-messages-a-second firehose a modified client could open. */
        const d = (m[2] | 0) & 255;
        if (d > 60) return;
        if (now - (me.dmgT || 0) > 2400) { me.dmgT = now; me.dmgSum = 0; }
        if ((me.dmgSum = (me.dmgSum || 0) + d) > 110) return;
        const target = this.players.get(String(m[1] || ''));
        if (target && near(me, target)) {
          const cls = typeof m[4] === 'string' ? m[4].slice(0, 1) : 0;   // element 4 carries the attack class so the victim's overhead can answer
          try { target.ws.send(JSON.stringify([[11, me.pid, d, m[3] ? 1 : 0, cls]])); } catch {}   // element 3 carries Smite
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
          /* combat and total level ride the same write as columns, so /characters can
             select two integers instead of parsing forty 8 KB blobs. Rows older than
             the columns migrate lazily: the ALTER runs once, on the first save that
             finds them missing. */
          const s = summarise(payload);
          const put = () => this.env.DB.prepare(
            'INSERT INTO characters (pid, seed, save, combat, total_level, created, updated) VALUES (?,?,?,?,?,?,?) ' +
            'ON CONFLICT(pid, seed) DO UPDATE SET save=excluded.save, combat=excluded.combat, total_level=excluded.total_level, updated=excluded.updated'
          ).bind(me.pid, seed, blob, s.combat, s.totalLevel, now, now).run();
          try { await put(); } catch (e) {
            if (!/no column|no such column/i.test(String(e))) throw e;
            await this.env.DB.prepare('ALTER TABLE characters ADD COLUMN combat INTEGER').run().catch(() => {});
            await this.env.DB.prepare('ALTER TABLE characters ADD COLUMN total_level INTEGER').run().catch(() => {});
            await put();
          }
          // Remember the last world played so login can preselect it — but only
          // when it actually changes. Writing it on every flush doubled the D1
          // cost of a save for a column that changes once a session.
          if (me.savedSeed !== seed) {
            me.savedSeed = seed;
            await this.env.DB.prepare('UPDATE players SET seed=?, updated=? WHERE pid=?')
              .bind(seed, now, me.pid).run();
            this.saveAtt(ws, me);
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

      case 23: {                                 // house claimed, edited or demolished: [23, houseObj | 0]
        const h = m[1];
        await this.loadHouses(me.seed);
        if (!h) { this.houses.delete(me.pid); }
        else {
          if (!Number.isInteger(h.x) || !Number.isInteger(h.z) || Math.abs(h.x) > 1e6 || Math.abs(h.z) > 1e6 || !Array.isArray(h.rm)) return;
          let d; try { d = JSON.stringify(h); } catch { return; }
          /* a refusal must never be silent: the owner keeps seeing their own copy and would never learn the world holds a stale one */
          if (d.length > 4000 || h.rm.length > 12) { try { ws.send(JSON.stringify([[24, d.length]])); } catch {} return; }
          this.houses.set(me.pid, { x: h.x, z: h.z, d: h });
        }
        this.hDirty.add(me.pid);
        this.flushHouses();
        this.queue('23:' + me.pid, [23, me.pid, h || 0]);
        break;
      }

      case 9:                                    // clock ping
        ws.send(JSON.stringify([[9, m[1], Date.now()]]));
        return;

      default:
        return;
    }
  }

  /* One-shot timer only, never a repeating alarm. A repeating alarm keeps the
     object awake forever and blocks hibernation, which is where the bill is. */
  pruneWorld(force) {
    const t = Date.now();
    if (!force && t - (this.lastPrune || 0) < 5000) return;   // entries self-expire; a sweep every few seconds is plenty
    this.lastPrune = t;
    const gt = wTick();
    for (const [k, d] of this.depleted) if (d <= gt) this.depleted.delete(k);
    for (const [k, d] of this.monDead) if (d <= gt) this.monDead.delete(k);
    // a runaway client cannot grow these without bound: oldest entries fall off
    while (this.depleted.size > 800) this.depleted.delete(this.depleted.keys().next().value);
    while (this.monDead.size > 800) this.monDead.delete(this.monDead.keys().next().value);
  }

  /* One SELECT per object lifetime; the table self-creates the first time a
     world ever sees a house. Rows hold the client's compact JSON. */
  async loadHouses(seed) {
    if (this.houses) return;
    this.houses = new Map();
    this.housesSeed = seed;
    if (!this.env.DB) return;
    try {
      const q = () => this.env.DB.prepare('SELECT pid, data FROM houses WHERE seed=?').bind(seed).all();
      let rows;
      try { rows = await q(); } catch (e) {
        if (!/no such table/i.test(String(e))) throw e;
        await this.env.DB.prepare('CREATE TABLE IF NOT EXISTS houses (pid TEXT NOT NULL, seed TEXT NOT NULL, x INTEGER, z INTEGER, data TEXT, updated INTEGER, PRIMARY KEY (pid, seed))').run().catch(() => {});
        rows = await q();
      }
      for (const r of (rows.results || [])) {
        try { const h = JSON.parse(r.data); this.houses.set(r.pid, { x: h.x | 0, z: h.z | 0, d: h }); } catch {}
      }
    } catch (e) { console.log('loadHouses failed', String(e).slice(0, 120)); }
  }

  /* Dirty pids drain to D1 in one burst, at most every 10 s; force on a
     player's disconnect so a finished build session cannot be lost to
     hibernation. Fire-and-forget: a miss costs a house edit, not a session. */
  flushHouses(force) {
    if (!this.hDirty.size || !this.env.DB || !this.houses) return;
    const t = Date.now();
    if (!force && t - this.hFlushT < 10000) return;
    this.hFlushT = t;
    const dirty = [...this.hDirty]; this.hDirty.clear();
    this.ctx.waitUntil((async () => {
      for (const pid of dirty) {
        const h = this.houses.get(pid);
        const run = () => h
          ? this.env.DB.prepare('INSERT INTO houses (pid, seed, x, z, data, updated) VALUES (?,?,?,?,?,?) ON CONFLICT(pid, seed) DO UPDATE SET x=excluded.x, z=excluded.z, data=excluded.data, updated=excluded.updated')
              .bind(pid, this.housesSeed, h.x, h.z, JSON.stringify(h.d), t).run()
          : this.env.DB.prepare('DELETE FROM houses WHERE pid=? AND seed=?').bind(pid, this.housesSeed).run();
        try { await run(); } catch (e) {
          if (/no such table/i.test(String(e))) {
            await this.env.DB.prepare('CREATE TABLE IF NOT EXISTS houses (pid TEXT NOT NULL, seed TEXT NOT NULL, x INTEGER, z INTEGER, data TEXT, updated INTEGER, PRIMARY KEY (pid, seed))').run().catch(() => {});
            await run().catch(e2 => console.log('house write failed', pid, String(e2).slice(0, 120)));
          } else console.log('house write failed', pid, String(e).slice(0, 120));
        }
      }
    })());
  }

  queue(key, msg) {
    this.pending.set(key, msg);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 40);
  }

  flush() {
    this.timer = null;
    const msgs = [...this.pending.values()];
    this.pending.clear();

    /* Interest management on a VIEW-sized grid: anyone within the view radius of p
       sits in p's 3x3 cell neighbourhood, so each player scans local density, not
       the whole room. Leaves (and reaping the departed) fall out of the seen set. */
    const grid = new Map();
    for (const q of this.players.values()) {
      const c = Math.floor(q.x / VIEW) + ':' + Math.floor(q.z / VIEW);
      const a = grid.get(c); if (a) a.push(q); else grid.set(c, [q]);
    }

    for (const p of this.players.values()) {
      const out = [];

      for (const pid of p.seen) {
        const q = this.players.get(pid);
        if (!q || Math.abs(q.x - p.x) > VIEW || Math.abs(q.z - p.z) > VIEW) { p.seen.delete(pid); out.push([5, pid]); }
      }

      const bx = Math.floor(p.x / VIEW), bz = Math.floor(p.z / VIEW);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const cell = grid.get((bx + a) + ':' + (bz + b));
        if (!cell) continue;
        for (const q of cell) {
          if (q.pid === p.pid || p.seen.has(q.pid) || !q.pos) continue;   // an unreported position is not a location to announce
          if (Math.abs(q.x - p.x) <= VIEW && Math.abs(q.z - p.z) <= VIEW) {
            p.seen.add(q.pid);
            out.push([6, q.pid, q.name, q.x, q.z, q.eq]);
          }
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
        if (m[0] === 23) {                       // houses are landscape: everyone in the room hears of one
          if (m[1] !== p.pid) out.push(m);
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
    /* A reconnect replaces the record and closes the old socket, and that
       close lands here later wearing the same pid. Deleting by pid alone
       would evict the live connection — the room then ignores everything it
       sends, saves included. Only the socket that owns the record removes it. */
    const cur = this.players.get(a.pid);
    if (!cur || cur.ws !== ws) return;
    this.players.delete(a.pid);
    /* the leaver's house folds with them: houses stand only while their owner walks the world.
       Their record leaves memory and D1 too — the character blob is the one true copy, and the
       client re-announces it on every join. A row surviving an evicted object without this close
       is filtered from snapshots by the connected-pids check above. */
    if (this.houses && this.houses.delete(a.pid)) this.hDirty.add(a.pid);
    this.flushHouses(1);                         // a leaver's pending house edits (now including the fold) go to disk
    this.queue('23:' + a.pid, [23, a.pid, 0]);
    for (const p of this.players.values()) {
      if (p.seen.delete(a.pid)) {
        try { p.ws.send(JSON.stringify([[5, a.pid]])); } catch {}
      }
    }
  }
}

/* ======================== THE GRAND EXCHANGE ============================= */
/* One Durable Object for every world: the order book is global, so a seller
   on one seed meets a buyer on another, and a sale completes with the seller
   asleep three worlds away. The book lives in D1 and survives hibernation;
   the object holds nothing worth keeping — it exists to be the till. Every
   request funnels through one instance and queues on one lock, so two
   crossing offers can never both spend the same coins.

   The matching rule is the 2007 exchange's: a new offer sweeps the book
   best-price-first, each trade striking at the *resting* offer's price. A
   buy above the ask pays the ask and banks the difference for collection; a
   sell below the bid is paid the bid. Escrow is taken by the client when the
   offer is placed, so completion needs nobody online: proceeds sit in the
   offer's collection box until their owner comes back for them, and only an
   emptied, finished offer frees its slot. */

const GE_SLOTS = 8;
const GE_MAXQ = 100000;          // per offer; arrows are the volume case
const GE_MAXP = 1000000000;      // coins per item

export class Exchange extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.lock = Promise.resolve();
    this.tables = 0;
  }
  /* D1 calls are subrequests, not DO storage, so the platform's input gate
     does not serialise them — this chain does. Handlers run strictly in turn. */
  serial(fn) {
    const p = this.lock.then(fn, fn);
    this.lock = p.then(() => {}, () => {});
    return p;
  }
  /* The table makes itself on first use: no migration to run, nothing to
     forget. The index is what the matching query lives on. */
  async ensure() {
    if (this.tables) return;
    await this.env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS ge_offers (' +
      'pid TEXT NOT NULL, slot INTEGER NOT NULL, kind INTEGER NOT NULL, ' +
      'item TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL, ' +
      'filled INTEGER NOT NULL DEFAULT 0, coins_box INTEGER NOT NULL DEFAULT 0, ' +
      'items_box INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0, ' +
      'created INTEGER NOT NULL, updated INTEGER NOT NULL, ' +
      'PRIMARY KEY (pid, slot))').run();
    await this.env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS ge_book ON ge_offers (item, kind, state, price)').run();
    this.tables = 1;
  }
  row(pid, slot) {
    return this.env.DB.prepare('SELECT * FROM ge_offers WHERE pid=? AND slot=?')
      .bind(pid, slot).first();
  }
  async fetch(req) {
    const u = new URL(req.url);
    const pid = u.searchParams.get('pid') || '';
    if (!pid) return Response.json({ e: 'no pid' }, { status: 400 });
    /* The 10-second poll from every open GE panel is a plain read: serving it
       outside the lock means the whole world's polls no longer queue behind
       one player's fills. A read racing a fill sees the book a beat stale,
       which the next poll corrects. Mutations still run strictly in turn. */
    if (u.pathname === '/ge') {
      try { await this.ensure(); return Response.json(await this.state(pid)); }
      catch (e) { console.log('ge error', String(e)); return Response.json({ e: 'exchange error' }, { status: 500 }); }
    }
    return this.serial(async () => {
      try {
        await this.ensure();
        let b = {};
        if (req.method === 'POST') { try { b = await req.json(); } catch {} }
        if (u.pathname === '/ge/place') return Response.json(await this.place(pid, b));
        if (u.pathname === '/ge/abort') return Response.json(await this.abort(pid, b));
        if (u.pathname === '/ge/collect') return Response.json(await this.collect(pid, b));
        return Response.json({ e: 'no such path' }, { status: 404 });
      } catch (e) {
        console.log('ge error', String(e));
        return Response.json({ e: 'exchange error' }, { status: 500 });
      }
    });
  }
  async state(pid) {
    const r = await this.env.DB.prepare('SELECT * FROM ge_offers WHERE pid=?').bind(pid).all();
    const slots = new Array(GE_SLOTS).fill(null);
    for (const o of (r.results || [])) if (o.slot >= 0 && o.slot < GE_SLOTS) slots[o.slot] = o;
    return { slots };
  }
  async place(pid, b) {
    const slot = b.slot | 0, kind = b.kind | 0;
    const item = String(b.item || '');
    const price = Math.floor(+b.price || 0), qty = Math.floor(+b.qty || 0);
    if (slot < 0 || slot >= GE_SLOTS) return { e: 'bad slot' };
    if (kind !== 0 && kind !== 1) return { e: 'bad kind' };
    if (!/^[a-z0-9_]{1,32}$/.test(item) || item === 'coins') return { e: 'bad item' };
    if (!(price >= 1 && price <= GE_MAXP)) return { e: 'bad price' };
    if (!(qty >= 1 && qty <= GE_MAXQ)) return { e: 'bad quantity' };
    if (await this.row(pid, slot)) return { e: 'slot in use' };
    const now = Date.now();
    await this.env.DB.prepare(
      'INSERT INTO ge_offers (pid, slot, kind, item, price, qty, filled, coins_box, items_box, state, created, updated) ' +
      'VALUES (?,?,?,?,?,?,0,0,0,0,?,?)').bind(pid, slot, kind, item, price, qty, now, now).run();

    /* One page of candidates in one query, matches bounded per request: a large
       order against a fragmented book fills against up to twenty resting offers
       now and meets the rest of the book on later placements, instead of holding
       the global lock for a round-trip per row. */
    let remaining = qty, mineFilled = 0;
    const page = await this.env.DB.prepare(kind === 0
      ? 'SELECT * FROM ge_offers WHERE item=? AND kind=1 AND state=0 AND price<=? AND pid<>? ORDER BY price ASC, created ASC LIMIT 20'
      : 'SELECT * FROM ge_offers WHERE item=? AND kind=0 AND state=0 AND price>=? AND pid<>? ORDER BY price DESC, created ASC LIMIT 20'
    ).bind(item, price, pid).all();
    const upd = 'UPDATE ge_offers SET filled=filled+?, coins_box=coins_box+?, items_box=items_box+?, state=?, updated=? WHERE pid=? AND slot=?';
    for (const c of (page.results || [])) {
      if (remaining <= 0) break;
      const t = Math.min(remaining, c.qty - c.filled);
      if (t <= 0) continue;                          // a corrupt row must not spin forever
      const tp = c.price;                            // the resting offer sets the price
      const doneC = c.filled + t >= c.qty ? 1 : 0;
      mineFilled += t;
      const doneM = mineFilled >= qty ? 1 : 0;
      // both sides of the trade land in one transaction, or neither does
      await this.env.DB.batch(kind === 0
        ? [this.env.DB.prepare(upd).bind(t, t * tp, 0, doneC, now, c.pid, c.slot),               // seller is paid the ask
           this.env.DB.prepare(upd).bind(t, t * (price - tp), t, doneM, now, pid, slot)]         // buyer gets goods + change
        : [this.env.DB.prepare(upd).bind(t, 0, t, doneC, now, c.pid, c.slot),                    // buyer's offer receives goods
           this.env.DB.prepare(upd).bind(t, t * tp, 0, doneM, now, pid, slot)]);                 // seller is paid the bid
      remaining -= t;
    }
    return { offer: await this.row(pid, slot) };
  }
  async abort(pid, b) {
    const o = await this.row(pid, b.slot | 0);
    if (!o) return { e: 'no offer' };
    if (o.state !== 0) return { offer: o };          // already finished: nothing to abort
    // the unfilled escrow comes back through the collection box, as it did in 2007
    const backC = o.kind === 0 ? (o.qty - o.filled) * o.price : 0;
    const backI = o.kind === 1 ? (o.qty - o.filled) : 0;
    await this.env.DB.prepare(
      'UPDATE ge_offers SET state=1, coins_box=coins_box+?, items_box=items_box+?, updated=? WHERE pid=? AND slot=?'
    ).bind(backC, backI, Date.now(), o.pid, o.slot).run();
    return { offer: await this.row(o.pid, o.slot) };
  }
  async collect(pid, b) {
    const o = await this.row(pid, b.slot | 0);
    if (!o) return { e: 'no offer' };
    /* The client asks for what its pack can hold; the box keeps the rest.
       Clamped here, so a hopeful request can never mint anything. */
    const tc = Math.max(0, Math.min(Math.floor(+b.coins || 0), o.coins_box));
    const ti = Math.max(0, Math.min(Math.floor(+b.items || 0), o.items_box));
    await this.env.DB.prepare(
      'UPDATE ge_offers SET coins_box=coins_box-?, items_box=items_box-?, updated=? WHERE pid=? AND slot=?'
    ).bind(tc, ti, Date.now(), o.pid, o.slot).run();
    const left = await this.row(o.pid, o.slot);
    if (left && left.state === 1 && left.coins_box === 0 && left.items_box === 0) {
      await this.env.DB.prepare('DELETE FROM ge_offers WHERE pid=? AND slot=?').bind(o.pid, o.slot).run();
      return { coins: tc, items: ti, item: o.item, offer: null };
    }
    return { coins: tc, items: ti, item: o.item, offer: left };
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

/* Resolve an auth token to an account row. Every authed route needs this
   and every one of them wants the same 401 on failure. */
async function whoami(env, auth) {
  if (!/^[0-9a-f]{64}$/.test(auth || '')) return { e: 'bad auth', code: 400 };
  let row;
  try {
    row = await env.DB.prepare('SELECT pid, name, seed FROM players WHERE auth_hash=?')
      .bind(await sha256('v1|' + auth)).first();
  } catch (e) { console.log('db error', String(e)); return { e: 'db error', code: 500 }; }
  if (!row) return { e: 'unknown key', code: 401 };
  return { row };
}

async function population(env, u, origin) {
  const seed = cleanSeed(u.searchParams.get('seed'));
  /* Every open world-select screen polls this; without a cache each poll
     instantiates the seed's Durable Object. Eight seconds of staleness on a
     head-count costs nothing and absorbs the whole crowd into one request. */
  const ck = new Request('https://population.cache/?seed=' + encodeURIComponent(seed));
  try {
    const hit = await caches.default.match(ck);
    if (hit) return json(await hit.json(), 200, origin);
  } catch {}
  let body;
  try {
    const stub = env.WORLD.get(env.WORLD.idFromName('world:' + seed));
    const r = await stub.fetch(new Request('https://do/count'));
    const j = await r.json();
    body = { seed, n: j.n | 0, build: BUILD };
  } catch {
    // an empty world has never been instantiated; that is not an error
    body = { seed, n: 0, build: BUILD };
  }
  try {
    await caches.default.put(ck, new Response(JSON.stringify(body),
      { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=8' } }));
  } catch {}
  return json(body, 200, origin);
}
async function characters(env, u, origin) {
  const who = await whoami(env, u.searchParams.get('auth') || '');
  if (who.e) return json({ e: who.e }, who.code, origin);
  const row = who.row;

  /* The columns are written at save time; the blob ships only for rows that
     predate them, and those are summarised the old way until their next save. */
  let rows;
  try {
    rows = await env.DB.prepare(
      'SELECT seed, updated, combat, total_level, CASE WHEN combat IS NULL THEN save ELSE NULL END AS save ' +
      'FROM characters WHERE pid=? ORDER BY updated DESC LIMIT 40'
    ).bind(row.pid).all();
  } catch {
    try {
      rows = await env.DB.prepare(
        'SELECT seed, save, updated FROM characters WHERE pid=? ORDER BY updated DESC LIMIT 40'
      ).bind(row.pid).all();
    } catch {
      // no table yet: an account with no characters, not a server fault
      return json({ pid: row.pid, name: row.name, last: row.seed, characters: [], build: BUILD }, 200, origin);
    }
  }
  const list = (rows?.results || []).map(r => {
    if (r.combat != null) return { seed: r.seed, updated: r.updated, combat: r.combat, totalLevel: r.total_level };
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

      const who = await whoami(env, auth);
      if (who.e) return new Response(who.e, { status: who.code });

      const target = new URL(req.url);
      target.searchParams.set('pid', who.row.pid);
      target.searchParams.set('name', who.row.name || 'Adventurer');
      target.searchParams.set('seed', seed);
      target.searchParams.set('last', who.row.seed || '');

      const stub = env.WORLD.get(env.WORLD.idFromName('world:' + seed));
      return stub.fetch(new Request(target, req));
    }

    /* ---------------- /ge : the grand exchange ---------------- */
    if (u.pathname === '/ge' || u.pathname.startsWith('/ge/')) {
      if (!originOk) return json({ e: 'origin' }, 403, 'null');
      let body = null;
      if (req.method === 'POST') {
        try { body = await req.json(); } catch { return json({ e: 'bad json' }, 400, origin); }
      }
      const who = await whoami(env, (body && body.auth) || u.searchParams.get('auth') || '');
      if (who.e) return json({ e: who.e }, who.code, origin);
      try {
        const stub = env.EXCHANGE.get(env.EXCHANGE.idFromName('ge'));
        const r = await stub.fetch(new Request('https://do' + u.pathname + '?pid=' + who.row.pid, {
          method: req.method,
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined
        }));
        let j; try { j = await r.json(); } catch { j = { e: 'exchange error' }; }
        return json(j, r.status, origin);
      } catch (e) {
        console.log('ge route failed', String(e));
        return json({ e: 'exchange unavailable' }, 500, origin);
      }
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

      const who = await whoami(env, u.searchParams.get('auth') || '');
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
        /* the indexes every hot query assumes; IF NOT EXISTS makes /health the
           one-call migration to run after a deploy */
        for (const q of [
          'CREATE INDEX IF NOT EXISTS idx_players_auth ON players (auth_hash)',
          'CREATE INDEX IF NOT EXISTS idx_players_name ON players (name COLLATE NOCASE)',
          'CREATE INDEX IF NOT EXISTS idx_players_ip ON players (ip_hash, created)',
          'CREATE INDEX IF NOT EXISTS idx_characters_pid ON characters (pid, updated)',
          'CREATE TABLE IF NOT EXISTS houses (pid TEXT NOT NULL, seed TEXT NOT NULL, x INTEGER, z INTEGER, data TEXT, updated INTEGER, PRIMARY KEY (pid, seed))',
          'CREATE INDEX IF NOT EXISTS idx_houses_seed ON houses (seed)'   // loadHouses filters by seed; the (pid, seed) PK cannot serve that
        ]) { try { await env.DB.prepare(q).run(); } catch {} }
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
