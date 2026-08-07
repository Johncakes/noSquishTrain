# Gotchas

Data traps that produce a **plausible, wrong** result. Every one of these would
have shipped silently. Each entry records how it was caught, because that is the
reusable part.

The recurring shape: the published data is not wrong in ways that crash. It is
wrong in ways that render beautifully.

---

## 1. 9호선's 상선/하선 are inverted relative to lines 1–8

On lines 1–8, `하선` = increasing 역번호. On 9호선 it is the opposite: `상선` =
increasing.

**Caught by:** terminus zeros. 개화 is 9호선's lowest 역번호 and its **하선**
series is zero in every bucket. On lines 1–8 it is the lowest station's **상선**
that is zero (방화, 응암, 장암).

**Would have caused:** every 9호선 reading drawn on the wrong half of every dot —
a line where everyone appears to commute home in the morning.

**Confirmed by:** 염창 상선 peaks 133% at 08:00 inbound and 하선 peaks 135% at
18:00 outbound. Inverted, that reads backwards.

Encoded in `LINE_DIRECTIONS` (`topology.ts`).

---

## 2. Phantom zeros: second services hide under 9xxx rows

A station serving two services records the second under a synthetic 9xxx row and
leaves **its own row at 0** for that direction.

`211 성수 외선` reads 0, while `9001 성수E 외선` reads 34.4 (the real main loop)
and `9002` reads 18.9 (the branch shuttle).

**Caught by:** matching each synthetic row against its neighbours — 성수E's 34.4
sits between 뚝섬 (35.8) and 건대입구 (35.1), so it is the main loop; 9002's 18.9
matches the branch's 15–17.

**Would have caused:** the most dangerous failure in the original router — a 0%
is invisible *and* it actively attracts routes.

Encoded in `CONGESTION_SOURCE`. `npm run check` #6 asserts no departure reads an
all-zero row.

---

## 3. Consecutive 역번호 are not adjacent track

Four distinct ways this fails: branch junctions (5호선 2554→2555), branches
numbered out of path order (성수지선 runs 211→244→245→250→246), stations appended
to the numbering but sitting mid-line (1호선 동묘앞 159, 8호선 남위례 2828), and
one-way track (응암순환).

**Caught by:** `npm run check`. Its first run produced 6 failures, including two
of my own mistakes — degree computed from out-edges rather than undirected
neighbours, and 응암순환 built bidirectionally when it is one-way.

---

## 4. The coordinate file renumbers 6호선

data.go.kr 15099316 carries the same 고유역번호 as the congestion file — which
makes joining on the number look obvious. It places **봉화산 at 2615**; the
congestion file has it at 2648 (correct: between 화랑대 and 신내). That single
displacement shifts every station from 연신내 onward by one slot.

**Would have caused:** 34 of 39 stations on the line drawn at their neighbour's
position, with 봉화산 landing in 은평구 instead of 중랑구. The map would have
looked entirely plausible.

**Caught by:** joining on name and asserting the numbers agree. 까치산 also
disagrees (filed at 200, ours 260). Both are listed as known in
`src/cli/coords.ts`; anything else exits non-zero.

---

## 5. Two coordinates in the published file are simply wrong

용답 is filed 6.4km west of where it is (near 충정로); 신답 is off by 1.2km.

**Caught by:** `npm run check` #3, which asserts adjacent stations are within
5km. 성수 → 용답 read as a **7.3km hop** on a branch whose real spacing is 2.3km.

Corrected in `OVERRIDES` with cited sources. 암사역사공원 (opened 2024-08) is
absent from the 2025-08 file entirely and is filled the same way.

---

## 6. Fixed slots vs. a packed list *(my bug, shipped in the first map commit)*

The wire format sent `directions` as a list in sort order, so slot 0 meant "the
first direction that exists" — not 상행. Every terminus serves exactly one
direction, so 방화 (하선 only) and 오금 (상선 only) both landed in slot 0.

**Consequence while it was live:** 상행 mode painted 방화's **하선** number and
labelled it 상행; 하행 mode drew an ✕ over service that actually runs. 22
platforms wrong in every single-direction view.

**Caught by:** counting rendered marks in the browser. 상행 mode reported **zero**
✕ marks when it should have had 13.

**Lesson:** an index that carries meaning must be assigned by that meaning, never
by position in a filtered list. Making the slots nullable let the type checker
find every place that had assumed otherwise.

---

## 7. Interchange coordinates must be byte-identical

`geo.ts` groups platforms into one station by `lat.toFixed(5),lon.toFixed(5)`.
A coordinate that differs in the sixth decimal splits one interchange into two
stations sitting next to each other.

This is why 9호선's eight shared stations reuse the exact 1–8 value instead of
having their own entry.

---

## 8. `replaceQuarter` would have deleted 9호선

The swap deleted every row from any other quarter. Lines 1–8 are 2026Q1; 9호선 is
2025Q4. So the next routine `npm run ingest` would have wiped it.

**Caught by:** thinking about what "quarter" meant once two sources with
different periods existed — not by any test. Now `replaceLines` scopes by line.

---

## 9. Missing `.track-9` made a whole line invisible

Line colours are applied by a CSS class per line. Adding 9호선 without adding
`.track-9` left its track with SVG's default stroke of `none`.

**Caught by:** looking at a screenshot of the 급행 view, where the express dots
were visibly floating with no line beneath them.

`styles.css` now has an audit-friendly shape: every line has three theme tokens
and one track class.

---

## 10. `TextDecoder('cp949')` throws

Node does not accept the label `cp949`. Use `'euc-kr'` or `'windows-949'`.
(Only relevant to the CSV seeder; the API path is UTF-8 JSON.)

---

## 11. The 9호선 holiday sheets have 37 buckets, not 39

Holiday service stops at 23:30, so 00:00 and 00:30 are absent. Column counts are
read per sheet rather than assumed, and `npm run line9` prints them when they
differ.

---

## 12. Provenance can hide in shared strings

The 9호선 file's `기준일자` notes — the only record of which week was measured —
are in `sharedStrings.xml` but referenced by no cell. They live in a header or
text box. `readWorkbook` exposes the whole string table for exactly this.

---

## 13. All-zero series are "no service", not "empty train"

At a terminus the dead direction is published as 0 in every bucket. Stored, that
becomes a 0% reading at exactly the place trains do not run. Series that are zero
in *every* bucket are dropped at ingest; individual zeros are kept, because a
genuinely quiet 05:30 reading is real.

---

## Coverage limits (not bugs, but easy to forget)

- **1호선 covers 서울역–청량리 only** — 10 stations. The rest of Line 1 is
  KORAIL-operated and not in this dataset.
- Lines 1–8 are 서울교통공사 only. No 신분당선, 공항철도, 경의중앙, GTX.
- 9호선's 급행 serves 16 of its 38 stations.
- The two congestion sources are measured in **different periods** — 2026Q1 and
  one week of November 2025. Comparing a 9호선 number against a 2호선 number
  compares different months.
