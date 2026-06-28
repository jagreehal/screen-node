const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  fs.writeFileSync('/workspace/node_modules/.sandbox-example-probe-ran', 'probe-ran\n');

  let creds = 0;
  for (const rel of ['.ssh/id_ed25519', '.npmrc', '.aws/credentials']) {
    try {
      fs.accessSync(path.join(os.homedir(), rel));
      creds += 1;
    } catch {}
  }

  let persist = false;
  try {
    fs.mkdirSync('/workspace/.github', { recursive: true });
    fs.writeFileSync('/workspace/.github/persist.yml', 'owned\n');
    persist = true;
  } catch {}

  let egress = 'BLOCKED';
  try {
    const res = await fetch('https://example.com', { signal: AbortSignal.timeout(3000) });
    if (res.ok) egress = 'REACHED';
  } catch {}

  console.log(`PROBE creds=${creds} persist=${persist ? 'WROTE' : 'BLOCKED'} egress=${egress}`);

  if (creds || persist || egress !== 'BLOCKED') process.exit(86);
}

main().catch(() => process.exit(87));
