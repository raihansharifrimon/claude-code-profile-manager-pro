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
    if (meta.invalid) {
      return 'expired';
    }
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
    // While Claude Code signs in to another account, the tokens and the
    // identity are written separately; never pair one account's tokens with
    // another's identity.
    const credentialsOrg = parseTokenInfo(credentials).organizationUuid;
    if (credentialsOrg && oauthAccount.organizationUuid && credentialsOrg !== oauthAccount.organizationUuid) {
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
      await this.repairMisattributed(live);
      const existing = this.deps.store.get(live.id);
      const meta = this.buildMeta(live, { ...existing, label: label ?? existing?.label, lastUsedAt: this.now });
      const saved = existing && (await this.deps.store.getSecret(live.id));
      await this.deps.store.put(meta, {
        credentials: live.credentials,
        oauthAccount: live.oauthAccount,
        previousCredentials: saved?.credentials !== live.credentials ? saved?.credentials : saved?.previousCredentials,
      });
      this.fire();
      return meta;
    });
  }

  /**
   * Claude Code rotates tokens as it refreshes them, which can invalidate the
   * copy we saved earlier. Copy the latest tokens of the active account back
   * into its saved session. Returns true if anything changed.
   */
  syncActive(settleMs = 0): Promise<boolean> {
    return this.exclusive(() => this.syncActiveUnlocked(settleMs));
  }

  /**
   * `settleMs` > 0 re-reads the login after a pause and only syncs if it did
   * not change in between, so a sign-in that is still being written is skipped.
   */
  private async syncActiveUnlocked(settleMs = 0): Promise<boolean> {
    let live = await this.getLive();
    if (live && settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      const again = await this.getLive();
      live = again && again.id === live.id && again.credentials === live.credentials ? again : undefined;
    }
    if (!live) {
      return false;
    }
    const repaired = await this.repairMisattributed(live);
    const existing = this.deps.store.get(live.id);
    if (!existing) {
      return repaired;
    }
    const saved = await this.deps.store.getSecret(live.id);
    if (
      saved?.credentials === live.credentials &&
      JSON.stringify(saved.oauthAccount) === JSON.stringify(live.oauthAccount)
    ) {
      if (repaired) {
        this.fire();
      }
      return repaired;
    }
    await this.deps.store.put(this.buildMeta(live, existing), {
      credentials: live.credentials,
      oauthAccount: live.oauthAccount,
      previousCredentials: saved?.credentials !== live.credentials ? saved?.credentials : saved?.previousCredentials,
    });
    this.fire();
    return true;
  }

  /**
   * A token belongs to exactly one account. If another saved session holds the
   * tokens Claude Code is now using for `live`, an earlier sync caught Claude
   * Code mid sign-in and saved them under the wrong account. Undo that by
   * restoring the other session's previous tokens, or flag it for sign-in.
   */
  private async repairMisattributed(live: LiveLogin): Promise<boolean> {
    let repaired = false;
    for (const meta of this.deps.store.list()) {
      if (meta.id === live.id) {
        continue;
      }
      const secret = await this.deps.store.getSecret(meta.id);
      if (secret?.credentials !== live.credentials) {
        continue;
      }
      const previous = secret.previousCredentials;
      if (previous && previous !== live.credentials) {
        const tokens = parseTokenInfo(previous);
        await this.deps.store.put(
          {
            ...meta,
            subscriptionType: tokens.subscriptionType ?? meta.subscriptionType,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
            invalid: undefined,
          },
          { credentials: previous, oauthAccount: secret.oauthAccount },
        );
      } else {
        await this.deps.store.put({ ...meta, invalid: true }, { credentials: '', oauthAccount: secret.oauthAccount });
      }
      repaired = true;
    }
    return repaired;
  }

  switchTo(id: string): Promise<ProfileMeta> {
    return this.exclusive(async () => {
      const target = this.deps.store.get(id);
      const secret = await this.deps.store.getSecret(id);
      if (!target || !secret) {
        throw new Error('That saved session no longer exists.');
      }
      if (this.status(target) === 'expired' || !secret.credentials) {
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

  /** Deletes every saved session. Claude Code's current login is left as is. */
  async removeAll(): Promise<number> {
    const ids = this.deps.store.list().map((p) => p.id);
    for (const id of ids) {
      await this.deps.store.remove(id);
    }
    this.fire();
    return ids.length;
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
