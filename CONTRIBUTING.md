# Contributing to exposure-router

Thanks for looking. This is a small, deliberately scoped library, and the bar
below is what keeps it reviewable by one maintainer.

## Setup

```bash
npm install          # dev dependencies only; the library has zero runtime deps
npm test             # must be green before you open a PR
```

Node 20 or newer.

## The checks

| Command | What it checks | When it may change |
|---|---|---|
| `npm test` | Unit tests, golden outputs, seeded property tests, the README quick start. | Never red in a PR. |
| `npm run typecheck` | Strict TypeScript, `noUncheckedIndexedAccess` on. | Never red in a PR. |
| `npm run bench -- --check` | Behaviour metrics per scenario against `bench/baseline.json`. | Only with an intended, explained behaviour change. |
| `npm run bench:perf` | Runtime and memory on the larger scenarios. Information only. | Paste before/after for performance-relevant PRs. |

### Golden outputs

`test/golden/*.json` records the exact output of every case in
`fixtures/golden.ts`: route node ids and edge indices, distance, expected reads,
objective cost, total edge exposure, snapped node ids, corridor waypoints and
field values. `npm test` fails if any of them moves (ids exactly, numbers to a
relative 1e-9).

If your change is *meant* to change routing output:

```bash
npm run golden:update      # rewrites test/golden/ and prints every value that moved
```

Commit the updated files, and in the PR say which outputs moved and why. If you
did not mean to change output, a golden failure is a regression: fix the code,
do not regenerate.

### Property tests

`test/*Properties.test.ts` check invariants on seeded random maps (legal moves,
totals, optimality against an exhaustive search and an independent Dijkstra,
monotonicity in λ and in cost, determinism, the spatial index against brute
force, and more). They are deterministic in CI. A failure prints its seed:

```bash
PROPERTY_SEED=1234 PROPERTY_TRIALS=1 npm test     # replay one failing trial
PROPERTY_TRIALS=2000 PROPERTY_SEED=99 npm test    # search harder before you push
```

A property that fails is a bug or a wrong property; say which in the PR. Do not
loosen a tolerance to make one pass without explaining why the old one was wrong.

### Benchmarks

```bash
npm run bench                  # print the behaviour table, diff against the baseline
npm run bench -- --update      # refresh bench/baseline.json after an intended change
npm run bench:perf             # runtime / memory table (add -- --json for raw numbers)
```

Perf numbers depend on the machine: compare before and after on the same one.

## What a good PR includes

- **A test for the change.** New behaviour gets a test; a bug fix gets a test
  that fails without the fix, in the same commit.
- **Before/after numbers** when it can affect results or speed: the
  `npm run bench` diff, and `npm run bench:perf` before and after for anything
  touching the search, the field or graph assembly.
- **An explanation of every routing-output change.** A change to a route, a
  cost or an exposure value must be intentional: list what moved (the
  `golden:update` and `bench` output) and why. "Feels better" is not evidence.
  A change that alters behaviour with no movement in any golden or bench number
  is either mislabelled or missing a case; add one.

Adding a scenario is a welcome PR on its own: if the router does something wrong
and nothing catches it, add a case to `fixtures/golden.ts` or a bench scenario
to `fixtures/` and the matching recorded output.

## The rules

1. **A behaviour change lands with its diff** (golden and bench), as above.
2. **`src/` stays pure.** No `fetch`, no `fs`, no `Date.now()` in `src/`: the
   engine runs under `node --test` with no bundler, and that is load-bearing.
   Fixtures, tests and benches may read files; the engine may not.
3. **Framing discipline (below) applies to code, comments, tests, PR titles,
   commit messages and issues.** It is enforced in review.
4. **The maintainer vets and merges. There is no auto-merge.** Every
   contributor is credited. A correct but off-scope PR may be declined with an
   explanation.

Keep commits focused: a routing change and a refactor in one commit are hard to
bisect.

## Framing discipline

This library models **exposure to fixed public equipment** for awareness and
transparency. It is not an evasion tool, and the language everywhere in the
project has to reflect that: not as decoration, but because framing is what
keeps the work legitimate.

**Write:** "exposure", "expected reads", "the route's integral of the field",
"within a sensor's field of view", "publicly reported sensor", "accounts for
which way each sensor faces".

**Do not write:** anything about slipping past, beating, defeating, evading, or
going undetected by a sensor or law enforcement; anything about not getting
caught. A PR whose description, comments or test names use that framing will be
asked to reword before it is reviewed on the merits, even if the code is fine.

If the *only* natural description of a proposal is an evasion framing, it is
probably out of scope for this library.

Small PRs get reviewed fastest. Thank you for contributing.
