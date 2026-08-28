# Seedworld map

Navigation for index.html (~810KB, one `<script>`): CSS, a short HTML shell, then every game system in banner-marked
sections. **Never read the file whole.** Grep a banner phrase from the list below (e.g. `rg "24. ACTIONS" index.html`),
then read that range. Regenerate this file with `node mapgen.mjs`.

## Rules of the road
- All game code lives in index.html; src/worker.js is the Cloudflare Worker (D1 + Durable Objects). Deploy both together on any wire change.
- icons07.js is GENERATED single-line data (sprite + tint maps, ~72KB): never hand-edit, read or grep it.
  Regenerate with `node icons07-genmap.mjs` (after editing icons07-map.csv) / `node icons07-tint.mjs` (after sprite or glyph changes).
  New-item icon workflow: csv row -> `node icons07-sync.mjs` -> `node icons07-genmap.mjs`; then `node icons07-tint.mjs` for worn tints.
- .rgignore hides the generated/data files (icons07.js, the csvs, sound/, i07/, c07/) from ripgrep on purpose.
- Data tables are positional where rows repeat: NPC_TYPES rows are `[k, n, lv, hp, atk, str, def, abon, sz, body, build, rest?]`
  via NPC_ROW (fills db 0, spd 4); BOSSES and LADDERS carry their own column schemas — each table's comment block is the authority.
- Bump SPAWN_REV on any spawn-side change; wiki numbers stay wiki-true; wire message ids are append-only.
- Test: launch config `see-static` (:8933) -> Play offline -> Enter this world. `POST /shot?name=x` saves a screenshot to the scratchpad.

## Sections, in file order (grep the phrase, not a line number)
- 1. NOISE: integer hash, never floats, so every client agrees
- 2. THE WORLD: one tile = one unit, sea level y 0. macroHeight is the expensive field (sampled per tile),
- STAGE 1: siting. Each stage reads only what the stage before it settled.
- STAGE 4: roads. Each settlement links east, south and maybe a diagonal, so every link is built once.
- 2b. REGIONS: a jittered Voronoi of kingdoms ~1500 tiles across. Everything discrete hangs off the cell —
- 2c. SITES: the unit of OSRS content is the named place with a fixed composition, not the per-tile coin flip.
- 2d. THE WILDERNESS: an infinite series of ragged rings round the origin. Ring i spans a quadratic layout
- 3. PALETTE: colour per quad, light baked into the vertex
- 4. PROGRESSION: the 2007 xp curve, exactly; 99 = 13,034,431 xp
- 5. ITEMS: tier x piece generates the armoury; every other item is one line
- 5b. THE LARDER: what the gathering and making skills pass between them; a family is one line
- 5c. RECIPES: everything made by hand or at a fixture is one row; a make task turns them out one every few ticks
- 6. SHOPS: stock is a function of (kind, settlement tier), derived every time the door opens
- 6b. MAGIC EQUIPMENT: robes trade defence for magic; an elemental staff supplies its rune
- 7. COMBAT STYLES, MAGIC, PRAYER
- 7b. SPECIAL ATTACKS: energy runs 0-100 and returns 10 points every 50 ticks, the 2007 pace. cost in %; n hits; acc…
- 6c. ICONS: drawn, not loaded; one 32x32 canvas per (glyph, colours), cached as a data URL
- 8. RENDERER
- 9. PROP LIBRARY
- 10. INSTANCE POOLS: fixed-size InstancedMeshes for everything transient
- 11. ARTICULATED FIGURES: one material per part so gear recolours a limb
- 12. THE BESTIARY: a rig is one merged body plus limbs pivoted at their joints; builders take proportions and a palette
- 12b. NAMED BOSSES: a family's build at monster scale with the wiki's own stat block; they fight in phases and roam…
- 12c. LEVEL VARIANTS: every rung is the wiki's own stat block, never a scaled copy. A bare number is the base row's…
- 12d. DROP TABLES: each family's wiki table, mapped onto this game's items. den + main: one weighted [id, w, min, max]
- STAGE 2: the plan of a town. One tile grid, claimed in a fixed order: streets, walls, castle, houses, parks.
- 13. THE CASTLE: gatehouse, mid-wall turrets, a two-tier hall with the banner, sheds and a well
- 14. LAYING OUT A TOWN
- 15. CHUNKS
- 16. HEIGHT, FLOORS AND WALKABILITY
- 17. STREAMING LOOP: half-tile quads nearby, then 1, 2, 4, with hysteresis
- 18. PATHFINDING: A* over tiles, octile heuristic, capped; diagonals need both orthogonals open
- 19. INVENTORY + EQUIPMENT: 28 slots; raw materials stack
- 20. PLAYER
- 21. WALKING THE TICK
- the wilderness ditch: click the trench anywhere and the character runs up and leaps it. Going in asks (once,
- 22. GROUND ITEMS
- 23. NPCS: spawned off the settlement lattice, so a town has the same guards every time
- THE SKULL: strike first and it rises; strike back and it doesn't. The timer is one saved tick (`sku`), refreshed by…
- 24. ACTIONS: one roll every four ticks; chance rises with level over the requirement and the tool
- 25. SHOPS, BANK, BARBER
- 25b. GRAND EXCHANGE: the order book lives on the worker; this side is an honest till (escrow leaves the pack first)
- 26. UI
- 27. DEV CONSOLE (backtick)
- 28. HOVER + CONTEXT MENU: left click runs the top option, the corner names it, right click lists the rest
- 29. MINIMAP: 120 px over 360 tiles, painted a few rows a frame and cached; only the markers repaint as you move
- 30. CONTROLS: the mouse moves the character, the keys swing the camera
- 31. WORLD MAP: 64-pixel tiles cached and filled in nearest first; names and door icons from the settlement plans
- 32. RESET
- 33. THE GAME TICK: everything with consequences, ten times per six seconds; frames only interpolate
- 34. ANIMATION: one rig drives you and everyone else; each entity owns its phase accumulators
- 35. HUD
- 36. FRAME
- 37. ACCOUNT: the key is the whole credential; it leaves this file only as a hash
- MUSIC: one looping track; browsers hold it back until the first gesture
- SOUND EFFECTS: one-shot wavs in sound/<id>.wav, fetched on first use and decoded once; the music's gesture unlocks…
- write budget. D1 bills per row written, so mutations only raise a flag and a scheduler coalesces them:
- 38. THE SOCKET: everything degrades to single player
- 39. OTHER PLAYERS: the nearest twelve get articulated rigs, the rest one instanced pool
- 40. BOOT
- 41. WELCOME: the preview runs the same macroHeight and siting pass the world will use
- 42. TRADING: two offers, two confirmations, any change clears both
- 43. LEAVING PROPERLY: signing out is the one moment we can wait for the server to confirm the write
- 44. LOGIN: who you are, then where you are; every branch has an offline exit
- 43. SKILLS: one block a skill, in dependency order. A block defines its own items, recipes, objects and verbs, and…
- ICONS for the skill items, in the 6c voice: 32x32, 1px K outlines, c primary, d shade
- WORLD SITES & TOWN AMENITIES: the furniture of the named places — mine rims, grove signs, waypoints between towns,
- AGILITY: log balances over narrow water and climbing rocks up short cliffs, pure functions of the tile; a crossing…
- THIEVING: pockets and market stalls. A pick is one roll every two ticks until a stun, a full pack or a target that…
- SLAYER: one master a settlement hands out a family to hunt; every kill of it pays its hitpoints in xp
- FLETCHING: a knife on logs, a string on a bow, feathers and tips on shafts; every row is a hand recipe (use one item…
- HERBLORE: a vial of water takes a clean herb, the unfinished potion takes its secondary; a dose is one pack slot and…
- FARMING: four patches on every settlement's field ring; sow, let the shared clock run, harvest. No weeds, compost or…
- HUNTER: traps laid on open ground beyond the town edge; a tick hook rolls each against the best catch your level…
- CONSTRUCTION II: THE PLAYER HOUSE
- DUNGEONS: every castle's black door opens on one. They live on a far band of the same plane (z > 500000, inside the
- WILDERNESS CAVES: the rings keep their own doors down — a gaping cave mouth or a half-buried trapdoor on a
- BRIDGES: now and then a plank crossing over a narrow water — or, in the wilds, over lava — where both banks
- MAGIC: blasts, waves and curses are SPELLS rows; the utility spells below are armed as P.uspell (item spells) or fire…
- THE OLD BOOK'S MISSING PAGES: holds and grabs, gem bolts, the famous weapons, the baker's economy, prayer on the cloth
- ARMOURY II: beyond rune. Barrows, the god wars, and the treasure tiers. Icons ship from i07/ (icons07-map.csv);
- ARMOURY II DROPS: every treasure above now has a home. GWD pieces sit at the wiki's own 1/381 armour and 1/508
- ARMOURY III: the remaining famous absences, wiki-audited Aug 27 (infoboxes fetched, every stat exact).
- THE LONG GAME: boss pets, the collection log, combat feats, town diaries, and the world's small surprises
- TREASURE TRAILS: a clue falls from a kill and names a spot a walk away; a spade there turns up a casket. One trail at…
- DEV TELEPORTS: the nearest settlement reader (laid out on the way), lattice finder, or spawn of a chosen kind; one…
- SKILL GUIDES: what each level unlocks, read off the data tables; a click on a skill opens its page. Recipes and the…
