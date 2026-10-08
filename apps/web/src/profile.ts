import type { DoctorCheckDto, ProfileDto, RunDto } from '@task-pilot/api-types';
import type { Look } from './integrations.ts';

/** Личный стиль текстов словами: какие правки линтер делает сам. */
export function styleText(style: ProfileDto['personal']['style']): string {
  const parts = [style.yo && 'е без точек', style.dash && 'дефис вместо длинного тире', style.quotes && 'прямые кавычки'].filter((p): p is string => !!p);
  return parts.length ? parts.join(', ') : 'без личного стиля';
}

const ORDER: Look[] = ['fail', 'warn', 'wait', 'ok'];

/** Худшее из состояний: по нему точка на кнопке профиля показывает, что с аккаунтами. */
export function worstLook(looks: Look[]): Look {
  return ORDER.find((l) => looks.includes(l)) ?? 'ok';
}

/** Буквы в кружке профиля: из логина (i.petrov - IP), без логина - из названия команды. */
export function initials(login: string, team: string): string {
  const source = login.trim() || team.trim();
  const parts = source.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/** Последние прогоны для панели: по времени последнего изменения, новые первыми. */
export function recentRuns(runs: RunDto[], count = 6): RunDto[] {
  return [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, count);
}

/** Пример ключа для поля "Открыть задачу": проект последнего прогона задачи, пока прогонов нет - просто KEY. */
export function exampleKey(runs: RunDto[] | undefined): string {
  const key = runs?.map((r) => r.issueKey).find((k) => !k.startsWith('PILOT-'));
  return `${key?.replace(/-\d+$/, '') ?? 'KEY'}-1234`;
}

/** Сводка проверки окружения для панели: сколько проблем и предупреждений и какие это проверки. */
export function doctorSummary(checks: DoctorCheckDto[]): { fail: number; warn: number; issues: DoctorCheckDto[] } {
  const issues = checks.filter((c) => c.level !== 'ok').sort((a, b) => Number(b.level === 'fail') - Number(a.level === 'fail'));
  return { fail: issues.filter((c) => c.level === 'fail').length, warn: issues.filter((c) => c.level === 'warn').length, issues };
}

/** Сводка окружения словами: сколько проблем и предупреждений; пустая строка - все в порядке. */
export function doctorText(s: { fail: number; warn: number }): string {
  const text = [s.fail && `проблем: ${s.fail}`, s.warn && `предупреждений: ${s.warn}`].filter((p): p is string => !!p).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
