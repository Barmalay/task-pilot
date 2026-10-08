import type { WikiPage, WikiPort } from '@task-pilot/step-kit';

/** Вики в памяти: для демо-режима и тестов. Страницы создаются и обновляются, как в Confluence, но никуда не уходят. */
export function memoryWiki(): WikiPort & { pages: Map<string, WikiPage> } {
  const pages = new Map<string, WikiPage>();
  let next = 7001;
  const get = (id: string) => {
    const page = pages.get(id);
    if (!page) throw new Error(`Страницы ${id} нет`);
    return { ...page };
  };
  return {
    pages,
    async getPage(id) {
      return get(id);
    },
    async findPage(space, title) {
      const page = [...pages.values()].find((p) => p.space === space && p.title === title);
      return page ? { ...page } : null;
    },
    async createPage(input) {
      const id = String(next++);
      const url = `https://wiki.demo.invalid/pages/viewpage.action?pageId=${id}`;
      pages.set(id, { id, title: input.title, space: input.space, version: 1, url, markdown: input.markdown });
      return { id, url };
    },
    async updatePage(input) {
      const page = get(input.id);
      pages.set(input.id, { ...page, title: input.title, markdown: input.markdown, version: page.version + 1 });
      return { id: input.id, url: page.url };
    },
  };
}
