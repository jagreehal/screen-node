import type { PackageManager } from './package-manager.js';

export type ProjectMode =
  | 'no-deps'
  | 'host-native'
  | 'container-built'
  | 'deps-without-native-signal';

/**
 * One mode per project. A project's `node_modules` is built EITHER locally or in the container, never
 * reconciled across both. The two real modes:
 *   - `host-native` (LOCAL): a tree built by the user's own package manager (`pnpm install`), so the
 *     IDE and host tools load native binaries and just work.
 *   - `container-built` (CONTAINER): a Linux tree built by a contained install (`spnpm install` /
 *     `sandbox <pm>`), so lifecycle scripts never touch the host.
 * Two more values just say we can't tell yet: `no-deps` (nothing installed) and
 * `deps-without-native-signal` (a tree with no platform-specific packages, so either mode is possible
 * and it doesn't matter).
 *
 * We don't maintain or reconcile two trees; we detect the mode from the tree itself and warn on a
 * cross-mode action. The signal is the platform of the installed native packages, read live, NOT a
 * written marker: a sentinel file would survive a later host install and go stale (suppressing the
 * warning when it should fire). Host-native native packages present means a local tree a contained
 * install would replace with a Linux one the IDE can't load. The reverse direction (a host tool
 * loading a Linux tree) is the foreign-incompatible case the post-install/`doctor` checks already cover.
 */

/**
 * Classify the dependency mode from already-resolved signals. Pure: the caller does the filesystem
 * scans (in native-deps) and passes booleans, so the decision is unit-testable and one place owns the
 * precedence (host-native binaries win over foreign ones, since a host-native tree is the one a
 * contained install would clobber). `hostNative` should already be false on Linux, where host and
 * container share a platform and the distinction is moot.
 */
export function classifyProjectMode(input: { hasDeps: boolean; hostNative: boolean; foreignNative: boolean }): ProjectMode {
  if (!input.hasDeps) return 'no-deps';
  if (input.hostNative) return 'host-native';
  if (input.foreignNative) return 'container-built';
  return 'deps-without-native-signal';
}

/** A short, user-facing label for the workspace's current dependency mode. */
export function projectModeLabel(mode: ProjectMode): string {
  switch (mode) {
    case 'no-deps':
      return 'project mode: no deps installed yet';
    case 'host-native':
      return 'project mode: host-native deps';
    case 'container-built':
      return 'project mode: container-built deps';
    case 'deps-without-native-signal':
      return 'project mode: deps installed (no native-platform signal)';
  }
}

/** The terse mode phrase for the inline orient line (no `project mode:` prefix). */
function projectModeShort(mode: ProjectMode): string {
  switch (mode) {
    case 'no-deps':
      return 'no deps yet';
    case 'host-native':
      return 'host-native deps';
    case 'container-built':
      return 'container-built deps';
    case 'deps-without-native-signal':
      return 'deps installed';
  }
}

/**
 * The single action line printed before a tree-mutating write: the operation verb, the package
 * manager, the current project mode, and the one plain reason that matters. `verb` is the
 * present-progressive operation ("installing", "removing", …) so a `remove` doesn't announce an install.
 * Screen-node always installs natively on the host: it states the honest line (the gates ran, but a
 * native install runs lifecycle scripts on the host, so it's heuristic screening, not a hard boundary).
 */
export function writeActionLine(input: { verb: string; pm: PackageManager; mode: ProjectMode }): string {
  return `${input.verb} natively on the host with ${input.pm} (${projectModeShort(input.mode)}; gates ran, no container boundary)`;
}
