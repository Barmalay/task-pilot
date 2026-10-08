import { Maximize2, Minimize2, ScrollText } from 'lucide-react';
import { useState } from 'react';
import type { EventDto } from '@task-pilot/api-types';
import { Button, Card } from '../ui.tsx';
import { EventFeed } from './EventFeed.tsx';

const EXPANDED_KEY = 'task-pilot.feed.expanded';
/** Сколько последних событий показывает карточка; все - в окне всей ленты. */
const CARD_EVENTS = 100;

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeExpanded(value: boolean): void {
  try {
    localStorage.setItem(EXPANDED_KEY, value ? '1' : '0');
  } catch {
    // Выбор высоты - удобство одной вкладки: без хранилища лента просто откроется свернутой.
  }
}

/**
 * Карточка ленты прогона: последние события в невысоком окне. "Развернуть" растягивает ее на высоту экрана (выбор
 * запоминается), "Вся лента" и клик по событию открывают окно со всей историей прогона, фильтрами и подробностями:
 * его держит страница прогона, потому что оно открывается и из журнала сбоев, и из карточки времени.
 */
export function FeedCard({ events, onOpen }: { events: EventDto[]; onOpen: (initial: EventDto | null) => void }) {
  const [expanded, setExpanded] = useState(readExpanded);
  const toggle = () => {
    writeExpanded(!expanded);
    setExpanded(!expanded);
  };
  return (
    <Card>
      <div className="flex items-center gap-1 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
        <h2 className="mr-auto font-semibold">Лента</h2>
        <Button variant="ghost" size="sm" icon={expanded ? Minimize2 : Maximize2} onClick={toggle} title={expanded ? 'Свернуть ленту до нескольких последних событий' : 'Развернуть ленту на высоту экрана'}>
          {expanded ? 'Свернуть' : 'Развернуть'}
        </Button>
        <Button variant="ghost" size="sm" icon={ScrollText} onClick={() => onOpen(null)} title="Вся история прогона с фильтрами и подробностями: дифф правок файлов, вывод команд, содержимое подтверждений, вопросы с ответами">
          Вся лента
        </Button>
      </div>
      <EventFeed events={events.slice(-CARD_EVENTS)} onOpen={onOpen} className={expanded ? 'max-h-[70vh]' : 'max-h-56'} />
    </Card>
  );
}
