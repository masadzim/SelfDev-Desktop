import type { WorkspaceMode } from './types';

/**
 * What a workspace is for.
 *
 * The mode is not a personality: it decides which instructions the model gets, so
 * "remind me in ten minutes" works without the user explaining the tools first.
 * A chat is not a coding session by default.
 *
 * Prompts are the Android client's, word for word, so switching to Research here
 * behaves exactly as it does there.
 */
export interface ModeInfo {
  id: WorkspaceMode;
  label: string;
  summary: string;
  /** Appended to the system prompt while this mode is active. */
  prompt: string;
}

export const MODES: ModeInfo[] = [
  {
    id: 'general',
    label: 'Umum',
    summary: 'Bantuan apa pun, teknis atau bukan.',
    prompt:
      'Kamu adalah asisten pribadi yang praktis. Bantu hal apa pun yang diminta pengguna, termasuk hal teknis maupun non-teknis, dan jawab dalam bahasa yang sama dengan pesan pengguna.'
  },
  {
    id: 'code',
    label: 'Kode',
    summary: 'Kode, build, dan diagnose.',
    prompt:
      'Kamu adalah asisten teknis. Fokus pada kode, build, dan diagnose. Sertakan potongan kode hanya bila memang perlu, dan jelaskan langkahnya ringkas.'
  },
  {
    id: 'media',
    label: 'Foto & video',
    summary: 'Baca dan jelaskan foto atau video yang dikirim.',
    prompt:
      'Kamu adalah asisten media. Fokus pada foto dan video yang dikirim pengguna: deskripsi apa yang terlihat, berikut pertanyaan yang masuk akal. Jangan mengarang isi yang tidak terlihat pada frame.'
  },
  {
    id: 'alert',
    label: 'Pengingat',
    summary: 'Buat pengingat yang berbunyi di perangkat.',
    prompt:
      'Kamu adalah asisten pengingat. Kalau pengguna diminta-sounding, gunakan tool alert dan konfirmasi jamnya. Jangan membuat pengingat tanpa diminta.'
  },
  {
    id: 'writing',
    label: 'Menulis',
    summary: 'Draf, ringkasan, dan perbaikan tulisan.',
    prompt:
      'Kamu adalah penulis. Fokus pada draf, ringkasan, dan perbaikan tulisan. Berikan hasil yang siap pakai, bukan sekadar saran.'
  },
  {
    id: 'research',
    label: 'Riset',
    summary: 'Cari di web dan sumberkan jawabannya.',
    prompt:
      'Kamu adalah peneliti. Cari jawaban dari web bila perlu, sumberkan klaim penting, dan bedakan fakta dari dugaan.'
  },
  {
    id: 'music',
    label: 'Musik',
    summary: 'Lirik, chord, notasi, dan teori musik.',
    prompt:
      'Kamu adalah asisten musik. Fokus pada bass, chord progression, dan struktur lagu. Beri notasi atau tablature bila pengguna memintanya, sebutkan nada dan chord dalam bahasa yang sama dengan pesan pengguna, dan jangan mengarang lirik yang diklaim sebagai milik seniman tertentu.'
  }
];

export const DEFAULT_MODE: WorkspaceMode = 'code';

export function modeFor(id: string | null | undefined): ModeInfo {
  return MODES.find((m) => m.id === id) ?? modeFor(DEFAULT_MODE);
}

export function isValidWorkspaceMode(id: unknown): id is WorkspaceMode {
  return typeof id === 'string' && MODES.some((m) => m.id === id);
}

/**
 * The system prompt actually sent: the base one, then the mode's instructions.
 * Appending rather than replacing is what lets the tool-use guidance survive a
 * switch to, say, Research.
 */
export function promptFor(base: string, mode: WorkspaceMode): string {
  const info = modeFor(mode);
  return base.trim() ? `${base.trim()}\n\n${info.prompt}` : info.prompt;
}

/** Modes where reaching for a tool is the point; the rest stay tool-free. */
export function modeUsesTools(id: WorkspaceMode): boolean {
  return id === 'code' || id === 'general' || id === 'research';
}