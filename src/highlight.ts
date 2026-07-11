import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { CSSProperties } from 'react';
import type { LanguageRegistration, ThemeRegistration } from '@shikijs/types';

export interface SyntaxToken {
  content: string;
  style?: CSSProperties;
}

const redlineTheme: ThemeRegistration = {
  name: 'redline-night',
  type: 'dark',
  fg: 'var(--syntax-text)',
  bg: 'transparent',
  settings: [
    {
      settings: {
        foreground: 'var(--syntax-text)',
        background: 'transparent'
      }
    },
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: 'var(--syntax-comment)', fontStyle: 'italic' }
    },
    {
      scope: ['keyword', 'storage', 'storage.type.function'],
      settings: { foreground: 'var(--syntax-keyword)' }
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'entity.name.namespace',
        'support.type',
        'support.class'
      ],
      settings: { foreground: 'var(--syntax-type)' }
    },
    {
      scope: [
        'entity.name.function',
        'meta.function-call',
        'support.function',
        'variable.function'
      ],
      settings: { foreground: 'var(--syntax-function)' }
    },
    {
      scope: ['string', 'string.quoted', 'string.template'],
      settings: { foreground: 'var(--syntax-string)' }
    },
    {
      scope: ['constant.numeric'],
      settings: { foreground: 'var(--syntax-number)' }
    },
    {
      scope: ['constant.language', 'constant.character', 'constant.other', 'variable.language'],
      settings: { foreground: 'var(--syntax-constant)' }
    },
    {
      scope: [
        'variable.other.property',
        'support.variable.property',
        'meta.object-literal.key',
        'entity.other.attribute-name'
      ],
      settings: { foreground: 'var(--syntax-property)' }
    },
    {
      scope: ['entity.name.tag', 'support.class.component'],
      settings: { foreground: 'var(--syntax-tag)' }
    },
    {
      scope: ['keyword.operator', 'punctuation.separator', 'punctuation.terminator'],
      settings: { foreground: 'var(--syntax-operator)' }
    },
    {
      scope: ['invalid', 'invalid.illegal'],
      settings: { foreground: 'var(--syntax-invalid)' }
    }
  ]
};

interface LanguageModule {
  default: LanguageRegistration[];
}

const languageLoaders = {
  css: () => import('@shikijs/langs/css'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  markdown: () => import('@shikijs/langs/markdown'),
  python: () => import('@shikijs/langs/python'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  shell: () => import('@shikijs/langs/shell'),
  sql: () => import('@shikijs/langs/sql'),
  typescript: () => import('@shikijs/langs/typescript'),
  vue: () => import('@shikijs/langs/vue'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml')
} satisfies Record<string, () => Promise<LanguageModule>>;

const highlighterPromise = createHighlighterCore({
  themes: [redlineTheme],
  langs: [],
  engine: createJavaScriptRegexEngine()
});
const languageLoads = new Map<string, Promise<void>>();

function plainLines(lines: string[]): SyntaxToken[][] {
  return lines.map((line) => line ? [{ content: line }] : []);
}

function tokenStyle(token: {
  color?: string;
  fontStyle?: number;
  htmlStyle?: Record<string, string>;
}): CSSProperties | undefined {
  if (token.htmlStyle) return token.htmlStyle;

  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  if (token.fontStyle && (token.fontStyle & 1) !== 0) style.fontStyle = 'italic';
  if (token.fontStyle && (token.fontStyle & 2) !== 0) style.fontWeight = 700;
  if (token.fontStyle && (token.fontStyle & 4) !== 0) style.textDecoration = 'underline';
  return Object.keys(style).length > 0 ? style : undefined;
}

export async function highlightLines(lines: string[], language: string): Promise<SyntaxToken[][]> {
  const loader = Object.hasOwn(languageLoaders, language)
    ? languageLoaders[language as keyof typeof languageLoaders]
    : undefined;
  if (lines.length === 0 || language === 'text' || !loader) {
    return plainLines(lines);
  }

  const highlighter = await highlighterPromise;
  if (!languageLoads.has(language)) {
    const load = loader().then((module) => highlighter.loadLanguage(module.default));
    languageLoads.set(language, load);
  }
  await languageLoads.get(language);

  const result = highlighter.codeToTokens(lines.join('\n'), {
    lang: language,
    theme: redlineTheme,
    tokenizeMaxLineLength: 20_000,
    tokenizeTimeLimit: 100
  });

  return lines.map((line, index) => {
    const tokens = result.tokens[index];
    if (!tokens || (tokens.length === 0 && line)) return [{ content: line }];
    return tokens.map((token) => ({
      content: token.content,
      style: tokenStyle(token)
    }));
  });
}
