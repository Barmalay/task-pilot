import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactsOf, artifactType } from '../src/artifacts.ts';
import { buildServer } from '../src/http/server.ts';
import { TaskService } from '../src/tasks.ts';
import { FakeCatalog, makeEngine, manifest, PROFILES } from './helpers.ts';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('artifacts of a task', () => {
  it('lists the files of the folder and tells which of them Jira already has', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pilot-artifacts-'));
    cleanup.push(dir);
    writeFileSync(join(dir, '01-login.png'), 'png-1');
    writeFileSync(join(dir, '02-captcha.png'), 'png-2');
    writeFileSync(join(dir, 'kibana-logs-01.png'), 'png-3');
    writeFileSync(join(dir, '.DS_Store'), 'x');
    const jira = { attachments: async () => [{ filename: '01-login.png', size: 5 }, { filename: '02-captcha.png', size: 999 }] };
    const r = await artifactsOf(dir, 'TEAM-7', jira, (t) => t);
    expect(r.files.map((f) => [f.name, f.jira, f.image])).toEqual([
      ['01-login.png', 'same', true],
      ['02-captcha.png', 'other', true],
      ['kibana-logs-01.png', null, true],
    ]);
    expect(r.jiraError).toBeNull();
  });

  it('still shows the files when Jira is unavailable and says why', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pilot-artifacts-'));
    cleanup.push(dir);
    writeFileSync(join(dir, '01-login.png'), 'png');
    const r = await artifactsOf(dir, 'TEAM-7', { attachments: async () => Promise.reject(new Error('REST Jira GET /issue/TEAM-7: 401')) }, (t) => t);
    expect(r.files.map((f) => [f.name, f.jira])).toEqual([['01-login.png', null]]);
    expect(r.jiraError).toBe('REST Jira GET /issue/TEAM-7: 401');
  });

  it('answers an empty list for a folder that does not exist yet', async () => {
    expect((await artifactsOf('/nonexistent/qa', 'TEAM-7', { attachments: async () => [] }, (t) => t)).files).toEqual([]);
  });

  it('serves pictures inline and everything else as a download', () => {
    expect(artifactType('01.png')).toEqual({ type: 'image/png', inline: true });
    expect(artifactType('report.md')).toEqual({ type: 'application/octet-stream', inline: false });
    expect(artifactType('x.svg')).toEqual({ type: 'application/octet-stream', inline: false });
  });
});

describe('artifacts routes', () => {
  const LOCAL = { host: 'localhost:5176' };

  it('gives the gallery of a run and its files only from the artifacts folder', async () => {
    const catalog = new FakeCatalog().add(manifest('a.one'), { run: async () => ({}) }).addPreset(['a.one']);
    const deps = makeEngine(catalog);
    const server = buildServer({ profiles: PROFILES, catalog, tasks: new TaskService({ ...deps, profiles: PROFILES }), ...deps });
    const key = `TEAM-${4000 + Math.floor(Math.random() * 999)}`;
    const run = deps.engine.createRun({ issueKey: key });
    const dir = join(deps.engine.artifactsDir(run.id), 'qa');
    cleanup.push(deps.engine.artifactsDir(run.id));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '01-login.png'), 'png-bytes');
    try {
      const list = await server.inject({ method: 'GET', url: `/api/runs/${run.id}/artifacts`, headers: LOCAL });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({ dir, files: [{ name: '01-login.png', size: 9, image: true, jira: null }], jiraError: null });
      const file = await server.inject({ method: 'GET', url: `/api/runs/${run.id}/artifacts/01-login.png`, headers: LOCAL });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.body).toBe('png-bytes');
      for (const name of ['..%2F..%2F..%2Fetc%2Fpasswd', 'nope.png', '.DS_Store']) {
        expect((await server.inject({ method: 'GET', url: `/api/runs/${run.id}/artifacts/${name}`, headers: LOCAL })).statusCode).toBe(404);
      }
    } finally {
      await server.close();
    }
  });
});
