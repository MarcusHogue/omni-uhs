/**
 * Wiki tables, which used to be deleted outright.
 *
 * The fixture is the real `Chrono Trigger/Inns`, trimmed to five of its
 * fourteen rows (strategywiki.org, CC-BY-SA-4.0). That page is *nothing but* a
 * table, so before this it downloaded as an empty row in the library — which is
 * the failure worth pinning, because nothing about it looks like a failure.
 */

import { describe, expect, it } from 'vitest';

import type { TableNode } from '../../src/parser/ast.js';
import { walk } from '../../src/parser/ast.js';
import { deserializeDocument, serializeDocument } from '../../src/parser/serialize.js';
import { parseWikiWalkthrough } from '../../src/parser/wikitext/index.js';
import { extractTables, takeMarkers } from '../../src/parser/wikitext/tables.js';

const INNS = `{{Header Nav|game=Chrono Trigger}}
{|{{prettytable|sortable=1}}
!Location!!Era!!Price!!Info
|-
|'''Algetty''' (Terra Cave)||12,000 B.C.||Free||
|-
|'''Bangor Dome'''||2300 A.D.||Free||Enertron.
|-
|'''Choras Inn'''||1000 A.D.||10G||
|-
|'''Medina Inn''' (normal)||1000 A.D.||200G||You'll have to fight a Hench and two Diablos before you're allowed to rent a room.
|-
|'''Truce Inn'''||1000 A.D.||10G||Available throughout the game.
|}

{{Footer Nav|game=Chrono Trigger|prevpage=Equipment and items|nextpage=Jetbike Race}}`;

const OPTIONS = {
  kind: 'strategywiki' as const,
  gameTitle: 'Chrono Trigger',
  baseUrl: 'https://strategywiki.org/wiki/',
  license: 'CC-BY-SA-4.0',
  personalUseOnly: false,
  fetchedAt: '2026-01-01T00:00:00.000Z',
};

const tablesIn = (wikitext: string, title = 'Chrono Trigger/Inns'): TableNode[] => {
  const { document } = parseWikiWalkthrough([{ title, wikitext, revision: '1' }], OPTIONS);
  return [...walk(document.root)].filter((n): n is TableNode => n.type === 'table');
};

const plain = (cell: { kind: string; text?: string; label?: string }[]): string =>
  cell.map((part) => (part.kind === 'run' ? part.text : part.label)).join('');

describe('extractTables', () => {
  it('reads header and rows, one cell per column', () => {
    const { tables } = extractTables(INNS);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.headers).toEqual(['Location', 'Era', 'Price', 'Info']);
    expect(tables[0]!.rows).toHaveLength(5);
    expect(tables[0]!.rows[1]).toEqual(["'''Bangor Dome'''", '2300 A.D.', 'Free', 'Enertron.']);
  });

  it('leaves a marker where the table was, and the line count intact', () => {
    // Both matter downstream: `splitSections` counts lines, and the marker is
    // the only thing that says which section a table belonged to.
    const { text } = extractTables(INNS);
    expect(text.split('\n')).toHaveLength(INNS.split('\n').length);
    const markers = text.split('\n').filter((line) => takeMarkers(line).markers.length > 0);
    expect(markers).toHaveLength(1);
    // And nothing of the table itself survives into the prose.
    expect(text).not.toContain('Bangor Dome');
    expect(text).not.toContain('prettytable');
  });

  it('keeps a header written one cell per line', () => {
    // The common multiline form. Taking only the first `!` line as the header
    // put "Description" in a data row of its own and shifted every column after
    // it — a corrupted table rather than a missing one, which is worse.
    const perLine = `{|
! Name
! Description
|-
|Sword||Sharp
|}`;
    const [table] = extractTables(perLine).tables;
    expect(table!.headers).toEqual(['Name', 'Description']);
    expect(table!.rows).toEqual([['Sword', 'Sharp']]);
  });

  it('treats a ! after the first row break as a row header, not a heading', () => {
    const rowHeaders = `{|
!Name!!Value
|-
!Strength
|10
|}`;
    const [table] = extractTables(rowHeaders).tables;
    expect(table!.headers).toEqual(['Name', 'Value']);
    expect(table!.rows).toEqual([['Strength', '10']]);
  });

  it('accepts one cell per line as well as several to a line', () => {
    const mixed = `{|
!A!!B
|-
|one
|two
|-
|three||four
|}`;
    expect(extractTables(mixed).tables[0]!.rows).toEqual([
      ['one', 'two'],
      ['three', 'four'],
    ]);
  });

  it('drops a cell\'s HTML attributes but not a pipe inside its content', () => {
    // The one genuinely ambiguous piece of the syntax. `colspan="2"` is styling;
    // the pipe in a wikilink is not, and treating it as a divider would cut
    // every linked cell in half.
    const table = `{|
|colspan="2" style="background:brown"|Shop: Melchior
|-
|[[Chrono Trigger/Items|Iron Blade]]||350 G
|}`;
    expect(extractTables(table).tables[0]!.rows).toEqual([
      ['Shop: Melchior'],
      ['[[Chrono Trigger/Items|Iron Blade]]', '350 G'],
    ]);
  });

  it('keeps a nested table\'s rows rather than losing them', () => {
    const nested = `{|
|-
|outer
{|
|-
|inner
|}
|}`;
    const { tables } = extractTables(nested);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.rows.flat()).toContain('inner');
  });

  it('keeps what an unclosed table held', () => {
    expect(extractTables('{|\n|-\n|orphan').tables[0]!.rows).toEqual([['orphan']]);
  });
});

describe('tables in a parsed page', () => {
  it('turns a table-only page into a table instead of nothing', () => {
    const tables = tablesIn(INNS);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.rows).toHaveLength(5);
    // `'''Truce Inn'''` is emphasis markup, and has to be gone by now.
    expect(plain(tables[0]!.rows[4]![0]!)).toBe('Truce Inn');
    expect(plain(tables[0]!.headers[2]!)).toBe('Price');
  });

  it('is reachable by walk(), so search and export see it', () => {
    const { document } = parseWikiWalkthrough(
      [{ title: 'Chrono Trigger/Inns', wikitext: INNS, revision: '1' }],
      OPTIONS,
    );
    expect([...walk(document.root)].some((n) => n.type === 'table')).toBe(true);
  });

  it('keeps a link inside a cell as a link', () => {
    const { document } = parseWikiWalkthrough(
      [
        {
          title: 'Chrono Trigger/Markets',
          wikitext: '{|\n|-\n|[[../Items|Iron Blade]]||350 G\n|}',
          revision: '1',
        },
        { title: 'Chrono Trigger/Items', wikitext: 'Every item.', revision: '2' },
      ],
      OPTIONS,
    );
    const table = [...walk(document.root)].find((n): n is TableNode => n.type === 'table')!;
    expect(table.rows[0]![0]![0]).toMatchObject({ kind: 'link', label: 'Iron Blade' });
  });

  it('puts the table in the section it was written in', () => {
    const page = `== Shops ==
Buy what you can afford.
{|
!Item!!Price
|-
|Iron Blade||350 G
|}

== Silver Points ==
Fight Gato.`;
    const { document } = parseWikiWalkthrough(
      [{ title: 'Chrono Trigger/The Millennial Fair', wikitext: page, revision: '1' }],
      OPTIONS,
    );

    // Under Shops, beside its prose — not at the foot of the page, which is
    // where a page-level extraction would have left it.
    const shops = [...walk(document.root)].find(
      (n) => n.type === 'subject' && n.label === 'Shops',
    );
    expect(shops?.type === 'subject' && shops.children.some((c) => c.type === 'table')).toBe(true);
  });

  it('does not disturb the prose around it', () => {
    // Table extraction now runs on every wiki page, Fandom included, and the
    // failure that would matter is not a missing table — it is prose that moved.
    const withTable = `Buy what you can afford.

{|
!Item!!Price
|-
|Iron Blade||350 G
|}

Then head north.`;
    const without = 'Buy what you can afford.\n\nThen head north.';

    const prose = (wikitext: string): string =>
      [...walk(parseWikiWalkthrough([{ title: 'X/Y', wikitext, revision: '1' }], OPTIONS).document.root)]
        .flatMap((n) => (n.type === 'text' ? n.content : []))
        .map((i) => (i.kind === 'run' ? i.text : i.label))
        .join('');

    expect(prose(withTable)).toBe(prose(without));
  });

  it('does not corrupt a template that happens to contain a table', () => {
    // `extractTables` runs before `stripBlockMarkup`, so it sees table syntax
    // inside a template too. Whatever it does with the table, the sentence
    // either side of the template has to survive intact.
    const page = `Before.

{{Infobox
|data={|
|-
|a||b
|}
}}

After.`;
    const text = [...walk(parseWikiWalkthrough([{ title: 'X/Y', wikitext: page, revision: '1' }], OPTIONS).document.root)]
      .flatMap((n) => (n.type === 'text' ? n.content : []))
      .map((i) => (i.kind === 'run' ? i.text : i.label))
      .join('');
    expect(text).toContain('Before.');
    expect(text).toContain('After.');
    expect(text).not.toContain('Infobox');
    expect(text).not.toContain('|');
  });

  it('survives a serialize/deserialize round trip', () => {
    // Export writes the document through JSON, and a node type the serializer
    // does not know about is the kind of thing that silently loses cells.
    const { document } = parseWikiWalkthrough(
      [{ title: 'Chrono Trigger/Inns', wikitext: INNS, revision: '1' }],
      OPTIONS,
    );
    const back = deserializeDocument(JSON.parse(JSON.stringify(serializeDocument(document))));
    const table = [...walk(back.root)].find((n): n is TableNode => n.type === 'table')!;
    expect(table.rows).toHaveLength(5);
    expect(plain(table.rows[4]![0]!)).toBe('Truce Inn');
  });

  it('keeps a table inside a spoiler behind the spoiler', () => {
    // `stripBlockMarkup` flattens a multi-line `{{spoiler|…}}` onto one line,
    // so the table's marker ends up mid-template. Matching only whole lines
    // dropped the table *and* printed the raw marker as the hint's text.
    const page = `Intro.

{{spoiler|
{|
!A!!B
|-
|1||2
|}
}}`;
    const { document } = parseWikiWalkthrough(
      [{ title: 'Chrono Trigger/Secrets', wikitext: page, revision: '1' }],
      OPTIONS,
    );

    const hints = [...walk(document.root)].flatMap((n) => (n.type === 'hints' ? n.hints : []));
    const hint = hints.find((h) => h.tables);
    expect(hint?.tables?.[0]?.rows).toEqual([[[{ kind: 'run', text: '1' }], [{ kind: 'run', text: '2' }]]]);
    // Behind the reveal, not beside it: a table in a spoiler is the answer.
    expect([...walk(document.root)].filter((n) => n.type === 'table')).toHaveLength(1);
    const prose = [...walk(document.root)]
      .flatMap((n) => (n.type === 'text' ? n.content : []))
      .map((i) => (i.kind === 'run' ? i.text : i.label))
      .join('');
    expect(prose).toBe('Intro.');
    // And the marker never reaches anything a reader can see.
    for (const h of hints) {
      expect(h.content.map((i) => (i.kind === 'run' ? i.text : i.label)).join('')).not.toContain(
        'table:',
      );
    }
  });

  it('turns a dead link in a cell back into text', () => {
    // A page whose sections were all dropped still has an id in `pageIds`, so a
    // cell could link to a node that is not in the tree — and the reader
    // silently falls back to the document root when it cannot find one.
    const { document } = parseWikiWalkthrough(
      [
        {
          title: 'Chrono Trigger/Markets',
          wikitext: '{|\n|-\n|[[../Empty|Iron Blade]]||350 G\n|}',
          revision: '1',
        },
        // Nothing on it survives parsing, so it contributes no subject.
        { title: 'Chrono Trigger/Empty', wikitext: '{|\n|-\n|\n|}', revision: '2' },
      ],
      OPTIONS,
    );
    const table = [...walk(document.root)].find((n): n is TableNode => n.type === 'table')!;
    expect(table.rows[0]![0]![0]).toEqual({ kind: 'run', text: 'Iron Blade' });
  });

  it('leaves a layout-only table out rather than emitting an empty one', () => {
    // `extractTables` records every `{|` so its marker keeps pointing at the
    // right entry, and some of those hold nothing but a column of prose.
    expect(tablesIn('{|\n|-\n|\n|}\n\nJust prose.')).toEqual([]);
  });
});
