import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { EventDetailsDto, PatchHunkDto, ToolCallDto, ToolResultDto } from '@task-pilot/api-types';
import type { EventRow, Store } from './store/db.ts';

/** id запуска агента - имя его папки в .data/agent. */
const SESSION = /^[0-9a-f-]{36}$/i;
/** Сколько символов текста показывать в подробностях. */
const TEXT_LIMIT = 20_000;
/** Сколько строк диффа показывать у одного вызова. */
const PATCH_LINES = 3000;
/** Сколько найденных файлов показывать у поиска. */
const FILES_LIMIT = 500;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Начало длинного текста; clipped - обрезано ли. */
export function clipHead(text: string, limit = TEXT_LIMIT): { text: string; clipped: boolean } {
  return text.length > limit ? { text: `${text.slice(0, limit)}\n... обрезано, еще ${text.length - limit} символов`, clipped: true } : { text, clipped: false };
}

/** Конец длинного текста: у вывода команды важнее последние строки. */
export function clipTail(text: string, limit = TEXT_LIMIT): { text: string; clipped: boolean } {
  return text.length > limit ? { text: `... обрезано, еще ${text.length - limit} символов\n${text.slice(-limit)}`, clipped: true } : { text, clipped: false };
}

/** Вход инструмента для показа: длинные строки (содержимое файла, большие правки) обрезаются. */
function clipInput(value: unknown): unknown {
  if (typeof value === 'string') return clipHead(value).text;
  if (Array.isArray(value)) return value.map(clipInput);
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipInput(v)]));
  return value;
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.filter(isObj).map((c) => str(c.text) ?? '').filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

/** Куски диффа с общим лимитом строк: хвост сверх лимита отрезается целыми строками. */
function patchOf(value: unknown): { patch: PatchHunkDto[]; clipped: boolean } {
  const hunks = Array.isArray(value) ? value.filter(isObj) : [];
  const patch: PatchHunkDto[] = [];
  let left = PATCH_LINES;
  let clipped = false;
  for (const h of hunks) {
    const lines = Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === 'string') : [];
    if (left <= 0) {
      clipped = true;
      break;
    }
    if (lines.length > left) clipped = true;
    patch.push({ oldStart: Number(h.oldStart) || 0, oldLines: Number(h.oldLines) || 0, newStart: Number(h.newStart) || 0, newLines: Number(h.newLines) || 0, lines: lines.slice(0, left) });
    left -= lines.length;
  }
  return { patch, clipped };
}

/**
 * Ответ инструмента из строки tool_result и структурированного tool_use_result, который CLI кладет рядом: у правок и
 * записи файлов там путь и дифф с номерами строк, у команд - stdout и stderr, у поиска - найденные файлы.
 */
function resultOf(block: Obj, structured: unknown): ToolResultDto {
  const text = textOf(block.content);
  const head = text === null ? null : clipHead(text);
  const result: ToolResultDto = { isError: block.is_error === true, text: head?.text ?? null, clipped: head?.clipped || undefined };
  if (!isObj(structured)) return result;
  const file = isObj(structured.file) ? str(structured.file.filePath) : undefined;
  const path = str(structured.filePath) ?? file;
  if (path) result.filePath = path;
  if ('structuredPatch' in structured) {
    const { patch, clipped } = patchOf(structured.structuredPatch);
    result.patch = patch;
    result.change = structured.type === 'create' ? 'create' : 'update';
    if (clipped) result.clipped = true;
  }
  if (typeof structured.stdout === 'string' || typeof structured.stderr === 'string') {
    const out = clipTail(str(structured.stdout) ?? '');
    const err = clipTail(str(structured.stderr) ?? '');
    result.stdout = out.text;
    result.stderr = err.text;
    result.interrupted = structured.interrupted === true;
    if (out.clipped || err.clipped) result.clipped = true;
  }
  if (Array.isArray(structured.filenames)) {
    const files = structured.filenames.filter((f): f is string => typeof f === 'string');
    result.files = files.slice(0, FILES_LIMIT);
    if (files.length > FILES_LIMIT) result.clipped = true;
  }
  return result;
}

/**
 * Вызов инструмента из журнала потока агента (`stream.jsonl`, секреты в нем уже замаскированы): вход из tool_use,
 * ответ из tool_result. Новый файл, у которого CLI не дал диффа, показывается целиком добавленными строками.
 */
export async function toolCallOf(file: string, toolUseId: string): Promise<ToolCallDto | null> {
  if (!toolUseId || !existsSync(file)) return null;
  let call: { tool: string; input: Obj } | null = null;
  let result: ToolResultDto | null = null;
  const input = createReadStream(file, 'utf8');
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    // Быстрый отсев: разбирается только строка, где встречается id вызова.
    if (!line.includes(toolUseId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(parsed)) continue;
    const content = isObj(parsed.message) && Array.isArray(parsed.message.content) ? parsed.message.content.filter(isObj) : [];
    for (const c of content) {
      if (c.type === 'tool_use' && c.id === toolUseId) call = { tool: str(c.name) ?? '', input: isObj(c.input) ? c.input : {} };
      if (c.type === 'tool_result' && c.tool_use_id === toolUseId) result = resultOf(c, parsed.tool_use_result);
    }
    if (call && result) break;
  }
  lines.close();
  input.destroy();
  if (!call) return null;
  if (result && call.tool === 'Write' && !result.patch?.length && typeof call.input.content === 'string') {
    const added = call.input.content.split('\n');
    const { patch, clipped } = patchOf([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: added.length, lines: added.map((l) => `+${l}`) }]);
    Object.assign(result, { patch, change: result.change ?? 'create', filePath: result.filePath ?? str(call.input.file_path), ...(clipped ? { clipped } : {}) });
  }
  return { tool: call.tool, input: clipInput(call.input) as Obj, result };
}

/**
 * Подробности события ленты. У вызова инструмента - что агент передал и получил (дифф правки, вывод команды), у
 * подтверждения - что было на нем показано и чем закончилось, у вопроса - вопрос, варианты и ответ, у остальных -
 * данные события. У вызова без ссылки на журнал агента (session и toolUseId в данных события) подробностей нет.
 */
export async function eventDetails(store: Store, dataDir: string, e: EventRow): Promise<EventDetailsDto> {
  const data = isObj(e.data) ? e.data : {};
  if (e.type === 'agent.tool') {
    const session = str(data.session);
    const id = str(data.toolUseId);
    if (!session || !SESSION.test(session) || !id) return { kind: 'none', reason: 'Подробности этого вызова не сохранились: у него нет ссылки на журнал агента' };
    const call = await toolCallOf(join(dataDir, 'agent', session, 'stream.jsonl'), id);
    return call ? { kind: 'tool', call } : { kind: 'none', reason: 'Вызова нет в журнале агента: журнал удален или запуск прервался' };
  }
  const approval = str(data.approvalId) ? store.getApproval(str(data.approvalId)!) : undefined;
  if (approval && approval.runId === e.runId) {
    const { id, status, comment, createdAt, decidedAt, preview } = approval;
    return { kind: 'approval', approval: { id, status, comment, createdAt, decidedAt, preview } };
  }
  const question = str(data.questionId) ? store.getQuestion(str(data.questionId)!) : undefined;
  if (question && question.runId === e.runId) {
    const { question: text, options, status, answer, createdAt, answeredAt } = question;
    return { kind: 'question', question: { question: text, options, status, answer, createdAt, answeredAt } };
  }
  if (e.data !== null && e.data !== undefined) return { kind: 'data', data: e.data };
  return { kind: 'none', reason: 'У события нет подробностей' };
}
