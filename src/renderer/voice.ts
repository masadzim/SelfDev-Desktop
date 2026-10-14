import { chunks, fromMarkdown } from '../shared/spokenText';

/**
 * Voice, on the two engines the browser already ships.
 *
 * Speaking needs nothing: Chromium drives the OS voice engine, so there is no
 * dependency and no key. Dictation is the fragile half — it needs a speech
 * service the OS may not have — so it is feature-detected and degrades to a
 * message rather than a microphone button that silently does nothing.
 */

export type SpeechState = 'idle' | 'listening' | 'speaking';

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
}

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null;
}

export function speechAvailable(): boolean {
  return typeof window.speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
}

export function dictationAvailable(): boolean {
  return recognitionCtor() !== null;
}

export interface VoiceHandle {
  stop(): void;
}

/**
 * Reads an answer out loud.
 *
 * Markdown is stripped first and the text is queued sentence by sentence, because
 * handing a synthesiser a whole long answer at once makes it start minutes after
 * the reply arrived.
 */
export function speak(
  text: string,
  opts: { lang: string; voiceName: string | null; includeCode: boolean; onState: (s: SpeechState) => void }
): VoiceHandle | null {
  if (!speechAvailable()) return null;
  const clean = fromMarkdown(text, opts.includeCode);
  const parts = chunks(clean);
  if (!parts.length) return null;

  const synth = window.speechSynthesis;
  synth.cancel();
  opts.onState('speaking');

  parts.forEach((part, i) => {
    const utter = new SpeechSynthesisUtterance(part);
    utter.lang = opts.lang === 'en' ? 'en-US' : 'id-ID';
    if (opts.voiceName) {
      const voice = synth.getVoices().find((v) => v.name === opts.voiceName);
      if (voice) utter.voice = voice;
    }
    if (i === parts.length - 1) {
      utter.onend = () => opts.onState('idle');
      utter.onerror = () => opts.onState('idle');
    }
    synth.speak(utter);
  });

  return { stop: () => { synth.cancel(); opts.onState('idle'); } };
}

export function stopSpeaking(): void {
  if (speechAvailable()) window.speechSynthesis.cancel();
}

export function listVoices(): SpeechSynthesisVoice[] {
  if (!speechAvailable()) return [];
  return window.speechSynthesis.getVoices();
}

/**
 * Listens once and hands the transcript back.
 *
 * The transcript lands in the composer rather than being sent: dictation is
 * nearly always the first half of a thought, and firing it off on its own would
 * cost a round trip.
 */
export function dictate(
  lang: string,
  handlers: { onPartial: (text: string) => void; onFinal: (text: string) => void; onState: (s: SpeechState) => void; onError: (message: string) => void }
): VoiceHandle | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;

  const recognition = new Ctor();
  recognition.lang = lang === 'en' ? 'en-US' : 'id-ID';
  recognition.continuous = false;
  recognition.interimResults = true;

  handlers.onState('listening');

  recognition.onresult = (event: any) => {
    let final = '';
    let partial = '';
    for (const result of Array.from(event.results ?? []) as Array<any>) {
      const text = String(result?.[0]?.transcript ?? '');
      if (result?.isFinal) final += text;
      else partial += text;
    }
    if (partial) handlers.onPartial(partial);
    if (final) handlers.onFinal(final);
  };
  recognition.onerror = (event: any) => {
    handlers.onState('idle');
    const code = String(event?.error ?? 'unknown');
    // A missing or denied microphone is an expected outcome, not a crash.
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      handlers.onError('Mikrofon ditolak. Izinkan akses mikrofon di pengaturan sistem.');
    } else if (code === 'no-speech') {
      handlers.onError('Tidak ada suara terdengar.');
    } else if (code === 'audio-capture') {
      handlers.onError('Tidak ada mikrofon yang tersedia.');
    } else if (code !== 'aborted') {
      handlers.onError(`Dikte gagal: ${code}.`);
    }
  };
  recognition.onend = () => handlers.onState('idle');

  try {
    recognition.start();
  } catch {
    handlers.onState('idle');
    return null;
  }
  return { stop: () => recognition.stop(), };
}