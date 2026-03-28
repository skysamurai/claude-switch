import { platform } from 'os';

export function isMacOS() {
  return platform() === 'darwin';
}

export function isLinux() {
  return platform() === 'linux';
}

export function isWindows() {
  return platform() === 'win32';
}
