# Context benchmark

The evidence behind [CONTEXT.md](../CONTEXT.md): every round of the context
benchmark, in order, with what each one changed. CONTEXT.md keeps the current
result; this page keeps how we got there, including where classic compaction
won. Findings a later round overturned are marked superseded, not removed.

## The setup

`npm run bench:context` ([packages/evals](../packages/evals/README.md#the-context-benchmark))
runs one long task under different strategies, with the same model, archive
and window. The task: read a paged incident archive (20 pages, about 206k
characters, roughly three times the window) one page at a time, then report
the audit reference from page 1 and the 12 incidents whose final severity is
SEV1 (corrections on later pages change four of them), each with its exact
root-cause location and on-call engineer. Afterwards, the same session gets a
**follow-up** about details of a minor incident on page 3 that nobody asked
for before (its ticket and deploy id).

| arm | strategy |
|-----|----------|
| `classic` | classic compaction: at 85% everything is summarised; no notes, no context tools (and no note at a new request: turned off explicitly since `b5597bc`; no earlier run of classic got one) |
| `safety-net` | our automatic compaction alone: at 85%, keeping the latest 15% verbatim |
| `managed-early` | everything, with notes at 50% and 75% (the default before the benchmark) |
| `managed` | everything, as deployed: a note at 70%, the free-space turn at 80%, the context tools (`sessions.rewind`, `offload`, `restore`, `compact`, `contents`, `search`¹), compaction at 85% |

¹ Rounds one and two ran without `sessions.search`. The note at a request
boundary came after the third round (`bfed127`); it fires only when there is
more than one request, so the single-request rounds wouldn't have used it.

A **fresh session** baseline asks the same follow-up of a new session that
starts from zero, as the cost of not asking the session that already read the
archive.

## First results (2026-10-13)

Claude Sonnet 5.5, a 64k window, three runs per arm. Figures are medians,
with the range when the runs differ. **Billed-equivalent** weighs tokens by
price, in uncached input tokens: cached reads ×0.1, output ×5. Cache writes
(×1.25) aren't reported by the provider, so billed-equivalent is a lower
bound.

| arm | report correct | prompt tokens | cached | billed-equivalent | collapses | restores | time | follow-up right | follow-up billed |
|-----|----------------|---------------|--------|-------------------|-----------|----------|------|-----------------|------------------|
| classic | 12/12 (3/3 runs) | 657k | 65% | 308k | 0 | 0 | 64 s | 3/3 | 30k |
| safety-net | 12/12 (3/3) | 684k | 67% | 311k | 0 | 0 | 66 s | 3/3 | 35k |
| managed-early | 12/12 (3/3) | 818k (743k–826k) | 62% | 418k (371k–420k) | 6 | 10 | 105 s | 3/3 | 65k (38k–269k) |

**Classic compaction wins this task**, by about a third on billed cost.
Everything the report needs is twelve short lines, so any summary keeps it,
and the archive can be read again, so the follow-up costs three page reads.
What we saw in the managed-early arm (round one's only managed arm):

- **It collapses too early and too often.** A page is about 5.5k tokens, so
  five pages fill about 45% of the window. The 50% note suggests collapsing
  them; the collapse drops the context by more than the 15-point re-arm
  margin, which arms the 50% note again, and the cycle repeats. Each collapse
  costs output (the summary) and a context the cache hasn't seen.
- **It distrusts its own summaries.** In two of three runs, after a few
  collapses, the model listed what it had collapsed and read entries back one
  by one. The task asks for exact values and later pages carry corrections,
  and a free-form summary doesn't say whether it kept everything exactly.
- **The follow-up was answered from its own history** in two runs (three or
  five restores). In the third, the model didn't know which collapsed stretch
  held page 3, so it read 16 pages again (269k billed).

## What changed after the first round

- **Collapse summaries carry an index.** The harness appends one line per
  replaced tool call, with its arguments and the entry holding its result
  (`- archive.read_page {"page":3,…} → entry ent_… (≈5.5k tokens)`), so a
  later question reads back the one result it needs.
- **The summary is authoritative.** The tool asks for exact values copied
  verbatim, and its result says the summary now stands for the stretch: rely
  on it, and read entries back only for a detail it lacks.
- **Restores show their cost** ("adds about 5.5k tokens to your context").
- **Fewer notes:** the `managed` arm has a single note at 70%
  (`CONTEXT_NOTES=70`, now the default); `managed-early` keeps 50% and 75%.
- **A one-time source** (`--source feed`): each page can be read once, so a
  follow-up can only be answered from the session's own history, and a
  **fresh session** baseline asks the same follow-up from zero.

## Second round (2026-10-13)

The same task, with the collapse index, authoritative summaries and restore
costs, and with the `managed` arm (one note at 70%) next to `managed-early`.
On the **archive**,
pages can be read again; on the **feed**, each page can be read once, so the
follow-up (the ticket and deploy id of a minor incident on page 3) can only
be answered from what the session kept.

Follow-up figures count only runs that finished; a run the harness failed is
counted on its own, not as a wrong answer.

| source | arm | report correct | calls | billed-equivalent | collapses | restores | time | follow-up right | follow-up billed | harness failures | fresh session |
|--------|-----|----------------|-------|-------------------|-----------|----------|------|-----------------|------------------|------------------|---------------|
| archive | classic | 12/12 (3/3 runs) | 23 | 310k | 0 | 0 | 70 s | 3/3 | 30k | 0 | 3/3, 27k |
| archive | safety-net | 12/12 (3/3) | 23 | 311k | 0 | 0 | 69 s | 3/3 | 34k | 0 | 3/3, 27k |
| archive | managed | 12/12 (3/3) | 21 | **265k** | 2 | 0 | 57 s | 2/2 | 159k (104k–215k) | 1 | 3/3, 29k |
| archive | managed-early | 12/12 (3/3) | 29 | 410k (355k–431k) | 5 | 0 | 102 s | 3/3 | 126k (48k–221k) | 0 | 3/3, 28k |
| feed | classic | 12/12 (3/3) | 23 | 306k | 0 | 0 | 88 s | **0/3, all abstained** | 4k | 0 | can't: pages consumed |
| feed | safety-net | 12/12 (3/3) | 23 | 316k | 0 | 0 | 72 s | **0/3, all abstained** | 5k | 0 | can't: pages consumed |
| feed | managed | 12/12 (3/3) | 21 | **267k** | 2 | 0 | 56 s | 2/2 | 65k (42k–87k) | 1 | can't: pages consumed |
| feed | managed-early | 12/12 (3/3) | 27 | 401k (267k–456k) | 6 | 10 | 108 s | **3/3** | 64k (40k–183k) | 0 | can't: pages consumed |

- **One late note beats two early ones.** With a single note at 70%, the
  model collapses twice, in big pieces, never restores, and never reaches
  compaction: **15% cheaper than classic compaction** on billed cost, and
  faster. `managed-early` still churns: on the feed it read back 10 and 12
  collapsed entries during the report in two of three runs (0 in the third),
  as in the first round, so it's a habit of that arm, not one bad run.
  `CONTEXT_NOTES` now defaults to 70.
- **Detail that can't be read again is where classic compaction fails.** On
  the feed, classic and safety-net answered the follow-up wrong in all six
  runs: the summary had no reason to keep a minor incident's ticket, and
  nothing else held it. They failed honestly: every one of the six answers
  said the details weren't in its notes and that it wouldn't guess, none
  invented a ticket. Both managed arms answered from their own history.
- *(Superseded in round three, with `sessions.search`.)* **A fresh session is the cheapest way to answer a targeted lookup when the
  source can be read again.** On the archive, a new session answered the
  follow-up for 27–29k, less than every arm: classic's re-read (30k), and
  far less than the managed arms answering from history (126k–159k). A new
  session has a small context, finds the incident in three page reads, and
  stops; a long session pays for its whole context on every call, cached or
  not. So "ask the session that knows" (above) doesn't hold for this case.
  What the data supports so far: the dense session wins when the detail
  **can't** be read again (the feed, where a fresh session can't answer at
  all, and classic abstained), not as a cheaper lookup.
- *(Superseded in round three, with `sessions.search`.)* **Answering from history still costs more than re-reading** when
  re-reading is possible. The question names an incident, not a page, and an
  index of arguments (`read_page {page: 3}`) doesn't say where the incident
  is, so the model browsed `sessions.contents` and restored page after page.
  The benchmark also left out `sessions.search`, which the deployed toolset
  has. Fixed since: the context tools include `sessions.search`, which
  searches the session's own history, collapsed parts included, and each hit
  comes with a ready `restore { entryId, offset, length }` that reads the
  text around the match.
- **Two harness failures:** a `managed` follow-up run failed right after a
  `sessions.rewind` that reached back into the earlier run (archive), and
  another before its first model call (feed). They're harness errors, not
  model ones; the benchmark now records the error and the app's warnings so
  they can be fixed. The archive `managed` follow-up figure is over the two
  runs that finished.

## Third round: scaling the facts (2026-10-14)

The same 20 pages, with more facts the report has to keep exactly: 12, 40, 80
and 150 SEV1 incidents. After the report, **five follow-ups by id** (minor
incidents on pages spread across the archive) and **three fuzzy follow-ups**
(an incident described in other words, without its id: "the media-cdn
incident where background jobs piled up and stopped moving, because two cache
entries ended up with the same key"). Every run at commit `ddf1143`, with
`sessions.search` and the 70% note. Three runs per arm and size; medians.

| facts | arm | report correct | prompt tokens | billed-equivalent | compactions | collapses | time | 5 follow-ups by id, billed | 3 fuzzy, right, billed |
|-------|-----|----------------|---------------|-------------------|-------------|-----------|------|----------------------------|------------------------|
| 12 | classic | 12/12 (3/3 runs) | 656k | 312k | 2 | 0 | 69 s | 15/15, 276k | 9/9, 322k |
| 12 | managed | 12/12 (3/3) | 659k | **270k** (−13%) | 0 | 3 | 56 s | 15/15, **22k** | 6/9¹, 233k |
| 40 | classic | 40/40 in 2 runs, 39/40 in 1² | 983k | 478k | 3 | 0 | 116 s | 15/15, 282k | 9/9, 327k |
| 40 | managed | 40/40 (3/3) | 644k | **273k** (−43%) | 0 | 3 | 81 s | 15/15, **30k** | 9/9, 271k |
| 80 | classic | 80/80 (3/3) | 1009k | 522k | 3 | 0 | 156 s | 15/15, 270k | 9/9, 297k |
| 80 | managed | 80/80 (3/3) | 692k | **313k** (−40%) | 0 | 4 | 104 s | 15/15, **48k** | 9/9, 285k |
| 150 | classic | 150/150 (3/3) | 1360k | 755k | 4 | 0 | 264 s | 15/15, 291k | 9/9, 290k |
| 150 | managed | 150/150 (3/3) | 703k | **325k** (−57%) | 0 | 5 | 127 s | 15/15, **62k** | 9/9, 435k |

A **fresh session** answering the same five follow-ups from zero: 30/30 right,
278–281k billed at every size (range 254k–303k, about 15% run to run: the
noise floor for the other comparisons).

¹ One run lost the question: it collapsed a stretch that included the fuzzy
question itself, then answered with its earlier report. Fixed since: a request made in the current run is
kept word for word after a collapse that covers it.
² One run lost an incident a correction on page 16 upgraded to SEV1: its
record was on an early page, and the summary had no reason to keep a minor
incident. The model said so ("its original record is not in the archive, so
I have no file:line or on-call"), and left it out.

- **The managed report costs about the same at any size; classic's grows.**
  Managed: 270k → 325k from 12 to 150 facts. Classic: 312k → 755k. Classic
  re-summarises everything at each compaction, and its summaries grow with
  the facts (about 3.5k tokens each at 12 facts, 5.5k at 80, 7.3k at 150, just
  under the 8,000-token cap), so each compaction costs more and comes sooner.
  At 150 it needed a fourth. The gap is 40–43% at 40–80 facts and 57% at 150.
- **Classic lost what became relevant late.** At 40 facts, a correction on
  page 16 upgraded an incident to SEV1 whose record was on an early page.
  Classic's summary had no reason to keep a minor incident, so by then its
  location and engineer were gone; the model said so ("its original record
  is not in the archive, so I have no file:line or on-call") and left it
  out. Managed, whose original entries stay findable, never lost one. That's
  the failure people meet in practice: a detail that looked unimportant when
  it was summarised turns out to matter, inside the main task, not in a
  follow-up.
- **Otherwise classic stays accurate, and pays for it.** 150 facts was close
  to its limit: summaries of about 7.3k of the 8,000 tokens the summary call
  may write. That commit (`ddf1143`) didn't have the retry for a cut-off
  summary yet (it came in `bfed127`), and none was cut: every classic report
  at 150 facts had all 150.
- **Lookups by id: the session that read everything is the cheapest.** 22–62k
  for five follow-ups, against 270–291k for classic (which re-reads) and
  278–281k for a fresh session. `sessions.search` is what changed: in round
  two, without it, one follow-up cost the same arm 159k.
- **Fuzzy lookups are even, not won.** Both arms got 9/9 from 40 facts on;
  managed was cheaper up to 80 facts and dearer at 150 (435k vs 290k).
  Without the id, search had to match the record's own words, and the
  description used others; the model fell back to restoring or re-reading
  pages. Fixed since: a search that finds no entry with every word ranks
  entries by how many of the words they have, and its ready read starts where
  they come together. Not measured yet.

## Chains of tasks (2026-10-14)

Five tasks in one session (`--chain 5`), each auditing its own five pages of
a 25-page archive, and from the second on asked about an incident from the
task before. Commit `bfed127`, three runs per arm.

| task | classic billed | managed billed | classic context at end | managed context at end |
|------|----------------|----------------|------------------------|------------------------|
| 1 | 47k | 51k | 33k | 36k |
| 2 | 113k | 115k | 12k | 38k |
| 3 | 144k | 141k | 7k | 25k |
| 4 | 161k | 87k | 29k | 55k |
| 5 | 163k | 134k | 28k | 39k |

Every task right in both arms, the questions about earlier tasks included.
Managed is **16% cheaper over the chain** (about 528k against 628k), but the
gap doesn't grow with the number of tasks. On this shape classic's single
compaction per task acts like a collapse of the finished task: the tasks
share one fact each, so its summary stays small. The note at a new request
didn't lead to a collapse at the boundary; the model carried on into the
70% and 80% notes. *(Corrected below: the note never fired in this round. A
new run estimated its context at the default 3.5 characters a token, and
these pages run about 1.9, so the finished task looked half its size.)* A
chain whose tasks build on each other is still to test.

## Instructions during the work (2026-10-14)

`--instructions`: while the report (40 facts) is written, the person sends a
constraint after page 4 ("leave out every billing-worker incident, those go
to a separate review") and after page 12 a correction that doesn't name the
service again ("keep those after all, marked (review)"). Commit `a540240`.

| commit | arm | instructions followed | report correct | billed-equivalent | compactions | collapses | time |
|--------|-----|-----------------------|----------------|-------------------|-------------|-----------|------|
| `a540240` | classic | 3/3 runs | 40/40 (3/3) | 496k | 3 | 0 | 141 s |
| `a540240` | managed | 3/3 runs | 40/40 (3/3) | 555k | 2–3 | 0 | 147 s |
| `47bc622` | classic | 3/3 runs | 40/40 (3/3) | 488k | 3 | 0 | 130 s |
| `47bc622` | managed | 3/3 runs | 40/40 (3/3) | **340k** (−30%) | 0 | 2 | 88 s |

- **Classic kept both instructions** through its compactions: its summary
  prompt asks for decisions and who asked, and it carried the constraint
  and the correction.
- **Managed couldn't collapse at all**, and paid more for it. Its rewind at
  80% covered the person's constraint, and the harness refused a collapse
  that would replace a request made in the run. The model didn't try again
  around it, so automatic compaction took over.
- **Fixed, and measured** (`47bc622`): a request made in the run is kept
  word for word right after the summary, and the collapse goes ahead.
  Managed then followed both instructions in every run, never needed a
  compaction, and was **30% cheaper** and a third faster than classic.

## Lookups in other words, with the search fallback (2026-10-14)

40 facts, five lookups by id and three fuzzy ones, at commit `27654a4`: the
search that ranks entries by their best passage when none has every word.

| arm | report correct | report billed | 5 by id | 3 fuzzy |
|-----|----------------|---------------|---------|---------|
| classic | 40/40 (3/3 runs) | 481k | 15/15, 290k, re-read the archive in 3/3 runs | 9/9, 319k |
| managed | 40/40 (3/3) | **271k** (−44%) | 15/15, **36k**, re-read in 0/3 | 9/9, **275k** (225k–483k) |

A fresh session answering the five by id: 30/30, 281k.

- **Fuzzy lookups are right, and a little cheaper than classic, but not
  targeted.** The same arm cost a median 636k before passage ranking; now
  275k. It still restored 17–25 entries per run (one run re-read 17 pages),
  because matching words can't tell that "background jobs piled up" is "stuck
  jobs in the queue". Lookups by id stay cheap: an exact string is word
  matching's best case. Closing the gap for questions in other words needs
  search by meaning (embeddings), not done.

## Lookups in other words, with query expansion and keywords (2026-10-14)

Two cheap steps before search by meaning: `sessions.search`'s description
asks for a few short queries, one idea each, with the words the material
would use and their synonyms, instead of one long phrase; and collapse and
compaction summaries end with a `Keywords:` line of the words a later
question might use. The examples in the prompts are unrelated to the
benchmark's questions. 40 facts, commit `b5597bc`.

| arm | report correct | report billed | 5 by id | 3 fuzzy | fuzzy restores per run |
|-----|----------------|---------------|---------|---------|------------------------|
| classic | 40/40 in 1 run, 39/40 in 2 | 346k | 15/15, 297k, re-read in 3/3 | 9/9, 327k | 0 (re-reads 18–20 pages) |
| managed | 40/40 (3/3) | **302k** (−13%) | 15/15, **23k**, re-read in 0/3 | 8/9 (1 abstained), **257k** (247k–411k) | 8–17 |

- **Fewer restores, not few.** 8–17 restores per fuzzy run, against 17–25
  before; one run also re-read 10 pages. Cost fell a little (257k against
  275k), within the noise of three runs.
- **One abstention.** The model searched with the archive's own words
  ("5xx", "missing index") and still concluded the record wasn't there, and
  said so rather than guessing. A miss with the right words means the gap is
  not only paraphrase: how the model reads hits matters too.
- **Classic lost facts again**: 39/40 in two of three runs, the same
  late-correction loss as round three. The report gap is smaller this time
  (−13%, against −44% in the previous round), because classic needed two
  compactions instead of three. Run-to-run noise on the report is large.

Verdict: query expansion and keywords helped some, but didn't make lookups
in other words targeted. Search by meaning is still the open step.

## Chains, with the collapse at a new request (2026-10-14)

The same five-task chain (`--chain 5`), three runs per arm, after two fixes:

1. **The note fires** (`b969e3b`): a run sizes its context with the previous
   run's measured tokens per character until its own first call.
2. **The harness collapses what the model keeps** (`5898b42`): finished
   requests a note named that are still there after the model's next turn
   are collapsed by the harness, in one stretch. Each request and the final
   reply to it stay word for word after the summary, and the work becomes an
   index.

| commit | arm | chain billed (median, range) | compactions per run | collapses at a boundary | earlier-task questions |
|--------|-----|------------------------------|---------------------|-------------------------|------------------------|
| `bfed127` (round above) | classic | 629k (534k–911k) | 3–6 | – | 12/12 |
| `bfed127` | managed | 528k (520k–551k) | 2–3 | 0 | 12/12 |
| `b969e3b` (note fires) | classic | 378k (373k–504k) | 2–3 | – | 8/12 |
| `b969e3b` | managed | 523k (475k–540k) | 1–2 | 0 | 12/12 |
| `5898b42` (harness collapses) | classic | 507k (504k–809k) | 3–5 | – | 12/12 |
| `5898b42` | managed | **383k** (381k–384k) | **0** | **4 of 4** | 12/12 |

Per task at `5898b42` (medians):

| task | classic billed | managed billed | classic context at end | managed context at end |
|------|----------------|----------------|------------------------|------------------------|
| 1 | 46k | 47k | 33k | 36k |
| 2 | 116k | 83k | 12k | 39k |
| 3 | 146k | 82k | 7k | 40k |
| 4 | 80k | 84k | 51k | 41k |
| 5 | 122k | 87k | 35k | 42k |

- **A note alone made it worse.** With the note firing (`b969e3b`), the
  model read it and went on with the new task. At 80% it collapsed its
  current reads, folding the earlier task in with them, or compaction did.
  That costs more than classic, which compacts once and moves on.
- **The harness collapse made it flat.** At every boundary the finished task
  went from about 41–47k to 17–20k of context, after one turn. No compaction
  in any run, no collapse by the model, and the same cost per task from the
  second on (82–87k). Its context grows by about 1k per task: the request
  and reply kept word for word. Managed is **24% cheaper** over the chain
  (383k against 507k), and its three runs are within 3k of each other, while
  classic's range is 504k–809k.
- **Earlier detail was found, not kept.** Each task's question about the
  task before (a minor incident's engineer and ticket, never in a reply) was
  answered with one `sessions.search` and one `sessions.restore`, right in
  all 12.
- **Classic's 8/12 at `b969e3b`**: four questions whose summary didn't keep
  the earlier minor incident; at `5898b42` it got all 12. Which details a
  summary keeps varies from run to run.

The tasks still barely depend on each other. A chain whose tasks build on
each other's results is the next test, now that the boundary collapse runs.
