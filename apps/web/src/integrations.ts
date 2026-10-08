import type { AccountDto, IntegrationAccountDto, IntegrationCheckDto, IntegrationDto, IntegrationsDto } from '@task-pilot/api-types';

/** Как выглядит состояние: цвет точки и плашки. */
export type Look = 'ok' | 'warn' | 'fail' | 'wait';

/** Состояние доступа для экрана: вид, короткая подпись и объяснение. */
export interface Shown {
  look: Look;
  text: string;
  title: string;
}

/** Итог проверки аккаунта: работает, нет доступа или еще не проверен. */
export function checkShown(check: IntegrationCheckDto | null): Shown {
  if (!check) return { look: 'wait', text: 'не проверен', title: 'Аккаунт еще не проверялся: нажмите "Проверить"' };
  if (!check.ok) return { look: 'fail', text: 'нет доступа', title: check.error ?? 'Проверка не прошла' };
  return { look: 'ok', text: 'работает', title: `Проверено ${new Date(check.at).toLocaleString('ru-RU')}` };
}

/**
 * Кто владелец доступа по проверке: у Jira и остальных - имя и логин, у Claude - почта, организация и тариф.
 * Пусто, если система работает без входа или еще не ответила.
 */
export function whoOf(kind: IntegrationDto['kind'], check: IntegrationCheckDto | null): string {
  if (!check?.ok) return '';
  if (kind === 'claude') return [check.login, check.name, check.detail].filter(Boolean).join(', ');
  if (check.name && check.login && check.name !== check.login) return `${check.name} (${check.login})`;
  return check.login ?? check.name ?? check.detail ?? '';
}

/** Активный аккаунт интеграции: под ним Task Pilot ходит в систему. */
export function activeOf(i: IntegrationDto): IntegrationAccountDto {
  return i.accounts.find((a) => a.active) ?? i.accounts[0]!;
}

/** Хост адреса для подписи; сам адрес, если он не разбирается. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Идет ли вход в Claude через браузер: пока идет, экран спрашивает сервер чаще. */
export function loginInProgress(list: IntegrationsDto | undefined): boolean {
  return !!list?.integrations.some((i) => i.logins.some((l) => l.state !== 'failed'));
}

/** Список интеграций с обновленной интеграцией из ответа на изменение. */
export function withIntegration(list: IntegrationsDto | undefined, next: IntegrationDto): IntegrationsDto | undefined {
  return list && { ...list, integrations: list.integrations.map((i) => (i.id === next.id ? next : i)) };
}

/** Значок Jira в шапке: под кем Task Pilot ходит в Jira и на кого шаги назначают задачи. */
export function jiraBadge(jira: AccountDto['jira'] | undefined): Shown {
  if (!jira) return { look: 'wait', text: 'проверяю', title: 'Проверяю вход' };
  const { active, me } = jira;
  const check = active.check;
  if (!check) return { look: 'wait', text: active.label, title: `Jira: аккаунт "${active.label}" еще не проверялся` };
  if (!check.ok) return { look: 'fail', text: 'нет входа', title: `Jira не отвечает: ${check.error ?? 'неизвестная ошибка'}` };
  const who = whoOf('jira', check) || active.label;
  const where = active.kind === 'default' ? 'доступ как обычно, из Claude Code' : `аккаунт "${active.label}" с экрана "Интеграции"`;
  if (!me) {
    return { look: 'warn', text: check.name ?? check.login ?? active.label, title: `Jira: ${who}, ${where}. Логин, на который шаги назначают задачи, не задан: укажите me в ~/.task-pilot/profile.yaml` };
  }
  if (active.kind === 'default' && check.login && check.login !== me) {
    return { look: 'warn', text: check.name ?? check.login, title: `Токен Jira из ~/.claude.json принадлежит ${who}, а в личных настройках указан ${me}: шаги назначают задачи на ${me}` };
  }
  return { look: 'ok', text: check.name ?? check.login ?? active.label, title: `Jira: ${who}, ${where}. Задачи назначаются на ${me}` };
}

/** Значок Claude в шапке: под каким аккаунтом работают агенты шагов. */
export function claudeBadge(claude: AccountDto['claude'] | undefined): Shown {
  if (!claude) return { look: 'wait', text: 'проверяю', title: 'Проверяю вход' };
  const { active } = claude;
  const check = active.check;
  if (!check) return { look: 'wait', text: active.label, title: `Claude: аккаунт "${active.label}" еще не проверялся` };
  if (!check.ok) return { look: 'fail', text: 'нет входа', title: `Claude: ${check.error ?? 'CLI claude не вошел в аккаунт'}` };
  const who = whoOf('claude', check);
  const where = active.kind === 'default' ? 'вход CLI claude' : `аккаунт "${active.label}" с экрана "Интеграции"`;
  return { look: 'ok', text: check.login ?? active.label, title: `Claude: ${where}${who ? `, ${who}` : ''}. Под ним работают агенты шагов` };
}
