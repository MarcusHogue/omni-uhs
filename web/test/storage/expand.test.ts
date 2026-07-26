/**
 * Asking a wiki what its own templates say.
 *
 * The two failure modes worth pinning are both about *not* trusting the answer:
 * a reply whose parts no longer line up with the calls, and an answer that turns
 * out to depend on which page asked. Both would put text on screen under the
 * wrong name, which is worse than the missing word this feature exists to fix.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { expandTemplates } from '../../src/storage/expand.js';

const SEPARATOR = '{{{OMNI-UHS-SPLIT}}}';

vi.mock('../../src/api/client.js', () => ({ api: { wiki: vi.fn() } }));
const { api } = await import('../../src/api/client.js');
const wiki = api.wiki as unknown as ReturnType<typeof vi.fn>;

/** Answer as the wiki would: one part per call, joined by the separator. */
const reply = (parts: string[]): { expandtemplates: { wikitext: string } } => ({
  expandtemplates: { wikitext: parts.join(`\n${SEPARATOR}\n`) },
});

describe('expandTemplates', () => {
  beforeEach(() => {
    wiki.mockReset();
  });

  it('keeps an answer that is the same in both contexts', async () => {
    wiki.mockResolvedValue(reply(["''[[Animal Well]]''"]));
    const result = await expandTemplates('animalwell.wiki.gg', ['AW']);
    expect(result.expanded).toEqual({ AW: "''[[Animal Well]]''" });
    expect(result.warnings).toEqual([]);
    // Twice: the second call is the probe.
    expect(wiki).toHaveBeenCalledTimes(2);
    expect(wiki.mock.calls[0]![1].action).toBe('expandtemplates');
    expect(wiki.mock.calls[0]![1].title).not.toBe(wiki.mock.calls[1]![1].title);
  });

  it('drops an answer that depends on which page asked', async () => {
    // A template's *definition* can consult {{PAGENAME}} without the call site
    // showing it, and these answers are shared across a whole game — so one
    // context's answer would be substituted onto every page.
    wiki
      .mockResolvedValueOnce(reply(["''[[Animal Well]]''", 'Probe A']))
      .mockResolvedValueOnce(reply(["''[[Animal Well]]''", 'Probe B']));
    const result = await expandTemplates('animalwell.wiki.gg', ['AW', 'Pagey']);
    expect(Object.keys(result.expanded)).toEqual(['AW']);
  });

  it('drops a batch whose reply does not line up, rather than pairing it wrong', async () => {
    wiki.mockResolvedValue(reply(['only one part']));
    const result = await expandTemplates('a.wiki.gg', ['One', 'Two']);
    expect(result.expanded).toEqual({});
    expect(result.warnings[0]).toMatch(/did not line up/);
  });

  it('ignores a template that expanded to itself', async () => {
    // What MediaWiki returns for a template that does not exist.
    wiki.mockResolvedValue(reply(['{{Nope}}']));
    expect((await expandTemplates('a.wiki.gg', ['Nope'])).expanded).toEqual({});
  });

  it('leaves the parser where it was when the wiki will not answer', async () => {
    wiki.mockRejectedValue(new Error('502'));
    const result = await expandTemplates('a.wiki.gg', ['AW']);
    expect(result.expanded).toEqual({});
    expect(result.warnings[0]).toMatch(/could not expand/);
  });

  it('asks nothing when there is nothing to ask', async () => {
    expect(await expandTemplates('a.wiki.gg', [])).toEqual({ expanded: {}, warnings: [] });
    expect(wiki).not.toHaveBeenCalled();
  });
});
