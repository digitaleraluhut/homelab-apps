import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// Renders the program with mocks (the renderer CI's data-loss check uses).
const root = path.resolve(__dirname, '../../..');
type Rendered = { type: string; name: string; inputs: any };
const rendered: Rendered[] = JSON.parse(
  execFileSync('node', [path.join(root, '.github/scripts/render_app.cjs'), path.join(root, 'apps/opencode')], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }),
);
const of = (type: string) => rendered.filter((r) => r.type === `kubernetes:${type}`);
const pod = of('apps/v1:Deployment').find((d) => d.inputs.metadata?.name === 'opencode')!.inputs.spec.template.spec;
const app = pod.containers.find((c: any) => c.name === 'app');

describe('opencode projects volume', () => {
  it('claims opencode-projects on longhorn-uncritical (no backup), apart from the config volume', () => {
    const claims = of('core/v1:PersistentVolumeClaim').map((c) => c.inputs);
    const data = claims.find((c) => c.metadata.name === 'opencode-projects');
    expect(data.spec).toMatchObject({ accessModes: ['ReadWriteOnce'], storageClassName: 'longhorn-uncritical' });
    expect(data.spec.resources.requests.storage).toBe('20Gi');
    expect(claims.length).toBeGreaterThanOrEqual(2);
  });

  it('mounts it at ~/projects (HOME is /data/home)', () => {
    const env = Object.fromEntries(app.env.map((e: any) => [e.name, e.value]));
    expect(env.HOME).toBe('/data/home');
    const vol = pod.volumes.find((v: any) => v.persistentVolumeClaim?.claimName === 'opencode-projects');
    expect(app.volumeMounts.find((m: any) => m.name === vol.name).mountPath).toBe('/data/home/projects');
  });

  it('starts opencode serve in ~/projects (serve has no directory argument; Alpine image with /bin/sh)', () => {
    expect(app.command).toEqual(['/bin/sh', '-c']);
    expect(app.args).toEqual(['cd /data/home/projects && exec opencode serve --hostname 0.0.0.0 --port 4096']);
  });
});

describe('opencode plugins', () => {
  const env = Object.fromEntries(app.env.map((e: any) => [e.name, e.value]));
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);

  it('lists the plugins under `plugins` (opencode 2.x), each pinned to an exact version', () => {
    expect(config.plugin).toBeUndefined();
    expect(config.plugins).toEqual([
      '@ex-machina/opencode-anthropic-auth@2.0.0-next.8',
      '@codemcp/workflows-opencode@6.25.0',
      'opencode-antigravity-auth@2.1.2',
    ]);
    for (const p of config.plugins) expect(p).toMatch(/@\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it('keeps the local-ai provider and model', () => {
    expect(config.model).toBe('local-ai/qwen3.6-35b-a3b');
    expect(config.provider['local-ai'].options.baseURL).toBe('http://flinker:8080/v1');
  });
});

describe('opencode agent and global instructions', () => {
  const env = Object.fromEntries(app.env.map((e: any) => [e.name, e.value]));
  const cm = of('core/v1:ConfigMap').find((c) => c.name === 'opencode-agents')!.inputs;
  const mount = (p: string) => app.volumeMounts.find((m: any) => m.mountPath === p);

  it('makes the workflow agent the default', () => {
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).default_agent).toBe('workflow');
    expect(cm.data['workflow.md']).toMatch(/^---\n[\s\S]*mode: primary[\s\S]*\n---\n/);
  });

  it('carries the router base permissions, e.g. no .env reads and no rm -rf', () => {
    expect(cm.data['workflow.md']).toContain('"*.env": deny');
    expect(cm.data['workflow.md']).toContain('"rm -rf *": deny');
  });

  it('puts the global AGENTS.md with the worktree rule into ~/.config/opencode', () => {
    expect(cm.data['AGENTS.md']).toContain('Always work in worktrees');
    expect(env.XDG_CONFIG_HOME).toBe('/data/config');
    expect(mount('/data/config/opencode/AGENTS.md')).toMatchObject({ subPath: 'AGENTS.md', readOnly: true });
    expect(mount('/data/config/opencode/agents/workflow.md')).toMatchObject({ subPath: 'workflow.md' });
    expect(cm.metadata.name).toMatch(/^opencode-agents-[0-9a-f]{8}$/);
  });
});

