# Changelog

## 0.1.0

- Initial release: save multiple Claude Code login sessions locally and switch between them.
- Accounts sidebar view, status bar switcher and quick pick.
- "Add Account" flow that signs out locally without revoking saved sessions.
- Automatic sync of refreshed tokens for the active account.
- macOS Keychain and Linux/Windows `.credentials.json` support.
- Security hardening: machine-scoped settings, disabled in untrusted workspaces,
  Keychain command-injection guard, account mix-up detection and repair,
  escaped tooltips, symlink-safe writes, and a "Remove All Saved Sessions" command.
