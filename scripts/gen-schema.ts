// Generate sandbox.schema.json from the zod schema (the single source of truth).
// Run via `npm run gen:schema`; `npm run build` runs it first. A unit test asserts
// the committed file stays in sync.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SandboxConfigSchema } from '../src/config.js';

export function buildSchema(): unknown {
  return z.toJSONSchema(SandboxConfigSchema);
}

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sandbox.schema.json');
writeFileSync(out, `${JSON.stringify(buildSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
