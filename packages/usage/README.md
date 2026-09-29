# @mp/usage

The usage ledger (`usage`, `use_`: one record per model call), configurable limits (`limit`, `lim_`) and budget checks.

## API

`createUsage({ records, clock, pricing?, bus? })` returns:

- `record(input)`: stores a call; `totalTokens` defaults to prompt + completion, `costUsd` comes from `pricing[model]`
  (`inputPerM`, `outputPerM`, `cachedInputPerM`; unknown models cost 0), `at` from the clock. Publishes `usage.recorded`.
- `cost(model, tokens)`, `totals(filter)` (`{ promptTokens, completionTokens, cachedTokens, reasoningTokens, totalTokens, costUsd, calls }`;
  filter by run, session, root session, employee, requester, template, procedure, project, model, `since`, `until`),
  `breakdown(groupBy, filter)` (employee, session, tree, model, requester, run, template, procedure, project, day).
- `limits`: `set` (upsert by target + period, or by `id`), `get`, `list`, `remove`, `matching(ctx)`, `effective(ctx)` (tightest
  value of each field; budgets per period). A target without an id applies to every one of its type.
- `checkBudget(ctx)`: `{ ok: true }` or the first budget reached with `reason`, `field`, `period`, `limit`, `used`. Periods:
  `run`, `session`, `tree` (totals of that run/session/tree), `day`/`month` (the employee's totals since the start of the
  UTC day/month). Without a period, a budget is per run (per session/tree for session/tree targets).
- Pure helpers: `checkForkLimits({ depth, fanOut, runningSessions, limits })` (values the new state would have; allowed up
  to the limit), `mergeLimits`, `limitApplies`, `startOfUtcDay`, `startOfUtcMonth`.

## Tests

`test/usage.test.ts` with `memoryStore()` and `ManualClock`: pricing, totals, breakdowns, limit merging, run/session/tree/day/month budgets.

## Replacing it

Same `UsageService` interface and kinds.
