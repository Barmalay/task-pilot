import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, CircleDashed, ExternalLink, KeyRound, LoaderCircle, LogIn, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { ClaudeLoginDto, IntegrationAccountDto, IntegrationDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { DOT } from '../components/BudgetBadge.tsx';
import { activeOf, checkShown, hostOf, loginInProgress, whoOf, withIntegration } from '../integrations.ts';
import type { Tone } from '../ui.tsx';
import { Button, Card, Chip, cx, ErrorBox, Loading, PageHeader, Tip } from '../ui.tsx';

const LOOK_TONE: Record<ReturnType<typeof checkShown>['look'], Tone> = { ok: 'green', warn: 'amber', fail: 'red', wait: 'slate' };
const LOOK_ICON = { ok: CircleCheck, warn: CircleAlert, fail: CircleAlert, wait: CircleDashed } as const;

const INPUT = 'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900';

/** Кэш экрана и шапки после изменения: список получает ответ сервера, шапка и доска перечитываются. */
function useApply() {
  const qc = useQueryClient();
  return (next: IntegrationDto) => {
    qc.setQueryData(['integrations'], (old: Parameters<typeof withIntegration>[0]) => withIntegration(old, next));
    void qc.invalidateQueries({ queryKey: ['account'] });
    // Под другим аккаунтом Jira у доски другие "мои" задачи.
    if (next.kind === 'jira') {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['sprints'] });
    }
  };
}

function CheckChip({ account, checking }: { account: IntegrationAccountDto; checking: boolean }) {
  if (checking) {
    return (
      <Chip tone="slate">
        <LoaderCircle className="size-3 animate-spin" aria-hidden />
        проверяю
      </Chip>
    );
  }
  const shown = checkShown(account.check);
  const Icon = LOOK_ICON[shown.look];
  return (
    <Tip text={shown.title}>
      <Chip tone={LOOK_TONE[shown.look]}>
        <Icon className="size-3" aria-hidden />
        {shown.text}
      </Chip>
    </Tip>
  );
}

function AccountRow({ i, a, secrets, checking, busy, onSelect }: { i: IntegrationDto; a: IntegrationAccountDto; secrets: string; checking: boolean; busy: boolean; onSelect: () => void }) {
  const apply = useApply();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({ mutationFn: () => api.removeAccount(i.id, a.id!), onSuccess: apply });
  const who = whoOf(i.kind, a.check);
  const selectable = a.kind !== 'none';
  const inputId = `account-${i.id}-${a.id ?? 'default'}`;
  return (
    <div className={cx('flex items-start gap-3 rounded-lg border p-2.5', a.active ? 'border-blue-300 bg-blue-50/60 dark:border-blue-800 dark:bg-blue-950/30' : 'border-slate-200 dark:border-slate-800')}>
      {selectable && (
        <input
          id={inputId}
          type="radio"
          name={`account-${i.id}`}
          checked={a.active}
          disabled={busy}
          onChange={onSelect}
          className="mt-1 size-4 accent-blue-600"
          aria-describedby={`${inputId}-source`}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={selectable ? inputId : undefined} className={cx('font-medium', selectable && 'cursor-pointer')}>
            {a.label}
          </label>
          {a.active && selectable && <Chip tone="blue">активный</Chip>}
          <CheckChip account={a} checking={checking} />
        </div>
        {who && <div className="mt-0.5 text-sm text-slate-700 dark:text-slate-200">{who}</div>}
        <div id={`${inputId}-source`} className="mt-0.5 break-words text-xs text-slate-500">
          {a.source}
        </div>
        {a.check && !a.check.ok && a.check.error && <div className="mt-1 break-words text-xs text-red-700 dark:text-red-300">{a.check.error}</div>}
        {remove.error && <div className="mt-1 text-xs text-red-700 dark:text-red-300">{remove.error.message}</div>}
      </div>
      {a.id !== null &&
        (confirm ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="danger" size="sm" spin={remove.isPending} icon={remove.isPending ? LoaderCircle : Trash2} disabled={remove.isPending} onClick={() => remove.mutate()}>
              Удалить
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
              Нет
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            icon={Trash2}
            disabled={busy}
            onClick={() => setConfirm(true)}
            title={a.kind === 'login' ? 'Удалить аккаунт: выйти из него и удалить его папку' : `Удалить аккаунт: токен уйдет из ${secrets}`}
            aria-label={`Удалить аккаунт ${a.label}`}
          />
        ))}
    </div>
  );
}

function TokenForm({ i, secrets, onDone }: { i: IntegrationDto; secrets: string; onDone: () => void }) {
  const apply = useApply();
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const add = useMutation({
    mutationFn: () => api.addToken(i.id, token, label.trim() || undefined),
    onSuccess: (next) => {
      apply(next);
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  const check = i.kind === 'claude' ? 'коротким запуском claude -p на haiku (доли цента)' : `запросом к ${i.title} "кто я"`;
  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Токен</span>
        <input type="password" required autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} className={cx(INPUT, 'font-mono')} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Подпись, если нужна</span>
        <input type="text" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={i.kind === 'claude' ? 'например, личный Max' : 'например, технический'} className={INPUT} />
      </label>
      <p className="text-xs text-slate-500">
        {i.tokenHelp}. Токен проверяется {check}, хранится в {secrets} и сразу становится активным.
      </p>
      {add.error && <ErrorBox error={add.error} title="Токен не сохранен" />}
      <div className="flex gap-2">
        <Button type="submit" size="sm" icon={add.isPending ? LoaderCircle : ShieldCheck} spin={add.isPending} disabled={add.isPending || !token.trim()}>
          Проверить и сохранить
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

function LoginForm({ onDone }: { onDone: () => void }) {
  const apply = useApply();
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');
  const start = useMutation({
    mutationFn: () => api.claudeLogin({ ...(email.trim() ? { email: email.trim() } : {}), ...(label.trim() ? { label: label.trim() } : {}) }),
    onSuccess: (next) => {
      apply(next);
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    start.mutate();
  };
  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Почта аккаунта, если нужна</span>
        <input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="подставится на странице входа" className={INPUT} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Подпись, если нужна</span>
        <input type="text" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="например, личный Max" className={INPUT} />
      </label>
      <p className="text-xs text-slate-500">
        Task Pilot запустит claude auth login в отдельной папке аккаунта и откроет браузер: войдите нужным аккаунтом. Ваш вход CLI и сессии в терминале не
        меняются, а скиллы, CLAUDE.md и настройки у агентов остаются те же.
      </p>
      {start.error && <ErrorBox error={start.error} title="Вход не запущен" />}
      <div className="flex gap-2">
        <Button type="submit" size="sm" icon={start.isPending ? LoaderCircle : LogIn} spin={start.isPending} disabled={start.isPending}>
          Открыть вход
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

function LoginRow({ login }: { login: ClaudeLoginDto }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['integrations'] });
  const send = useMutation({ mutationFn: () => api.claudeLoginCode(login.id, code.trim()), onSuccess: () => (setCode(''), refresh()) });
  const cancel = useMutation({ mutationFn: () => api.cancelClaudeLogin(login.id), onSuccess: refresh });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };
  if (login.state === 'failed') {
    return (
      <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 break-words">Вход через браузер не удался: {login.error}</div>
        <Button variant="ghost" size="sm" icon={X} onClick={() => cancel.mutate()} aria-label="Убрать сообщение" title="Убрать сообщение" />
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/40">
      <div className="flex items-start gap-2">
        <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-blue-600" aria-hidden />
        <div className="min-w-0 flex-1">
          {login.state === 'checking' ? (
            'Вход закончен, проверяю аккаунт'
          ) : (
            <>
              Открыт браузер: войдите нужным аккаунтом Claude{login.label ? ` (${login.label})` : ''}. Если браузер не открылся или страница входа показала код,{' '}
              {login.url ? (
                <a href={login.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-blue-700 underline dark:text-blue-300">
                  откройте ее здесь
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : (
                'откройте ссылку из вывода claude'
              )}{' '}
              и вставьте код ниже.
            </>
          )}
        </div>
      </div>
      {login.state === 'waiting' && (
        <form onSubmit={submit} className="mt-2 flex flex-wrap gap-2">
          <label className="sr-only" htmlFor={`code-${login.id}`}>
            Код со страницы входа
          </label>
          <input
            id={`code-${login.id}`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Код со страницы входа"
            className={cx(INPUT, 'max-w-xs flex-1 font-mono')}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!code.trim() || send.isPending} spin={send.isPending} icon={send.isPending ? LoaderCircle : undefined}>
            Отправить код
          </Button>
          <Button variant="ghost" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Отменить вход
          </Button>
        </form>
      )}
      {(send.error ?? cancel.error) && <div className="mt-1 text-xs text-red-700 dark:text-red-300">{(send.error ?? cancel.error)!.message}</div>}
    </div>
  );
}

function IntegrationCard({ i, secrets }: { i: IntegrationDto; secrets: string }) {
  const apply = useApply();
  const [form, setForm] = useState<'token' | 'login' | null>(null);
  const check = useMutation({ mutationFn: () => api.checkIntegration(i.id), onSuccess: apply });
  const activate = useMutation({ mutationFn: (account: string | null) => api.activateAccount(i.id, account), onSuccess: apply });
  const active = activeOf(i);
  const shown = checkShown(active.check);
  const busy = activate.isPending || check.isPending;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Tip text={`Активный аккаунт: ${shown.text}`}>
              <span className={cx('size-2.5 shrink-0 rounded-full', DOT[shown.look])} aria-hidden />
            </Tip>
            <h2 className="font-semibold">{i.title}</h2>
          </div>
          {i.url && (
            <Tip text={`Открыть ${i.title} в новой вкладке`}>
              <a href={i.url} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 font-mono text-xs text-slate-500 hover:text-blue-600">
                {hostOf(i.url)}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            </Tip>
          )}
        </div>
        <Button variant="ghost" size="sm" icon={RefreshCw} spin={check.isPending} disabled={busy} onClick={() => check.mutate()} title="Проверить все аккаунты заново: система ответит, кто владелец доступа">
          Проверить
        </Button>
      </div>
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
        <span className="text-slate-500">Нужна для:</span> {i.usedBy}
      </p>
      {i.note && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{i.note}</p>}
      <fieldset className="mt-3 space-y-2">
        <legend className="sr-only">Аккаунт {i.title}</legend>
        {i.accounts.map((a) => (
          <AccountRow key={a.id ?? 'default'} i={i} a={a} secrets={secrets} checking={check.isPending} busy={busy} onSelect={() => activate.mutate(a.id)} />
        ))}
      </fieldset>
      {(activate.error ?? check.error) && <div className="mt-2 text-xs text-red-700 dark:text-red-300">{(activate.error ?? check.error)!.message}</div>}
      {i.logins.map((l) => (
        <LoginRow key={l.id} login={l} />
      ))}
      {form === 'token' && <TokenForm i={i} secrets={secrets} onDone={() => setForm(null)} />}
      {form === 'login' && <LoginForm onDone={() => setForm(null)} />}
      {form === null && (i.canToken || i.canLogin) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {i.canLogin && (
            <Button variant="secondary" size="sm" icon={LogIn} onClick={() => setForm('login')} title="Войти в другой аккаунт Claude через браузер: у него будет своя папка входа">
              Войти через браузер
            </Button>
          )}
          {i.canToken && (
            <Button variant="secondary" size="sm" icon={KeyRound} onClick={() => setForm('token')} title={`${i.tokenHelp}: Task Pilot проверит токен и сохранит его в ${secrets}`}>
              Добавить токен
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/** Экран "Интеграции": откуда берется доступ к каждой системе, под чьим аккаунтом Task Pilot туда ходит и смена аккаунта. */
export function IntegrationsPage() {
  const list = useQuery({
    queryKey: ['integrations'],
    queryFn: api.integrations,
    staleTime: 60_000,
    // Пока идет вход в Claude через браузер, экран спрашивает сервер чаще: вход заканчивается в браузере.
    refetchInterval: (q) => (loginInProgress(q.state.data) ? 2000 : false),
  });
  return (
    <section>
      <PageHeader
        className="mb-4"
        title="Интеграции"
        help={`Под какими аккаунтами Task Pilot ходит во внешние системы. Как обычно доступ берется из настроек Claude Code: MCP-серверов в ~/.claude.json и входа CLI claude. Токен, заведенный здесь, их заменяет${list.data ? ` и хранится в ${list.data.secrets}` : ''}. Смена действует сразу: следующие запросы и новые запуски агентов идут под новым аккаунтом, а агент, который уже работает, доделывает шаг под прежним`}
        actions={
          <Button variant="ghost" icon={RefreshCw} spin={list.isFetching} onClick={() => void list.refetch()} title="Перечитать экран: проверки младше 5 минут берутся из памяти">
            Обновить
          </Button>
        }
      />
      {list.isLoading && <Loading text="Спрашиваю системы, кто владелец доступа" />}
      {list.error && <ErrorBox error={list.error} title="Не удалось прочитать интеграции" />}
      {list.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          {list.data.integrations.map((i) => (
            <IntegrationCard key={i.id} i={i} secrets={list.data.secrets} />
          ))}
        </div>
      )}
    </section>
  );
}
