// Tiny zero-dep structured logger. Human lines by default (to stderr), NDJSON when
// SANDBOX_LOG=json — so CI/GUI wrappers can consume events the same way they consume
// the serializable RunPlan. Not pino: this is a short-lived CLI, not a server.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const HUMAN_PREFIX: Record<LogLevel, string> = {
  debug: 'sandbox debug: ',
  info: 'sandbox: ',
  warn: 'sandbox: ⚠ ',
  error: 'sandbox: ✖ ',
};

/**
 * Render one field value for a human line. Primitives print as-is; arrays join with `,`
 * (recursing, so a string array stays `a,b`); objects serialize as JSON — never the useless
 * `[object Object]` that `String({})` would produce for a structured field like `endpoints`.
 */
function renderValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(renderValue).join(',');
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function fieldsToText(fields?: LogFields): string {
  if (!fields) return '';
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${renderValue(v)}`);
  return parts.length ? ` (${parts.join(' ')})` : '';
}

/** Pure formatter — easy to unit-test. */
export function formatEvent(level: LogLevel, msg: string, fields: LogFields | undefined, json: boolean): string {
  return json ? JSON.stringify({ level, msg, ...fields }) : `${HUMAN_PREFIX[level]}${msg}${fieldsToText(fields)}`;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  json?: boolean;
  level?: LogLevel;
  sink?: (line: string) => void;
}

function envLevel(): LogLevel {
  const raw = process.env.SANDBOX_LOG_LEVEL as LogLevel | undefined;
  if (raw && raw in ORDER) return raw;
  return process.env.SANDBOX_DEBUG ? 'debug' : 'info';
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const json = opts.json ?? process.env.SANDBOX_LOG === 'json';
  const min = ORDER[opts.level ?? envLevel()];
  const sink = opts.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const emit = (level: LogLevel) => (msg: string, fields?: LogFields) => {
    if (ORDER[level] >= min) sink(formatEvent(level, msg, fields, json));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** Default process logger. */
export const log = createLogger();
