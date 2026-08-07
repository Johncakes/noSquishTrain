# Context

## What this is

A map of how crowded Seoul's subway is, for every station on lines 1–9, across
the whole service day. You scrub or play a timeline and watch the crush form,
spread and drain.

It is a **data visualisation tool**, not a service. It answers "what was
measured", never "what should you do". That distinction was arrived at the hard
way — see the pivots below.

Single user, run locally, not deployed.

## Current state (2026-08-07)

- **315 platforms**, 308 track segments, 9 lines
- **77,034 readings**: lines 1–8 at 2026Q1 (65,169), 9호선 at 2025Q4 (11,865)
- 39 half-hour buckets, 05:30 → 00:30; 3 day types; 2 directions; 2 services
- Zero runtime dependencies. Dev dependencies are `typescript` and `@types/node`
- `npm run serve` → <http://localhost:8137>

```
src/
  data/     fetching and storing      db, discover, ingest, normalize,
                                      seed-csv, coords, xlsx, line9
  domain/   what the data means       congestion, network, topology, geo, journey
  server/   one process               index
  cli/      entry points              check, coords, line9, stats, versions, journey
  shared/   compiled for both sides   scale, types
  web/      typed ES modules          main, map, timeline, legend, styles.css
```

`tsc` is the entire front-end build (`tsconfig.web.json` → `dist/`). The browser
loads native ES modules and imports the same thresholds the server uses.

## How it got here

Three pivots, each because the previous thing turned out not to be worth using.

### 1. Route planner (abandoned)

The original brief was crowd-aware routing: find a path that avoids the crush.
Built the topology, a time-dependent Dijkstra, a discomfort model converting
congestion into "perceived minutes", and a departure-time sweep.

**Killed by measurement.** Sampling 3,126 rush-hour origin–destination pairs:
42% produced a different line set, but only **21% (654)** actually lowered
perceived travel time, and the net effect was one finding — *get off 2호선*
(−93 uses) and onto 1호선 (+139), 6호선 (+123) or 3호선 (+111). A router is a
bad way to say one thing.

Deleted in `5c04c64`: `route.ts`, `plan.ts`, `score.ts`, `sweep.ts` and the
pathfinding half of `graph.ts`.

### 2. Journey evaluator (kept, marginal)

The next idea was narrower: not *which* route, but *when* — show the crowding at
each boarding moment, including the transfer you reach 25 minutes later.

The premise was real and is worth remembering: departing 신도림 at 08:00,
4호선 at 동대문역사문화공원 reads **82.8% when you leave but 105.4% by the time
you arrive**. A departure-time-only view gets that wrong.

But it needed a route to evaluate, which meant an external routing API, and it
was still a service giving advice. Survives as `npm run journey` (a CLI taking a
hand-written journey file) because it costs nothing and it is the only thing
that answers the transfer question.

### 3. The map (current)

Judgement: the dataset is inherently spatio-temporal — 315 platforms × 39
buckets × 3 day types × 2 directions × 2 services — and every previous version
collapsed all of that into a single recommended number. A map with a time
control shows the whole shape and cannot be wrong the way advice can be.

The topology work survived the pivot intact: `topology.ts` still holds the
hand-validated adjacency, and `network.ts` uses it to draw the track.

## What the map has shown so far

Findings that came out of building it. All figures are 평일, worst service at
each platform, measured against the current database.

- **The morning peak is worse than the evening peak.** 39 platform-directions
  sit at 130%+ at 08:00, against 26 at 18:00. On lines 1–8 alone the gap is
  starker still — **23 against 9** — even though the middle of the distribution
  is nearly identical. Evening crowding spreads wider; morning crowding
  concentrates.
- **The two directions peak at opposite times**, which is most of the story and
  the reason each station is drawn as a split dot. Flipping 방향 at 08:00 is the
  clearest single thing the map does.
- **9호선 is the most crowded line in the network, on both services.** It holds
  every extreme: worst 하행 at 08:00 is 동작 (186%), worst 상행 is 노량진 (183%),
  and the evening's worst is 국회의사당 하행 at 185%. Even its *일반* peaks at
  160% (선유도) — above the 148% maximum of anything on lines 1–8.
- Before 9호선 was added, the worst readings anywhere were 철산 148% (상행) and
  강동구청 145% (하행), both at 08:00. 9호선 displaced both by ~40 points.

## Open threads

- `npm run journey` reads the **일반** figure on 9호선, since that is
  `lookup.at`'s default. For a station where 급행 also stops that understates by
  up to 70 points.
- `meta.source` is a single row, so whichever ingest ran last overwrites it.
  Per-source provenance is in `meta.quarter` and `meta.line9_period`, which are
  correct; `source` alone is misleading.
- Nothing writes `data-theme`, so the light/dark toggle path in the CSS is
  present but unexercised.
