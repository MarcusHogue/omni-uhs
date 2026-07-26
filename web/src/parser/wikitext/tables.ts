/**
 * Wiki tables, which used to be deleted.
 *
 * `stripBlockMarkup` keeps only the newlines inside `{| … |}`. That is defensible
 * on a Fandom wiki, where a table is usually an infobox or a stat grid beside the
 * prose — but StrategyWiki writes its reference material *as* tables, and the
 * result was that `Chrono Trigger/Inns` downloaded as an empty page. Fourteen
 * inns, their eras and their prices, gone. The same is true of Equipment and
 * items, Markets, Tabs, Bosses, Experience, Formulae, Stat gains and Techniques:
 * most of the appendices of most games.
 *
 * Extraction has to happen *before* stripping, for the same reason `<gallery>`
 * does, and it leaves the newlines behind for the same reason too — everything
 * downstream splits on blank lines and counts them.
 *
 * ## What wikitext tables actually look like
 *
 * ```
 * {|{{prettytable|sortable=1}}
 * !Location!!Era!!Price
 * |-
 * |'''Truce Inn'''||1000 A.D.||10G
 * |-
 * |Porre Inn
 * |1000 A.D.
 * |20G
 * |}
 * ```
 *
 * Cells come two ways — several to a line separated by `||`, or one per line
 * after a leading `|` — and both appear inside a single real table. A cell can
 * also carry HTML attributes before a *single* `|`
 * (`| colspan="2" | Shop: Melchior`), which is the one genuinely ambiguous piece
 * of the syntax and is handled below.
 */

import type { Inline } from '../ast';

export interface TableRef {
  caption: string;
  /** Raw cell text, before inline parsing — this module stays free of it. */
  headers: string[];
  rows: string[][];
}

/** A table opens on `{|` at the start of a line and closes on `|}`. */
const TABLE_OPEN = /^\s*\{\|/;
const TABLE_CLOSE = /^\s*\|\}/;

/**
 * Split a cell line into cells.
 *
 * `!!` and `||` separate cells on one line. A lone `|` inside a cell does *not*
 * — that is the attribute separator — so the split is on the doubled form only,
 * and `stripCellAttributes` deals with the single one afterwards.
 */
function splitCells(line: string, separator: '||' | '!!'): string[] {
  return line.split(separator).map((cell) => stripCellAttributes(cell));
}

/**
 * Drop the HTML attributes in front of a cell's content.
 *
 * `| colspan="2" | Shop: Melchior` renders as "Shop: Melchior"; the first
 * segment is styling. But `| 10G` has no attributes and `| Free || Enertron.`
 * has already been split, so a bare `|` cannot simply be treated as a divider —
 * most cells contain none at all, and a wikilink contains one routinely.
 *
 * The rule MediaWiki uses is that attributes are only recognised when the part
 * before the `|` looks like attributes: no wiki markup, and either an `=` or
 * nothing but a bare word. Anything else is content that happens to contain a
 * pipe, and is left whole.
 */
function stripCellAttributes(cell: string): string {
  const pipe = cell.indexOf('|');
  if (pipe === -1) return cell.trim();

  const head = cell.slice(0, pipe);
  // A link or a template before the pipe means the pipe belongs to *it*.
  if (/[[\]{}]/.test(head)) return cell.trim();
  if (!/=/.test(head)) return cell.trim();
  return cell.slice(pipe + 1).trim();
}

/**
 * Where a table was, left behind in the text so its position survives.
 *
 * Blanking the lines the way `extractGalleries` does would be enough to keep the
 * line count right, but not to say *which section* a table belonged to — and a
 * page has many. A marker line costs nothing: `stripBlockMarkup` passes it
 * through untouched, `splitSections` treats it as an ordinary line, and
 * `toBlocks` swaps it back for the table. The control characters cannot collide
 * with anything a wiki can write.
 */
const MARKER_OPEN = '\u0000table:';
const MARKER_CLOSE = '\u0000';

export const tableMarker = (index: number): string =>
  `${MARKER_OPEN}${index}${MARKER_CLOSE}`;

/** The table a marker line stands for, or -1 if this is not one. */
export function markedTable(line: string): number {
  const trimmed = line.trim();
  if (!trimmed.startsWith(MARKER_OPEN) || !trimmed.endsWith(MARKER_CLOSE)) return -1;
  const index = Number(trimmed.slice(MARKER_OPEN.length, -MARKER_CLOSE.length));
  return Number.isInteger(index) && index >= 0 ? index : -1;
}

/**
 * Pull every table out of one page's wikitext.
 *
 * Nested tables are flattened into the outer one rather than parsed separately:
 * they are a layout device, and the alternative — dropping the inner rows — is
 * the failure this module exists to fix.
 */
export function extractTables(wikitext: string): { text: string; tables: TableRef[] } {
  const tables: TableRef[] = [];
  const kept: string[] = [];
  const lines = wikitext.split('\n');

  let depth = 0;
  let caption = '';
  let headers: string[] = [];
  let rows: string[][] = [];
  let row: string[] | null = null;

  const endRow = (): void => {
    if (row && row.length > 0) rows.push(row);
    row = null;
  };

  const endTable = (): void => {
    endRow();
    // Always pushed, even when empty, so the marker written on `{|` keeps
    // pointing at the right entry.
    tables.push({ caption, headers, rows });
    caption = '';
    headers = [];
    rows = [];
  };

  for (const line of lines) {
    if (TABLE_OPEN.test(line)) {
      depth += 1;
      // An inner table's rows join the outer one; only the outermost resets.
      if (depth === 1) {
        caption = '';
        headers = [];
        rows = [];
        row = null;
        // Claim the index now: a nested table must not take the outer one's
        // place in the list, and the outer one's marker is already written.
        kept.push(tableMarker(tables.length));
      } else {
        kept.push('');
      }
      continue;
    }

    if (depth === 0) {
      kept.push(line);
      continue;
    }

    kept.push('');

    if (TABLE_CLOSE.test(line)) {
      depth -= 1;
      if (depth === 0) endTable();
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('|+')) {
      caption = stripCellAttributes(trimmed.slice(2)).trim();
    } else if (trimmed.startsWith('|-')) {
      endRow();
    } else if (trimmed.startsWith('!')) {
      // A header line outside a row is the table's header; inside one it is a
      // row header, which reads as an ordinary first cell.
      const cells = splitCells(trimmed.slice(1), '!!');
      if (row === null && headers.length === 0 && rows.length === 0) headers.push(...cells);
      else (row ??= []).push(...cells);
    } else if (trimmed.startsWith('|')) {
      (row ??= []).push(...splitCells(trimmed.slice(1), '||'));
    } else if (trimmed !== '' && row !== null && row.length > 0) {
      // A cell whose content wraps onto the next line.
      row[row.length - 1] += ` ${trimmed}`;
    }
  }

  // An unclosed table runs to the end of the page; keep what it held anyway.
  if (depth > 0) endTable();

  return { text: kept.join('\n'), tables };
}

/** Every cell of a table, for callers that only want its words. */
export function tableText(table: { headers: Inline[][]; rows: Inline[][][] }): string[] {
  return [...table.headers, ...table.rows.flat()].map((cell) =>
    cell.map((part) => (part.kind === 'run' ? part.text : part.label)).join(''),
  );
}
