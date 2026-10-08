/** Итог сборки для строки "Изменения": что сказала последняя проверка изменений. */
export interface BuildVerdict {
  label: string;
  tone: 'green' | 'red' | 'amber';
  hint: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/**
 * Итог сборки по самой поздней проверке, какая есть в контексте прогона: зеленая сборка CI текущего коммита, иначе
 * итог локальной проверки (сборка и тесты), иначе слова агента, который писал код. Отчет агента проверку не
 * заменяет, поэтому после проверки и CI он больше не показывается.
 */
export function buildVerdict(context: Obj): BuildVerdict | null {
  const build = context.build;
  const sha = context.commitSha;
  if (isObj(build) && typeof build.revision === 'string' && typeof sha === 'string' && sha && (build.revision.startsWith(sha) || sha.startsWith(build.revision))) {
    return { label: 'CI: сборка прошла', tone: 'green', hint: `Bamboo собрал коммит ${sha.slice(0, 8)}${typeof build.key === 'string' ? `: ${build.key}` : ''}` };
  }
  const report = context.testReport;
  if (isObj(report) && typeof report.tests === 'number') {
    const failed = num(report.failures) + num(report.errors);
    return failed
      ? { label: `проверка: упало ${failed}`, tone: 'red', hint: `Последняя локальная сборка: тестов ${report.tests}, упало ${failed}` }
      : { label: 'проверка: сборка зеленая', tone: 'green', hint: `Последняя локальная сборка: тестов ${report.tests}, все прошли` };
  }
  const changes = context.changes;
  if (isObj(changes) && typeof changes.buildGreen === 'boolean') {
    return changes.buildGreen
      ? { label: 'агент: сборка зеленая', tone: 'green', hint: 'Так сообщил агент, который писал код; шаг проверки соберет и проверит сам' }
      : { label: 'агент: сборка не зеленая', tone: 'amber', hint: 'Так сообщил агент, который писал код; шаг проверки разберет и исправит сборку' };
  }
  return null;
}
