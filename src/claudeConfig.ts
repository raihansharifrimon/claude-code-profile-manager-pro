import { readFileIfExists, writeFileAtomic } from './fsUtil';
import type { OAuthAccount } from './types';

async function readConfig(file: string): Promise<Record<string, unknown>> {
  const text = await readFileIfExists(file);
  if (!text?.trim()) {
    return {};
  }
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

export async function readOAuthAccount(file: string): Promise<OAuthAccount | undefined> {
  const account = (await readConfig(file)).oauthAccount as OAuthAccount | undefined;
  if (account && typeof account.accountUuid === 'string' && typeof account.emailAddress === 'string') {
    return account;
  }
  return undefined;
}

/**
 * Replaces only the `oauthAccount` key, leaving every other setting in the
 * file untouched. Passing `undefined` removes it (signed-out state).
 */
export async function writeOAuthAccount(file: string, account: OAuthAccount | undefined): Promise<void> {
  const config = await readConfig(file);
  if (account) {
    config.oauthAccount = account;
  } else {
    delete config.oauthAccount;
  }
  await writeFileAtomic(file, JSON.stringify(config, null, 2));
}
