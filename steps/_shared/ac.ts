import type { Plan, StepContext } from '../../packages/step-kit/src/index.ts';
import { extractAcceptanceCriteria, renderTemplate } from '../../packages/step-kit/src/index.ts';
import { readText } from './agent.ts';

/** Критерии приемки, по которым работает прогон, и откуда они взяты. */
export interface RunAc {
  /** null - критериев нет ни в описании задачи, ни в плане; пустой список - у задачи метка skip_ac. */
  items: string[] | null;
  /** Файл плана, если критерии взяты из его раздела: в описании задачи их нет. */
  planFile: string | null;
}

/**
 * Критерии приемки прогона: из описания задачи в Jira, а если их там нет - утвержденные с планом. jira - критерии
 * описания, когда шаг перечитал задачу сам; по умолчанию они берутся из контекста.
 */
export function acOf(c: Pick<StepContext, 'get'>, jira: string[] | null | undefined = c.get<string[] | null>('ac')): RunAc {
  if (jira) return { items: jira, planFile: null };
  const plan = c.get<Plan>('plan');
  return plan?.ac?.length ? { items: plan.ac, planFile: plan.file } : { items: null, planFile: null };
}

/** Критерии приемки нумерованным списком для промпта; у критериев из плана сказано, откуда они. */
export function acText(ac: RunAc): string {
  if (ac.items === null) return 'в описании не найдены';
  if (!ac.items.length) return 'нет, у задачи метка skip_ac';
  const list = ac.items.map((a, i) => `${i + 1}. ${a}`).join('\n');
  return ac.planFile ? `в описании задачи их нет, список утвержден с планом (раздел "Критерии приемки" в ${ac.planFile}):\n${list}` : list;
}

/** Критерии приемки из раздела плана, если в описании задачи их нет; undefined - они в описании или раздела в плане нет. */
export function planAcOf(plan: string, jira: string[] | null | undefined): string[] | undefined {
  return jira ? undefined : (extractAcceptanceCriteria(plan) ?? undefined);
}

/**
 * Задание агенту, который пишет план, про раздел критериев приемки: зафиксировать критерии в плане, если в описании
 * задачи их нет (docs - папка доков задачи, где их можно найти), или убрать раздел из плана, если критерии появились
 * в описании. Пустая строка - делать ничего не нужно, в том числе у задачи с меткой skip_ac.
 */
export function acPlanTask(jira: string[] | null | undefined, docs: string, planHasAc = false): string {
  if (!jira) return renderTemplate(readText(import.meta.url, './ac-plan.md'), { docs }).trim();
  return jira.length && planHasAc ? readText(import.meta.url, './ac-jira.md').trim() : '';
}

/** Что показать на подтверждении плана о его критериях приемки: откуда они и чего не хватает. */
export function planAcPreview(plan: string, jira: string[] | null | undefined): { actions: string[]; warnings: string[] } {
  const ac = planAcOf(plan, jira);
  if (ac) return { actions: [`Критерии приемки из раздела плана (${ac.length}): по ним пойдут реализация, тест на стенде и итоги в Jira, в описании задачи их нет`], warnings: [] };
  if (jira) return { actions: [], warnings: [] };
  return {
    actions: [],
    warnings: ['В описании задачи нет критериев приемки, а в плане нет раздела "Критерии приемки": следующим шагам не с чем сверять работу. "Переделать" с замечанием попросит агента их составить'],
  };
}
