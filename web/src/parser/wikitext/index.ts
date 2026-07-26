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
import { inlineText } from '../ast';
import { stableId } from '../id';
import { guidanceRank, isNeverHint, looksLikeGuidance, scoreSection } from './guidance';

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
const FILING_LINK = /\[\[(?:Category|File|Image|Media|Template|Special):[^\]]*\]\]/gi;

/** Everything that vanishes: markers, filing, and comments. */
const removed = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(FILING_LINK, '');

/** Everything else, once the links have been dealt with. */
const cleaned = (text: string): string =>
  text
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
    .replace(/\s+/g, ' ');

/**
 * Strip wiki markup down to display text, keeping internal links as link text.
 *
 * Deliberately conservative: this is a reader, not a renderer, so anything not
 * understood is dropped rather than shown as raw markup.
 */
export function stripMarkup(text: string): string {
  return cleaned(
    removed(text)
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
  /** Display content, with in-document links preserved as links. */
  content: Inline[];
  spoiler: boolean;
}

/** Resolves a page title to the id of its subject, when it is in this download. */
type Resolver = (title: string) => string | undefined;

/** Concatenate blocks into one run sequence, separated by newlines. */
const joinBlocks = (blocks: Block[]): Inline[] =>
  blocks.flatMap((block, index) =>
    index === 0 ? block.content : [{ kind: 'run' as const, text: '\n' }, ...block.content],
  );

/** Split a section's wikitext into displayable blocks. */
function toBlocks(body: string, resolve?: Resolver): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let paragraphSpoiler = false;

  const push = (raw: string, spoiler: boolean): void => {
    const content = toInline(raw, resolve);
    if (content.length > 0) blocks.push({ content, spoiler });
  };

  const flush = (): void => {
    push(paragraph.join(' '), paragraphSpoiler);
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
      push(listItem[1] ?? '', spoiler);
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

  for (const section of splitSections(stripBlockMarkup(page.wikitext))) {
    // Filing, not content: references, galleries, track listings. Dropped
    // rather than ranked — they are only a few per cent of a wiki's prose, but
    // they are rows, and rows are what you scroll past.
    if (rank && isNeverHint(section.title)) continue;

    const blocks = toBlocks(section.body, resolve);

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
            content: block.content,
          })),
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
        hints: spoilers.map((block, index) => ({
          id: `${target.id}.s${target.children.length}:h${index}`,
          type: 'hint' as const,
          content: block.content,
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

  kept.forEach((page, index) => {
    const subject = pageToSubject(page, `p:${index}`, reveal, resolve, rank, rankOf);
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
