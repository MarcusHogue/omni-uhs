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

export interface WikiWalkthroughOptions {
  kind: SourceKind;
  gameTitle: string;
  /** e.g. https://strategywiki.org/wiki/ */
  baseUrl: string;
  license: string;
  personalUseOnly: boolean;
  fetchedAt?: string;
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
      }
      buffer = '';
      continue;
    }
    if (depth > 0) buffer += text[i];
    else out += text[i];
  }
  return { text: out, spoiler };
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

/** Build the subject tree for one page. */
function pageToSubject(page: WikiPageInput, idPrefix: string): SubjectNode {
  const label = page.title.includes('/') ? page.title.slice(page.title.indexOf('/') + 1) : page.title;
  const root: SubjectNode = {
    id: idPrefix,
    type: 'subject',
    label: label.replace(/_/g, ' '),
    children: [],
  };

  const stack: { level: number; node: SubjectNode }[] = [{ level: 1, node: root }];
  let counter = 0;

  for (const section of splitSections(page.wikitext)) {
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
      const text: TextNode = {
        id: `${target.id}.t${target.children.length}`,
        type: 'text',
        label: section.title || root.label,
        content: inline(plain.map((b) => b.text).join('\n')),
      };
      target.children.push(text);
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

  return root;
}

export function parseWikiWalkthrough(
  pages: WikiPageInput[],
  options: WikiWalkthroughOptions,
): ParseResult {
  const warnings: string[] = [];
  const children: Node[] = [];

  pages.forEach((page, index) => {
    if (page.wikitext.trim() === '') {
      warnings.push(`${page.title}: page is empty`);
      return;
    }
    if (/^#\s*REDIRECT/i.test(page.wikitext.trim())) return;
    const subject = pageToSubject(page, `p:${index}`);
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
