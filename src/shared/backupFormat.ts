import type { BackupSettings, Project, Session } from './types';

/**
 * Backup format.
 *
 * Everything is one JSON document so the format stays inspectable, and the whole
 * document is sealed with a passphrase the user supplies. This file holds the
 * shape and the naming; the cipher and the disk I/O live in the main process, so
 * the renderer can import a suggested filename without dragging node in.
 */

export const FORMAT = 'selfdev-backup';
export const VERSION = 1;
export const EXTENSION = 'selfdev';

export interface BackupPayload {
  format: typeof FORMAT;
  version: number;
  exportedAt: number;
  encrypted: boolean;
  counts: { sessions: number; projects: number; alerts: number; notes: number };
  settings: BackupSettings;
  sessions: Session[];
  projects: Project[];
  alerts: unknown[];
  notes: unknown[];
}

function stamp(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** `selfdev-backup-2026-10-14-1832.selfdev` */
export function suggestedFilename(now = Date.now()): string {
  return `${FORMAT}-${stamp(now)}.${EXTENSION}`;
}

export function parsePayload(json: string): BackupPayload {
  const root = JSON.parse(json) as Partial<BackupPayload>;
  if (root.format !== FORMAT) throw new Error('Berkas ini bukan backup SelfDev.');
  const version = Number(root.version ?? 0);
  if (version < 1 || version > VERSION) {
    throw new Error(`Versi backup ${version} tidak bisa dibaca oleh build ini.`);
  }
  const settings = root.settings as BackupSettings | undefined;
  if (!settings?.config) throw new Error('Backup ini tidak memuat pengaturan.');
  const sessions = Array.isArray(root.sessions) ? root.sessions : [];
  const projects = Array.isArray(root.projects) ? root.projects : [];
  return {
    format: FORMAT,
    version,
    exportedAt: Number(root.exportedAt ?? Date.now()),
    encrypted: root.encrypted === true,
    counts: {
      sessions: sessions.length,
      projects: projects.length,
      alerts: Array.isArray(root.alerts) ? root.alerts.length : 0,
      notes: Array.isArray(root.notes) ? root.notes.length : 0
    },
    settings,
    sessions,
    projects,
    alerts: Array.isArray(root.alerts) ? root.alerts : [],
    notes: Array.isArray(root.notes) ? root.notes : []
  };
}

export function buildPayload(input: {
  settings: BackupSettings;
  sessions: Session[];
  projects: Project[];
  /** The credential only travels when the user opts in. */
  includeApiKey: boolean;
}): BackupPayload {
  const config = input.includeApiKey
    ? input.settings.config
    : { ...input.settings.config, apiKey: '' };
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: Date.now(),
    encrypted: true,
    counts: { sessions: input.sessions.length, projects: input.projects.length, alerts: 0, notes: 0 },
    settings: { ...input.settings, config },
    sessions: input.sessions,
    projects: input.projects,
    alerts: [],
    notes: []
  };
}

export function describeCounts(counts: BackupPayload['counts']): string {
  return `${counts.sessions} sesi · ${counts.projects} proyek`;
}
