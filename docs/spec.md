# meatless-proxy spec

meatless-proxy is an AI harness: the runtime that hosts the AI employee defined
in [employee.md](employee.md). It connects the model to the company's people,
systems and tasks.

## Goals

1. **Reduce latency between AIs.** When one AI needs something that another
   AI (or the system behind it) can provide, the two talk directly. The request
   shouldn't wait on a person to carry it across.
2. **Remove humans from steps that don't need them.** People stay in the loop
   for decisions, approvals and judgment. They are removed from steps where all
   they do is relay, copy or reformat what an AI produced.
3. **Reduce round trips.** Fewer back-and-forth exchanges per task: gather the
   needed context up front, ask everything in one go, and resolve as much as
   possible without extra hops.

## Structure

This document is written incrementally. Common harness features come first,
and the features unique to meatless-proxy follow later.

## Common features

_None specified yet._

## Unique features

_None specified yet._
