import { describe, expect, it } from 'vitest';

import { walk } from '../../src/parser/ast.js';
import {
  collectImages,
  extractGalleries,
  findFileLinks,
  looksDecorativeName,
  normalizeFileTitle,
  parseFileLink,
  stripFileLinks,
} from '../../src/parser/wikitext/images.js';
import { parseWikiWalkthrough } from '../../src/parser/wikitext/index.js';

describe('normalizeFileTitle', () => {
  it('matches how MediaWiki compares titles', () => {
    expect(normalizeFileTitle('File:antechamber_puzzle.png')).toBe('Antechamber puzzle.png');
    expect(normalizeFileTitle('  Image : Map.PNG ')).toBe('Map.PNG');
    // Same file written two ways on two pages must fetch once.
    expect(normalizeFileTitle('File:Room 46.jpg')).toBe(normalizeFileTitle('Room_46.jpg'));
  });
});

describe('parseFileLink', () => {
  it('drops layout parameters and keeps the caption', () => {
    expect(parseFileLink('File:Door.png|thumb|300px|right|Solution to the door')).toEqual({
      file: 'Door.png',
      caption: 'Solution to the door',
    });
  });

  it('keeps a caption that contains a wikilink of its own', () => {
    expect(parseFileLink('File:Door.png|thumb|Solution to the [[Antechamber]] door')?.caption).toBe(
      'Solution to the [[Antechamber]] door',
    );
  });

  it('ignores named parameters', () => {
    expect(parseFileLink('File:Icon.png|20px|link=|alt=an icon')?.caption).toBe('');
  });

  it('refuses anything that is not a picture', () => {
    expect(parseFileLink('File:Theme.ogg|thumb')).toBeNull();
    expect(parseFileLink('File:Trailer.webm')).toBeNull();
    expect(parseFileLink('File:NoExtension|thumb')).toBeNull();
  });

  it('refuses a title MediaWiki could not name', () => {
    // Real, from Blue Prince: an editor left a wikilink inside the filename.
    expect(parseFileLink('File:Spare Room (Locked [[Locked Trunk]] north).jpg|A caption')).toBeNull();
  });
});

describe('looksDecorativeName', () => {
  it('recognises page furniture', () => {
    expect(looksDecorativeName('Spare Room - Spare Bedroom Icon.png')).toBe(true);
    expect(looksDecorativeName('Nav sprite.png')).toBe(true);
    expect(looksDecorativeName('Antechamber puzzle.png')).toBe(false);
  });
});

describe('findFileLinks', () => {
  it('balances brackets rather than stopping at the first close', () => {
    const refs = findFileLinks(
      'Before [[File:Door.png|thumb|See the [[Antechamber]] door]] after.',
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]!.file).toBe('Door.png');
  });

  it('leaves out decorative names', () => {
    expect(findFileLinks('[[File:Nav icon.png|20px|link=]]')).toEqual([]);
  });

  it('ignores an unclosed link instead of swallowing the rest', () => {
    expect(findFileLinks('[[File:Door.png|thumb|no close\n\nA later paragraph.')).toEqual([]);
  });
});

describe('stripFileLinks', () => {
  it('removes the whole link, nested caption included', () => {
    expect(
      stripFileLinks('Before [[File:Door.png|thumb|See the [[Antechamber]] door]] after.'),
    ).toBe('Before  after.');
  });

  it('leaves ordinary wikilinks alone', () => {
    expect(stripFileLinks('See [[The Antechamber]] for more.')).toBe(
      'See [[The Antechamber]] for more.',
    );
  });
});

describe('extractGalleries', () => {
  const GALLERY = `Prose above.

<gallery class="center" widths="200px">
File:One.png
File:Two.jpg|The village
File:Theme.ogg
</gallery>

Prose below.
`;

  it('takes the pictures out and leaves no markup behind', () => {
    const { text, images } = extractGalleries(GALLERY);
    expect(text).not.toContain('gallery');
    expect(text).not.toContain('File:');
    expect(images.map((i) => i.file)).toEqual(['One.png', 'Two.jpg']);
    expect(images[1]!.caption).toBe('The village');
  });

  it('keeps the line count, so section splitting is unaffected', () => {
    const { text } = extractGalleries(GALLERY);
    expect(text.split('\n')).toHaveLength(GALLERY.split('\n').length);
  });
});

describe('collectImages', () => {
  it('deduplicates by file and keeps the caption that has one', () => {
    const { images } = collectImages(
      '[[File:Map.png|thumb]] and again [[File:Map.png|thumb|The full map]]',
    );
    expect(images).toEqual([{ file: 'Map.png', caption: 'The full map' }]);
  });
});

describe('images in a parsed wiki page', () => {
  const parse = (wikitext: string, images: boolean) =>
    parseWikiWalkthrough([{ title: 'Spare Room', wikitext, revision: '1' }], {
      kind: 'fandom',
      gameTitle: 'Blue Prince',
      baseUrl: 'https://blue-prince.fandom.com/wiki/',
      license: 'CC-BY-SA',
      personalUseOnly: true,
      reveal: 'progressive',
      rank: true,
      images,
    });

  const PAGE = `== The Antechamber ==
[[File:Antechamber puzzle.png|thumb|300px|Solution to the [[Antechamber]] door]]
Turn the dials to match.
`;

  it('attaches the picture to the hint, not the subject', () => {
    const { document } = parse(PAGE, true);
    const hints = [...walk(document.root)].filter((n) => n.type === 'hints');
    const withImages = hints.flatMap((n) => (n.type === 'hints' ? n.hints : [])).filter((h) => h.images);
    expect(withImages).toHaveLength(1);
    const image = withImages[0]!.images![0]!;
    expect(image.source?.file).toBe('Antechamber puzzle.png');
    expect(image.label).toBe('Solution to the Antechamber door');
    // No bytes yet, and nothing may render it as though there were.
    expect(image.data.length).toBe(0);
    expect(image.source?.omitted).toBe('unavailable');
    expect(image.source?.url).toBe(
      'https://blue-prince.fandom.com/wiki/File:Antechamber_puzzle.png',
    );
  });

  it('records nothing when images are off', () => {
    const { document } = parse(PAGE, false);
    for (const node of walk(document.root)) {
      if (node.type === 'hints') for (const hint of node.hints) expect(hint.images).toBeUndefined();
    }
  });

  it('strips a gallery from the prose whether images are on or off', () => {
    const page = `== Locations ==
It sits above the crater.

<gallery>
File:Conceptart 01.jpg
</gallery>
`;
    for (const images of [true, false]) {
      const text = [...walk(parse(page, images).document.root)]
        .flatMap((n) => (n.type === 'hints' ? n.hints : []))
        .flatMap((h) => h.content)
        .map((i) => (i.kind === 'run' ? i.text : i.label))
        .join(' ');
      expect(text).not.toContain('gallery');
      expect(text).not.toContain('Conceptart');
    }
  });

  it('keeps a section whose only content is a picture', () => {
    const { document } = parse('== Room 46 ==\n[[File:Room 46 solution.png|thumb|The way in]]\n', true);
    const hint = [...walk(document.root)]
      .flatMap((n) => (n.type === 'hints' ? n.hints : []))
      .find((h) => h.images);
    expect(hint?.images?.[0]?.source?.file).toBe('Room 46 solution.png');
  });

  it('keeps the picture on a page read as written', () => {
    // StrategyWiki renders as-written, so its prose is a `text` node rather
    // than a hint — and `text` had nowhere to put a picture, so every one on
    // every StrategyWiki page was parsed and then dropped on the floor.
    const { document } = parseWikiWalkthrough(
      [{ title: 'Chrono Trigger/The Millennial Fair', wikitext: PAGE, revision: '1' }],
      {
        kind: 'strategywiki',
        gameTitle: 'Chrono Trigger',
        baseUrl: 'https://strategywiki.org/wiki/',
        license: 'CC-BY-SA-4.0',
        personalUseOnly: false,
        reveal: 'as-written',
        images: true,
      },
    );

    const texts = [...walk(document.root)].filter((n) => n.type === 'text');
    expect(texts.flatMap((n) => (n.type === 'text' ? (n.images ?? []) : []))).toHaveLength(1);
    // And reachable by walk(), which is what the orphan sweep counts as "in
    // use" — without it every StrategyWiki picture would look reclaimable.
    expect([...walk(document.root)].some((n) => n.type === 'image')).toBe(true);
  });

  it('is reachable by walk(), so search and export see it', () => {
    const { document } = parse(PAGE, true);
    expect([...walk(document.root)].some((n) => n.type === 'image')).toBe(true);
  });
});
