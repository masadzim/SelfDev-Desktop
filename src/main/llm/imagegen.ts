import {
  buildGeminiBody,
  buildImagenBody,
  buildOpenAiBody,
  findImageModel,
  imageUrl,
  parseGemini,
  parseImagen,
  parseOpenAi
} from '../../shared/imagegen';
import { authHeaders, buildError, classifyError, LlmError } from './chat';
import { presetFor } from '../../shared/providers';
import type { GeneratedImage, ImageGenKind, ImageRequest, ResolvedEndpoint } from '../../shared/types';

export * from '../../shared/imagegen';

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

/** The request a provider will actually receive, resolved without sending it. */
export function imageRequestFor(
  providerId: string,
  customBaseUrl: string,
  customWireApi: ResolvedEndpoint['wireApi'],
  apiKey: string,
  model: string,
  request: ImageRequest
): { url: string; headers: Record<string, string>; body: Record<string, unknown>; kind: ImageGenKind } {
  const found = findImageModel(providerId, model, customWireApi);
  // Refusing here rather than 404-ing is what stops a chat-only provider from
  // being asked for a picture and reporting a perfectly good key as broken.
  if (!found) throw new LlmError(`${model} bukan model yang bisa menggambar`, 'MODEL');

  const base =
    providerId === 'custom'
      ? customBaseUrl.replace(/\/+$/, '')
      : presetFor(providerId).baseUrl.replace(/\/+$/, '');
  if (!base) throw new LlmError('Base URL belum diisi', 'MODEL');

  const kind = found.kind;
  // Google's endpoints take the key in a header of their own, not as Bearer.
  const headers = kind === 'OPENAI_IMAGE' ? authHeaders('OPENAI_CHAT', apiKey) : { 'x-goog-api-key': apiKey };
  const body =
    kind === 'OPENAI_IMAGE'
      ? buildOpenAiBody(model, request)
      : kind === 'IMAGEN'
        ? buildImagenBody(request)
        : buildGeminiBody(request);
  return { url: imageUrl(base, model, kind), headers, body, kind };
}

/* ------------------------------------------------------------- transport --- */

/**
 * Asks a provider for pictures.
 *
 * A URL in the response is followed here rather than in the renderer: an image
 * endpoint hands out links that expire in minutes, and the user will still be
 * looking at the picture after the run finishes.
 */
export async function generateImages(
  spec: { url: string; headers: Record<string, string>; body: Record<string, unknown>; kind: ImageGenKind },
  model: string,
  signal: AbortSignal
): Promise<GeneratedImage[]> {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json', ...spec.headers };
  let root: Record<string, unknown>;
  try {
    const response = await fetch(spec.url, { method: 'POST', headers, body: JSON.stringify(spec.body), signal });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LlmError(`API error (HTTP ${response.status}): ${buildError(detail)}`, classifyError(response.status, detail), response.status);
    }
    root = (await response.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof LlmError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new LlmError(message, /timeout|abort/i.test(message) ? 'TIMEOUT' : 'NETWORK');
  }

  if (spec.kind === 'OPENAI_IMAGE') {
    const remote = ((root.data ?? []) as Array<Record<string, unknown>>)
      .filter((e) => typeof e.url === 'string' && typeof e.b64_json !== 'string')
      .map((e) => ({ url: String(e.url), revised: typeof e.revised_prompt === 'string' ? e.revised_prompt : null }));
    const fetched = await Promise.all(
      remote.map(async (r) => {
        const bytes = await fetchBounded(r.url, signal);
        return bytes ? { data: bytes, mimeType: 'image/png', model, revisedPrompt: r.revised } : null;
      })
    );
    const fromUrls = fetched.filter((f): f is GeneratedImage => f !== null);
    return [...fromUrls, ...parseOpenAi(root, model)];
  }
  if (spec.kind === 'IMAGEN') return parseImagen(root, model);
  return parseGemini(root, model);
}

async function fetchBounded(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(url, { redirect: 'follow', signal });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) return null;
    return Buffer.from(buffer).toString('base64');
  } catch {
    return null;
  }
}

/** The file extension that follows from the mime type: a PNG saved as .jpg renders wrong. */
export function extensionFor(mimeType: string): string {
  if (mimeType.includes('jpeg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  return 'png';
}