# Project notes

Written for whoever picks this up next — most likely me, months from now, having
forgotten why any of it is the way it is.

| File | What it holds |
|---|---|
| [context.md](context.md) | What this is now, and the three pivots that got it here |
| [decisions.md](decisions.md) | Every decision that is not obvious from the code, with the reason and the evidence |
| [data-sources.md](data-sources.md) | Where the data comes from, what it costs, and how to refresh it |
| [gotchas.md](gotchas.md) | The data traps. Read this before trusting anything the map draws |

## What goes where

The code comments explain *how*; these files explain *why*, and record things
that cannot be seen from any single file:

- **A decision belongs in `decisions.md`** if a reasonable person would have
  chosen differently, or if I'd be tempted to "fix" it later without knowing
  what it was for.
- **A trap belongs in `gotchas.md`** if the data lies in a way that produces a
  plausible, wrong result — the ones that do not announce themselves. Each entry
  says how it was caught, because that is the part worth reusing.
- **Anything about a source** — keys, cadence, quirks, refresh steps — goes in
  `data-sources.md`.

## Keeping it current

Append; don't rewrite. A decision that gets reversed stays, with a note pointing
at the one that replaced it — the reversal is usually the more interesting half.
Decisions are numbered so they can be referenced from commit messages and code
comments.

The single rule that has earned its keep: **when the data surprises you, write
down how you found out.** Every entry in `gotchas.md` cost real time to
discover, and most of them would have shipped silently.
