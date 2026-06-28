// preinstall guard: refuse to install on the host.
// Only `./sandbox install` sets SANDBOX=1, so a naive host `npm install` stops here
// BEFORE any dependency lifecycle script (or binding.gyp) gets a chance to run.
if (process.env.SANDBOX !== '1') {
  console.error('\n  ✋ Refusing to `npm install` on the host.');
  console.error('     preinstall/postinstall and node-gyp/binding.gyp must run in the');
  console.error('     sandbox, not on your machine. Run instead:\n');
  console.error('       ../sandbox install\n');
  process.exit(1);
}
console.log('[guard] SANDBOX=1 — installing inside the container. OK.');
