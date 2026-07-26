/**
 * Asking a wiki what its own templates say.
 *
 * Some words are not in the page. `animalwell.wiki.gg` writes the game's name as
 * `{{AW}}`, so "a secret collectible animal in {{AW}}." came through as "…animal
 * in ." — a sentence with a hole where the subject should be. Tunic does the
 * same with `{{Gamename}}`; Obra Dinn writes chapter references as
 * `{{short|3-3}}`. No amount of care with the raw wikitext recovers any of it,
 * because the text lives in the template's definition on the wiki.
 *
 * `action=expandtemplates` answers exactly that, and is already one of the
 * actions the proxy will proxy. This asks only about the calls the parser was
 * going to drop, batched, so a game costs a handful of requests rather than one
 * per template — and the proxy caches them like any other wiki read.
 */

import { api } from '../api/client';

/**
 * Separates the calls inside one batched request.
 *
 * Long and unlikely on purpose: it has to survive being handed to MediaWiki and
 * come back intact, and it must not appear inside anything a template expands
 * to. A mismatch is detected rather than guessed at — see below.
 */
const SEPARATOR = '\n{{{OMNI-UHS-SPLIT}}}\n';

/**
 * How much call text goes in one request.
 *
 * The proxy forwards this as a GET, so the whole batch rides in the query
 * string. Well under any server's URL limit, and large enough that a page's
 * worth of distinct templates is usually one request.
 */
const BATCH_CHARS = 1200;

interface ExpandResponse {
  expandtemplates?: { wikitext?: string };
}

/** Group calls into requests small enough to send as a query string. */
function batches(calls: string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const call of calls) {
    if (current.length > 0 && size + call.length > BATCH_CHARS) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(call);
    size += call.length + SEPARATOR.length;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export interface ExpandResult {
  /** Call inner text -> what the wiki says it expands to. */
  expanded: Record<string, string>;
  warnings: string[];
}

/**
 * Expand a set of template calls against one wiki.
 *
 * Never throws. A wiki that will not answer leaves the parser exactly where it
 * was before this existed — words missing, but everything else intact — and that
 * is a much better outcome than failing a download over a nicety.
 */
export async function expandTemplates(
  host: string,
  calls: string[],
  signal?: AbortSignal,
): Promise<ExpandResult> {
  const expanded: Record<string, string> = {};
  const warnings: string[] = [];
  if (calls.length === 0) return { expanded, warnings };

  for (const batch of batches(calls)) {
    try {
      const response = await api.wiki<ExpandResponse>(
        host,
        {
          action: 'expandtemplates',
          prop: 'wikitext',
          text: batch.map((call) => `{{${call}}}`).join(SEPARATOR),
        },
        signal,
      );
      const wikitext = response.expandtemplates?.wikitext;
      if (wikitext === undefined) continue;

      const parts = wikitext.split(SEPARATOR.trim());
      // If the separator did not survive intact, the parts no longer line up
      // with the calls and pairing them would attach one template's text to
      // another's name. Dropping the batch loses words; guessing invents them.
      if (parts.length !== batch.length) {
        warnings.push(
          `could not expand ${batch.length} template${batch.length === 1 ? '' : 's'}: the wiki's reply did not line up`,
        );
        continue;
      }
      batch.forEach((call, i) => {
        const value = parts[i]!.trim();
        if (value && value !== `{{${call}}}`) expanded[call] = value;
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      warnings.push(`could not expand templates on ${host}: ${(error as Error).message}`);
    }
  }

  return { expanded, warnings };
}
