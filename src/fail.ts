/** Print a `screen:`-prefixed error to stderr and exit non-zero. The one place a CLI path bails out. */
export function fail(msg: string): never {
  console.error(`screen: ${msg}`);
  process.exit(1);
}
