# @mp/usage

The usage ledger (`usage`, `use_`: one record per model call), configurable limits (`limit`, `lim_`), budget checks and
pricing.

## API

`createUsage({ records, clock, pricing?, defaults?, bus? })` returns:

- `record(input)`: stores a call; `totalTokens` defaults to prompt + completion, `costUsd` comes from the pricing
  (`inputPerM`, `outputPerM`, `cachedInputPerM`; unknown models cost 0), `at` from the clock. Publishes `usage.recorded`.
- `cost(model, tokens)`, `priceOf(model)`, `totals(filter)` (`{ promptTokens, completionTokens, cachedTokens,
  reasoningTokens, totalTokens, costUsd, calls }`; filter by run, session, root session, employee, requester, template,
  procedure, project, model, `since`, `until`), `breakdown(groupBy, filter)` (employee, session, tree, model, requester,
  run, template, procedure, project, day).
- `limits`: `set` (upsert by target + period, or by `id`), `get`, `list`, `remove`, `matching(ctx)`, `defaults()`,
  `effective(ctx)`.
- `budgetStatus(ctx)`: every budget that applies with what has been used, in check order.
- `checkBudget(ctx)`: `{ ok: true }` or the first budget reached with `reason` ("the employee's daily token budget is
  used up: 5,000,120 of 5,000,000 tokens today (it resets at 00:00 UTC)"), `field`, `period`, `scope`, `source` (a limit
  id or `default`), `max`, `used`.
- Pure helpers: `mergeLimits(limits, defaults)`, `checkForkLimits({ depth, fanOut, runningSessions, limits })` (values the
  new state would have; allowed up to the limit), `limitApplies`, `specificity`, `budgetKey`, `describeBudget`,
  `startOfUtcDay`, `startOfUtcMonth`.
- Pricing (`src/pricing.ts`): `BUILTIN_PRICING` (only prices checked on the providers' official pages, each with its
  source URL and date), `priceFor(model, ...tables)` (the first table with the model, by exact name, then loosely: case,
  a `vendor/` prefix and `.` versus `-` are ignored, so `kimi-k2-7-code` finds `kimi-k2.7-code`), `normalizeModel`,
  `checkPricing(value)`.

`pricing` and `defaults` may be values or functions (called on every use), so they can change at runtime.

## Limits

- **Defaults** (`LimitDefaults`): caps (`maxDepth`, `maxFanOut`, `maxConcurrentSessions` = runs working at once per
  employee, `maxSteps`, `maxWallMs`, `maxAiStreak`), `budgets` (`{ target, period, maxTokens?, maxCostUsd? }`, e.g. 5M
  tokens per employee per day) and `warnAt` (the share at which a warning is due). The server builds them from its
  environment.
- **Limit records** override the defaults for their target: `global` (the whole deployment), `employee`, `contact`
  (the requester), `template`, `procedure`, `session`, `tree`. A target without an id covers every one of its type.
  For each field the most specific matching record wins (session, tree, procedure, template, contact, employee,
  global; one naming an id beats one for every one of its type), else the default. `null` means "no limit" and lifts a
  default.
- **Budgets** are per key: `run`, `session`, `tree` (totals of that run, session or tree), or `day`/`month` of the
  target (`day:employee` is each employee's usage since 00:00 UTC, `day:contact` each requester's, `day:global` the
  whole deployment's). Without a period a budget is per run (per day for a contact, per session/tree for those targets).
  `checkBudget` checks them in this order: run, session, tree, then day and month budgets from the narrowest scope to
  the requester, the employee and the whole deployment.

## Tests

`test/usage.test.ts` with `memoryStore()` and `ManualClock`: pricing (the built-in table, loose names, overrides, table
validation), totals, breakdowns, limit merging (most specific wins, defaults with no records, `null` overrides),
run/session/tree/day/month budgets, per-requester and deployment budgets and their order.

## Replacing it

Same `UsageService` interface and kinds.
