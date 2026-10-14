import type {
  GeneratedImage,
  ImageGenKind,
  ImageGenModel,
  ImageRequest,
  ImageSize,
  ModelEntry,
  ProviderId,
  WireApi
} from './types';

/**
 * Image generation, on the two endpoints that actually exist.
 *
 * One endpoint covers OpenAI's own models and every OpenAI-compatible host that
 * draws at all; the other covers Google's Imagen and image-capable Gemini. The
 * difference between the two is bigger than a path: one takes a flat prompt and
 * returns base64, the other nests the prompt and returns a prediction array.
 */

/** The three shapes a user actually asks for. No image API takes free dimensions. */
export const IMAGE_SIZES: Array<{ id: ImageSize; label: string; openAi: string | null; gemini: string }> = [
  { id: 'SQUARE', label: 'Persegi', openAi: '1024x1024', gemini: '1:1' },
  { id: 'LANDSCAPE', label: 'Lanskap', openAi: '1536x1024', gemini: '3:2' },
  { id: 'PORTRAIT', label: 'Potret', openAi: '1024x1536', gemini: '2:3' }
];

export const MAX_IMAGES = 4;

/* ------------------------------------------------------------- registry --- */

/**
 * Which models can draw, and how each is reached.
 *
 * Every model is listed by name, never inferred from a provider being able to
 * draw: OpenAI's key serves chat models with no image endpoint at all, and
 * offering a text model here produces a 404 that reads like a broken key.
 *
 * The endpoint a model is reached through comes from this list too — `gpt-image-1`
 * contains the word "image" but goes through OpenAI's endpoint, not Google's, so
 * guessing from the name would send it somewhere that 404s.
 */

const OPENAI_MODELS = ['gpt-image-1', 'dall-e-3'];
const GEMINI_MODELS = ['gemini-2.5-flash-image'];
const IMAGEN_MODELS = ['imagen-4.0-generate-001', 'imagen-3.0-generate-002'];

/** Hosts that draw over the OpenAI endpoint. */
const BY_PROVIDER: Record<string, string[]> = {
  openai: OPENAI_MODELS,
  gemini: GEMINI_MODELS,
  together: ['black-forest-labs/FLUX.1-schnell'],
  fireworks: ['flux-1-schnell-fp8'],
  novita: ['black-forest-labs/flux-1-dev']
};

/** Imagen is Google's too, so it is offered under the same key. */
const IMAGEN_PROVIDER = 'gemini';

/**
 * Fragments that mark a model as a drawing one, used only where the catalogue has
 * nothing to say: a custom endpoint the user pointed at themselves.
 *
 * Positive fragments only, so a chat model can never be mistaken for a drawing
 * one — offering the wrong model here is a failed request, and failing to offer a
 * model the endpoint does have is a screen with nothing on it.
 */
const IMAGE_MARKERS = [
  'dall-e',
  'gpt-image',
  'imagen',
  'flux',
  'stable-diffusion',
  'sdxl',
  'seedream',
  'qwen-image',
  'kolors',
  'recraft',
  'ideogram',
  'playground',
  'civitai',
  'wuerstchen',
  'deep-image',
  'photon',
  'shuttle'
];

/** True when a model id reads as a drawing one. Never true for a chat model. */
export function looksLikeImageModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  if (!id) return false;
  return IMAGE_MARKERS.some((marker) => id.includes(marker));
}

/** Every model this app offers, in the order the screen should show them. */
export function allImageModels(): ImageGenModel[] {
  const out: ImageGenModel[] = [
    ...OPENAI_MODELS.map((model) => ({ providerId: 'openai' as ProviderId, model, kind: 'OPENAI_IMAGE' as ImageGenKind, label: model })),
    ...GEMINI_MODELS.map((model) => ({ providerId: 'gemini' as ProviderId, model, kind: 'GEMINI_IMAGE' as ImageGenKind, label: model })),
    ...IMAGEN_MODELS.map((model) => ({ providerId: IMAGEN_PROVIDER as ProviderId, model, kind: 'IMAGEN' as ImageGenKind, label: model }))
  ];
  for (const [providerId, models] of Object.entries(BY_PROVIDER)) {
    // OpenAI's and Gemini's own models were listed above, in screen order.
    if (providerId === 'openai' || providerId === 'gemini') continue;
    out.push(...models.map((model) => ({ providerId: providerId as ProviderId, model, kind: 'OPENAI_IMAGE' as ImageGenKind, label: model })));
  }
  return out;
}

/**
 * How `model` should be reached, or null when it should not be offered.
 *
 * A curated model answers for itself. Otherwise only a custom endpoint is taken at
 * its word, because there the account's own catalogue is the only evidence there
 * is and a curated list would have nothing to say about it.
 */
export function findImageModel(
  providerId: string,
  model: string,
  customWireApi: WireApi = 'OPENAI_CHAT'
): ImageGenModel | null {
  const id = model.trim();
  if (!id) return null;
  const curated = allImageModels().find(
    (m) => m.providerId === providerId && m.model.toLowerCase() === id.toLowerCase()
  );
  if (curated) return curated;
  if (providerId !== 'custom') return null;
  if (!looksLikeImageModel(id)) return null;
  const lower = id.toLowerCase();
  const kind: ImageGenKind = lower.startsWith('imagen')
    ? 'IMAGEN'
    : customWireApi === 'GEMINI_CONTENT'
      ? 'GEMINI_IMAGE'
      : 'OPENAI_IMAGE';
  return { providerId: 'custom', model: id, kind, label: id };
}

/** The models offered for one provider, curated first. */
export function imageModels(
  providerId: string,
  discovered: ModelEntry[] = [],
  customWireApi: WireApi = 'OPENAI_CHAT'
): ImageGenModel[] {
  const curated = allImageModels().filter((m) => m.providerId === providerId);
  const seen = new Set(curated.map((m) => m.model.toLowerCase()));
  const extra = discovered
    .filter((m) => !seen.has(m.id.toLowerCase()) && looksLikeImageModel(m.id))
    .map((m) => findImageModel(providerId === 'custom' ? 'custom' : providerId, m.id, customWireApi))
    .filter((m): m is ImageGenModel => m !== null);
  return [...curated, ...extra];
}

/** Providers that have at least one drawing model, so the screen never offers a dead end. */
export function imageProviderIds(): ProviderId[] {
  return [...new Set(allImageModels().map((m) => m.providerId))];
}

export function canGenerate(providerId: string, model: string): boolean {
  return allImageModels().some((m) => m.providerId === providerId && m.model === model);
}

/* --------------------------------------------------------------- request --- */

function imageSize(kind: ImageGenKind, size: ImageSize): string | null {
  const spec = IMAGE_SIZES.find((s) => s.id === size) ?? IMAGE_SIZES[0];
  if (kind === 'OPENAI_IMAGE') return spec.openAi;
  return spec.gemini;
}

function openAiSize(model: string, size: ImageSize): string | null {
  const lower = model.trim().toLowerCase();
  // The oldest model takes one shape and nothing else, so it is fixed rather
  // than guessed at.
  if (lower === 'dall-e-2') return '512x512';
  if (lower === 'dall-e-3') {
    return { SQUARE: '1024x1024', LANDSCAPE: '1792x1024', PORTRAIT: '1024x1792' }[size];
  }
  return imageSize('OPENAI_IMAGE', size);
}

export function buildOpenAiBody(model: string, request: ImageRequest): Record<string, unknown> {
  const id = model.trim().toLowerCase();
  const body: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    n: Math.min(MAX_IMAGES, Math.max(1, request.count))
  };
  // A field that is present but wrong is refused outright, while an absent one
  // is filled in by the provider — so an unsupportable size is left out.
  const size = openAiSize(id, request.size);
  if (size) body.size = size;
  // gpt-image-1 always answers base64 and rejects the field outright; the DALL·E
  // models default to a URL, and this asks for the bytes instead.
  if (id.startsWith('dall-e')) body.response_format = 'b64_json';
  if (id.startsWith('gpt-image') || id.startsWith('o1') || id.startsWith('gpt-5')) body.output_format = 'png';
  return body;
}

export function buildImagenBody(request: ImageRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    instances: [{ prompt: request.prompt }],
    parameters: { sampleCount: Math.min(MAX_IMAGES, Math.max(1, request.count)) }
  };
  const spec = IMAGE_SIZES.find((s) => s.id === request.size) ?? IMAGE_SIZES[0];
  body.parameters = { ...(body.parameters as object), aspectRatio: spec.gemini };
  return body;
}

export function imageUrl(base: string, model: string, kind: ImageGenKind): string {
  if (kind === 'OPENAI_IMAGE') return `${base}/images/generations`;
  if (kind === 'IMAGEN') return `${base}/models/${model}:predict`;
  return `${base}/models/${model}:generateContent`;
}

/* --------------------------------------------------------------- reading --- */

function dataUrlToBase64(url: string): string {
  const comma = url.indexOf(',');
  return comma === -1 ? '' : url.slice(comma + 1);
}

export function parseOpenAi(root: Record<string, unknown>, model: string): GeneratedImage[] {
  const data = (root.data ?? []) as Array<Record<string, unknown>>;
  return data
    .filter((entry) => typeof entry.b64_json === 'string' || typeof entry.url === 'string')
    .map((entry) => ({
      data: typeof entry.b64_json === 'string' ? entry.b64_json : dataUrlToBase64(String(entry.url ?? '')),
      mimeType: 'image/png',
      model,
      revisedPrompt: typeof entry.revised_prompt === 'string' ? entry.revised_prompt : null
    }))
    .filter((img) => img.data.length > 0);
}

export function parseImagen(root: Record<string, unknown>, model: string): GeneratedImage[] {
  const predictions = (root.predictions ?? []) as Array<Record<string, unknown>>;
  return predictions
    .filter((p) => typeof p.bytesBase64Encoded === 'string')
    .map((p) => ({
      data: String(p.bytesBase64Encoded),
      mimeType: typeof p.mimeType === 'string' ? p.mimeType : 'image/png',
      model,
      revisedPrompt: null
    }));
}

export function parseGemini(root: Record<string, unknown>, model: string): GeneratedImage[] {
  const candidates = (root.candidates ?? []) as Array<Record<string, unknown>>;
  const parts = (candidates[0]?.content as Record<string, unknown> | undefined)?.parts as
    | Array<Record<string, unknown>>
    | undefined;
  return (parts ?? [])
    .filter((p) => {
      const inline = p.inlineData as Record<string, unknown> | undefined;
      return typeof inline?.data === 'string';
    })
    .map((p) => {
      const inline = p.inlineData as Record<string, unknown>;
      return {
        data: String(inline.data),
        mimeType: typeof inline.mimeType === 'string' ? String(inline.mimeType) : 'image/png',
        model,
        revisedPrompt: null
      };
    });
}

/** The file extension that follows from the mime type: a PNG saved as .jpg renders wrong. */
export function extensionFor(mimeType: string): string {
  if (mimeType.includes('jpeg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  return 'png';
}

/**
 * Gemini's image-capable models take the prompt as plain text and answer with
 * inline data, so this body is a plain generateContent with an image modality.
 */
export function buildGeminiBody(request: ImageRequest): Record<string, unknown> {
  const spec = IMAGE_SIZES.find((x) => x.id === request.size) ?? IMAGE_SIZES[0];
  return {
    contents: [{ parts: [{ text: request.prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: spec.gemini }
    }
  };
}
