import { useQuery } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, RefreshCw } from 'lucide-react';
import type { DoctorLevel } from '@task-pilot/api-types';
import { api } from '../api.ts';
import type { Tone } from '../ui.tsx';
import { Button, Card, Chip, ErrorBox, Loading, PageHeader } from '../ui.tsx';

const LEVEL: Record<DoctorLevel, { tone: Tone; icon: typeof CircleCheck; text: string }> = {
  ok: { tone: 'green', icon: CircleCheck, text: 'в порядке' },
  warn: { tone: 'amber', icon: CircleAlert, text: 'внимание' },
  fail: { tone: 'red', icon: CircleAlert, text: 'проблема' },
};

/** Экран "Окружение": программы, файлы и папки этой машины, от которых зависит Task Pilot, - то же, что pnpm checkup. */
export function EnvironmentPage() {
  const doctor = useQuery({ queryKey: ['doctor'], queryFn: api.doctor, staleTime: 5 * 60_000 });
  return (
    <section>
      <PageHeader
        className="mb-4"
        title="Окружение"
        help='Программы, файлы и папки этой машины, от которых зависит Task Pilot. То же печатает pnpm checkup в терминале; доступ к системам проверяет вкладка "Интеграции", а место на диске чистится на вкладке "История"'
        actions={
          <Button variant="ghost" icon={RefreshCw} spin={doctor.isFetching} onClick={() => void doctor.refetch()} title="Проверить окружение заново">
            Проверить
          </Button>
        }
      />
      {doctor.isLoading && <Loading text="Проверяю окружение" />}
      {doctor.error && <ErrorBox error={doctor.error} title="Проверка окружения не прошла" />}
      {doctor.data && (
        <Card className="px-4 py-1">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {doctor.data.checks.map((c) => {
              const level = LEVEL[c.level];
              const Icon = level.icon;
              return (
                <li key={c.id} className="flex items-start gap-3 py-2 text-sm">
                  <Chip tone={level.tone} className="mt-0.5 shrink-0">
                    <Icon className="size-3" aria-hidden />
                    {level.text}
                  </Chip>
                  <div className="min-w-0">
                    <span className="font-medium">{c.title}</span>
                    <span className="break-words text-slate-600 dark:text-slate-300">: {c.detail}</span>
                    {c.fix && c.level !== 'ok' && <div className="mt-0.5 text-xs text-slate-500">Как исправить: {c.fix}</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}
