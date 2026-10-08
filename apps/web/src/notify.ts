import type { EventDto } from '@task-pilot/api-types';

/** Уведомление вкладки: заголовок, текст и экран, который откроет клик. */
export interface Notice {
  title: string;
  body: string;
  /** Адрес экрана после #: прогон или дашборд мониторинга. */
  href: string;
  /** Одинаковый tag у двух вкладок: браузер покажет уведомление один раз. */
  tag: string;
}

const TITLES: Record<string, string> = {
  'approval.requested': 'Нужно ваше подтверждение',
  'question.asked': 'Агент спрашивает',
  'ask.answered': 'Ответ на ваш вопрос о прогоне',
  'pr.merged': 'PR смержен',
  'pr.review': 'Замечания в PR',
  'issue.changed': 'Задача изменилась в Jira',
};

const RUN_TITLES: Record<string, string> = {
  failed: 'Шаг упал',
  completed: 'Прогон выполнен',
};

function clip(text: string, size = 180): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > size ? `${one.slice(0, size - 3)}...` : one;
}

/**
 * Уведомление по событию общего потока или null, если о событии уведомлять не нужно. Текст начинается с ключа
 * задачи, один раз, даже если его уже называет само событие: уведомления разных прогонов не путаются.
 */
export function noticeOf(e: EventDto): Notice | null {
  // Сработавший алерт мониторинга: прогона у него нет, клик открывает дашборд. О снятии алерта не уведомляем.
  if (e.type === 'monitor.alert') {
    const data = (e.data ?? {}) as { state?: unknown; dashboard?: unknown };
    if (data.state !== 'firing' || typeof data.dashboard !== 'string') return null;
    return { title: 'Алерт мониторинга', body: clip(e.message ?? ''), href: `/monitor/${data.dashboard}`, tag: `task-pilot-${e.id}` };
  }
  if (!e.runId) return null;
  const status = (e.data as { status?: unknown } | null)?.status;
  const title = e.type === 'run.status' ? (typeof status === 'string' ? RUN_TITLES[status] : undefined) : TITLES[e.type];
  if (!title) return null;
  const text = e.type === 'run.status' ? (status === 'failed' ? 'Прогон остановлен на ошибке' : 'Все выбранные шаги выполнены') : (e.message ?? '');
  const body = clip(e.issueKey && !text.startsWith(e.issueKey) ? `${e.issueKey}: ${text}` : text);
  return { title, body, href: `/runs/${e.runId}`, tag: `task-pilot-${e.id}` };
}

/** Где хранится выбор владельца: уведомления можно выключить, не отзывая разрешение браузера. */
export const MUTE_KEY = 'task-pilot.notifications';

/** Уведомления выключены владельцем в этом браузере. */
export function muted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === 'off';
  } catch {
    return false;
  }
}

/**
 * Показывает уведомление, если браузер разрешил, владелец не выключил их и не смотрит сейчас на вкладку: тогда он
 * и так видит событие на экране. Клик открывает прогон или дашборд в этой вкладке.
 */
export function show(n: Notice): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || muted()) return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const notification = new Notification(n.title, { body: n.body, tag: n.tag });
  notification.onclick = () => {
    window.focus();
    window.location.hash = n.href;
    notification.close();
  };
}
