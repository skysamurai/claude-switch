/**
 * Shared re-authentication helpers.
 *
 * Two-tier approach:
 * 1. Silent refresh via OAuth token endpoint — uses the same endpoint and
 *    client ID as Claude Code CLI. Writes fresh tokens to the shared keychain.
 * 2. Browser-based re-login via `claude auth login` — fallback when silent
 *    refresh fails (e.g., refresh token is also expired/revoked).
 */

import { spawn } from 'child_process';
import { readCredentials, isTokenExpired, refreshAccessToken } from './keychain.js';
import { DEFAULT_CLAUDE_DIR } from './config.js';

/**
 * Attempt silent token refresh using the OAuth refresh endpoint.
 *
 * @param {{ name: string, configDir: string }} account
 * @returns {Promise<boolean>} true if the token was refreshed successfully
 */
export async function silentRefresh(account) {
  const result = await refreshAccessToken(account.configDir);
  return !!result.token && !result.error;
}

/**
 * Re-authenticate a single account via `claude auth login`.
 * Opens the browser for OAuth — no interactive Claude session needed.
 *
 * @param {{ name: string, configDir: string }} account
 * @returns {Promise<boolean>} true if credentials were refreshed successfully
 */
export async function reauthAccount(account) {
  console.error(`\n[claude-switch] Re-authenticating "${account.name}"...`);
  console.error(`  Config: ${account.configDir}`);
  console.error('  Opening browser for login...\n');

  // Strip CLAUDECODE so this works when called from inside a Claude Code session.
  // For the default account (~/.claude), don't set CLAUDE_CONFIG_DIR — Claude Code
  // uses a hash-based keychain service name when the env var is explicitly set, even
  // if it points to ~/.claude. This causes a mismatch where login writes to the
  // hashed entry but readCredentials reads from the standard one.
  const authEnv = { ...process.env };
  delete authEnv.CLAUDECODE;
  if (account.configDir === DEFAULT_CLAUDE_DIR) {
    delete authEnv.CLAUDE_CONFIG_DIR;
  } else {
    authEnv.CLAUDE_CONFIG_DIR = account.configDir;
  }

  await new Promise((resolve) => {
    const child = spawn('claude', ['auth', 'login'], {
      env: authEnv,
      stdio: 'inherit',
    });

    child.on('close', () => resolve());
    child.on('error', (err) => {
      console.error(`  Failed to launch Claude Code: ${err.message}`);
      resolve();
    });
  });

  const creds = readCredentials(account.configDir);
  if (creds.token && !isTokenExpired(creds)) {
    console.error(`  "${account.name}" authenticated successfully.`);
    if (creds.email) console.error(`  Email: ${creds.email}`);
    return true;
  }

  console.error(`  Warning: "${account.name}" still not authenticated.`);
  return false;
}

/**
 * Identify accounts needing re-auth and attempt to fix them interactively.
 *
 * @param {Array<{name: string, configDir: string, token?: string, usage?: object}>} accounts
 * @returns {Promise<string[]>} Names of accounts that were successfully re-authenticated
 */
export async function reauthExpiredAccounts(accounts) {
  const needsReauth = accounts.filter(a => {
    if (!a.token) return true;
    const creds = readCredentials(a.configDir);
    if (isTokenExpired(creds)) return true;
    if (a.usage?.error === 'HTTP 401' || a.usage?.error === 'HTTP 403') return true;
    return false;
  });

  if (needsReauth.length === 0) return [];

  const refreshed = [];

  // First pass: try silent refresh
  const silentCandidates = needsReauth.filter(a => a.token);
  const stillNeedsReauth = [...needsReauth.filter(a => !a.token)];

  if (silentCandidates.length > 0) {
    console.error(`[claude-switch] Refreshing ${silentCandidates.length} expired token(s)...`);
    for (const account of silentCandidates) {
      if (await silentRefresh(account)) {
        refreshed.push(account.name);
      } else {
        stillNeedsReauth.push(account);
      }
    }
  }

  if (stillNeedsReauth.length === 0) return refreshed;

  // Second pass: browser-based re-auth (requires TTY)
  if (!process.stdin.isTTY) {
    console.error('[claude-switch] Non-interactive mode — cannot open browser for re-auth. Run "claude-switch reauth" manually.');
    return refreshed;
  }

  console.error(`\n[claude-switch] ${stillNeedsReauth.length} account(s) need browser re-authentication:`);
  for (const a of stillNeedsReauth) {
    const reason = !a.token ? 'no credentials'
      : a.usage?.error === 'HTTP 401' ? 'token rejected (401)'
      : 'token expired';
    console.error(`  ${a.name}: ${reason}`);
  }

  for (const account of stillNeedsReauth) {
    const success = await reauthAccount(account);
    if (success) refreshed.push(account.name);
  }

  return refreshed;
}
