/**
 * Settings that more than one screen needs, with their defaults in one place.
 *
 * The image ones are here rather than read ad hoc in `download.ts` because the
 * Settings screen and the download path have to agree on the defaults, and a
 * disagreement would show up as "I turned that off and it still downloaded
 * them".
 */

import { getSetting } from './db';
import type { ImagePolicy } from './images';

/**
 * The measured width.
 *
 * 640 is the only value that has been costed end to end: Blue Prince's 280
 * pictures come to about 11 MB at 640px against 413 MB at full size. Other
 * widths work; their totals are guesses.
 */
export const DEFAULT_IMAGE_WIDTH = 640;

/** Per-game ceiling. Comfortably above the largest game measured. */
export const DEFAULT_IMAGE_BUDGET_MB = 40;

export interface ImageSettings extends ImagePolicy {
  enabled: boolean;
}

export async function imageSettings(): Promise<ImageSettings> {
  const [enabled, width, budgetMb] = await Promise.all([
    getSetting('wikiImages', true),
    getSetting('wikiImageWidth', DEFAULT_IMAGE_WIDTH),
    getSetting('wikiImageBudgetMb', DEFAULT_IMAGE_BUDGET_MB),
  ]);
  return {
    enabled,
    maxWidth: Math.max(64, Number(width) || DEFAULT_IMAGE_WIDTH),
    budgetBytes: Math.max(1, Number(budgetMb) || DEFAULT_IMAGE_BUDGET_MB) * 1024 * 1024,
  };
}
