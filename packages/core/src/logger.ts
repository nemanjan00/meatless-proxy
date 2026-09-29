export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Structured JSON lines on stdout (stderr for warn and error). */
export function jsonLogger(level: LogLevel = 'info', base: Record<string, unknown> = {}): Logger {
  const log = (l: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[l] < ORDER[level]) return
    const line = JSON.stringify({ time: new Date().toISOString(), level: l, msg, ...base, ...fields }, errorReplacer)
    if (ORDER[l] >= ORDER.warn) process.stderr.write(line + '\n')
    else process.stdout.write(line + '\n')
  }
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (fields) => jsonLogger(level, { ...base, ...fields }),
  }
}

function errorReplacer(_key: string, value: unknown) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  return value
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
}

export interface LogLine {
  level: LogLevel
  msg: string
  fields: Record<string, unknown>
}

/** Collects log lines in memory, for tests. */
export function memoryLogger(lines: LogLine[] = [], base: Record<string, unknown> = {}): Logger & { lines: LogLine[] } {
  const log = (level: LogLevel) => (msg: string, fields?: Record<string, unknown>) =>
    void lines.push({ level, msg, fields: { ...base, ...fields } })
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (fields) => memoryLogger(lines, { ...base, ...fields }),
  }
}
