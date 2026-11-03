import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountManager } from '../accountManager';
import { readOAuthAccount } from '../claudeConfig';
import { FileBackend, KeychainBackend } from '../credentials';
import { resolveClaudePaths, type ClaudePaths } from '../paths';
import { ProfileStore, type MementoLike, type SecretStorageLike } from '../profileStore';
import type { OAuthAccount } from '../types';

class MemorySecrets implements SecretStorageLike {
  readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key);
  }
  async store(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}

class MemoryMemento implements MementoLike {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown) {
    this.data.set(key, value);
  }
}

const NOW = 1_800_000_000_000;

function creds(tag: string, refreshTokenExpiresAt = NOW + 86_400_000) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `access-${tag}`,
      refreshToken: `refresh-${tag}`,
      expiresAt: NOW + 3_600_000,
      refreshTokenExpiresAt,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
  });
}

function account(email: string): OAuthAccount {
  return { accountUuid: `uuid-${email}`, emailAddress: email, organizationUuid: 'org-1', organizationName: 'Brillmark' };
}

describe('AccountManager', () => {
  let dir: string;
  let paths: ClaudePaths;
  let backend: FileBackend;
  let manager: AccountManager;

  const signIn = async (email: string, tag: string) => {
    await backend.write(creds(tag));
    const config = JSON.parse(await fs.readFile(paths.configFile, 'utf8'));
    await fs.writeFile(paths.configFile, JSON.stringify({ ...config, oauthAccount: account(email) }));
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sessions-'));
    paths = resolveClaudePaths(dir);
    backend = new FileBackend(paths.credentialsFile);
    await fs.writeFile(paths.configFile, JSON.stringify({ theme: 'dark', projects: { a: 1 } }));
    manager = new AccountManager({
      store: new ProfileStore(new MemorySecrets(), new MemoryMemento()),
      backend: async () => backend,
      paths: () => paths,
      now: () => NOW,
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('saves the current login with metadata', async () => {
    await signIn('raihan@brillmark.com', 'r1');
    const meta = await manager.saveCurrent();
    expect(meta).toMatchObject({
      email: 'raihan@brillmark.com',
      organizationName: 'Brillmark',
      subscriptionType: 'max',
      refreshTokenExpiresAt: NOW + 86_400_000,
    });
    expect(manager.list()).toHaveLength(1);
  });

  it('throws when nobody is signed in', async () => {
    await expect(manager.saveCurrent()).rejects.toThrow(/No Claude Code login/);
  });

  it('switches accounts and leaves other config untouched', async () => {
    await signIn('raihan@brillmark.com', 'r1');
    const raihan = await manager.saveCurrent();
    await signIn('shams@brillmark.com', 's1');
    await manager.saveCurrent();

    await manager.switchTo(raihan.id);

    expect(await backend.read()).toBe(creds('r1'));
    expect((await readOAuthAccount(paths.configFile))?.emailAddress).toBe('raihan@brillmark.com');
    const config = JSON.parse(await fs.readFile(paths.configFile, 'utf8'));
    expect(config).toMatchObject({ theme: 'dark', projects: { a: 1 } });
  });

  it('keeps tokens Claude Code rotated while an account was active', async () => {
    await signIn('raihan@brillmark.com', 'r1');
    const raihan = await manager.saveCurrent();
    await signIn('shams@brillmark.com', 's1');
    const shams = await manager.saveCurrent();

    // Claude Code refreshes shams' tokens in place.
    await backend.write(creds('s2'));

    await manager.switchTo(raihan.id);
    await manager.switchTo(shams.id);
    expect(await backend.read()).toBe(creds('s2'));
  });

  it('refuses to switch to an expired session', async () => {
    await backend.write(creds('old', NOW - 1));
    await fs.writeFile(paths.configFile, JSON.stringify({ oauthAccount: account('ariful@brillmark.com') }));
    const ariful = await manager.saveCurrent();
    expect(manager.status(ariful)).toBe('expired');

    await signIn('raihan@brillmark.com', 'r1');
    await expect(manager.switchTo(ariful.id)).rejects.toThrow(/expired/);
    expect(await backend.read()).toBe(creds('r1'));
  });

  it('signs out locally without losing the saved session', async () => {
    await signIn('raihan@brillmark.com', 'r1');
    const raihan = await manager.saveCurrent();

    await manager.clearLiveLogin();
    expect(await manager.getLive()).toBeUndefined();
    expect(await readOAuthAccount(paths.configFile)).toBeUndefined();

    await manager.switchTo(raihan.id);
    expect((await manager.getLive())?.id).toBe(raihan.id);
  });

  it('ignores a login whose tokens and identity belong to different organizations', async () => {
    await backend.write(JSON.stringify({ ...JSON.parse(creds('x')), organizationUuid: 'org-other' }));
    await fs.writeFile(paths.configFile, JSON.stringify({ oauthAccount: account('raihan@brillmark.com') }));
    expect(await manager.getLive()).toBeUndefined();
  });

  it('skips a background sync while the login is still changing', async () => {
    await signIn('raihan@brillmark.com', 'r1');
    const raihan = await manager.saveCurrent();
    await backend.write(creds('r2'));
    const pending = manager.syncActive(50);
    await backend.write(creds('r3'));
    expect(await pending).toBe(false);
    expect(await manager.syncActive(50)).toBe(true);
    await signIn('shams@brillmark.com', 's1');
    await manager.saveCurrent();
    await manager.switchTo(raihan.id);
    expect(await backend.read()).toBe(creds('r3'));
  });

  it('undoes a sync that saved one account\'s tokens under another in the same organization', async () => {
    await signIn('raihan@brillmark.com', 'r1');
    const raihan = await manager.saveCurrent();

    // `/login` as shams outside the extension: tokens land before the identity.
    await backend.write(creds('s1'));
    await manager.syncActive();
    // Then Claude Code writes shams' identity.
    const config = JSON.parse(await fs.readFile(paths.configFile, 'utf8'));
    await fs.writeFile(paths.configFile, JSON.stringify({ ...config, oauthAccount: account('shams@brillmark.com') }));

    await manager.saveCurrent();
    await manager.switchTo(raihan.id);
    expect(await backend.read()).toBe(creds('r1'));
  });

  it('flags a session for sign-in when its only tokens belonged to another account', async () => {
    await backend.write(creds('s1'));
    await fs.writeFile(paths.configFile, JSON.stringify({ oauthAccount: account('raihan@brillmark.com') }));
    const raihan = await manager.saveCurrent();
    await fs.writeFile(paths.configFile, JSON.stringify({ oauthAccount: account('shams@brillmark.com') }));
    await manager.saveCurrent();

    const flagged = manager.list().find((p) => p.id === raihan.id)!;
    expect(manager.status(flagged)).toBe('expired');
    await expect(manager.switchTo(raihan.id)).rejects.toThrow(/expired/);

    // Signing in to it again clears the flag.
    await signIn('raihan@brillmark.com', 'r2');
    await manager.saveCurrent();
    expect(manager.status(manager.list().find((p) => p.id === raihan.id)!)).toBe('ok');
  });

  it('removes every saved session but keeps the current login', async () => {
    await signIn('raihan@brillmark.com', 'r1');
    await manager.saveCurrent();
    await signIn('shams@brillmark.com', 's1');
    await manager.saveCurrent();
    expect(await manager.removeAll()).toBe(2);
    expect(manager.list()).toHaveLength(0);
    expect((await manager.getLive())?.oauthAccount.emailAddress).toBe('shams@brillmark.com');
  });

  it('writes through a symlinked .claude.json instead of replacing it', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const real = path.join(dir, 'dotfiles-claude.json');
    await fs.rename(paths.configFile, real);
    await fs.symlink(real, paths.configFile);
    await signIn('raihan@brillmark.com', 'r1');
    const raihan = await manager.saveCurrent();
    await manager.clearLiveLogin();
    await manager.switchTo(raihan.id);
    expect((await fs.lstat(paths.configFile)).isSymbolicLink()).toBe(true);
    expect((await readOAuthAccount(real))?.emailAddress).toBe('raihan@brillmark.com');
  });

  it('renames and removes sessions', async () => {
    await signIn('raihan@brillmark.com', 'r1');
    const raihan = await manager.saveCurrent();
    await manager.rename(raihan.id, '  Work  ');
    expect(manager.list()[0].label).toBe('Work');
    await manager.remove(raihan.id);
    expect(manager.list()).toHaveLength(0);
  });
});

describe('resolveClaudePaths', () => {
  it('defaults to the home directory', () => {
    expect(resolveClaudePaths('', {}, '/home/u')).toEqual({
      configFile: path.join('/home/u', '.claude.json'),
      credentialsFile: path.join('/home/u', '.claude', '.credentials.json'),
    });
  });

  it('honours CLAUDE_CONFIG_DIR', () => {
    expect(resolveClaudePaths('', { CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u').configFile).toBe(
      path.join('/cfg', '.claude.json'),
    );
  });
});

describe('KeychainBackend', () => {
  it('rejects service names that could inject extra `security` commands', async () => {
    const backend = new KeychainBackend('x"\ndelete-generic-password -s "Claude Code-credentials', 'me');
    await expect(backend.write('{}')).rejects.toThrow(/control characters/);
  });
});

describe('FileBackend', () => {
  it('writes credentials readable only by the owner', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sessions-'));
    const file = path.join(dir, 'nested', '.credentials.json');
    await new FileBackend(file).write('{}');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
