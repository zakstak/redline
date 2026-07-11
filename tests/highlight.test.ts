import { describe, expect, it } from 'vitest';
import { highlightLines } from '../src/highlight.js';

describe('language-aware highlighting', () => {
  it('uses distinct low-fatigue roles from the TypeScript grammar', async () => {
    const [tokens] = await highlightLines(
      ['const greeting: string = "hello"; // note'],
      'typescript'
    );

    const colorFor = (content: string) => tokens?.find((token) => token.content === content)?.style?.color;
    expect(colorFor('const')).toBe('var(--syntax-keyword)');
    expect(colorFor('string')).toBe('var(--syntax-type)');
    expect(colorFor('"hello"')).toBe('var(--syntax-string)');
    expect(colorFor('// note')).toBe('var(--syntax-comment)');
  });

  it('keeps unsupported file types readable without tokenization', async () => {
    await expect(highlightLines(['plain local content'], 'not-a-language')).resolves.toEqual([
      [{ content: 'plain local content' }]
    ]);
  });
});
