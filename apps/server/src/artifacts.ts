import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ArtifactDto, ArtifactsDto } from '@task-pilot/api-types';

/** Имя файла артефакта: без путей, как имена скриншотов QA-браузера. */
export const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Тип содержимого файла артефакта; не картинка отдается как вложение, а не страницей. */
export function artifactType(name: string): { type: string; inline: boolean } {
  const image = IMAGES[extname(name).toLowerCase()];
  return image ? { type: image, inline: true } : { type: 'application/octet-stream', inline: false };
}

/**
 * Файлы папки артефактов задачи со сверкой по вложениям Jira: тот же файл уже загружен, загружен другой файл
 * с тем же именем или его во вложениях нет. Недоступная Jira не мешает показать файлы.
 */
export async function artifactsOf(
  dir: string,
  issueKey: string,
  jira: { attachments(key: string): Promise<{ filename: string; size: number }[]> },
  redact: (text: string) => string,
): Promise<ArtifactsDto> {
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => ARTIFACT_NAME.test(n) && statSync(join(dir, n)).isFile()).sort() : [];
  let attachments: { filename: string; size: number }[] = [];
  let jiraError: string | null = null;
  if (names.length) {
    try {
      attachments = await jira.attachments(issueKey);
    } catch (e) {
      jiraError = redact(e instanceof Error ? e.message : String(e));
    }
  }
  const files = names.map((name): ArtifactDto => {
    const st = statSync(join(dir, name));
    const same = attachments.filter((a) => a.filename === name);
    return {
      name,
      size: st.size,
      modified: st.mtime.toISOString(),
      image: artifactType(name).inline,
      jira: !same.length ? null : same.some((a) => a.size === st.size) ? 'same' : 'other',
    };
  });
  return { dir, files, jiraError };
}
