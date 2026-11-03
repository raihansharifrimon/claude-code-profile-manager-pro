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
