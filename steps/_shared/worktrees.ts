/** Разбирает вывод git worktree list --porcelain. */
export function parseWorktrees(out: string): { path: string; branch: string | null }[] {
  const list: { path: string; branch: string | null }[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) list.push({ path: line.slice('worktree '.length), branch: null });
    else if (line.startsWith('branch ') && list.length) list[list.length - 1]!.branch = line.slice('branch '.length);
  }
  return list;
}
