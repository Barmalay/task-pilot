import { useMutation, useQuery } from '@tanstack/react-query';
import { Lock, Sparkles, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api.ts';
import { go } from '../router.ts';
import { GATE_HINT, KIND_LOOK, PHASE_LABEL, stageHint, TRIGGER_LABEL, triggerHint } from '../status.tsx';
import { Button, Card, Chip, ErrorBox, Loading, PageHeader, Tip } from '../ui.tsx';

/**
 * Мастер "Новый шаг": шаг описывается словами, Claude пишет папку шага с тестом, Task Pilot проверяет ее на копии,
 * а в каталог она попадает после вашего подтверждения. Работа идет отдельным прогоном PILOT-<n>, на него экран и переходит.
 */
function NewStepCard({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const start = useMutation({ mutationFn: () => api.draftStep(text), onSuccess: ({ id }) => go(`/runs/${id}`) });
  return (
    <Card className="p-4">
      <h2 className="flex items-center gap-2 font-semibold">
        <Wand2 className="size-4 text-violet-600" aria-hidden />
        Новый шаг
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        Опишите, что шаг делает, когда запускается, что ему нужно и что он дает следующим шагам, какие внешние действия делает и что показывает на подтверждении. Claude напишет манифест, код, промпт и тест, Task Pilot проверит их тестами на копии, а в каталог шаг попадет после вашего подтверждения
      </p>
      <textarea
        className="mt-3 h-32 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        value={text}
        placeholder="Например: после мержа пишет в Jira комментарий со ссылкой на PR и сборку, текст на подтверждении"
        onChange={(e) => setText(e.target.value)}
      />
      {start.error && <ErrorBox title="Не удалось начать" error={start.error} />}
      <div className="mt-2 flex gap-2">
        <Button icon={Sparkles} spin={start.isPending} disabled={!text.trim() || start.isPending} onClick={() => start.mutate()}>
          Написать шаг
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Отмена
        </Button>
      </div>
    </Card>
  );
}

/** Экран "Каталог шагов": все шаги цикла по фазам, пресеты и ошибки загрузки. */
export function CatalogPage() {
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: api.catalog });
  const [wizard, setWizard] = useState(false);
  if (catalog.isLoading) return <Loading text="Загружаю каталог" />;
  if (catalog.error || !catalog.data) return <ErrorBox error={catalog.error ?? 'нет данных'} />;
  const { presets, errors } = catalog.data;
  // Шаги идут в порядке полного цикла; шаги вне него (по событию, служебные) - в конце фазы.
  const cycle = presets.find((p) => p.id === 'full')?.steps ?? [];
  const rank = (id: string) => (cycle.includes(id) ? cycle.indexOf(id) : cycle.length);
  const steps = [...catalog.data.steps].sort((a, b) => rank(a.id) - rank(b.id));
  const title = new Map(steps.map((s) => [s.id, s.title]));
  const ready = steps.filter((s) => s.implemented).length;

  return (
    <section className="space-y-6">
      <PageHeader
        title="Каталог шагов"
        help='Все шаги цикла по фазам и пресеты, из которых начинается прогон. Новый шаг - это папка steps/<id> с step.yaml и index.ts; каталог подхватывает правки без перезапуска, а кнопка "Новый шаг" просит Claude написать его по описанию'
        actions={
          !wizard && (
            <Button variant="secondary" icon={Wand2} onClick={() => setWizard(true)} title="Описать шаг словами: Claude напишет его с тестом, в каталог он попадет после вашего подтверждения">
              Новый шаг
            </Button>
          )
        }
      >
        Готово шагов: {ready} из {steps.length}
      </PageHeader>
      {wizard && <NewStepCard onClose={() => setWizard(false)} />}

      {errors.length > 0 && (
        <ErrorBox title={`Ошибки в файлах каталога: ${errors.length}`} error={errors.map((e) => `${e.file}: ${e.message}`).join('\n')} />
      )}

      {(Object.keys(PHASE_LABEL) as (keyof typeof PHASE_LABEL)[]).map((phase) => {
        const list = steps.filter((s) => s.phase === phase);
        if (!list.length) return null;
        return (
          <Card key={phase}>
            <h2 className="border-b border-slate-100 px-4 py-3 font-semibold dark:border-slate-800">{PHASE_LABEL[phase]}</h2>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {list.map((s) => {
                const kind = KIND_LOOK[s.kind];
                const KindIcon = kind.icon;
                return (
                  <li key={s.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{s.title}</span>
                        <span className="font-mono text-xs text-slate-400">{s.id}</span>
                        {s.implemented ? (
                          <Tip text="Шаг реализован и доступен в прогонах">
                            <Chip tone="green">готов</Chip>
                          </Tip>
                        ) : (
                          <Tip text={stageHint(s.stage)}>
                            <Chip>этап {s.stage}</Chip>
                          </Tip>
                        )}
                        {s.trigger && (
                          <Tip text={triggerHint(s.trigger)}>
                            <Chip tone="violet">по событию: {TRIGGER_LABEL[s.trigger.event]}</Chip>
                          </Tip>
                        )}
                      </div>
                      <p className="mt-0.5 text-sm text-slate-500">{s.hint}</p>
                      {(s.requires.length > 0 || s.provides.length > 0) && (
                        <p className="mt-1 text-xs text-slate-400">
                          {s.requires.length > 0 && <>нужно: {s.requires.join(', ')}. </>}
                          {s.provides.length > 0 && <>дает: {s.provides.join(', ')}</>}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500">
                      <Tip text={kind.hint}>
                        <span className="inline-flex items-center gap-1">
                          <KindIcon className="size-3.5" aria-hidden />
                          {kind.label}
                        </span>
                      </Tip>
                      {s.gate !== 'none' && (
                        <Tip text={GATE_HINT[s.gate]}>
                          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                            <Lock className="size-3.5" aria-hidden />
                            {s.gate === 'publish' ? 'подтверждение всегда' : 'подтверждение'}
                          </span>
                        </Tip>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}

      <Card>
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h2 className="font-semibold">Пресеты</h2>
          <a href="#/presets" className="text-sm text-blue-700 hover:underline dark:text-blue-400">
            Изменить
          </a>
        </div>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {presets.map((p) => (
            <li key={p.id} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.title}</span>
                <span className="font-mono text-xs text-slate-400">{p.id}</span>
              </div>
              <p className="text-sm text-slate-500">{p.hint}</p>
              <p className="mt-1 text-xs text-slate-500">{p.steps.map((id) => (p.off.includes(id) ? `(${title.get(id)})` : title.get(id))).join(' → ')}</p>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
