#!/usr/bin/env node
/*
 * SIMULATED credential-stealer postinstall — SAFE, EDUCATIONAL, READ-ONLY.
 *
 * Mirrors the *harvest* step of the Miasma / Shai-Hulud npm worm documented in
 * INCIDENT-REPORT.md (the real payload swept ~/.ssh/id_*, ~/.npmrc,
 * ~/.aws/credentials, gh tokens, env vars, then exfiltrated them).
 *
 * This stand-in ONLY checks whether those files are *reachable* and prints their
 * PATHS — never their contents — and sends nothing anywhere. The lesson:
 *   - run via `../sandbox install`  -> 0 reachable (contained)
 *   - run on the host (`node simulate-stealer.js`) -> it would find your real creds
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const TARGETS = [
  '.ssh/id_ed25519', '.ssh/id_rsa', '.ssh/id_ecdsa', '.ssh/id_bs',
  '.npmrc', '.aws/credentials', '.config/gh/hosts.yml',
  '.docker/config.json', '.kube/config', '.claude/.credentials.json',
];

console.log('\n  [simulated-stealer] dependency postinstall executing');
console.log(`    context: hostname=${os.hostname()} platform=${os.platform()} home=${HOME}`);

let found = 0;
for (const rel of TARGETS) {
  const p = path.join(HOME, rel);
  try {
    fs.accessSync(p, fs.constants.R_OK);
    found++;
    console.log(`    HARVESTABLE: ${p}`); // path only — contents never read or printed
  } catch { /* not reachable */ }
}

const envHits = Object.entries(process.env).filter(
  ([k, v]) => /(_TOKEN|_KEY|_SECRET|NPM_TOKEN|AWS_)/i.test(k) && typeof v === 'string' && v.length > 12
).length;

// Persistence attempt: the real worm wrote .github/setup.js, .claude/settings.json,
// .vscode/tasks.json INTO the repo to re-execute on open. Try to plant such a file.
let persisted = false;
try {
  fs.mkdirSync('/workspace/.github', { recursive: true });
  fs.writeFileSync('/workspace/.github/persist.yml', 'x');
  persisted = true;
} catch { /* persistence paths are read-only */ }
console.log(
  `    repo persistence write: ${persisted
    ? '⚠️  SUCCEEDED — planted .github/persist.yml'
    : '✅ BLOCKED — persistence paths are read-only'}`
);

console.log(`\n    SUMMARY: ${found} credential file(s) reachable; ${envHits} token-shaped env var(s).`);
console.log(
  found === 0 && envHits === 0
    ? '    ✅ CONTAINED — nothing here for a stealer to take.\n'
    : '    ⚠️  EXPOSED — a real worm would exfiltrate the above.\n'
);
