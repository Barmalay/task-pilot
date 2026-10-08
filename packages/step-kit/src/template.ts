/**
 * Подстановка значений в шаблон промпта вида "Задача {{key}}: {{summary}}".
 * Неизвестная переменная - ошибка: опечатка в prompt.md видна сразу, а не пустым местом в промпте.
 */
export function renderTemplate(template: string, vars: Record<string, string | number | boolean | null | undefined>): string {
  const missing = new Set<string>();
  const out = template.replace(/\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g, (_m, name: string) => {
    if (!(name in vars)) {
      missing.add(name);
      return '';
    }
    const value = vars[name];
    return value === null || value === undefined ? '' : String(value);
  });
  if (missing.size) throw new Error(`В шаблоне неизвестные переменные: ${[...missing].join(', ')}`);
  return out;
}
