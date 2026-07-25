/**
 * Regenerate the synthetic fixture suite.
 *
 *   npm run fixtures --workspace web
 *
 * Writes `<name>.uhs` and `<name>.expected.json` into test/fixtures/synthetic/.
 * The `.uhs` files are ours (see tools/fixtures/definitions.ts) and are safe to
 * commit; the expected JSON is the portability contract the Swift parser will
 * be held to.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseUhs } from '../src/parser/uhs/index.js';
import { serializeDocument } from '../src/parser/serialize.js';
import { FIXTURES } from './fixtures/definitions.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test', 'fixtures', 'synthetic');

/** Frozen so regenerating fixtures never produces a spurious diff. */
const FETCHED_AT = '2026-01-01T00:00:00.000Z';

mkdirSync(outDir, { recursive: true });

for (const fixture of FIXTURES) {
  const bytes = fixture.build();
  writeFileSync(join(outDir, `${fixture.name}.uhs`), bytes);

  const result = parseUhs(bytes, {
    url: `fixture://${fixture.name}.uhs`,
    fetchedAt: FETCHED_AT,
  });
  const expected = {
    document: serializeDocument(result.document),
    warnings: result.warnings,
  };
  writeFileSync(
    join(outDir, `${fixture.name}.expected.json`),
    `${JSON.stringify(expected, null, 2)}\n`,
  );

  console.log(
    `${fixture.name}: ${bytes.length} bytes, ${result.warnings.length} warning(s)`,
  );
}
