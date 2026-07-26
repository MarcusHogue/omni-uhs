import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Cache } from '../src/cache/index.js';
import { parseMasterIndex } from '../src/catalog/ifarchive.js';
import { parseIfdbSearch } from '../src/catalog/ifdb.js';
import { parseAllPages, parseRightsInfo, parseWikiSearch, apiUrl } from '../src/catalog/mediawiki.js';
import { NORMALIZE_VECTORS, normalizeTitle } from '../src/catalog/normalize.js';
import { describeSources, groupEntries } from '../src/catalog/search.js';
import { fallbackSlugs, hostFromQuery, slugCandidates } from '../src/catalog/discover.js';
import {
  allowWiki,
  allowedWikiHosts,
  describeWiki,
  forgetWiki,
  isWikiAllowed,
  kindForHost,
  siteTarget,
} from '../src/catalog/wikis.js';
import type { CatalogEntry } from '../src/catalog/types.js';
import { parseIndexHtml, parseUpdateCgi, searchUhsCatalog } from '../src/catalog/uhs.js';

describe('title normalization', () => {
  for (const [input, expected] of NORMALIZE_VECTORS) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeTitle(input)).toBe(expected);
    });
  }

  it('groups "The Longest Journey" with "Longest Journey, The"', () => {
    expect(normalizeTitle('The Longest Journey')).toBe(normalizeTitle('Longest Journey, The'));
  });
});

describe('uhs catalog parsing', () => {
  const sample = `
<FILE><FTITLE>The 11th Hour</FTITLE>
<FURL>http://www.uhs-hints.com/rfiles/11thhour.zip</FURL>
<FNAME>11thhour.uhs</FNAME><FDATE>23-Jan-96</FDATE>
<FSIZE>25024</FSIZE>
<FFULLSIZE>51278</FFULLSIZE></FILE>
<FILE><FTITLE>Zork I: The Great Underground Empire</FTITLE>
<FURL>http://www.uhs-hints.com/rfiles/zork1.zip</FURL>
<FNAME>zork1.uhs</FNAME><FDATE>02-Feb-97</FDATE>
<FSIZE>9562</FSIZE>
<FFULLSIZE>22830</FFULLSIZE></FILE>`;

  it('reads every record', () => {
    const entries = parseUpdateCgi(sample);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.title).toBe('The 11th Hour');
    expect(entries[0]!.fileName).toBe('11thhour.uhs');
    expect(entries[0]!.meta?.size).toBe(25024);
  });

  it('upgrades the advertised http URLs to https', () => {
    expect(parseUpdateCgi(sample)[0]!.ref).toBe('https://www.uhs-hints.com/rfiles/11thhour.zip');
  });

  it('normalizes titles for grouping', () => {
    expect(parseUpdateCgi(sample)[0]!.normalizedTitle).toBe('11th hour');
  });

  it('ignores malformed records rather than throwing', () => {
    expect(parseUpdateCgi('<FILE><FTITLE>No URL</FTITLE></FILE>')).toEqual([]);
    expect(parseUpdateCgi('not xml at all')).toEqual([]);
  });

  it('falls back to scraping the index page', () => {
    const html = `
      <table>
        <tr><td><a href="/rfiles/myst.zip">Myst</a></td></tr>
        <tr><td><a href="https://www.uhs-hints.com/rfiles/riven.zip"><b>Riven</b>: Sequel to Myst</a></td></tr>
        <tr><td><a href="/hints/other.html">Not a hint file</a></td></tr>
      </table>`;
    const entries = parseIndexHtml(html);
    expect(entries.map((e) => e.title)).toEqual(['Myst', 'Riven: Sequel to Myst']);
    expect(entries[0]!.ref).toBe('https://www.uhs-hints.com/rfiles/myst.zip');
    expect(entries[1]!.fileName).toBe('riven.uhs');
  });
});

describe('uhs catalog storage', () => {
  let dir: string;
  let cache: Cache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hint-catalog-'));
    cache = new Cache(dir);
    const insert = cache.db.prepare(
      `INSERT INTO catalog (source, ref, title, normalized_title, meta, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [title, ref] of [
      ['Zork I: The Great Underground Empire', 'https://x/zork1.zip'],
      ['Zork II: The Wizard of Frobozz', 'https://x/zork2.zip'],
      ['Myst', 'https://x/myst.zip'],
    ] as const) {
      insert.run('uhs', ref, title, normalizeTitle(title), '{}', Date.now());
    }
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('searches the local copy without any network access', () => {
    const results = searchUhsCatalog(cache, 'zork');
    expect(results.map((r) => r.title)).toEqual([
      'Zork I: The Great Underground Empire',
      'Zork II: The Wizard of Frobozz',
    ]);
  });

  it('matches case-insensitively and ignores punctuation', () => {
    expect(searchUhsCatalog(cache, 'MYST!').map((r) => r.title)).toEqual(['Myst']);
  });

  it('treats LIKE wildcards in the query as literal text', () => {
    expect(searchUhsCatalog(cache, '%')).toEqual([]);
  });
});

describe('IF Archive master index', () => {
  const xml = `
<ifarchive>
<file><name>zork1.sol</name><directory>if-archive/solutions</directory>
<path>if-archive/solutions/zork1.sol</path><size>1234</size><date>01-Jan-2000</date></file>
<file><name>AMFV.inv</name><directory>if-archive/infocom/hints/invisiclues</directory>
<path>if-archive/infocom/hints/invisiclues/AMFV.inv</path><size>32404</size></file>
<file><name>soundtrack.zip</name><directory>if-archive/solutions</directory>
<path>if-archive/solutions/soundtrack.zip</path><size>999</size></file>
<file><name>game.z5</name><directory>if-archive/games/zcode</directory>
<path>if-archive/games/zcode/game.z5</path><size>500</size></file>
</ifarchive>`;

  it('indexes only the hint-bearing directories', () => {
    const entries = parseMasterIndex(xml);
    expect(entries.map((e) => e.ref)).toEqual([
      'if-archive/solutions/zork1.sol',
      'if-archive/infocom/hints/invisiclues/AMFV.inv',
    ]);
  });

  it('skips archives and binaries it cannot read', () => {
    expect(parseMasterIndex(xml).some((e) => e.ref.endsWith('.zip'))).toBe(false);
  });

  it('derives a readable title from the filename', () => {
    expect(parseMasterIndex(xml)[0]!.title).toBe('zork1');
  });
});

describe('IFDB', () => {
  it('parses the search JSON', () => {
    const json = JSON.stringify({
      games: [
        { tuid: 'abc123', title: 'Zork', published: { machine: '1979' } },
        { tuid: 'def456', title: "Zork: A Troll's-Eye View" },
        { title: 'no tuid' },
      ],
    });
    const entries = parseIfdbSearch(json);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ sourceKind: 'ifdb', ref: 'abc123', meta: { year: 1979 } });
  });

  it('returns nothing for a Cloudflare challenge page instead of throwing', () => {
    expect(parseIfdbSearch('<!DOCTYPE html><title>Just a moment...</title>')).toEqual([]);
  });
});

describe('MediaWiki', () => {
  it('adds maxlag and formatversion to every API call', () => {
    const url = new URL(apiUrl('https://strategywiki.org/w/api.php', { action: 'query' }));
    expect(url.searchParams.get('maxlag')).toBe('5');
    expect(url.searchParams.get('formatversion')).toBe('2');
    expect(url.searchParams.get('format')).toBe('json');
  });

  it('groups sub-page hits under the game title', () => {
    const json = JSON.stringify({
      query: {
        search: [
          { title: 'Chrono Trigger/Walkthrough' },
          { title: 'Chrono Trigger/Sidequests' },
          { title: 'Chrono Cross' },
        ],
      },
    });
    const entries = parseWikiSearch(json, 'strategywiki');
    expect(entries.map((e) => e.title)).toEqual(['Chrono Trigger', 'Chrono Cross']);
    expect(entries[0]!.ref).toBe('Chrono Trigger/Walkthrough');
  });

  it('parses an allpages listing', () => {
    const json = JSON.stringify({
      query: { allpages: [{ title: 'Myst/Walkthrough' }, { title: 'Myst/Channelwood' }] },
    });
    expect(parseAllPages(json, 'strategywiki').map((e) => e.ref)).toEqual([
      'Myst/Walkthrough',
      'Myst/Channelwood',
    ]);
  });

  it('recognises CC-BY-SA and lets it be exported', () => {
    const info = parseRightsInfo(
      JSON.stringify({
        query: {
          rightsinfo: {
            url: 'https://creativecommons.org/licenses/by-sa/4.0/',
            text: 'Creative Commons Attribution-ShareAlike 4.0',
          },
        },
      }),
    );
    expect(info.license).toBe('CC-BY-SA-4.0');
    expect(info.personalUseOnly).toBe(false);
  });

  it('forces personal-use-only for a -NC license', () => {
    const info = parseRightsInfo(
      JSON.stringify({
        query: {
          rightsinfo: {
            url: 'https://creativecommons.org/licenses/by-nc-sa/3.0/',
            text: 'CC BY-NC-SA 3.0',
          },
        },
      }),
    );
    expect(info.personalUseOnly).toBe(true);
  });

  it('treats an unknown or unreadable license as personal-use-only', () => {
    expect(parseRightsInfo('garbage').personalUseOnly).toBe(true);
    expect(parseRightsInfo(JSON.stringify({ query: {} })).personalUseOnly).toBe(true);
  });
});

describe('cross-source grouping', () => {
  const entry = (sourceKind: CatalogEntry['sourceKind'], title: string): CatalogEntry => ({
    sourceKind,
    title,
    normalizedTitle: normalizeTitle(title),
    ref: `${sourceKind}:${title}`,
  });

  it('merges the same game from several sources into one group', () => {
    const groups = groupEntries(
      [
        entry('uhs', 'The Longest Journey'),
        entry('strategywiki', 'Longest Journey, The'),
        entry('ifdb', 'Myst'),
      ],
      'longest journey',
    );
    // Myst is dropped: it does not match the query at all, and something else did.
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((e) => e.sourceKind).sort()).toEqual(['strategywiki', 'uhs']);
  });

  it('keeps unrelated entries out of the results entirely', () => {
    const groups = groupEntries(
      [entry('uhs', 'The Longest Journey'), entry('ifdb', 'Myst')],
      'longest journey',
    );
    expect(groups.map((g) => g.title)).not.toContain('Myst');
  });

  it('but shows the near-misses when nothing matched, rather than nothing at all', () => {
    const groups = groupEntries([entry('ifdb', 'Trinity'), entry('ifdb', 'Unity!')], 'triniti');
    expect(groups).toHaveLength(2);
  });

  it('prefers the most descriptive title in a group', () => {
    const groups = groupEntries(
      [entry('uhs', 'Zork I'), entry('ifdb', 'Zork I')],
      'zork',
    );
    expect(groups[0]!.title).toBe('Zork I');
  });

  it('puts an exact match first', () => {
    const groups = groupEntries(
      [entry('uhs', 'Zork I: The Great Underground Empire'), entry('uhs', 'Zork')],
      'zork',
    );
    expect(groups[0]!.title).toBe('Zork');
  });

  it('caps the number of groups', () => {
    const many = Array.from({ length: 120 }, (_, i) => entry('uhs', `Game ${i}`));
    expect(groupEntries(many, 'game').length).toBeLessThanOrEqual(50);
  });
});

describe('search relevance', () => {
  const entry = (
    sourceKind: CatalogEntry['sourceKind'],
    title: string,
    ref = `${sourceKind}:${title}`,
  ): CatalogEntry => ({
    sourceKind,
    title,
    normalizedTitle: normalizeTitle(title),
    ref,
  });

  const titles = (entries: CatalogEntry[], query: string): string[] =>
    groupEntries(entries, query).map((group) => group.title);

  it('ranks a prefix match above a mere substring', () => {
    const order = titles(
      [entry('uhs', 'The Secret of Monkey Island'), entry('uhs', 'Monkey Island 2')],
      'monkey island',
    );
    expect(order[0]).toBe('Monkey Island 2');
  });

  it('does not let file count outrank the title you typed', () => {
    // The old ordering sorted by group size, so four IF Archive files for a
    // loosely-matching game buried the exact hit.
    const noisy = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((file) =>
      entry('ifarchive', 'Zork Zero Hints', `if-archive/solutions/${file}`),
    );
    expect(titles([...noisy, entry('uhs', 'Zork')], 'zork')[0]).toBe('Zork');
  });

  it('prefers the shorter of two matches that both start with the query', () => {
    const order = titles(
      [entry('uhs', 'Zork: The Undiscovered Underground'), entry('uhs', 'Zork II')],
      'zork',
    );
    expect(order[0]).toBe('Zork II');
  });

  it('groups a filename stem with its properly spelled sibling', () => {
    const groups = groupEntries(
      [entry('ifarchive', 'beyondzork', 'if-archive/solutions/beyondzork.sol'),
       entry('uhs', 'Beyond Zork')],
      'beyond zork',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.title).toBe('Beyond Zork');
  });

  it('sinks a group that only IFDB knows about', () => {
    const order = titles(
      [entry('ifdb', 'Trinity Redux'), entry('uhs', 'Trinity Redux II')],
      'trinity',
    );
    expect(order[0]).toBe('Trinity Redux II');
  });

  it('lists the readable source first inside a group', () => {
    const groups = groupEntries(
      [entry('ifdb', 'Trinity'), entry('uhs', 'Trinity'), entry('ifarchive', 'Trinity')],
      'trinity',
    );
    expect(groups[0]!.entries.map((e) => e.sourceKind)).toEqual(['uhs', 'ifarchive', 'ifdb']);
  });
});

describe('source advertisement', () => {
  let dir: string;
  let cache: Cache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hint-sources-'));
    cache = new Cache(dir);
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks StrategyWiki as off by default and says why', () => {
    const strategywiki = describeSources(cache).find((source) => source.kind === 'strategywiki');
    expect(strategywiki?.enabledByDefault).toBe(false);
    expect(strategywiki?.note).toMatch(/Cloudflare/);
  });

  it('still advertises it as searchable, so it can be turned on', () => {
    expect(describeSources(cache).map((source) => source.kind)).toContain('strategywiki');
    expect(
      describeSources(cache).filter((source) => source.enabledByDefault).map((s) => s.kind),
    ).toEqual(['uhs', 'ifarchive', 'ifdb']);
  });
});

describe('wiki discovery', () => {
  it('turns a game name into the slugs a wiki might live at', () => {
    expect(slugCandidates('Blue Prince')).toContain('blue-prince');
    expect(slugCandidates('Animal Well')).toContain('animalwell');
    // Articles and joining words are not part of a slug — but the literal form
    // is kept too, because "The Witness" really is thewitness.fandom.com.
    expect(slugCandidates('The Legend of Zelda')).toContain('legend-zelda');
    expect(slugCandidates('The Legend of Zelda')).toContain('the-legend-of-zelda');
    expect(slugCandidates('   ')).toEqual([]);
  });

  it('keeps the first-word guess for the fallback round only', () => {
    // A series title hangs off a short wiki, so this rescues Zelda...
    expect(fallbackSlugs('Zelda Tears of the Kingdom')).toEqual(['zelda']);
    // ...but tried in parallel it would offer blue.fandom.com — a real wiki,
    // about the colour — next to the right answer. It runs only when the full
    // name found nothing.
    expect(slugCandidates('Blue Prince')).not.toContain('blue');
    // Nothing to fall back to from a single word, or from an initial too short
    // to be anyone's wiki.
    expect(fallbackSlugs('Myst')).toEqual([]);
    expect(fallbackSlugs('Ico Shadow of the Colossus')).toEqual([]);
  });

  it('strips punctuation and accents rather than putting them in a hostname', () => {
    expect(slugCandidates('Pokémon: Red!')).toContain('pokemon-red');
    for (const slug of slugCandidates('Zork I: The Great Underground Empire')) {
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('takes a pasted address, at any depth, over guessing', () => {
    expect(hostFromQuery('blue-prince.fandom.com')).toBe('blue-prince.fandom.com');
    expect(hostFromQuery('https://animalwell.wiki.gg/wiki/Eggs')).toBe('animalwell.wiki.gg');
    expect(hostFromQuery('  HTTPS://Terraria.Wiki.GG/  ')).toBe('terraria.wiki.gg');
  });

  it('refuses an address that is not one of the two platforms', () => {
    // The suffix rule is the SSRF boundary for anything added at runtime.
    expect(hostFromQuery('http://169.254.169.254/latest/meta-data/')).toBeNull();
    expect(hostFromQuery('https://internal.corp')).toBeNull();
    expect(hostFromQuery('https://blue-prince.fandom.com.evil.test/')).toBeNull();
    expect(hostFromQuery('not a url')).toBeNull();
  });
});

describe('wiki registry', () => {
  it('routes a host to the right source', () => {
    expect(kindForHost('blue-prince.fandom.com')).toBe('fandom');
    expect(kindForHost('animalwell.wiki.gg')).toBe('wikigg');
    expect(kindForHost('strategywiki.org')).toBe('strategywiki');
    expect(kindForHost('example.com')).toBeNull();
    // Not a suffix match on a lookalike: `notfandom.com` must not pass.
    expect(kindForHost('notfandom.com')).toBeNull();
  });

  it('builds the api URL from what the wiki reported, not from its hostname', () => {
    // The bug this replaces: every non-Fandom host was sent to /w/api.php,
    // which 404s on wiki.gg. Both platforms report an empty scriptpath.
    const target = siteTarget({
      host: 'animalwell.wiki.gg',
      kind: 'wikigg',
      sitename: 'Animal Well Wiki',
      scriptPath: '',
      articlePath: '/wiki/$1',
      license: 'CC-BY-SA-4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      personalUseOnly: false,
      gamepedia: false,
    });
    expect(target.api).toBe('https://animalwell.wiki.gg/api.php');
    expect(target.pageBase).toBe('https://animalwell.wiki.gg/wiki/');
    // Carries its own allowlist, or every fetch is rejected as off-list.
    expect(target.allowlist).toEqual(['animalwell.wiki.gg']);
  });

  it('honours a non-empty script path, as a self-hosted MediaWiki has', () => {
    const target = siteTarget({
      host: 'wiki.example.test',
      kind: 'fandom',
      sitename: 'Example',
      scriptPath: '/w',
      articlePath: '/wiki/$1',
      license: 'CC-BY-SA',
      licenseUrl: '',
      personalUseOnly: false,
      gamepedia: false,
    });
    expect(target.api).toBe('https://wiki.example.test/w/api.php');
  });

  describe('describeWiki', () => {
    let dir: string;
    let cache: Cache;

    /** Answer any siteinfo call with one payload, and count the calls. */
    const stubSiteinfo = (payload: unknown): { calls: () => number } => {
      const fetch = vi
        .spyOn(cache, 'fetch')
        .mockResolvedValue({ path: '', contentType: 'application/json' } as never);
      vi.spyOn(cache, 'readText').mockResolvedValue(JSON.stringify(payload));
      return { calls: () => fetch.mock.calls.length };
    };

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'hint-wikis-'));
      cache = new Cache(dir);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      cache.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('records what the wiki says about itself, and asks only once', async () => {
      const stub = stubSiteinfo({
        query: {
          general: {
            sitename: 'Animal Well Wiki',
            scriptpath: '',
            articlepath: '/wiki/$1',
          },
          rightsinfo: {
            text: 'Creative Commons Attribution-ShareAlike 4.0',
            url: 'https://creativecommons.org/licenses/by-sa/4.0/',
          },
        },
      });

      const site = await describeWiki(cache, 'animalwell.wiki.gg');
      expect(site).toMatchObject({
        host: 'animalwell.wiki.gg',
        kind: 'wikigg',
        sitename: 'Animal Well Wiki',
        articlePath: '/wiki/$1',
        license: 'CC-BY-SA-4.0',
        personalUseOnly: false,
      });

      // Second lookup comes from SQLite: a script path is not worth a round trip
      // on every request, and a wiki that is down must not become unusable.
      await describeWiki(cache, 'animalwell.wiki.gg');
      expect(stub.calls()).toBe(1);
    });

    it('re-asks once the record is older than the index TTL', async () => {
      // A licence is not decoration: it decides whether documents from this
      // wiki may leave the device. A wiki that relicenses to -NC must not keep
      // producing shareable exports forever.
      stubSiteinfo({
        query: {
          general: { sitename: 'Some Wiki', scriptpath: '', articlepath: '/wiki/$1' },
          rightsinfo: { text: 'CC BY-SA 4.0', url: '' },
        },
      });
      expect((await describeWiki(cache, 'some.wiki.gg')).personalUseOnly).toBe(false);

      // Age the row past the TTL, then answer with a different licence.
      cache.db
        .prepare('UPDATE wiki_site SET updated_at = ? WHERE host = ?')
        .run(Date.now() - 8 * 24 * 3600 * 1000, 'some.wiki.gg');
      vi.restoreAllMocks();
      stubSiteinfo({
        query: {
          general: { sitename: 'Some Wiki', scriptpath: '', articlepath: '/wiki/$1' },
          rightsinfo: { text: 'CC BY-NC-SA 4.0', url: '' },
        },
      });
      expect((await describeWiki(cache, 'some.wiki.gg')).personalUseOnly).toBe(true);
    });

    it('serves the stale record when the wiki cannot be reached', async () => {
      stubSiteinfo({
        query: {
          general: { sitename: 'Some Wiki', scriptpath: '', articlepath: '/wiki/$1' },
          rightsinfo: { text: 'CC BY-SA 4.0', url: '' },
        },
      });
      await describeWiki(cache, 'some.wiki.gg');
      cache.db
        .prepare('UPDATE wiki_site SET updated_at = ? WHERE host = ?')
        .run(Date.now() - 8 * 24 * 3600 * 1000, 'some.wiki.gg');

      vi.restoreAllMocks();
      vi.spyOn(cache, 'fetch').mockRejectedValue(new Error('upstream down'));
      // Expired is not the same as unusable: an allowlisted host stays readable
      // while its wiki is having a bad day.
      expect((await describeWiki(cache, 'some.wiki.gg')).sitename).toBe('Some Wiki');
    });

    it('marks an NC wiki personal-use-only', async () => {
      stubSiteinfo({
        query: {
          general: { sitename: 'Terraria Wiki', scriptpath: '', articlepath: '/wiki/$1' },
          rightsinfo: {
            text: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0',
            url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
          },
        },
      });
      const site = await describeWiki(cache, 'terraria.wiki.gg');
      expect(site.personalUseOnly).toBe(true);
    });

    it('reports Fandom’s gamepedia flag, which arrives as a string', async () => {
      stubSiteinfo({
        query: {
          general: {
            sitename: 'Terraria Wiki',
            scriptpath: '',
            articlepath: '/wiki/$1',
            gamepedia: 'true',
          },
          rightsinfo: { text: 'CC BY-SA', url: '' },
        },
      });
      expect((await describeWiki(cache, 'terraria.fandom.com')).gamepedia).toBe(true);
    });

    it('refuses a host that belongs to no known platform', async () => {
      await expect(describeWiki(cache, 'evil.example.com')).rejects.toThrow(/not a recognised/);
    });

    it('adds and removes a wiki at runtime, with no restart in between', async () => {
      stubSiteinfo({
        query: {
          general: { sitename: 'Blue Prince Wiki', scriptpath: '', articlepath: '/wiki/$1' },
          rightsinfo: { text: 'CC BY-SA 4.0', url: '' },
        },
      });
      expect(isWikiAllowed(cache, 'blue-prince.fandom.com')).toBe(false);

      const site = await allowWiki(cache, 'Blue-Prince.Fandom.com');
      expect(site.sitename).toBe('Blue Prince Wiki');
      // Case-folded on the way in, so the allowlist has one spelling of a host.
      expect(allowedWikiHosts(cache)).toContain('blue-prince.fandom.com');
      expect(isWikiAllowed(cache, 'blue-prince.fandom.com')).toBe(true);

      expect(forgetWiki(cache, 'blue-prince.fandom.com')).toBe(true);
      expect(isWikiAllowed(cache, 'blue-prince.fandom.com')).toBe(false);
    });

    it('refuses to add anything that is not one of the two platforms', async () => {
      // This is the SSRF boundary: the app can widen the allowlist, but only
      // ever within Fandom and wiki.gg.
      for (const host of [
        'internal.corp',
        '169.254.169.254',
        'blue-prince.fandom.com.evil.test',
        'strategywiki.org',
      ]) {
        await expect(allowWiki(cache, host)).rejects.toThrow(/Fandom and wiki\.gg/);
      }
      expect(allowedWikiHosts(cache)).toEqual([]);
    });

    it('does not record a host that turned out not to be a wiki', async () => {
      vi.spyOn(cache, 'fetch').mockRejectedValue(
        Object.assign(new Error('Upstream responded 404'), { statusCode: 404 }),
      );
      await expect(allowWiki(cache, 'nosuchgame.fandom.com')).rejects.toThrow();
      expect(allowedWikiHosts(cache)).toEqual([]);
    });
  });

  it('stamps the wiki host onto entries so a result says where it came from', () => {
    const json = JSON.stringify({ query: { search: [{ title: 'Room 46' }] } });
    const target = siteTarget({
      host: 'blue-prince.fandom.com',
      kind: 'fandom',
      sitename: 'Blue Prince Wiki',
      scriptPath: '',
      articlePath: '/wiki/$1',
      license: 'CC-BY-SA',
      licenseUrl: '',
      personalUseOnly: false,
      gamepedia: false,
    });
    expect(parseWikiSearch(json, 'fandom', target)[0]).toMatchObject({
      sourceKind: 'fandom',
      ref: 'Room 46',
      host: 'blue-prince.fandom.com',
    });
    // Single-host sources stay clean: no host field where it would be noise.
    expect(parseWikiSearch(json, 'strategywiki')[0]!.host).toBeUndefined();
  });
});
