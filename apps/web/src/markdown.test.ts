import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './components/Markdown.tsx';

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('markdown of plans, PR descriptions and wiki pages', () => {
  it('shows headings, tables, lists and code of a plan as they read', () => {
    const out = html('# План\n\n| Условие | scope |\n|---|---|\n| все отказали | `all_providers` |\n\n1. Счетчик\n2. Тест\n\n```java\nint x = 1;\n```');
    expect(out).toContain('<h1>План</h1>');
    expect(out).toContain('<table>');
    expect(out).toContain('<code>all_providers</code>');
    expect(out).toContain('<ol>');
    expect(out).toContain('int x = 1;');
  });

  it('drops raw HTML and images an agent may write and opens links in a new tab without scripts', () => {
    const out = html('<script>alert(1)</script> <b>жирный</b>\n\n![схема](https://tracker.example/p.png)\n\n[PR](https://git.example/pr/22) и [ссылка](javascript:alert(1))');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('<img');
    expect(out).toContain('href="https://git.example/pr/22" target="_blank" rel="noreferrer"');
    expect(out).not.toContain('javascript:');
  });
});
