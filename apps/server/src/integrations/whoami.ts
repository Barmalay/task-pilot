import type { IntegrationKind } from './registry.ts';

/** Владелец доступа по ответу самой системы. */
export interface Identity {
  /** Логин; null - система без входа. */
  login: string | null;
  name: string | null;
}

/** Проверка доступа к системе: кто владелец токена. Отказ системы - исключение с понятным текстом. */
export type WhoAmI = (kind: Exclude<IntegrationKind, 'claude'>, url: string, token: string | null) => Promise<Identity>;

/** Система отказала в доступе: токен неверный, отозван или истек. */
export class AccessDenied extends Error {}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * "Кто я" каждой системы: Jira `/rest/api/2/myself`, Confluence `/rest/api/user/current` (анонимному она тоже отвечает
 * 200, поэтому смотрится type), Bitbucket `/plugins/servlet/applinks/whoami` (логин текстом, пустой у анонимного) и
 * имя из `/rest/api/1.0/users`, Bamboo `/rest/api/latest/currentUser`, Elasticsearch `/_security/_authenticate` с ключом
 * ApiKey. Kibana стендов работает без входа, у нее проверяется только `/api/status`. Запросы только читают.
 */
export function createWhoAmI(doFetch: typeof fetch = fetch, timeoutMs = 10_000): WhoAmI {
  const get = async (url: string, headers: Record<string, string>, what: string): Promise<string> => {
    let r: Response;
    try {
      r = await doFetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // Сетевой сбой: система не ответила или до нее нет маршрута (например, без VPN контура).
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`${what}: нет ответа за ${Math.round(timeoutMs / 1000)} с`);
      const code = (e as { cause?: { code?: unknown } }).cause?.code;
      throw new Error(`${what}: не удалось подключиться${typeof code === 'string' ? ` (${code})` : ''}`);
    }
    const body = await r.text();
    if (r.status === 401 || r.status === 403) throw new AccessDenied(`${what}: токен не принят, ответ ${r.status}`);
    if (!r.ok) throw new Error(`${what}: ответ ${r.status}`);
    return body;
  };
  const json = (body: string, what: string): Record<string, unknown> => {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new Error(`${what}: ответ не JSON`);
    }
  };
  return async (kind, url, token) => {
    const base = url.replace(/\/+$/, '');
    const bearer: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    if (kind === 'kibana') {
      await get(`${base}/api/status`, {}, 'Kibana');
      return { login: null, name: null };
    }
    if (!token) throw new Error('Нет токена');
    if (kind === 'jira') {
      const o = json(await get(`${base}/rest/api/2/myself`, bearer, 'Jira'), 'Jira');
      return { login: text(o.name), name: text(o.displayName) };
    }
    if (kind === 'confluence') {
      const o = json(await get(`${base}/rest/api/user/current`, bearer, 'Confluence'), 'Confluence');
      if (o.type === 'anonymous' || !text(o.username)) throw new AccessDenied('Confluence: токен не принят, ответ как анонимному');
      return { login: text(o.username), name: text(o.displayName) };
    }
    if (kind === 'bitbucket') {
      const login = (await get(`${base}/plugins/servlet/applinks/whoami`, bearer, 'Bitbucket')).trim();
      if (!login) throw new AccessDenied('Bitbucket: токен не принят, ответ как анонимному');
      let name: string | null = null;
      try {
        name = text(json(await get(`${base}/rest/api/1.0/users/${encodeURIComponent(login)}`, bearer, 'Bitbucket'), 'Bitbucket').displayName);
      } catch {
        // Имя нужно только для подписи: логина достаточно.
      }
      return { login, name };
    }
    if (kind === 'bamboo') {
      const o = json(await get(`${base}/rest/api/latest/currentUser`, bearer, 'Bamboo'), 'Bamboo');
      return { login: text(o.name), name: text(o.fullName) };
    }
    const o = json(await get(`${base}/_security/_authenticate`, { authorization: `ApiKey ${token}` }, 'Elasticsearch'), 'Elasticsearch');
    const key = text((o.api_key as { name?: unknown } | undefined)?.name);
    return { login: text(o.username), name: key ? `ключ ${key}` : null };
  };
}
