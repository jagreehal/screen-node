import * as p from '@clack/prompts';
import { describeBlockedHosts, renderBlockedHostLines, type DescribeHostsOptions } from './hosts.js';
import type { RunPlan } from './plan.js';

export type BlockedEgressChoice = 'allow-once' | 'allow-project' | 'allow-local' | 'full-network' | 'cancel';

export function canPromptInteractively(
  enabled: boolean,
  stdin: Pick<NodeJS.ReadStream, 'isTTY'> = process.stdin,
  stdout: Pick<NodeJS.WriteStream, 'isTTY'> = process.stdout,
): boolean {
  return enabled && Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
}

/**
 * The retry plan for a choice that continues, or `undefined` to stop. All three "allow" variants
 * widen the same way — add the blocked hosts to this run's allowlist; they differ only in whether
 * the CLI *also* persists them (and to which config layer), which is a side effect the CLI owns.
 * `full-network` drops the allowlist for the retry; `cancel` stops.
 */
export function nextPlanForBlockedEgressChoice(plan: RunPlan, deniedHosts: string[], choice: BlockedEgressChoice): RunPlan | undefined {
  switch (choice) {
    case 'allow-once':
    case 'allow-project':
    case 'allow-local':
      return { ...plan, egressAllow: [...new Set([...plan.egressAllow, ...deniedHosts])].sort() };
    case 'full-network':
      return { ...plan, network: 'on', egressAllow: [] };
    case 'cancel':
      return undefined;
  }
}

/**
 * Ask what to do after default-deny blocked an egress attempt. The hosts are annotated (registry vs
 * native-build vs unknown) so the decision is informed, not a rubber stamp — the whole reason the
 * boundary stops here instead of auto-allowing.
 */
export async function promptForBlockedEgress(deniedHosts: string[], opts: DescribeHostsOptions = {}): Promise<BlockedEgressChoice> {
  const classified = describeBlockedHosts(deniedHosts, opts);
  const allKnown = classified.every((c) => c.commonForInstall);
  p.log.warn(`Blocked egress (default-deny) to:\n${renderBlockedHostLines(classified)}`);
  if (!allKnown) {
    p.log.warn('One or more hosts are not known install/registry hosts. If you did not expect this, cancel and inspect, it can be an exfiltration attempt.');
  }

  const choice = await p.select({
    message: 'What should sandbox do?',
    options: [
      { value: 'allow-once', label: 'Allow once', hint: 'retry with these hosts, this run only, nothing saved' },
      { value: 'allow-project', label: 'Allow & save for the team', hint: 'write to sandbox.config.json (shows up in your PR diff)' },
      { value: 'allow-local', label: 'Allow & save for me', hint: 'write to sandbox.config.local.json (personal, git-ignored)' },
      { value: 'full-network', label: 'Full network once', hint: 'retry with NO allowlist, disables exfil protection for this run' },
      { value: 'cancel', label: 'Cancel', hint: 'stop here, boundary unchanged' },
    ],
    // The cursor lands on the first option (Allow once) — the safest, reversible default.
  });
  return p.isCancel(choice) ? 'cancel' : choice;
}
