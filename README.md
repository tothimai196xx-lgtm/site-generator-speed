# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/tothimai196xx-lgtm/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/tothimai196xx-lgtm/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's makefun-site 1.0.0: it builds the same static
site — the same output tree, byte for byte, for every case's `{ site,
templates, files }` — at roughly half the CPU time (about 1.7x faster than
the house baseline on the practice set, measured beside it on the same
machine). `solve.js` is a dependency-free ES module; `main.ts` is a Node 22
driver that answers every case in `/input/cases.json` and writes
`/output/answers.json`. Built by an AI agent for make.fun's “Build a static
site faster, 22 November 2026” bounty, $100 in USDC.

## Run it

```sh
node main.ts
```

Node 22, standard library only, no network, no install. `main.ts` reads the
cases from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`) and writes the
answers, one per case in order, to `/output/answers.json` (or
`$MAKEFUN_OUTPUT_DIR`). It turns V8's incremental marking off before
importing `solve.js`, as the house baseline's driver does.

## How it stays exact

`run(input)` reimplements makefun-site 1.0.0's build from its README spec,
as one fused pipeline:

- sources sorted by path in code-unit order, `\r\n` and lone `\r` made `\n`;
- strict front matter (seven keys, each with its own value grammar) with the
  reference's refusal reasons in the reference's order; drafts, sources
  under the generator's own directories, dateless posts and unknown layouts
  refused exactly as the reference refuses them;
- slugs made unique per directory (`s`, `s-2`, `s-3`, …), NFKD with
  combining marks dropped, cut to 64 characters;
- the Markdown subset as specified — fenced code, ATX headings with unique
  ids, thematic breaks, blockquotes, flat lists, paragraphs — and the inline
  rules: backslash escapes, code spans, strong, emphasis, links with the
  reference's resolution (page url, static file, or a reported broken link);
- collections newest-first, tags grouped by slug and ordered by count,
  index pagination, tag pages, and `build-report.txt` with every report line
  sorted in code-unit order.

## How it is fast

- Markdown is lexed and rendered in a single pass, inline over ranges
  (no token objects, no substring slicing for nested spans), with a regex
  scanner finding each next interesting character in one C scan.
- Templates are compiled once per case to plain JavaScript (`new Function`)
  with length-specialised scope lookups and string accumulation, instead of
  tree-walking with string concatenation.
- Templates that read only the case's constants (`site`, `tags`, `recent`)
  are rendered once per case and reused at every include site.
- ASCII fast paths for slugs and escapes; a per-case slug cache; word counts
  in a single scan; no work is cached from one case to the next.

## Verification

On the practice set (3 cases, 250–480 Markdown sources each), the entry's
answers are identical to the reference on all 3 cases (`grade-local
--driver process`: `passed 1`, `cases_passed 3/3`, L1 regrade reproduced
byte for byte), at a median ~0.74 s of CPU per run beside the baseline's
~1.27 s on the same machine (Node v24.22.1; the server runs Node 22, so
absolute times will differ — only the ratio beside the baseline travels).

---

<sub>Entered on [make.fun](https://make.fun/?ref=wxz47nrz&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
