import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// Renders the program with mocks (the renderer CI's data-loss check uses) and checks it against the
// facts in README.md, "## Upstream facts".
const root = path.resolve(__dirname, '../../..');
type Rendered = { type: string; name: string; inputs: any };
const rendered: Rendered[] = JSON.parse(
  execFileSync('node', [path.join(root, '.github/scripts/render_app.cjs'), path.join(root, 'apps/mailpit')], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }),
);
const ofType = (type: string) => rendered.filter((r) => r.type === `kubernetes:${type}`);
const deployment = ofType('apps/v1:Deployment').find((d) => d.inputs.metadata?.name === 'mailpit')!.inputs;
const pod = deployment.spec.template.spec;
const app = pod.containers.find((c: any) => c.name === 'app');
const env = Object.fromEntries(app.env.map((e: any) => [e.name, e.value]));

describe('mailpit', () => {
  it('runs the pinned image (release v1.34.0, index digest)', () => {
    expect(app.image).toMatch(/^docker\.io\/axllent\/mailpit:v1\.34\.0@sha256:[0-9a-f]{64}$/);
  });

  it('listens for the UI on 8025 and for SMTP on 1025 (cmd/root.go MP_UI_BIND_ADDR, MP_SMTP_BIND_ADDR)', () => {
    expect(env.MP_UI_BIND_ADDR).toBe('0.0.0.0:8025');
    expect(env.MP_SMTP_BIND_ADDR).toBe('0.0.0.0:1025');
    expect(app.ports[0].containerPort).toBe(8025);
  });

  it('keeps its database in a writable emptyDir and makes no version calls', () => {
    expect(env.MP_DATABASE).toBe('/data/mailpit.db');
    expect(env.MP_DISABLE_VERSION_CHECK).toBe('true');
    expect(pod.volumes.find((v: any) => v.name === 'data').emptyDir).toBeDefined();
    expect(app.volumeMounts.find((m: any) => m.name === 'data').mountPath).toBe('/data');
  });

  it('probes /readyz and /livez (server/server.go)', () => {
    expect(app.readinessProbe.httpGet).toEqual({ path: '/readyz', port: 8025 });
    expect(app.livenessProbe.httpGet).toEqual({ path: '/livez', port: 8025 });
  });

  it('offers SMTP only inside the cluster, to the Mailpit pod', () => {
    const smtp = ofType('core/v1:Service').find((s) => s.inputs.metadata?.name === 'mailpit-smtp')!.inputs;
    expect(smtp.spec.type).toBe('ClusterIP');
    expect(smtp.spec.selector).toEqual({ app: 'mailpit' });
    expect(deployment.spec.template.metadata.labels.app).toBe('mailpit');
    expect(smtp.spec.ports).toEqual([{ name: 'smtp', port: 1025, targetPort: 1025, protocol: 'TCP' }]);
  });

  it('runs as non-root without service links', () => {
    expect(pod.enableServiceLinks).toBe(false);
    expect(app.securityContext).toMatchObject({ allowPrivilegeEscalation: false, runAsNonRoot: true });
  });
});
