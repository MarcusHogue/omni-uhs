/**
 * MediaWiki wikitext -> AST.
 *
 * Headings become nested subjects, paragraphs and list items become the body
 * of a hint group, and anything marked as a spoiler stays hidden behind the
 * usual tap-to-reveal.
 *
 * Attribution is not optional here: StrategyWiki is CC-BY-SA 4.0, so the page
 * URL and revision id travel with the document and are displayed in the reader
 * and the library (spec §11).
 */

import type {
  HintDocument,
  HintGroupNode,
  HintNode,
  ImageNode,
  Inline,
  Node,
  ParseResult,
  SourceKind,
  SubjectNode,
  TextNode,
} from '../ast';
import { inlineText } from '../ast';
import { stableId } from '../id';
import { guidanceRank, isNeverHint, looksLikeGuidance, scoreSection } from './guidance';
import type { ImageRef } from './images';
import { extractGalleries, findFileLinks, splitParams, stripFileLinks } from './images';

export interface WikiPageInput {
  title: string;
  wikitext: string;
  revision: string | null;
}

/**
 * How a page's prose becomes nodes.
 *
 * `as-written` keeps the page as it reads: prose is a `text` node, visible
 * immediately. Right for StrategyWiki, which is *written* as a walkthrough with
 * its answers already behind spoiler templates.
 *
 * `progressive` re-shapes it: each section heading becomes the question and its
 * paragraphs become hints revealed one at a time. Necessary for a reference
 * wiki, where nothing is marked as an answer and dumping the page would spoil
 * everything on it at once — the exact thing this app exists to avoid.
 */
export type RevealMode = 'as-written' | 'progressive';

export interface WikiWalkthroughOptions {
  kind: SourceKind;
  gameTitle: string;
  /** e.g. https://strategywiki.org/wiki/ */
  baseUrl: string;
  /**
   * The URL the document as a whole stands for.
   *
   * Defaults to the game's own page under `baseUrl`, which is right when a
   * download *is* one page or one game's sub-tree. A whole wiki has no such
   * page, so it passes its article root instead rather than linking attribution
   * at a title that may not exist.
   */
  documentUrl?: string;
  license: string;
  personalUseOnly: boolean;
  fetchedAt?: string;
  /** Defaults to `as-written`, so existing callers are unaffected. */
  reveal?: RevealMode;
  /**
   * Score each section, label it, and lead the document with the ones that read
   * like guidance. Only sensible with `progressive`; off by default, so
   * StrategyWiki — which is already written as a walkthrough — is untouched.
   */
  rank?: boolean;
  /**
   * Record the pictures each hint refers to, for the storage layer to fetch.
   *
   * Off by default. StrategyWiki's fallback path reads the wiki straight from
   * the browser and cannot fetch image bytes at all, so turning this on there
   * would produce references that never resolve.
   */
  images?: boolean;
  /**
   * What the wiki says a template call expands to, keyed on the call's inner
   * text — `AW` for `{{AW}}`.
   *
   * Some words only exist in a template's *definition*, which is on the wiki and
   * not in the page: `{{AW}}` is how Animal Well's pages write the game's name,
   * so "a secret collectible animal in {{AW}}" arrived as "…animal in ." Nothing
   * in the source can recover that, so the download layer asks the wiki and
   * passes the answers in. Absent, the parser behaves exactly as before.
   *
   * See `collectExpandable`, which says which calls are worth asking about.
   */
  expanded?: Record<string, string>;
}

/** Templates whose content is a spoiler and must start hidden. */
const SPOILER_TEMPLATES = /^(spoiler|hidden|collapse|mbox spoiler)/i;

/**
 * Namespaced links that are filing, not prose.
 *
 * `[[Category:Creatures]]` is how a page declares its own category. It renders
 * as nothing in the page body — MediaWiki puts it in a footer — so passing the
 * text through turned a filing instruction into a sentence, and on a page whose
 * only content was categories, into a hint reading "Category:Creatures".
 */
const FILING_LINK = /\[\[(?:Category|Media|Template|Special):[^\]]*\]\]/gi;

/**
 * Everything that vanishes: markers, filing, and comments.
 *
 * File links go through `stripFileLinks`, not `FILING_LINK`. A caption may
 * contain a link of its own — `[[File:Door.png|thumb|Solution to the
 * [[Antechamber]] door]]` — and the flat `[^\]]*` pattern stops at the first
 * `]]` inside it, leaving `door]]` in the prose.
 */
const removed = (text: string): string =>
  stripFileLinks(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(FILING_LINK, '')
    // A link whose target was a template — `[[{{PAGENAME}}|Galligan]]` — has
    // lost its target by the time this runs, and `[[|Galligan]]` matches no
    // link pattern, so it survived as the residue `Galligan]]`. Tunic writes
    // `[[{{PAGENAME}}]]`, which left a bare `[[]]`.
    .replace(/\[\[\s*\]\]/g, '')
    .replace(/\[\[\s*\|/g, '[[');

/**
 * An HTML or MediaWiki extension tag.
 *
 * A fixed list of *twelve* inline tags was not enough. Hollow Knight writes its
 * section headings as literal `<h2>Usefulness</h2>` — 77 of them across ten
 * pages — and between them the wikis in use also emit `<code>`,
 * `<p class="MsoNormal">`, `<noinclude>`, `<rss>` and `<twitterfeed theme=dark>`.
 * All of it reached the reader as text.
 *
 * The answer is a longer list, not a looser pattern. Matching any `<name …>`
 * cannot work: in `if x<y and a=b>0` the middle reads as a tag called `y` with
 * two attributes, and stripping it leaves `if x0`. Attribute syntax does not
 * save it either, because `and a=b` *is* valid attribute syntax. The only thing
 * separating a tag from a comparison is whether the name is one — so the name
 * has to be known.
 *
 * An unrecognised extension tag therefore still leaks, visibly, which is the
 * failure worth having: text that should not be there is obvious, and text
 * quietly deleted is not.
 *
 * `<math>` is in the list and its contents survive, which is what you want:
 * Blue Prince's worked examples are `<math>0 + 5 + 13 = 18</math>`.
 */
const HTML_TAGS = [
  // HTML5.
  'a|abbr|address|area|article|aside|audio|b|base|bdi|bdo|big|blockquote|body',
  'br|button|canvas|caption|center|cite|code|col|colgroup|data|datalist|dd|del',
  'details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|font|footer',
  'form|h1|h2|h3|h4|h5|h6|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd',
  'label|legend|li|link|main|map|mark|menu|meta|meter|nav|noscript|object|ol',
  'optgroup|option|output|p|param|picture|pre|progress|q|rp|rt|ruby|s|samp',
  'script|section|select|slot|small|source|span|strike|strong|style|sub|summary',
  'sup|table|tbody|td|textarea|tfoot|th|thead|time|title|tr|track|tt|u|ul|var',
  'video|wbr',
  // MediaWiki, and the extensions these wikis actually use.
  'categorytree|ce|charinsert|chem|dynamicpagelist|gallery|graph|hiero|imagemap',
  'includeonly|indicator|inputbox|mapframe|maplink|math|noinclude|nowiki',
  'onlyinclude|poem|references|rss|score|syntaxhighlight|tabber|tabbertransclude',
  'templatedata|templatestyles|timeline|twitterfeed|verbatim|youtube',
].join('|');

const HTML_TAG = new RegExp(`</?(?:${HTML_TAGS})(?=[\\s/>])[^<>]*>`, 'gi');

/** Everything else, once the links have been dealt with. */
const cleaned = (text: string): string =>
  text
    .replace(/\[(?:https?:)?\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/\S+\]/g, '')
    // Runs, not pairs. Wikitext marks emphasis with 2, 3 or 5 apostrophes and
    // nests them freely: Obra Dinn writes `'''''Murder'', part 3'''`, where
    // matching `'''…'''` and `''…''` as pairs leaves marks stranded mid-sentence.
    // A lone apostrophe is punctuation and is left alone.
    .replace(/'{2,}/g, '')
    .replace(HTML_TAG, '')
    // What `<math>` was wrapping. Stripping the tag leaves the LaTeX, and Blue
    // Prince's worked dartboard examples are arithmetic: `\times 4 \times 2` and
    // `\frac{8}{4}` are the calculation the reader came for, so they are
    // translated rather than shown raw or dropped.
    // A repeating decimal: keep the bar, or `0.\overline{6}` becomes 0.6 and
    // means something else. U+0305 sits over the digit before it.
    .replace(/\\overline\s*\{([^{}]*)\}/g, (_all, digits: string) =>
      [...digits].map((c) => `${c}\u0305`).join(''),
    )
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\times/g, '×')
    .replace(/\\cdot/g, '·')
    .replace(/\\div/g, '÷')
    .replace(/\\(?:left|right|,|;|!|quad|qquad)/g, '')
    // An indent marker that survived a flattened block: `:<math>…` became
    // `: 0 + 12 = 12`. Only before a digit or a backslash, so a time of day
    // ("10:30", no space before the colon) is left alone.
    .replace(/\s+:\s*(?=[\d\\])/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    // Removing a picture or a citation leaves the space that was in front of
    // it: "solved the puzzle in The Precipice ." Safe to close up now that
    // template expansion has recovered the *words* that used to go missing —
    // before that, this gap was the only sign a sentence had lost one.
    .replace(/\s+([.,;:!?])/g, '$1');

/**
 * Strip wiki markup down to display text, keeping internal links as link text.
 *
 * Deliberately conservative: this is a reader, not a renderer, so anything not
 * understood is dropped rather than shown as raw markup.
 */
export function stripMarkup(text: string, expanded: Record<string, string> = {}): string {
  return cleaned(
    // Templates go too. Without this a section title kept them verbatim, and
    // Obra Dinn's transcript headings read `Transcript {{play|End_pt1.ogg}}`.
    extractTemplates(removed(text), expanded).text
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1'),
  ).trim();
}

const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** How MediaWiki itself compares two page titles. */
export function normalizePageTitle(title: string): string {
  const trimmed = title.replace(/_/g, ' ').split('#')[0]!.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Display text, with links to pages in this download kept as links.
 *
 * A wiki is a web, and flattening it loses the thing that makes it navigable:
 * "see [[The Antechamber]]" is a pointer, and printing it as plain text leaves
 * the reader to go and find that page by hand. Where the target is one of the
 * pages downloaded with this game, it becomes a link the reader can follow;
 * where it is not, the label stands as text, because a link to something not
 * present would be a dead end.
 */
export function toInline(
  text: string,
  resolve?: (title: string) => string | undefined,
): Inline[] {
  const source = removed(text);
  const out: Inline[] = [];
  const push = (run: string): void => {
    const value = cleaned(run);
    if (!value) return;
    const last = out[out.length - 1];
    if (last?.kind === 'run') last.text += value;
    else out.push({ kind: 'run', text: value });
  };

  let index = 0;
  for (const match of source.matchAll(WIKILINK)) {
    push(source.slice(index, match.index));
    index = match.index + match[0].length;

    const target = match[1]!;
    const label = cleaned(match[2] ?? target).trim();
    const targetId = resolve?.(normalizePageTitle(target));
    if (targetId && label) out.push({ kind: 'link', label, targetId });
    else push(label);
  }
  push(source.slice(index));

  // Trim the ends without disturbing the single spaces that sit either side of
  // a link, which `cleaned` deliberately preserves.
  const first = out[0];
  if (first?.kind === 'run') first.text = first.text.replace(/^\s+/, '');
  const last = out[out.length - 1];
  if (last?.kind === 'run') last.text = last.text.replace(/\s+$/, '');
  return out.filter((item) => item.kind !== 'run' || item.text !== '');
}

/**
 * Templates whose job is to style a run of text, where the text is the last
 * unnamed parameter.
 *
 * The convention is wikitext's own: `[[target|label]]`, `[[File:x|thumb|caption]]`
 * — what is displayed comes last. A styling template follows it, and the earlier
 * parameters are the colour, class or size.
 *
 * Matched on the name rather than guessed at from the values, because the values
 * cannot be told apart: in `{{ColorText|add|Blue}}` both are short lowercase-ish
 * words and only the name says which is presentation.
 */
const TEXT_TEMPLATE =
  /^(colou?r\w*|\w*colou?r|font\w*|text|fg|bg|small|big|large|nowrap|abbr|tt|kbd|code|em|strong|mono)$/i;

/**
 * The display text of a template that is standing in for a word.
 *
 * Dropping templates wholesale is right for infoboxes and citations, but game
 * wikis also use them mid-sentence as glorified links — Blue Prince writes
 * `a very complex and long {{roomtype|Puzzle}};`, which came out as "a very
 * complex and long ;". So a template with exactly one unnamed parameter gives
 * that parameter back.
 *
 * With two or more, the parameters have roles this cannot generally know —
 * `{{tooltip|shown|hovered}}` would be a coin flip — so it only reads the ones
 * whose *name* says the last parameter is the text. That case is not
 * hypothetical and the failure was not cosmetic: `blueprince.wiki.gg` writes the
 * dartboard solution as `### {{ColorText|add|Blue}} is addition.`, which came
 * out as " is addition." The colour *is* the answer, and four steps of a puzzle
 * lost the only word that mattered.
 *
 * Bare dimensions (`{{Reflist|30em}}`) and anything wordless are layout, not
 * prose. Named parameters are configuration, so they are ignored when counting
 * — `{{Foo|text|class=x}}` still yields "text".
 */
function templateText(buffer: string): string | null {
  // Bracket-aware, because a parameter can hold a link and a plain `split('|')`
  // cuts it in half. `{{transcript|who=[[Paul Moss|Moss]]|line=…}}` came apart
  // into `who=[[Paul Moss` and `Moss]]`, and the second fragment looked exactly
  // like a lone unnamed parameter — so the reader was shown `Moss]]`.
  const parts = splitParams(buffer);
  const name = parts[0]!.trim();
  const unnamed = parts.slice(1).filter((part) => !part.includes('='));
  if (unnamed.length === 0) return null;
  if (unnamed.length > 1 && !TEXT_TEMPLATE.test(name)) return null;

  const value = unnamed[unnamed.length - 1]!.trim();
  if (value.length === 0 || value.length > 60) return null;
  if (!/[a-z]/i.test(value)) return null;
  if (/^\d+(\.\d+)?(px|em|%|pt)?$/i.test(value)) return null;
  // A media filename is a reference, not a word. Obra Dinn's transcripts open
  // with `{{play|Escape_pt2.ogg}}`, which put "Escape_pt2.ogg" in the prose.
  if (/\.(ogg|mp3|wav|webm|ogv|mp4|png|jpe?g|gif|svg|webp|pdf)$/i.test(value)) return null;
  return value;
}

/**
 * What a template expands to, if the wiki was asked and the answer is a phrase.
 *
 * Bounded to a single line: this is for the templates that stand in for words,
 * and anything that came back as a block is layout — a navbox, a reference
 * list — which the parser was right to drop in the first place. The result is
 * wikitext, so `''[[Animal Well]]''` still goes through the usual link and
 * emphasis handling downstream.
 */
const EXPANDED_MAX = 200;

/** Block markup: a navbox or a stub notice, not a phrase. */
const EXPANDED_BLOCK = /\{\||<(?:div|table|ul|ol|dl|tr|td|th)\b/i;

function expandedText(buffer: string, expanded: Record<string, string>): string | null {
  const key = buffer.trim();
  // Own properties only. A wiki is untrusted input, and `{{constructor}}` on a
  // plain object resolves to `Object` — truthy, so optional chaining waves it
  // through, and `.trim()` on a function throws and takes the download with it.
  if (!Object.hasOwn(expanded, key)) return null;
  const value = expanded[key]?.trim();
  if (!value || value.includes('\n') || value.length > EXPANDED_MAX) return null;
  // Tunic's `{{Stub}}` expands to a `<div><table>` notice. Length alone would
  // usually catch it, but the test that matters is what it *is*.
  if (EXPANDED_BLOCK.test(value)) return null;
  return value;
}

/**
 * The template calls worth asking the wiki to expand.
 *
 * Only the ones the parser is about to drop, so a call it can already read —
 * `{{ColorText|add|Blue}}` — costs no request. Only leaf calls, with no template
 * nested inside: the resolver works inside-out, so an outer call's text no
 * longer matches its source by the time it is looked up.
 *
 * Page-context magic words are left out. Their expansion depends on which page
 * is asking, and these are batched across a whole game, so the answer would be
 * confidently wrong rather than merely missing.
 */
const PAGE_CONTEXT = /\b(PAGENAME|SUBPAGENAME|FULLPAGENAME|BASEPAGENAME|NAMESPACE|REVISIONID|SITENAME)\b/;

export function collectExpandable(wikitext: string): string[] {
  const found = new Set<string>();
  for (const match of stripBlockMarkup(wikitext).matchAll(/\{\{([^{}\n]*)\}\}/g)) {
    const inner = match[1]!.trim();
    if (!inner || inner.length > 300) continue;
    if (SPOILER_TEMPLATES.test(inner)) continue;
    if (PAGE_CONTEXT.test(inner)) continue;
    if (templateText(inner) !== null) continue;
    found.add(inner);
  }
  return [...found];
}

/**
 * What a spoiler template is actually hiding.
 *
 * `{{spoiler|the butler did it}}` is one unnamed parameter and the whole thing
 * is the payload. A box form is not: `blueprince.wiki.gg` writes
 * `{{SpoilerBox|topic=solution|content=…}}`, and joining every parameter back
 * together put `topic=solution|content=` on screen as prose — and printed the
 * topic, which on a puzzle page is a word like "solution", right where the
 * reader had asked not to be told anything yet.
 *
 * So: the body parameter when there is one, otherwise the unnamed parameters.
 */
function spoilerPayload(buffer: string): string {
  const parts = splitParams(buffer);
  const body = parts.find((part) => BODY_PARAM.test(part));
  if (body) return body.slice(body.indexOf('=') + 1).trim();
  return parts
    .slice(1)
    .filter((part) => !part.includes('='))
    .join('|')
    .trim();
}

/** Remove templates, tracking whether any of them marked a spoiler. */
function extractTemplates(
  text: string,
  expanded: Record<string, string> = {},
): { text: string; spoiler: boolean } {
  let spoiler = false;
  let out = '';
  /**
   * One buffer per open template, innermost last.
   *
   * A single buffer reset on every `{{` was the bug: a template containing
   * another one lost its own name, because by the time its `}}` arrived the
   * buffer held only the text since the *inner* `{{`. So it was not recognised
   * as a spoiler and its body was handed to `templateText`, which dropped it.
   *
   * That is not an edge case on the wiki this was found on. Blue Prince nests
   * its puzzle hints — a `{{SpoilerBox}}` holding eight more, including a
   * `{{CollapsedBox}}` — and every one of those bodies was being deleted.
   * Resolving inside-out means an inner template's text lands in its parent's
   * buffer, so the parent still sees a complete body.
   */
  const stack: string[] = [];
  const emit = (fragment: string): void => {
    if (stack.length > 0) stack[stack.length - 1] += fragment;
    else out += fragment;
  };

  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('{{', i)) {
      stack.push('');
      i += 1;
      continue;
    }
    if (text.startsWith('}}', i) && stack.length > 0) {
      const buffer = stack.pop()!;
      i += 1;
      if (SPOILER_TEMPLATES.test(buffer.trim())) {
        spoiler = true;
        const payload = spoilerPayload(buffer);
        if (payload) emit(` ${payload} `);
      } else {
        // No padding: the template sits mid-sentence, next to its punctuation.
        emit(templateText(buffer) ?? expandedText(buffer, expanded) ?? '');
      }
      continue;
    }
    emit(text[i]!);
  }

  // An unclosed `{{` swallowed the rest of the line. Dropped, as before: what it
  // holds is half a template call, not prose, and `stripBlockMarkup` has already
  // dealt with the multi-line templates that are meant to span one.
  return { text: out, spoiler };
}

/**
 * Remove templates and tables that span more than one line.
 *
 * `extractTemplates` runs per line, so its brace counter can never balance a
 * template written across several — which is how every infobox on Fandom and
 * wiki.gg is written. The result was that `| damage = 50` and friends survived
 * as body text. Single-line templates are left alone so `extractTemplates`
 * still sees them and can keep a spoiler's payload.
 *
 * Newlines inside a dropped region are preserved, so section splitting and line
 * numbering downstream are unaffected.
 */
/**
 * What to emit for a balanced top-level template.
 *
 * Single-line templates pass through untouched, for `extractTemplates` to
 * handle. A multi-line one is layout — an infobox — and is dropped, keeping only
 * its newlines.
 *
 * Unless it is a spoiler. A `{{spoiler|…}}` written across several lines holds
 * the answer to something, and dropping it would take the page's hidden guidance
 * with it — the section would come back empty, or the page would be rejected as
 * having nothing on it. Those are flattened onto one line instead, which is what
 * lets `extractTemplates`, whose brace counter is per line, recognise them at
 * all. The newlines follow, so the payload lands as its own block and the
 * section splitting below is unaffected.
 */
function flattenOrDrop(template: string): string {
  if (!template.includes('\n')) return template;
  const newlines = template.replace(/[^\n]/g, '');
  const name = template.slice(2).split('|')[0]!.trim();
  if (SPOILER_TEMPLATES.test(name)) return template.replace(/\s*\n\s*/g, ' ') + newlines;

  const body = bodyParam(template);
  if (body === null) return newlines;
  // Recursively, because a container holds containers: Blue Prince wraps
  // SpoilerBoxes in a CollapsedBox. Without this the inner ones came out as
  // source — an unbalanced `{{SpoilerBox|…` on one line and a stray `}}` on
  // another, which reached the reader as "except the memo. }} }}".
  const inner = stripBlockMarkup(body);
  // The body where the box was, padded back to the template's own line count so
  // section splitting sees the same shape it did before.
  return inner + newlines.slice(inner.replace(/[^\n]/g, '').length);
}

/**
 * Parameters that hold a box template's body rather than one of its fields.
 *
 * The distinction matters because dropping a multi-line template is right for an
 * infobox and wrong for a container. `blueprince.wiki.gg` writes its worked
 * dartboard examples as `{{CollapsedBox|header=…|content=<the example>}}`, and
 * ten such bodies across ten pages were being deleted — "In general, solving the
 * puzzles gets easier once one or two…", "Once a piece's name has correctly been
 * entered…". Solutions, thrown away for being inside braces.
 */
const BODY_PARAM = /^\s*(?:content|body|text|message|note|info)\s*=/i;

/**
 * The body of a box template, if it has one.
 *
 * Split with `splitParams` rather than on `|`, because a body contains links,
 * file references and templates of its own, all of which carry pipes.
 */
function bodyParam(template: string): string | null {
  const inner = template.replace(/^\{\{/, '').replace(/\}\}$/, '');
  for (const part of splitParams(inner)) {
    if (!BODY_PARAM.test(part)) continue;
    const value = part.slice(part.indexOf('=') + 1);
    // A field, not a body: `|text=yes` is configuration. Requiring some length
    // keeps this to the containers it is meant for.
    if (value.trim().length < 40) continue;
    return value;
  }
  return null;
}

export function stripBlockMarkup(wikitext: string): string {
  let out = '';
  let buffer = '';
  let depth = 0;
  let table = 0;

  for (let i = 0; i < wikitext.length; i++) {
    const two = wikitext.startsWith('{{', i)
      ? '{{'
      : wikitext.startsWith('}}', i)
        ? '}}'
        : wikitext.startsWith('{|', i)
          ? '{|'
          : wikitext.startsWith('|}', i)
            ? '|}'
            : null;

    if (two === '{|' && depth === 0) {
      table += 1;
      i += 1;
      continue;
    }
    if (two === '|}' && table > 0) {
      table -= 1;
      i += 1;
      continue;
    }
    if (table > 0) {
      if (wikitext[i] === '\n') out += '\n';
      continue;
    }

    if (two === '{{') {
      depth += 1;
      i += 1;
      buffer += '{{';
      continue;
    }
    if (two === '}}' && depth > 0) {
      depth -= 1;
      i += 1;
      buffer += '}}';
      if (depth === 0) {
        out += flattenOrDrop(buffer);
        buffer = '';
      }
      continue;
    }

    if (depth > 0) buffer += wikitext[i];
    else out += wikitext[i];
  }

  // An unclosed template runs to the end of the page; drop what it swallowed.
  if (buffer) out += buffer.replace(/[^\n]/g, '');
  return out;
}

interface Block {
  /** Display content, with in-document links preserved as links. */
  content: Inline[];
  spoiler: boolean;
  /** Pictures referenced alongside this block. Empty unless asked for. */
  images: ImageRef[];
}

/** Resolves a page title to the id of its subject, when it is in this download. */
type Resolver = (title: string) => string | undefined;

/** Concatenate blocks into one run sequence, separated by newlines. */
const joinBlocks = (blocks: Block[]): Inline[] =>
  blocks.flatMap((block, index) =>
    index === 0 ? block.content : [{ kind: 'run' as const, text: '\n' }, ...block.content],
  );

/**
 * Split a section's wikitext into displayable blocks.
 *
 * `<gallery>` blocks come out first and unconditionally. Nothing else in the
 * pipeline recognised them — `FILING_LINK` only matches bracketed `[[File:…]]`,
 * and `cleaned` strips a fixed list of inline HTML tags that does not include
 * `gallery` — so a gallery survived into a hint as prose reading
 * `<gallery widths="200px"> File:Conceptart 01.jpg File:Conceptart 02.jpg`.
 */
function toBlocks(
  body: string,
  resolve?: Resolver,
  withImages = false,
  expanded: Record<string, string> = {},
): Block[] {
  const { text, images: fromGalleries } = extractGalleries(body);
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let paragraphSpoiler = false;
  /** Pictures seen since the last block, waiting for something to belong to. */
  let pending: ImageRef[] = [];

  const push = (raw: string, spoiler: boolean): void => {
    const content = toInline(raw, resolve);
    const images = pending;
    pending = [];
    // A picture with no prose is still a block: on Blue Prince a section is
    // often nothing but the scan that answers it.
    if (content.length > 0 || images.length > 0) blocks.push({ content, spoiler, images });
  };

  const flush = (): void => {
    push(paragraph.join(' '), paragraphSpoiler);
    paragraph = [];
    paragraphSpoiler = false;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (withImages) pending.push(...findFileLinks(line));
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (/^\s*(\{\||\|\}|\|[-+}]|!)/.test(line)) continue; // tables: skip

    const { text: withoutTemplates, spoiler } = extractTemplates(line, expanded);
    const listItem = /^[*#:;]+\s*(.*)$/.exec(withoutTemplates);
    if (listItem) {
      flush();
      push(listItem[1] ?? '', spoiler);
      continue;
    }
    paragraph.push(withoutTemplates);
    paragraphSpoiler ||= spoiler;
  }
  flush();

  if (withImages && fromGalleries.length > 0) {
    // A gallery's position is lost when it is blanked out, so it goes with the
    // last thing the section said — which for a gallery is usually where it was.
    const last = blocks[blocks.length - 1];
    if (last) last.images.push(...fromGalleries);
    else blocks.push({ content: [], spoiler: false, images: fromGalleries });
  }
  return blocks;
}

interface Section {
  level: number;
  title: string;
  body: string;
}

export function splitSections(
  wikitext: string,
  expanded: Record<string, string> = {},
): Section[] {
  const sections: Section[] = [];
  let current: Section = { level: 1, title: '', body: '' };
  for (const line of wikitext.split('\n')) {
    const heading = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
    if (heading) {
      sections.push(current);
      current = {
        level: heading[1]!.length,
        title: stripMarkup(heading[2]!, expanded),
        body: '',
      };
      continue;
    }
    current.body += `${line}\n`;
  }
  sections.push(current);
  return sections.filter((s) => s.title !== '' || s.body.trim() !== '');
}

/**
 * A picture the page refers to, with no bytes yet.
 *
 * `data` stays empty until `storage/images.ts` has fetched something, and
 * `blobKey` is set at the same time. A renderer must therefore check
 * `data.length` rather than assuming bytes are there — the alternative,
 * making `data` optional, would ripple through the UHS path where it never is.
 */
function toImageNode(ref: ImageRef, id: string, wikiBase: string): ImageNode {
  const underscored = ref.file.replace(/ /g, '_');
  return {
    id,
    type: 'image',
    label: ref.caption ? stripMarkup(ref.caption) : ref.file.replace(/\.\w+$/, ''),
    data: new Uint8Array(0),
    mime: '',
    source: {
      file: ref.file,
      url: `${wikiBase}File:${encodeURIComponent(underscored)}`,
      omitted: 'unavailable',
    },
  };
}

/** Turn a block's picture references into nodes hanging off one hint. */
function imagesFor(block: Block, hintId: string, wikiBase: string): ImageNode[] | undefined {
  if (block.images.length === 0) return undefined;
  return block.images.map((ref, n) => toImageNode(ref, `${hintId}:i${n}`, wikiBase));
}

/** Build the subject tree for one page. */
function pageToSubject(
  page: WikiPageInput,
  idPrefix: string,
  reveal: RevealMode,
  resolve?: Resolver,
  /** Score, label and order the sections. Off for StrategyWiki. */
  rank = false,
  /** Collects each group's rank, for the index built at the document level. */
  rankOf: Map<string, number> = new Map(),
  /** Record picture references. Off for StrategyWiki. */
  images = false,
  /** e.g. https://blue-prince.fandom.com/wiki/ — for the "view on the wiki" link. */
  wikiBase = '',
  /** What the wiki says its templates expand to. */
  expanded: Record<string, string> = {},
): SubjectNode {
  const label = page.title.includes('/') ? page.title.slice(page.title.indexOf('/') + 1) : page.title;
  const root: SubjectNode = {
    id: idPrefix,
    type: 'subject',
    label: label.replace(/_/g, ' '),
    children: [],
  };

  const stack: { level: number; node: SubjectNode }[] = [{ level: 1, node: root }];
  let counter = 0;

  for (const section of splitSections(stripBlockMarkup(page.wikitext), expanded)) {
    // Filing, not content: references, galleries, track listings. Dropped
    // rather than ranked — they are only a few per cent of a wiki's prose, but
    // they are rows, and rows are what you scroll past.
    if (rank && isNeverHint(section.title)) continue;

    const blocks = toBlocks(section.body, resolve, images, expanded);

    let target = root;
    if (section.title) {
      while (stack.length > 1 && stack[stack.length - 1]!.level >= section.level) stack.pop();
      const parent = stack[stack.length - 1]!.node;
      const node: SubjectNode = {
        id: `${idPrefix}.${++counter}`,
        type: 'subject',
        label: section.title,
        children: [],
      };
      parent.children.push(node);
      stack.push({ level: section.level, node });
      target = node;
    }

    if (blocks.length === 0) continue;

    const spoilers = blocks.filter((b) => b.spoiler);
    const plain = blocks.filter((b) => !b.spoiler);

    if (plain.length > 0) {
      if (reveal === 'progressive') {
        // The heading is the question; each block is one step of the answer.
        const group: HintGroupNode = {
          id: `${target.id}.p${target.children.length}`,
          type: 'hints',
          label: section.title || root.label,
          hints: plain.map((block, index) => {
            const id = `${target.id}.p${target.children.length}:h${index}`;
            const hint: HintNode = { id, type: 'hint', content: block.content };
            const pictures = imagesFor(block, id, wikiBase);
            if (pictures) hint.images = pictures;
            return hint;
          }),
        };
        if (rank) {
          const signals = scoreSection(
            section.title || root.label,
            plain.map((block) => inlineText(block.content)).join(' '),
          );
          // Only the positive label is set. Calling everything else
          // `reference` would put "not a hint" on Obra Dinn's Identification
          // sections, which are the answers — the score cannot see them, and a
          // label is a claim the score is not entitled to make. Unlabelled
          // means "no opinion", and the rank still orders it.
          if (looksLikeGuidance(signals)) group.role = 'guidance';
          rankOf.set(group.id!, guidanceRank(signals));
        }
        target.children.push(group);
      } else {
        const text: TextNode = {
          id: `${target.id}.t${target.children.length}`,
          type: 'text',
          label: section.title || root.label,
          content: joinBlocks(plain),
        };
        target.children.push(text);
      }
    }

    if (spoilers.length > 0) {
      // Spoiler-marked content is hidden by default: one hint per block, so it
      // reveals in the same one-at-a-time way as everything else.
      const group: HintGroupNode = {
        id: `${target.id}.s${target.children.length}`,
        type: 'hints',
        label: section.title ? `${section.title} (spoilers)` : 'Spoilers',
        hints: spoilers.map((block, index) => {
          const id = `${target.id}.s${target.children.length}:h${index}`;
          const hint: HintNode = { id, type: 'hint', content: block.content };
          const pictures = imagesFor(block, id, wikiBase);
          if (pictures) hint.images = pictures;
          return hint;
        }),
      };
      target.children.push(group);
    }
  }

  return collapseSectionWrappers(root);
}

/**
 * Drop the subject a leaf section is wrapped in.
 *
 * Every section becomes a subject so that deeper headings have somewhere to
 * nest, but a section with no sub-headings ends up holding exactly one hint
 * group carrying the same heading — which the reader shows as "▸ Puzzle" and
 * then, one tap later, "? Puzzle". The wrapper earns nothing there, so it is
 * removed and the group takes its place.
 */
function collapseSectionWrappers(node: SubjectNode): SubjectNode {
  node.children = node.children.map((child) => {
    if (child.type !== 'subject') return child;
    const collapsed = collapseSectionWrappers(child);
    const only = collapsed.children.length === 1 ? collapsed.children[0] : undefined;
    return only && only.type === 'hints' && only.label === collapsed.label ? only : collapsed;
  });
  return node;
}

/**
 * Turn links with no destination back into text.
 *
 * The reader navigates by node id, so a link to an id that is not in the tree
 * is a button that goes nowhere. Cheaper to fix here, once, than to make every
 * caller of the reader defensive about it.
 */
function pruneDeadLinks(roots: Node[]): void {
  const ids = new Set<string>();
  const collect = (node: Node): void => {
    if (node.id) ids.add(node.id);
    if (node.type === 'subject') node.children.forEach(collect);
  };
  roots.forEach(collect);

  const fix = (content: Inline[]): Inline[] =>
    content.map((item) =>
      item.kind === 'link' && !ids.has(item.targetId)
        ? { kind: 'run' as const, text: item.label }
        : item,
    );

  const walkNode = (node: Node): void => {
    if (node.type === 'subject') node.children.forEach(walkNode);
    else if (node.type === 'text') node.content = fix(node.content);
    else if (node.type === 'hints') {
      for (const hint of node.hints) hint.content = fix(hint.content);
    }
  };
  roots.forEach(walkNode);
}

/** The best rank anywhere under a node — how promising the page looks. */
function bestRank(node: Node, rankOf: Map<string, number>): number {
  if (node.type === 'hints') return rankOf.get(node.id ?? '') ?? 0;
  if (node.type !== 'subject') return -Infinity;
  return node.children.reduce(
    (best, child) => Math.max(best, bestRank(child, rankOf)),
    -Infinity,
  );
}

/**
 * Lead with what reads like guidance, at every level.
 *
 * A stable sort, so pages that score the same keep the order the wiki gave
 * them — which for a chaptered game is the order it should be read in.
 */
function orderByGuidance(nodes: Node[], rankOf: Map<string, number>): void {
  for (const node of nodes) {
    if (node.type === 'subject') orderByGuidance(node.children, rankOf);
  }
  const ranked = nodes.map((node, index) => ({ node, index, rank: bestRank(node, rankOf) }));
  ranked.sort((a, b) => b.rank - a.rank || a.index - b.index);
  ranked.forEach((row, position) => {
    nodes[position] = row.node;
  });
}

/** How many entries the index offers before it stops being a shortcut. */
const INDEX_LIMIT = 20;

/**
 * A shortcut to the sections most likely to help.
 *
 * Sixty pages of wiki is not a hint system, it is a reading list, and the first
 * question is always "where do I start". This answers it without removing
 * anything: every page is still there, in full, one tap further away.
 *
 * "Likely", because the score is a guess. A deduction game's answers score zero
 * and will not appear here — they are still on their own pages, which is why
 * this is an index and not a filter.
 */
function guidanceIndex(children: Node[], rankOf: Map<string, number>): SubjectNode | null {
  const found: { id: string; label: string; rank: number }[] = [];
  const visit = (node: Node, page: string): void => {
    if (node.type === 'hints' && node.role === 'guidance' && node.id) {
      const rank = rankOf.get(node.id) ?? 0;
      // The page name is the useful half: "Room 46 — Puzzle" locates it, and a
      // bare "Puzzle" repeated eleven times does not.
      const label = node.label === page ? page : `${page} — ${node.label}`;
      found.push({ id: node.id, label, rank });
    }
    if (node.type === 'subject') for (const child of node.children) visit(child, page);
  };
  for (const child of children) visit(child, child.type === 'subject' ? child.label : '');

  if (found.length < 2) return null;
  found.sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label));

  return {
    id: 'p:guidance',
    type: 'subject',
    label: 'Likely guidance',
    children: found.slice(0, INDEX_LIMIT).map((row, i) => ({
      id: `p:guidance:${i}`,
      type: 'link' as const,
      label: row.label,
      targetId: row.id,
    })),
  };
}

export function parseWikiWalkthrough(
  pages: WikiPageInput[],
  options: WikiWalkthroughOptions,
): ParseResult {
  const warnings: string[] = [];
  const children: Node[] = [];
  const reveal = options.reveal ?? 'as-written';

  // Which pages survive, decided before anything is parsed. A link can point
  // forwards -- the first page routinely refers to the last -- so the set of
  // link targets has to be known up front, and a page dropped later would
  // otherwise leave links pointing at nothing.
  const kept = pages.filter((page, index) => {
    if (page.wikitext.trim() === '') {
      warnings.push(`${page.title}: page is empty`);
      return false;
    }
    if (/^#\s*REDIRECT/i.test(page.wikitext.trim())) return false;
    void index;
    return true;
  });

  const pageIds = new Map(kept.map((page, index) => [normalizePageTitle(page.title), `p:${index}`]));
  const resolve = (title: string): string | undefined => pageIds.get(title);
  const rank = options.rank ?? false;
  const rankOf = new Map<string, number>();
  const images = options.images ?? false;
  const expanded = options.expanded ?? {};

  kept.forEach((page, index) => {
    const subject = pageToSubject(
      page,
      `p:${index}`,
      reveal,
      resolve,
      rank,
      rankOf,
      images,
      options.baseUrl,
      expanded,
    );
    if (subject.children.length > 0) children.push(subject);
    else if (rank) {
      // Everything on it was a gallery, a table, or a references list. Worth
      // saying: "why is that page not here" is a fair question, and silence
      // makes it look like the download failed.
      warnings.push(`${page.title}: nothing on it reads as content`);
    }
  });

  // A page can still come out empty — every section a table, say — so anything
  // pointing at one is downgraded to plain text rather than left as a link to
  // a node that is not in the tree.
  pruneDeadLinks(children);

  if (children.length === 0) warnings.push('No readable content found on these pages.');

  const first = pages[0];
  const pageUrl =
    options.documentUrl ??
    `${options.baseUrl}${encodeURIComponent(options.gameTitle.replace(/ /g, '_'))}`;
  const revision = first?.revision ?? null;

  if (rank) {
    orderByGuidance(children, rankOf);
    const index = guidanceIndex(children, rankOf);
    if (index) children.unshift(index);
  }

  const root: SubjectNode =
    children.length === 1 && children[0]!.type === 'subject'
      ? (children[0] as SubjectNode)
      : { id: 'p:root', type: 'subject', label: options.gameTitle, children };
  root.label = options.gameTitle;

  const document: HintDocument = {
    id: stableId(options.kind, pageUrl),
    game: { title: options.gameTitle },
    source: {
      kind: options.kind,
      url: pageUrl,
      license: options.license,
      // CC-BY-SA requires attribution wherever the content is shown.
      attribution: `${options.gameTitle} on ${new URL(options.baseUrl).hostname}${
        revision ? `, revision ${revision}` : ''
      } — ${options.license}`,
      personalUseOnly: options.personalUseOnly,
      ...(revision ? { revision } : {}),
    },
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    root,
  };

  return { document, warnings };
}
