import { join } from 'node:path';
import type { DashboardDataDto, FeatureStatsDto, MonitorEditDto, MonitorEditsDto, MonitorVersionDto } from '@task-pilot/api-types';
import { maskPhones, parseMonitorTarget, targetKey, type Dashboard, type FeatureProfile, type MonitorPort, type MonitorServiceProfile, type MonitorTarget } from '@task-pilot/step-kit';
import { PIPELINE_TOOLS } from '../agent/policy.ts';
import type { AgentService } from '../agent/service.ts';
import type { Redactor } from '../lib/redact.ts';
import type { MonitorEditRow, MonitorVersionRow, Store } from '../store/db.ts';
import type { FeatureService } from './features.ts';
import { MonitorError, type MonitorService } from './service.ts';

/** Предел стоимости одной просьбы: агент читает форматы и примеры и возвращает текст файла. */
export const EDIT_BUDGET_USD = 0.6;
const EDIT_MODEL = 'sonnet';
const EDIT_LABEL = 'правка мониторинга';
const MESSAGE_MAX = 2000;

const SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string', description: 'Новый текст файла целиком, YAML' },
    summary: { type: 'string', description: 'Что изменено, одной-двумя фразами по-русски' },
  },
  required: ['source', 'summary'],
  additionalProperties: false,
};

/** Что агент знает о правке: файл, его текст, разговор, ошибки прошлого черновика, сервисы и где читать форматы. */
export interface EditPromptInput {
  target: MonitorTarget;
  label: string;
  file: string;
  /** Текст, от которого агент правит: прошлый черновик, если разговор продолжается, иначе файл. */
  source: string;
  messages: { role: 'owner' | 'agent'; text: string }[];
  errors: string[];
  services: Pick<MonitorServiceProfile, 'id' | 'title'>[];
  /** Где читать формат, примеры и справочники. */
  docs: string[];
}

const KIND: Record<MonitorTarget['kind'], string> = {
  dashboard: 'дашборд задачи: панели по строкам логов прода (график timeseries, число stat, строки lines, самые частые значения top, распределение numbers) и алерты',
  feature: 'профиль воронки фичи входа: стадии по ролям, ошибки сервиса, исходы после шага, вход, время шага и порог автоматов',
  attempt: 'профиль пути одной попытки входа: сервисы пути, идентификаторы попытки по охвату и правила строк (шаг, действие, ошибка, итог, служебная)',
};

/**
 * Задание агенту правки мониторинга: он меняет только один файл и возвращает его новый текст целиком; на диск не
 * пишет, команд не запускает, строк логов и значений из них не видит. Просьбы владельца приходят с телефонами маской.
 */
export function editPrompt(i: EditPromptInput): string {
  const id = i.target.kind === 'attempt' ? null : i.target.id;
  const lines = [
    `Правка мониторинга Task Pilot по просьбе владельца: ${i.label} (файл ${i.file} пакета команды). Ты меняешь только этот файл: возвращаешь его новый текст целиком и коротко пишешь, что изменил. Файлы на диске не меняешь, команд не запускаешь и вопросов владельцу не задаешь: он ждет ответа здесь.`,
    '',
    `Что за файл: ${KIND[i.target.kind]}.`,
    'Формат, примеры и справочники строк логов читай здесь:',
    ...i.docs.map((d) => `- ${d}`),
    '',
    'Сервисы панели мониторинга:',
    ...i.services.map((s) => `- ${s.id} - ${s.title}`),
    '',
    'Правила:',
    ...(id ? [`- id в файле остается ${id}.`] : []),
    '- Меняй только то, о чем просит владелец; остальное, включая комментарии, оставь как было.',
    '- Фразы для поиска строк бери из этого файла, других дашбордов и профилей пакета и справочников скиллов; если нужной фразы там нет, не выдумывай ее, а скажи об этом в summary.',
    '- В текстах нет телефонов, адресов почты и имен сотрудников; выражения detail не вытаскивают телефон, код или accountId.',
    '- Тексты по-русски, без буквы ё и длинного тире, кавычки только прямые; Keycloak латиницей.',
    '',
    'Текущий текст файла:',
    '<файл>',
    i.source.trimEnd(),
    '</файл>',
    ...(i.errors.length ? ['', 'Прошлый текст не прошел проверку схемой, исправь это:', ...i.errors.map((e) => `- ${e}`)] : []),
    '',
    'Разговор, последняя просьба внизу:',
    ...i.messages.map((m) => `${m.role === 'owner' ? 'Владелец' : 'Агент'}: ${m.text}`),
    '',
    'Верни JSON по схеме: source - новый текст файла целиком, summary - что изменено.',
  ];
  return lines.join('\n');
}

/** Зависимости правок мониторинга. */
export interface EditServiceDeps {
  port: MonitorPort;
  store: Store;
  agents: Pick<AgentService, 'forTool'>;
  redact: Redactor;
  monitor: Pick<MonitorService, 'preview'>;
  features?: Pick<FeatureService, 'preview' | 'refresh'>;
  /** Корень Task Pilot: агент читает форматы в docs/. */
  root: string;
  /** Пакет команды: агент работает в нем и читает другие дашборды, профили и скиллы. */
  teamDir: string;
}

/** Превью черновика: данные дашборда, цифры фичи или ничего (у профиля пути превью нет). */
export type EditPreview = { kind: 'dashboard'; data: DashboardDataDto } | { kind: 'feature'; stats: FeatureStatsDto } | { kind: 'none' };

const versionDto = (v: MonitorVersionRow): MonitorVersionDto => ({ id: v.id, target: v.target, note: v.note, source: v.source, createdAt: v.createdAt });
const editDto = (e: MonitorEditRow): MonitorEditDto => ({ ...e });

/**
 * Правка мониторинга по запросу в чате: агент меняет дашборд, профиль фичи или профиль пути по просьбе владельца,
 * Task Pilot проверяет черновик схемой и показывает дифф и превью, а "Применить" пишет файл в пакет команды. Прежний
 * текст файла остается версией в базе и возвращается кнопкой. Агент не видит строк логов, телефоны в просьбах
 * маскируются до того, как попасть в базу и к агенту.
 */
export class EditService {
  private readonly d: EditServiceDeps;
  private readonly pending = new Map<string, { ctl: AbortController; done: Promise<void> }>();

  constructor(d: EditServiceDeps) {
    this.d = d;
  }

  private target(value: string): MonitorTarget {
    const t = parseMonitorTarget(value);
    if (!t) throw new MonitorError('Цель правки - dashboard:<id>, feature:<id> или attempt');
    return t;
  }

  private file(t: MonitorTarget): string {
    return t.kind === 'dashboard' ? `dashboards/${t.id}/dashboard.yaml` : t.kind === 'feature' ? `features/${t.id}.yaml` : 'attempt.yaml';
  }

  private label(t: MonitorTarget): string {
    if (t.kind === 'dashboard') return `дашборд "${this.d.port.dashboards().dashboards.find((x) => x.id === t.id)?.title ?? t.id}"`;
    if (t.kind === 'feature') return `воронка фичи "${this.d.port.features().features.find((x) => x.id === t.id)?.title ?? t.id}"`;
    return `путь попытки "${this.d.port.attempt().profile?.title ?? 'attempt.yaml'}"`;
  }

  /** Проверка текста файла схемой и сервисами; id дашборда и фичи меняться не может. */
  private check(t: MonitorTarget, source: string): { parsed: Dashboard | FeatureProfile | object | null; errors: string[] } {
    if (t.kind === 'dashboard') {
      const r = this.d.port.validate(source);
      if (r.dashboard && r.dashboard.id !== t.id) return { parsed: null, errors: [`id дашборда менять нельзя: было ${t.id}, стало ${r.dashboard.id}`] };
      return { parsed: r.dashboard, errors: r.errors };
    }
    if (t.kind === 'feature') {
      const r = this.d.port.validateFeature(source);
      if (r.feature && r.feature.id !== t.id) return { parsed: null, errors: [`id фичи менять нельзя: было ${t.id}, стало ${r.feature.id}`] };
      return { parsed: r.feature, errors: r.errors };
    }
    const r = this.d.port.validateAttempt(source);
    return { parsed: r.attempt, errors: r.errors };
  }

  private async save(t: MonitorTarget, source: string): Promise<void> {
    if (t.kind === 'dashboard') await this.d.port.save(source);
    else if (t.kind === 'feature') await this.d.port.saveFeature(source);
    else await this.d.port.saveAttempt(source);
  }

  private mustEdit(id: string): MonitorEditRow {
    const e = this.d.store.getMonitorEdit(id);
    if (!e) throw new MonitorError('Правки нет', 404);
    return e;
  }

  /** Правки цели: текущий текст файла, незакрытая правка и прошлые версии. */
  list(value: string): MonitorEditsDto {
    const t = this.target(value);
    const key = targetKey(t);
    const edit = this.d.store.openMonitorEdit(key);
    return {
      target: key,
      label: this.label(t),
      file: this.file(t),
      source: this.d.port.readSource(t),
      edit: edit ? editDto(edit) : null,
      versions: this.d.store.monitorVersions(key).map(versionDto),
    };
  }

  /**
   * Просьба владельца: открывает правку цели или продолжает незакрытую, агент готовит черновик в фоне. Пока агент
   * работает, вторая просьба по той же цели не принимается.
   */
  request(value: string, message: string): MonitorEditDto {
    const t = this.target(value);
    const key = targetKey(t);
    const text = maskPhones(this.d.redact.text(message.trim())).slice(0, MESSAGE_MAX);
    if (!text) throw new MonitorError('Напишите, что поменять');
    const source = this.d.port.readSource(t);
    if (source === null) throw new MonitorError(`Файла ${this.file(t)} в пакете команды нет`, 404);
    const open = this.d.store.openMonitorEdit(key);
    if (open?.status === 'working') throw new MonitorError('Агент еще готовит прошлую правку: дождитесь ее', 409);
    const at = new Date().toISOString();
    const edit = open ? this.d.store.updateMonitorEdit(open.id, { status: 'working', message: { role: 'owner', text, at } }) : this.d.store.createMonitorEdit({ target: key, base: source, message: text });
    const ctl = new AbortController();
    const done = this.work(t, edit.id, ctl.signal).finally(() => this.pending.delete(edit.id));
    this.pending.set(edit.id, { ctl, done });
    return editDto(edit);
  }

  private async work(t: MonitorTarget, id: string, signal: AbortSignal): Promise<void> {
    const agent = this.d.agents.forTool({ tool: 'monitor.edit', manifest: { agent: { model: EDIT_MODEL, browser: false } }, signal, onCost: (usd) => this.d.store.addMonitorEditCost(id, usd) });
    const docs = [
      join(this.d.root, 'docs', t.kind === 'dashboard' ? 'dashboards.md' : 'monitor.md'),
      join(this.d.teamDir, t.kind === 'dashboard' ? 'dashboards' : t.kind === 'feature' ? 'features' : 'attempt.yaml'),
      join(this.d.teamDir, 'plugin', 'skills'),
    ];
    try {
      const e = this.mustEdit(id);
      const prompt = editPrompt({
        target: t,
        label: this.label(t),
        file: this.file(t),
        source: e.draft ?? e.base,
        messages: e.messages,
        errors: e.errors,
        services: this.d.port.services(),
        docs,
      });
      const request = { label: EDIT_LABEL, cwd: this.d.teamDir, tools: ['Read', 'Grep', 'Glob'], writeCwd: false, deny: [...PIPELINE_TOOLS], schema: SCHEMA, maxBudgetUsd: EDIT_BUDGET_USD };
      let r = await agent.run({ ...request, prompt });
      let out = outputOf(r.output, r.text);
      let check = this.check(t, out.source);
      if (!check.parsed) {
        // Один круг исправления: агент получает ошибки проверки в той же сессии.
        r = await agent.run({ ...request, prompt: `Текст не прошел проверку схемой:\n${check.errors.map((x) => `- ${x}`).join('\n')}\n\nИсправь и верни JSON по той же схеме.`, resume: r.sessionId });
        out = outputOf(r.output, r.text);
        check = this.check(t, out.source);
      }
      const summary = this.d.redact.text(out.summary);
      const at = new Date().toISOString();
      if (check.parsed) {
        this.d.store.updateMonitorEdit(id, { status: 'ready', draft: out.source, summary, errors: [], message: { role: 'agent', text: summary, at } });
      } else {
        const text = `${summary}\nЧерновик не прошел проверку: ${check.errors.join('; ')}`;
        this.d.store.updateMonitorEdit(id, { status: 'invalid', draft: out.source, summary, errors: check.errors, message: { role: 'agent', text, at } });
      }
    } catch (err) {
      const text = this.d.redact.text(signal.aborted ? 'Правка остановлена: попросите снова' : err instanceof Error ? err.message : String(err));
      if (this.d.store.getMonitorEdit(id)?.status === 'working') this.d.store.updateMonitorEdit(id, { status: 'failed', message: { role: 'agent', text: `Агент не подготовил правку: ${text}`, at: new Date().toISOString() } });
    }
  }

  /**
   * Применяет готовую правку: черновик проверяется заново, прежний текст файла становится версией, черновик пишется в
   * пакет команды. Если файл изменился с начала правки, она не применяется.
   */
  async apply(id: string): Promise<MonitorEditsDto> {
    const e = this.mustEdit(id);
    if (e.status !== 'ready' || !e.draft) throw new MonitorError('Применить можно только готовую правку, прошедшую проверку', 409);
    const t = this.target(e.target);
    const current = this.d.port.readSource(t);
    if (current !== e.base) throw new MonitorError('Файл изменился, пока шла правка: отклоните ее и попросите заново', 409);
    const check = this.check(t, e.draft);
    if (!check.parsed) throw new MonitorError(`Черновик не прошел проверку: ${check.errors.join('; ')}`);
    this.d.store.addMonitorVersion({ target: e.target, source: current, note: `до правки: ${e.summary ?? 'без описания'}` });
    await this.save(t, e.draft);
    this.d.store.updateMonitorEdit(id, { status: 'applied' });
    // Новые стадии и ошибки фичи нужны и в дневных итогах: они пересчитываются из логов за срок хранения индекса.
    if (t.kind === 'feature') void this.d.features?.refresh(t.id);
    return this.list(e.target);
  }

  /** Отклоняет правку; если агент над ней еще работает, он останавливается. */
  discard(id: string): MonitorEditsDto {
    const e = this.mustEdit(id);
    this.pending.get(id)?.ctl.abort();
    if (e.status !== 'applied') this.d.store.updateMonitorEdit(id, { status: 'discarded' });
    return this.list(e.target);
  }

  /** Возвращает прошлую версию файла: текущий текст становится версией, незакрытая правка цели отклоняется. */
  async revert(versionId: string): Promise<MonitorEditsDto> {
    const v = this.d.store.getMonitorVersion(versionId);
    if (!v) throw new MonitorError('Версии нет', 404);
    const t = this.target(v.target);
    const check = this.check(t, v.source);
    if (!check.parsed) throw new MonitorError(`Версия больше не проходит проверку: ${check.errors.join('; ')}`);
    const current = this.d.port.readSource(t);
    if (current !== null) this.d.store.addMonitorVersion({ target: v.target, source: current, note: 'до возврата версии' });
    await this.save(t, v.source);
    const open = this.d.store.openMonitorEdit(v.target);
    if (open) this.discard(open.id);
    if (t.kind === 'feature') void this.d.features?.refresh(t.id);
    return this.list(v.target);
  }

  /** Превью черновика: дашборд за период, фича за окно дней; у профиля пути превью нет. */
  async preview(id: string, q: { period?: string; from?: string; to?: string }): Promise<EditPreview> {
    const e = this.mustEdit(id);
    if (!e.draft) throw new MonitorError('Черновика пока нет', 409);
    const t = this.target(e.target);
    const check = this.check(t, e.draft);
    if (!check.parsed) throw new MonitorError(`Черновик не прошел проверку: ${check.errors.join('; ')}`);
    if (t.kind === 'dashboard') return { kind: 'dashboard', data: await this.d.monitor.preview(check.parsed as Dashboard, q.period ?? '1h') };
    if (t.kind === 'feature' && this.d.features) return { kind: 'feature', stats: await this.d.features.preview(check.parsed as FeatureProfile, q.from, q.to) };
    return { kind: 'none' };
  }

  /** Дожидается агентов, которые сейчас готовят правки. */
  async settled(): Promise<void> {
    await Promise.all([...this.pending.values()].map((p) => p.done));
  }

  /** Останавливает агентов правок: их правки закрываются ошибкой. */
  close(): void {
    for (const p of this.pending.values()) p.ctl.abort();
  }
}

/** Итог агента: текст файла и что изменено; без JSON по схеме - ошибка. */
function outputOf(output: unknown, text: string): { source: string; summary: string } {
  const o = (output ?? {}) as { source?: unknown; summary?: unknown };
  if (typeof o.source !== 'string' || !o.source.trim()) throw new Error(`Агент не вернул текст файла: ${text.slice(0, 300)}`);
  const source = o.source.endsWith('\n') ? o.source : `${o.source}\n`;
  return { source, summary: typeof o.summary === 'string' && o.summary.trim() ? o.summary.trim() : 'Без описания' };
}
