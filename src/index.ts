export * from './config.js';
export * from './dispatch.js';
export * from './package-manager.js';
export * from './project.js';
export * from './presets.js';
export * from './risk.js';
export * from './advisory.js';
export { runPreflight, type PreflightPolicy, type PreflightResult, type PreflightContext } from './preflight.js';
export { runScan, type ScanResult, type ScanContext } from './scan.js';
export { runDelta, changedPackages, type DeltaPolicy, type DeltaResult, type DeltaContext } from './delta.js';
export { runDoctor, type DoctorOptions } from './doctor.js';
export { runInit, writeSandboxConfig, type InitOptions } from './init.js';
export { runSetup, type SetupOptions } from './setup.js';
export { createLogger, formatEvent, log, type Logger, type LogLevel } from './log.js';
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
