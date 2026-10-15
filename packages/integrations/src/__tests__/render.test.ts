import { describe, expect, it } from 'vitest';
import { renderDigest, renderNotification } from '../render.js';
import { item } from './helpers.js';
import type { OutboundNotification } from '../deps.js';

const n = (over: Partial<OutboundNotification> = {}): OutboundNotification => ({
  kind: 'assigned', title: 'Assigned', body: 'Please take a look', item: item('RATES-12', { title: 'Fix curve' }), actorName: 'Alice', createdAt: '2026-10-15T10:00:00Z', ...over,
});

describe('render', () => {
  it('renderNotification is compact and carries the key, subject verb and url in every format', () => {
    const r = renderNotification(n());
    expect(r.subject).toBe('[RATES-12] Alice assigned you: Fix curve');
    expect(r.text).toContain('RATES-12 Fix curve');
    expect(r.text).toContain('http://app.test/items/RATES-12');
    expect(r.text).toContain('Please take a look');
    expect(r.html).toContain('href="http://app.test/items/RATES-12"');
    expect(r.html).not.toContain('<script');
    expect(JSON.stringify(r.slackBlocks)).toContain('<http://app.test/items/RATES-12|RATES-12>');
    expect(JSON.stringify(r.slackBlocks)).toContain('transition:RATES-12:complete');
    expect(renderNotification(n({ kind: 'mention', body: '<b>hi</b>' })).html).toContain('&lt;b&gt;hi&lt;/b&gt;');
  });

  it('renderDigest groups by project then item', () => {
    const r = renderDigest([
      n(),
      n({ kind: 'comment', body: 'second comment', actorName: 'Bob' }),
      n({ item: item('OPS-3', { project_key: 'OPS', title: 'Rotate keys' }), kind: 'due_soon', body: null }),
    ]);
    expect(r.subject).toBe('pm-tool digest: 3 updates across 2 items');
    expect(r.text.indexOf('## RATES')).toBeLessThan(r.text.indexOf('## OPS'));
    expect(r.text).toContain('RATES-12 Fix curve  http://app.test/items/RATES-12');
    expect(r.text).toContain('- Alice assigned you: Please take a look');
    expect(r.text).toContain('- Bob commented: second comment');
    expect(r.text.match(/RATES-12 Fix curve/g)).toHaveLength(1);
    expect(r.html).toContain('<h3');
    expect(r.slackBlocks).toHaveLength(3); // header + one section per project
  });
});
