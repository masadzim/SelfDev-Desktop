import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { parsePayload, type BackupPayload } from '../shared/backupFormat';

/**
 * The sealed half of a backup: AES-256-GCM, the same cipher the Android client
 * uses, with the key derived from the user's passphrase by scrypt because a
 * passphrase is not key material.
 *
 * A wrong passphrase and a tampered file are indistinguishable by design, which
 * is also why the passphrase is never stored anywhere.
 */

export * from '../shared/backupFormat';

const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
// scrypt needs ~128 * r * N bytes. Node's default maxmem is 32 MB, which this
// comfortably exceeds, so it is raised explicitly rather than left to blow up.
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 2 ** 15 * 8 + 32 * 2 ** 20 } as const;

export interface SealedFile {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, SCRYPT_PARAMS);
}

export function sealPayload(payload: BackupPayload, passphrase: string): Buffer {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const data = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final()
  ]);
  const file: SealedFile = {
    version: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
  return Buffer.from(JSON.stringify(file), 'utf8');
}

export function openPayload(bytes: Buffer, passphrase: string): BackupPayload {
  let file: SealedFile;
  try {
    file = JSON.parse(bytes.toString('utf8')) as SealedFile;
  } catch {
    throw new Error('Berkas ini bukan backup SelfDev yang bisa dibaca.');
  }
  if (!file?.salt || !file.iv || !file.data) throw new Error('Berkas ini bukan backup SelfDev yang bisa dibaca.');
  if (file.version !== 1) throw new Error(`Versi enkripsi ${file.version} tidak didukung build ini.`);

  let json: string;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(passphrase, Buffer.from(file.salt, 'base64')),
      Buffer.from(file.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
    json = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Passphrase salah, atau berkasnya sudah berubah.');
  }
  return parsePayload(json);
}

/** Writes the sealed backup. */
export async function writeBackup(path: string, payload: BackupPayload, passphrase: string): Promise<void> {
  await fs.writeFile(path, sealPayload(payload, passphrase));
}

export async function readBackup(path: string, passphrase: string): Promise<BackupPayload> {
  return openPayload(await fs.readFile(path), passphrase);
}

export function describeTarget(path: string): string {
  return basename(path) || path;
}
