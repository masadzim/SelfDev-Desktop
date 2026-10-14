import type { ModelEntry } from './types';

/**
 * Which price tier a model falls in.
 *
 * Two sources, in order of trust. A published price wins, and is compared
 * against the other prices from the same provider rather than a fixed threshold,
 * so "cheap" means "cheap here" and follows the provider when they change it.
 * With no price to read, the model id is used as a rough proxy: an 8b general
 * checkpoint is not priced like a 120b reasoning one, whatever they cost today.
 */

export type EconomyTier = 'CHEAP' | 'MID' | 'HEAVY' | 'UNKNOWN';

/** How a tier was decided, so the UI can be honest about how much it knows. */
export type EconomyBasis = 'LIVE_PRICE' | 'SIZE_ESTIMATE' | 'UNKNOWN';

export interface Economy {
  tier: EconomyTier;
  basis: EconomyBasis;
  /**
   * Only ever set when `basis` is LIVE_PRICE. A number shown next to an estimate
   * would read as a quote, and would quietly rot.
   */
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  approxParamsB: number | null;
}

/** Below this many priced models a median is too noisy to rank against. */
const MIN_MODELS_FOR_LIVE_TIER = 3;
const LOW_TIER_FACTOR = 0.4;
const HIGH_TIER_FACTOR = 1.0;

const CHEAP_FAMILY = ['mini', 'nano', 'flash', 'haiku', 'instant', 'lite', 'small', 'turbo', ':free'];

const HEAVY_FAMILY = [
  'pro',
  'max',
  'ultra',
  'opus',
  'sonnet',
  'large',
  'reasoner',
  'thinking',
  'preview'
];

/** Reasoning checkpoints, which cost more and answer a short prompt slowly. */
const REASONING_MARKERS = ['oss', 'reasoner', 'thinking', 'r1', 'o1', 'o3', 'o4'];

/**
 * Parameter count as written in the model id, e.g. `120b` in
 * `openai/gpt-oss-120b`. Returns null when the id carries no size.
 *
 * The guards matter: an id like `claude-haiku-4-5-20251001` has digits that are
 * a date, and `gpt-4o-mini` has no size at all.
 */
export function approxParams(modelId: string): number | null {
  const match = /(?<![0-9a-z.])(\d{1,3}(?:\.\d)?)b(?![0-9a-z])/i.exec(modelId.trim());
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function medianOrNull(values: number[]): number | null {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Combined input+output cost, the single number a tier is ranked from. */
function combinedPrice(entry: ModelEntry): number | null {
  if (entry.inputPerMTok === null && entry.outputPerMTok === null) return null;
  return (entry.inputPerMTok ?? 0) + (entry.outputPerMTok ?? 0);
}

export function classify(
  modelId: string,
  livePrice: number | null,
  peerPrices: number[],
  inputPerMTok: number | null,
  outputPerMTok: number | null
): Economy {
  const lower = modelId.trim().toLowerCase();
  const size = approxParams(modelId);

  if (livePrice !== null && livePrice > 0) {
    const median = medianOrNull(peerPrices);
    // Too few prices to rank against, so stay quiet rather than guess.
    const tier: EconomyTier =
      median === null || peerPrices.length < MIN_MODELS_FOR_LIVE_TIER
        ? 'UNKNOWN'
        : livePrice <= median * LOW_TIER_FACTOR
          ? 'CHEAP'
          : livePrice <= median * HIGH_TIER_FACTOR
            ? 'MID'
            : 'HEAVY';
    if (tier !== 'UNKNOWN') {
      return { tier, basis: 'LIVE_PRICE', inputPerMTok, outputPerMTok, approxParamsB: size };
    }
  }

  const tier: EconomyTier =
    size !== null && size >= 70
      ? 'HEAVY'
      : size !== null && size <= 9
        ? 'CHEAP'
        : CHEAP_FAMILY.some((f) => lower.includes(f))
          ? 'CHEAP'
          : HEAVY_FAMILY.some((f) => lower.includes(f))
            ? 'HEAVY'
            : REASONING_MARKERS.some((f) => lower.includes(f))
              ? 'HEAVY'
              : size !== null
                ? 'MID'
                : 'UNKNOWN';
  return {
    tier,
    basis: tier === 'UNKNOWN' ? 'UNKNOWN' : 'SIZE_ESTIMATE',
    inputPerMTok: null,
    outputPerMTok: null,
    approxParamsB: size
  };
}

/**
 * Prices every discovered model against its peers, so one call fills the whole
 * picker. Models the provider priced nothing for fall back to the id heuristic.
 */
export function economiesFor(catalogue: ModelEntry[]): Map<string, Economy> {
  const prices = catalogue.map(combinedPrice).filter((p): p is number => p !== null);
  const out = new Map<string, Economy>();
  for (const entry of catalogue) {
    out.set(entry.id, classify(entry.id, combinedPrice(entry), prices, entry.inputPerMTok, entry.outputPerMTok));
  }
  return out;
}

/**
 * Classifies one model against a whole catalogue, so its peers are available for
 * the relative ranking.
 */
export function economyFor(modelId: string, catalogue: ModelEntry[]): Economy {
  const entry = catalogue.find((m) => m.id === modelId);
  const prices = catalogue.map(combinedPrice).filter((p): p is number => p !== null);
  return classify(
    modelId,
    entry ? combinedPrice(entry) : null,
    prices,
    entry?.inputPerMTok ?? null,
    entry?.outputPerMTok ?? null
  );
}

/**
 * The id-only estimate, for a model the provider published no price for. Every
 * provider without pricing still gets a useful badge out of this.
 */
export function estimateEconomy(modelId: string): Economy {
  return economyFor(modelId, []);
}

export function isBadgeWorthy(e: Economy): boolean {
  return e.tier !== 'UNKNOWN';
}

/** Ordering key for the model picker, cheapest first. */
export function sortKey(e: Economy): number {
  const base =
    e.tier === 'CHEAP' ? 0 : e.tier === 'MID' ? 1 : e.tier === 'HEAVY' ? 2 : 3;
  return base + (e.approxParamsB ?? 0) / 1000;
}

/**
 * Formats a live price for display, or null when there is nothing trustworthy
 * to show. Callers must not substitute a fallback number of their own.
 *
 * Fixed to the US locale on purpose: a device locale that renders this as
 * "$0,15" reads as a broken price.
 */
export function formatPrice(perMTok: number | null, isLive: boolean): string | null {
  if (!isLive || perMTok === null || perMTok <= 0) return null;
  return `$${(perMTok < 0.01 ? perMTok.toFixed(4) : perMTok.toFixed(2))}`;
}

/** The tier glyph shown in the picker. */
export function tierGlyph(tier: EconomyTier): string {
  switch (tier) {
    case 'CHEAP':
      return '$';
    case 'MID':
      return '$$';
    case 'HEAVY':
      return '$$$';
    default:
      return '';
  }
}