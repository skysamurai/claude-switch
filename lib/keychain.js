/**
 * Credential reading and token refresh for OS-specific secure storage.
 *
 * macOS: Keychain via `security find-generic-password` / `add-generic-password`
 * Linux: Secret Service via `secret-tool` or ~/.credentials.json fallback
 *
 * Service name format:
 * - Default (~/.claude): "Claude Code-credentials"
 * - Custom dirs: "Claude Code-credentials-{sha256_8(expandedPath)}"
 *
 * Token refresh uses the same OAuth endpoint and client ID as Claude Code CLI,
 * so both tools share the same credentials in the keychain seamlessly.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { homedir, userInfo } from 'os';
import { join, normalize } from 'path';
import { isMacOS, isLinux, isWindows } from './platform.js';
import { DEFAULT_CLAUDE_DIR } from './config.js';

const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_TIMEOUT_MS = 10_000;

/**
 * Get the macOS Keychain account name.
 *
 * Claude Code CLI uses the system username (e.g. "rc") as the `-a` account
 * field. We must match this exactly, otherwise `add-generic-password -U`
 * creates a second entry instead of updating the existing one, and
 * `find-generic-password` without `-a` returns whichever entry it finds
 * first — leading to stale-token bugs after silent refresh.
 */
function getKeychainAccount() {
  return userInfo().username;
}

/**
 * Compute the 8-char SHA256 hash suffix for a config directory.
 * Matches Claude Code CLI's hash computation.
 */
export function calculateConfigDirHash(configDir) {
  const expanded = expandPath(configDir);
  return createHash('sha256').update(expanded).digest('hex').slice(0, 8);
}

/**
 * Expand ~ to homedir and normalize the path.
 */
export function expandPath(p) {
  const expanded = p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
  return normalize(expanded);
}

/**
 * Get the Keychain service name for a config directory.
 *
 * Default (~/.claude) uses "Claude Code-credentials" (no hash) —
 * this matches the standard Claude Code CLI behavior.
 * Custom dirs use "Claude Code-credentials-{hash}" for isolation.
 */
export function getServiceName(configDir) {
  const expanded = expandPath(configDir);

  if (expanded === DEFAULT_CLAUDE_DIR) {
    return 'Claude Code-credentials';
  }

  const hash = calculateConfigDirHash(configDir);
  return `Claude Code-credentials-${hash}`;
}

/**
 * Read OAuth credentials from the platform credential store.
 *
 * @param {string} configDir - The CLAUDE_CONFIG_DIR path
 * @returns {{ token: string|null, email: string|null, name: string|null, error: string|null }}
 */
export function readCredentials(configDir) {
  if (isMacOS()) {
    return readFromMacKeychain(configDir);
  }
  if (isLinux()) {
    return readFromLinux(configDir);
  }
  if (isWindows()) {
    return readFromWindows(configDir);
  }
  return { token: null, email: null, name: null, expiresAt: null, error: 'unsupported_platform' };
}

/**
 * macOS: Read from Keychain using `security` command.
 */
function readFromMacKeychain(configDir) {
  const serviceName = getServiceName(configDir);

  try {
    const raw = execFileSync('security', [
      'find-generic-password',
      '-s', serviceName,
      '-a', getKeychainAccount(),
      '-w'
    ], { encoding: 'utf-8', timeout: 5000 }).trim();

    return parseCredentialJson(raw);
  } catch (error) {
    // Exit code 44 = errSecItemNotFound (item not in keychain)
    if (error?.status === 44) {
      return { token: null, email: null, name: null, expiresAt: null, error: 'not_found' };
    }
    return { token: null, email: null, name: null, expiresAt: null, error: error.message };
  }
}

/**
 * Linux: Try secret-tool first, fall back to .credentials.json file.
 */
function readFromLinux(configDir) {
  const expanded = expandPath(configDir);
  const serviceName = getServiceName(configDir);

  // Try secret-tool (GNOME Keyring / KDE Wallet)
  try {
    const raw = execFileSync('secret-tool', [
      'lookup',
      'service', serviceName
    ], { encoding: 'utf-8', timeout: 5000 }).trim();

    if (raw) return parseCredentialJson(raw);
  } catch {
    // Fall through to file-based
  }

  // Fall back to .credentials.json
  const credFile = join(expanded, '.credentials.json');
  if (existsSync(credFile)) {
    try {
      const raw = readFileSync(credFile, 'utf-8');
      return parseCredentialJson(raw);
    } catch {
      return { token: null, email: null, name: null, expiresAt: null, error: 'parse_failed' };
    }
  }

  return { token: null, email: null, name: null, expiresAt: null, error: 'not_found' };
}

/**
 * Windows: Read from Windows Credential Manager via PowerShell, with
 * .credentials.json fallback (same directory layout as Linux).
 */
function readFromWindows(configDir) {
  const serviceName = getServiceName(configDir);

  // Try Windows Credential Manager
  const raw = readFromWindowsCredentialManager(serviceName);
  if (raw) return parseCredentialJson(raw);

  // Fall back to .credentials.json
  const credFile = join(expandPath(configDir), '.credentials.json');
  if (existsSync(credFile)) {
    try {
      return parseCredentialJson(readFileSync(credFile, 'utf-8'));
    } catch {
      return { token: null, email: null, name: null, expiresAt: null, error: 'parse_failed' };
    }
  }

  return { token: null, email: null, name: null, expiresAt: null, error: 'not_found' };
}

/**
 * Read a credential blob from Windows Credential Manager using PowerShell.
 * Returns the raw JSON string, or null if not found / on error.
 */
function readFromWindowsCredentialManager(serviceName) {
  // Escape the service name for safe embedding in a PS double-quoted string
  const safeTarget = serviceName.replace(/'/g, "''");
  const psScript = `
try { Add-Type -ErrorAction SilentlyContinue @'
using System; using System.Runtime.InteropServices;
public class WinCredNS {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, uint type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr buffer);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName;
    public string Comment; public long LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount;
    public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
}
'@ } catch {}
$ptr = [IntPtr]::Zero
if ([WinCredNS]::CredRead('${safeTarget}', 1, 0, [ref]$ptr)) {
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][WinCredNS+CREDENTIAL])
  $b = New-Object byte[] $c.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $c.CredentialBlobSize)
  [WinCredNS]::CredFree($ptr)
  [Text.Encoding]::Unicode.GetString($b)
}`;

  try {
    const result = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command', psScript
    ], { encoding: 'utf-8', timeout: 15000 }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Write a credential blob to Windows Credential Manager using PowerShell.
 * Uses a temp file to avoid command-line injection with the JSON payload.
 */
function writeToWindowsCredentialManager(serviceName, jsonString) {
  const tmpFile = join(expandPath(homedir()), `.wincred-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmpFile, jsonString, { encoding: 'utf-8' });
    const safeTarget = serviceName.replace(/'/g, "''");
    const safeTmp = tmpFile.replace(/'/g, "''");
    const psScript = `
try { Add-Type -ErrorAction SilentlyContinue @'
using System; using System.Runtime.InteropServices;
public class WinCredNSW {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName;
    public string Comment; public long LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount;
    public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
}
'@ } catch {}
$json = [IO.File]::ReadAllText('${safeTmp}')
$bytes = [Text.Encoding]::Unicode.GetBytes($json)
$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
$cred = New-Object WinCredNSW+CREDENTIAL
$cred.Type = 1; $cred.TargetName = '${safeTarget}'
$cred.CredentialBlobSize = $bytes.Length; $cred.CredentialBlob = $ptr; $cred.Persist = 2
$ok = [WinCredNSW]::CredWrite([ref]$cred, 0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
if (-not $ok) { exit 1 }`;

    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command', psScript
    ], { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  } finally {
    try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Parse the credential JSON blob and extract token + email.
 *
 * Claude Code stores credentials as:
 * {
 *   "claudeAiOauth": {
 *     "accessToken": "sk-ant-oat01-...",
 *     "refreshToken": "sk-ant-ort01-...",
 *     "email": "user@example.com",
 *     "expiresAt": 1234567890000
 *   }
 * }
 */
export function parseCredentialJson(raw) {
  try {
    const data = JSON.parse(raw);
    const oauth = data?.claudeAiOauth;

    if (!oauth) {
      return { token: null, email: null, name: null, expiresAt: null, error: 'no_oauth_data' };
    }

    const token = oauth.accessToken || null;
    const email = oauth.email || oauth.emailAddress || data?.email || null;
    const name = oauth.name || oauth.fullName || oauth.displayName || data?.name || null;
    const expiresAt = oauth.expiresAt || null;

    if (token && !token.startsWith('sk-ant-')) {
      return { token: null, email, name, expiresAt, error: 'invalid_token_format' };
    }

    return { token, email, name, expiresAt, error: null };
  } catch {
    return { token: null, email: null, name: null, expiresAt: null, error: 'parse_failed' };
  }
}

/**
 * Read the raw credential JSON blob from the credential store.
 * Returns the full JSON string, not parsed — needed for read-modify-write.
 *
 * @param {string} configDir - The CLAUDE_CONFIG_DIR path
 * @returns {string|null} Raw JSON string or null if not found
 */
function readRawCredentialBlob(configDir) {
  const serviceName = getServiceName(configDir);

  if (isMacOS()) {
    try {
      return execFileSync('security', [
        'find-generic-password', '-s', serviceName, '-a', getKeychainAccount(), '-w'
      ], { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch {
      return null;
    }
  }

  if (isLinux()) {
    try {
      const raw = execFileSync('secret-tool', [
        'lookup', 'service', serviceName
      ], { encoding: 'utf-8', timeout: 5000 }).trim();
      if (raw) return raw;
    } catch { /* fall through */ }

    const expanded = expandPath(configDir);
    const credFile = join(expanded, '.credentials.json');
    if (existsSync(credFile)) {
      try { return readFileSync(credFile, 'utf-8'); } catch { /* fall through */ }
    }
  }

  if (isWindows()) {
    const raw = readFromWindowsCredentialManager(serviceName);
    if (raw) return raw;

    const credFile = join(expandPath(configDir), '.credentials.json');
    if (existsSync(credFile)) {
      try { return readFileSync(credFile, 'utf-8'); } catch { /* fall through */ }
    }
  }

  return null;
}

/**
 * Write a credential JSON blob back to the credential store.
 * Both Claude Code and claude-nonstop share the same keychain entries.
 *
 * @param {string} configDir - The CLAUDE_CONFIG_DIR path
 * @param {string} jsonString - The full credential JSON to write
 * @returns {{ written: boolean, error: string|null }}
 */
function writeCredentialBlob(configDir, jsonString) {
  const serviceName = getServiceName(configDir);

  if (isMacOS()) {
    try {
      // -U flag updates existing entry (or creates if missing)
      execFileSync('security', [
        'add-generic-password',
        '-s', serviceName,
        '-a', getKeychainAccount(),
        '-w', jsonString,
        '-U'
      ], { stdio: 'pipe', timeout: 5000 });
      return { written: true, error: null };
    } catch (error) {
      return { written: false, error: error.message };
    }
  }

  if (isLinux()) {
    // Write to .credentials.json (atomic write)
    const expanded = expandPath(configDir);
    const credFile = join(expanded, '.credentials.json');
    try {
      const tmpFile = `${credFile}.${process.pid}.tmp`;
      writeFileSync(tmpFile, jsonString, { mode: 0o600 });
      renameSync(tmpFile, credFile);
      return { written: true, error: null };
    } catch (error) {
      return { written: false, error: error.message };
    }
  }

  if (isWindows()) {
    // Write to Windows Credential Manager (so Claude Code CLI can read it back)
    const wcmOk = writeToWindowsCredentialManager(serviceName, jsonString);

    // Also write .credentials.json as a local cache / fallback
    const expanded = expandPath(configDir);
    const credFile = join(expanded, '.credentials.json');
    try {
      const tmpFile = `${credFile}.${process.pid}.tmp`;
      writeFileSync(tmpFile, jsonString);
      renameSync(tmpFile, credFile);
      return { written: true, error: null };
    } catch (error) {
      if (wcmOk) return { written: true, error: null };
      return { written: false, error: error.message };
    }
  }

  return { written: false, error: 'unsupported_platform' };
}

/**
 * Refresh an expired access token using the OAuth refresh token.
 *
 * Uses the same endpoint and client ID as Claude Code CLI, so the refreshed
 * tokens are written back to the shared keychain entry. Both Claude Code and
 * claude-nonstop will see the fresh tokens.
 *
 * Refresh tokens are single-use — the new refresh token MUST be saved back.
 *
 * @param {string} configDir - The CLAUDE_CONFIG_DIR path
 * @returns {Promise<{ token: string|null, email: string|null, name: string|null, expiresAt: number|null, error: string|null }>}
 */
export async function refreshAccessToken(configDir) {
  const raw = readRawCredentialBlob(configDir);
  if (!raw) {
    return { token: null, email: null, name: null, expiresAt: null, error: 'no_credentials' };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { token: null, email: null, name: null, expiresAt: null, error: 'parse_failed' };
  }

  const refreshToken = data?.claudeAiOauth?.refreshToken;
  if (!refreshToken) {
    return { token: null, email: null, name: null, expiresAt: null, error: 'no_refresh_token' };
  }

  // Call the OAuth token endpoint
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { token: null, email: null, name: null, expiresAt: null, error: body.error || `HTTP ${res.status}` };
    }

    const tokens = await res.json();
    if (!tokens.access_token) {
      return { token: null, email: null, name: null, expiresAt: null, error: 'no_access_token_in_response' };
    }

    // Update the credential blob with new tokens
    data.claudeAiOauth.accessToken = tokens.access_token;
    if (tokens.refresh_token) {
      data.claudeAiOauth.refreshToken = tokens.refresh_token;
    }
    data.claudeAiOauth.expiresAt = Date.now() + (tokens.expires_in * 1000);

    // Write back to keychain immediately (refresh tokens are single-use)
    const writeResult = writeCredentialBlob(configDir, JSON.stringify(data));
    if (!writeResult.written) {
      return { token: null, email: null, name: null, expiresAt: null, error: `keychain_write_failed: ${writeResult.error}` };
    }

    return parseCredentialJson(JSON.stringify(data));
  } catch (error) {
    return { token: null, email: null, name: null, expiresAt: null, error: error.name === 'AbortError' ? 'timeout' : error.message };
  }
}

/**
 * Delete a keychain entry for a config directory.
 *
 * @param {string} configDir - The CLAUDE_CONFIG_DIR path
 * @returns {{ deleted: boolean, error: string|null }}
 */
export function deleteKeychainEntry(configDir) {
  const serviceName = getServiceName(configDir);

  if (isMacOS()) {
    try {
      execFileSync('security', [
        'delete-generic-password',
        '-s', serviceName,
        '-a', getKeychainAccount()
      ], { stdio: 'pipe', timeout: 5000 });
      return { deleted: true, error: null };
    } catch (error) {
      // Exit code 44 = errSecItemNotFound
      if (error?.status === 44) {
        return { deleted: false, error: null };
      }
      return { deleted: false, error: error.message };
    }
  }

  if (isLinux()) {
    // File-based .credentials.json lives inside the profile dir,
    // which gets removed by rmSync. Only need to clear secret-tool.
    try {
      execFileSync('secret-tool', [
        'clear',
        'service', serviceName
      ], { stdio: 'pipe', timeout: 5000 });
      return { deleted: true, error: null };
    } catch {
      // secret-tool may not be installed or entry may not exist
      return { deleted: false, error: null };
    }
  }

  if (isWindows()) {
    const safeTarget = serviceName.replace(/'/g, "''");
    const psScript = `
try { Add-Type -ErrorAction SilentlyContinue @'
using System.Runtime.InteropServices;
public class WinCredNSD {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredDelete(string target, uint type, int flags);
}
'@ } catch {}
[WinCredNSD]::CredDelete('${safeTarget}', 1, 0) | Out-Null`;
    try {
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command', psScript
      ], { stdio: 'pipe', timeout: 10000 });
    } catch { /* non-fatal */ }
    return { deleted: true, error: null };
  }

  return { deleted: false, error: 'unsupported_platform' };
}

/**
 * Check if credentials have an expired access token.
 *
 * @param {{ expiresAt: number|null }} creds - Credentials from readCredentials()
 * @returns {boolean}
 */
export function isTokenExpired(creds) {
  if (!creds.expiresAt) return false;
  return creds.expiresAt < Date.now();
}
