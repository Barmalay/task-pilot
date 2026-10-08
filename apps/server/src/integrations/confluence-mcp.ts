import type { WikiPage, WikiPort } from '@task-pilot/step-kit';
import type { McpCall } from './jira-mcp.ts';

interface RawPage {
  id?: string | number;
  title?: string;
  url?: string;
  version?: number | { number?: number };
  space?: { key?: string };
  content?: { value?: string } | string;
}

/** Страница из ответа mcp-atlassian: метаданные бывают в корне или в metadata, тело - в content.value. */
export function toPage(raw: RawPage & { metadata?: RawPage; page?: RawPage }): WikiPage {
  const meta = raw.metadata ?? raw.page ?? raw;
  const content = raw.content ?? meta.content;
  const version = typeof meta.version === 'number' ? meta.version : (meta.version?.number ?? 0);
  if (meta.id === undefined) throw new Error('Confluence вернул страницу без id');
  return {
    id: String(meta.id),
    title: meta.title ?? '',
    space: meta.space?.key ?? '',
    version,
    url: meta.url ?? '',
    markdown: typeof content === 'string' ? content : (content?.value ?? ''),
  };
}

/**
 * Порт вики поверх MCP-сервера atlassian: тело страницы идет markdown. Поиск по заголовку сделан точным: CQL `title`
 * ищет по словам, поэтому из найденного берется страница ровно с этим заголовком.
 */
export function createWikiMcp(call: McpCall): WikiPort {
  return {
    async getPage(id) {
      return toPage((await call('confluence_get_page', { page_id: id, convert_to_markdown: true, include_metadata: true })) as RawPage);
    },
    async findPage(space, title) {
      const cql = `type = page AND space = "${space.replace(/"/g, '')}" AND title = "${title.replace(/"/g, '\\"')}"`;
      const found = (await call('confluence_search', { query: cql, limit: 5 })) as RawPage[];
      const hit = (Array.isArray(found) ? found : []).find((p) => p.title === title);
      return hit?.id === undefined ? null : this.getPage(String(hit.id));
    },
    async createPage(input) {
      const raw = (await call('confluence_create_page', {
        space_key: input.space,
        title: input.title,
        content: input.markdown,
        content_format: 'markdown',
        ...(input.parentId ? { parent_id: input.parentId } : {}),
      })) as RawPage & { page?: RawPage };
      const page = raw.page ?? raw;
      return { id: String(page.id ?? ''), url: page.url ?? '' };
    },
    async updatePage(input) {
      const raw = (await call('confluence_update_page', {
        page_id: input.id,
        title: input.title,
        content: input.markdown,
        content_format: 'markdown',
        version_comment: input.comment,
      })) as RawPage & { page?: RawPage };
      const page = raw.page ?? raw;
      return { id: String(page.id ?? input.id), url: page.url ?? '' };
    },
  };
}
