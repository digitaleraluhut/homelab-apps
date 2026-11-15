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
  execFileSync('node', [path.join(root, '.github/scripts/render_app.cjs'), path.join(root, 'apps/zitadel')], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }),
);
const ofType = (type: string) => rendered.filter((r) => r.type === `kubernetes:${type}`);

const deployment = ofType('apps/v1:Deployment')[0].inputs;
const pod = deployment.spec.template.spec;
const container = pod.containers[0];
const env = (name: string) => container.env.find((e: { name: string }) => e.name === name);

describe('zitadel image', () => {
  it('is pinned by digest, so every deploy runs the same bytes', () => {
    // Digest of v4.20.3: https://github.com/zitadel/zitadel/releases/tag/v4.20.3
    expect(container.image).toMatch(
      /^ghcr\.io\/zitadel\/zitadel:v4\.20\.3@sha256:[0-9a-f]{64}$/,
    );
  });
});

describe('zitadel settings', () => {
  it('uses h2c backend protocol (required for gRPC and management console)', () => {
    // createExposedWebApp sets appProtocol: kubernetes.io/h2c on the Service.
    // Source: https://zitadel.com/docs/self-hosting/manage/http2
    const svc = ofType('core/v1:Service')[0].inputs;
    const port = svc.spec.ports[0];
    expect(port.appProtocol).toBe('kubernetes.io/h2c');
  });

  it('sets TLS.Enabled=false in the runtime config (Traefik terminates TLS)', () => {
    // Source: https://zitadel.com/docs/self-hosting/manage/tls_modes
    const configMap = ofType('core/v1:ConfigMap')[0].inputs;
    const yaml = configMap.data['zitadel.yaml'];
    expect(yaml).toContain('TLS:\n  Enabled: false');
  });

  it('sets the external domain to id.<domain>', () => {
    const configMap = ofType('core/v1:ConfigMap')[0].inputs;
    const yaml = configMap.data['zitadel.yaml'];
    expect(yaml).toContain('ExternalDomain: "zitadel.example.org"');
    expect(yaml).toContain('ExternalPort: 443');
  });

  it('configures the first admin user (admin@example.org, PasswordChangeRequired: true)', () => {
    // Source: https://zitadel.com/docs/self-hosting/deploy/kubernetes
    // ("PasswordChangeRequired: true" forces change at first login)
    const configMap = ofType('core/v1:ConfigMap')[0].inputs;
    const yaml = configMap.data['zitadel.yaml'];
    expect(yaml).toContain('UserName: "admin"');
    expect(yaml).toContain('Email: "admin@example.org"');
    expect(yaml).toContain('PasswordChangeRequired: true');
  });
});

describe('zitadel secrets', () => {
  it('generates the master key from a RandomPassword, not a literal', () => {
    // Source: https://zitadel.com/docs/self-hosting/deploy/kubernetes
    // The mock type is 'random:index/randomPassword:RandomPassword'.
    const random = rendered.find((r) => r.type.includes('randomPassword'));
    expect(random).toBeDefined();
    const masterKeySecret = ofType('core/v1:Secret')
      .find((s) => s.name === 'zitadel-masterkey')!;
    // The key is base64-encoded (render-placeholder-secret base64'd), never the plaintext.
    expect(masterKeySecret.inputs.data?.masterkey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(masterKeySecret.inputs.data?.masterkey).not.toBe('render-placeholder-secret');
  });

  it('stores the first admin password in a Secret, not in the ConfigMap', () => {
    const adminSecret = ofType('core/v1:Secret')
      .find((s) => s.name === 'zitadel-first-admin-password')!;
    expect(adminSecret.inputs.data?.password).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('reads the master key from the Secret in the deployment env, not as a literal', () => {
    const secret = ofType('core/v1:Secret')
      .find((s) => s.name === 'zitadel-masterkey')!.inputs.metadata.name;
    const e = env('ZITADEL_MASTERKEY');
    expect(e.value).toBeUndefined();
    expect(e.valueFrom).toEqual({ secretKeyRef: { name: secret, key: 'masterkey' } });
  });

  it('reads the first admin password from the Secret in the setup job env', () => {
    const setup = rendered
      .find((r) => r.type === 'kubernetes:batch/v1:Job' && r.name === 'zitadel-setup')!
      .inputs;
    const container = setup.spec.template.spec.containers[0];
    const e = container.env.find((e: { name: string }) =>
      e.name === 'ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD',
    );
    const secret = ofType('core/v1:Secret')
      .find((s) => s.name === 'zitadel-first-admin-password')!.inputs.metadata.name;
    expect(e.value).toBeUndefined();
    expect(e.valueFrom).toEqual({ secretKeyRef: { name: secret, key: 'password' } });
  });
});

describe('zitadel database', () => {
  it('connects via DATABASE_URL from the CNPG credentials Secret', () => {
    // The DSN is read from the PostgresInstance adapter Secret, not as a literal.
    const dbSecret = ofType('core/v1:Secret')
      .find((s) => s.urn.includes('PostgresInstance'))!.inputs.metadata.name;
    for (const src of [
      env('ZITADEL_DATABASE_POSTGRES_DSN'),
      // init job
      ofType('batch/v1:Job')
        .find((j) => j.name === 'zitadel-init')!
        .inputs.spec.template.spec.containers[0].env.find(
          (e: { name: string }) => e.name === 'ZITADEL_DATABASE_POSTGRES_DSN',
        ),
    ]) {
      expect(src.value).toBeUndefined();
      expect(src.valueFrom).toEqual({
        secretKeyRef: { name: dbSecret, key: 'DATABASE_URL' },
      });
    }
  });
});

describe('zitadel jobs', () => {
  it('runs init before setup (init job dependency)', () => {
    // init schema must run before setup (schema must exist for first instance).
    // Source: https://zitadel.com/docs/self-hosting/manage/database
    //         https://zitadel.com/docs/self-hosting/manage/updating_scaling
    const setup = rendered
      .find((r) => r.type === 'kubernetes:batch/v1:Job' && r.name === 'zitadel-setup')!
      .inputs;
    const initContainer = setup.spec.template.spec.initContainers?.[0];
    expect(initContainer).toBeDefined();
    expect(initContainer.name).toBe('wait-for-init');
    expect(initContainer.image).toBe('docker.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662');
  });

  it('init job runs `zitadel init schema`', () => {
    // PostgresInstance creates the DB and user; we only need schema bootstrap.
    // Source: https://zitadel.com/docs/self-hosting/manage/database
    const init = ofType('batch/v1:Job')
      .find((j) => j.name === 'zitadel-init')!;
    const cmd = init.inputs.spec.template.spec.containers[0].command;
    expect(cmd).toEqual(['zitadel', 'init', 'schema']);
  });

  it('setup job runs `zitadel setup`', () => {
    // Creates the first instance (org, admin user) from config.
    // Source: https://zitadel.com/docs/self-hosting/manage/updating_scaling#the-setup-phase
    const setup = ofType('batch/v1:Job')
      .find((j) => j.name === 'zitadel-setup')!;
    const cmd = setup.inputs.spec.template.spec.containers[0].command;
    expect(cmd).toEqual(['zitadel', 'setup']);
  });
});

describe('zitadel network', () => {
  it('probes /debug/health on port 8080', () => {
    // Source: https://zitadel.com/docs/self-hosting/manage/monitoring#health-checks
    for (const probe of [container.readinessProbe, container.livenessProbe]) {
      expect(probe.httpGet).toEqual({ path: '/debug/health', port: 8080 });
    }
  });

  it('runs as non-root (uid/gid 1000)', () => {
    // ZITADEL image runs as non-root; 1000 is the standard UID.
    expect(pod.securityContext).toMatchObject({
      runAsUser: 1000,
      runAsGroup: 1000,
    });
  });
});
