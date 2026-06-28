#!/usr/bin/env node
// Demonstrates `runCode` — the agent-facing API for executing untrusted / model-generated code
// inside the sandbox. Needs Docker (or Podman) running; the first call builds the image.
//
//   npm run build && node examples/run-code.mjs
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'index.mjs');
if (!existsSync(dist)) {
  console.error('sandbox not built — run `npm run build` first');
  process.exit(1);
}
const { runCode } = await import(dist);

// 1. Plain JavaScript, output captured.
console.log('js   ->', (await runCode('console.log(1 + 1)')).stdout.trim());

// 2. TypeScript, executed by Node's type-stripping (no compiler, no network).
console.log('ts   ->', (await runCode('const n: number = 21; console.log(n * 2)', { language: 'ts' })).stdout.trim());

// 3. A real timeout the code cannot defeat — enforced by a separate process (the container's init),
//    so a busy loop can't block or outrun it the way it defeats an in-process vm timeout.
const looped = await runCode('while (true) {}', { timeoutMs: 1500 });
console.log('loop ->', `timedOut=${looped.timedOut} exitCode=${looped.exitCode} (${looped.durationMs}ms)`);

// 4. No network by default — an outbound request just fails.
const offline = await runCode("try { await fetch('https://example.com'); console.log('REACHED'); } catch { console.log('BLOCKED'); }");
console.log('net  ->', offline.stdout.trim());

// 5. A multi-file program: extra files are written alongside the snippet so it can import them.
const multi = await runCode("import { greet } from './lib.mjs';\nconsole.log(greet('sandbox'))", {
  files: { 'lib.mjs': 'export const greet = (name) => `hello, ${name}`;' },
});
console.log('file ->', multi.stdout.trim());
