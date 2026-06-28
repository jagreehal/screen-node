import process from 'node:process';
import { detectImportCycles } from '../src/repo-checks/import-cycles.js';

const cycles = detectImportCycles(process.cwd());
if (cycles.length === 0) process.exit(0);

for (const cycle of cycles) {
  process.stderr.write(`import cycle: ${cycle.join(' -> ')}\n`);
}
process.exit(1);
