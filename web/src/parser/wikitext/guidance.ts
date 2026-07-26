/**
 * Telling guidance from reference, as far as that can honestly be done.
 *
 * A wiki page is not written to be a hint. Some of it is — "Strategy", "How
 * To", "Secrets" — and a great deal of it is appearances, trivia and track
 * listings. The question is which.
 *
 * Measuring second-person and imperative language against 318 real sections
 * across five game wikis, the signal is real. Matches per 100 words, median 0.9:
 *
 *     14.3  Early Chameleon Boss Fight § How To        0  Alexander Booth § Appearances
 *     12.9  Crank Bridge Super Bounce  § Advantages    0  Soundtrack (Silksong) § lead
 *      9.4  Drafting Strategy Vol. 3   § TOP COMBOS    0  Miss Jane Bird § In other languages
 *      7.3  Moorwing                   § Strategy      0  Magnetite dice § lead
 *
 * **And it misses whole genres.** Return of the Obra Dinn scores zero
 * everywhere: it is a deduction game, so its answers are *facts* — an
 * "Identification" section states who someone is — and a fact is not phrased as
 * an instruction. Those sections are the most spoiler-bearing content on the
 * wiki and the score cannot see them at all.
 *
 * So the contract here is narrow and deliberate:
 *
 * - the score **orders**; it never removes anything;
 * - `reference` is decided by the **heading alone**, never by a low score.
 *
 * A zero means "this says nothing about how instructional the text is", not
 * "this is not a hint". Anything that starts dropping content on a low score
 * will silently throw away an entire game's answers, and the failure will look
 * like the wiki being thin rather than like a bug.
 */

/**
 * Second-person, imperative and sequencing language.
 *
 * Word-boundary matched, so "use" does not fire on "used" — the difference
 * between "use the lever" and "the lever is used to" is exactly the difference
 * being measured.
 */
const INSTRUCTIONAL = [
  'you',
  'your',
  'must',
  'need to',
  'should',
  'go to',
  'head to',
  'return to',
  'use the',
  'press',
  'hold',
  'jump',
  'climb',
  'enter',
  'unlock',
  'obtain',
  'require',
  'requires',
  'required',
  'then',
  'after',
  'once you',
  'in order to',
  'solution',
  'answer',
  'solve',
  'reveal',
  'reveals',
  'hidden',
  'secret',
  'first',
  'next',
  'finally',
  'tip',
  'trick',
  'avoid',
  'make sure',
  'be careful',
];

const INSTRUCTIONAL_RE = new RegExp(
  `\\b(${INSTRUCTIONAL.map((word) => word.replace(/ /g, '\\s+')).join('|')})\\b`,
  'gi',
);

/** Headings that promise guidance outright. */
const GUIDANCE_HEADING =
  /\b(walkthrough|strateg|solution|how ?to|tips?|tricks?|secrets?|puzzles?|answers?|steps?|guide|requirements?|combination|progression|advantages?|getting there)\b/i;

/**
 * Headings that are never a hint, on any wiki.
 *
 * Dropped outright rather than ranked. Only about 3.4% of a wiki's prose by
 * volume, but they occupy rows, and rows are what you scroll past.
 */
const NEVER_HINT =
  /^(references?|gallery|trivia|external links?|see also|navigation|credits|soundtrack|videos?|images?|media|notes and references|citations|sources|in other languages|appearances?|changelog|patch history|update history|version history|behind the scenes|development|cast)$/i;

export type SectionRole = 'guidance' | 'neutral' | 'reference';

export interface GuidanceSignals {
  /** Instructional matches per 100 words. */
  instructional: number;
  role: SectionRole;
  words: number;
}

/** True for a heading whose content is never guidance and can be dropped. */
export function isNeverHint(heading: string): boolean {
  return NEVER_HINT.test(heading.trim());
}

/**
 * How much a section reads like guidance.
 *
 * `role` comes from the heading and nothing else. A section with a heading that
 * promises guidance is `guidance`; one whose heading is a known reference
 * section is `reference`; everything else is `neutral`, including a section that
 * scores zero — see the note at the top of this file.
 */
export function scoreSection(heading: string, text: string): GuidanceSignals {
  const words = text.split(/\s+/).filter(Boolean).length;
  const matches = words === 0 ? 0 : (text.match(INSTRUCTIONAL_RE) ?? []).length;
  // Below about 25 words there is not enough text for a density to mean
  // anything; a single "you" in a 6-word caption would score 16.
  const instructional = words < 25 ? 0 : (matches / words) * 100;

  const title = heading.trim();
  const role: SectionRole = isNeverHint(title)
    ? 'reference'
    : GUIDANCE_HEADING.test(title)
      ? 'guidance'
      : 'neutral';

  return { instructional, role, words };
}

/** Strong enough that the heading alone is not needed. */
const STRONG = 3;

/**
 * A single number to sort by, highest first.
 *
 * The heading dominates because it is the reliable half of the signal; the
 * density breaks ties and rescues a guidance section that happens to be called
 * something idiosyncratic, which is most of them.
 */
export function guidanceRank(signals: GuidanceSignals): number {
  const fromRole = signals.role === 'guidance' ? 10 : signals.role === 'reference' ? -10 : 0;
  const fromDensity = Math.min(signals.instructional, 15);
  // A section with nothing in it is not worth ranking above one that says
  // something, whatever its heading promised.
  const substance = signals.words >= 25 ? 0 : -5;
  return fromRole + fromDensity + substance;
}

/** Whether a section reads instructional enough to label as guidance. */
export function looksLikeGuidance(signals: GuidanceSignals): boolean {
  return signals.role === 'guidance' || signals.instructional >= STRONG;
}
