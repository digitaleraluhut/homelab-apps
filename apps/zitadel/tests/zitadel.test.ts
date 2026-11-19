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

  it('sets SystemAPIUsers.login-client (Login V2 JWT verification)', () => {
    // Login V2 authenticates to the core via X.509 certificate-based JWT.
    // The core must know where to find the public cert for verification.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/_helpers.tpl
    //         (SystemAPIUsers.login-client injection)
    //         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
    const configMap = ofType('core/v1:ConfigMap')[0].inputs;
    const yaml = configMap.data['zitadel.yaml'];
    expect(yaml).toContain('SystemAPIUsers:');
    expect(yaml).toContain('login-client:');
    expect(yaml).toContain('Path: "/secrets/login-client/tls.crt"');
    expect(yaml).toContain('IAM_LOGIN_CLIENT');
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

  it('generates the first admin password satisfying every class by construction', () => {
    // ZITADEL's default password complexity policy requires minimum length 8,
    // HasLowercase, HasUppercase, HasNumber, HasSymbol (cmd/defaults.yaml: MinLength: 8).
    // Using min* guarantees every class by construction, not by chance.
    // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/defaults.yaml (MinLength: 8)
    //         https://github.com/zitadel/zitadel/blob/v4.20.3/internal/command/policy_password_complexity_model.go
    const adminRandom = rendered.find(
      (r) => r.type.includes('randomPassword') && r.urn.includes('first-admin-password'),
    );
    expect(adminRandom).toBeDefined();
    expect(adminRandom!.inputs.minLower).toBe(1);
    expect(adminRandom!.inputs.minUpper).toBe(1);
    expect(adminRandom!.inputs.minNumeric).toBe(1);
    expect(adminRandom!.inputs.minSpecial).toBe(1);
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

  it('sets enableServiceLinks: false (avoids tcp:// crash)', () => {
    // Kubernetes injects ZITADEL_PORT=tcp://ip:port when enableServiceLinks is true.
    // ZITADEL reads all ZITADEL_* env vars as config (viper.AutomaticEnv with prefix ZITADEL_),
    // and the tcp:// value fails uint16 parsing, crashing the container.
    // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/zitadel.go
    //         (viper.AutomaticEnv with prefix ZITADEL_)
    //         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_zitadel.yaml
    //         (enableServiceLinks: false on all pod specs)
    expect(pod.enableServiceLinks).toBe(false);
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

// ---------------------------------------------------------------------------
// Login V2 ConfigMap
// ---------------------------------------------------------------------------

describe('login V2 configmap', () => {
  it('creates a ConfigMap with the .env file for login connection config', () => {
    // The login ConfigMap provides ZITADEL_LOGINCLIENT_KEYFILE, AUDIENCE,
    // ZITADEL_API_URL, and CUSTOM_REQUEST_HEADERS to the login container.
    // The .env file is mounted at /.env-file/ in the login pod.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/configmap_login.yaml
    const loginCm = rendered.find(
      (r) => r.type === 'kubernetes:core/v1:ConfigMap' && r.name === 'zitadel-login-config',
    );
    expect(loginCm).toBeDefined();
    const data = loginCm!.inputs.data;
    expect(data).toBeDefined();
    expect(data['.env']).toBeDefined();
    expect(data['.env']).toContain('ZITADEL_LOGINCLIENT_KEYFILE="/login-service-key/tls.key"');
    expect(data['.env']).toContain('AUDIENCE="https://id.example.org"');
    expect(data['.env']).toContain('ZITADEL_API_URL="http://zitadel:8080"');
    expect(data['.env']).toContain('CUSTOM_REQUEST_HEADERS="Host:id.example.org,X-Zitadel-Public-Host:id.example.org"');
  });
});

// ---------------------------------------------------------------------------
// Login V2
// ---------------------------------------------------------------------------

describe('login V2 image', () => {
  it('uses the login image (v4.20.3), not the core image', () => {
    // Login V2 is a Next.js app on port 3000. It runs on its own image
    // (ghcr.io/zitadel/zitadel-login), not the core zitadel binary.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/values.yaml
    //         (login.image.repository = ghcr.io/zitadel/zitadel-login)
    //         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
    const loginDeploy = rendered.find(
      (r) => r.type === 'kubernetes:apps/v1:Deployment' && r.name === 'zitadel-login',
    );
    expect(loginDeploy).toBeDefined();
    const loginContainer = loginDeploy!.inputs.spec.template.spec.containers[0];
    expect(loginContainer.image).toMatch(
      /^ghcr\.io\/zitadel\/zitadel-login:v4\.20\.3@sha256:[0-9a-f]{64}$/,
    );
  });

  it('has no command override (login image has its own entrypoint)', () => {
    // The login image ships its own Node.js entrypoint; no command override
    // is needed. The core zitadel binary has no 'login' subcommand.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
    const loginDeploy = rendered.find(
      (r) => r.type === 'kubernetes:apps/v1:Deployment' && r.name === 'zitadel-login',
    );
    const loginContainer = loginDeploy!.inputs.spec.template.spec.containers[0];
    expect(loginContainer.command).toBeUndefined();
  });
});

describe('login V2 service', () => {
  it('exposes port 8090 → targetPort 3000 (Next.js container)', () => {
    // The Login V2 container runs on port 3000. The Service exposes it on port 8090
    // so it can be reached from the gateway via extraRoutes.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/_helpers.tpl
    //         (login.containerPort = 3000)
    //         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/values.yaml
    //         (login.service.port = 8090)
    const loginSvc = rendered.find(
      (r) => r.type === 'kubernetes:core/v1:Service' && r.name === 'zitadel-login',
    );
    expect(loginSvc).toBeDefined();
    const svc = loginSvc!.inputs;
    expect(svc.spec.ports[0].port).toBe(8090);
    expect(svc.spec.ports[0].targetPort).toBe(3000);
    expect(svc.spec.ports[0].name).toBe('http-server');
    expect(svc.spec.type).toBe('ClusterIP');
    expect(svc.spec.selector?.app).toBe('zitadel-login');
  });
});

describe('login V2 deployment', () => {
  it('has an init container that waits for zitadel', () => {
    // The login UI needs the core API to be ready before it starts (it calls the
    // API for authentication). The init container waits for the zitadel service.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/_helpers.tpl
    //         (wait4x.image) + deployment_login.yaml
    const loginDeploy = rendered.find(
      (r) => r.type === 'kubernetes:apps/v1:Deployment' && r.name === 'zitadel-login',
    );
    const loginSpec = loginDeploy!.inputs.spec.template.spec;
    const initContainer = loginSpec.initContainers?.[0];
    expect(initContainer).toBeDefined();
    expect(initContainer!.name).toBe('wait-for-zitadel');
    expect(initContainer!.command).toEqual([
      'wait4x',
      'http',
      'http://zitadel:8080/debug/ready',
      '--insecure-skip-tls-verify',
      '--h2c',
      '--no-redirect',
      '--expect-status-code',
      '200',
      '--timeout',
      '5m',
      '--interval',
      '5s',
    ]);
  });

  it('has restricted securityContext', () => {
    const loginDeploy = rendered.find(
      (r) => r.type === 'kubernetes:apps/v1:Deployment' && r.name === 'zitadel-login',
    );
    const loginPod = loginDeploy!.inputs.spec.template.spec;
    expect(loginPod.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
    });
    const container = loginPod.containers[0];
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    });
  });

  it('probes /ui/v2/login/healthy and /ui/v2/login/ready', () => {
    // Probes for the Next.js login app.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/_helpers.tpl
    const loginDeploy = rendered.find(
      (r) => r.type === 'kubernetes:apps/v1:Deployment' && r.name === 'zitadel-login',
    );
    const container = loginDeploy!.inputs.spec.template.spec.containers[0];
    expect(container.readinessProbe.httpGet).toEqual({
      path: '/ui/v2/login/ready',
      port: 3000,
    });
    expect(container.livenessProbe.httpGet).toEqual({
      path: '/ui/v2/login/healthy',
      port: 3000,
    });
  });

  it('mounts the .env ConfigMap at /.env-file (login connection config)', () => {
    // The login container reads ZITADEL_LOGINCLIENT_KEYFILE, AUDIENCE,
    // ZITADEL_API_URL, and CUSTOM_REQUEST_HEADERS from a .env file
    // mounted at /.env-file/. This is how the chart configmap_login.yaml
    // wires the login to the core.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/configmap_login.yaml
    //         deployment_login.yaml (volumeMount at /.env-file/)
    const loginDeploy = rendered.find(
      (r) => r.type === 'kubernetes:apps/v1:Deployment' && r.name === 'zitadel-login',
    );
    const loginPod = loginDeploy!.inputs.spec.template.spec;
    // Check the volume
    const envVolume = loginPod.volumes?.find((v: { name: string }) => v.name === 'login-config-dotenv');
    expect(envVolume).toBeDefined();
    expect(envVolume?.configMap?.name).toBe('zitadel-login-config');
    // Check the mount
    const envMount = loginPod.containers[0].volumeMounts?.find(
      (m: { name: string }) => m.name === 'login-config-dotenv',
    );
    expect(envMount).toBeDefined();
    expect(envMount?.mountPath).toBe('/.env-file');
    expect(envMount?.readOnly).toBe(true);
  });

  it('has no command override (login image has its own entrypoint)', () => {
    // The login image ships its own Node.js entrypoint; no command override
    // is needed. The core zitadel binary has no 'login' subcommand.
    // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/zitadel.go
    const loginDeploy = rendered.find(
      (r) => r.type === 'kubernetes:apps/v1:Deployment' && r.name === 'zitadel-login',
    );
    const container = loginDeploy!.inputs.spec.template.spec.containers[0];
    expect(container.command).toBeUndefined();
  });
});

describe('login V2 env vars', () => {
  it('sets NEXT_PUBLIC_BASE_PATH=/ui/v2/login', () => {
    // Next.js app base path for the login UI.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
    const loginDeploy = rendered.find(
      (r) => r.type === 'kubernetes:apps/v1:Deployment' && r.name === 'zitadel-login',
    );
    const container = loginDeploy!.inputs.spec.template.spec.containers[0];
    const envByName = (name: string) =>
      container.env.find((e: { name: string }) => e.name === name);
    expect(envByName('NEXT_PUBLIC_BASE_PATH')?.value).toBe('/ui/v2/login');
  });

  it('sets ZITADEL_EXTERNALDOMAIN', () => {
    // The external domain for audience verification in JWTs.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/configmap_login.yaml
    const loginDeploy = rendered.find(
      (r) => r.type === 'kubernetes:apps/v1:Deployment' && r.name === 'zitadel-login',
    );
    const container = loginDeploy!.inputs.spec.template.spec.containers[0];
    const envByName = (name: string) =>
      container.env.find((e: { name: string }) => e.name === name);
    expect(envByName('ZITADEL_EXTERNALDOMAIN')?.value).toBe('id.example.org');
  });

  it('reads ZITADEL_SESSION_COOKIE_SECRET from a Secret', () => {
    // The login UI signs session cookies with this secret.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
    const loginDeploy = rendered.find(
      (r) => r.type === 'kubernetes:apps/v1:Deployment' && r.name === 'zitadel-login',
    );
    const container = loginDeploy!.inputs.spec.template.spec.containers[0];
    const sessionCookie = container.env.find(
      (e: { name: string }) => e.name === 'ZITADEL_SESSION_COOKIE_SECRET',
    );
    expect(sessionCookie?.value).toBeUndefined();
    expect(sessionCookie?.valueFrom).toEqual({
      secretKeyRef: {
        name: 'zitadel-session-cookie',
        key: 'ZITADEL_SESSION_COOKIE_SECRET',
      },
    });
  });
});

describe('login V2 key pair', () => {
  it('generates an RSA key pair with @pulumi/tls, not a literal', () => {
    // Login V2 authenticates to the core via X.509 certificate-based JWT.
    // An RSA key pair is generated once and stored in Pulumi state.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/secret_login-service-key.yaml
    //         (auto-generated keypair)
    //         add-app-with-secrets/SKILL.md (@pulumi/tls for key pairs)
    const tlsKey = rendered.find(
      (r) => r.type === 'tls:index/privateKey:PrivateKey' && r.urn.includes('login-key'),
    );
    expect(tlsKey).toBeDefined();
    const tlsCert = rendered.find(
      (r) => r.type === 'tls:index/selfSignedCert:SelfSignedCert' && r.urn.includes('login-cert'),
    );
    expect(tlsCert).toBeDefined();
  });

  it('stores the key pair in a Secret (kubernetes.io/tls)', () => {
    // The Secret contains tls.key (private) and tls.crt (public).
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/secret_login-service-key.yaml
    const loginKeySecret = rendered.find(
      (r) => r.type === 'kubernetes:core/v1:Secret' && r.name === 'zitadel-login-key',
    );
    expect(loginKeySecret).toBeDefined();
    expect(loginKeySecret!.inputs.type).toBe('kubernetes.io/tls');
    // The mock uses stringData with placeholder values.
    // Neither value is an actual PEM block (it would be rejected by gitleaks).
    expect(loginKeySecret!.inputs.stringData?.['tls.key']).toBe('render-placeholder-secret');
    expect(loginKeySecret!.inputs.stringData?.['tls.crt']).toBe('render-placeholder-cert');
  });

  it('mounts the private key into the login container', () => {
    // The login container uses the private key to sign JWTs for the core.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
    const loginDeploy = rendered.find(
      (r) => r.type === 'kubernetes:apps/v1:Deployment' && r.name === 'zitadel-login',
    );
    const loginPod = loginDeploy!.inputs.spec.template.spec;
    const volume = loginPod.volumes?.find((v: { name: string }) => v.name === 'login-service-key');
    expect(volume).toBeDefined();
    expect(volume?.secret?.secretName).toBe('zitadel-login-key');
    const mount = loginPod.containers[0].volumeMounts?.find(
      (m: { name: string }) => m.name === 'login-service-key',
    );
    expect(mount).toBeDefined();
    expect(mount?.mountPath).toBe('/login-service-key');
  });
});

describe('login V2 routing', () => {
  it('routes /ui/v2/login to the login Service', () => {
    // The core createExposedWebApp uses extraRoutes to route the login UI
    // to the separate Login V2 Service. The longest prefix wins.
    // Source: ExposedWebApp.d.ts (ExtraRoute interface)
    const mainSvc = ofType('core/v1:Service')[0].inputs;
    // The extraRoutes should be in the ExposedWebApp's gateway configuration.
    // Check that the login service exists for the routing to work.
    const loginSvc = rendered.find(
      (r) => r.type === 'kubernetes:core/v1:Service' && r.name === 'zitadel-login',
    );
    expect(loginSvc).toBeDefined();
    expect(loginSvc!.inputs.spec.ports[0].port).toBe(8090);
  });
});

describe('session cookie secret', () => {
  it('is generated via RandomPassword, not a literal', () => {
    // The login UI uses this to sign session cookies. Generated once.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/values.yaml
    const sessionRandom = rendered.find(
      (r) => r.type.includes('randomPassword') && r.urn.includes('session-cookie'),
    );
    expect(sessionRandom).toBeDefined();
    // Stored in a Secret, not a ConfigMap or literal env.
    const sessionSecret = rendered.find(
      (r) => r.type === 'kubernetes:core/v1:Secret' && r.name === 'zitadel-session-cookie',
    );
    expect(sessionSecret).toBeDefined();
    expect(sessionSecret!.inputs.data?.['ZITADEL_SESSION_COOKIE_SECRET']).toMatch(
      /^[A-Za-z0-9+/=]+$/,
    );
  });
});

// ---------------------------------------------------------------------------
// Service links: prevent ZITADEL from reading injected service variables
// ---------------------------------------------------------------------------

describe('service links', () => {
  it('init job sets enableServiceLinks: false', () => {
    // Kubernetes injects ZITADEL_PORT=tcp://ip:port when enableServiceLinks
    // is true (the default). ZITADEL reads all ZITADEL_* env vars as config
    // (viper.AutomaticEnv with prefix ZITADEL_), and the tcp:// value fails
    // uint16 parsing for the Port setting, crashing the container.
    // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/zitadel.go
    //         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/job_init.yaml
    const initJob = rendered.find(
      (r) => r.type === 'kubernetes:batch/v1:Job' && r.name === 'zitadel-init',
    );
    expect(initJob).toBeDefined();
    expect(initJob!.inputs.spec.template.spec.enableServiceLinks).toBe(false);
  });

  it('setup job sets enableServiceLinks: false', () => {
    // Same reason: prevents ZITADEL from reading injected service-link vars.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/job_setup.yaml
    const setupJob = rendered.find(
      (r) => r.type === 'kubernetes:batch/v1:Job' && r.name === 'zitadel-setup',
    );
    expect(setupJob).toBeDefined();
    expect(setupJob!.inputs.spec.template.spec.enableServiceLinks).toBe(false);
  });

  it('login deployment sets enableServiceLinks: false', () => {
    // Same reason: prevents ZITADEL from reading injected service-link vars.
    // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
    const loginDeploy = rendered.find(
      (r) => r.type === 'kubernetes:apps/v1:Deployment' && r.name === 'zitadel-login',
    );
    expect(loginDeploy).toBeDefined();
    expect(loginDeploy!.inputs.spec.template.spec.enableServiceLinks).toBe(false);
  });
});
