import type { StandDto } from '@task-pilot/api-types';
import { ago, cx } from '../ui.tsx';

/** Что сейчас на выбранном стенде и чем это грозит деплою задачи: чужой релиз, идущий деплой, стенд не отвечает. */
export function StandNow({ s, issueKey }: { s: StandDto; issueKey: string }) {
  if (!s.release) return null;
  const busy = s.release.lifeCycle !== null && s.release.lifeCycle !== 'FINISHED';
  const foreign = s.task !== null && s.task !== issueKey;
  const state = busy ? 'идет деплой' : s.release.state === 'SUCCESS' ? 'выкачен' : `последний деплой ${s.release.state?.toLowerCase() ?? 'неизвестно чем закончился'}`;
  const when = busy ? '' : ` ${ago(s.release.finishedAt ?? s.release.startedAt)}`;
  return (
    <p className={cx((busy || foreign || s.up === false) && 'text-amber-700 dark:text-amber-400')}>
      Сейчас на стенде {s.title}: {s.release.name}
      {s.branch ? ` (${s.branch})` : ''}, {state}
      {when}
      {foreign && `; это релиз задачи ${s.task}, деплой заменит его`}
      {s.up === false && '; стенд не отвечает'}
    </p>
  );
}
