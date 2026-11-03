/** Identity block Claude Code keeps under `oauthAccount` in `.claude.json`. */
export interface OAuthAccount {
  accountUuid: string;
  emailAddress: string;
  organizationUuid?: string;
  organizationName?: string;
  displayName?: string;
  [key: string]: unknown;
}

/** Non-secret metadata about a saved session, kept in extension global state. */
export interface ProfileMeta {
  id: string;
  email: string;
  label?: string;
  organizationName?: string;
  subscriptionType?: string;
  savedAt: number;
  lastUsedAt?: number;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
}

/** Secret payload of a saved session, kept in VS Code Secret Storage. */
export interface ProfileSecret {
  /** Raw credentials JSON exactly as Claude Code stored it. */
  credentials: string;
  oauthAccount: OAuthAccount;
}

/** The login Claude Code is currently using on this machine. */
export interface LiveLogin {
  id: string;
  credentials: string;
  oauthAccount: OAuthAccount;
}

export interface TokenInfo {
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  subscriptionType?: string;
}

export function profileIdFor(account: OAuthAccount): string {
  return `${account.accountUuid}:${account.organizationUuid ?? ''}`;
}

/** Reads expiry/plan info from a credentials blob without exposing tokens. */
export function parseTokenInfo(raw: string): TokenInfo {
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object') {
      return {};
    }
    return {
      accessTokenExpiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
      refreshTokenExpiresAt:
        typeof oauth.refreshTokenExpiresAt === 'number' ? oauth.refreshTokenExpiresAt : undefined,
      subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
    };
  } catch {
    return {};
  }
}

export function isValidCredentials(raw: string): boolean {
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    return typeof oauth?.accessToken === 'string' && typeof oauth?.refreshToken === 'string';
  } catch {
    return false;
  }
}
