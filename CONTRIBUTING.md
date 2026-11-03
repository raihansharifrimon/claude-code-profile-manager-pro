# Contributing

Thanks for helping out!

## Setup

```bash
npm install
npm run compile   # type-check + bundle into dist/
npm test          # unit tests (vitest)
npm run lint
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

## Project layout

| File | Purpose |
| --- | --- |
| `src/extension.ts` | Activation, commands, status bar, file watchers |
| `src/accountsTree.ts` | Sidebar tree view |
| `src/accountManager.ts` | Save / switch / sync logic (no `vscode` import, unit tested) |
| `src/profileStore.ts` | Saved sessions in SecretStorage + metadata in global state |
| `src/credentials.ts` | Reading/writing Claude Code's live credentials (Keychain or file) |
| `src/claudeConfig.ts` | Reading/writing `oauthAccount` in `.claude.json` |
| `src/paths.ts` | Resolves Claude config locations (`CLAUDE_CONFIG_DIR` aware) |

Keep `accountManager.ts` and the modules it imports free of `vscode` imports so
they stay testable with plain Node.

## Pull requests

- Add or update tests for behaviour changes.
- Never log, print or display token values.
- Run `npm run lint && npm test && npm run package` before opening the PR.
