import process from 'node:process';
import { verifyManifestPolicy } from '../src/repo-checks/manifest.js';

const issues = verifyManifestPolicy(process.cwd());
if (issues.length === 0) process.exit(0);

for (const issue of issues) {
  process.stderr.write(`repo metadata: ${issue}\n`);
}
process.exit(1);
