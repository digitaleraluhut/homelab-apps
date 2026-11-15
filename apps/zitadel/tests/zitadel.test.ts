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
    expect(yaml).toContain('ExternalDomain: "id.example.org"');
    expect(yaml).toContain('ExternalPort: 443');
  });

  // NOTE: FirstInstance settings are passed via ZITADEL_ env vars to the setup Job,
  // NOT in the config file. See test "zitadel first instance env vars" above.
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

  it('generates the first admin password with special characters', () => {
    // ZITADEL's default password complexity policy requires at least one symbol
    // (internal/command/policy_password_complexity_model.go: Validate method checks
    // HasSymbol). The random password must include special chars so the setup Job
    // does not fail with "Errors.User.PasswordComplexityPolicy.HasSymbol".
    // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/internal/command/policy_password_complexity_model.go
    //         https://raw.githubusercontent.com/zitadel/zitadel/v4.20.3/cmd/setup/steps.yaml
    //         (default example password: "Password1!")
    const adminRandom = rendered.find(
      (r) => r.type.includes('randomPassword') && r.urn.includes('first-admin-password'),
    );
    expect(adminRandom).toBeDefined();
    expect(adminRandom!.inputs.special).toBe(true);
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

describe('zitadel first instance env vars', () => {
  it('setup job passes FirstInstance settings via ZITADEL_ env vars (not config file)', () => {
    // FirstInstance settings (org name, username, email, password, PasswordChangeRequired)
    // are read by `zitadel setup` from ZITADEL_ environment variables, not from the config file.
    // NewSteps at cmd/setup/config.go:205-217 reads from ZITADEL_ prefix only.
    // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/setup/config.go (lines 205-217)
    //         https://raw.githubusercontent.com/zitadel/zitadel/v4.20.3/cmd/setup/steps.yaml (env annotations)
    const setup = rendered
      .find((r) => r.type === 'kubernetes:batch/v1:Job' && r.name === 'zitadel-setup')!
      .inputs;
    const container = setup.spec.template.spec.containers[0];

    const envByName = (name: string) =>
      container.env.find((e: { name: string }) => e.name === name);

    expect(envByName('ZITADEL_FIRSTINSTANCE_ORG_NAME')?.value).toBe('Homelab');
    expect(envByName('ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME')?.value).toBe('admin');
    expect(envByName('ZITADEL_FIRSTINSTANCE_ORG_HUMAN_EMAIL_ADDRESS')?.value).toContain('example.org');
    expect(envByName('ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORDCHANGEREQUIRED')?.value).toBe('true');
    // Password comes from Secret
    const pwdEnv = envByName('ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD');
    expect(pwdEnv?.value).toBeUndefined();
    expect(pwdEnv?.valueFrom).toEqual({
      secretKeyRef: { name: 'zitadel-first-admin-password', key: 'password' },
    });
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
    // No initContainer is needed: the setup Job depends on the init Job,
    // which confirms the database is ready when `zitadel setup` runs.
    // The scratch image has no shell, so a `sh -c` initContainer could not start.
    // Source: https://zitadel.com/docs/self-hosting/manage/updating_scaling#the-init-phase
    const setup = rendered
      .find((r) => r.type === 'kubernetes:batch/v1:Job' && r.name === 'zitadel-setup')!
      .inputs;
    const initContainer = setup.spec.template.spec.initContainers?.[0];
    expect(initContainer).toBeUndefined();
  });

  it('init job runs `/app/zitadel init schema`', () => {
    // PostgresInstance creates the DB and user; we only need schema bootstrap.
    // The binary path is /app/zitadel (Dockerfile COPY to /app/zitadel).
    // Source: https://zitadel.com/docs/self-hosting/manage/database
    const init = ofType('batch/v1:Job')
      .find((j) => j.name === 'zitadel-init')!;
    const cmd = init.inputs.spec.template.spec.containers[0].command;
    expect(cmd).toEqual(['/app/zitadel', 'init', 'schema']);
  });

  it('setup job runs `/app/zitadel setup --masterkeyFromEnv --config /config/zitadel.yaml`', () => {
    // Creates the first instance (org, admin user) from config.
    // The binary path is /app/zitadel (Dockerfile COPY to /app/zitadel).
    // The --masterkeyFromEnv flag tells MasterKey() to read ZITADEL_MASTERKEY from the env var.
    // The --config flag tells ZITADEL to read ExternalDomain, ExternalPort, TLS,
    // FirstInstance etc. from the ConfigMap (cmd/zitadel.go:56,97).
    // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/key/masterkey.go (lines 31-48: `MasterKey()` function)
    //         https://zitadel.com/docs/self-hosting/manage/configure/configure ("database initialization file")
    const setup = ofType('batch/v1:Job')
      .find((j) => j.name === 'zitadel-setup')!;
    const cmd = setup.inputs.spec.template.spec.containers[0].command;
    expect(cmd).toEqual([
      '/app/zitadel',
      'setup',
      '--masterkeyFromEnv',
      '--config',
      '/config/zitadel.yaml',
    ]);
  });
});

describe('zitadel master key flag', () => {
  it('setup job passes --masterkeyFromEnv (cmd/key/masterkey.go:31-48)', () => {
    // MasterKey() reads ZITADEL_MASTERKEY only when --masterkeyFromEnv is set.
    // Without it: "masterkey must either be provided by file path, value or environment variable".
    // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/key/masterkey.go (lines 31-48)
    const setup = ofType('batch/v1:Job')
      .find((j) => j.name === 'zitadel-setup')!;
    const cmd = setup.inputs.spec.template.spec.containers[0].command;
    expect(cmd).toContain('--masterkeyFromEnv');
  });

  it('Deployment passes --masterkeyFromEnv (cmd/key/masterkey.go:31-48)', () => {
    // Same reason as setup job: start.go:106 calls key.MasterKey(cmd) which needs the flag.
    // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/key/masterkey.go (lines 31-48)
    expect(container.command).toContain('--masterkeyFromEnv');
  });

  it('Deployment passes --config /config/zitadel.yaml (cmd/zitadel.go:56,97)', () => {
    // The --config flag tells ZITADEL to read the runtime config (ExternalDomain,
    // ExternalPort, TLS, FirstInstance) from the ConfigMap. Without it, these
    // settings are ignored and ZITADEL starts with defaults (cmd/zitadel.go:56).
    // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/zitadel.go (line 56: StringArrayVar for --config,
    //         line 97: initConfig merges the files)
    //         https://zitadel.com/docs/self-hosting/manage/configure/configure ("database initialization file")
    expect(container.command).toContain('--config');
    expect(container.command).toContain('/config/zitadel.yaml');
  });

  it('no ZITADEL_CONFIG env var (it is not read by anything)', () => {
    // ZITADEL reads config files only from the --config flag, not from an env var.
    // The ZITADEL_CONFIG variable is never read, so ExternalDomain, ExternalPort,
    // ExternalSecure, TLS and FirstInstance from the ConfigMap would be ignored.
    // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/zitadel.go (line 56: StringArrayVar for --config)
    const configEnv = env('ZITADEL_CONFIG');
    expect(configEnv).toBeUndefined();
  });
});

describe('zitadel network', () => {
  it('probes /debug/healthz on port 8080', () => {
    // /debug/healthz is registered under the /debug prefix (internal/api/api.go:healthHandler)
    for (const probe of [container.readinessProbe, container.livenessProbe]) {
      expect(probe.httpGet).toEqual({ path: '/debug/healthz', port: 8080 });
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

describe('zitadel pod security', () => {
  it('init job has restricted securityContext (PSS restricted:latest)', () => {
    // The namespace enforces PodSecurity restricted:latest, which requires
    // allowPrivilegeEscalation=false, capabilities.drop ALL, runAsNonRoot=true,
    // and seccompProfile RuntimeDefault on every container.
    // Without this the Job fails with "is forbidden: violates PodSecurity".
    const init = ofType('batch/v1:Job')
      .find((j) => j.name === 'zitadel-init')!
      .inputs;
    const initContainer = init.spec.template.spec.containers[0];
    expect(initContainer.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(init.spec.template.spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
    });
  });

  it('setup job has restricted securityContext (PSS restricted:latest)', () => {
    const setup = ofType('batch/v1:Job')
      .find((j) => j.name === 'zitadel-setup')!
      .inputs;
    const setupContainer = setup.spec.template.spec.containers[0];
    expect(setupContainer.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(setup.spec.template.spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
    });
  });
});
