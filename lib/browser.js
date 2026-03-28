/**
 * Cross-platform browser utilities.
 *
 * Used to open the Claude logout page before adding a new account,
 * so the browser session is cleared and the user gets a fresh login prompt.
 */

import { execFileSync } from 'child_process';
import { isMacOS, isWindows } from './platform.js';

const CLAUDE_LOGOUT_URL = 'https://claude.ai/logout';

/**
 * Open a URL in the default browser.
 * Silently ignores errors (e.g., no browser available in headless environments).
 */
export function openUrl(url) {
  try {
    if (isWindows()) {
      execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore', timeout: 5000 });
    } else if (isMacOS()) {
      execFileSync('open', [url], { stdio: 'ignore', timeout: 5000 });
    } else {
      execFileSync('xdg-open', [url], { stdio: 'ignore', timeout: 5000 });
    }
  } catch {
    // Ignore — browser may not be available
  }
}

/**
 * Open the Claude logout page to clear the current browser session.
 * Call this before `claude auth login` when adding a second account,
 * so the user isn't silently re-authenticated as the wrong account.
 */
export function openLogout() {
  openUrl(CLAUDE_LOGOUT_URL);
}

/**
 * Sleep for ms milliseconds.
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
