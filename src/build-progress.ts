// First-run build feedback. The sandbox image build is a ~30s one-time step; without a clear,
// expected-looking message it reads as a hang. This module owns the human framing (pure strings)
// and a tiny reporter whose output goes through an injectable driver — so the messaging is
// unit-testable, and the CLI can swap in a clack spinner on a TTY without touching this logic.

/** The two image states that actually trigger a build (the third, `current`, never gets here). */
export type BuildingState = 'absent' | 'stale';

/** The headline shown when a build starts, framed by why it's happening. Pure. */
export function buildNotice(state: BuildingState): string {
  return state === 'absent'
    ? 'Building the sandbox image, one-time setup (~30s). This is the Node.js container your installs and dev commands run inside; cached after this run.'
    : 'Rebuilding the sandbox image, config changed since it was last built (~30s). The image must match your sandbox.config.json so the boundary is reproducible.';
}

const READY_NOTICE = 'Sandbox image ready';
const FAILED_NOTICE = 'Sandbox image build failed';

/** Where a reporter sends its three lifecycle messages — a clack spinner or plain stderr lines. */
export interface BuildReporterDriver {
  start(message: string): void;
  succeed(message: string): void;
  fail(message: string): void;
}

export interface BuildReporter {
  start(state: BuildingState): void;
  succeed(): void;
  fail(): void;
}

/** Default driver: one `sandbox:`-prefixed line per event on stderr (so stdout stays clean). */
function stderrDriver(): BuildReporterDriver {
  const line = (glyph: string, message: string) => process.stderr.write(`sandbox: ${glyph}${message}\n`);
  return {
    start: (m) => line('', m),
    succeed: (m) => line('✓ ', m),
    fail: (m) => line('✖ ', m),
  };
}

/** A reporter that turns image states into framed messages and routes them through `driver`. */
export function createBuildReporter(driver: BuildReporterDriver = stderrDriver()): BuildReporter {
  return {
    start: (state) => driver.start(buildNotice(state)),
    succeed: () => driver.succeed(READY_NOTICE),
    fail: () => driver.fail(FAILED_NOTICE),
  };
}
