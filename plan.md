# Seoul Subway Congestion-Aware Route Planner — Project Brief

## Goal

Build a prototype route planner that suggests subway routes between two
stations, optimized not just for speed but for avoiding crowded cars/lines,
using Seoul Metro's published congestion data.

## Data on hand

File: `서울교통공사_지하철혼잡도정보_20260331.csv` (from data.go.kr, dataset 15071311)
Encoding: **CP949** (Korean) — must specify this when reading with pandas
(`pd.read_csv(path, encoding='cp949')`).

Shape: 1,671 rows × 44 columns.

Columns:

- `요일구분` — day type: 평일 (weekday) / 토요일 (Saturday) / 일요일 (Sunday)
- `호선` — subway line (1호선–8호선, 8 lines total)
- `역번호` — station number
- `출발역` — station name (245 unique stations)
- `상하구분` — direction: 상선/하선 (up/down, for line-shaped lines) or
  내선/외선 (inner/outer loop, for loop lines like Line 2)
- 38 time-bucket columns, one per 30-min slot from `5시30분` to `00시30분`,
  each holding a congestion % (observed range: 0.0–147.7, mean ~16–20
  depending on time of day; over 100% = standing room only / overcrowded)

Key caveat: this is **historical/typical average congestion**, not real-time.
It tells you "how crowded this station/line/direction usually is at this time
on this day-type," not live conditions.

## The core problem

This CSV has no concept of "route from A to B" — it's just station-level
crowding by line/time/direction. To build a route planner we need to pair it
with an actual transit routing API to get candidate routes, then overlay
congestion scores on top.

## Routing API landscape (researched Aug 2026)

**Kakao and Naver do NOT offer public transit routing via open/hobby APIs:**

- Kakao Mobility's Directions/Navi API (`apis-navi.kakaomobility.com`) only
  covers driving, walking, and multi-waypoint car routes — parameters are
  car-specific (fuel type, hipass, etc). No subway/bus mode.
- Kakao Map's `traffic` (대중교통) mode exists but only as a URL-builder that
  deep-links into the Kakao Map app/web UI — not a data API you can parse.
- Naver's Directions 5 API (`naveropenapi.apigw.ntruss.com`) is driving-only
  (time, distance, fuel cost, tolls). No transit mode.

**What Korean devs actually use for transit routing: ODsay**

- Third-party API at `lab.odsay.com`, not affiliated with Kakao/Naver.
- Offers public transit route search, dedicated subway route search, nearby
  transit stop lookup, and route graphic data.
- Has a free tier suitable for personal/prototype projects — this is the
  standard choice for Korean hobby transit projects.
- Sign up for a free API key at lab.odsay.com before starting.

**Alternative: Google Directions API (transit mode)**

- Works fine for Seoul subway, returns step-by-step legs + fares.
- No meaningful free tier (paid), and less tuned to local transit quirks
  than ODsay. Fallback option only.

## Proposed architecture

1. **Get a candidate route** from ODsay (origin → destination → day/time):
   returns which lines, which stations, where transfers happen.
2. **Score each leg** by joining the route back to the congestion CSV —
   match on 호선 + 역(출발역) + 상하/내외 direction + nearest 30-min time
   bucket — to get a congestion % per leg of the trip.
3. **Generate alternatives** — e.g. compare the fastest route against routes
   that avoid the worst leg(s) (different transfer point, one stop
   earlier/later departure), scored on a blend of travel time + congestion.
4. **Surface as a simple UI** — pick origin/destination/day-type/time, see
   2–3 ranked route options with total time + a per-leg crowding badge.

### Nuance to handle carefully

`상선/하선` vs `내선/외선` direction labels need to be mapped correctly per
line: loop lines (2호선, and partial loops elsewhere) use 내선/외선, the rest
use 상선/하선. Direction must be derived from the actual travel direction
between the two chosen stations, not assumed.

## Suggested build order for a local prototype

1. Load and clean the CSV (cp949 encoding, melt time columns into long format
   for easier querying: `역, 호선, 요일구분, 방향, 시간대, 혼잡도`).
2. Get an ODsay API key, wire up a basic "get route between two stations" call.
3. Write the join logic: given a route's legs, look up congestion for each.
4. Build scoring/ranking for "fastest" vs "least crowded" route.
5. Simple frontend (even just a CLI or basic HTML page) to input origin/
   destination/time and display ranked options.

## Notes

- Discussed in a private/incognito Claude.ai chat that isn't saved — this
  file is the handoff artifact to continue the work locally in Claude Code.
- Original public dataset page: https://www.data.go.kr/data/15071311/fileData.do
