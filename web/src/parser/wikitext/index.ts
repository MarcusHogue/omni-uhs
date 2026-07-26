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
  Inline,
  Node,
  ParseResult,
  SourceKind,
  SubjectNode,
  TextNode,
} from '../ast';
import { stableId } from '../id';

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
  license: string;
  personalUseOnly: boolean;
  fetchedAt?: string;
  /** Defaults to `as-written`, so existing callers are unaffected. */
  reveal?: RevealMode;
  /**
   * Drop pages that look like stat tables rather than guidance. Only sensible
   * with `progressive`; off by default.
   */
  skipReferencePages?: boolean;
}

/** Templates whose content is a spoiler and must start hidden. */
const SPOILER_TEMPLATES = /^(spoiler|hidden|collapse|mbox spoiler)/i;

/**
 * Strip wiki markup down to display text, keeping internal links as link text.
 *
 * Deliberately conservative: this is a reader, not a renderer, so anything not
 * understood is dropped rather than shown as raw markup.
 */
export function stripMarkup(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/\S+\]/g, '')
    .replace(/'''''([^']+)'''''/g, '$1')
    .replace(/'''([^']+)'''/g, '$1')
    .replace(/''([^']+)''/g, '$1')
    .replace(/<\/?(?:small|big|b|i|u|s|em|strong|span|div|center|br)[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The display text of a template that is standing in for a word.
 *
 * Dropping templates wholesale is right for infoboxes and citations, but game
 * wikis also use them mid-sentence as glorified links — Blue Prince writes
 * `a very complex and long {{roomtype|Puzzle}};`, which came out as "a very
 * complex and long ;". So a template with exactly one unnamed parameter gives
 * that parameter back.
 *
 * Exactly one, deliberately. Two or more and the parameters have roles this
 * cannot know — `{{tooltip|shown|hovered}}` would be a coin flip — so those are
 * still dropped. Bare dimensions (`{{Reflist|30em}}`) and anything wordless are
 * layout, not prose.
 */
function templateText(buffer: string): string | null {
  const parts = buffer.split('|');
  if (parts.length !== 2) return null;
  const value = parts[1]!.trim();
  if (value.length === 0 || value.length > 60) return null;
  if (value.includes('=')) return null;
  if (!/[a-z]/i.test(value)) return null;
  if (/^\d+(\.\d+)?(px|em|%|pt)?$/i.test(value)) return null;
  return value;
}

/** Remove templates, tracking whether any of them marked a spoiler. */
function extractTemplates(text: string): { text: string; spoiler: boolean } {
  let spoiler = false;
  let out = '';
  let depth = 0;
  let buffer = '';
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('{{', i)) {
      depth += 1;
      i += 1;
      buffer = '';
      continue;
    }
    if (text.startsWith('}}', i) && depth > 0) {
      depth -= 1;
      i += 1;
      if (SPOILER_TEMPLATES.test(buffer.trim())) {
        spoiler = true;
        // Keep the spoiler's payload: "{{spoiler|the butler did it}}".
        const parts = buffer.split('|');
        if (parts.length > 1) out += ` ${parts.slice(1).join('|')} `;
      } else {
        // No padding: the template sits mid-sentence, next to its punctuation.
        out += templateText(buffer) ?? '';
      }
      buffer = '';
      continue;
    }
    if (depth > 0) buffer += text[i];
    else out += text[i];
  }
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
  if (!SPOILER_TEMPLATES.test(name)) return newlines;
  return template.replace(/\s*\n\s*/g, ' ') + newlines;
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
  text: string;
  spoiler: boolean;
}

const inline = (text: string): Inline[] => (text ? [{ kind: 'run', text }] : []);

/** Split a section's wikitext into displayable blocks. */
function toBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let paragraphSpoiler = false;

  const flush = (): void => {
    const text = stripMarkup(paragraph.join(' '));
    if (text) blocks.push({ text, spoiler: paragraphSpoiler });
    paragraph = [];
    paragraphSpoiler = false;
  };

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (/^\s*(\{\||\|\}|\|[-+}]|!)/.test(line)) continue; // tables: skip

    const { text: withoutTemplates, spoiler } = extractTemplates(line);
    const listItem = /^[*#:;]+\s*(.*)$/.exec(withoutTemplates);
    if (listItem) {
      flush();
      const text = stripMarkup(listItem[1] ?? '');
      if (text) blocks.push({ text, spoiler });
      continue;
    }
    paragraph.push(withoutTemplates);
    paragraphSpoiler ||= spoiler;
  }
  flush();
  return blocks;
}

interface Section {
  level: number;
  title: string;
  body: string;
}

export function splitSections(wikitext: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { level: 1, title: '', body: '' };
  for (const line of wikitext.split('\n')) {
    const heading = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
    if (heading) {
      sections.push(current);
      current = {
        level: heading[1]!.length,
        title: stripMarkup(heading[2]!),
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
 * Does this page read like guidance, or like a database row?
 *
 * A reference wiki's stat pages are mostly infobox templates and tables — the
 * two things `toBlocks` already discards — so a page whose surviving prose is a
 * thin rind around a big template is one we should not be turning into hints.
 * Returns the share of the page's lines that survived as readable prose.
 */
/** Readable characters left after templates and tables are removed. */
export function proseChars(wikitext: string): number {
  return splitSections(stripBlockMarkup(wikitext)).reduce(
    (total, section) => total + toBlocks(section.body).reduce((n, b) => n + b.text.length, 0),
    0,
  );
}

/** That prose as a share of the raw page. */
export function proseRatio(wikitext: string): number {
  const raw = wikitext.replace(/\s+/g, ' ').trim().length;
  return raw === 0 ? 0 : proseChars(wikitext) / raw;
}

/**
 * Is this page reference data rather than something to read?
 *
 * Ratio alone is the obvious measure and the wrong one: how much template soup
 * surrounds a page varies enormously, so a genuinely useful page can score low
 * simply for sitting under a big infobox. Blue Prince's *Antechamber* page —
 * one of the most guidance-heavy on that wiki — is 11% prose, and a ratio gate
 * threw it away.
 *
 * What actually separates a stat page is having almost no prose at all, in
 * absolute terms. So both have to be true before a page is dropped, and the
 * bias is deliberately towards keeping: a mediocre page costs a scroll, a
 * dropped guide costs the thing you came for.
 */
const MIN_PROSE_CHARS = 300;
const MIN_PROSE_RATIO = 0.15;

export function looksLikeReference(wikitext: string): boolean {
  return proseChars(wikitext) < MIN_PROSE_CHARS && proseRatio(wikitext) < MIN_PROSE_RATIO;
}

/** Build the subject tree for one page. */
function pageToSubject(page: WikiPageInput, idPrefix: string, reveal: RevealMode): SubjectNode {
  const label = page.title.includes('/') ? page.title.slice(page.title.indexOf('/') + 1) : page.title;
  const root: SubjectNode = {
    id: idPrefix,
    type: 'subject',
    label: label.replace(/_/g, ' '),
    children: [],
  };

  const stack: { level: number; node: SubjectNode }[] = [{ level: 1, node: root }];
  let counter = 0;

  for (const section of splitSections(stripBlockMarkup(page.wikitext))) {
    const blocks = toBlocks(section.body);

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
          hints: plain.map((block, index) => ({
            id: `${target.id}.p${target.children.length}:h${index}`,
            type: 'hint' as const,
            content: inline(block.text),
          })),
        };
        target.children.push(group);
      } else {
        const text: TextNode = {
          id: `${target.id}.t${target.children.length}`,
          type: 'text',
          label: section.title || root.label,
          content: inline(plain.map((b) => b.text).join('\n')),
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
        hints: spoilers.map((block, index) => ({
          id: `${target.id}.s${target.children.length}:h${index}`,
          type: 'hint' as const,
          content: inline(block.text),
        })),
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

export function parseWikiWalkthrough(
  pages: WikiPageInput[],
  options: WikiWalkthroughOptions,
): ParseResult {
  const warnings: string[] = [];
  const children: Node[] = [];
  const reveal = options.reveal ?? 'as-written';

  pages.forEach((page, index) => {
    if (page.wikitext.trim() === '') {
      warnings.push(`${page.title}: page is empty`);
      return;
    }
    if (/^#\s*REDIRECT/i.test(page.wikitext.trim())) return;
    if (options.skipReferencePages && looksLikeReference(page.wikitext)) {
      // Named, not silent: "why is that page missing" is a fair question.
      warnings.push(
        `${page.title}: skipped, reads as reference data rather than guidance ` +
          `(${proseChars(page.wikitext)} characters of prose)`,
      );
      return;
    }
    const subject = pageToSubject(page, `p:${index}`, reveal);
    if (subject.children.length > 0) children.push(subject);
  });

  if (children.length === 0) warnings.push('No readable content found on these pages.');

  const first = pages[0];
  const pageUrl = `${options.baseUrl}${encodeURIComponent(options.gameTitle.replace(/ /g, '_'))}`;
  const revision = first?.revision ?? null;

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
