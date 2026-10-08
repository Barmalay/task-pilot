import type { ServiceDocDto, ServiceDto } from '@task-pilot/api-types';

/** Почему сервер сейчас нельзя перезапустить с экрана; null - можно. */
export function restartBlock(server: Pick<ServiceDto['server'], 'launchedByApp' | 'runs'>): string | null {
  if (!server.launchedByApp) return 'Сервер запущен не приложением Task Pilot, например командой pnpm dev: перезапустите его там, где запускали';
  const running = server.runs.filter((r) => r.status === 'running');
  if (running.length) return `Выполняется прогонов: ${running.length} (${running.map((r) => r.issueKey).join(', ')}). Перезапуск прервал бы их шаги`;
  return null;
}

/** Нужен ли перезапуск и почему: сервер читает код, пакеты и профили только при запуске. */
export function restartNeed(server: Pick<ServiceDto['server'], 'changed'>): { needed: boolean; text: string } {
  const n = server.changed.length;
  return n
    ? { needed: true, text: `Нужен перезапуск: после запуска изменились файлы, которые сервер читает только при запуске (${n})` }
    : { needed: false, text: 'Перезапуск не нужен: код сервера, пакеты, профили и личные настройки не менялись после запуска' };
}

/** Сколько работает сервер: "меньше минуты", "12 мин", "3 ч 5 мин", "2 д 4 ч". */
export function uptimeText(startedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  if (minutes < 1) return 'меньше минуты';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} ч ${minutes % 60} мин` : `${hours} ч`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} д ${hours % 24} ч` : `${days} д`;
}

/** Ответил новый сервер: время запуска сменилось по сравнению с тем, что было до перезапуска. */
export function restarted(before: string, now: Pick<ServiceDto['server'], 'startedAt'> | undefined): boolean {
  return now !== undefined && now.startedAt !== before;
}

export const DOC_KIND: Record<ServiceDocDto['kind'], string> = { acceptance: 'гайд приемки', notes: 'журнал решений', plan: 'план' };

/** Доки на решение: принятые показываются только по просьбе. */
export function docsShown(docs: ServiceDocDto[], showAccepted: boolean): ServiceDocDto[] {
  return docs.filter((d) => showAccepted || !d.accepted);
}

const DIRTY: Record<string, string> = { M: 'изменен', A: 'добавлен', D: 'удален', R: 'переименован', C: 'скопирован' };

/** Что значит двузначный код git status: первый знак - индекс, второй - рабочая папка. */
export function dirtyText(code: string): string {
  if (code === '??') return 'новый, не в git';
  const [index = ' ', tree = ' '] = code.padEnd(2, ' ');
  if (index === 'U' || tree === 'U') return 'конфликт слияния';
  if (index !== ' ' && tree !== ' ') return `${DIRTY[index] ?? index} в индексе и изменен после этого`;
  if (index !== ' ') return `${DIRTY[index] ?? index}, в индексе`;
  return DIRTY[tree] ?? code.trim();
}
