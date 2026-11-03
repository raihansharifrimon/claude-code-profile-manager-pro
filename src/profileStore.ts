import type { ProfileMeta, ProfileSecret } from './types';

/** Subset of `vscode.SecretStorage` (kept minimal so tests can fake it). */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

/** Subset of `vscode.Memento`. */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const INDEX_KEY = 'claudeSessions.profiles';
const secretKey = (id: string) => `claudeSessions.profile.${id}`;

/**
 * Tokens live in Secret Storage (backed by the OS keychain / libsecret /
 * Windows Credential Manager); only display metadata lives in global state.
 */
export class ProfileStore {
  constructor(
    private readonly secrets: SecretStorageLike,
    private readonly state: MementoLike,
  ) {}

  list(): ProfileMeta[] {
    return [...this.state.get<ProfileMeta[]>(INDEX_KEY, [])];
  }

  get(id: string): ProfileMeta | undefined {
    return this.list().find((p) => p.id === id);
  }

  async getSecret(id: string): Promise<ProfileSecret | undefined> {
    const raw = await this.secrets.get(secretKey(id));
    return raw ? (JSON.parse(raw) as ProfileSecret) : undefined;
  }

  async put(meta: ProfileMeta, secret: ProfileSecret): Promise<void> {
    await this.secrets.store(secretKey(meta.id), JSON.stringify(secret));
    await this.updateMeta(meta);
  }

  async updateMeta(meta: ProfileMeta): Promise<void> {
    const list = this.list();
    const index = list.findIndex((p) => p.id === meta.id);
    if (index >= 0) {
      list[index] = meta;
    } else {
      list.push(meta);
    }
    await this.state.update(INDEX_KEY, list);
  }

  async remove(id: string): Promise<void> {
    await this.secrets.delete(secretKey(id));
    await this.state.update(
      INDEX_KEY,
      this.list().filter((p) => p.id !== id),
    );
  }
}
