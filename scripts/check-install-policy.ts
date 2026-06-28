import process from 'node:process';
import { verifyInstallPolicy } from '../src/repo-checks/install-policy.js';

const issues = verifyInstallPolicy(process.cwd());
if (issues.length === 0) process.exit(0);

for (const issue of issues) {
  process.stderr.write(`install policy: ${issue}\n`);
}
process.exit(1);
