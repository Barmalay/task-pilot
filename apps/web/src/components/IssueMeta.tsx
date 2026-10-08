import { Boxes, CalendarDays, Tag } from 'lucide-react';
import type { SprintRef } from '@task-pilot/step-kit';
import { cx, Tip } from '../ui.tsx';

/** Метка или компонент задачи; кликабельна, если передан onPick. */
function MetaChip({ kind, value, active, onPick }: { kind: 'label' | 'component'; value: string; active?: boolean; onPick?: (v: string) => void }) {
  const Icon = kind === 'component' ? Boxes : Tag;
  const tone =
    kind === 'component'
      ? 'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-800'
      : 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700';
  const className = cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs ring-1', tone, active && 'ring-2 ring-blue-500');
  const content = (
    <>
      <Icon className="size-3" aria-hidden />
      {value}
    </>
  );
  if (!onPick) return <span className={className}>{content}</span>;
  return (
    <Tip text={`Показать только задачи с ${kind === 'component' ? 'компонентом' : 'меткой'} ${value}. Повторный клик снимает этот фильтр`}>
      <button type="button" className={cx(className, 'hover:brightness-95')} onClick={() => onPick(value)}>
        {content}
      </button>
    </Tip>
  );
}

/** Спринт, компоненты и метки задачи. */
export function IssueMeta({
  labels,
  components,
  sprint,
  active,
  onPick,
}: {
  labels: string[];
  components: string[];
  sprint?: SprintRef | null;
  active?: Set<string>;
  onPick?: (value: string, kind: 'label' | 'component') => void;
}) {
  if (!labels.length && !components.length && !sprint) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sprint && (
        <span className="inline-flex items-center gap-1 rounded-md bg-violet-50 px-1.5 py-0.5 text-xs text-violet-800 ring-1 ring-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:ring-violet-800">
          <CalendarDays className="size-3" aria-hidden />
          {sprint.name}
        </span>
      )}
      {components.map((c) => (
        <MetaChip key={`c:${c}`} kind="component" value={c} active={active?.has(`c:${c}`)} onPick={onPick && ((v) => onPick(v, 'component'))} />
      ))}
      {labels.map((l) => (
        <MetaChip key={`l:${l}`} kind="label" value={l} active={active?.has(`l:${l}`)} onPick={onPick && ((v) => onPick(v, 'label'))} />
      ))}
    </div>
  );
}
