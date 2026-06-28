import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';

/**
 * Pre-flight secret scanner. The sandbox keeps host credentials OUT of the install container, but it
 * can't stop a developer from committing a key into the repo itself — and the moment you `--env-from`
 * a file or grant a path, that secret is in scope. This is the visibility half of the credential
 * mission: a fast, offline grep for high-signal credential shapes so a leak is caught before it ships.
 *
 * Deliberately high-precision over exhaustive: each rule targets a provider's distinctive token shape
 * (false positives erode trust faster than a missed generic string). Matched values are REDACTED in
 * output — the scanner reports *where*, never the secret itself.
 */

export interface SecretRule {
  id: string;
  label: string;
  regex: RegExp;
  /** A broad fallback (e.g. `<SERVICE>_KEY=…`): only fires on a line no specific rule already matched. */
  generic?: boolean;
  /**
   * Optional second-stage confirmation on a regex hit. A shape can match by accident (a random
   * `eyJ…` blob, a Luhn-passing order id); a validator decodes/checksums the candidate and returns
   * false to DROP it. This is the precision lever that lets a scanner ship a
   * broad pattern without drowning the user in noise. Runs on `m[capture ?? 0]`.
   */
  validate?: (match: string) => boolean;
  /** Which capture group the value lives in (for redaction + validation). Default 0 (whole match). */
  capture?: number;
}

export interface SecretFinding {
  /** Path relative to the scan root. */
  file: string;
  /** 1-based line number. */
  line: number;
  ruleId: string;
  label: string;
  /** The matched token, redacted (first/last few chars only). */
  redacted: string;
}

/**
 * Shannon entropy in bits per character. A measure of randomness: English prose sits around 2.5–3.5,
 * a base64-encoded secret around 5–6. The {@link highEntropyToken} fallback uses it to catch opaque
 * credentials we have no named pattern for.
 */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Min length / entropy for the opaque-token fallback. Chosen so hex digests (≤4.0 bits) don't trip it. */
const ENTROPY_MIN_LEN = 24;
const ENTROPY_MIN_BITS = 4.2;

/**
 * Is `value` a high-entropy opaque token (a likely secret with no named shape)? Deliberately strict —
 * this is the catch-all, and a noisy catch-all is worse than none. Requires:
 *   • length ≥ 24 and Shannon entropy ≥ 4.2 bits/char (a 40-char hex git SHA maxes at 4.0, so it's
 *     excluded; only base64/base62-class randomness clears the bar), and
 *   • three character classes (lower, upper, digit) — excludes prose, hex digests, and UUIDs.
 */
export function highEntropyToken(value: string): boolean {
  if (value.length < ENTROPY_MIN_LEN) return false;
  if (!/^[A-Za-z0-9_\-+/]+$/.test(value)) return false; // base64/url-safe charset only
  const classes = Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/[0-9]/.test(value));
  if (classes < 3) return false;
  return shannonEntropy(value) >= ENTROPY_MIN_BITS;
}

/**
 * Luhn (mod-10) checksum — the check digit every payment card carries. Strips spaces/dashes, then
 * doubles every second digit from the right (subtracting 9 when >9) and asserts the sum is a multiple
 * of 10. ~90% of random 16-digit runs fail it, which is exactly why it earns the card pattern its place.
 */
export function luhnValid(s: string): boolean {
  const digits = s.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Confirm a `eyJ…` candidate is a real JWT, not a lookalike base64 blob: the first segment must
 * base64url-decode to JSON carrying an `alg` field (the one header member RFC 7519 requires). Cheap,
 * offline, and it kills the false positives a bare three-segment regex otherwise produces.
 */
export function jwtValid(match: string): boolean {
  const header = match.split('.')[0];
  if (!header) return false;
  try {
    const json = Buffer.from(header.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const obj = JSON.parse(json) as Record<string, unknown>;
    return typeof obj === 'object' && obj !== null && 'alg' in obj;
  } catch {
    return false;
  }
}

/** High-signal credential patterns. Provider-specific shapes first, generic shapes last. */
export const SECRET_RULES: SecretRule[] = [
  { id: 'aws-access-key', label: 'AWS access key id', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', label: 'GitHub token', regex: /\bgh[posru]_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-pat', label: 'GitHub fine-grained PAT', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: 'gitlab-token', label: 'GitLab token', regex: /\bgl(?:pat|deploy|rt|cbt|ptt|oas|soat|ft|imt|agent|wt)-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token', label: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'slack-app-token', label: 'Slack app-level token', regex: /\bxapp-[0-9]+-[A-Za-z0-9_]+-[0-9]+-[a-f0-9]+\b/g },
  { id: 'stripe-key', label: 'Stripe secret key', regex: /\b[rs]k_live_[0-9a-zA-Z]{20,}\b/g },
  { id: 'stripe-webhook', label: 'Stripe webhook secret', regex: /\bwhsec_[A-Za-z0-9]{20,}\b/g },
  { id: 'anthropic-key', label: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai-key', label: 'OpenAI API key', regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openrouter-key', label: 'OpenRouter API key', regex: /\bsk-or-v1-[A-Za-z0-9]{20,}\b/g },
  { id: 'groq-key', label: 'Groq API key', regex: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { id: 'xai-key', label: 'xAI API key', regex: /\bxai-[A-Za-z0-9-]{40,}\b/g },
  { id: 'huggingface-token', label: 'Hugging Face token', regex: /\bhf_[A-Za-z0-9]{34,}\b/g },
  { id: 'replicate-token', label: 'Replicate API token', regex: /\br8_[A-Za-z0-9]{37,}\b/g },
  { id: 'pinecone-key', label: 'Pinecone API key', regex: /\bpcsk_[A-Za-z0-9]{30,}\b/g },
  { id: 'google-api-key', label: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'google-oauth-secret', label: 'Google OAuth client secret', regex: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'gcp-service-account', label: 'GCP service-account key', regex: /"type"\s*:\s*"service_account"/g },
  { id: 'azure-storage-key', label: 'Azure storage account key', regex: /\bAccountKey=[A-Za-z0-9+/]{86}==/g },
  { id: 'twilio-sid', label: 'Twilio account SID', regex: /\bAC[0-9a-fA-F]{32}\b/g },
  { id: 'discord-bot-token', label: 'Discord bot token', regex: /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g },
  { id: 'digitalocean-token', label: 'DigitalOcean token', regex: /\bdop_v1_[a-f0-9]{64}\b/g },
  { id: 'vault-token', label: 'HashiCorp Vault token', regex: /\bhvs\.[A-Za-z0-9_-]{24,}\b/g },
  { id: 'vercel-token', label: 'Vercel token', regex: /\b(?:vercel|vc[piark])_[A-Za-z0-9]{24,}\b/g },
  { id: 'databricks-token', label: 'Databricks token', regex: /\bdapi[0-9a-f]{32,}\b/g },
  { id: 'linear-key', label: 'Linear API key', regex: /\blin_api_[A-Za-z0-9]{40,}\b/g },
  { id: 'notion-key', label: 'Notion API key', regex: /\bntn_[A-Za-z0-9]{40,}\b/g },
  { id: 'sentry-token', label: 'Sentry auth token', regex: /\bsntrys_[A-Za-z0-9]{40,}\b/g },
  { id: 'new-relic-key', label: 'New Relic API key', regex: /\bNRAK-[A-Z0-9]{27,}\b/g },
  { id: 'npm-token', label: 'npm access token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'pypi-token', label: 'PyPI API token', regex: /\bpypi-AgE[A-Za-z0-9_-]{50,}\b/g },
  { id: 'sendgrid-key', label: 'SendGrid API key', regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { id: 'mailgun-key', label: 'Mailgun API key', regex: /\bkey-[a-z0-9]{32}\b/g },
  { id: 'private-key', label: 'private key block', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'db-url-creds', label: 'database URL with password', regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/g },
  { id: 'jwt', label: 'JSON Web Token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, validate: jwtValid },
  // Payment card — broad shape (13–19 digits, optional space/dash grouping) gated by the Luhn
  // checksum, which rejects ~90% of random digit runs (order ids, timestamps) that would otherwise
  // be noise. The mechanism, not just this rule, is the point: any pattern can carry a `validate`.
  { id: 'credit-card', label: 'payment card number', regex: /\b(?:\d[ -]?){13,19}\b/g, validate: luhnValid },
  // Generic fallback: a `<SERVICE>_KEY|_SECRET|_TOKEN|… = value`
  // assignment with a 16+ char value catches branded providers we don't hardcode. Broad, so it only
  // fires on lines no specific rule matched, and requires the value to be quoted or assignment-shaped.
  { id: 'generic-credential', label: 'credential assignment', generic: true, capture: 1, regex: /\b[A-Z][A-Z0-9_]*(?:_API)?(?:_KEY|_SECRET|_TOKEN|_ACCESS_KEY|_AUTH_TOKEN|_PASSWORD)\s*[:=]\s*['"]?([A-Za-z0-9_\-./+]{16,})['"]?/g },
];

/** Redact a matched token: keep a short head and tail, mask the middle (never echo a full secret). */
export function redact(value: string): string {
  if (value.length <= 12) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}

/**
 * The entropy fallback's key matcher: a secret-ISH identifier (key/secret/token/password/cred/auth/
 * api/bearer, any case) assigned a value. The value is confirmed by {@link highEntropyToken}, so this
 * catches a real credential whose PROVIDER we don't recognise — `dbPassword: "f8Kd…"`, `accessToken =
 * '…'` — without the noise of flagging every base64 blob (a data URI or SRI hash has no secret-ish key).
 */
const ENTROPY_ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_]*(?:key|secret|token|password|passwd|cred|auth|api|bearer)[A-Za-z0-9_]*)\s*[:=]\s*['"]?([A-Za-z0-9_\-+/]{24,})['"]?/gi;

/** Scan one text body for every rule. Pure — the unit-test surface. Returns line-numbered, redacted hits. */
export function scanText(text: string, rules: SecretRule[] = SECRET_RULES): Array<Omit<SecretFinding, 'file'>> {
  const out: Array<Omit<SecretFinding, 'file'>> = [];
  const specific = rules.filter((r) => !r.generic);
  const generic = rules.filter((r) => r.generic);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let claimed = false;
    for (const rule of specific) {
      rule.regex.lastIndex = 0;
      for (const m of line.matchAll(rule.regex)) {
        const value = m[rule.capture ?? 0]!;
        if (rule.validate && !rule.validate(value)) continue; // shape matched but checksum/decode rejected it
        claimed = true;
        out.push({ line: i + 1, ruleId: rule.id, label: rule.label, redacted: redact(value) });
      }
    }
    // A fallback only fires on a line no specific rule already claimed (avoids double-reporting).
    if (claimed) continue;
    for (const rule of generic) {
      rule.regex.lastIndex = 0;
      for (const m of line.matchAll(rule.regex)) {
        const value = m[rule.capture ?? 0]!;
        if (rule.validate && !rule.validate(value)) continue;
        claimed = true;
        // For an assignment-shaped match, redact the captured VALUE, not the whole `KEY=value` span.
        out.push({ line: i + 1, ruleId: rule.id, label: rule.label, redacted: redact(value) });
      }
    }
    // Last resort: a secret-ish assignment whose value is a high-entropy opaque token we have no
    // named pattern for. Only on a still-unclaimed line, so it never double-reports a known provider.
    if (claimed) continue;
    ENTROPY_ASSIGNMENT.lastIndex = 0;
    for (const m of line.matchAll(ENTROPY_ASSIGNMENT)) {
      const value = m[2]!;
      if (highEntropyToken(value)) out.push({ line: i + 1, ruleId: 'high-entropy-secret', label: 'high-entropy credential', redacted: redact(value) });
    }
  }
  return out;
}

/** Directories never worth scanning (build output, deps, VCS) — pruned during the walk. */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', 'vendor', '__pycache__', '.venv', '.terraform']);

/** Lockfiles and obvious non-secret-bearing files: skipped by name. Lockfiles hash to JWT-like noise. */
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'screen.schema.json']);

const MAX_FILE_BYTES = 512 * 1024; // skip large/binary blobs; secrets live in small config/source files

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 1024);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Recursively list scannable files under `root` (relative paths), honoring {@link SKIP_DIRS}/size/binary. */
export function listScannableFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && (e.isDirectory() ? SKIP_DIRS.has(e.name) : false)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (SKIP_FILES.has(e.name)) continue;
      try {
        if (statSync(abs).size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      out.push(path.relative(root, abs));
    }
  };
  walk(root);
  return out;
}

export interface ScanSecretsOptions {
  rules?: SecretRule[];
  /** Override file discovery (tests). Returns paths relative to `root`. */
  listFiles?: (root: string) => string[];
  /** Override file reading (tests). */
  readFile?: (abs: string) => string;
}

/** Scan a directory tree — OR a single file — for credential leaks. One finding per matched token. */
export function scanSecrets(root: string, opts: ScanSecretsOptions = {}): SecretFinding[] {
  const rules = opts.rules ?? SECRET_RULES;
  // `root` may be a file (`sandbox secrets .env`): scan just that file rather than walking it as a
  // directory (readdirSync on a file throws → would otherwise be swallowed into a false "clean").
  let files: string[];
  let base = root;
  if (opts.listFiles) {
    files = opts.listFiles(root);
  } else {
    // A missing/unreadable scan ROOT must be an error, not a silent "clean" — for a security scanner,
    // a typo'd target reporting no findings is worse than useless. (Files that vanish mid-walk are
    // still skipped below; this guards only the explicit target the caller named.)
    let isFile: boolean;
    try {
      isFile = statSync(root).isFile();
    } catch (e) {
      throw new Error(`cannot scan ${root}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (isFile) {
      base = path.dirname(root);
      files = [path.basename(root)];
    } else {
      files = listScannableFiles(root);
    }
  }
  const findings: SecretFinding[] = [];
  for (const rel of files) {
    const abs = path.isAbsolute(rel) ? rel : path.join(base, rel);
    let text: string;
    try {
      if (opts.readFile) {
        text = opts.readFile(abs);
      } else {
        const buf = readFileSync(abs);
        if (looksBinary(buf)) continue;
        text = buf.toString('utf8');
      }
    } catch {
      continue;
    }
    for (const hit of scanText(text, rules)) findings.push({ file: rel, ...hit });
  }
  return findings;
}
