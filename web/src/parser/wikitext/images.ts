/**
 * Pictures in wikitext: `[[File:…]]` links and `<gallery>` blocks.
 *
 * On several games the picture *is* the content. Blue Prince's puzzles are
 * scans of in-game documents — a parchment with a symbol grid on it — and the
 * text around them says little more than "see the diagram". Fifty of its pages
 * reference 377 distinct images between them.
 *
 * Pure string work, like everything under `parser/`: this module decides *which*
 * pictures a section refers to and what they are called. Fetching bytes,
 * choosing a size and storing them belong to `storage/images.ts`.
 */

/** A picture referenced by a page, before anything has been fetched. */
export interface ImageRef {
  /** Canonical `File:`-less title, e.g. `Antechamber puzzle.png`. */
  file: string;
  /** The caption as written, or '' when the reference carried none. */
  caption: string;
}

/**
 * Parameters that describe layout rather than content.
 *
 * Everything here is dropped; whatever unnamed parameter is left last is the
 * caption. MediaWiki itself works the same way, which is why a file link can
 * carry a caption without naming it.
 */
const LAYOUT_PARAM =
  /^(?:thumb|thumbnail|frame|framed|frameless|border|left|right|cent(?:er|re)|none|baseline|middle|sub|super|top|text-top|bottom|text-bottom|upright(?:=[\d.]+)?|\d+\s*x?\s*\d*\s*px|x\d+px)$/i;

/** Named parameters, all of which are layout or metadata. */
const NAMED_PARAM = /^(?:link|alt|lang|page|class|thumbtime|start|end|loop|muted)\s*=/i;

/** File extensions worth chasing. Video and audio are not pictures. */
const PICTURE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

/**
 * Characters MediaWiki forbids in a page title.
 *
 * A title carrying any of them cannot name a real file, so the reference is
 * broken at the source and there is nothing to fetch. Blue Prince has one:
 * a gallery line reading `File:Spare Room (Locked [[Locked Trunk]] north).jpg`,
 * where an editor left a wikilink inside the filename. Guessing what was meant
 * would be worse than leaving it out.
 */
const ILLEGAL_IN_TITLE = /[#<>[\]|{}]/;

/**
 * Names that are chrome on every wiki: icons, sprites, buttons, dividers.
 *
 * A cheap pre-filter only. The reliable test is the picture's dimensions, which
 * `storage/images.ts` applies once `imageinfo` has reported them — some of Blue
 * Prince's decorations are 6×8 pixels and named nothing in particular. This
 * catches the obvious ones before spending a request on them.
 */
const DECORATIVE_NAME =
  /\b(icon|sprite|button|bullet|divider|spacer|placeholder|blank|transparent|favicon|wordmark|site.?logo|stub|ambox|nav(?:box|icon)|emote|emoji|flag of)\b/i;

/** How MediaWiki compares two file titles: `_` is a space and case-1 is free. */
export function normalizeFileTitle(raw: string): string {
  const title = raw
    .replace(/^\s*(?:File|Image)\s*:\s*/i, '')
    .replace(/_/g, ' ')
    .trim();
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** True for a name that reads like page furniture rather than game content. */
export function looksDecorativeName(file: string): boolean {
  return DECORATIVE_NAME.test(file);
}

/**
 * Split a file link's body on `|`, ignoring the pipes inside a nested
 * `[[wikilink|label]]` or `{{template|arg}}` in the caption.
 *
 * Captions do contain links — "Solution to the [[Antechamber]] door" — and
 * a plain `split('|')` would cut them in half and hand back "label]]" as the
 * caption.
 */
function splitParams(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    if (body.startsWith('[[', i) || body.startsWith('{{', i)) {
      depth += 1;
      current += body.slice(i, i + 2);
      i += 1;
      continue;
    }
    if ((body.startsWith(']]', i) || body.startsWith('}}', i)) && depth > 0) {
      depth -= 1;
      current += body.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (body[i] === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += body[i];
  }
  parts.push(current);
  return parts;
}

/**
 * One `[[File:…]]` body — the text between the brackets — as a reference.
 *
 * Returns null for anything that is not a picture: `[[File:Theme.ogg]]`,
 * `[[File:Trailer.webm|thumb]]`, and a `link=`-only decoration with no file
 * extension at all.
 */
export function parseFileLink(body: string): ImageRef | null {
  const params = splitParams(body);
  const file = normalizeFileTitle(params[0] ?? '');
  if (!file || !PICTURE_EXT.test(file) || ILLEGAL_IN_TITLE.test(file)) return null;

  let caption = '';
  for (const raw of params.slice(1)) {
    const param = raw.trim();
    if (!param || LAYOUT_PARAM.test(param) || NAMED_PARAM.test(param)) continue;
    // Last unnamed parameter wins, which is MediaWiki's own rule.
    caption = param;
  }
  return { file, caption };
}

/** Where a `[[File:…]]` or `[[Image:…]]` link starts. */
const FILE_LINK_START = /\[\[\s*(?:File|Image)\s*:/gi;

/** One file link: where it sits in the text, and what it refers to. */
interface FoundLink {
  start: number;
  end: number;
  ref: ImageRef | null;
}

/**
 * Locate every `[[File:…]]` in a run of wikitext, bracket-balanced.
 *
 * Balanced rather than regex-matched because a caption may itself contain
 * `[[…]]` — "Solution to the [[Antechamber]] door" is exactly how a wiki writes
 * one — and a lazy `[^\]]*` stops at the first `]]` inside it, leaving `door]]`
 * behind as prose.
 */
function scanFileLinks(wikitext: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const match of [...wikitext.matchAll(FILE_LINK_START)]) {
    let depth = 1;
    let i = match.index + match[0].length;
    const body = i;
    for (; i < wikitext.length && depth > 0; i++) {
      if (wikitext.startsWith('[[', i)) {
        depth += 1;
        i += 1;
      } else if (wikitext.startsWith(']]', i)) {
        depth -= 1;
        i += 1;
      }
    }
    // An unclosed link runs to the end of the page; leave it alone rather than
    // swallowing the rest of the section as a caption.
    if (depth > 0) continue;
    found.push({
      start: match.index,
      end: i,
      ref: parseFileLink(`${match[0].replace(/^\[\[/, '')}${wikitext.slice(body, i - 2)}`),
    });
  }
  return found;
}

/**
 * Every picture referenced by a run of wikitext, in order.
 *
 * Decorative names are left out here rather than filtered downstream: a nav
 * icon that reaches the AST becomes a hint with no text in it.
 */
export function findFileLinks(wikitext: string): ImageRef[] {
  return scanFileLinks(wikitext)
    .map((link) => link.ref)
    .filter((ref): ref is ImageRef => ref !== null && !looksDecorativeName(ref.file));
}

/**
 * The same text with every file link removed, captions and all.
 *
 * This is what `removed()` in the wikitext parser wants and could not express:
 * its `FILING_LINK` pattern handles the flat `[[Category:X]]` case but cannot
 * balance a caption that contains a link of its own.
 */
export function stripFileLinks(wikitext: string): string {
  let out = '';
  let cursor = 0;
  for (const { start, end } of scanFileLinks(wikitext)) {
    out += wikitext.slice(cursor, start);
    cursor = end;
  }
  return out + wikitext.slice(cursor);
}

/** `<gallery …>` and its closing tag. */
const GALLERY = /<gallery\b[^>]*>([\s\S]*?)<\/gallery\s*>/gi;

/**
 * Pull the pictures out of every `<gallery>` block, and give back the wikitext
 * without them.
 *
 * A gallery's lines are bare `File:X.png|Caption` — no brackets — so nothing
 * upstream recognised them: `FILING_LINK` only matches `[[File:…]]`, and
 * `cleaned` strips a fixed list of inline HTML tags that does not include
 * `gallery`. The whole block was surviving into a hint as prose reading
 * `<gallery widths="200px"> File:Conceptart 01.jpg File:Conceptart 02.jpg`.
 */
export function extractGalleries(wikitext: string): { text: string; images: ImageRef[] } {
  const images: ImageRef[] = [];
  const text = wikitext.replace(GALLERY, (all: string, body: string) => {
    for (const line of body.split('\n')) {
      const entry = line.trim();
      if (!entry) continue;
      const ref = parseFileLink(entry);
      if (ref) images.push(ref);
    }
    // Newlines survive so section splitting and blank-line paragraph breaks
    // downstream see the same shape they did before.
    return all.replace(/[^\n]/g, '');
  });
  return { text, images };
}

/**
 * Every picture a run of wikitext refers to, deduplicated by file.
 *
 * The first caption wins: a picture used twice on a page is usually captioned
 * where it is explained and left bare where it is repeated.
 */
export function collectImages(wikitext: string): { text: string; images: ImageRef[] } {
  const { text, images: fromGalleries } = extractGalleries(wikitext);
  const seen = new Map<string, ImageRef>();
  for (const ref of [...findFileLinks(text), ...fromGalleries]) {
    const existing = seen.get(ref.file);
    if (!existing) seen.set(ref.file, ref);
    else if (!existing.caption && ref.caption) existing.caption = ref.caption;
  }
  return { text, images: [...seen.values()] };
}
