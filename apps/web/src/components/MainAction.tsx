import { CheckCheck, FolderGit2, Hand, Hourglass, LoaderCircle, MessageCircleQuestion, Play, TriangleAlert } from 'lucide-react';
import type { RepoChoice, StepStatus, WaitEvent } from '@task-pilot/step-kit';
import type { RunViewDto, StepDto } from '@task-pilot/api-types';
import { Button } from '../ui.tsx';
import { waitWords } from '../waiting.ts';

/**
 * Статусы, с которых прогон продолжается запуском. Заблокированный шаг движок проверит заново, ждущий события
 * продолжит, а шаг, который ждет подтверждения без открытого запроса (например, после перезапуска сервера),
 * выполнится по уже данному одобрению или попросит его снова.
 */
const RESUMABLE: StepStatus[] = ['pending', 'blocked', 'waiting_owner', 'waiting'];

/** Фоновый шаг, который упал или отклонен: запуск его не продолжит, и цепочку он не держит. */
const parked = (s: StepDto) => s.background && (s.status === 'failed' || s.status === 'blocked');

/** Главная кнопка экрана: всегда показывает следующее действие. */
export function MainAction({
  view,
  onStart,
  onOpenGate,
  onAnswer,
  busy,
}: {
  view: RunViewDto;
  onStart: () => void;
  onOpenGate: () => void;
  onAnswer: () => void;
  busy: boolean;
}) {
  const running = view.active || view.run.status === 'running';
  const selected = view.steps.filter((s) => s.selected);
  const resumable = selected.filter((s) => RESUMABLE.includes(s.status) && !parked(s));
  const next = resumable[0];
  // О фоновом шаге, который сам не продолжится, кнопка говорит, когда цепочке больше нечего делать.
  const stuck = selected.find((s) => s.status === 'failed' && !s.background) ?? (next ? undefined : selected.find(parked));
  if (view.approval) {
    // Подтверждений бывает несколько (шаг цепочки и фоновые шаги): кнопка открывает первое, остальные - строки шагов.
    const more = view.approvals.length - 1;
    const hint = 'Открыть подтверждение: что шаг сделает, и кнопки Подтвердить, Переделать и Отклонить';
    return (
      <Button variant="warning" size="lg" icon={Hand} onClick={onOpenGate} title={more > 0 ? `${hint}. Еще подтверждений: ${more}, они открываются из строк своих шагов` : hint}>
        Подтвердить: {view.approval.preview.title}
        {more > 0 && ` (+${more})`}
      </Button>
    );
  }
  if (view.questions.length) {
    return (
      <Button variant="warning" size="lg" icon={MessageCircleQuestion} onClick={onAnswer} title="Агент ждет вашего ответа: перейти к карточке вопроса">
        Ответить агенту{view.questions.length > 1 ? ` (${view.questions.length})` : ''}
      </Button>
    );
  }
  if (running) {
    return (
      <Button size="lg" icon={LoaderCircle} spin disabled title="Шаги выполняются. Прервать можно кнопкой Остановить">
        Выполняется
      </Button>
    );
  }
  if (stuck && (!next || stuck.position < next.position)) {
    return (
      <Button
        size="lg"
        icon={TriangleAlert}
        disabled
        title={stuck.status === 'blocked' ? 'Фоновый шаг отклонен и сам не запустится: в его строке нажмите Повторить или Пропустить' : 'Прогон остановился на упавшем шаге: в его строке нажмите Повторить или Пропустить'}
      >
        Сначала повторите или пропустите шаг "{stuck.title}"
      </Button>
    );
  }
  if (next && (view.context.repoChoice as RepoChoice | null | undefined)?.unsure) {
    return (
      <Button size="lg" icon={FolderGit2} disabled title="Задача не подсказала репозиторий: выберите его в списке Репозиторий или оставьте выбранный кнопкой рядом с подсказкой">
        Сначала выберите репозиторий
      </Button>
    );
  }
  // Шаг ждет события снаружи (сборка, деплой, мерж PR): прогон продолжит наблюдатель, а кнопка проверяет сразу.
  const waiting = view.context.waiting as { stepId?: string; event?: WaitEvent } | undefined;
  if (next && next.status === 'waiting') {
    return (
      <Button
        size="lg"
        variant="secondary"
        icon={Hourglass}
        disabled={busy}
        onClick={onStart}
        title="Шаг ждет события снаружи. Наблюдатель Task Pilot сам проверяет его и продолжит прогон, кнопка проверит сейчас"
      >
        {waiting?.stepId === next.stepId && waiting.event ? `Жду ${waitWords(waiting.event).what}: проверить сейчас` : `${next.title} ждет события: проверить сейчас`}
      </Button>
    );
  }
  if (next) {
    const count = resumable.length;
    return (
      <Button
        size="lg"
        icon={Play}
        disabled={busy}
        onClick={onStart}
        title={
          next.status === 'waiting_owner'
            ? 'Продолжить с шага, который ждет вас'
            : 'Выполнить отмеченные шаги по порядку. Шаг с подтверждением остановится и спросит вас, внешние действия без вашего клика не выполняются'
        }
      >
        {next.status === 'waiting_owner' ? `Продолжить: ${next.title}` : `Запустить выбранные шаги (${count})`}
      </Button>
    );
  }
  return (
    <Button size="lg" icon={CheckCheck} disabled title={selected.length ? 'Отмеченные шаги выполнены. Отметьте другие шаги или начните новый прогон' : 'Отметьте в списке ниже шаги, которые нужно выполнить'}>
      {selected.length ? 'Все выбранные шаги выполнены' : 'Отметьте шаги для запуска'}
    </Button>
  );
}
