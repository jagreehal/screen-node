/** Print a `sandbox:`-prefixed error to stderr and exit non-zero. The one place a CLI path bails out. */
export function fail(msg: string): never {
  console.error(`sandbox: ${msg}`);
  process.exit(1);
}
