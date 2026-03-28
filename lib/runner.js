/**
 * Process runner — spawns Claude Code, monitors output for rate limits,
 * and automatically switches accounts with session migration.
 *
 * Flow:
 * 1. Spawn `claude` with CLAUDE_CONFIG_DIR pointing to selected account
 * 2. Pipe stdout/stderr through to the user's terminal (real-time pass-through)
 * 3. Simultaneously scan output for rate limit patterns
 * 4. On rate limit detection:
 *    a. Kill the paused Claude process
 *    b. Find the active session file
 *    c. Migrate session to the next best account's config dir
 *    d. Resume with `claude --resume <sessionId>` using the new account
 */

import * as pty from 'node-pty';
import { readCredentials } from './keychain.js';
import { checkAllUsage } from './usage.js';
import { pickBestAccount, effectiveUtilization } from './scorer.js';
import { findLatestSession, migrateSession } from './session.js';
import { reauthExpiredAccounts } from './reauth.js';
import { isWindows } from './platform.js';

/**
 * On Windows, `claude` is installed as `claude.cmd` which can't be spawned
 * directly by node-pty (requires a real .exe). We wrap it in cmd.exe /c.
 */
function resolveClaudeSpawn(claudeArgs) {
  if (isWindows()) {
    return { file: 'cmd.exe', args: ['/c', 'claude', ...claudeArgs] };
  }
  return { file: 'claude', args: claudeArgs };
}

/**
 * Rate limit detection pattern.
 * Claude Code outputs either:
 *   "Limit reached · resets Dec 17 at 6am (Europe/Oslo)"
 *   "You've hit your limit · resets 8am (America/Los_Angeles)"
 */
const RATE_LIMIT_PATTERN = /(?:Limit reached|You've hit your limit)\s*[·•]\s*resets\s+(.+?)(?:\s*$|\n)/im;

/** Maximum output buffer size before trimming (bytes). */
const OUTPUT_BUFFER_MAX = 4000;
/** Buffer trim target (bytes). */
const OUTPUT_BUFFER_TRIM = 2000;
/** Maximum number of account swaps before giving up. */
const MAX_SWAPS_DEFAULT = 5;
/** Message sent to auto-continue after rate-limit account switch. */
const RATE_LIMIT_CONTINUE_MSG = 'Continue.';
/** Time to wait before SIGKILL after SIGTERM (ms). */
const KILL_ESCALATION_DELAY = 3000;
/** Utilization threshold (%) at which all accounts are considered near-exhausted. */
const EXHAUSTION_THRESHOLD = 99;
/** Maximum sleep duration when waiting for a rate limit reset (6 hours). */
const MAX_SLEEP_MS = 6 * 60 * 60 * 1000;

// ─── ANSI Stripping ────────────────────────────────────────────────────────

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// ─── Sleep ─────────────────────────────────────────────────────────────────

/**
 * Sleep for the given number of milliseconds.
 * Interruptible: SIGINT or SIGTERM will resolve the sleep early.
 */
function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { cleanup(); resolve({ interrupted: false }); }, ms);

    function onSignal() { cleanup(); resolve({ interrupted: true }); }

    function cleanup() {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

function formatDuration(ms) {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function findEarliestReset(accounts, excludeName) {
  const now = Date.now();
  let earliest = Infinity;

  for (const a of accounts) {
    if (a.name === excludeName) continue;
    if (!a.usage) continue;
    for (const ts of [a.usage.sessionResetsAt, a.usage.weeklyResetsAt]) {
      if (!ts) continue;
      const resetMs = new Date(ts).getTime();
      if (!isNaN(resetMs) && resetMs > now && resetMs < earliest) earliest = resetMs;
    }
  }

  return earliest === Infinity ? 0 : earliest - now;
}

// ─── Main run loop ─────────────────────────────────────────────────────────

/**
 * Run Claude Code with automatic account switching.
 *
 * @param {string[]} claudeArgs - Arguments to pass to `claude`
 * @param {{ name: string, configDir: string }} selectedAccount - Account to use
 * @param {Array<{ name: string, configDir: string }>} allAccounts - All registered accounts
 * @param {{ maxSwaps?: number }} options
 */
export async function run(claudeArgs, selectedAccount, allAccounts, options = {}) {
  const maxSwaps = options.maxSwaps ?? Math.max(MAX_SWAPS_DEFAULT, allAccounts.length * 2);
  let currentAccount = selectedAccount;
  let swapCount = 0;
  let sessionId = extractResumeSessionId(claudeArgs);

  while (swapCount <= maxSwaps) {
    const result = await runOnce(claudeArgs, currentAccount, sessionId);

    if (result.exitCode !== null && !result.rateLimitDetected) {
      process.exitCode = result.exitCode;
      return;
    }

    if (!result.rateLimitDetected) {
      process.exitCode = result.exitCode ?? 1;
      return;
    }

    swapCount++;
    console.error(`\n[claude-switch] Rate limit detected on "${currentAccount.name}" (swap ${swapCount}/${maxSwaps})`);

    if (swapCount > maxSwaps) {
      console.error('[claude-switch] Maximum swap attempts reached. All accounts may be rate-limited.');
      process.exitCode = 1;
      return;
    }

    // Find the session to migrate
    const cwd = process.cwd();
    const session = result.sessionId
      ? { sessionId: result.sessionId }
      : findLatestSession(currentAccount.configDir, cwd);

    if (!session) {
      console.error('[claude-switch] Could not find session to migrate. Starting fresh on new account.');
    }

    // Pick the next best account
    const accountsWithTokens = allAccounts.map(a => ({
      ...a,
      token: readCredentials(a.configDir).token,
    })).filter(a => a.token);

    let accountsWithUsage = await checkAllUsage(accountsWithTokens);
    const hasPriorities = accountsWithUsage.some(a => a.priority != null);
    let best = pickBestAccount(accountsWithUsage, currentAccount.name, { usePriority: hasPriorities });

    // If all accounts near-exhausted, sleep until earliest reset
    if (best && effectiveUtilization(best.account.usage) >= EXHAUSTION_THRESHOLD) {
      const sleepMs = findEarliestReset(accountsWithUsage);
      if (sleepMs > 0) {
        const clampedMs = Math.min(sleepMs, MAX_SLEEP_MS);
        const resetDate = new Date(Date.now() + clampedMs);
        console.error(`[claude-switch] All accounts near limit. Sleeping until ${resetDate.toLocaleTimeString()} (${formatDuration(clampedMs)})...`);

        const { interrupted } = await sleep(clampedMs);
        if (interrupted) {
          console.error('\n[claude-switch] Sleep interrupted. Exiting.');
          process.exitCode = 130;
          return;
        }

        console.error('[claude-switch] Sleep complete. Re-checking account usage...');

        const refreshedTokens = allAccounts.map(a => ({
          ...a,
          token: readCredentials(a.configDir).token,
        })).filter(a => a.token);
        accountsWithUsage = await checkAllUsage(refreshedTokens);
        best = pickBestAccount(accountsWithUsage, undefined, { usePriority: hasPriorities });
        swapCount--;
      }
    }

    // If no accounts available, try re-auth
    if (!best) {
      const authErrors = accountsWithUsage.filter(a =>
        a.name !== currentAccount.name && a.usage?.error === 'HTTP 401'
      );
      if (authErrors.length > 0) {
        console.error('[claude-switch] Some accounts have expired tokens. Attempting re-auth...');
        const refreshed = await reauthExpiredAccounts(authErrors);
        if (refreshed.length > 0) {
          const updatedAccounts = allAccounts.map(a => ({
            ...a,
            token: readCredentials(a.configDir).token,
          })).filter(a => a.token);
          accountsWithUsage = await checkAllUsage(updatedAccounts);
          best = pickBestAccount(accountsWithUsage, currentAccount.name, { usePriority: hasPriorities });
        }
      }
    }

    if (!best) {
      console.error('[claude-switch] No alternative accounts available.');
      process.exitCode = 1;
      return;
    }

    const nextAccount = best.account;
    console.error(`[claude-switch] Switching to "${nextAccount.name}" (${best.reason})`);

    // Migrate session if we have one
    if (session) {
      const migration = migrateSession(
        currentAccount.configDir,
        nextAccount.configDir,
        cwd,
        session.sessionId
      );

      if (migration.success) {
        sessionId = session.sessionId;
        console.error(`[claude-switch] Session ${sessionId} migrated successfully`);
      } else {
        console.error(`[claude-switch] Session migration failed: ${migration.error}`);
        console.error('[claude-switch] Starting fresh session on new account');
        sessionId = null;
      }
    } else {
      sessionId = null;
    }

    if (sessionId) {
      claudeArgs = buildResumeArgs(claudeArgs, sessionId, RATE_LIMIT_CONTINUE_MSG);
    }

    currentAccount = nextAccount;
  }
}

// ─── runOnce ───────────────────────────────────────────────────────────────

function runOnce(claudeArgs, account, existingSessionId) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: account.configDir,
      FORCE_COLOR: '1',
    };
    delete env.CLAUDECODE;

    const { file, args: spawnArgs } = resolveClaudeSpawn(claudeArgs);
    const child = pty.spawn(file, spawnArgs, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env,
    });

    // Resize PTY when the real terminal resizes
    const onResize = () => {
      try { child.resize(process.stdout.columns, process.stdout.rows); } catch {}
    };
    process.stdout.on('resize', onResize);

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const onStdinData = (data) => child.write(data);
    process.stdin.on('data', onStdinData);
    process.stdin.on('error', () => {});

    let rateLimitDetected = false;
    let resetTime = null;
    let outputBuffer = '';

    child.onData((data) => {
      process.stdout.write(data);

      outputBuffer += data;
      if (outputBuffer.length > OUTPUT_BUFFER_MAX) {
        outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_TRIM);
      }

      if (rateLimitDetected) return;

      const match = RATE_LIMIT_PATTERN.exec(stripAnsi(outputBuffer));
      if (match) {
        rateLimitDetected = true;
        resetTime = match[1].trim();
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, KILL_ESCALATION_DELAY);
      }
    });

    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const signalHandlers = {};
    let cleaned = false;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;

      for (const sig of signals) process.removeListener(sig, signalHandlers[sig]);

      process.stdin.removeListener('data', onStdinData);
      process.stdin.pause();
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      process.stdout.removeListener('resize', onResize);
    }

    for (const sig of signals) {
      const handler = () => {
        if (!rateLimitDetected) {
          try { child.kill(sig); } catch {}
        }
      };
      signalHandlers[sig] = handler;
      process.on(sig, handler);
    }

    child.onExit(({ exitCode }) => {
      cleanup();
      resolve({
        exitCode: exitCode ?? null,
        rateLimitDetected,
        resetTime,
        sessionId: existingSessionId,
      });
    });
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractResumeSessionId(args) {
  for (const flag of ['--resume', '-r']) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  }
  return null;
}

const FLAGS_WITH_VALUES = new Set([
  '--append-system-prompt', '--model', '-m',
  '--allowedTools', '--disallowedTools',
]);

function buildResumeArgs(originalArgs, sessionId, continueMessage) {
  const args = [...originalArgs];

  for (const flag of ['--resume', '-r']) {
    const idx = args.indexOf(flag);
    if (idx !== -1) args.splice(idx, 2);
  }

  if (continueMessage) {
    const flagsOnly = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-')) {
        flagsOnly.push(args[i]);
        if (FLAGS_WITH_VALUES.has(args[i]) && i + 1 < args.length) {
          flagsOnly.push(args[++i]);
        }
      }
    }
    flagsOnly.unshift('--resume', sessionId);
    flagsOnly.push(continueMessage);
    return flagsOnly;
  }

  args.unshift('--resume', sessionId);
  return args;
}
