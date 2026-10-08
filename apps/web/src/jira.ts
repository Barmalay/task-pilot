/**
 * Разбор wiki-разметки Jira Server для показа текста до публикации: блоки (заголовки, абзацы, списки, таблицы, код,
 * цитаты, панели, линии) и строчная разметка внутри них. Разбирается то, что пишут шаги и агенты по
 * справочнику разметки Jira в скилле теста на стенде, и частые конструкции Jira; незнакомое остается текстом.
 */

export type JiraMark = 'strong' | 'em' | 'del' | 'ins' | 'sup' | 'sub' | 'cite';

/** Строчный узел: текст, перенос, выделение, моноширинный код, ссылка, вложение, картинка, цвет, упоминание. */
export type JiraInline =
  | { kind: 'text'; text: string }
  | { kind: 'break' }
  | { kind: 'mark'; mark: JiraMark; children: JiraInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: JiraInline[] }
  | { kind: 'attachment'; name: string }
  | { kind: 'image'; source: string; thumbnail: boolean }
  | { kind: 'color'; color: string; children: JiraInline[] }
  | { kind: 'mention'; user: string };

export interface JiraList {
  kind: 'list';
  ordered: boolean;
  items: { content: JiraInline[]; lists: JiraList[] }[];
}

export interface JiraCell {
  header: boolean;
  content: JiraInline[];
}

export type JiraBlock =
  | { kind: 'heading'; level: number; content: JiraInline[] }
  | { kind: 'paragraph'; content: JiraInline[] }
  | JiraList
  | { kind: 'table'; rows: JiraCell[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; blocks: JiraBlock[] }
  | { kind: 'panel'; title: string | null; blocks: JiraBlock[] }
  | { kind: 'rule' };

const HEADING = /^h([1-6])\.\s+(.*)$/;
const LIST_ITEM = /^([*#]+|-)\s+(.*)$/;
const RULE = /^-{4,}$/;
const QUOTE_LINE = /^bq\.\s+(.*)$/;
const CODE_OPEN = /^\{(code|noformat)(?::[^}]*)?\}/;
const BLOCK_OPEN = /^\{(quote|panel)(?::([^}]*))?\}/;
const IMAGE = /^!([^\s!|][^!|\n]*?)(?:\|([^!\n]*))?!/;
/** Картинка - адрес в сети или имя файла вложения с расширением картинки, иначе восклицательные знаки - просто текст. */
const IMAGE_SOURCE = /^(?:https?:\/\/\S+|[^/\\]+\.(?:png|jpe?g|gif|webp|bmp|svg))$/i;
const URL_AT = /^(?:https?:\/\/|mailto:)[^\s|[\]<>"]+/i;
const WORD = /[\p{L}\p{N}]/u;
const MARKS: Record<string, JiraMark> = { '*': 'strong', _: 'em', '-': 'del', '+': 'ins', '^': 'sup', '~': 'sub' };
const EMOTICONS: [string, string][] = [
  ['(/)', '✅'],
  ['(x)', '❌'],
  ['(!)', '⚠️'],
  ['(i)', 'ℹ️'],
  ['(?)', '❓'],
  ['(y)', '👍'],
  ['(n)', '👎'],
  ['(on)', '💡'],
  ['(off)', '💡'],
  ['(*)', '⭐'],
  ['(+)', '➕'],
  ['(-)', '➖'],
];

/** Текст в разметке Jira блоками. */
export function parseJira(text: string): JiraBlock[] {
  return blocksOf(text.replace(/\r\n?/g, '\n').split('\n'));
}

/**
 * Тело блочного макроса ({code}, {noformat}, {quote}, {panel}) от открывающего тега в строке start до закрывающего:
 * строки тела и номер строки, где макрос закончился. Незакрытый макрос идет до конца текста.
 */
function macroBody(lines: string[], start: number, open: string, close: string): { body: string[]; end: number } {
  const body: string[] = [];
  let rest = lines[start]!.trimStart().slice(open.length);
  for (let i = start; ; ) {
    const at = rest.indexOf(close);
    if (at >= 0) {
      body.push(rest.slice(0, at));
      return { body, end: i };
    }
    body.push(rest);
    if (++i >= lines.length) return { body, end: i - 1 };
    rest = lines[i]!;
  }
}

function panelTitle(params: string | undefined): string | null {
  const title = params
    ?.split('|')
    .map((p) => /^\s*title\s*=(.*)$/.exec(p)?.[1]?.trim())
    .find(Boolean);
  return title ?? null;
}

function blocksOf(lines: string[]): JiraBlock[] {
  const out: JiraBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    out.push({ kind: 'paragraph', content: lineInlines(paragraph) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) {
      flush();
      continue;
    }
    const code = CODE_OPEN.exec(line);
    const macro = code ? null : BLOCK_OPEN.exec(line);
    if (code || macro) {
      flush();
      const name = (code ?? macro)![1]!;
      const { body, end } = macroBody(lines, i, (code ?? macro)![0], `{${name}}`);
      if (code) out.push({ kind: 'code', text: body.join('\n').replace(/^\n+|\n\s*$/g, '') });
      else if (name === 'quote') out.push({ kind: 'quote', blocks: blocksOf(body) });
      else out.push({ kind: 'panel', title: panelTitle(macro![2]), blocks: blocksOf(body) });
      i = end;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      out.push({ kind: 'heading', level: Number(heading[1]), content: inlines(heading[2]!) });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push({ kind: 'rule' });
      continue;
    }
    const quote = QUOTE_LINE.exec(line);
    if (quote) {
      flush();
      out.push({ kind: 'quote', blocks: [{ kind: 'paragraph', content: inlines(quote[1]!) }] });
      continue;
    }
    if (line.startsWith('|')) {
      flush();
      const rows: JiraCell[][] = [];
      for (; i < lines.length && lines[i]!.trim().startsWith('|'); i++) rows.push(rowOf(lines[i]!.trim()));
      i--;
      out.push({ kind: 'table', rows });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      const entries: { marker: string; text: string }[] = [];
      for (; i < lines.length; i++) {
        const m = LIST_ITEM.exec(lines[i]!.trim());
        if (!m) break;
        entries.push({ marker: m[1] === '-' ? '*' : m[1]!, text: m[2]! });
      }
      i--;
      out.push(...listsOf(entries));
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out;
}

/**
 * Вложенные списки по маркерам строк: глубина - длина маркера, вид списка на каждой глубине - знак маркера на этом
 * месте (# - нумерованный). Смена вида на той же глубине начинает рядом новый список.
 */
function listsOf(entries: { marker: string; text: string }[]): JiraList[] {
  const roots: JiraList[] = [];
  const stack: JiraList[] = [];
  const attach = (list: JiraList, depth: number) => {
    if (depth === 1) {
      roots.push(list);
      return;
    }
    const parent = stack[depth - 2]!;
    if (!parent.items.length) parent.items.push({ content: [], lists: [] });
    parent.items.at(-1)!.lists.push(list);
  };
  for (const { marker, text } of entries) {
    const depth = marker.length;
    stack.length = Math.min(stack.length, depth);
    while (stack.length < depth) {
      const list: JiraList = { kind: 'list', ordered: marker[stack.length] === '#', items: [] };
      attach(list, stack.length + 1);
      stack.push(list);
    }
    const ordered = marker.endsWith('#');
    if (stack[depth - 1]!.ordered !== ordered) {
      const list: JiraList = { kind: 'list', ordered, items: [] };
      attach(list, depth);
      stack[depth - 1] = list;
    }
    stack[depth - 1]!.items.push({ content: inlines(text), lists: [] });
  }
  return roots;
}

/** Картинка с начала строки: источник, миниатюра ли она и длина разметки; null - это не картинка. */
function imageAt(s: string): { source: string; thumbnail: boolean; length: number } | null {
  const m = IMAGE.exec(s);
  const source = m?.[1]?.trim();
  if (!m || !source || !IMAGE_SOURCE.test(source)) return null;
  const params = (m[2] ?? '').split(',').map((p) => p.trim().toLowerCase());
  return { source, thumbnail: params.includes('thumbnail'), length: m[0].length };
}

/** Конец ячейки таблицы: следующая черта, которая не внутри ссылки, картинки, моноширинного текста и не экранирована. */
function cellEnd(line: string, from: number): number {
  let i = from;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '|') return i;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    const skip =
      ch === '[' ? line.indexOf(']', i + 1) + 1 : ch === '!' ? i + (imageAt(line.slice(i))?.length ?? 0) : line.startsWith('{{', i) ? line.indexOf('}}', i + 2) + 2 : 0;
    i = skip > i ? skip : i + 1;
  }
  return i;
}

/** Строка таблицы ячейками: || - заголовок, | - обычная ячейка; черта в конце строки ячейку не открывает. */
function rowOf(line: string): JiraCell[] {
  const cells: JiraCell[] = [];
  let i = 0;
  while (i < line.length) {
    const header = line.startsWith('||', i);
    i += header ? 2 : line[i] === '|' ? 1 : 0;
    const start = i;
    i = cellEnd(line, i);
    const text = line.slice(start, i);
    if (i >= line.length && !text.trim()) break;
    cells.push({ header, content: inlines(text.trim()) });
  }
  return cells;
}

/** Строки абзаца: переносы строк Jira показывает как есть. */
function lineInlines(lines: string[]): JiraInline[] {
  return lines.flatMap((line, i) => (i ? [{ kind: 'break' } as JiraInline, ...inlines(line)] : inlines(line)));
}

function unescape(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

/** Ссылка в квадратных скобках: [текст|адрес], [адрес], [^вложение], [~пользователь]; null - это не ссылка. */
function linkOf(content: string): JiraInline | null {
  if (content.startsWith('^')) return content.slice(1).trim() ? { kind: 'attachment', name: content.slice(1).trim() } : null;
  if (content.startsWith('~')) return content.slice(1).trim() ? { kind: 'mention', user: content.slice(1).trim() } : null;
  const bar = content.indexOf('|');
  const target = (bar >= 0 ? content.slice(bar + 1).split('|')[0]! : content).trim();
  if (!/^(https?:\/\/|mailto:)/i.test(target)) return null;
  const alias = bar >= 0 ? content.slice(0, bar).trim() : '';
  return { kind: 'link', href: target, children: alias ? inlines(alias) : [{ kind: 'text', text: target }] };
}

/**
 * Выделение, которое начинается в позиции i: знак стоит в начале слова и за ним не пробел, закрывающий такой же знак
 * стоит в конце слова. ??цитата?? - по парным вопросительным знакам.
 */
function markAt(s: string, i: number): { mark: JiraMark; inner: string; end: number } | null {
  if (s.startsWith('??', i)) {
    const close = s.indexOf('??', i + 2);
    return close > i + 2 ? { mark: 'cite', inner: s.slice(i + 2, close), end: close + 2 } : null;
  }
  const ch = s[i]!;
  const mark = MARKS[ch];
  if (!mark || (i > 0 && WORD.test(s[i - 1]!))) return null;
  const next = s[i + 1];
  if (next === undefined || /\s/.test(next) || next === ch) return null;
  for (let j = i + 2; j < s.length; j++) {
    if (s[j] !== ch || s[j - 1] === '\\' || /\s/.test(s[j - 1]!)) continue;
    if (j + 1 < s.length && WORD.test(s[j + 1]!)) continue;
    return { mark, inner: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

/** Строчная разметка Jira узлами. */
export function inlines(s: string): JiraInline[] {
  const out: JiraInline[] = [];
  let text = '';
  const push = (node: JiraInline) => {
    if (text) out.push({ kind: 'text', text });
    text = '';
    out.push(node);
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    const rest = s.slice(i);
    if (ch === '\\') {
      // \\ - перенос строки, \x - знак x как есть.
      if (s[i + 1] === '\\') push({ kind: 'break' });
      else text += s[i + 1] ?? ch;
      i += 2;
      continue;
    }
    if (rest.startsWith('{{')) {
      const close = s.indexOf('}}', i + 2);
      if (close > i + 2) {
        push({ kind: 'code', text: unescape(s.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    const color = /^\{color:([^}]*)\}/.exec(rest);
    const colorEnd = color ? s.indexOf('{color}', i + color[0].length) : -1;
    if (color && colorEnd >= 0) {
      push({ kind: 'color', color: color[1]!.trim(), children: inlines(s.slice(i + color[0].length, colorEnd)) });
      i = colorEnd + '{color}'.length;
      continue;
    }
    const image = ch === '!' ? imageAt(rest) : null;
    if (image) {
      push({ kind: 'image', source: image.source, thumbnail: image.thumbnail });
      i += image.length;
      continue;
    }
    const close = ch === '[' ? s.indexOf(']', i + 1) : -1;
    const link = close > i + 1 ? linkOf(s.slice(i + 1, close)) : null;
    if (link) {
      push(link);
      i = close + 1;
      continue;
    }
    const url = (ch === 'h' || ch === 'H' || ch === 'm' || ch === 'M') && (i === 0 || !WORD.test(s[i - 1]!)) ? URL_AT.exec(rest)?.[0].replace(/[.,;:!?)]+$/, '') : undefined;
    if (url) {
      push({ kind: 'link', href: url, children: [{ kind: 'text', text: url }] });
      i += url.length;
      continue;
    }
    const mark = markAt(s, i);
    if (mark) {
      push({ kind: 'mark', mark: mark.mark, children: inlines(mark.inner) });
      i = mark.end;
      continue;
    }
    const emoticon = ch === '(' ? EMOTICONS.find(([code]) => rest.startsWith(code)) : undefined;
    if (emoticon) {
      text += emoticon[1];
      i += emoticon[0].length;
      continue;
    }
    text += ch;
    i++;
  }
  if (text) out.push({ kind: 'text', text });
  return out;
}
