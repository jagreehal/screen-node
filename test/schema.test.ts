import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SandboxConfigSchema } from '../src/config.js';

const SCHEMA_PATH = path.resolve('sandbox.schema.json');

describe('sandbox.schema.json', () => {
  it('is committed', () => {
    expect(existsSync(SCHEMA_PATH)).toBe(true);
  });

  it('matches the zod schema (run `npm run gen:schema` if this fails)', () => {
    const committed = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    expect(committed).toEqual(z.toJSONSchema(SandboxConfigSchema));
  });
});
