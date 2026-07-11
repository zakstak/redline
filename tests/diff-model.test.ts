import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/diff-model.js';

describe('diff presentation model', () => {
  it('pairs removed and added lines for side-by-side word changes', () => {
    const parsed = parseDiff([
      '@@ -1,2 +1,2 @@',
      '-const status = "waiting";',
      '+const status = "approved";',
      ' keep();'
    ].join('\n'));

    const changedRow = parsed.rows.find((row) => row.oldLine?.type === 'remove');
    expect(changedRow?.oldLine?.segments?.some((segment) => segment.changed && segment.text.includes('waiting'))).toBe(true);
    expect(changedRow?.newLine?.segments?.some((segment) => segment.changed && segment.text.includes('approved'))).toBe(true);
  });

  it('marks exact removed and added content as moved code', () => {
    const parsed = parseDiff([
      '@@ -1,3 +1,3 @@',
      '-renderApprovedSnapshot();',
      ' keep();',
      '+renderApprovedSnapshot();'
    ].join('\n'));

    const movedLines = parsed.lines.filter((line) => line.moved);
    expect(movedLines).toHaveLength(2);
  });

  it('does not invent an unchanged line for a trailing diff newline', () => {
    const parsed = parseDiff('@@ -1 +1 @@\n-before\n+after\n');

    expect(parsed.lines.map((line) => line.type)).toEqual(['hunk', 'remove', 'add']);
  });

  it('attaches no-newline markers without advancing line numbers', () => {
    const parsed = parseDiff([
      '@@ -1 +1 @@',
      '-before',
      '\\ No newline at end of file',
      '+after',
      '\\ No newline at end of file'
    ].join('\n'));

    expect(parsed.lines).toMatchObject([
      { type: 'hunk' },
      { id: 'old-1', type: 'remove', oldNumber: 1, noNewline: true },
      { id: 'new-1', type: 'add', newNumber: 1, noNewline: true }
    ]);
  });

  it('keeps mode-only diffs as non-commentable metadata', () => {
    const parsed = parseDiff([
      'diff --git a/tool.sh b/tool.sh',
      'old mode 100644',
      'new mode 100755'
    ].join('\n'));

    expect(parsed.lines).toMatchObject([
      { type: 'meta', text: 'old mode 100644', oldNumber: null, newNumber: null },
      { type: 'meta', text: 'new mode 100755', oldNumber: null, newNumber: null }
    ]);
    expect(parsed.lines.some((line) => line.type === 'context')).toBe(false);
  });

  it('keeps source lines that resemble file headers and preserves following anchors', () => {
    const parsed = parseDiff([
      '@@ -1,2 +1,2 @@',
      '--- old directive',
      '+++ new directive',
      ' tail()'
    ].join('\n'));

    expect(parsed.lines).toMatchObject([
      { type: 'hunk' },
      { id: 'old-1', type: 'remove', text: '-- old directive', oldNumber: 1 },
      { id: 'new-1', type: 'add', text: '++ new directive', newNumber: 1 },
      { id: 'both-2-2', type: 'context', text: 'tail()', oldNumber: 2, newNumber: 2 }
    ]);
  });
});
