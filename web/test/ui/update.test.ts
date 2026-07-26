/**
 * @vitest-environment node
 *
 * Node, not jsdom: the only browser API this touches is `localStorage`, which
 * is a dozen lines below. Pulling in a DOM implementation to get a string map
 * would be a dependency for nothing.
 */

/**
 * Dismissal keys.
 *
 * This is the third pass over this logic and the second bug in it, both of the
 * same shape: a notice waved away once, and a later, different release silently
 * inheriting the dismissal. The rule the tests below enforce is simply that two
 * states a user would want to hear about separately never share a key.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { UpdateState } from '../../src/ui/update.js';

/** Enough of `localStorage` for the persistence path, installed before import. */
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

// Imported after the stub is in place: the module reads `localStorage` lazily,
// but keeping the order explicit is cheaper than relying on that.
const { dismiss, dismissalKey, isDismissed } = await import('../../src/ui/update.js');

const base: UpdateState = {
  waiting: false,
  mismatch: false,
  release: null,
  proxyVersion: null,
  checked: true,
  reason: null,
};

const release = (identity: string, behind: string[] = ['web']): UpdateState => ({
  ...base,
  reason: 'registry-release',
  release: { version: null, images: [], behind, identity, unknown: [] },
});

describe('dismissal keys', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('separates two unlabelled releases of the same image', () => {
    // The bug: an image with no version label had nothing to key on but the
    // word "unknown", so every release after the first was pre-dismissed.
    const first = release('web@97555fba51d1');
    const second = release('web@0c7c0353bf12');
    expect(dismissalKey(first)).not.toBe(dismissalKey(second));

    dismiss(first);
    expect(isDismissed(first)).toBe(true);
    expect(isDismissed(second)).toBe(false);
  });

  it('separates "one image behind" from "both behind" at the same build', () => {
    const web = release('web@aaaa', ['web']);
    const both = release('proxy@bbbb,web@aaaa', ['proxy', 'web']);
    dismiss(web);
    expect(isDismissed(web)).toBe(true);
    expect(isDismissed(both)).toBe(false);
  });

  it('keeps a mismatch dismissal from evicting a release dismissal', () => {
    // One localStorage slot used to hold one key, so dismissing either notice
    // resurrected the other.
    const rel = release('web@aaaa');
    const mismatch: UpdateState = { ...base, reason: 'version-mismatch', proxyVersion: '2c6bbad' };

    dismiss(rel);
    dismiss(mismatch);
    expect(isDismissed(rel)).toBe(true);
    expect(isDismissed(mismatch)).toBe(true);
  });

  it('re-asks about a mismatch with a different proxy build', () => {
    const first: UpdateState = { ...base, reason: 'version-mismatch', proxyVersion: 'aaaaaaa' };
    const second: UpdateState = { ...base, reason: 'version-mismatch', proxyVersion: 'bbbbbbb' };
    dismiss(first);
    expect(isDismissed(second)).toBe(false);
  });

  it('forgets a service-worker dismissal on the next launch', () => {
    // It has no durable identity — the page cannot see the version waiting in
    // the worker — so it is session-scoped rather than keyed on the wrong thing.
    const waiting: UpdateState = { ...base, waiting: true, reason: 'service-worker' };
    dismiss(waiting);
    expect(isDismissed(waiting)).toBe(true);
    expect(localStorage.getItem('omni-uhs:update-dismissed')).toBeNull();
  });

  it('reads a dismissal written by an earlier build', () => {
    // Older versions stored a bare string rather than a list.
    const mismatch: UpdateState = { ...base, reason: 'version-mismatch', proxyVersion: '2c6bbad' };
    localStorage.setItem('omni-uhs:update-dismissed', dismissalKey(mismatch));
    expect(isDismissed(mismatch)).toBe(true);
  });
});
