import { NotFoundError, ValidationError, type Json } from '@mp/core'
import { checkTimeZone, type ScheduledTask, type ScheduledTaskPatch } from '@mp/events'
import type { ToolContext } from '@mp/tools'
import { fail, ok, str, type Kit } from '../kit.ts'
import { scheduleService, scheduleSummary, type WhenInput } from '../schedules.ts'

const whenProps = {
  at: {
    type: 'string',
    description:
      'Once, at this time: "2026-10-02 16:00" (in timezone), "tomorrow 09:00", "friday 16:00", or ISO with an offset ("2026-10-02T14:00:00Z").',
  },
  in: { type: 'string', description: 'Once, after this delay: "2 hours", "30 minutes", "3 days".' },
  every: {
    type: 'string',
    description:
      'Recurring, in words: "weekday at 09:00", "day at 18:30", "monday, thursday at 9am", "week on friday at 16:00", "month on the 1st at 09:00", "hour", "30 minutes".',
  },
  cron: { type: 'string', description: 'Recurring, as a 5-field cron expression (minute first), e.g. "0 9 * * 1-5".' },
  timezone: {
    type: 'string',
    description: 'IANA time zone the time or schedule is read in, e.g. Europe/Belgrade. Default: the company time zone.',
  },
}

const reportProp = {
  description:
    'Where each run reports: "here" (default: the conversation this run was asked in, or the thread this session owns), "none", {threadId} (a harness chat thread), {channel} (a harness chat channel, name or id) or {subject: {system, id}} (e.g. {system:"slack", id:"C123/1700000000.000100"} for a Slack thread, {system:"slack", id:"C123"} for a channel).',
}

const idProp = { id: { type: 'string', description: 'The task or follow-up id (tsk_…), from schedule.list.' } }

const whenOf = (a: Record<string, unknown>): WhenInput => ({
  ...(a.at !== undefined ? { at: a.at as string } : {}),
  ...(a.in !== undefined ? { in: a.in as string } : {}),
  ...(a.every !== undefined ? { every: a.every as string } : {}),
  ...(a.cron !== undefined ? { cron: a.cron as string } : {}),
})

const hasWhen = (a: Record<string, unknown>) => ['at', 'in', 'every', 'cron'].some((k) => a[k] !== undefined)

export function registerScheduleTools(kit: Kit): void {
  const { deps } = kit
  const svc = () => scheduleService(deps)

  /** One of this employee's tasks (`NotFoundError` for anything else, so nothing leaks). */
  const own = async (id: unknown, ctx: ToolContext): Promise<ScheduledTask> => {
    const v = str(id)
    if (!v) throw new ValidationError('id is required (tsk_…, from schedule.list)')
    const t = await svc().tasks.get(v.trim())
    if (!t || t.data.employeeId !== ctx.employeeId) throw new NotFoundError('scheduled task', v)
    return t
  }

  const view = (t: ScheduledTask) => scheduleSummary(svc().tasks, t, deps.clock.now())

  const timezoneOf = async (a: Record<string, unknown>, fallback?: string) =>
    str(a.timezone) ? checkTimeZone(a.timezone) : (fallback ?? (await svc().defaultTimezone()))

  kit.tool(
    {
      name: 'schedule.create',
      description:
        'Schedule work for later: an instruction you carry out once (at a time, or in a while) or on a schedule, such as a reminder for Friday or "every weekday at 09:00, triage new issues". Give exactly one of at, in, every or cron; times are read in the company time zone unless you give timezone. Each firing starts a run with the instruction in the task\'s own session, which remembers earlier runs (session: "fresh" gives each run a clean one), and reports where report says (by default here, in this conversation). Tell the person what you scheduled. To come back to your current work later, use sessions.follow_up instead. Returns the task with its next run.',
      effect: 'idempotent',
      params: {
        properties: {
          instruction: {
            type: 'string',
            description: 'What to do each time, self-contained: the run starts without this conversation. Include who it is for.',
          },
          ...whenProps,
          report: reportProp,
          session: {
            type: 'string',
            enum: ['continue', 'fresh'],
            description:
              'continue (default): every run in the same session, which remembers the earlier ones. fresh: a clean fork each time.',
          },
          graceSeconds: {
            type: 'number',
            description: 'How late a missed firing (the harness was down) may still run. Default 300, one-offs 3600.',
          },
        },
        required: ['instruction'],
      },
    },
    async (a, ctx) => {
      const instruction = str(a.instruction)
      if (!instruction) return fail('instruction is required: what to do each time')
      const s = svc()
      const timezone = await timezoneOf(a)
      const when = s.resolveWhen(whenOf(a), timezone)
      const report = await s.parseReport(a.report, ctx.runId, ctx.sessionId)
      const output = await kit.once('schedule.create', ctx, async () => {
        const t = await s.create(
          {
            employeeId: ctx.employeeId,
            instruction,
            when,
            timezone,
            ...(ctx.requesterId ? { requesterId: ctx.requesterId } : {}),
            ...(report ? { report } : {}),
            ...(a.session !== undefined ? { sessionMode: a.session } : {}),
            ...(a.graceSeconds !== undefined ? { graceSeconds: a.graceSeconds } : {}),
          },
          kit.actor(ctx),
        )
        return view(t)
      })
      return ok(output)
    },
  )

  kit.tool(
    {
      name: 'schedule.list',
      description:
        'Your scheduled tasks and follow-ups: what, when (in words, with the next run in local time), where they report, and how the last run went. Default: the ones still to come or paused; all: true adds finished one-offs.',
      effect: 'read',
      params: {
        properties: {
          kind: { type: 'string', enum: ['task', 'follow_up'], description: 'Only tasks, or only follow-ups.' },
          all: { type: 'boolean', description: 'Include one-offs that already ran or were missed.' },
          sessionId: { type: 'string', description: 'Only those that run in this session (e.g. its follow-ups).' },
        },
      },
    },
    async (a, ctx) => {
      if (a.kind !== undefined && a.kind !== 'task' && a.kind !== 'follow_up') return fail('kind must be task or follow_up')
      const list = await svc().tasks.list({
        employeeId: ctx.employeeId,
        ...(a.kind ? { kind: a.kind } : {}),
        ...(str(a.sessionId) ? { sessionId: a.sessionId } : {}),
      })
      const shown = a.all === true ? list : list.filter((t) => !t.data.done)
      return ok({ items: shown.slice(0, 100).map(view), total: shown.length })
    },
  )

  kit.tool(
    {
      name: 'schedule.update',
      description:
        'Change one of your scheduled tasks or follow-ups: its instruction (or note), when (one of at, in, every, cron; a new time re-arms a one-off that already ran), timezone, report, or pause and resume it with enabled.',
      effect: 'idempotent',
      params: {
        properties: {
          ...idProp,
          instruction: { type: 'string' },
          ...whenProps,
          report: reportProp,
          enabled: { type: 'boolean', description: 'false pauses it; true resumes it (slots missed meanwhile are skipped).' },
          session: { type: 'string', enum: ['continue', 'fresh'] },
        },
        required: ['id'],
      },
    },
    async (a, ctx) => {
      const t = await own(a.id, ctx)
      const s = svc()
      const patch: ScheduledTaskPatch = {}
      if (a.instruction !== undefined) {
        if (!str(a.instruction)) return fail('instruction must not be empty')
        patch.instruction = a.instruction
      }
      const timezone = str(a.timezone) ? await timezoneOf(a) : t.data.timezone
      if (str(a.timezone)) patch.timezone = timezone
      if (hasWhen(a)) patch.when = s.resolveWhen(whenOf(a), timezone)
      if (a.report !== undefined) patch.report = (await s.parseReport(a.report, ctx.runId, ctx.sessionId)) ?? null
      if (a.enabled !== undefined) {
        if (typeof a.enabled !== 'boolean') return fail('enabled must be true or false')
        patch.enabled = a.enabled
      }
      if (a.session !== undefined) patch.sessionMode = a.session
      if (!Object.keys(patch).length) return fail('nothing to change: give instruction, a time, timezone, report or enabled')
      return ok(view(await s.update(t.id, patch, kit.actor(ctx))))
    },
  )

  kit.tool(
    {
      name: 'schedule.cancel',
      description: 'Delete one of your scheduled tasks or follow-ups: it never fires again. Runs already going are not stopped.',
      effect: 'idempotent',
      params: { properties: idProp, required: ['id'] },
    },
    async (a, ctx) => {
      const t = await own(a.id, ctx)
      await svc().cancel(t.id, kit.actor(ctx))
      return ok({ cancelled: t.id, kind: t.data.kind, instruction: t.data.instruction.slice(0, 200) })
    },
  )

  kit.tool(
    {
      name: 'schedule.run_now',
      description:
        "Run one of your scheduled tasks now, outside its schedule (its schedule stays; a one-off counts as done). The run starts in the task's session and reports where the task does.",
      effect: 'idempotent',
      params: { properties: idProp, required: ['id'] },
    },
    async (a, ctx) => {
      const t = await own(a.id, ctx)
      if (t.data.kind !== 'task')
        return fail('a follow-up comes back to its session on its own; change its time with schedule.update')
      const output = await kit.once('schedule.run_now', ctx, async () => {
        const r = await svc().runNow(t.id, { key: ctx.idempotencyKey })
        return { ...view(r.task), eventId: r.eventId } as Json
      })
      return ok(output)
    },
  )

  kit.tool(
    {
      name: 'sessions.follow_up',
      description:
        'Come back to this session later with a note, e.g. "check CI on !42" or "poke the reviewer if there is no answer", without waiting: you can finish this run now. At the time, this session gets a new run with your note (or the note arrives in its run, if one is going). If what you were waiting for happens first, the note still comes: check, and end without doing anything if it is no longer needed (or cancel it with schedule.cancel). Give in or at.',
      effect: 'idempotent',
      params: {
        properties: {
          note: { type: 'string', description: 'What to do or check then, with what you need to know.' },
          in: whenProps.in,
          at: whenProps.at,
          timezone: whenProps.timezone,
        },
        required: ['note'],
      },
    },
    async (a, ctx) => {
      const note = str(a.note)
      if (!note) return fail('note is required: what to do or check then')
      if (a.every !== undefined || a.cron !== undefined) return fail('a follow-up happens once: give in or at')
      const s = svc()
      const timezone = await timezoneOf(a)
      const when = s.resolveWhen(whenOf(a), timezone)
      const output = await kit.once('sessions.follow_up', ctx, async () => {
        const t = await s.followUp(
          {
            employeeId: ctx.employeeId,
            sessionId: ctx.sessionId,
            note,
            when,
            timezone,
            ...(ctx.requesterId ? { requesterId: ctx.requesterId } : {}),
          },
          kit.actor(ctx),
        )
        const v = view(t)
        return { followUpId: t.id, at: v.nextRun ?? null, local: v.nextRunLocal ?? null, note: t.data.instruction }
      })
      return ok(output)
    },
  )
}
