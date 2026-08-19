# Contributing to exposure-router

Thanks for looking. This is a small, deliberately-scoped library, and the bar
below is what keeps it reviewable by one maintainer.

## The four rules

1. **A behaviour change must land with its bench diff.**
   If your change can alter a route — the cost function, the field model, the
   drivability weights, the λ handling, the graph assembly — run `npm run bench`
   and paste the diff into the PR. Then refresh the baseline with
   `npm run bench -- --update` and commit it. **"Feels better" is not evidence.**
   A reviewer must be able to see exactly what moved and decide whether the trade
   is right. A PR that changes behaviour with no bench movement is either
   mislabelled or missing a scenario — say which.

   Adding a scenario is a welcome kind of PR on its own: if the router does
   something wrong and no existing fixture catches it, the fix is a new fixture
   in `fixtures/` plus a baseline update.

2. **New behaviour needs a test, and `src/` stays pure.**
   The three modules in `src/` have no I/O, no database, no network, no clock —
   they run under `node --test` with no bundler, and that is load-bearing, not
   incidental. Keep it that way: no `fetch`, no `fs`, no `Date.now()` inside
   `src/`. Fixtures and the bench may read files; the engine may not.

3. **Framing discipline (see below) applies to code, comments, tests, PR titles,
   commit messages, and issues.** This is enforced in review.

4. **The maintainer vets and merges. There is no auto-merge.** Every contributor
   is credited. A PR that is correct but off-scope may still be declined with an
   explanation — scope creep is how a readable library becomes an unreadable one.

## Framing discipline

This library models **exposure to fixed public equipment** for awareness and
transparency. It is not an evasion tool, and the language everywhere in the
project has to reflect that — not as decoration, but because framing is what
keeps the work legitimate and the door open for the applications built on it.

**Write:** "exposure", "expected reads", "the route's integral of the field",
"within a sensor's field of view", "publicly reported sensor", "accounts for
which way each sensor faces".

**Do not write:** anything about slipping past, beating, defeating, evading, or
going undetected by a sensor or law enforcement; anything about not getting
caught. A PR whose description, comments, or test names use that framing will be
asked to reword before it can be reviewed on the merits — even if the code is
fine. Keep the same discipline out of issue titles.

If you are proposing something whose *only* natural description is an evasion
framing, it is probably out of scope for this library.

## Practicalities

- `npm test` — unit tests (engine + bench metrics). Must be green.
- `npm run typecheck` — strict TypeScript, `noUncheckedIndexedAccess` on.
- `npm run bench -- --check` — must pass, or the PR must explain the diff and
  ship an updated baseline.
- Keep commits focused; a routing change and a refactor in one commit are hard
  to bisect later.

Small PRs get reviewed fastest. Thank you for contributing.
