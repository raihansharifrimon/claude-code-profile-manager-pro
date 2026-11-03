import { readOAuthAccount, writeOAuthAccount } from './claudeConfig';
import type { CredentialBackend } from './credentials';
import type { ClaudePaths } from './paths';
import type { ProfileStore } from './profileStore';
import {
  isValidCredentials,
  parseTokenInfo,
  profileIdFor,
  type LiveLogin,
  type OAuthAccount,
  type ProfileMeta,
} from './types';

export interface AccountManagerDeps {
  store: ProfileStore;
  backend: () => Promise<CredentialBackend>;
  paths: () => ClaudePaths;
  now?: () => number;
}

export type ProfileStatus = 'ok' | 'expired';

export class AccountManager {
  private readonly listeners = new Set<() => void>();
  /** Serializes operations that touch the live login so they never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AccountManagerDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private fire(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  list(): ProfileMeta[] {
    return this.deps.store.list().sort((a, b) => (a.label ?? a.email).localeCompare(b.label ?? b.email));
  }

  status(meta: ProfileMeta): ProfileStatus {
    return meta.refreshTokenExpiresAt !== undefined && meta.refreshTokenExpiresAt <= this.now ? 'expired' : 'ok';
  }

  /** The login Claude Code is using right now, if any. */
  async getLive(): Promise<LiveLogin | undefined> {
    const [backend, oauthAccount] = await Promise.all([
      this.deps.backend(),
      readOAuthAccount(this.deps.paths().configFile),
    ]);
    const credentials = await backend.read();
    if (!credentials || !oauthAccount || !isValidCredentials(credentials)) {
      return undefined;
    }
    return { id: profileIdFor(oauthAccount), credentials, oauthAccount };
  }

  saveCurrent(label?: string): Promise<ProfileMeta> {
    return this.exclusive(async () => {
      const live = await this.getLive();
      if (!live) {
        throw new Error('No Claude Code login found on this machine. Sign in to Claude Code first.');
      }
      const existing = this.deps.store.get(live.id);
      const meta = this.buildMeta(live, { ...existing, label: label ?? existing?.label, lastUsedAt: this.now });
      await this.deps.store.put(meta, { credentials: live.credentials, oauthAccount: live.oauthAccount });
      this.fire();
      return meta;
    });
  }

  /**
   * Claude Code rotates tokens as it refreshes them, which can invalidate the
   * copy we saved earlier. Copy the latest tokens of the active account back
   * into its saved session. Returns true if anything changed.
   */
  syncActive(): Promise<boolean> {
    return this.exclusive(() => this.syncActiveUnlocked());
  }

  private async syncActiveUnlocked(): Promise<boolean> {
    const live = await this.getLive();
    const existing = live && this.deps.store.get(live.id);
    if (!live || !existing) {
      return false;
    }
    const saved = await this.deps.store.getSecret(live.id);
    if (
      saved?.credentials === live.credentials &&
      JSON.stringify(saved.oauthAccount) === JSON.stringify(live.oauthAccount)
    ) {
      return false;
    }
    await this.deps.store.put(this.buildMeta(live, existing), {
      credentials: live.credentials,
      oauthAccount: live.oauthAccount,
    });
    this.fire();
    return true;
  }

  switchTo(id: string): Promise<ProfileMeta> {
    return this.exclusive(async () => {
      const target = this.deps.store.get(id);
      const secret = await this.deps.store.getSecret(id);
      if (!target || !secret) {
        throw new Error('That saved session no longer exists.');
      }
      if (this.status(target) === 'expired') {
        throw new Error(
          `The saved session for ${target.email} has expired. Sign in to it again, then save it.`,
        );
      }

      // Keep the outgoing account's freshest tokens before overwriting them.
      await this.syncActiveUnlocked();

      const backend = await this.deps.backend();
      const configFile = this.deps.paths().configFile;
      const previousCredentials = await backend.read();

      await backend.write(secret.credentials);
      try {
        await writeOAuthAccount(configFile, secret.oauthAccount);
      } catch (err) {
        await this.restore(backend, previousCredentials);
        throw err;
      }

      const meta = { ...target, lastUsedAt: this.now };
      await this.deps.store.updateMeta(meta);
      this.fire();
      return meta;
    });
  }

  /**
   * Signs out locally so a different account can be signed in. Tokens are not
   * revoked on the server, so the saved copy keeps working.
   */
  clearLiveLogin(): Promise<void> {
    return this.exclusive(async () => {
      await this.syncActiveUnlocked();
      const backend = await this.deps.backend();
      await backend.clear();
      await writeOAuthAccount(this.deps.paths().configFile, undefined);
      this.fire();
    });
  }

  async rename(id: string, label: string | undefined): Promise<void> {
    const meta = this.deps.store.get(id);
    if (meta) {
      await this.deps.store.updateMeta({ ...meta, label: label?.trim() || undefined });
      this.fire();
    }
  }

  async remove(id: string): Promise<void> {
    await this.deps.store.remove(id);
    this.fire();
  }

  private async restore(backend: CredentialBackend, credentials: string | undefined): Promise<void> {
    try {
      if (credentials) {
        await backend.write(credentials);
      } else {
        await backend.clear();
      }
    } catch {
      // Best effort: the original error is more useful to surface.
    }
  }

  private buildMeta(live: LiveLogin, base: Partial<ProfileMeta> | undefined): ProfileMeta {
    const account: OAuthAccount = live.oauthAccount;
    const tokens = parseTokenInfo(live.credentials);
    return {
      id: live.id,
      email: account.emailAddress,
      label: base?.label,
      organizationName: typeof account.organizationName === 'string' ? account.organizationName : undefined,
      subscriptionType: tokens.subscriptionType ?? base?.subscriptionType,
      savedAt: this.now,
      lastUsedAt: base?.lastUsedAt,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    };
  }
}
