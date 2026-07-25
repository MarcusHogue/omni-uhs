/**
 * The portability contract.
 *
 * Every committed fixture must parse to exactly its `.expected.json`. The Swift
 * parser will be held to the same files, so a diff here is either a real
 * regression or a deliberate format change that must be mirrored in both
 * implementations.
 *
 * Regenerate with: npm run fixtures --workspace web
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { serializeDocument, deserializeDocument } from '../../src/parser/serialize.js';
import { parseUhs } from '../../src/parser/uhs/index.js';
import { FIXTURES } from '../../tools/fixtures/definitions.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'synthetic');
const FETCHED_AT = '2026-01-01T00:00:00.000Z';

describe('synthetic fixture suite', () => {
  const names = FIXTURES.map((f) => f.name);

  it('has a committed .uhs and .expected.json for every fixture', () => {
    const files = readdirSync(dir);
    for (const name of names) {
      expect(files).toContain(`${name}.uhs`);
      expect(files).toContain(`${name}.expected.json`);
    }
  });

  for (const name of names) {
    it(`${name}: committed bytes match the generator`, () => {
      const onDisk = new Uint8Array(readFileSync(join(dir, `${name}.uhs`)));
      const generated = FIXTURES.find((f) => f.name === name)!.build();
      expect([...onDisk]).toEqual([...generated]);
    });

    it(`${name}: parses to the expected AST`, () => {
      const bytes = new Uint8Array(readFileSync(join(dir, `${name}.uhs`)));
      const expected = JSON.parse(readFileSync(join(dir, `${name}.expected.json`), 'utf8'));
      const result = parseUhs(bytes, {
        url: `fixture://${name}.uhs`,
        fetchedAt: FETCHED_AT,
      });
      expect({
        document: serializeDocument(result.document),
        warnings: result.warnings,
      }).toEqual(expected);
    });

    it(`${name}: survives a serialize/deserialize round trip`, () => {
      const bytes = new Uint8Array(readFileSync(join(dir, `${name}.uhs`)));
      const { document } = parseUhs(bytes, {
        url: `fixture://${name}.uhs`,
        fetchedAt: FETCHED_AT,
      });
      const round = deserializeDocument(
        JSON.parse(JSON.stringify(serializeDocument(document))),
      );
      expect(serializeDocument(round)).toEqual(serializeDocument(document));
    });
  }
});
