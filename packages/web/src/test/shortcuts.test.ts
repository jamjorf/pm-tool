import { describe, it, expect } from 'vitest';
import { SHORTCUTS, keyFromEvent, resolveShortcut, formatKeys, isTypingTarget } from '../lib/shortcuts';

describe('keyboard shortcut map', () => {
  it('covers every shortcut in ARCHITECTURE.md with unique sequences', () => {
    const keys = SHORTCUTS.map((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ['j', 'k', 'Enter', 'Escape', 'c', 'e', 'a', 'p', 's', 'l', '/', 'g i', 'g p', 'g n', '?', 'mod+k', 'x', 'mod+a']) expect(keys).toContain(k);
  });

  it('normalizes events and resolves single keys, chords and sequences', () => {
    expect(keyFromEvent({ key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe('mod+k');
    expect(keyFromEvent({ key: 'K', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true })).toBe('mod+k');
    expect(keyFromEvent({ key: '?', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBe('?');
    expect(resolveShortcut(['mod+k'])).toMatchObject({ match: { id: 'palette' } });
    expect(resolveShortcut(['g'])).toEqual({ prefix: true });
    expect(resolveShortcut(['g', 'i'])).toMatchObject({ match: { id: 'go_inbox' } });
    expect(resolveShortcut(['g', 'z'])).toEqual({ none: true });
    expect(resolveShortcut(['x'])).toMatchObject({ match: { id: 'select' } });
  });

  it('formats keys per platform and detects typing targets', () => {
    expect(formatKeys('mod+k', true)).toEqual(['⌘K']);
    expect(formatKeys('mod+k', false)).toEqual(['Ctrl+K']);
    expect(formatKeys('g i', false)).toEqual(['G', 'I']);
    const input = document.createElement('input');
    const div = document.createElement('div');
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(div)).toBe(false);
  });
});
