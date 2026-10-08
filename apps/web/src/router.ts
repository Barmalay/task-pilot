import { useEffect, useState } from 'react';

/** Экран приложения по адресу после #. */
export type Route =
  | { name: 'tasks' }
  | { name: 'catalog' }
  | { name: 'presets' }
  | { name: 'stands' }
  | { name: 'history' }
  | { name: 'integrations' }
  | { name: 'environment' }
  | { name: 'service' }
  | { name: 'run'; id: string }
  | { name: 'monitor' }
  | { name: 'dashboard'; id: string }
  | { name: 'feature'; id: string }
  | { name: 'attempt'; value: string; at: number | null };

/** Экран по адресу после #; незнакомый адрес - доска задач. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  const run = /^\/runs\/([\w-]+)$/.exec(path);
  if (run?.[1]) return { name: 'run', id: run[1] };
  const attempt = /^\/monitor\/attempt(?:\/([^/]+)(?:\/(\d+))?)?$/.exec(path);
  if (attempt) return { name: 'attempt', value: attempt[1] ? decodeURIComponent(attempt[1]) : '', at: attempt[2] ? Number(attempt[2]) : null };
  const feature = /^\/monitor\/features\/([\w-]+)$/.exec(path);
  if (feature?.[1]) return { name: 'feature', id: feature[1] };
  const dashboard = /^\/monitor\/([\w-]+)$/.exec(path);
  if (dashboard?.[1]) return { name: 'dashboard', id: dashboard[1] };
  if (path === '/monitor') return { name: 'monitor' };
  if (path === '/catalog') return { name: 'catalog' };
  if (path === '/presets') return { name: 'presets' };
  if (path === '/stands') return { name: 'stands' };
  if (path === '/history') return { name: 'history' };
  if (path === '/integrations') return { name: 'integrations' };
  if (path === '/environment') return { name: 'environment' };
  if (path === '/service') return { name: 'service' };
  return { name: 'tasks' };
}

/** Текущий экран; меняется вместе с адресом. */
export function useRoute(): Route {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parseRoute(hash);
}

/** Переход на экран. */
export function go(path: string): void {
  window.location.hash = path;
}
