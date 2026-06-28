export function renderSandboxRetry(flag: string, cmd: string | undefined, args: string[]): string {
  const rest = cmd ? [cmd, ...args] : ['install'];
  return ['screen', flag, ...rest].join(' ');
}
