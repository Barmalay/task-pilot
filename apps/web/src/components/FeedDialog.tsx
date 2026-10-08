import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EventDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { FEED_FILTERS, findTarget, historyBehind, matchesFeed, mergeFeed, type FeedFilter, type FeedTarget } from '../feed.ts';
import { Button, cx, ErrorBox, Tip } from '../ui.tsx';
import { EventDetails } from './EventDetails.tsx';
import { EventFeed } from './EventFeed.tsx';

/**
 * Вся лента прогона: история с сервера по страницам (от новых к старым) вместе с живым потоком, фильтры по виду
 * событий, поиск по тексту и подробности выбранного события рядом со списком. Открывается кнопкой "Вся лента", кликом по
 * событию в карточке ленты, по записи журнала сбоев и правок или по отрезку в карточке времени; закрывается Escape,
 * кнопкой или кликом мимо окна.
 */
export function FeedDialog({
  runId,
  live,
  initial,
  target,
  onClose,
}: {
  runId: string;
  live: EventDto[];
  initial: EventDto | null;
  /** Событие, которое окно найдет само: по id или первое событие шага с момента; история догружается, пока его нет. */
  target?: FeedTarget;
  onClose: () => void;
}) {
  const pages = useInfiniteQuery({
    queryKey: ['feed', runId],
    queryFn: ({ pageParam }) => api.feed(runId, pageParam),
    initialPageParam: undefined as number | undefined,
    // Следующая страница - события старше самого старого из загруженных.
    getNextPageParam: (last) => (last.more ? last.events[0]?.id : undefined),
  });
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [query, setQuery] = useState('');
  // Выбранное событие хранится целиком: подробности остаются на экране, даже когда фильтр или перечитывание убрали его из списка.
  const [selected, setSelected] = useState<EventDto | null>(initial);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Фокус ставится только при открытии: onClose меняется с каждым живым событием и не должен уводить фокус из поиска.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Пока окно открыто, живой поток уходит вперед; когда история от него отстала, она перечитывается от самых новых.
  const behind = historyBehind(pages.data?.pages[0]?.events, live);
  const { refetch } = pages;
  useEffect(() => {
    if (behind) void refetch();
  }, [behind, refetch]);

  const all = mergeFeed(...(pages.data?.pages.map((p) => p.events) ?? []), live);
  const shown = all.filter((e) => matchesFeed(e, filter, query));
  // Цель окна ищется среди загруженных событий; пока ее нет, история догружается раньше, до самого начала прогона.
  const aimed = target ? findTarget(all, target) : undefined;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  useEffect(() => {
    if (!target || aimed || !pages.data || !hasNextPage || isFetchingNextPage) return;
    void fetchNextPage();
  }, [target, aimed, pages.data, hasNextPage, isFetchingNextPage, fetchNextPage]);
  useEffect(() => {
    if (aimed) setSelected((current) => current ?? aimed);
  }, [aimed]);
  // Событие, с которым открыли окно, прокручивается в список один раз, когда оно в нем появилось и выбрано.
  const scrolled = useRef(false);
  const opening = initial ?? aimed ?? null;
  const found = opening !== null && selected?.id === opening.id && all.some((e) => e.id === opening.id);
  useEffect(() => {
    if (scrolled.current || !found) return;
    scrolled.current = true;
    dialogRef.current?.querySelector('li[aria-current="true"]')?.scrollIntoView({ block: 'center' });
  }, [found]);

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feed-title"
        className="flex h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl outline-none dark:bg-slate-900"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <ScrollText className="size-4 text-slate-500" aria-hidden />
          <h2 id="feed-title" className="font-semibold">
            Лента прогона
          </h2>
          <span className="text-xs text-slate-500 tabular-nums">событий {all.length}{pages.hasNextPage ? ', есть еще раньше' : ''}</span>
          <Button variant="ghost" size="sm" icon={X} className="ml-auto" onClick={onClose} aria-label="Закрыть ленту" />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-2.5 dark:border-slate-800">
          {FEED_FILTERS.map((f) => {
            const count = all.filter((e) => matchesFeed(e, f.id, query)).length;
            return (
              <Tip key={f.id} text={f.hint}>
                <button
                  type="button"
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={cx(
                    'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                    filter === f.id ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                  )}
                >
                  {f.label} <span className="tabular-nums opacity-70">{count}</span>
                </button>
              </Tip>
            );
          })}
          <label className="ml-auto flex items-center gap-1.5 rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700">
            <Search className="size-3.5 text-slate-400" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по тексту и шагу" className="w-56 bg-transparent outline-none" aria-label="Поиск по ленте" />
          </label>
        </div>
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:grid-rows-1">
          <div className="min-h-0 overflow-y-auto border-b border-slate-100 lg:border-r lg:border-b-0 dark:border-slate-800">
            {pages.isError && (
              <div className="p-3">
                <ErrorBox error={pages.error} title="Не удалось загрузить историю ленты" />
              </div>
            )}
            <EventFeed events={shown} onOpen={setSelected} selectedId={selected?.id} />
            {pages.hasNextPage && (
              <div className="px-4 pb-4">
                <Button variant="secondary" size="sm" className="w-full" spin={pages.isFetchingNextPage} disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                  Показать раньше
                </Button>
              </div>
            )}
          </div>
          <div className="min-h-0 overflow-y-auto p-5">
            {selected ? <EventDetails key={selected.id} runId={runId} event={selected} /> :<p className="text-sm text-slate-500">Выберите событие в списке: у правок файлов откроется дифф, у команд их вывод, у подтверждений то, что на них было показано</p>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
