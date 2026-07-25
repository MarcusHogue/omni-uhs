#!/usr/bin/env tsx
/**
 * CLI harness (milestone 1): dump the AST of a .uhs file as JSON.
 *
 *   npm run dump --workspace web -- path/to/file.uhs [--incentive] [--88a] [--tree]
 *
 * `--tree` prints a human-readable outline instead of JSON, which is the
 * quickest way to eyeball a real file without spoiling anything: hint bodies
 * are never printed, only labels and counts.
 */

import { readFileSync } from 'node:fs';

import type { Node } from '../src/parser/ast.js';
import { serializeDocument } from '../src/parser/serialize.js';
import { parseUhs } from '../src/parser/uhs/index.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: dump-ast <file.uhs> [--incentive] [--88a] [--tree]');
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(file));
const result = parseUhs(bytes, {
  url: `file://${file}`,
  decodeIncentive: args.includes('--incentive'),
  prefer88a: args.includes('--88a'),
});

if (args.includes('--tree')) {
  const counts = new Map<string, number>();
  const outline = (node: Node, depth: number): void => {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    const indent = '  '.repeat(depth);
    if (node.type === 'subject') {
      console.log(`${indent}+ ${node.label}`);
      node.children.forEach((child) => outline(child, depth + 1));
    } else if (node.type === 'hints') {
      console.log(`${indent}? ${node.label}  [${node.hints.length} hint(s)]`);
      node.hints.forEach((hint) =>
        hint.nested?.forEach((nested) => outline(nested, depth + 1)),
      );
    } else if (node.type === 'text') {
      console.log(`${indent}= ${node.label}`);
    } else if (node.type === 'image') {
      console.log(
        `${indent}[img] ${node.label}  (${node.data.length} bytes, ${node.hotspots?.length ?? 0} hotspot(s))`,
      );
    } else {
      console.log(`${indent}-> ${node.label}`);
    }
  };
  console.log(`${result.document.game.title}\n`);
  outline(result.document.root, 0);
  console.log(`\ncounts: ${[...counts].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (result.warnings.length > 0) {
    console.log(`\nwarnings (${result.warnings.length}):`);
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }
} else {
  console.log(
    JSON.stringify(
      { document: serializeDocument(result.document), warnings: result.warnings },
      null,
      2,
    ),
  );
}
