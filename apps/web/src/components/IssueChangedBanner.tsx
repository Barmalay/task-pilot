import { RefreshCw, X } from 'lucide-react';
import { Button, Card } from '../ui.tsx';

/** Изменения задачи, найденные наблюдателем Task Pilot: лежат в контексте прогона как issueChanged. */
interface IssueChanged {
  at: string;
  status: string;
  changes: { kind: string; text: string; returned?: boolean }[];
}

function isChanged(value: unknown): value is IssueChanged {
  return !!value && typeof value === 'object' && Array.isArray((value as IssueChanged).changes) && (value as IssueChanged).changes.length > 0;
}

/**
 * Плашка на прогоне: задача изменилась в Jira с тех пор, как по ней работал прогон. "Доработать" переключает прогон
 * на пресет "Доработка" и запускает его шаг по изменению задачи: он покажет изменения и обновит план на утверждение;
 * без такого шага в пресете кнопки нет. "Скрыть", если дорабатывать нечего, перечитывает задачу из Jira: она
 * становится новым снимком прогона, и плашка гаснет.
 */
export function IssueChangedBanner({
  value,
  busy,
  canRework,
  onRework,
  onDismiss,
}: {
  value: unknown;
  busy: boolean;
  canRework: boolean;
  /** Нет - в пресете доработки нет шага по изменению задачи, и кнопка "Доработать" не показывается. */
  onRework?: () => void;
  onDismiss: () => void;
}) {
  if (!isChanged(value)) return null;
  const returned = value.changes.some((c) => c.returned);
  const when = new Date(value.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return (
    <Card className="border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-amber-900 dark:text-amber-200">{returned ? 'Задачу вернули в Jira' : 'Задача изменилась в Jira'}</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-amber-900 dark:text-amber-200">
            {value.changes.map((c) => (
              <li key={c.text}>{c.text}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-300/80">Заметил наблюдатель Task Pilot {when}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {onRework && (
            <Button
              size="sm"
              icon={RefreshCw}
              disabled={busy || !canRework}
              onClick={onRework}
              title={canRework ? 'Переключить прогон на пресет "Доработка" и запустить его шаг по изменению задачи: он покажет изменения и обновит план на утверждение' : 'Прогон выполняется: доработку можно начать после его остановки'}
            >
              Доработать
            </Button>
          )}
          <Button variant="ghost" size="sm" icon={X} disabled={busy} onClick={onDismiss} title="Скрыть: изменения посмотрел, дорабатывать не нужно. Задача перечитается из Jira и станет новой точкой отсчета">
            Скрыть
          </Button>
        </div>
      </div>
    </Card>
  );
}
