import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

// Renders the program the way Pulumi runs it, with mocks (no cluster, no credentials; the same
// renderer as CI's data-loss check), and checks the rendered resources against the facts looked
// up upstream. Each expectation names its source (README.md, "## Upstream facts"), so a test
// fails when the program deploys something else than the fact says, not when a constant changes.
const root = path.resolve(__dirname, '../../..');
type Rendered = { urn: string; type: string; name: string; inputs: any };
const rendered: Rendered[] = JSON.parse(
  execFileSync('node', [path.join(root, '.github/scripts/render_app.cjs'), path.join(root, 'apps/gitea')], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }),
);
const ofType = (type: string) => rendered.filter((r) => r.type === `kubernetes:${type}`);

const deployment = ofType('apps/v1:Deployment')[0].inputs;
const pod = deployment.spec.template.spec;
const container = pod.containers[0];
const env = (name: string) => container.env.find((e: { name: string }) => e.name === name);

describe('gitea image', () => {
  it('is pinned by digest, so every deploy runs the same bytes', () => {
    // Digest of 28.3.0-rootless: https://hub.docker.com/v2/repositories/gitea/gitea/tags/28.3.0-rootless
    expect(container.image).toMatch(/^docker\.io\/gitea\/gitea:28\.3\.0-rootless@sha256:[0-9a-f]{64}$/);
  });

  it('runs as the git user of the rootless image (uid/gid 1000)', () => {
    // Dockerfile.rootless (v28.3.0): user git, 1000:1000
    expect(pod.securityContext).toMatchObject({ runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 });
  });
});

describe('gitea settings (GITEA__<section>__<KEY>, config cheat sheet)', () => {
  it.each([
    ['GITEA__security__INSTALL_LOCK', 'true'], // nobody can claim the installer and become admin
    ['GITEA__service__DISABLE_REGISTRATION', 'true'], // accounts only by invitation
    ['GITEA__service__REQUIRE_SIGNIN_VIEW', 'true'], // no anonymous browsing, API included
    ['GITEA__server__DISABLE_SSH', 'true'], // git over HTTPS only
    ['GITEA__database__DB_TYPE', 'postgres'],
  ])('sets %s=%s', (name, value) => {
    expect(env(name)).toEqual({ name, value });
  });

  it('reads the database user and password from the CNPG credentials Secret, not literals', () => {
    const secret = ofType('core/v1:Secret').find((s) => s.urn.includes('PostgresInstance'))!.inputs.metadata.name;
    for (const [name, key] of [
      ['GITEA__database__USER', 'POSTGRES_USER'],
      ['GITEA__database__PASSWD', 'POSTGRES_PASSWORD'],
    ]) {
      expect(env(name).value).toBeUndefined();
      expect(env(name).valueFrom).toEqual({ secretKeyRef: { name: secret, key } });
    }
  });

  it('connects to the read-write service of its own CNPG cluster', () => {
    const cluster = ofType('postgresql.cnpg.io/v1:Cluster')[0].inputs.metadata.name;
    expect(env('GITEA__database__HOST').value).toBe(`${cluster}-rw:5432`);
  });
});

describe('gitea storage', () => {
  it('keeps data (/var/lib/gitea) and config (/etc/gitea) on the persistent volume claim', () => {
    // Both are VOLUMEs in Dockerfile.rootless (v28.3.0)
    const claim = ofType('core/v1:PersistentVolumeClaim').find((c) => c.name === 'gitea-data')!.inputs;
    const volume = pod.volumes.find((v: { persistentVolumeClaim?: { claimName: string } }) =>
      v.persistentVolumeClaim?.claimName === claim.metadata.name,
    );
    const mounts = container.volumeMounts.filter((m: { name: string }) => m.name === volume.name);
    expect(mounts.map((m: { mountPath: string }) => m.mountPath).sort()).toEqual(['/etc/gitea', '/var/lib/gitea']);
    expect(claim.spec.storageClassName).toBe('longhorn-persistent');
    expect(claim.spec.accessModes).toEqual(['ReadWriteOnce']);
  });

  it('replaces the pod instead of rolling (one writer on a ReadWriteOnce volume)', () => {
    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
  });
});

describe('gitea network', () => {
  it('probes the health endpoint on the HTTP port', () => {
    // routers/web/web.go (v28.3.0): GET /api/healthz; HTTP port 3000 (Dockerfile.rootless)
    for (const probe of [container.readinessProbe, container.livenessProbe]) {
      expect(probe.httpGet).toEqual({ path: '/api/healthz', port: 3000 });
    }
  });

  it('is reachable from the host on NodePort 30300, forwarding to the pod port', () => {
    const svc = ofType('core/v1:Service').find((s) => s.inputs.spec.type === 'NodePort')!.inputs;
    expect(svc.spec.selector).toEqual(deployment.spec.selector.matchLabels);
    expect(svc.spec.ports).toEqual([
      expect.objectContaining({ nodePort: 30300, targetPort: container.ports[0].containerPort }),
    ]);
  });
});
