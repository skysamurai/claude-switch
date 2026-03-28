#!/usr/bin/env node

/**
 * claude-switch — Multi-account Claude Code with automatic rate-limit switching.
 * Works on macOS, Linux and Windows.
 *
 * Run `claude-switch help` for usage.
 */

import { spawn, execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  addAccount, removeAccount, getAccounts,
  ensureDefaultAccount, validateAccountName,
  setAccountPriority, clearAccountPriority,
  CONFIG_DIR, DEFAULT_CLAUDE_DIR,
} from '../lib/config.js';
import { readCredentials, isTokenExpired, deleteKeychainEntry } from '../lib/keychain.js';
import { checkAllUsage, checkUsage, fetchProfile } from '../lib/usage.js';
import { pickBestAccount, pickByPriority } from '../lib/scorer.js';
import { run } from '../lib/runner.js';
import { reauthAccount, reauthExpiredAccounts, silentRefresh } from '../lib/reauth.js';
import { openLogout, sleep } from '../lib/browser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const command = args[0];

// ─── Auto-detect existing Claude auth at startup ───────────────────────────

const autoRegistered = ensureDefaultAccount();
if (autoRegistered) {
  const defaultCreds = readCredentials(DEFAULT_CLAUDE_DIR);
  if (defaultCreds.token) {
    console.error('[claude-switch] Found existing Claude authorization — registered as "default".');
  }
}

// ─── Command dispatch ──────────────────────────────────────────────────────

switch (command) {
  case 'add':
    await cmdAdd(args.slice(1));
    break;

  case 'remove':
    await cmdRemove(args.slice(1));
    break;

  case 'list':
    await cmdList();
    break;

  case 'status':
    await cmdStatus();
    break;

  case 'reauth':
    await cmdReauth();
    break;

  case 'resume':
    await cmdResume(args.slice(1));
    break;

  case 'use':
    await cmdUse(args.slice(1));
    break;

  case 'set-priority':
    await cmdSetPriority(args.slice(1));
    break;

  case 'init':
    cmdInit(args[1]);
    break;

  case 'update':
    await cmdUpdate();
    break;

  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;

  case '--version':
  case '-v': {
    const { readFileSync } = await import('fs');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
    console.log(`claude-switch v${pkg.version}`);
    break;
  }

  case undefined:
    await cmdRun([]);
    break;

  default:
    await cmdRun(args);
    break;
}

// ─── Commands ──────────────────────────────────────────────────────────────

async function cmdAdd(args) {
  const name = args[0];
  if (!name) {
    console.error('Usage: claude-switch add <name>');
    console.error('Example: claude-switch add work');
    process.exit(1);
  }

  try {
    validateAccountName(name);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  // Already registered?
  const existingAccounts = getAccounts();
  if (existingAccounts.some(a => a.name === name)) {
    console.log(`Account "${name}" is already registered.`);
    console.log('Run "claude-switch status" to check its authentication.');
    return;
  }

  // Create the profile dir and register the account
  let configDir;
  try {
    configDir = addAccount(name);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  // ── Check if credentials already exist (no browser needed) ──────────────
  const existingCreds = readCredentials(configDir);
  if (existingCreds.token) {
    const profile = await fetchProfile(existingCreds.token);
    console.log(`Account "${name}" registered from existing credentials.`);
    if (profile.email) console.log(`Email: ${profile.email}`);
    return;
  }

  // ── Need browser auth ────────────────────────────────────────────────────
  console.log(`Account "${name}" registered.`);
  console.log(`Config: ${configDir}`);
  console.log('');

  // If other accounts already exist, logout first so the browser
  // doesn't silently re-authenticate with the wrong account.
  if (existingAccounts.length > 0) {
    console.log('Step 1/2 — Logging out previous browser session...');
    openLogout();
    await sleep(2500);
    console.log('Step 2/2 — Opening login page...');
  } else {
    console.log('Opening browser for login...');
  }
  console.log('');

  // Strip CLAUDECODE so this works from inside a Claude Code session
  const authEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete authEnv.CLAUDECODE;

  await new Promise((resolve) => {
    const child = spawn('claude', ['auth', 'login'], {
      env: authEnv,
      stdio: 'inherit',
    });
    child.on('close', () => resolve());
    child.on('error', (err) => {
      console.error(`Failed to launch Claude: ${err.message}`);
      console.error('Make sure "claude" is installed and in your PATH.');
      resolve();
    });
  });

  // Verify credentials were saved
  const creds = readCredentials(configDir);
  if (!creds.token) {
    console.log('');
    console.log(`Warning: No credentials found for "${name}".`);
    console.log(`You can login later with:`);
    console.log(`  CLAUDE_CONFIG_DIR="${configDir}" claude auth login`);
    return;
  }

  console.log('');

  // Duplicate detection
  const newProfile = await fetchProfile(creds.token);
  if (newProfile.email) {
    const allOthers = getAccounts().filter(a => a.name !== name);
    const otherProfiles = await Promise.all(allOthers.map(async (a) => {
      const c = readCredentials(a.configDir);
      if (!c.token) return { ...a, email: null };
      const p = await fetchProfile(c.token);
      return { ...a, email: p.email };
    }));

    const duplicate = otherProfiles.find(a => a.email && a.email === newProfile.email);
    if (duplicate) {
      console.error(`Error: "${name}" (${newProfile.email}) is the same account as "${duplicate.name}".`);
      console.error('Each account must be a different Claude subscription.');
      console.error(`Removing "${name}"...`);
      removeAccount(name);
      process.exit(1);
    }
  }

  console.log(`Account "${name}" added successfully.`);
  if (newProfile.email) console.log(`Email: ${newProfile.email}`);
  console.log('');
  console.log('Run "claude-switch status" to verify all accounts.');
}

async function cmdRemove(args) {
  const name = args[0];
  if (!name) {
    console.error('Usage: claude-switch remove <name>');
    process.exit(1);
  }

  try {
    removeAccount(name);
    console.log(`Account "${name}" removed.`);
    console.log('Note: Credentials and config directory were not deleted.');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function cmdList() {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    console.log('No accounts registered.');
    console.log('Run "claude-switch add <name>" to register an account.');
    return;
  }

  console.log('Accounts:\n');

  const enriched = await Promise.all(accounts.map(async (account) => {
    const creds = readCredentials(account.configDir);
    const profile = creds.token ? await fetchProfile(creds.token) : { name: null, email: null };
    return { ...account, creds, profile };
  }));

  for (const entry of enriched) {
    const status = entry.creds.token ? 'authenticated' : 'not authenticated';
    const userInfo = formatUserInfo(entry.profile);
    const priLabel = entry.priority != null ? ` (priority: ${entry.priority})` : '';
    console.log(`  ${entry.name}${userInfo}${priLabel}`);
    console.log(`    Config: ${entry.configDir}`);
    console.log(`    Status: ${status}`);
    console.log('');
  }
}

async function cmdStatus() {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    console.log('No accounts registered.');
    return;
  }

  console.log('Checking usage for all accounts...\n');

  const accountsWithTokens = accounts.map(a => {
    const creds = readCredentials(a.configDir);
    return { ...a, token: creds.token };
  });

  const authenticated = accountsWithTokens.filter(a => a.token);
  const unauthenticated = accountsWithTokens.filter(a => !a.token);

  if (authenticated.length > 0) {
    let [withUsage, profiles] = await Promise.all([
      checkAllUsage(authenticated),
      Promise.all(authenticated.map(a => fetchProfile(a.token))),
    ]);

    // Silent refresh for auth errors
    const rejected = withUsage.filter(a =>
      a.usage?.error === 'HTTP 401' || a.usage?.error === 'HTTP 403'
    );
    if (rejected.length > 0) {
      for (const account of rejected) {
        if (await silentRefresh(account)) {
          const creds = readCredentials(account.configDir);
          if (creds.token) {
            account.token = creds.token;
            account.usage = await checkUsage(creds.token);
            const idx = authenticated.findIndex(a => a.name === account.name);
            if (idx !== -1) profiles[idx] = await fetchProfile(creds.token);
          }
        }
      }
    }

    const profileMap = Object.fromEntries(authenticated.map((a, i) => [a.name, profiles[i]]));
    const best = pickBestAccount(withUsage);
    const bestName = best?.account?.name;

    for (const account of withUsage) {
      const isBest = account.name === bestName;
      const marker = isBest ? '  <-- best' : '';
      const userInfo = formatUserInfo(profileMap[account.name] || {});
      const priLabel = account.priority != null ? ` (priority: ${account.priority})` : '';

      console.log(`  ${account.name}${userInfo}${priLabel}${marker}`);

      if (account.usage.error) {
        console.log(`    Usage: error (${account.usage.error})`);
      } else {
        const sessionBar = makeBar(account.usage.sessionPercent);
        const weeklyBar = makeBar(account.usage.weeklyPercent);
        console.log(`    5-hour:  ${sessionBar} ${account.usage.sessionPercent}%`);
        console.log(`    7-day:   ${weeklyBar} ${account.usage.weeklyPercent}%`);

        if (account.usage.sessionResetsAt) {
          console.log(`    Session resets: ${formatResetTime(account.usage.sessionResetsAt)}`);
        }
        if (account.usage.weeklyResetsAt) {
          console.log(`    Weekly resets:  ${formatResetTime(account.usage.weeklyResetsAt)}`);
        }
      }
      console.log('');
    }
  }

  if (unauthenticated.length > 0) {
    console.log('  Not authenticated:');
    for (const account of unauthenticated) {
      console.log(`    ${account.name} (${account.configDir})`);
    }
    console.log('');
  }
}

async function cmdReauth() {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    console.log('No accounts registered.');
    return;
  }

  console.log('Checking account credentials...\n');

  const accountsWithTokens = accounts.map(a => {
    const creds = readCredentials(a.configDir);
    return { ...a, token: creds.token, expiresAt: creds.expiresAt, error: creds.error };
  });

  const withTokens = accountsWithTokens.filter(a => a.token);
  const noTokens = accountsWithTokens.filter(a => !a.token);

  const localExpired = withTokens.filter(a => isTokenExpired({ expiresAt: a.expiresAt }));
  const toCheck = withTokens.filter(a => !isTokenExpired({ expiresAt: a.expiresAt }));

  let expired = [...noTokens, ...localExpired];
  if (toCheck.length > 0) {
    const withUsage = await checkAllUsage(toCheck);
    for (const a of withUsage) {
      if (a.usage?.error) expired.push(a);
    }
  }

  if (expired.length === 0) {
    console.log('All accounts are authenticated and working.');
    return;
  }

  console.log(`Found ${expired.length} account(s) needing re-authentication:\n`);
  for (const a of expired) {
    const reason = a.token
      ? (isTokenExpired({ expiresAt: a.expiresAt }) ? 'token expired' : `API error (${a.usage?.error || 'unknown'})`)
      : (a.error || 'no credentials');
    console.log(`  ${a.name}: ${reason}`);
  }
  console.log('');

  let successCount = 0;
  const stillExpired = [];
  const silentCandidates = expired.filter(a => a.token);

  if (silentCandidates.length > 0) {
    console.log('Attempting silent token refresh...');
    for (const account of silentCandidates) {
      if (await silentRefresh(account)) {
        console.log(`  ${account.name}: refreshed`);
        successCount++;
      } else {
        stillExpired.push(account);
      }
    }
    stillExpired.push(...expired.filter(a => !a.token));
    console.log('');
  } else {
    stillExpired.push(...expired);
  }

  for (let i = 0; i < stillExpired.length; i++) {
    console.log(`[${i + 1}/${stillExpired.length}]`);
    const success = await reauthAccount(stillExpired[i]);
    if (success) successCount++;
    console.log('');
  }

  console.log(`Re-authentication complete. ${successCount}/${expired.length} account(s) refreshed.`);
  console.log('Run "claude-switch status" to verify.');
}

async function cmdRun(claudeArgs) {
  const requestedAccount = extractAccountFlag(claudeArgs);

  const accounts = getAccounts();
  if (accounts.length === 0) {
    console.error('No accounts registered. Run "claude-switch add <name>" first.');
    process.exit(1);
  }

  let accountsWithCreds = accounts.map(a => {
    const creds = readCredentials(a.configDir);
    return { ...a, token: creds.token, expiresAt: creds.expiresAt };
  });

  // Pre-flight: refresh expired tokens
  const expiredPreFlight = accountsWithCreds.filter(a =>
    !a.token || (a.expiresAt && isTokenExpired({ expiresAt: a.expiresAt }))
  );
  if (expiredPreFlight.length > 0) {
    const refreshed = await reauthExpiredAccounts(expiredPreFlight);
    if (refreshed.length > 0) {
      accountsWithCreds = accounts.map(a => {
        const creds = readCredentials(a.configDir);
        return { ...a, token: creds.token, expiresAt: creds.expiresAt };
      });
    }
  }

  const authenticated = accountsWithCreds.filter(a => a.token);
  if (authenticated.length === 0) {
    console.error('No authenticated accounts. Run "claude-switch add <name>" to add one.');
    process.exit(1);
  }

  let selectedAccount;

  if (requestedAccount) {
    selectedAccount = authenticated.find(a => a.name === requestedAccount);
    if (!selectedAccount) {
      console.error(`Error: Account "${requestedAccount}" not found or not authenticated.`);
      console.error(`Authenticated accounts: ${authenticated.map(a => a.name).join(', ')}`);
      process.exit(1);
    }
    console.error(`[claude-switch] Using requested account "${selectedAccount.name}"`);
  } else if (authenticated.length === 1) {
    selectedAccount = authenticated[0];
    console.error(`[claude-switch] Using account "${selectedAccount.name}"`);
  } else {
    console.error('[claude-switch] Checking usage across accounts...');
    const withUsage = await checkAllUsage(authenticated);

    const apiExpired = withUsage.filter(a =>
      a.usage?.error === 'HTTP 401' || a.usage?.error === 'HTTP 403'
    );
    if (apiExpired.length > 0) {
      const refreshed = await reauthExpiredAccounts(apiExpired);
      if (refreshed.length > 0) {
        const updatedAccounts = accounts.map(a => {
          const creds = readCredentials(a.configDir);
          return { ...a, token: creds.token };
        }).filter(a => a.token);
        const updatedUsage = await checkAllUsage(updatedAccounts);
        for (const updated of updatedUsage) {
          const idx = withUsage.findIndex(a => a.name === updated.name);
          if (idx !== -1) withUsage[idx] = updated;
          else withUsage.push(updated);
        }
      }
    }

    const hasPriorities = withUsage.some(a => a.priority != null);
    const best = pickBestAccount(withUsage, undefined, { usePriority: hasPriorities });

    if (best) {
      selectedAccount = best.account;
      console.error(`[claude-switch] Selected "${selectedAccount.name}" (${best.reason})`);
    } else {
      selectedAccount = authenticated[0];
      console.error(`[claude-switch] Defaulting to "${selectedAccount.name}"`);
    }
  }

  await run(claudeArgs, selectedAccount, accounts);
}

async function cmdResume(resumeArgs) {
  const requestedAccount = extractAccountFlag(resumeArgs);

  const accounts = getAccounts();
  if (accounts.length === 0) {
    console.error('No accounts registered. Run "claude-switch add <name>" first.');
    process.exit(1);
  }

  const { findSessionAcrossProfiles, findLatestSessionAcrossProfiles, migrateSessionByHash } = await import('../lib/session.js');

  const sessionIdArg = resumeArgs.find(a => !a.startsWith('-'));
  let found;

  if (sessionIdArg) {
    console.error(`[claude-switch] Searching for session ${sessionIdArg}...`);
    found = findSessionAcrossProfiles(accounts, sessionIdArg);
    if (!found) {
      console.error(`Error: Session "${sessionIdArg}" not found in any account.`);
      process.exit(1);
    }
  } else {
    console.error('[claude-switch] Searching for most recent session in this project...');
    found = findLatestSessionAcrossProfiles(accounts, process.cwd());
    if (!found) {
      console.error('Error: No sessions found for this project in any account.');
      process.exit(1);
    }
  }

  const sessionId = sessionIdArg || found.sessionId;
  console.error(`[claude-switch] Found session ${sessionId} in account "${found.account.name}"`);

  const claudeArgs = ['--resume', sessionId];

  let accountsWithCreds = accounts.map(a => {
    const creds = readCredentials(a.configDir);
    return { ...a, token: creds.token, expiresAt: creds.expiresAt };
  });

  const expiredPreFlight = accountsWithCreds.filter(a =>
    !a.token || (a.expiresAt && isTokenExpired({ expiresAt: a.expiresAt }))
  );
  if (expiredPreFlight.length > 0) {
    const refreshed = await reauthExpiredAccounts(expiredPreFlight);
    if (refreshed.length > 0) {
      accountsWithCreds = accounts.map(a => {
        const creds = readCredentials(a.configDir);
        return { ...a, token: creds.token, expiresAt: creds.expiresAt };
      });
    }
  }

  const authenticated = accountsWithCreds.filter(a => a.token);
  if (authenticated.length === 0) {
    console.error('No authenticated accounts. Run "claude-switch add <name>" to add one.');
    process.exit(1);
  }

  let selectedAccount;

  if (requestedAccount) {
    selectedAccount = authenticated.find(a => a.name === requestedAccount);
    if (!selectedAccount) {
      console.error(`Error: Account "${requestedAccount}" not found or not authenticated.`);
      process.exit(1);
    }
  } else if (authenticated.length === 1) {
    selectedAccount = authenticated[0];
  } else {
    const withUsage = await checkAllUsage(authenticated);
    const hasPriorities = withUsage.some(a => a.priority != null);
    const best = pickBestAccount(withUsage, undefined, { usePriority: hasPriorities });
    selectedAccount = best?.account || authenticated[0];
  }

  // Migrate session to selected account if needed
  if (found.account.configDir !== selectedAccount.configDir) {
    console.error(`[claude-switch] Migrating session from "${found.account.name}" to "${selectedAccount.name}"...`);
    const result = migrateSessionByHash(found.account.configDir, selectedAccount.configDir, found.cwdHash, sessionId);
    if (!result.success) {
      console.error(`[claude-switch] Migration failed: ${result.error}`);
      selectedAccount = found.account;
    }
  }

  await run(claudeArgs, selectedAccount, accounts);
}

async function cmdUse(useArgs) {
  const flag = useArgs[0];

  if (!flag) {
    const current = process.env.CLAUDE_CONFIG_DIR;
    if (current) {
      const accounts = getAccounts();
      const match = accounts.find(a => a.configDir === current);
      const label = match ? match.name : 'unknown';
      console.error(`Current: ${label} (${current})`);
    } else {
      console.error(`Current: default (${DEFAULT_CLAUDE_DIR})`);
    }
    return;
  }

  if (flag === '--unset') {
    console.log('unset CLAUDE_CONFIG_DIR');
    console.error(`Reverted to default account (${DEFAULT_CLAUDE_DIR})`);
    return;
  }

  if (flag === '--best') {
    const accounts = getAccounts();
    const withCreds = accounts.map(a => ({ ...a, token: readCredentials(a.configDir).token }));
    const authenticated = withCreds.filter(a => a.token);
    if (authenticated.length === 0) { console.error('Error: No authenticated accounts.'); process.exit(1); }
    const withUsage = await checkAllUsage(authenticated);
    const best = pickBestAccount(withUsage);
    if (!best) { console.error('Error: No suitable accounts found.'); process.exit(1); }
    console.log(`export CLAUDE_CONFIG_DIR='${best.account.configDir}'`);
    console.error(`Switched to "${best.account.name}" (${best.reason})`);
    return;
  }

  if (flag === '--priority') {
    const accounts = getAccounts();
    const withCreds = accounts.map(a => ({ ...a, token: readCredentials(a.configDir).token }));
    const authenticated = withCreds.filter(a => a.token);
    if (authenticated.length === 0) { console.error('Error: No authenticated accounts.'); process.exit(1); }
    const withUsage = await checkAllUsage(authenticated);
    const best = pickByPriority(withUsage);
    if (!best) { console.error('Error: No suitable accounts found.'); process.exit(1); }
    console.log(`export CLAUDE_CONFIG_DIR='${best.account.configDir}'`);
    console.error(`Switched to "${best.account.name}" (${best.reason})`);
    return;
  }

  const name = flag;
  const accounts = getAccounts();
  const account = accounts.find(a => a.name === name);
  if (!account) {
    console.error(`Error: Account "${name}" not found.`);
    console.error(`Available: ${accounts.map(a => a.name).join(', ')}`);
    process.exit(1);
  }

  const creds = readCredentials(account.configDir);
  if (!creds.token) {
    console.error(`Warning: Account "${name}" is not authenticated. Run "claude-switch reauth" first.`);
  }

  console.log(`export CLAUDE_CONFIG_DIR='${account.configDir}'`);
  console.error(`Switched to "${account.name}" (${account.configDir})`);
}

async function cmdSetPriority(priorityArgs) {
  const name = priorityArgs[0];
  const priorityStr = priorityArgs[1];

  if (!name) {
    console.error('Usage: claude-switch set-priority <account> <number>');
    console.error('       claude-switch set-priority <account> clear');
    process.exit(1);
  }

  try {
    if (priorityStr === 'clear') {
      clearAccountPriority(name);
      console.log(`Priority cleared for "${name}".`);
    } else if (!priorityStr) {
      console.error('Usage: claude-switch set-priority <account> <number>');
      process.exit(1);
    } else {
      const priority = parseInt(priorityStr, 10);
      if (isNaN(priority)) { console.error('Error: Priority must be a positive integer.'); process.exit(1); }
      setAccountPriority(name, priority);
      console.log(`Priority for "${name}" set to ${priority}.`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function cmdInit(shell) {
  if (!shell || !['bash', 'zsh'].includes(shell)) {
    console.error('Usage: claude-switch init <bash|zsh>');
    console.error('');
    console.error('Add to your shell config:');
    console.error('  eval "$(claude-switch init bash)"   # ~/.bashrc');
    console.error('  eval "$(claude-switch init zsh)"    # ~/.zshrc');
    process.exit(1);
  }

  console.log(`
claude-switch() {
  if [ "\$1" = "use" ] && [ \$# -gt 1 ]; then
    local shell_code
    shell_code="\$(command claude-switch "\$@")"
    local exit_code=\$?
    if [ \$exit_code -eq 0 ] && [ -n "\$shell_code" ]; then
      eval "\$shell_code"
    fi
    return \$exit_code
  else
    command claude-switch "\$@"
  fi
}
`.trim());
}

async function cmdUpdate() {
  function isClauseSwitchRepo(dir) {
    try {
      if (!existsSync(join(dir, 'package.json'))) return false;
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name !== 'claude-switch') return false;
      execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'pipe' });
      return true;
    } catch { return false; }
  }

  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    join(home, 'code', 'claude-switch'),
    join(home, 'src', 'claude-switch'),
    join(home, 'projects', 'claude-switch'),
    join(home, 'dev', 'claude-switch'),
    'C:\\Portable\\claude-switch',
  ];

  let repoDir = candidates.find(isClauseSwitchRepo);

  if (!repoDir) {
    console.error('Could not find the claude-switch git repo.');
    console.error('Checked: ' + candidates.join(', '));
    process.exit(1);
  }

  console.log(`Updating from ${repoDir}...\n`);

  try {
    const remotes = execFileSync('git', ['remote'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    if (remotes) {
      console.log(`Tip: Run "cd ${repoDir} && git pull" first to get the latest changes.\n`);
    }
  } catch {}

  try {
    const tgz = execFileSync('npm', ['pack'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    const tgzPath = join(repoDir, tgz);
    execFileSync('npm', ['install', '-g', tgzPath], { encoding: 'utf8', stdio: 'pipe' });
    console.log(`Installed ${tgz}`);
  } catch (err) {
    console.error(`npm install failed: ${err.message}`);
    process.exit(1);
  }

  console.log('\nUpdate complete.');
}

function printHelp() {
  console.log(`
claude-switch — Automatic Claude Code account switching on rate limits

USAGE
  claude-switch [claude-args]       Run Claude with auto account switching
  claude-switch <command> [args]

COMMANDS
  add <name>                  Add and authenticate an account
  remove <name>               Remove a registered account
  list                        List all registered accounts
  status                      Show usage for all accounts
  reauth                      Re-authenticate expired accounts
  resume [session-id]         Resume a session, finding it across accounts
  use <name|--best|--unset>   Manually select an account (shell integration)
  set-priority <name> <n>     Set account priority (1 = highest)
  set-priority <name> clear   Clear account priority
  init <bash|zsh>             Print shell integration function
  update                      Reinstall from local git repo
  help                        Show this help

RUN OPTIONS
  --account <name>, -a <name>   Force a specific account

SHELL INTEGRATION
  Add to ~/.bashrc or ~/.zshrc:
    eval "\$(claude-switch init bash)"

  Then use: claude-switch use work
           claude-switch use --best
           claude-switch use --unset

FIRST USE
  claude-switch status          # Detects existing Claude auth automatically
  claude-switch add work        # Add a second account
  claude-switch                 # Run Claude — switches accounts on rate limits
`.trim());
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatUserInfo(profile) {
  if (profile?.email) return ` <${profile.email}>`;
  if (profile?.name) return ` (${profile.name})`;
  return '';
}

function makeBar(percent) {
  const filled = Math.round(percent / 5);
  const empty = 20 - filled;
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

function formatResetTime(isoString) {
  try {
    const d = new Date(isoString);
    const countdown = formatCountdown(d - Date.now());
    return `${d.toLocaleString()}  (${countdown})`;
  } catch {
    return isoString;
  }
}

function formatCountdown(ms) {
  if (ms <= 0) return 'now';
  const totalMinutes = Math.floor(ms / 60000);
  const days    = Math.floor(totalMinutes / 1440);
  const hours   = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0)  return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

function extractAccountFlag(args) {
  for (const flag of ['--account', '-a']) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      const name = args[idx + 1];
      args.splice(idx, 2);
      return name;
    }
  }
  return null;
}
