/** One CSV data row: values by normalised header name, and its 1-based line number in the file. */
export interface CsvRow {
  line: number
  values: Record<string, string>
}

/** `Manager Email` -> `manageremail`: headers are matched without case, spaces or punctuation. */
export const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Parses RFC 4180 CSV: quoted fields with `""` escapes and embedded commas or
 * newlines, CRLF or LF line ends, a BOM, and a `;` or tab delimiter when the
 * header line has no comma. Blank lines are skipped; values are trimmed.
 */
export function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const delim = firstLine.includes(',') ? ',' : firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ','
  const records: { line: number; cells: string[] }[] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let startLine = 1
  let touched = false
  const endCell = () => {
    cells.push(cell)
    cell = ''
  }
  const endRow = () => {
    endCell()
    if (touched || cells.some((c) => c.trim())) records.push({ line: startLine, cells })
    cells = []
    touched = false
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else {
        if (ch === '\n') line++
        cell += ch
      }
      continue
    }
    if (ch === '"' && !cell.trim()) {
      quoted = true
      cell = ''
      touched = true
    } else if (ch === delim) endCell()
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      endRow()
      line++
      startLine = line
    } else cell += ch
  }
  if (cell || cells.length) endRow()
  const [head, ...data] = records
  if (!head) return { headers: [], rows: [] }
  const headers = head.cells.map((h) => normHeader(h))
  const rows = data
    .filter((r) => r.cells.some((c) => c.trim()))
    .map((r) => ({
      line: r.line,
      values: Object.fromEntries(headers.map((h, i) => [h, (r.cells[i] ?? '').trim()])),
    }))
  return { headers, rows }
}
