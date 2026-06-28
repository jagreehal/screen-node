import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function decodeDoubleQuoted(value: string): string {
  return value.replace(/\\([nrt"\\])/g, (_m, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        return ch;
    }
  });
}

export function parseEnvFile(text: string, file = '.env'): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [idx, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(body);
    if (!match) throw new Error(`screen: invalid env file ${file}:${idx + 1}`);
    const [, key, rawValue] = match;
    let value = rawValue ?? '';
    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length === 1) throw new Error(`screen: invalid env file ${file}:${idx + 1}`);
      value = decodeDoubleQuoted(value.slice(1, -1));
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length === 1) throw new Error(`screen: invalid env file ${file}:${idx + 1}`);
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    env[key!] = value;
  }
  return env;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Split a `--env-file` / `grants.envFiles` spec into its path and an optional key allowlist.
 * `".env"` injects every key; `".env:FOO,BAR"` injects only `FOO` and `BAR`. The suffix is treated
 * as a key list only when every comma-separated part is a valid env-var name, so an ordinary path
 * that happens to contain a colon is left intact.
 */
export function parseEnvFileSpec(spec: string): { file: string; keys?: string[] } {
  const colon = spec.lastIndexOf(':');
  if (colon > 0) {
    const parts = spec.slice(colon + 1).split(',');
    if (parts.length > 0 && parts.every((k) => ENV_KEY.test(k))) {
      return { file: spec.slice(0, colon), keys: parts };
    }
  }
  return { file: spec };
}

export function loadEnvFiles(specs: string[], baseDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const spec of specs) {
    const { file: rel, keys } = parseEnvFileSpec(spec);
    const file = path.isAbsolute(rel) ? rel : path.join(baseDir, rel);
    if (!existsSync(file)) throw new Error(`screen: env file not found: ${file}`);
    const parsed = parseEnvFile(readFileSync(file, 'utf8'), file);
    if (keys) {
      // Allowlist: inject only the named keys that exist (a missing one is skipped, like `--env`).
      for (const key of keys) if (key in parsed) env[key] = parsed[key]!;
    } else {
      Object.assign(env, parsed);
    }
  }
  return env;
}
