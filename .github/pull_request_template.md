## What this changes

<!-- One or two sentences. -->

## Bench diff

<!--
REQUIRED if this changes routing behaviour (the cost function, the field model,
the drivability weights, λ handling, or graph assembly).

  npm run bench

Paste the before/after table below, then refresh the baseline with
`npm run bench -- --update` and commit it. "Feels better" is not evidence.

If this PR genuinely cannot move any bench number, say why here instead.
-->

```
paste `npm run bench` output here
```

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run bench -- --check` passes, or a bench diff is pasted above and
      `bench/baseline.json` is updated in this PR
- [ ] `src/` stays pure — no `fetch`, no `fs`, no `Date.now()` added there
- [ ] Framing discipline (CONTRIBUTING.md): this PR describes the work as
      **exposure modelling**, not as avoiding detection or defeating sensors —
      in the title, the description, the code comments and the test names
