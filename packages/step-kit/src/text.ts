/** Подставляет ключ задачи в шаблон вида feature/{KEY} или .claude/{KEY}. */
export function fillKey(template: string, issueKey: string): string {
  return template.replaceAll('{KEY}', issueKey);
}

/** Имя ветки задачи по шаблону профиля репозитория. */
export function branchFor(pattern: string, issueKey: string): string {
  return fillKey(pattern, issueKey);
}

/**
 * Ветка задачи среди веток remote. Create branch в Jira называет ее по типу (feature/, bugfix/, hotfix/)
 * или просто ключом задачи, иногда с описанием через дефис. Имя по шаблону профиля берется первым,
 * иначе единственная подходящая ветка; служебные ветки вроде deploy/... не подходят.
 */
export function pickBranch(heads: string[], key: string, pattern: string): { branch: string | null; candidates: string[] } {
  const exact = branchFor(pattern, key);
  if (heads.includes(exact)) return { branch: exact, candidates: [exact] };
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = new RegExp(`^(?:(?:feature|bugfix|hotfix)/)?${escaped}(?:-[^/]+)?$`);
  const candidates = heads.filter((h) => matches.test(h)).sort();
  return { branch: candidates.length === 1 ? candidates[0]! : null, candidates };
}

/** Имена веток из вывода git ls-remote --heads, без refs/heads/. */
export function headsOf(lsRemote: string): string[] {
  return lsRemote
    .split('\n')
    .map((l) => l.split('\t')[1]?.trim() ?? '')
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length));
}

/** Ключ задачи Jira вида TEAM-2799. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
