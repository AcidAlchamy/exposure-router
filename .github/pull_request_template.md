## What this changes

<!-- One or two sentences. -->

## Output diff

<!--
REQUIRED if this changes routing output (a route, a cost, an exposure value,
a snapped node): the cost function, the field model, the drivability weights,
λ handling, graph assembly, snapping or the corridor search.

  npm run golden:update     # prints every golden value that moved
  npm run bench             # prints the bench table and its diff

Paste both below, say why each change is intended, and commit the refreshed
test/golden/ and (via `npm run bench -- --update`) bench/baseline.json.
"Feels better" is not evidence.

If this PR genuinely cannot move any output, say why here instead.
-->

```
paste `npm run golden:update` and `npm run bench` output here
```

## Performance

<!--
For changes to the search, the field or graph assembly: `npm run bench:perf`
before and after, on the same machine. Otherwise delete this section.
-->

## Checklist

- [ ] `npm test` passes (unit, golden-output, property and README tests)
- [ ] `npm run typecheck` passes
- [ ] New behaviour has a test; a bug fix has a test that fails without it
- [ ] `npm run bench -- --check` passes, or the output diff above is pasted and
      `test/golden/` and `bench/baseline.json` are updated in this PR
- [ ] `src/` stays pure — no `fetch`, no `fs`, no `Date.now()` added there
- [ ] Framing discipline (CONTRIBUTING.md): this PR describes the work as
      **exposure modelling**, not as avoiding detection or defeating sensors —
      in the title, the description, the code comments and the test names
