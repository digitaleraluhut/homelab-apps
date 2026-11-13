import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

// Renders the app with Pulumi mocks (no cluster, no credentials; same renderer as the data-loss check)
// and checks the decisions of the hub's deployment.
const root = path.resolve(__dirname, '../../..');
const rendered: { type: string; name: string; inputs: any }[] = JSON.parse(
  execFileSync('node', [path.join(root, '.github/scripts/render_app.cjs'), path.join(root, 'apps/agentic-office')], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }),
);
const one = (type: string) => rendered.filter((r) => r.type === type);

describe('agentic-office render', () => {
  const dep = one('kubernetes:apps/v1:Deployment')[0].inputs;
  const pod = dep.spec.template.spec;
  const app = pod.containers[0];

  it('runs one replica with Recreate', () => {
    expect(dep.spec.replicas).toBe(1);
    expect(dep.spec.strategy.type).toBe('Recreate');
  });

  it('passes the hub flags with the first system admin', () => {
    const a: string[] = app.args;
    expect(a.slice(0, 8)).toEqual(['-data-dir', '/data', '-addr', '0.0.0.0:8740', '-signing-key', '/data/signing.key', '-public-url', a[7]]);
    expect(a[7]).toMatch(/^https:\/\//);
    expect(a[8]).toBe('-first-system-admin');
    expect(a[9]).toMatch(/^[^=]+=.+/);
  });

  it('uses the public image, pinned by tag, without pull secrets', () => {
    expect(app.image).toMatch(/^ghcr\.io\/mrsimpson\/agentic-office\/office-hub:\d+\.\d+\.\d+$/);
    expect(pod.imagePullSecrets).toBeUndefined();
  });

  it('creates the signing key only if missing, mode 0400, uid and fsGroup 10001', () => {
    const init = pod.initContainers[0];
    expect(init.args[0]).toContain('if [ ! -e /data/signing.key ]');
    expect(init.args[0]).toContain('office-hub keygen /data/signing.key');
    expect(init.args[0]).toContain('chmod 0400 /data/signing.key');
    expect(init.securityContext.runAsUser).toBe(10001);
    expect(pod.securityContext.fsGroup).toBe(10001);
  });

  it('probes TCP 8740 and sets 128Mi/512Mi', () => {
    expect(app.readinessProbe.tcpSocket.port).toBe(8740);
    expect(app.resources.requests.memory).toBe('128Mi');
    expect(app.resources.limits.memory).toBe('512Mi');
  });

  it('keeps /data on a PVC', () => {
    expect(one('kubernetes:core/v1:PersistentVolumeClaim')).toHaveLength(1);
    expect(pod.volumes[0].persistentVolumeClaim.claimName).toBe('agentic-office-data');
  });

  it('serves 8740 over TLS through Traefik without OAuth', () => {
    const svc = one('kubernetes:core/v1:Service')[0].inputs;
    expect(svc.spec.ports[0].port).toBe(8740);
    const route = rendered.find((r) => r.type === 'kubernetes:traefik.io/v1alpha1:IngressRoute')!.inputs;
    const s = route.spec.routes[0].services[0];
    expect(s.scheme).toBe('https');
    expect(s.port).toBe(8740);
    expect(route.spec.routes[0].middlewares).toBeUndefined();
  });
});
