# Security Policy

This extension handles Claude Code OAuth tokens. Please report vulnerabilities
privately through GitHub Security Advisories ("Report a vulnerability" on the
repository's Security tab). Do not open public issues for security problems.

## How credentials are handled

- Saved sessions are stored with VS Code `SecretStorage`, which is encrypted by
  the operating system (macOS Keychain, Windows Credential Manager, or
  libsecret on Linux). Only non-secret display data (email, plan, timestamps)
  is kept in VS Code global state.
- Nothing is sent over the network. The extension makes no HTTP requests.
- On macOS the active credentials are written to the Keychain through
  `/usr/bin/security -i`, with the secret sent hex-encoded over stdin so it is
  never visible in the process list.
- On Linux/Windows `.credentials.json` is written atomically with mode `0600`.
- Tokens are never logged or shown in the UI.
- Settings that control where credentials are read and written
  (`configDir`, `keychainService`, `loginCommand`) are machine-scoped: they can
  only be set in your user settings, never by a repository's
  `.vscode/settings.json`. The extension is disabled in untrusted workspaces.
- Before syncing refreshed tokens, the extension checks that the tokens and the
  account identity belong to the same organization and waits for Claude Code's
  writes to settle. If tokens were still saved under the wrong account (possible
  for two accounts in the same organization), the extension notices as soon as
  Claude Code reports the real account and restores the affected session's
  previous tokens. If there are none, it asks you to sign in to that account again.
- Symlinked config files (for example, managed by a dotfiles repo) are written
  through, not replaced.

## Known limitations

- On Linux, VS Code Secret Storage needs a keyring (GNOME Keyring or KWallet).
  Without one, VS Code may fall back to weaker local encryption.
- VS Code gives extensions no way to clean up when they're uninstalled, so
  saved sessions stay in Secret Storage. Run **Claude Accounts: Remove All Saved
  Sessions…** before uninstalling.
