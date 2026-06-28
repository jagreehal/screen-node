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

/**
 * Whether a contained install is about to rebuild a host-native `node_modules` as a Linux tree the
 * host IDE can't load, and the one-line warning to show if so. Returns undefined when there's nothing
 * to warn about:
 *   - On Linux the container and host share a platform, so a contained install can never replace a
 *     tree the host can't load.
 *   - With no host-native packages in the tree there's nothing to lose: it's already a container tree
 *     (its native packages target Linux, so they don't satisfy a macOS/Windows host), or the project
 *     is pure-JS (no native binaries either way).
 * Pure so it's unit-testable; the CLI passes the live filesystem scan
 * (`findHostNativePackagesInWorkspace`) as a thunk, which is why this can't go stale. The count is
 * lazy so the Linux short-circuit can skip the scan entirely (one place owns "do we even look?",
 * instead of the caller pre-checking the platform too).
 */
export function crossModeWarning(input: { hostOs: NodeJS.Platform; hostNativeCount: () => number; pm: PackageManager }): string | undefined {
  if (input.hostOs === 'linux') return undefined;
  if (input.hostNativeCount() === 0) return undefined;
  return `This project currently uses host-native node_modules (it has native packages built for your ${input.hostOs} host). A contained install rebuilds them as a Linux tree your host IDE and tools may not load. Keep host-native deps: \`${input.pm} install\`. Switch this project to container deps: remove node_modules, then rerun this command.`;
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

/** Where a tree-mutating install runs: natively on the host, or inside a throwaway container. */
export type InstallTarget = 'native' | 'container';

/**
 * Where a tree-mutating install should run, given the project's current mode and whether the user
 * forced the container. One mode per project: a `container-built` tree keeps getting contained installs
 * (so its Linux tree stays coherent); every other mode (`host-native`, fresh `no-deps`, or
 * `deps-without-native-signal`) installs natively, so the host IDE and tools load the result and a
 * fresh project gets the best DX. `forceContainer` always wins: typing the explicit `sandbox <pm>` form
 * is an explicit ask for the boundary, regardless of the detected mode. Pure so cli.ts stays thin.
 */
export function chooseInstallTarget(mode: ProjectMode, forceContainer: boolean): InstallTarget {
  if (forceContainer) return 'container';
  return mode === 'container-built' ? 'container' : 'native';
}

/**
 * The single action line printed before a tree-mutating write: the operation verb and where it runs,
 * the package manager, the current project mode, and the one plain reason that matters. `verb` is the
 * present-progressive operation ("installing", "removing", …) so a `remove` doesn't announce an install.
 * Native states the honest line (the gates ran, but a native install runs lifecycle scripts on the host,
 * so it's heuristic, not the container boundary); container names what the boundary buys. One line,
 * action + why, so the write says what it's doing in one place without narrating containment afterward.
 */
export function writeActionLine(input: { verb: string; pm: PackageManager; mode: ProjectMode; target: InstallTarget }): string {
  if (input.target === 'native') {
    return `${input.verb} natively on the host with ${input.pm} (${projectModeShort(input.mode)}; gates ran, no container boundary)`;
  }
  return `${input.verb} in a throwaway container with ${input.pm} (${projectModeShort(input.mode)}; no host creds, default-deny egress)`;
}
