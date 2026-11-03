import * as vscode from 'vscode';
import type { AccountManager } from './accountManager';
import type { LiveLogin, ProfileMeta } from './types';

export type AccountNode =
  | { kind: 'profile'; meta: ProfileMeta; active: boolean }
  | { kind: 'unsaved'; live: LiveLogin };

export function formatRelative(timestamp: number | undefined, now = Date.now()): string {
  if (!timestamp) {
    return 'never';
  }
  const diff = timestamp - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ];
  for (const [ms, unit] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      const text = `${n} ${unit}${n === 1 ? '' : 's'}`;
      return diff < 0 ? `${text} ago` : `in ${text}`;
    }
  }
  return 'just now';
}

export class AccountsTreeProvider implements vscode.TreeDataProvider<AccountNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly manager: AccountManager) {}

  refresh(): void {
    this.emitter.fire();
  }

  async getChildren(element?: AccountNode): Promise<AccountNode[]> {
    if (element) {
      return [];
    }
    const profiles = this.manager.list();
    let live: LiveLogin | undefined;
    try {
      live = await this.manager.getLive();
    } catch {
      live = undefined;
    }
    const nodes: AccountNode[] = profiles.map((meta) => ({ kind: 'profile', meta, active: meta.id === live?.id }));
    if (live && !profiles.some((p) => p.id === live.id)) {
      nodes.unshift({ kind: 'unsaved', live });
    }
    // An empty array lets the view's welcome content show.
    return nodes;
  }

  getTreeItem(node: AccountNode): vscode.TreeItem {
    if (node.kind === 'unsaved') {
      const item = new vscode.TreeItem(node.live.oauthAccount.emailAddress);
      item.description = 'current login · not saved';
      item.iconPath = new vscode.ThemeIcon('circle-large-outline');
      item.contextValue = 'live.unsaved';
      item.tooltip = 'Claude Code is signed in with this account, but it is not saved yet.';
      return item;
    }

    const { meta, active } = node;
    const expired = this.manager.status(meta) === 'expired';
    const item = new vscode.TreeItem(meta.label ?? meta.email);
    item.id = meta.id;
    item.contextValue = active ? 'profile.active' : 'profile.inactive';

    const parts = [meta.subscriptionType, meta.label ? meta.email : undefined];
    if (active) {
      parts.push('active');
    } else if (expired) {
      parts.push('expired');
    }
    item.description = parts.filter(Boolean).join(' · ');

    if (active) {
      item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    } else if (expired) {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    } else {
      item.iconPath = new vscode.ThemeIcon('account');
    }

    const tooltip = new vscode.MarkdownString(undefined, true);
    // Values come from .claude.json, so append them as escaped text, not Markdown.
    tooltip.appendMarkdown('**').appendText(meta.email).appendMarkdown('**\n\n');
    if (meta.organizationName) {
      tooltip.appendMarkdown('Organization: ').appendText(meta.organizationName).appendMarkdown('\n\n');
    }
    if (meta.subscriptionType) {
      tooltip.appendMarkdown('Plan: ').appendText(meta.subscriptionType).appendMarkdown('\n\n');
    }
    tooltip.appendMarkdown(`Last used: ${formatRelative(meta.lastUsedAt)}\n\n`);
    tooltip.appendMarkdown(`Session saved: ${formatRelative(meta.savedAt)}\n\n`);
    if (meta.invalid) {
      tooltip.appendMarkdown('$(warning) This saved session needs a fresh sign-in. Sign in to this account again and save it.');
    } else if (meta.refreshTokenExpiresAt) {
      tooltip.appendMarkdown(
        expired
          ? `$(warning) Session expired ${formatRelative(meta.refreshTokenExpiresAt)}. Sign in again and save it.`
          : `Session valid until ${new Date(meta.refreshTokenExpiresAt).toLocaleString()}`,
      );
    }
    item.tooltip = tooltip;
    return item;
  }
}
