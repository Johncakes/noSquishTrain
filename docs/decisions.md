# Decisions

Numbered so they can be cited from commits and comments. Append; don't rewrite.
A reversed decision keeps its entry and gains a pointer to its replacement.

---

## 1. Node only, zero runtime dependencies — 2026-08-06

**Considered:** Python with pandas, the obvious choice for this shape of work.

**Chose:** Node 24, nothing installed at runtime.

The two reasons Python was proposed both evaporated once the source turned out
to be JSON rather than CSV: no CP949 decoding, no wide→long `melt`. Node 24 runs
`.ts` directly by stripping types, ships `node:sqlite`, `fetch` and
`--env-file-if-exists`, and the local `python3` had no working `venv`/`pip`
anyway.

**Consequence:** `node src/x.ts` just runs, and the whole project stays
inspectable. It also means writing things that a library would otherwise
provide — see #17.

---

## 2. Latest quarter only — 2026-08-06

The source is republished quarterly. Keeping four quarters was the initial plan;
it was dropped because nothing in the app compares quarters. Ingest is a
wholesale swap, which also makes re-running it safe.

---

## 3. Resolve the dataset version automatically — 2026-08-06

data.go.kr gives each published file its own opaque `uddi`, with no "latest"
endpoint. But it also publishes an OpenAPI spec listing every version, with the
file date in each path summary.

`discover.ts` reads that spec and sorts by **the date string**, not by assuming
quarterly cadence — the series is annual through 2023 and contains an off-cycle
`20251130`. So no uddi is ever pasted by hand.

---

## 4. Never store a missing measurement as zero — 2026-08-06

A blank cell is dropped, not written as `0`. `lookup.at` returns `null`, and the
map draws grey.

This is the most load-bearing rule in the project. A 0% does not merely mislead —
in the original router it *attracted* routes, because an empty train looked
ideal. The same rule is why an all-zero 9호선 series is dropped at ingest (#19)
and why the map has a distinct "no measurement" colour.

---

## 5. Establish direction semantics by measurement — 2026-08-06

`상선`/`하선` are not defined anywhere in the data. Rather than assume, they were
derived from terminus behaviour: at 방화, 응암 and 장암 — each the lowest 역번호
on its line — `상선` is zero in every bucket, because no train departs that way.
So on lines 1–8, **하선 = increasing 역번호**.

Loop lines label by 내선/외선 instead. And 9호선 turned out to be inverted — see
gotchas.md #1. The method is the point: *measure it per line, never assume.*

---

## 6. Station numbering is not adjacency — 2026-08-06

Consecutive 역번호 are adjacent most of the time and it is tempting to build the
graph from that alone. Four failure modes say otherwise: branch junctions,
branches numbered out of path order (성수지선), stations appended to the
numbering but sitting mid-line (동묘앞 159, 남위례 2828), and one-way track
(응암순환).

`topology.ts` corrects each explicitly — `NON_ADJACENT`, `EXTRA_EDGES`,
`ONE_WAY`, `FORWARD_OVERRIDE` — and `npm run check` validates the result.
`NON_ADJACENT` means only "no track"; a hop whose *label* runs against numeric
order is `FORWARD_OVERRIDE`, kept separate so the strict check stays strict.

---

## 7. Second services live under synthetic 9xxx rows — 2026-08-06

A platform serving two services records the second under a synthetic 9xxx row
and leaves its own row at 0. `CONGESTION_SOURCE` maps each affected hop to the
row that actually describes it. See gotchas.md #2.

---

## 8. Drop the route planner — 2026-08-07 *(reverses the original brief)*

Measured its value before deleting it: of 3,126 sampled rush-hour cases, 21%
improved, and the aggregate finding was "avoid 2호선". Not worth a feature.

Deleted in `5c04c64`. The topology beneath it survived and now draws the map.

---

## 9. Rank a journey by its worst leg, not its average — 2026-08-06

In `journey.ts`. One crushed train ruins a trip; a calm second leg does not
compensate. An evaluation with no covered legs sorts **last**, not first —
unknown is not calm.

---

## 10. A geographic map, no basemap — 2026-08-07

Real lat/lon, but only our own network is drawn: line-coloured segments and
station dots, no tiles. Seoul's network shape is recognisable on its own, and
this keeps the no-external-request property. A schematic official-style map
would have meant hand-placing 300+ stations.

Projection is plate carrée with a cos(latitude) correction, accurate to well
under a pixel across Seoul's ~0.3° of latitude.

---

## 11. ES modules and `tsc`, not a framework — 2026-08-07

**Considered:** React or Svelte with Vite.

**Chose:** typed `.ts` modules compiled by `tsc` to native ES modules, no
bundler, no runtime dependency.

The complaint that prompted this was real — a 603-line HTML file with inline
everything — but the defect underneath it was not one a framework fixes: the
browser code re-derived the congestion thresholds that already existed, typed,
in the Node code. Two sources of truth for the numbers that decide what colour a
station is.

The app's entire client state is three values (time bucket, day type, direction;
later four). The render is ~600 SVG marks whose `fill` changes. A virtual DOM
exists to avoid work this app is not doing.

**Consequence:** `src/shared/` compiles for both sides, so a threshold cannot
mean two things. If this ever grows genuine component state, revisit.

---

## 12. Join coordinates by name, verify by number — 2026-08-07

The coordinate file carries the same 역번호 as the congestion file, which makes
joining on it look obvious and makes it wrong. See gotchas.md #4.

The join is by name within a line; the number is then checked and disagreements
are **reported, not absorbed**. Known disagreements are listed with their counts
in `src/cli/coords.ts`, so an unexpected one fails loudly.

---

## 13. Interchange platforms must share the exact coordinate — 2026-08-07

`geo.ts` groups platforms into one station by rounded position, then fans them
out. So 9호선 당산 does not get its own coordinate — it reuses the byte-identical
value already loaded for 2호선. A near-miss would silently split one interchange
into two stations sitting beside each other.

Only the 30 9호선 stations with no lines-1–8 counterpart are listed in
`LINE9_COORDS`.

---

## 14. Split dot for direction; whole circle for one — 2026-08-07

Each station is one dot: left half slot 0 (상행), right half slot 1 (하행),
because the two peak at opposite times and that asymmetry is most of the story.

Selecting a single direction draws a real `<circle>` rather than two half-discs
painted alike — both are stroked, so their shared diameter would be drawn twice
and leave a seam down the middle of what should read as one solid dot.

---

## 15. Sequential white→red ramp, deliberately failing one check — 2026-08-07

Congestion means bad, so it wears a warm scale: single-hue red, generated in
OKLCH at even lightness steps. Validated monotone with adjacent ΔL ≥ 0.06 and
3° hue spread in both modes.

It **fails** the ordinal light-end contrast check — band 0 measures 1.05:1 on
the light surface, because "여유 is white" is the requirement. An invisible dot
would be indistinguishable from no station at all, so the relief channel is a
hairline outline on every dot (3.5:1), plus the table view. That outline also
draws the divider that makes the split dot readable.

Bands are the operator's semantics — 34% seats gone, 100% design capacity, 130%
crush — not even slices. Even slices would put no boundary at capacity, the one
number the whole dataset is defined against.

Dark mode uses the **same five steps** rather than re-anchoring. Cost:
band 4 measures 2.69:1 on the dark surface against band 0's 16.1:1, so crowded
stations are the quietest marks there. Accepted so the scale means one thing in
both themes; reverting is a five-line change.

---

## 16. Line colours on the track, thin and translucent — 2026-08-07

Official 서울교통공사 colours, all verified ≥3:1 on both surfaces (with a
lightened set for dark, and a darkened 9호선 gold for light — its official
`#bdb092` is 2.09:1).

This is a second colour system beside the congestion ramp, doing a different job
(identity vs magnitude). Kept thin and semi-transparent so it stays reference
geometry. Spending eight categorical hues on line identity would have fought the
ramp for attention.

---

## 17. Read the .xlsx directly rather than add a library — 2026-08-07

9호선 is published only as a spreadsheet; there is no API. An xlsx is a ZIP of
XML and Node ships raw DEFLATE in `node:zlib`, so `src/data/xlsx.ts` is ~150
lines: walk the central directory, inflate, pull values.

Deliberately not supported: formulas, styles, dates, streaming. For one file a
year, that trade beats a dependency (#1).

---

## 18. 급행 is a separate service, never merged — 2026-08-07

At 동작 하선 the 급행 reads 186% while the 일반 beside it reads 114% — same
platform, same minute, different train. Averaging or overwriting would erase the
most crowded thing in the network.

`service` joined the primary key; the payload nests it under each direction; a
열차 control offers 전체 (worst running here) / 일반 / 급행. Selecting 급행
leaves only the 31 express platform-directions solid, which draws the express
corridor across the city in one view.

---

## 19. 휴일 is written to both 토요일 and 일요일 — 2026-08-07

The 9호선 file publishes 평일 and 휴일 only, and its 휴일 sheets are measured
over one Saturday *and* one Sunday together. That single series is written to
both day types, and the ingest report says so rather than implying two
independent measurements. The alternative — showing 9호선 as blank on weekends —
is worse.

Holiday sheets also stop at 23:30, so the last two buckets are genuinely empty
rather than zero.

---

## 20. Replace by line, not by quarter — 2026-08-07

`replaceQuarter` deleted every row from any other quarter. Once 9호선 arrived
measured in a different period (2025Q4 vs 2026Q1), that meant the next
`npm run ingest` would have silently deleted it.

Now `replaceLines` scopes the swap to the lines in the batch. Both periods are
named in the UI header rather than one date standing for the whole map.

---

## 21. Direction slots are fixed by semantics — 2026-08-07 *(fixes a shipped bug)*

The wire format sent `directions` as a packed list in sort order, so slot 0 meant
"first direction that exists", not 상행. See gotchas.md #6.

Slots are now assigned by label (상선/외선 → 0, 하선/내선 → 1) and are nullable,
with the server asserting no two departures claim one slot. Making them nullable
was the useful part: the type checker then found every place that had assumed a
packed list.

---

## 22. Commit the 9호선 spreadsheet despite `raw/` being ignored — 2026-08-07

`raw/` holds cached API responses, which are re-fetchable, so it is gitignored.
The 9호선 xlsx is hand-downloaded and has no API behind it — it is the only copy.
`.gitignore` carries an explicit `!raw/*.xlsx` exception.
