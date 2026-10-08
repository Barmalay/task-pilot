/** Раздел описания задачи с критериями приемки. */
export interface AcSection {
  title: string;
  items: string[];
}

const AC_TITLE = /(критери[ийя]\s+при[её]мки|acceptance\s+criteria|^ac$)/i;
const MD_HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const WIKI_HEADING = /^h([1-6])\.\s+(.*\S)\s*$/i;
const BOLD_LINE = /^\*\*(.+?)\*\*:?\s*$/;
const ITEM = /^\s*(?:[-*+]{1,3}|\d+[.)])\s+(.*\S)\s*$/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}/;

function clean(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

function isAcTitle(title: string): boolean {
  return AC_TITLE.test(clean(title).replace(/:$/, ''));
}

/** Заголовок строки: уровень и текст, или null. Уровень 0 - заголовок, записанный жирной строкой. */
function heading(line: string): { level: number; title: string } | null {
  const md = MD_HEADING.exec(line);
  if (md?.[1] && md[2]) return { level: md[1].length, title: md[2] };
  const wiki = WIKI_HEADING.exec(line);
  if (wiki?.[1] && wiki[2]) return { level: Number(wiki[1]), title: wiki[2] };
  const bold = BOLD_LINE.exec(line.trim());
  if (bold?.[1]) return { level: 0, title: bold[1] };
  return null;
}

/**
 * Все разделы критериев приемки в описании. Понимает то, как описания приходят из Jira через MCP:
 * экранированные маркеры списка (\*), вложенные пункты (**), нумерованный список Jira, превращенный
 * в строки "# пункт" под заголовком второго уровня и ниже, и таблицы с колонкой AC (и колонкой Тип).
 */
export function findAcceptanceSections(description: string): AcSection[] {
  const lines = description.replace(/\r\n?/g, '\n').replace(/\\([*_\-#|])/g, '$1').split('\n');
  const sections: AcSection[] = [];
  let current: (AcSection & { level: number; acColumn: number; typeColumn: number }) | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    const numbered: RegExpExecArray | null = current && current.level >= 2 ? /^#\s+(.*\S)\s*$/.exec(line) : null;
    const h: { level: number; title: string } | null = numbered ? null : heading(line);
    if (h) {
      current = isAcTitle(h.title) ? { title: clean(h.title), items: [], level: h.level, acColumn: -1, typeColumn: -1 } : null;
      if (current) sections.push(current);
      continue;
    }
    if (!current) {
      if (isAcTitle(line)) {
        current = { title: clean(line).replace(/:$/, ''), items: [], level: 0, acColumn: -1, typeColumn: -1 };
        sections.push(current);
      }
      continue;
    }

    const item = numbered?.[1] ?? ITEM.exec(line)?.[1];
    if (item) {
      current.items.push(clean(item));
      continue;
    }

    const row = TABLE_ROW.exec(line);
    if (row?.[1] !== undefined) {
      if (TABLE_RULE.test(line)) continue;
      const cells = row[1].split('|').map((c) => clean(c));
      if (current.acColumn < 0) {
        current.acColumn = cells.findIndex((c) => /^(ac|критери)/i.test(c));
        current.typeColumn = cells.findIndex((c) => /^тип$/i.test(c));
        if (current.acColumn >= 0) continue;
        current.acColumn = cells.reduce((best, c, i) => (c.length > (cells[best]?.length ?? 0) ? i : best), 0);
      }
      const text = cells[current.acColumn];
      const type = current.typeColumn >= 0 ? cells[current.typeColumn] : '';
      if (text) current.items.push(type ? `${type}: ${text}` : text);
      continue;
    }

    // Обычный текст до пунктов (например, легенда) пропускается, после пунктов закрывает раздел.
    if (current.items.length) current = null;
  }
  return sections.filter((s) => s.items.length > 0);
}

/**
 * Критерии приемки задачи: самый полный из найденных разделов или null, если разделов нет.
 * В задачах бывает несколько разделов (краткий список и подробная таблица для QA), берется подробный.
 */
export function extractAcceptanceCriteria(description: string): string[] | null {
  const sections = findAcceptanceSections(description);
  if (!sections.length) return null;
  return sections.reduce((best, s) => (s.items.length > best.items.length ? s : best)).items;
}

/** Критерии приемки задачи: у задачи с меткой skip_ac их нет (пустой список), иначе они берутся из описания. */
export function acceptanceCriteriaOf(issue: { labels: string[]; description: string }): string[] | null {
  return issue.labels.includes('skip_ac') ? [] : extractAcceptanceCriteria(issue.description);
}
