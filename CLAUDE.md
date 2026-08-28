# Seedworld (see)

Single-file three.js MMO client — all game code in index.html; src/worker.js is the Cloudflare Worker (D1 + Durable Objects).

- Read MAP.md first: it lists every section banner to grep. Never read index.html whole (~810KB) — grep a banner, read the range.
- Never read, grep or hand-edit icons07.js (generated sprite/tint maps; `node icons07-genmap.mjs` / `node icons07-tint.mjs` rewrite it).
- Style: compact reusable code, terse comments only where needed, minimal D1/Worker cost. OSRS wiki numbers stay wiki-true; XP_RATE 1.
- Bump SPAWN_REV on spawn-side changes; wire message ids are append-only; deploy worker + client together on wire changes.
- Test: launch config `see-static` (:8933) → Play offline → Enter this world; `POST /shot?name=x` saves a screenshot.
- Never git commit, push or deploy unless the user explicitly asks in the current request.
