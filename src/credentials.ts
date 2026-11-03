import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { readFileIfExists, writeFileAtomic } from './fsUtil';

/** Where Claude Code keeps the active login's OAuth tokens. */
export interface CredentialBackend {
  readonly kind: 'keychain' | 'file';
  read(): Promise<string | undefined>;
  write(raw: string): Promise<void>;
  clear(): Promise<void>;
}

const SECURITY = '/usr/bin/security';
/** `security` exit code for "item not found". */
const ERR_SEC_ITEM_NOT_FOUND = 44;

function quoteForSecurityShell(value: string): string {
  // `security -i` reads one command per line, so a newline would start a new command.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Keychain service and account names must not contain control characters.');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** macOS login keychain, accessed through the system `security` tool like Claude Code does. */
export class KeychainBackend implements CredentialBackend {
  readonly kind = 'keychain';

  constructor(
    private readonly service: string,
    private readonly account: string = os.userInfo().username,
  ) {}

  read(): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      execFile(
        SECURITY,
        ['find-generic-password', '-s', this.service, '-a', this.account, '-w'],
        { maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            return (err as { code?: number }).code === ERR_SEC_ITEM_NOT_FOUND
              ? resolve(undefined)
              : reject(new Error(`Could not read Keychain item "${this.service}": ${err.message}`));
          }
          const out = stdout.trim();
          // `security -w` prints hex when the stored data is not plain text.
          if (!out.startsWith('{') && /^[0-9a-fA-F]+$/.test(out)) {
            return resolve(Buffer.from(out, 'hex').toString('utf8'));
          }
          resolve(out || undefined);
        },
      );
    });
  }

  /**
   * The secret is passed hex-encoded over stdin (`security -i`) rather than
   * argv, so it never shows up in the process list.
   */
  async write(raw: string): Promise<void> {
    const command =
      [
        'add-generic-password',
        '-U',
        '-s',
        quoteForSecurityShell(this.service),
        '-a',
        quoteForSecurityShell(this.account),
        '-X',
        Buffer.from(raw, 'utf8').toString('hex'),
      ].join(' ') + '\n';
    await new Promise<void>((resolve, reject) => {
      const child = spawn(SECURITY, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 && !stderr.trim()) {
          resolve();
        } else {
          reject(new Error(`Could not write Keychain item "${this.service}": ${stderr.trim() || `exit ${code}`}`));
        }
      });
      child.stdin.end(command);
    });
  }

  clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(SECURITY, ['delete-generic-password', '-s', this.service, '-a', this.account], (err) => {
        if (err && (err as { code?: number }).code !== ERR_SEC_ITEM_NOT_FOUND) {
          return reject(new Error(`Could not remove Keychain item "${this.service}": ${err.message}`));
        }
        resolve();
      });
    });
  }
}

/** `.credentials.json`, used by Claude Code on Linux and Windows. */
export class FileBackend implements CredentialBackend {
  readonly kind = 'file';

  constructor(private readonly file: string) {}

  async read(): Promise<string | undefined> {
    return (await readFileIfExists(this.file))?.trim() || undefined;
  }

  write(raw: string): Promise<void> {
    return writeFileAtomic(this.file, raw, 0o600);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

/**
 * Picks the store Claude Code is actually using. On macOS that is the
 * Keychain, unless only the plain file exists (Claude Code's fallback).
 */
export async function detectBackend(opts: {
  platform?: NodeJS.Platform;
  keychainService: string;
  credentialsFile: string;
}): Promise<CredentialBackend> {
  const file = new FileBackend(opts.credentialsFile);
  if ((opts.platform ?? process.platform) !== 'darwin') {
    return file;
  }
  const keychain = new KeychainBackend(opts.keychainService);
  if (!(await keychain.read()) && (await file.read())) {
    return file;
  }
  return keychain;
}
