import { type ProjectData, SKILL_TEMPLATE, type SkillScope, parseSkillMarkdown } from '@mp/api'
import { FileUp } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Field, Segmented, errorText } from '@/components/knowledge-ui.tsx'
import { selectClass } from '@/components/start-form.tsx'
import { StepsEditor } from '@/components/steps-editor.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'

/** The scope picker: every employee's work, or one project's. */
export function ScopePicker({ value, onChange, id }: { value: SkillScope; onChange(next: SkillScope): void; id?: string }) {
  const projects = useLoad((a) => a.listRecords<ProjectData>('project', { orderBy: 'name', dir: 'asc', limit: 200 }), [])
  const list = projects.data?.items ?? []
  return (
    <div className="flex flex-col gap-2">
      <Segmented
        label="Where it applies"
        value={value.type}
        onChange={(type) =>
          onChange(
            type === 'company'
              ? { type }
              : { type, ...(value.projectId || list[0] ? { projectId: value.projectId ?? list[0]!.id } : {}) },
          )
        }
        options={[
          { value: 'company', label: 'Company-wide', hint: 'Every employee can load it, in any work.' },
          {
            value: 'project',
            label: 'One project',
            hint: 'Offered only in work on that project. A project skill with the same name as a company one replaces it there.',
          },
        ]}
      />
      {value.type === 'project' && (
        <select
          id={id}
          aria-label="Project"
          value={value.projectId ?? ''}
          onChange={(e) => onChange({ type: 'project', projectId: e.target.value })}
          className={selectClass}
        >
          {!value.projectId && <option value="">Pick a project</option>}
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.data.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/**
 * "New skill" (and "Import SKILL.md"): name, what it's for, when to use it, where it applies, and
 * its instructions from a template, with a live preview. Import reads a pasted or uploaded
 * `SKILL.md` into the same form, to check before saving. Opens the new skill when done.
 */
export function NewSkillDialog({
  open,
  onOpenChange,
  importing = false,
  initial,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  /** Start with the SKILL.md box. */
  importing?: boolean
  initial?: { name: string; description: string; whenToUse?: string; body: string; scope?: SkillScope }
}) {
  const api = useApi()
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [whenToUse, setWhenToUse] = useState('')
  const [scope, setScope] = useState<SkillScope>({ type: 'company' })
  const [body, setBody] = useState(SKILL_TEMPLATE)
  const [paste, setPaste] = useState('')
  const [showImport, setShowImport] = useState(importing)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: 'name' | 'description' | 'scope' | 'form' | 'import'; message: string } | null>(
    null,
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when it opens
  useEffect(() => {
    if (!open) return
    setName(initial ? `${initial.name}-copy` : '')
    setDescription(initial?.description ?? '')
    setWhenToUse(initial?.whenToUse ?? '')
    setScope(initial?.scope ?? { type: 'company' })
    setBody(initial?.body ?? SKILL_TEMPLATE)
    setPaste('')
    setShowImport(importing)
    setError(null)
  }, [open])

  const readSkill = (text: string) => {
    const p = parseSkillMarkdown(text)
    if (!p.body.trim()) return setError({ field: 'import', message: "That file is empty: paste a SKILL.md's text." })
    setName(p.name)
    setDescription(p.description)
    setWhenToUse(p.whenToUse)
    setBody(p.body)
    setShowImport(false)
    setError(null)
    toast('Read the SKILL.md', { description: 'Check the fields, pick where it applies, then save.' })
  }

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy) return
    if (!name.trim()) return setError({ field: 'name', message: 'Give it a short name, e.g. cut-release.' })
    if (!description.trim()) return setError({ field: 'description', message: 'Say in one line what it helps with.' })
    if (scope.type === 'project' && !scope.projectId) return setError({ field: 'scope', message: 'Pick the project.' })
    setBusy(true)
    setError(null)
    try {
      const k = await api.createSkill({
        name: name.trim(),
        description: description.trim(),
        ...(whenToUse.trim() ? { whenToUse: whenToUse.trim() } : {}),
        body,
        scope,
      })
      toast(`${k.skill.data.name} is ready`, { description: 'Employees see it in their skill list from their next step.' })
      onOpenChange(false)
      navigate(`/skills/${k.skill.id}`)
    } catch (err) {
      const message = errorText(err)
      setError({ field: /already a skill/.test(message) ? 'name' : 'form', message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[92svh] gap-4 overflow-y-auto sm:max-w-[820px]" data-testid="new-skill-dialog">
        <DialogHeader>
          <DialogTitle className="text-title1">{showImport ? 'Import a skill' : 'New skill'}</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            A skill is know-how for one kind of work. Employees see its name and description, and load the instructions when a
            task calls for them.
          </DialogDescription>
        </DialogHeader>
        {showImport ? (
          <div className="flex min-w-0 flex-col gap-3" data-testid="skill-import">
            <Field
              id="ns-paste"
              label="SKILL.md"
              hint="Front matter with name and description, then the instructions"
              error={error?.field === 'import' ? error.message : null}
            >
              <Textarea
                id="ns-paste"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                rows={10}
                className="font-mono text-micro"
                placeholder={'---\nname: cut-release\ndescription: Cut a release branch and write the notes.\n---\n\n## Steps\n…'}
              />
            </Field>
            <input
              ref={fileRef}
              type="file"
              accept=".md,text/markdown,text/plain"
              className="hidden"
              aria-label="Upload SKILL.md"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (f) readSkill(await f.text())
                e.target.value = ''
              }}
            />
            <DialogFooter className="flex-row flex-wrap sm:justify-between">
              <Button type="button" variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
                <FileUp /> Upload a file
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowImport(false)}>
                  Write one instead
                </Button>
                <Button type="button" size="sm" onClick={() => readSkill(paste)} disabled={!paste.trim()}>
                  Read it
                </Button>
              </div>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex min-w-0 flex-col gap-4" noValidate>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
              <Field id="ns-name" label="Name" error={error?.field === 'name' ? error.message : null}>
                <Input id="ns-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="cut-release" />
              </Field>
              <Field
                id="ns-description"
                label="What it helps with"
                hint="One line: employees decide by this"
                error={error?.field === 'description' ? error.message : null}
              >
                <Input
                  id="ns-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Cut a release branch, write the notes and open the deploy merge request."
                />
              </Field>
            </div>
            <Field id="ns-when" label="When to use it" hint="Optional: the situations that call for it">
              <Input
                id="ns-when"
                value={whenToUse}
                onChange={(e) => setWhenToUse(e.target.value)}
                placeholder="Someone asks for a release, or a release train is due."
              />
            </Field>
            <Field label="Where it applies" error={error?.field === 'scope' ? error.message : null}>
              <ScopePicker value={scope} onChange={setScope} id="ns-project" />
            </Field>
            <Field id="ns-body" label="Instructions" hint="Markdown; start from the template">
              <StepsEditor
                value={body}
                onChange={setBody}
                onSubmit={() => submit()}
                minHeight="min-h-56"
                id="ns-body"
                label="Instructions (markdown)"
              />
            </Field>
            {error?.field === 'form' && (
              <p role="alert" className="text-micro text-[var(--red)]">
                {error.message}
              </p>
            )}
            <DialogFooter className="flex-row flex-wrap border-t pt-4 sm:justify-between">
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowImport(true)}>
                <FileUp /> Import SKILL.md
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? 'Creating…' : 'Create skill'}
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
