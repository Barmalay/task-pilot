/**
 * Линтер текстов, которые инструмент публикует от имени владельца: коммиты, PR, комментарии Jira. Оформление по
 * личному стилю (е с точками, длинное тире, типографские кавычки) и русское написание Keycloak исправляются сами,
 * запрещенное содержимое блокирует публикацию.
 */

/** fixed - исправлено автоматически, warn - стоит поправить, block - публиковать нельзя. */
export type LintSeverity = 'fixed' | 'warn' | 'block';

/** Замечание линтера. */
export interface LintIssue {
  rule: string;
  severity: LintSeverity;
  message: string;
  /** Фрагмент текста; секреты в нем замаскированы. */
  sample?: string;
}

/** Текст после исправлений и замечания. */
export interface LintResult {
  text: string;
  issues: LintIssue[];
}

/** Личный стиль публикуемых текстов: какие правки оформления линтер делает сам. */
export interface TextStyle {
  /** Обычная е вместо е с точками. */
  yo: boolean;
  /** Дефис вместо длинного тире. */
  dash: boolean;
  /** Прямые кавычки вместо типографских. */
  quotes: boolean;
}

/** Без личного стиля: оформление текста линтер не меняет. */
export const NO_STYLE: TextStyle = { yo: false, dash: false, quotes: false };

/** Что еще считать запрещенным (точные значения токенов и имена сотрудников) и какой стиль у того, от чьего имени текст. */
export interface LintOptions {
  secrets?: string[];
  /** Имена и фамилии; совпадение ищется по началу слова, чтобы ловить падежи. */
  names?: string[];
  /** Адреса почты, которые можно упоминать. */
  allowEmails?: string[];
  /** Личный стиль: без него е с точками, тире и кавычки остаются как есть. */
  style?: Partial<TextStyle>;
}

interface FixRule {
  rule: string;
  /** Правка личного стиля: делается, только если она включена в стиле. */
  style?: keyof TextStyle;
  pattern: RegExp;
  replace: string;
  message: string;
}

const FIXES: FixRule[] = [
  { rule: 'yo', style: 'yo', pattern: /ё/g, replace: 'е', message: 'буква е с точками заменена на е' },
  { rule: 'yo', style: 'yo', pattern: /Ё/g, replace: 'Е', message: 'заглавная Е с точками заменена на Е' },
  { rule: 'dash', style: 'dash', pattern: /[\u2014\u2013\u2015]/g, replace: '-', message: 'длинное тире заменено дефисом' },
  { rule: 'quotes', style: 'quotes', pattern: /[«»„“”‹›]/g, replace: '"', message: 'типографские кавычки заменены прямыми' },
  // Только парные одинарные кавычки: одиночный знак ’ бывает апострофом.
  { rule: 'quotes', style: 'quotes', pattern: /‘([^‘’\n]*)’/g, replace: '"$1"', message: 'одинарные типографские кавычки заменены прямыми' },
  // Имя продукта пишется латиницей: русское написание в любом падеже (Киклок, Кейклоке) становится Keycloak.
  { rule: 'keycloak', pattern: /(?<!\p{L})[Кк](?:ей|и)клоа?к\p{L}*/gu, replace: 'Keycloak', message: 'Keycloak по-русски заменен на латиницу' },
];
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
/** Мобильные номера РФ в любом привычном написании: +7 916 123-45-67, 8(916)1234567, 79161234567. */
const PHONE = /(?<![\d+])(?:\+7|8|7)[\s(-]{0,2}9\d{2}[\s)-]{0,2}\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g;
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;

/** Куски текста: код в обратных кавычках и блоки ``` не исправляются, проза исправляется. */
function segments(text: string): { code: boolean; value: string }[] {
  const out: { code: boolean; value: string }[] = [];
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ code: false, value: text.slice(last, m.index) });
    out.push({ code: true, value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, value: text.slice(last) });
  return out;
}

function mask(value: string): string {
  return value.length <= 8 ? '***' : `${value.slice(0, 4)}***${value.slice(-2)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Проверяет и исправляет текст. Повторный прогон по исправленному тексту ничего не меняет. */
export function lintText(text: string, options: LintOptions = {}): LintResult {
  const issues: LintIssue[] = [];
  const counts = new Map<string, number>();
  const parts = segments(text).map((s) => {
    if (s.code) return s.value;
    let value = s.value;
    for (const f of FIXES) {
      if (f.style && !options.style?.[f.style]) continue;
      const found = value.match(f.pattern)?.length ?? 0;
      if (found) {
        counts.set(f.message, (counts.get(f.message) ?? 0) + found);
        value = value.replace(f.pattern, f.replace);
      }
    }
    return value;
  });
  for (const [message, n] of counts) {
    const rule = FIXES.find((f) => f.message === message)!.rule;
    issues.push({ rule, severity: 'fixed', message: n > 1 ? `${message} (${n})` : message });
  }
  const fixed = parts.join('');

  const block = (rule: string, message: string, sample: string) => issues.push({ rule, severity: 'block', message, sample });
  for (const secret of options.secrets ?? []) {
    if (secret.length >= 8 && fixed.includes(secret)) block('secret', 'в тексте значение токена', mask(secret));
  }
  for (const [pattern, what] of [
    [JWT, 'в тексте JWT'],
    [BEARER, 'в тексте токен авторизации'],
    [PRIVATE_KEY, 'в тексте приватный ключ'],
  ] as const) {
    for (const m of fixed.matchAll(pattern)) block('secret', what, mask(m[0]));
  }
  for (const m of fixed.matchAll(PHONE)) block('phone', 'в тексте номер телефона', m[0]);
  const allowed = new Set((options.allowEmails ?? []).map((e) => e.toLowerCase()));
  for (const m of fixed.matchAll(EMAIL)) {
    if (!allowed.has(m[0].toLowerCase())) block('email', 'в тексте адрес почты', m[0]);
  }
  for (const name of options.names ?? []) {
    const trimmed = name.trim();
    if (trimmed.length < 3) continue;
    const re = new RegExp(`(?<![\\p{L}])${escapeRegExp(trimmed)}\\p{L}{0,3}(?![\\p{L}])`, 'giu');
    const m = fixed.match(re);
    if (m) block('name', 'в тексте имя сотрудника: в публичных текстах нужна роль, а не имя', m[0]);
  }
  return { text: fixed, issues };
}

/** true, если среди замечаний есть блокирующие. */
export function lintBlocks(issues: LintIssue[] | undefined): boolean {
  return !!issues?.some((i) => i.severity === 'block');
}
