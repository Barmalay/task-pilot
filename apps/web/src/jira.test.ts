import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JiraMarkup } from './components/JiraMarkup.tsx';
import { inlines, parseJira, type JiraInline } from './jira.ts';

/** Комментарий с итогами QA в том виде, в каком его собирает шаг "Итоги в Jira". */
const COMMENT = [
  'h3. Итоги проверки на стенде testing-5 (23.09.2026)',
  '',
  'Капча показывается при признаках фрода. Сборка с образом 1.0.4-246. Сводный отчет во вложении [^TEAM-9-qa-report.md].',
  '',
  '||AC||Сценарий||Действие||Ожидаемый результат||Итог||Факт||',
  '|1. Капча вместо SMS|сценарий 1|ввод номера|страница капчи|пройден|!01-captcha.png|thumbnail! !kibana-logs-01.png|thumbnail!|',
  '|2|сценарий 2|логи по state|записи code\\_attempt\\_local нет (\\{source=partner\\})|не проверен| |',
  '',
  'h4. Замечания не по задаче',
  '* опечатка на странице входа',
].join('\n');

const html = (text: string, files: string[] = []) =>
  renderToStaticMarkup(createElement(JiraMarkup, { text, fileUrl: (name: string) => (files.includes(name) ? `/api/runs/r1/artifacts/${name}` : null) }));

const plain = (nodes: JiraInline[]): string =>
  nodes.map((n) => (n.kind === 'text' ? n.text : n.kind === 'break' ? '\n' : 'children' in n ? plain(n.children) : n.kind === 'code' ? n.text : '')).join('');

describe('Jira wiki markup of texts before publication', () => {
  it('reads the QA comment as a heading, a paragraph, a table with a header row and thumbnails, and a list', () => {
    const blocks = parseJira(COMMENT);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'table', 'heading', 'list']);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 3 });
    const table = blocks[2]!;
    if (table.kind !== 'table') throw new Error('нет таблицы');
    expect(table.rows.map((r) => r.length)).toEqual([6, 6, 6]);
    expect(table.rows[0]!.every((c) => c.header)).toBe(true);
    expect(table.rows[1]![5]!.content.filter((n) => n.kind === 'image')).toEqual([
      { kind: 'image', source: '01-captcha.png', thumbnail: true },
      { kind: 'image', source: 'kibana-logs-01.png', thumbnail: true },
    ]);
    // Экранированные знаки - просто текст, пустая ячейка из пробела остается ячейкой.
    expect(plain(table.rows[2]![3]!.content)).toBe('записи code_attempt_local нет ({source=partner})');
    expect(table.rows[2]![5]!.content).toEqual([]);
    expect(blocks[1]).toMatchObject({ content: expect.arrayContaining([{ kind: 'attachment', name: 'TEAM-9-qa-report.md' }]) });
  });

  it('shows thumbnails from the files of the run and marks the ones that are not there', () => {
    const out = html(COMMENT, ['01-captcha.png']);
    expect(out).toContain('<h3>Итоги проверки на стенде testing-5 (23.09.2026)</h3>');
    expect(out).toContain('<th>AC</th>');
    expect(out).toContain('<td>1. Капча вместо SMS</td>');
    expect(out).toContain('<img src="/api/runs/r1/artifacts/01-captcha.png" alt="01-captcha.png"');
    expect(out).not.toContain('src="/api/runs/r1/artifacts/kibana-logs-01.png"');
    expect(out).toContain('title="Файла нет среди артефактов прогона"');
    expect(out).toContain('<li>опечатка на странице входа</li>');
  });

  it('marks text up like Jira and leaves hyphens, underscores and pluses inside words alone', () => {
    expect(inlines('*жирный* _курсив_ -зачеркнуто- +подчеркнуто+ {{моно}} ??цитата?? м ^2^ и ~2~')).toEqual([
      { kind: 'mark', mark: 'strong', children: [{ kind: 'text', text: 'жирный' }] },
      { kind: 'text', text: ' ' },
      { kind: 'mark', mark: 'em', children: [{ kind: 'text', text: 'курсив' }] },
      { kind: 'text', text: ' ' },
      { kind: 'mark', mark: 'del', children: [{ kind: 'text', text: 'зачеркнуто' }] },
      { kind: 'text', text: ' ' },
      { kind: 'mark', mark: 'ins', children: [{ kind: 'text', text: 'подчеркнуто' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'моно' },
      { kind: 'text', text: ' ' },
      { kind: 'mark', mark: 'cite', children: [{ kind: 'text', text: 'цитата' }] },
      { kind: 'text', text: ' м ' },
      { kind: 'mark', mark: 'sup', children: [{ kind: 'text', text: '2' }] },
      { kind: 'text', text: ' и ' },
      { kind: 'mark', mark: 'sub', children: [{ kind: 'text', text: '2' }] },
    ]);
    // Как и в Jira, знак выделения внутри слова ничего не выделяет.
    const words = 'TEAM-2586 code_attempt_local 10-20 счетчик +1 a - b 11:03:47-11:04:43 * звездочка x^2^';
    expect(inlines(words)).toEqual([{ kind: 'text', text: words }]);
  });

  it('turns links, attachments, mentions, line breaks and emoticons into their own nodes', () => {
    expect(inlines('[PR|https://git.example/pr/22], https://kibana.example/app. [TEAM-1] [^report.md] [~owner] a\\\\b (/)')).toEqual([
      { kind: 'link', href: 'https://git.example/pr/22', children: [{ kind: 'text', text: 'PR' }] },
      { kind: 'text', text: ', ' },
      { kind: 'link', href: 'https://kibana.example/app', children: [{ kind: 'text', text: 'https://kibana.example/app' }] },
      { kind: 'text', text: '. [TEAM-1] ' },
      { kind: 'attachment', name: 'report.md' },
      { kind: 'text', text: ' ' },
      { kind: 'mention', user: 'owner' },
      { kind: 'text', text: ' a' },
      { kind: 'break' },
      { kind: 'text', text: 'b ✅' },
    ]);
    // Восклицательные знаки в обычной фразе - не картинка.
    expect(inlines('Внимание! Лимит 15, а не 20!')).toEqual([{ kind: 'text', text: 'Внимание! Лимит 15, а не 20!' }]);
  });

  it('keeps a link, an image and escaped bars inside one table cell', () => {
    const [table] = parseJira('|[вики|https://wiki.example/p?a=1]|!shot.png|width=300!|a \\| b|');
    if (table?.kind !== 'table') throw new Error('нет таблицы');
    expect(table.rows[0]!.map((c) => c.content[0]?.kind)).toEqual(['link', 'image', 'text']);
    expect(plain(table.rows[0]![2]!.content)).toBe('a | b');
    expect(table.rows[0]![1]!.content[0]).toEqual({ kind: 'image', source: 'shot.png', thumbnail: false });
  });

  it('nests lists by their markers and starts a new list when the kind changes', () => {
    const blocks = parseJira('* один\n** вложенный\n*# нумерованный внутри\n# второй список');
    expect(blocks.map((b) => (b.kind === 'list' ? b.ordered : b.kind))).toEqual([false, true]);
    const first = blocks[0]!;
    if (first.kind !== 'list') throw new Error('нет списка');
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.lists.map((l) => l.ordered)).toEqual([false, true]);
  });

  it('reads code, quotes, panels, rules and colors', () => {
    const blocks = parseJira('{code:java}\nint x = 1;\n  return x;\n{code}\n{noformat}*как есть*{noformat}\nbq. цитата\n{panel:title=Итоги|borderStyle=dashed}\nвнутри\n{panel}\n----\n{color:red}красный{color}');
    expect(blocks).toEqual([
      { kind: 'code', text: 'int x = 1;\n  return x;' },
      { kind: 'code', text: '*как есть*' },
      { kind: 'quote', blocks: [{ kind: 'paragraph', content: [{ kind: 'text', text: 'цитата' }] }] },
      { kind: 'panel', title: 'Итоги', blocks: [{ kind: 'paragraph', content: [{ kind: 'text', text: 'внутри' }] }] },
      { kind: 'rule' },
      { kind: 'paragraph', content: [{ kind: 'color', color: 'red', children: [{ kind: 'text', text: 'красный' }] }] },
    ]);
  });

  it('draws no raw HTML, loads no images from the network and drops unsafe links and colors', () => {
    const out = html('<script>alert(1)</script>\n!https://tracker.example/p.png!\n[x|javascript:alert(1)]\n{color:red;background:url(x)}текст{color} {color:#c00}красный{color}');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('javascript:alert(1)"');
    expect(out).not.toContain('background');
    expect(out).toContain('<span style="color:#c00">красный</span>');
  });

  it('keeps line breaks of a paragraph as Jira does', () => {
    expect(html('первая строка\nвторая строка')).toContain('<p>первая строка<br/>вторая строка</p>');
  });
});
