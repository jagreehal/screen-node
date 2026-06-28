export function renderSandboxRetry(flag: string, cmd: string | undefined, args: string[]): string {
  const rest = cmd ? [cmd, ...args] : ['install'];
  return ['sandbox', flag, ...rest].join(' ');
}
