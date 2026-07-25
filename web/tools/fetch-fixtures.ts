#!/usr/bin/env tsx
/**
 * Fetch a handful of real .uhs files for local parser validation.
 *
 *   npm run fetch-fixtures --workspace web -- [name ...]
 *
 * Output lands in test/fixtures/real/, which is gitignored: real hint files are
 * copyrighted and must never be committed (spec §10/§11). Nothing in the test
 * suite depends on them — they exist so a human can check the parser against
 * genuine 88a/95a/96a content.
 *
 * Deliberately serial and small: uhs-hints.com has been dormant since ~2015 and
 * deserves to be left alone.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzipSync } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test', 'fixtures', 'real');

const USER_AGENT = 'OmniUHS/1.0 (personal use; parser validation)';
const CATALOG = 'https://www.uhs-hints.com/cgi-bin/update.cgi';

/** A spread of generations, all small. */
const DEFAULT = ['adv660', 'zork1', 'myst'];

interface Entry {
  title: string;
  url: string;
  name: string;
  size: number;
}

function parseCatalog(xml: string): Entry[] {
  const entries: Entry[] = [];
  const fileRe = /<FILE>([\s\S]*?)<\/FILE>/g;
  let match: RegExpExecArray | null;
  while ((match = fileRe.exec(xml)) !== null) {
    const block = match[1]!;
    const field = (tag: string): string =>
      new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1]?.trim() ?? '';
    entries.push({
      title: field('FTITLE'),
      url: field('FURL').replace(/^http:/, 'https:'),
      name: field('FNAME'),
      size: Number.parseInt(field('FSIZE'), 10) || 0,
    });
  }
  return entries;
}

const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT;

mkdirSync(outDir, { recursive: true });

const catalogResponse = await fetch(CATALOG, { headers: { 'user-agent': USER_AGENT } });
if (!catalogResponse.ok) {
  console.error(`catalog fetch failed: ${catalogResponse.status}`);
  process.exit(1);
}
const catalog = parseCatalog(await catalogResponse.text());
console.log(`catalog: ${catalog.length} entries`);

for (const name of wanted) {
  const entry = catalog.find((e) => e.name.toLowerCase() === `${name.toLowerCase()}.uhs`);
  if (!entry) {
    console.error(`  ${name}: not in catalog`);
    continue;
  }
  const response = await fetch(entry.url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) {
    console.error(`  ${name}: ${response.status}`);
    continue;
  }
  const zip = new Uint8Array(await response.arrayBuffer());
  const files = unzipSync(zip);
  for (const [inner, bytes] of Object.entries(files)) {
    if (!inner.toLowerCase().endsWith('.uhs')) continue;
    writeFileSync(join(outDir, inner.toLowerCase()), bytes);
    console.log(`  ${entry.title}: ${inner} (${bytes.length} bytes)`);
  }
}
