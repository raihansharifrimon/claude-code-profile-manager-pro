import * as os from 'node:os';
import * as path from 'node:path';

export interface ClaudePaths {
  /** Claude Code's global config file holding `oauthAccount`. */
  configFile: string;
  /** Plain-file credential store used on Linux/Windows (and as a macOS fallback). */
  credentialsFile: string;
}

export function resolveClaudePaths(
  configDirOverride: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): ClaudePaths {
  const dir = configDirOverride?.trim() || env.CLAUDE_CONFIG_DIR?.trim();
  if (dir) {
    const resolved = dir.startsWith('~') ? path.join(home, dir.slice(1)) : dir;
    return {
      configFile: path.join(resolved, '.claude.json'),
      credentialsFile: path.join(resolved, '.credentials.json'),
    };
  }
  return {
    configFile: path.join(home, '.claude.json'),
    credentialsFile: path.join(home, '.claude', '.credentials.json'),
  };
}
