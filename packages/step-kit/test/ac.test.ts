import { describe, expect, it } from 'vitest';
import { acceptanceCriteriaOf, extractAcceptanceCriteria, findAcceptanceSections } from '../src/ac.ts';

describe('extractAcceptanceCriteria', () => {
  it('reads a numbered list under a bold heading', () => {
    const d = '**Что:** сделать метрику\r\n\r\n**Критерии приемки:**\r\n1. Метрика растет при ошибке\r\n2. Алерт срабатывает\r\n\r\n**Зачем:** мониторинг';
    expect(extractAcceptanceCriteria(d)).toEqual(['Метрика растет при ошибке', 'Алерт срабатывает']);
  });

  it('accepts the heading spelled with the dotted e letter', () => {
    expect(extractAcceptanceCriteria('## Критерии приёмки\n- первый\n- второй')).toEqual(['первый', 'второй']);
  });

  it('accepts the short AC heading and Jira wiki headings', () => {
    expect(extractAcceptanceCriteria('h3. AC\n* один\n* два')).toEqual(['один', 'два']);
    expect(extractAcceptanceCriteria('Acceptance criteria\n- one')).toEqual(['one']);
  });

  it('stops at the next section', () => {
    const d = '# Критерии приемки\n- пункт\n# Детали\n- не критерий';
    expect(extractAcceptanceCriteria(d)).toEqual(['пункт']);
  });

  it('returns null when there is no criteria section', () => {
    expect(extractAcceptanceCriteria('**Метрики:**\n1. ошибка\n2. еще ошибка')).toBeNull();
  });

  it('returns null when the section has no list items', () => {
    expect(extractAcceptanceCriteria('Критерии приемки\nсм. вики')).toBeNull();
  });
});

/** Описание в том виде, в каком его отдает mcp-atlassian: три раздела AC разного вида (как в TEAM-2799). */
const MCP_DESCRIPTION = [
  '## Безопасность (критерии приёмки)',
  '\\* Аутентификатор не доверяет ничему из URL.',
  '\\*\\* Невалидный токен: \\*\\*поведение не меняется\\*\\*.',
  '### Коды ответа обмена',
  '| Случай | Статус |',
  '|---|---|',
  '| Любой отказ | 401 |',
  '## Критерии приёмки',
  '# Пользователь получает SSO-пару без разлогина.',
  '# Токен содержит realm_access.roles.',
  '# Метрика выпусков настроена.',
  '## Что блокирует',
  'Все задачи по переводу сервисов.',
  '----',
  '### Acceptance Criteria',
  '\\*\\*Легенда:\\*\\* паспортный токен - кука в браузере.',
  '|№|Тип|AC|Артефакты|',
  '|---|---|---|---|',
  '|1|HP|Войти на стенде и удалить SSO-куки.|Видео|',
  '|2|HP|Раскодировать access-токен.|Скриншот|',
  '|3|EC|Испортить подпись паспортного токена.|Скриншот|',
  '|4|EC|Нажать выйти после обмена.|Видео|',
  '\\*\\*На чём проверять:\\*\\* десктоп, мобайл',
].join('\n');

describe('findAcceptanceSections on descriptions from MCP', () => {
  it('finds bullet, numbered and table sections and skips unrelated tables', () => {
    const sections = findAcceptanceSections(MCP_DESCRIPTION);
    expect(sections.map((s) => [s.title, s.items.length])).toEqual([
      ['Безопасность (критерии приёмки)', 2],
      ['Критерии приёмки', 3],
      ['Acceptance Criteria', 4],
    ]);
  });

  it('unescapes markdown and keeps nested bullets as items', () => {
    const [security] = findAcceptanceSections(MCP_DESCRIPTION);
    expect(security?.items).toEqual(['Аутентификатор не доверяет ничему из URL.', 'Невалидный токен: поведение не меняется.']);
  });

  it('reads the AC and type columns of a table and ignores the legend before it', () => {
    const table = findAcceptanceSections(MCP_DESCRIPTION)[2];
    expect(table?.items).toEqual(['HP: Войти на стенде и удалить SSO-куки.', 'HP: Раскодировать access-токен.', 'EC: Испортить подпись паспортного токена.', 'EC: Нажать выйти после обмена.']);
  });

  it('takes the most detailed section as the acceptance criteria', () => {
    expect(extractAcceptanceCriteria(MCP_DESCRIPTION)).toHaveLength(4);
  });
});

describe('acceptanceCriteriaOf', () => {
  const description = 'Задача\n\nКритерии приемки:\n1. Капча показывается\n2. SMS не уходит';

  it('takes the criteria from the description', () => {
    expect(acceptanceCriteriaOf({ labels: ['backend'], description })).toEqual(['Капча показывается', 'SMS не уходит']);
    expect(acceptanceCriteriaOf({ labels: [], description: 'Без раздела критериев' })).toBeNull();
  });

  it('gives an empty list for a task with the skip_ac label whatever the description says', () => {
    expect(acceptanceCriteriaOf({ labels: ['skip_ac'], description })).toEqual([]);
    expect(acceptanceCriteriaOf({ labels: ['dev_test', 'skip_ac'], description: 'Без раздела критериев' })).toEqual([]);
  });
});
