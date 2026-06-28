export * from './config.js';
export * from './dispatch.js';
export * from './network.js';
export { renderPlanSummary } from './dryrun.js';
export * from './package-manager.js';
export * from './plan.js';
export * from './project.js';
export * from './presets.js';
export * from './risk.js';
export * from './advisory.js';
export { runPreflight, type PreflightPolicy, type PreflightResult, type PreflightContext } from './preflight.js';
export { runScan, type ScanResult, type ScanContext } from './scan.js';
export { runDelta, changedPackages, type DeltaPolicy, type DeltaResult, type DeltaContext } from './delta.js';
export { runDoctor, type DoctorOptions } from './doctor.js';
export { runInit, writeSandboxConfig, writeAgentArtifacts, printUnwiredHookWarning, type InitOptions, type AgentArtifacts } from './init.js';
export { classifyBareCommand, mergePreToolUseHook, mergeAgentSettings, installAgentHook, HOOK_SCRIPT, MANUAL_AGENT_SNIPPET, SECRET_DENY_RULES, type HookDecision, type HookInstall } from './hook.js';
export {
  writeDevcontainer,
  devcontainerJson,
  devcontainerDockerfile,
  initFirewallScript,
  firewallEnabled,
  firewallAllowlist,
  resolveImageDigest,
  CLAUDE_DOMAINS,
  BASE_IMAGE,
  type WriteDevcontainerResult,
} from './devcontainer.js';
export { runSetup, type SetupOptions } from './setup.js';
export { createBackend, renderRunArgs, type ContainerBackend, type RunOverride } from './backend.js';
export { execute, type ExecuteOptions, type ExecuteResult } from './execute.js';
export { runCode, type RunCodeOptions, type RunCodeResult, type CodeLanguage } from './code.js';
export { EgressError, parseEgressDenials, type EgressHandle } from './egress.js';
export { createLogger, formatEvent, log, type Logger, type LogLevel } from './log.js';
export { canPromptInteractively, nextPlanForBlockedEgressChoice, promptForBlockedEgress, type BlockedEgressChoice } from './interactive.js';
export {
  detectRegistryHints,
  detectEgressHosts,
  allowHosts,
  allowHostsLocal,
  missingAllowHosts,
  projectRegistryHints,
  registryDiagnostics,
  renderAllowCommand,
  readProjectNpmrc,
  renderAllowlistSnippet,
  type RegistryHints,
  type RegistryDiagnostics,
} from './registry.js';
export {
  classifyHost,
  describeBlockedHosts,
  renderBlockedHostLines,
  hostGlyph,
  type HostCategory,
  type HostClassification,
  type DescribeHostsOptions,
} from './hosts.js';
export { classifyCommand, snapshotTree, summarizeUnexpectedChanges, type CommandKind, type TreeSnapshot } from './tamper.js';
export { parseVersion, runtimeVulnerabilities, nodeEolStatus, type RuntimeVuln, type NodeEolStatus } from './runtime-cve.js';
export {
  loadKnownBad,
  matchKnownBad,
  parseAdvisoryFile,
  loadAdvisoryFile,
  loadFeedCache,
  parseFeed,
  updateFeeds,
  projectAdvisoryPath,
  userAdvisoryPath,
  feedCacheDir,
  PROJECT_ADVISORY_NAME,
  type KnownBadEntry,
  type KnownBadHit,
  type Severity,
  type FeedUpdate,
  type FeedPackage,
} from './known-bad.js';
export { scanSecrets, scanText, listScannableFiles, redact, shannonEntropy, highEntropyToken, luhnValid, jwtValid, SECRET_RULES, SKIP_DIRS, type SecretRule, type SecretFinding, type ScanSecretsOptions } from './secrets.js';
export {
  canonicalize,
  sha256Hex,
  chainEntry,
  appendAudit,
  readAuditLog,
  verifyChain,
  generateSigningKey,
  signPayload,
  verifyReceipt,
  keyFingerprint,
  GENESIS,
  type AuditEntry,
  type ChainVerdict,
  type SigningKeyPair,
  type SignedReceipt,
  type ReceiptVerdict,
} from './receipt.js';
export { signVerifyReceipt, runVerifyReceipt, runKeygen, runAuditVerify, readSigningKey, verifyConfig, runVerify, type VerifyResult, type VerifyReceiptPayload } from './verify.js';
export { makeCanary, scanCanaryLog, canaryMarkers, type Canary, type CanaryHit } from './canary.js';
export { runDemo, demoPlan, DEMO_SCENARIOS, IMDS_BLOCKED_CODE, type DemoScenario, type DemoOutcome, type DemoRunner } from './demo.js';
