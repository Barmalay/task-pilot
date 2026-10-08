import type { FastifyInstance } from 'fastify';
import { stepSettings, stepSigns, type JiraConfig } from '@task-pilot/step-kit';
import type { CatalogDto, ProfilesDto } from '@task-pilot/api-types';
import type { CatalogView } from '../../catalog/catalog.ts';
import { PROTECTED_PRESETS } from '../../catalog/presets.ts';
import type { Profiles } from '../../config.ts';
import type { IdParams, ServerDeps } from '../support.ts';

function catalogDto(catalog: CatalogView, board: JiraConfig): CatalogDto {
  return {
    steps: catalog.entries().map((e) => ({
      id: e.manifest.id,
      title: e.manifest.title,
      hint: e.manifest.hint,
      phase: e.manifest.phase,
      kind: e.manifest.kind,
      gate: e.manifest.gate,
      requires: e.manifest.requires,
      provides: e.manifest.provides,
      sideEffects: e.manifest.sideEffects,
      implemented: e.implemented,
      stage: e.stage,
      ...stepSigns(e.manifest),
      settings: stepSettings(e.manifest, board),
    })),
    presets: catalog.presets(),
    presetIssues: Object.fromEntries(catalog.presets().map((p) => [p.id, catalog.presetIssues(p.id)])),
    protectedPresets: [...PROTECTED_PRESETS],
    errors: catalog.errors(),
    loadedAt: catalog.loadedAt(),
  };
}

function profilesDto(p: Profiles): ProfilesDto {
  const connected = (contour: string) => p.contours.find((c) => c.id === contour)?.connected === true;
  return {
    repos: p.repos.map((r) => ({ id: r.id, title: r.title, contour: r.contour, connected: connected(r.contour), default: r.default })),
    stands: p.stands.map((s) => ({ id: s.id, title: s.title, contour: s.contour, url: s.url ?? null, deployable: s.deployable, notes: s.notes, repos: s.bambooEnvIds ? Object.keys(s.bambooEnvIds) : null })),
    contours: p.contours.map((c) => ({ id: c.id, title: c.title, connected: c.connected, note: c.note ?? null })),
  };
}

/** Каталог шагов, правка пресетов и профили репозиториев, стендов и контуров. */
export function catalogRoutes(app: FastifyInstance, d: ServerDeps): void {
  app.get('/api/catalog', async () => catalogDto(d.catalog, d.integrations.jiraProfile()));
  // Пресеты: тело проверяет редактор по схеме и каталогу, после записи каталог уже перечитан.
  app.post('/api/presets', async (req, reply) => reply.code(201).send(await d.presets.create(req.body)));
  app.put<{ Params: IdParams }>('/api/presets/:id', async (req) => d.presets.update(req.params.id, req.body));
  app.delete<{ Params: IdParams }>('/api/presets/:id', async (req) => {
    await d.presets.remove(req.params.id);
    return { ok: true };
  });
  app.get('/api/profiles', async () => profilesDto(d.profiles));
}
