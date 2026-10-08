import { useMutation, useQuery } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { exampleKey } from '../profile.ts';
import { go } from '../router.ts';
import { Tip } from '../ui.tsx';

/** Нажатие клавиши пришло из поля ввода: тогда / - это просто символ. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');
}

/**
 * Поле "Открыть задачу" в шапке: ключ задачи с любого экрана, даже если задачи нет на доске. Открытие ничего не
 * запускает, а ведет в прогон задачи. Клавиша / ставит курсор в поле, ошибка открытия видна под ним, пока ключ не
 * поменяли.
 */
export function OpenTask() {
  const [key, setKey] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const runs = useQuery({ queryKey: ['runs', 'recent'], queryFn: api.recentRuns, staleTime: 60_000 });
  const open = useMutation({
    mutationFn: (issueKey: string) => api.openTask(issueKey),
    onSuccess: (r) => {
      setKey('');
      input.current?.blur();
      go(`/runs/${r.id}`);
    },
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const example = exampleKey(runs.data);
  return (
    <form
      className="relative hidden lg:block"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) open.mutate(key.trim());
      }}
    >
      <Tip text={`Открыть задачу по ключу, например ${example}, даже если ее нет на доске: открытие ничего не запускает. Клавиша / ставит сюда курсор, Enter открывает`}>
        <label className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 dark:border-slate-700 dark:bg-slate-900">
          <FolderOpen className="size-3.5 shrink-0 text-slate-400" aria-hidden />
          <input
            ref={input}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              if (open.isError) open.reset();
            }}
            placeholder={example}
            aria-label="Открыть задачу по ключу"
            disabled={open.isPending}
            className="w-24 bg-transparent font-mono text-sm outline-none placeholder:text-slate-400 xl:w-28"
          />
          <kbd className="hidden rounded border border-slate-200 px-1 font-sans text-[10px] leading-4 text-slate-400 2xl:inline dark:border-slate-700">/</kbd>
        </label>
      </Tip>
      {open.error && (
        <div role="alert" className="absolute top-full left-0 z-30 mt-2 w-72 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800 shadow-lg dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Не удалось открыть задачу: {open.error.message}
        </div>
      )}
    </form>
  );
}
