import { safeStorage } from 'electron';

/**
 * API-key vault.
 *
 * The Android client seals the key with AES-256-GCM under an AndroidKeyStore
 * alias. The desktop equivalent is Electron's `safeStorage`, which is backed by
 * the OS keychain (Keychain on macOS, libsecret/kwallet on Linux, DPAPI on
 * Windows). Ciphertext is stored, the plaintext never touches disk.
 *
 * On Linux `safeStorage` can be unavailable on a headless box with no keyring;
 * the app still has to run, so the key falls back to plaintext storage and the
 * UI says so rather than pretending it is protected.
 */

const PREFIX = 'enc:v1:';
const PREFIX_PLAIN = 'plain:v1:';

/** True when this build can actually seal a secret on this machine. */
export function vaultAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** How the stored value is currently protected, for the settings hint. */
export function vaultMode(): 'keychain' | 'plain' {
  return vaultAvailable() ? 'keychain' : 'plain';
}

export function seal(plaintext: string): string {
  if (!plaintext) return '';
  if (!vaultAvailable()) return `${PREFIX_PLAIN}${Buffer.from(plaintext, 'utf8').toString('base64')}`;
  try {
    return `${PREFIX}${safeStorage.encryptString(plaintext).toString('base64')}`;
  } catch {
    return `${PREFIX_PLAIN}${Buffer.from(plaintext, 'utf8').toString('base64')}`;
  }
}

/** Reads a sealed value. Anything unreadable comes back as an empty key. */
export function open(sealedValue: string): string {
  if (!sealedValue) return '';
  try {
    if (sealedValue.startsWith(PREFIX)) {
      if (!vaultAvailable()) return '';
      return safeStorage.decryptString(Buffer.from(sealedValue.slice(PREFIX.length), 'base64'));
    }
    if (sealedValue.startsWith(PREFIX_PLAIN)) {
      return Buffer.from(sealedValue.slice(PREFIX_PLAIN.length), 'base64').toString('utf8');
    }
  } catch {
    return '';
  }
  // Written by an older build, before the vault existed.
  return sealedValue;
}

export function isSealed(value: string): boolean {
  return value.startsWith(PREFIX) || value.startsWith(PREFIX_PLAIN);
}