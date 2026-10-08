import type { LucideIcon } from 'lucide-react';
import { Ban, Bot, CheckCheck, Circle, CircleCheck, CircleX, Code, FlaskConical, GitMerge, Hand, Hourglass, LoaderCircle, SkipForward, User } from 'lucide-react';
import type { RunStatus, StepManifest, StepStatus, StepTrigger, TriggerEvent } from '@task-pilot/step-kit';
import { cx, type Tone } from './ui.tsx';

interface StatusLook {
  label: string;
  /** Подсказка при наведении: что значит статус. */
  hint: string;
  icon: LucideIcon;
  color: string;
  tone: Tone;
  spin?: boolean;
}

/** Как показывать статус шага. */
export const STEP_LOOK: Record<StepStatus, StatusLook> = {
  pending: { label: 'ожидает', hint: 'Шаг еще не выполнялся', icon: Circle, color: 'text-slate-300 dark:text-slate-600', tone: 'slate' },
  running: { label: 'выполняется', hint: 'Шаг выполняется сейчас', icon: LoaderCircle, color: 'text-blue-600', tone: 'blue', spin: true },
  waiting_owner: { label: 'ждет вас', hint: 'Шаг ждет вашего подтверждения или ответа', icon: Hand, color: 'text-amber-500', tone: 'amber' },
  succeeded: { label: 'готово', hint: 'Шаг выполнен в этом прогоне', icon: CircleCheck, color: 'text-emerald-600', tone: 'green' },
  already: { label: 'уже сделано', hint: 'Шаг увидел, что его работа уже сделана, например задача уже в нужном статусе', icon: CheckCheck, color: 'text-emerald-600', tone: 'green' },
  simulated: { label: 'пробный прогон', hint: 'Пробный прогон: шаг только показал, что сделал бы', icon: FlaskConical, color: 'text-violet-600', tone: 'violet' },
  skipped: { label: 'пропущен', hint: 'Шаг пропущен в этом прогоне', icon: SkipForward, color: 'text-slate-400', tone: 'slate' },
  failed: { label: 'ошибка', hint: 'Шаг упал, причина под его названием. Повторите или пропустите шаг', icon: CircleX, color: 'text-red-600', tone: 'red' },
  blocked: { label: 'заблокирован', hint: 'Шагу не хватает результатов шагов выше: отметьте и выполните их или пропустите этот шаг', icon: Ban, color: 'text-orange-500', tone: 'amber' },
  waiting: { label: 'ждет события', hint: 'Шаг ждет события снаружи: сборки, деплоя, мержа PR. Наблюдатель Task Pilot продолжит прогон сам', icon: Hourglass, color: 'text-sky-500', tone: 'blue' },
};

/** Подпись и цвет статуса прогона. */
export const RUN_LOOK: Record<RunStatus, { label: string; hint: string; tone: Tone }> = {
  idle: { label: 'не запускался', hint: 'Прогон заведен, шаги еще не запускались', tone: 'slate' },
  running: { label: 'выполняется', hint: 'Шаги прогона выполняются', tone: 'blue' },
  waiting_owner: { label: 'ждет подтверждения', hint: 'Прогон ждет вашего подтверждения', tone: 'amber' },
  waiting: { label: 'ждет события', hint: 'Шаг прогона ждет события снаружи (сборки, деплоя, мержа PR): наблюдатель продолжит прогон сам', tone: 'blue' },
  paused: { label: 'на паузе', hint: 'Прогон остановлен: продолжить можно на экране прогона', tone: 'slate' },
  completed: { label: 'выполнен', hint: 'Все выбранные шаги прогона выполнены', tone: 'green' },
  failed: { label: 'ошибка', hint: 'Шаг прогона упал: прогон ждет, пока шаг повторят или пропустят', tone: 'red' },
};

/** Вид шага: кем он выполняется. */
export const KIND_LOOK: Record<StepManifest['kind'], { label: string; hint: string; icon: LucideIcon }> = {
  code: { label: 'код', hint: 'Шаг выполняет сам Task Pilot, без агента', icon: Code },
  agent: { label: 'агент', hint: 'Шаг выполняет агент Claude', icon: Bot },
  hybrid: { label: 'агент + код', hint: 'Агент готовит черновик, а публикует его Task Pilot после вашего подтверждения', icon: GitMerge },
  manual: { label: 'вручную', hint: 'Действие делаете вы сами, Task Pilot ждет результата', icon: User },
};

/** Подсказки к замку подтверждения шага. */
export const GATE_HINT: Record<'before' | 'publish', string> = {
  publish: 'Шаг меняет что-то снаружи и каждый раз сначала показывает, что сделает, и ждет вашего подтверждения',
  before: 'Шаг ждет вашего подтверждения, когда ему есть что менять',
};

/** Подсказка к плашке "фоновый": шаг идет рядом с цепочкой и ее не задерживает. */
export const BACKGROUND_HINT =
  'Фоновый шаг: запускается, когда готово все, что ему нужно, и идет рядом со следующими шагами, не задерживая их. Подтверждение у него свое, прогон закончится, когда он тоже завершится';

/** Подсказка к плашке "этап N": шаг описан в плане, но еще не реализован. */
export const stageHint = (stage: number | null) => `Шаг еще не реализован и появится на этапе ${stage} плана`;

/** Событие, по которому шаг запускается заново, для плашки "по событию". */
export const TRIGGER_LABEL: Record<TriggerEvent, string> = {
  'pr.review': 'комментарии в PR',
  'issue.changed': 'возврат задачи или новые AC',
};

/** Подсказка к плашке "по событию": кто запускает шаг, когда событие случилось. */
export const triggerHint = (trigger: StepTrigger) =>
  trigger.auto
    ? 'Шаг запускается сам, когда случится событие, а не по порядку цикла'
    : 'Когда случится событие, шаг запускаете вы с экрана прогона, а не цикл по порядку';

/** Фазы цикла. */
export const PHASE_LABEL: Record<StepManifest['phase'], string> = {
  task: 'Задача',
  code: 'Код',
  ci: 'Сборка',
  deploy: 'Деплой',
  qa: 'Тестирование',
  finish: 'Завершение',
  meta: 'Служебное',
};

/** Иконка статуса шага. */
export function StepStatusIcon({ status, className }: { status: StepStatus; className?: string }) {
  const look = STEP_LOOK[status];
  const Icon = look.icon;
  return <Icon className={cx('size-5 shrink-0', look.color, look.spin && 'animate-spin', className)} aria-label={look.label} />;
}
