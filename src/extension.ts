import * as path from 'node:path';
import * as vscode from 'vscode';
import { AccountManager } from './accountManager';
import { type AccountNode, AccountsTreeProvider } from './accountsTree';
import { detectBackend } from './credentials';
import { resolveClaudePaths } from './paths';
import { ProfileStore } from './profileStore';
import type { ProfileMeta } from './types';

const SECTION = 'claudeSessions';
const LOGIN_POLL_MS = 2_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** Claude Code writes its config often; wait for a burst of writes to finish. */
const BACKGROUND_SETTLE_MS = 1_500;

function config() {
  return vscode.workspace.getConfiguration(SECTION);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function activate(context: vscode.ExtensionContext): void {
  const paths = () => resolveClaudePaths(config().get<string>('configDir'));
  const manager = new AccountManager({
    store: new ProfileStore(context.secrets, context.globalState),
    paths,
    backend: () =>
      detectBackend({
        keychainService: config().get<string>('keychainService') || 'Claude Code-credentials',
        credentialsFile: paths().credentialsFile,
      }),
  });

  const tree = new AccountsTreeProvider(manager);
  const view = vscode.window.createTreeView('claudeSessions.accounts', { treeDataProvider: tree });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'claudeSessions.switch';
  context.subscriptions.push(view, statusBar);

  const updateStatusBar = async () => {
    try {
      const live = await manager.getLive();
      const meta = live && manager.list().find((p) => p.id === live.id);
      statusBar.text = `$(account) ${live ? (meta?.label ?? live.oauthAccount.emailAddress) : 'Claude: signed out'}`;
      statusBar.tooltip = live
        ? `Claude Code account: ${live.oauthAccount.emailAddress}\nClick to switch account`
        : 'Claude Code is not signed in. Click to switch to a saved account.';
    } catch {
      statusBar.text = '$(account) Claude';
      statusBar.tooltip = 'Click to switch Claude account';
    }
    statusBar.show();
  };

  const refreshAll = () => {
    tree.refresh();
    void updateStatusBar();
  };
  context.subscriptions.push(manager.onDidChange(refreshAll));

  const sync = async () => {
    try {
      await manager.syncActive(BACKGROUND_SETTLE_MS);
    } catch {
      // Background sync is opportunistic; errors surface on explicit actions.
    }
    refreshAll();
  };

  let debounceTimer: NodeJS.Timeout | undefined;
  const debouncedSync = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(sync, 500);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(debounceTimer) });

  // React when Claude Code itself changes the login (sign-in, token refresh).
  const watchConfigFiles = () => {
    const { configFile, credentialsFile } = paths();
    const watchers = [configFile, credentialsFile].map((file) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)),
      );
      watcher.onDidChange(debouncedSync);
      watcher.onDidCreate(debouncedSync);
      watcher.onDidDelete(refreshAll);
      return watcher;
    });
    return vscode.Disposable.from(...watchers);
  };
  let fileWatchers = watchConfigFiles();

  // The macOS Keychain can't be watched, so also poll.
  let syncTimer: NodeJS.Timeout | undefined;
  const scheduleSync = () => {
    clearInterval(syncTimer);
    const minutes = config().get<number>('autoSyncIntervalMinutes') ?? 5;
    syncTimer = minutes > 0 ? setInterval(sync, minutes * 60_000) : undefined;
  };
  scheduleSync();

  context.subscriptions.push(
    { dispose: () => clearInterval(syncTimer) },
    { dispose: () => fileWatchers.dispose() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.autoSyncIntervalMinutes`)) {
        scheduleSync();
      }
      if (e.affectsConfiguration(`${SECTION}.configDir`)) {
        fileWatchers.dispose();
        fileWatchers = watchConfigFiles();
      }
      if (e.affectsConfiguration(SECTION)) {
        refreshAll();
      }
    }),
  );

  const afterSwitch = async (meta: ProfileMeta) => {
    const mode = config().get<string>('reloadAfterSwitch') ?? 'ask';
    const message = `Switched Claude Code to ${meta.label ?? meta.email}. Restart any running \`claude\` terminal sessions.`;
    if (mode === 'always') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }
    if (mode === 'never') {
      void vscode.window.showInformationMessage(message);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `${message} Reload the window so the Claude Code extension uses the new account?`,
      'Reload Window',
    );
    if (choice === 'Reload Window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  const switchTo = async (id: string) => {
    try {
      const meta = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Switching Claude account…' },
        () => manager.switchTo(id),
      );
      await afterSwitch(meta);
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
    }
  };

  const pickProfile = async (placeHolder: string): Promise<ProfileMeta | undefined> => {
    const live = await manager.getLive().catch(() => undefined);
    const items = manager.list().map((meta) => ({
      label: `${meta.id === live?.id ? '$(pass-filled)' : '$(account)'} ${meta.label ?? meta.email}`,
      description: [meta.label ? meta.email : undefined, meta.subscriptionType].filter(Boolean).join(' · '),
      detail:
        meta.id === live?.id ? 'Active' : manager.status(meta) === 'expired' ? '$(warning) Expired: sign in again' : undefined,
      meta,
    }));
    if (!items.length) {
      void vscode.window.showInformationMessage('No saved Claude accounts yet. Save your current login first.');
      return undefined;
    }
    return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.meta;
  };

  /** Waits for Claude Code to finish signing in to an account that isn't saved yet. */
  const waitForNewLogin = (token: vscode.CancellationToken) =>
    new Promise<ProfileMeta | undefined>((resolve) => {
      const started = Date.now();
      const timer = setInterval(async () => {
        if (token.isCancellationRequested || Date.now() - started > LOGIN_TIMEOUT_MS) {
          clearInterval(timer);
          return resolve(undefined);
        }
        const live = await manager.getLive().catch(() => undefined);
        if (live) {
          clearInterval(timer);
          resolve(await manager.saveCurrent().catch(() => undefined));
        }
      }, LOGIN_POLL_MS);
    });

  const register = (command: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));

  register('claudeSessions.refresh', async () => {
    await manager.syncActive().catch(() => undefined);
    refreshAll();
  });

  register('claudeSessions.saveCurrent', async () => {
    try {
      const meta = await manager.saveCurrent();
      void vscode.window.showInformationMessage(`Saved Claude session for ${meta.email}.`);
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
    }
  });

  register('claudeSessions.addAccount', async () => {
    try {
      if (await manager.getLive()) {
        await manager.saveCurrent();
      }
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      return;
    }

    const confirm = await vscode.window.showInformationMessage(
      'Add another Claude account?',
      {
        modal: true,
        detail:
          'Your current login has been saved. Claude Code will be signed out on this machine only (tokens are not revoked), ' +
          'and a terminal will open so you can sign in with another account. ' +
          'Do not use /logout: it revokes the session on the server, and the saved copy stops working.',
      },
      'Continue',
    );
    if (confirm !== 'Continue') {
      return;
    }

    try {
      await manager.clearLiveLogin();
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      return;
    }

    const terminal = vscode.window.createTerminal({ name: 'Claude Login' });
    terminal.show();
    terminal.sendText(config().get<string>('loginCommand') || 'claude');

    const meta = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Waiting for you to sign in to Claude in the terminal…',
        cancellable: true,
      },
      (_progress, token) => waitForNewLogin(token),
    );
    if (meta) {
      void vscode.window.showInformationMessage(
        `Saved Claude session for ${meta.email}. You can switch between accounts from the Claude Accounts view.`,
      );
    }
  });

  register('claudeSessions.switch', async () => {
    const meta = await pickProfile('Select a Claude account to switch to');
    if (meta) {
      await switchTo(meta.id);
    }
  });

  register('claudeSessions.switchTo', async (node?: AccountNode) => {
    if (node?.kind === 'profile') {
      await switchTo(node.meta.id);
    }
  });

  register('claudeSessions.rename', async (node?: AccountNode) => {
    if (node?.kind !== 'profile') {
      return;
    }
    const label = await vscode.window.showInputBox({
      prompt: `Display name for ${node.meta.email} (leave empty to show the email)`,
      value: node.meta.label ?? '',
    });
    if (label !== undefined) {
      await manager.rename(node.meta.id, label);
    }
  });

  register('claudeSessions.removeAll', async () => {
    const count = manager.list().length;
    if (!count) {
      void vscode.window.showInformationMessage('There are no saved Claude sessions.');
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Remove all ${count} saved Claude session${count === 1 ? '' : 's'}?`,
      {
        modal: true,
        detail:
          'Saved tokens are deleted from this machine. Claude Code stays signed in to its current account. ' +
          'Run this before uninstalling the extension: uninstalling does not delete saved sessions.',
      },
      'Remove All',
    );
    if (confirm === 'Remove All') {
      await manager.removeAll();
      void vscode.window.showInformationMessage('All saved Claude sessions were removed.');
    }
  });

  register('claudeSessions.remove', async (node?: AccountNode) => {
    if (node?.kind !== 'profile') {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Remove the saved session for ${node.meta.email}?`,
      {
        modal: true,
        detail: node.active
          ? 'Claude Code stays signed in to this account; only the saved copy is removed.'
          : 'You will need to sign in to this account again to use it.',
      },
      'Remove',
    );
    if (confirm === 'Remove') {
      await manager.remove(node.meta.id);
    }
  });

  void sync();
}

export function deactivate(): void {}
