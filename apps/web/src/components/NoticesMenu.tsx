import { useQuery } from '@tanstack/react-query';
import { Bell, BellOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { loadSeen, newestId, noticeDays, noticeItems, saveSeen, timeOf, unreadCount } from '../notices.ts';
import { MUTE_KEY, muted } from '../notify.ts';
import { Button, cx, ErrorBox, Popover, Tip, useNow, usePopover } from '../ui.tsx';

/** Уведомления браузера: не умеет, еще не спрашивали, включены, выключены владельцем или запрещены в браузере. */
type BrowserState = 'unsupported' | 'ask' | 'on' | 'off' | 'denied';

function browserState(): BrowserState {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'default') return 'ask';
  return muted() ? 'off' : 'on';
}

const BROWSER_TEXT: Record<BrowserState, string> = {
  unsupported: 'Этот браузер не умеет показывать уведомления',
  ask: 'Уведомления браузера еще не включены: браузер спросит разрешение',
  on: 'Уведомления браузера включены: придут, когда вы не смотрите на вкладку',
  off: 'Уведомления браузера выключены: история здесь все равно пополняется',
  denied: 'Уведомления запрещены: в браузере разрешите их этому сайту в настройках сайта, в приложении Task Pilot - в Системных настройках, раздел Уведомления',
};

/**
 * Уведомления в шапке: колокольчик со счетчиком новых и история по дням и времени - подтверждения, вопросы агентов,
 * ответы на вопросы о прогоне, упавшие и законченные прогоны, мерж и замечания в PR, изменения задачи, алерты
 * мониторинга. Клик по уведомлению открывает его прогон или дашборд. Там же включаются и выключаются уведомления
 * браузера: первое включение просит разрешение, дальше выбор хранится в этом браузере, не отзывая разрешение.
 * Новые - те, что пришли после последнего открытия списка; история до первого открытия считается прочитанной.
 */
export function NoticesMenu() {
  const notices = useQuery({ queryKey: ['notifications'], queryFn: () => api.notifications(50) });
  const items = noticeItems(notices.data ?? []);
  const newest = newestId(items);
  const [seen, setSeen] = useState<number | null>(loadSeen);
  // Порог выделения новых в открытом списке: отметка просмотра до открытия.
  const [highlight, setHighlight] = useState<number | null>(null);
  const [browser, setBrowser] = useState<BrowserState>(browserState);
  const pop = usePopover();
  const now = useNow(60_000);

  useEffect(() => {
    if (seen !== null || !notices.isSuccess) return;
    saveSeen(newest ?? 0);
    setSeen(newest ?? 0);
  }, [seen, notices.isSuccess, newest]);

  const unread = unreadCount(items, seen);
  const toggleList = () => {
    if (!pop.open) {
      setHighlight(seen);
      if (newest !== null) {
        saveSeen(newest);
        setSeen(newest);
      }
    }
    pop.toggle();
  };
  const toggleBrowser = async () => {
    if (browser === 'ask') await Notification.requestPermission();
    else if (browser === 'on' || browser === 'off') {
      try {
        localStorage.setItem(MUTE_KEY, browser === 'on' ? 'off' : 'on');
      } catch {
        // Хранилище недоступно (приватный режим): уведомления остаются включенными.
      }
    }
    setBrowser(browserState());
  };
  const Icon = browser === 'on' ? Bell : BellOff;

  return (
    <div ref={pop.ref} className="relative shrink-0">
      <Tip text={unread ? `Новых уведомлений: ${unread}. Нажмите, чтобы посмотреть` : 'Уведомления: что было и когда, и уведомления браузера'}>
        <button
          type="button"
          onClick={toggleList}
          aria-expanded={pop.open}
          aria-label={unread ? `Уведомления, новых: ${unread}` : 'Уведомления'}
          className={cx('relative rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800', browser === 'on' ? 'text-blue-700 dark:text-blue-400' : 'text-slate-500')}
        >
          <Icon className="size-4" aria-hidden />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] leading-none font-semibold text-white">{unread > 99 ? '99+' : unread}</span>
          )}
        </button>
      </Tip>
      {pop.open && (
        <Popover label="Уведомления" className="w-[26rem]">
          <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <div className="text-sm font-semibold">Уведомления</div>
            <Tip text={BROWSER_TEXT[browser]} className="ml-auto">
              <Button variant="ghost" size="sm" icon={Icon} disabled={browser === 'unsupported' || browser === 'denied'} onClick={() => void toggleBrowser()}>
                {browser === 'on' ? 'Выключить в браузере' : browser === 'off' || browser === 'ask' ? 'Включить в браузере' : 'Браузер не покажет'}
              </Button>
            </Tip>
          </div>
          {notices.error && (
            <div className="p-3">
              <ErrorBox error={notices.error} title="Не удалось загрузить уведомления" />
            </div>
          )}
          {notices.isSuccess && !items.length && <div className="px-4 py-6 text-sm text-slate-500">Уведомлений пока нет: здесь появится все, где нужны вы или что вы ждали</div>}
          {noticeDays(items, now).map((day) => (
            <section key={day.label}>
              <div className="sticky top-0 bg-slate-50 px-4 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800/80">{day.label}</div>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {day.items.map((n) => {
                  const fresh = highlight !== null && n.id > highlight;
                  return (
                    <li key={n.id}>
                      <a href={`#${n.href}`} className={cx('flex gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800', fresh && 'bg-blue-50/60 dark:bg-blue-950/40')}>
                        <span className="w-10 shrink-0 pt-0.5 text-xs text-slate-400 tabular-nums">{timeOf(n.at)}</span>
                        <div className="min-w-0 flex-1">
                          <div className={cx('text-sm text-slate-800 dark:text-slate-100', fresh && 'font-semibold')}>{n.title}</div>
                          <div className="line-clamp-2 text-xs text-slate-500">{n.body}</div>
                        </div>
                        {fresh && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-blue-600" aria-label="новое" />}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </Popover>
      )}
    </div>
  );
}
