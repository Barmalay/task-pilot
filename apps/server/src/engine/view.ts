import type { StepManifest, StepSetting, StepSigns } from '@task-pilot/step-kit';
import type { AgentStats, ApprovalRow, QuestionRow, RunRow, RunStepRow } from '../store/db.ts';

/** Шаг прогона вместе с описанием и признаками из каталога. */
export interface StepView extends RunStepRow, StepSigns {
  title: string;
  hint: string;
  phase: StepManifest['phase'];
  kind: StepManifest['kind'];
  gate: StepManifest['gate'];
  implemented: boolean;
  stage: number | null;
  /** Шаг готовит черновик и умеет переделывать его по замечанию владельца. */
  canRework: boolean;
  agent: AgentStats | null;
  /** Настройки шага из манифеста: варианты, умолчание пресета и что выбрано в прогоне. */
  settings: StepSetting[];
}

/** Ожидающее решения подтверждение; blocked - линтер не дает его одобрить. */
export type PendingApproval = Pick<ApprovalRow, 'id' | 'stepId' | 'preview' | 'createdAt'> & { blocked: boolean };

/** Полное состояние прогона для интерфейса. */
export interface RunView {
  run: RunRow;
  steps: StepView[];
  context: Record<string, unknown>;
  /** Первое из ожидающих подтверждений: его показывает главная кнопка экрана. */
  approval: PendingApproval | null;
  /** Все ожидающие подтверждения: шага цепочки и фоновых шагов, от ранних к поздним. */
  approvals: PendingApproval[];
  /** Открытые вопросы агентов. */
  questions: QuestionRow[];
  active: boolean;
}
