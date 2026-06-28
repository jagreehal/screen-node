/**
 * The parsed global flags shared across the CLI surface. Lives in its own module (not `cli.ts`, which
 * self-executes `main()` and so can't be imported) so the write/install orchestration in `write.ts` can
 * take the same `Globals` the command handlers do.
 */
export interface Globals {
  config?: string;
  image?: string;
  backend: 'docker' | 'podman';
  json: boolean;
  format?: 'human' | 'json' | 'agent';
  frozen: boolean;
  dev: boolean;
  failOnEgress: boolean;
  failOnSourceWrites: boolean;
  failOnRisk?: boolean;
  fullNetwork: boolean;
  risk?: 'off' | 'basic' | 'thorough';
  envNames: string[];
  envFiles: string[];
  dryRun: boolean;
  /** Release-age gate threshold in days (overrides config; 0 disables). */
  minReleaseAge?: number;
  /** Package-name patterns exempt from the release-age gate (merged with config). */
  allowRecent: string[];
  /** Gate the whole resolved tree from the lockfile, not just direct deps. */
  deep: boolean;
  /** Local TTY mode: prompt before widening the boundary after a block. */
  interactive: boolean;
  /** Block on a known-malware advisory (overrides config). */
  failOnAdvisory?: boolean;
  /** Allow installing a maintainer-deprecated version for this run (overrides the default block). */
  failOnDeprecated?: boolean;
  /** Plant canary honeytokens and watch egress for them (overrides install.canaries). */
  canaries?: boolean;
  /** Suppress the "new version available" notice for this run (--no-update-check). */
  noUpdateCheck: boolean;
  /** Widen egress to the curated native-build/release hosts for this run (--allow-build-hosts). */
  allowBuildHosts: boolean;
  /** Approve every ignored dependency build script without prompting (--allow-all-builds). */
  allowAllBuilds: boolean;
}
