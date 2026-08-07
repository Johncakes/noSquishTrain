# Data sources

Three sources, two publishers, and one of them has no API. Read
[gotchas.md](gotchas.md) before trusting any of it.

---

## 1. Congestion, lines 1–8 — data.go.kr `15071311`

**서울교통공사_지하철혼잡도정보.** Republished quarterly (quarterly cadence began
2024; annual before that, plus an off-cycle `20251130`).

- Portal page: <https://www.data.go.kr/data/15071311/fileData.do>
- OpenAPI spec: `https://infuser.odcloud.kr/oas/docs?namespace=15071311/v1`
- Data: `https://api.odcloud.kr/api/15071311/v1/uddi:{uddi}`

Each published file gets its own opaque `uddi`; there is no "latest" endpoint.
`src/data/discover.ts` reads the spec, takes the date out of each path summary,
and sorts by **the date string** — never by assuming a quarterly cadence.

Wide format: one record per (day type, line, station, direction) with 39 time
columns named `5시30분`-style. `normalize.ts` expands it to long form.

**Currently loaded:** 2026Q1, 65,169 rows, max reading 147.7%.

```
npm run ingest              # auto-discovers the newest version
npm run ingest -- --dry-run # validate without writing
npm run versions            # list every published version
```

The raw response is cached to `raw/{quarter}.json` so the normalizer can be
re-run without spending a call.

---

## 2. Station coordinates — data.go.kr `15099316`

**서울교통공사_1_8호선 역사 좌표(위경도) 정보.** Same publisher, same
auto-converted-file API pattern. Latest is `20250814`, 276 records.

- Portal page: <https://www.data.go.kr/data/15099316/fileData.do>

```
npm run coords
npm run coords -- --dry-run
```

**Joined by name, verified by number** — see gotchas #4. The CLI prints known
numbering disagreements (6호선 ×34, 2호선 ×1) and **exits non-zero** on any
other, because an unexpected one means a line was renumbered and the map built
on it would be wrong.

Current resolution of all 315 platforms:

| Source | Count | |
|---|---|---|
| `file` | 269 | straight from the published file |
| `file:renamed` | 5 | renamed since publication (서울역/서울, 불암산/당고개, 이수/총신대입구, 자양/뚝섬유원지) |
| `override` | 3 | file value wrong or absent (용답, 신답, 암사역사공원) |
| `shared-platform` | 8 | 9호선 interchanges reusing the exact 1–8 value |
| `line9-table` | 30 | 9호선-only, from Wikipedia |

---

## 3. Congestion, 9호선 — a spreadsheet, no API

**2025년 9호선 역별 시간별 혼잡도 자료.xlsx**, from 서울 열린데이터광장. There is
no API for this line, so the file is downloaded by hand into `raw/` and
committed (decision #22 — it is the only copy).

- Dataset page: <https://data.seoul.go.kr/dataList/OA-22197/F/1/datasetView.do>

8 sheets: `{상선,하선} × {일반,급행} × {평일,휴일}`. Read directly by
`src/data/xlsx.ts` (no dependency — an xlsx is a ZIP of XML and Node ships raw
DEFLATE).

```
npm run line9                      # auto-finds the newest 9호선 .xlsx in raw/
npm run line9 -- --dry-run
npm run line9 -- path/to/file.xlsx
```

**Currently loaded:** 2025Q4 (기준일자 25.11.17–21 weekday, 25.11.22–23 holiday),
11,865 rows — 8,436 일반 and 3,429 급행. Max reading **185.8%** (하선급행 동작).

Four things it does differently from the 1–8 source, all handled:

| | |
|---|---|
| Direction | 상선/하선 are **inverted** vs lines 1–8 (gotchas #1) |
| Services | 급행 and 일반 are separate trains, stored separately (decision #18) |
| Day types | 평일 + 휴일 only; 휴일 is one Sat+Sun measurement written to both (decision #19) |
| Buckets | Holiday sheets stop at 23:30 — 37 buckets, not 39 |

Stations have no 역번호 in the file, only names in running order, so they are
numbered 901–938 along it (matching the official codes).

---

## Credentials

One data.go.kr key, in `.env` (gitignored). It must be registered **per dataset**
— 활용신청 on *both* `15071311` and `15099316`, or the second returns
`-401 유효하지 않은 인증키`. `.env.example` carries placeholders and both links.

Wikipedia needs no key. The Wikidata SPARQL endpoint was tried first and timed
out; the MediaWiki API (`action=query&prop=coordinates`, 50 titles per call) is
what actually worked.

---

## Refreshing everything

```
npm run ingest     # lines 1-8, newest published quarter
npm run line9      # 9호선, from raw/*.xlsx
npm run coords     # station coordinates
npm run check      # validate before trusting any of it
npm run serve      # builds the front end, then serves on :8137
```

Order matters only in that `coords` reads the station list out of the congestion
table, so run it after the two ingests. The swap is scoped by line
(decision #20), so the ingests do not clobber each other.

**`npm run check` is the gate.** Six checks: every platform has a coordinate;
every segment connects known platforms; adjacent stations are within 5km;
interchange platforms share a location; every platform has readable congestion;
no departure reads an all-zero row. Checks 3 and 6 are the ones that have
actually caught published errors.
