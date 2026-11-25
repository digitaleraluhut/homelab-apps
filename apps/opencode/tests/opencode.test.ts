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
