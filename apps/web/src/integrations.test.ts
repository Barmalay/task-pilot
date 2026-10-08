import { describe, expect, it } from 'vitest';
import type { IntegrationAccountDto, IntegrationCheckDto, IntegrationDto, IntegrationsDto } from '@task-pilot/api-types';
import { activeOf, checkShown, claudeBadge, hostOf, jiraBadge, loginInProgress, whoOf, withIntegration } from './integrations.ts';

const AT = '2026-09-24T07:00:00.000Z';
const ok = (over: Partial<IntegrationCheckDto> = {}): IntegrationCheckDto => ({ ok: true, login: 'owner', name: 'Владелец', detail: null, error: null, at: AT, ...over });
const account = (over: Partial<IntegrationAccountDto> = {}): IntegrationAccountDto => ({
  id: null,
  kind: 'default',
  label: 'Как обычно, из Claude Code',
  source: 'MCP-сервер atlassian в ~/.claude.json',
  active: true,
  check: ok(),
  ...over,
});
const integration = (over: Partial<IntegrationDto> = {}): IntegrationDto => ({
  id: 'jira',
  kind: 'jira',
  title: 'Jira',
  url: 'https://jira.example.org',
  usedBy: 'доска',
  note: null,
  tokenHelp: 'токен',
  canToken: true,
  canLogin: false,
  accounts: [account()],
  logins: [],
  ...over,
});

describe('integration accounts on the screen', () => {
  it('says whether an account works, has no access or was not checked yet', () => {
    expect(checkShown(ok())).toMatchObject({ look: 'ok', text: 'работает' });
    expect(checkShown(ok({ ok: false, error: 'Jira: токен не принят, ответ 401' }))).toEqual({ look: 'fail', text: 'нет доступа', title: 'Jira: токен не принят, ответ 401' });
    expect(checkShown(null)).toMatchObject({ look: 'wait', text: 'не проверен' });
  });

  it('names the owner of the access: name and login, and for Claude the email, organisation and plan', () => {
    expect(whoOf('jira', ok())).toBe('Владелец (owner)');
    expect(whoOf('bitbucket', ok({ name: null }))).toBe('owner');
    expect(whoOf('claude', ok({ login: 'a@b.c', name: 'Org', detail: 'тариф team' }))).toBe('a@b.c, Org, тариф team');
    expect(whoOf('kibana', ok({ login: null, name: null, detail: 'отвечает без входа' }))).toBe('отвечает без входа');
    expect(whoOf('jira', ok({ ok: false }))).toBe('');
    expect(whoOf('jira', null)).toBe('');
  });

  it('finds the active account, shortens the address and replaces an integration after a change', () => {
    const i = integration({ accounts: [account({ active: false }), account({ id: 'ab12', kind: 'token', label: 'Технический', active: true })] });
    expect(activeOf(i).label).toBe('Технический');
    expect(hostOf('https://jira.example.org/secure')).toBe('jira.example.org');
    expect(hostOf('не адрес')).toBe('не адрес');
    const list: IntegrationsDto = { secrets: 'Keychain macOS', integrations: [integration(), integration({ id: 'claude', kind: 'claude' })] };
    expect(withIntegration(list, i)?.integrations.map((x) => x.accounts.length)).toEqual([2, 1]);
    expect(withIntegration(undefined, i)).toBeUndefined();
  });

  it('asks the server more often only while a claude login through the browser is going on', () => {
    const login = { id: 'l1', label: null, url: null, error: null, startedAt: AT };
    const list = (state: 'waiting' | 'checking' | 'failed'): IntegrationsDto => ({ secrets: 'x', integrations: [integration({ logins: [{ ...login, state }] })] });
    expect(loginInProgress(list('waiting'))).toBe(true);
    expect(loginInProgress(list('checking'))).toBe(true);
    expect(loginInProgress(list('failed'))).toBe(false);
    expect(loginInProgress(undefined)).toBe(false);
  });
});

describe('account badges in the header', () => {
  it('shows the Jira owner and warns when the token of ~/.claude.json belongs to someone other than me of personal settings', () => {
    expect(jiraBadge({ active: account(), me: 'owner' })).toMatchObject({ look: 'ok', text: 'Владелец', title: 'Jira: Владелец (owner), доступ как обычно, из Claude Code. Задачи назначаются на owner' });
    expect(jiraBadge({ active: account({ check: ok({ login: 'other', name: 'Другой' }) }), me: 'owner' })).toMatchObject({ look: 'warn', text: 'Другой' });
    const token = account({ id: 'ab12', kind: 'token', label: 'Технический', check: ok({ login: 'tech', name: 'Тех' }) });
    expect(jiraBadge({ active: token, me: 'tech' })).toMatchObject({ look: 'ok', title: 'Jira: Тех (tech), аккаунт "Технический" с экрана "Интеграции". Задачи назначаются на tech' });
    expect(jiraBadge({ active: account({ check: ok({ ok: false, error: 'нет сети' }) }), me: 'owner' })).toMatchObject({ look: 'fail', text: 'нет входа' });
    expect(jiraBadge(undefined)).toMatchObject({ look: 'wait' });
  });

  it('warns when the Jira login steps assign issues to is not set', () => {
    expect(jiraBadge({ active: account(), me: '' })).toMatchObject({
      look: 'warn',
      text: 'Владелец',
      title: 'Jira: Владелец (owner), доступ как обычно, из Claude Code. Логин, на который шаги назначают задачи, не задан: укажите me в ~/.task-pilot/profile.yaml',
    });
  });

  it('shows the claude account agents work under', () => {
    const cli = account({ label: 'Вход CLI claude', check: ok({ login: 'owner@example.org', name: 'Команда', detail: 'тариф team' }) });
    expect(claudeBadge({ active: cli })).toEqual({ look: 'ok', text: 'owner@example.org', title: 'Claude: вход CLI claude, owner@example.org, Команда, тариф team. Под ним работают агенты шагов' });
    const token = account({ id: 'cd34', kind: 'oauth-token', label: 'Личный', check: ok({ login: null, name: null, detail: 'CLI claude отвечает с этим токеном' }) });
    expect(claudeBadge({ active: token })).toMatchObject({ look: 'ok', text: 'Личный', title: 'Claude: аккаунт "Личный" с экрана "Интеграции", CLI claude отвечает с этим токеном. Под ним работают агенты шагов' });
    expect(claudeBadge({ active: account({ check: null }) })).toMatchObject({ look: 'wait' });
    expect(claudeBadge({ active: account({ check: ok({ ok: false, error: 'CLI claude не вошел в аккаунт' }) }) })).toMatchObject({ look: 'fail', title: 'Claude: CLI claude не вошел в аккаунт' });
  });
});
