import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import * as tls from '@pulumi/tls';
import {
  AuthType,
  createAppNamespace,
  createHomelabContextFromStack,
  PostgresInstance,
} from '@mrsimpson/homelab-core-components';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = 'zitadel';
const APP_PORT = 8080; // ZITADEL HTTP/gRPC port (defaults.yaml: Port: 8080)
const LOGIN_PORT = 3000; // Login V2 Next.js container port (helm chart _helpers.tpl)

// Pinned image digest for v4.20.3 (the newest release).
// Source: https://github.com/zitadel/zitadel/releases/tag/v4.20.3
const DEFAULT_IMAGE =
  'ghcr.io/zitadel/zitadel:v4.20.3@sha256:1b30fea7ed88826dc0a98dacee4e2f2c8b05201fd26f5e4cb5386615b29f7638';

// Pinned image digest for login v4.20.3.
// Source: https://github.com/zitadel/zitadel/releases/tag/v4.20.3
//         Registry API of ghcr.io (image_digest tool).
const LOGIN_IMAGE =
  'ghcr.io/zitadel/zitadel-login:v4.20.3@sha256:8f730428dfd65cd8979d07ef4e34a59d44978e956692b7dbbc3bba4e4abb4f92';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const cfg = new pulumi.Config(APP_NAME);
const homelabStack = new pulumi.StackReference(cfg.require('homelabStack'));
const domain = homelabStack.getOutput('domain') as pulumi.Output<string>;
const homelab = createHomelabContextFromStack(homelabStack);

const image = cfg.get('image') ?? DEFAULT_IMAGE;

// ---------------------------------------------------------------------------
// Namespace: created here, with the CI's deployer rights.
// ---------------------------------------------------------------------------

const { namespace: ns } = createAppNamespace(APP_NAME);

// ---------------------------------------------------------------------------
// Database: CloudNativePG-managed PostgreSQL
// ---------------------------------------------------------------------------

const db = new PostgresInstance(`${APP_NAME}-db`, {
  namespace: ns,
  databaseName: APP_NAME,
  storageSize: '5Gi',
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

// Master key: generated at deploy time, encrypted in Pulumi state.
// ZITADEL encrypts sensitive data at rest with this key; it cannot be
// changed after the first run.
// Source: https://zitadel.com/docs/self-hosting/deploy/kubernetes
const masterKey = pulumi.secret(
  new random.RandomPassword('master-key', { length: 32, special: false }).result,
);

// First admin password: stored in a Kubernetes Secret so the owner can
// read it once at first login. Never appears in the repository.
// Source: https://zitadel.com/docs/self-hosting/deploy/kubernetes
//         ("PasswordChangeRequired: true" forces change at first login)
// ZITADEL's default password complexity policy requires minimum length 8,
// at least one lowercase, one uppercase, one number, and one symbol
// (cmd/defaults.yaml: MinLength: 8, HasLowercase, HasUppercase, HasNumber, HasSymbol).
// Using min* guarantees every class by construction, not by chance.
// Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/defaults.yaml (MinLength: 8)
//         https://github.com/zitadel/zitadel/blob/v4.20.3/internal/command/policy_password_complexity_model.go
const firstAdminPassword = pulumi.secret(
  new random.RandomPassword('first-admin-password', {
    length: 24,
    minSpecial: 1,
    minUpper: 1,
    minLower: 1,
    minNumeric: 1,
  }).result,
);

// Master key Secret (mounted as /masterkey/masterkey).
const masterKeySecret = new k8s.core.v1.Secret(`${APP_NAME}-masterkey`, {
  metadata: {
    name: `${APP_NAME}-masterkey`,
    namespace: ns.metadata.name,
  },
  data: {
    'masterkey': masterKey.apply((key: string) =>
      Buffer.from(key).toString('base64'),
    ),
  },
}, { dependsOn: [ns] });

// First admin password Secret (mounted as /first-admin/password).
const firstAdminPasswordSecret = new k8s.core.v1.Secret(`${APP_NAME}-first-admin-password`, {
  metadata: {
    name: `${APP_NAME}-first-admin-password`,
    namespace: ns.metadata.name,
  },
  data: {
    'password': firstAdminPassword.apply((key: string) =>
      Buffer.from(key).toString('base64'),
    ),
  },
}, { dependsOn: [ns] });

// ---------------------------------------------------------------------------
// Login V2 authentication keypair
// ---------------------------------------------------------------------------
// The Login V2 UI authenticates to the core via X.509 certificate-based
// JWT authentication (SystemAPIUsers mechanism). The chart auto-generates
// an RSA keypair and:
//   - injects SystemAPIUsers.login-client into the ConfigMap (public cert)
//   - mounts the private key into the Login container for JWT signing
// Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/_helpers.tpl
//         (zitadel.mergedConfigmapConfig, loginServiceKeySecretName)
//         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
//         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/secret_login-service-key.yaml

// Generate a self-signed RSA keypair once (persisted in Pulumi state).
const loginKey = new tls.PrivateKey(`${APP_NAME}-login-key`, {
  algorithm: 'RSA',
  rsaBits: 2048,
}, { dependsOn: [ns] });

const loginCert = new tls.SelfSignedCert(`${APP_NAME}-login-cert`, {
  privateKeyPem: loginKey.privateKeyPem,
  subject: { commonName: `${APP_NAME}-login` },
  validityPeriodHours: 24 * 365 * 10, // 10 years
  earlyRenewalHours: 24 * 30,
  isCaCertificate: false,
  allowedUses: [
    'digital_signature',
    'key_encipherment',
  ],
}, { dependsOn: [loginKey, ns] });

// Login key Secret (kubernetes.io/tls type): tls.key (private) and tls.crt (public).
// Mounted into the Login V2 pod at /login-service-key (private key) and into
// the zitadel pod at /secrets/login-client (public cert for JWT verification).
// Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/secret_login-service-key.yaml
//         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
const loginKeySecret = new k8s.core.v1.Secret(`${APP_NAME}-login-key`, {
  metadata: {
    name: `${APP_NAME}-login-key`,
    namespace: ns.metadata.name,
  },
  type: 'kubernetes.io/tls',
  stringData: {
    'tls.key': loginKey.privateKeyPem,
    'tls.crt': loginCert.certPem,
  },
}, { dependsOn: [loginKey, loginCert, ns] });

// Session cookie secret: the Login UI uses this to sign its session cookies.
// Every entry ≥ 32 chars; first entry signs, all accepted for verification.
// Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/values.yaml
//         (login.sessionCookieSecretName)
const sessionCookieSecret = pulumi.secret(
  new random.RandomPassword('session-cookie', {
    length: 64,
    special: false,
  }).result,
);

const sessionCookieSecretResource = new k8s.core.v1.Secret(`${APP_NAME}-session-cookie`, {
  metadata: {
    name: `${APP_NAME}-session-cookie`,
    namespace: ns.metadata.name,
  },
  data: {
    'ZITADEL_SESSION_COOKIE_SECRET': sessionCookieSecret.apply((s: string) =>
      Buffer.from(s).toString('base64'),
    ),
  },
}, { dependsOn: [ns] });

// ---------------------------------------------------------------------------
// Runtime configuration as a ConfigMap (mounted at /config/zitadel.yaml)
// ---------------------------------------------------------------------------

// The ConfigMap includes the core runtime config AND the SystemAPIUsers.login-client
// entry so that the zitadel Deployment can verify JWTs signed by the Login V2 UI.
// Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/_helpers.tpl
//         (zitadel.mergedConfigmapConfig — adds SystemAPIUsers.login-client)
const configMap = new k8s.core.v1.ConfigMap(`${APP_NAME}-config`, {
  metadata: {
    name: `${APP_NAME}-config`,
    namespace: ns.metadata.name,
  },
  data: {
    'zitadel.yaml': pulumi.interpolate`# ZITADEL runtime configuration
ExternalDomain: "id.${domain}"
ExternalPort: 443
ExternalSecure: true
TLS:
  Enabled: false
Log:
  Level: info
SystemAPIUsers:
  login-client:
    Path: "/secrets/login-client/tls.crt"
    Memberships:
      - MemberType: System
        Roles:
          - IAM_LOGIN_CLIENT
`,
  },
}, { dependsOn: [ns, loginCert] });

// ---------------------------------------------------------------------------
// Init Job: bootstrap database schemas.
// PostgresInstance creates the database and app user, so we only need
// `zitadel init schema` (no provisioning needed).
// Source: https://zitadel.com/docs/self-hosting/manage/database
//         https://zitadel.com/docs/self-hosting/manage/updating_scaling#the-init-phase
// ---------------------------------------------------------------------------

const initJob = new k8s.batch.v1.Job(`${APP_NAME}-init`, {
  metadata: {
    name: `${APP_NAME}-init`,
    namespace: ns.metadata.name,
  },
  spec: {
    template: {
      spec: {
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
        },
        // Service-link variables (e.g. ZITADEL_PORT=tcp://ip:port) are read by
        // ZITADEL as configuration (viper.AutomaticEnv with prefix ZITADEL_).
        // The injected tcp:// value cannot be parsed as uint16 for Port,
        // causing the core Deployment to crash.
        // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/zitadel.go
        //         (viper.AutomaticEnv with prefix ZITADEL_)
        //         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_zitadel.yaml
        //         (enableServiceLinks: false on all pod specs)
        enableServiceLinks: false,
        containers: [{
          name: 'init',
          image: DEFAULT_IMAGE,
          command: ['/app/zitadel', 'init', 'schema'],
          env: [{
            name: 'ZITADEL_DATABASE_POSTGRES_DSN',
            valueFrom: {
              secretKeyRef: { name: db.credentialsSecretName, key: 'DATABASE_URL' },
            },
          }],
          securityContext: {
            allowPrivilegeEscalation: false,
            runAsNonRoot: true,
            capabilities: {
              drop: ['ALL'],
            },
            seccompProfile: {
              type: 'RuntimeDefault',
            },
          },
          volumeMounts: [
            { name: 'config', mountPath: '/config/zitadel.yaml', subPath: 'zitadel.yaml', readOnly: true },
          ],
        }],
        restartPolicy: 'Never',
        volumes: [{ name: 'config', configMap: { name: configMap.metadata.name } }],
      },
    },
    backoffLimit: 3,
  },
}, { dependsOn: [ns, db] });

// ---------------------------------------------------------------------------
// Setup Job: create the first instance (org + admin user).
// Source: https://zitadel.com/docs/self-hosting/manage/updating_scaling#the-setup-phase
// ---------------------------------------------------------------------------

const setupJob = new k8s.batch.v1.Job(`${APP_NAME}-setup`, {
  metadata: {
    name: `${APP_NAME}-setup`,
    namespace: ns.metadata.name,
  },
  spec: {
    template: {
      spec: {
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
        },
        // Service-link variables are injected with enableServiceLinks=true (default)
        // and read by ZITADEL as configuration (viper.AutomaticEnv with prefix ZITADEL_).
        // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/zitadel.go
        //         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/job_init.yaml
        enableServiceLinks: false,
        containers: [{
          name: 'setup',
          image: DEFAULT_IMAGE,
          command: [
            '/app/zitadel',
            'setup',
            '--masterkeyFromEnv',
            '--config',
            '/config/zitadel.yaml',
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            runAsNonRoot: true,
            capabilities: {
              drop: ['ALL'],
            },
            seccompProfile: {
              type: 'RuntimeDefault',
            },
          },
          env: [
            {
              name: 'ZITADEL_MASTERKEY',
              valueFrom: {
                secretKeyRef: { name: masterKeySecret.metadata.name, key: 'masterkey' },
              },
            },
            {
              name: 'ZITADEL_DATABASE_POSTGRES_DSN',
              valueFrom: {
                secretKeyRef: { name: db.credentialsSecretName, key: 'DATABASE_URL' },
              },
            },
            // FirstInstance settings — read by `zitadel setup` from ZITADEL_ env vars,
            // NOT from the config file (NewSteps at cmd/setup/config.go:205-217 ignores --config).
            // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/setup/config.go (lines 205-217)
            //         https://raw.githubusercontent.com/zitadel/zitadel/v4.20.3/cmd/setup/steps.yaml (env annotations)
            {
              name: 'ZITADEL_FIRSTINSTANCE_ORG_NAME',
              value: 'Homelab',
            },
            {
              name: 'ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME',
              value: 'admin',
            },
            {
              name: 'ZITADEL_FIRSTINSTANCE_ORG_HUMAN_EMAIL_ADDRESS',
              value: pulumi.interpolate`admin@${domain}`,
            },
            {
              name: 'ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD',
              valueFrom: {
                secretKeyRef: { name: firstAdminPasswordSecret.metadata.name, key: 'password' },
              },
            },
            {
              name: 'ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORDCHANGEREQUIRED',
              value: 'true',
            },
          ],
          volumeMounts: [
            { name: 'config', mountPath: '/config/zitadel.yaml', subPath: 'zitadel.yaml', readOnly: true },
          ],
        }],
        restartPolicy: 'Never',
        volumes: [{ name: 'config', configMap: { name: configMap.metadata.name } }],
      },
    },
    backoffLimit: 3,
  },
}, { dependsOn: [ns, db, initJob, masterKeySecret, firstAdminPasswordSecret] });

// ---------------------------------------------------------------------------
// Deployment: runtime phase (zitadel start).
// The root command at cmd/zitadel.go:41 refuses to run without a subcommand.
// 'zitadel start' is the production command (cmd/start/start.go).
// ---------------------------------------------------------------------------

type EnvEntry = {
  name: string;
  value?: pulumi.Input<string>;
  valueFrom?: { secretKeyRef: { name: pulumi.Input<string>; key: string } };
};

const runtimeEnv: EnvEntry[] = [
  // Master key for encrypting sensitive data at rest.
  {
    name: 'ZITADEL_MASTERKEY',
    valueFrom: {
      secretKeyRef: { name: masterKeySecret.metadata.name, key: 'masterkey' },
    },
  },
  // Database connection string — from PostgresInstance credentials Secret.
  {
    name: 'ZITADEL_DATABASE_POSTGRES_DSN',
    valueFrom: { secretKeyRef: { name: db.credentialsSecretName, key: 'DATABASE_URL' } },
  },
];

const app = homelab.createExposedWebApp(
  APP_NAME,
  {
    namespace: ns,
    image,
    domain: pulumi.interpolate`id.${domain}`,
    port: APP_PORT,
    replicas: 1,
    // h2c required for ZITADEL's gRPC and management console.
    // Source: https://zitadel.com/docs/self-hosting/manage/http2
    backendProtocol: 'h2c',
    auth: AuthType.NONE, // ZITADEL is the login itself.
    // Service-link variables (e.g. ZITADEL_PORT=tcp://ip:port) are read by
    // ZITADEL as configuration (viper.AutomaticEnv with prefix ZITADEL_).
    // The injected tcp:// value cannot be parsed as uint16 for Port,
    // causing the core Deployment to crash.
    // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/zitadel.go
    //         (viper.AutomaticEnv with prefix ZITADEL_)
    //         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_zitadel.yaml
    //         (enableServiceLinks: false on all pod specs)
    enableServiceLinks: false,
    securityContext: {
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
    },
    // 'zitadel start' is the production command; the root command refuses
    // to run without a subcommand (cmd/zitadel.go:41).
    // --config tells ZITADEL to read ExternalDomain, ExternalPort, TLS,
    // FirstInstance etc. from the ConfigMap (cmd/zitadel.go:56,97).
    command: [
      '/app/zitadel',
      'start',
      '--masterkeyFromEnv',
      '--config',
      '/config/zitadel.yaml',
    ],
    env: runtimeEnv as any,
    extraVolumes: [
      { name: 'config', configMap: { name: configMap.metadata.name } },
      { name: 'masterkey', secret: { secretName: masterKeySecret.metadata.name } },
      { name: 'login-client', secret: { secretName: loginKeySecret.metadata.name, items: [{ key: 'tls.crt', path: 'tls.crt' }] } },
    ],
    extraVolumeMounts: [
      { name: 'config', mountPath: '/config/zitadel.yaml', subPath: 'zitadel.yaml', readOnly: true },
      { name: 'masterkey', mountPath: '/masterkey', readOnly: true },
      { name: 'login-client', mountPath: '/secrets/login-client', readOnly: true },
    ],
    probes: {
      readinessProbe: {
        httpGet: { path: '/debug/healthz', port: APP_PORT },
        initialDelaySeconds: 10,
        periodSeconds: 10,
      },
      livenessProbe: {
        httpGet: { path: '/debug/healthz', port: APP_PORT },
        initialDelaySeconds: 30,
        periodSeconds: 30,
      },
    },
    // Route /ui/v2/login to the Login V2 Service. The longest prefix wins
    // in Gateway API, so /ui/v2/login routes to login and / to zitadel.
    // Source: ExposedWebApp.d.ts (ExtraRoute interface)
    extraRoutes: [
      {
        pathPrefix: '/ui/v2/login',
        serviceName: `${APP_NAME}-login`,
        servicePort: 8090,
      },
    ],
    tags: ['zitadel', 'auth', 'oidc'],
  },
  { dependsOn: [ns, setupJob, configMap, loginKeySecret, sessionCookieSecretResource] },
);

// ---------------------------------------------------------------------------
// Login V2 Service
// ---------------------------------------------------------------------------
// The Login V2 UI is a Next.js application listening on port 3000 inside the
// container. The Service exposes it on port 8090 so it can be reached from
// the traefik gateway via the extraRoutes in createExposedWebApp.
// Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/_helpers.tpl
//         (login.containerPort = 3000)
//         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/values.yaml
//         (login.service.port = 8090)
// ---------------------------------------------------------------------------

const loginService = new k8s.core.v1.Service(`${APP_NAME}-login`, {
  metadata: {
    name: `${APP_NAME}-login`,
    namespace: ns.metadata.name,
  },
  spec: {
    selector: {
      app: `${APP_NAME}-login`,
    },
    ports: [{
      port: 8090,
      targetPort: 3000,
      protocol: 'TCP',
      name: 'http-server',
    }],
    type: 'ClusterIP',
  },
}, { dependsOn: [ns] });

// ---------------------------------------------------------------------------
// Login V2 ConfigMap (.env file)
// ---------------------------------------------------------------------------
// The Login V2 container reads its configuration from a .env file mounted
// at /.env-file/. This mirrors the Helm chart's configmap_login.yaml.
// The file is generated by the chart using shell variable expansion from
// ZITADEL_EXTERNALDOMAIN (provided as an env var in the container).
//
// Contents (configmap_login.yaml):
//   ZITADEL_LOGINCLIENT_KEYFILE="/login-service-key/tls.key"
//   AUDIENCE="https://${ZITADEL_EXTERNALDOMAIN}"    (ExternalSecure=true, ExternalPort=443)
//   ZITADEL_API_URL="http://zitadel:8080"           (TLS.Enabled=false)
//   CUSTOM_REQUEST_HEADERS="Host:${ZITADEL_EXTERNALDOMAIN},X-Zitadel-Public-Host:${ZITADEL_EXTERNALDOMAIN}"
//
// Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/configmap_login.yaml
// ---------------------------------------------------------------------------

const loginDomain = pulumi.interpolate`id.${domain}`;

// The .env file uses the ExposedWebApp Service port (not the container port).
// The Service listens on port 80 and forwards to targetPort APP_PORT (8080).
// Source: @mrsimpson/homelab-core-components/ExposedWebApp.js (Service creation: port: 80, targetPort: args.port)
const loginConfigMap = new k8s.core.v1.ConfigMap(`${APP_NAME}-login-config`, {
  metadata: {
    name: `${APP_NAME}-login-config`,
    namespace: ns.metadata.name,
  },
  data: {
    '.env': pulumi.interpolate`
ZITADEL_LOGINCLIENT_KEYFILE="/login-service-key/tls.key"
AUDIENCE="https://${loginDomain}"
ZITADEL_API_URL="http://zitadel:${app.service.spec.ports[0].port}"
CUSTOM_REQUEST_HEADERS="Host:${loginDomain},X-Zitadel-Public-Host:${loginDomain}"
`,
  },
}, { dependsOn: [ns] });

// ---------------------------------------------------------------------------
// Login V2 Deployment
// ---------------------------------------------------------------------------
// Login V2 is a separate Next.js application that handles the user-facing
// authentication interface (login, registration, password reset). It runs
// on its own container image (ghcr.io/zitadel/zitadel-login), not the core.
// The login image has its own entrypoint and does not need a command override.
//
// Authentication to the core: X.509 certificate-based JWT authentication
// via ZITADEL's SystemAPIUsers mechanism. The login container mounts the
// private key and uses it to sign JWTs; the core verifies them with the
// public cert (mounted at /secrets/login-client/tls.crt).
//
// The init container waits for the core zitadel to be ready before the login
// UI starts, preventing a race condition.
//
// The wait4x URL uses the ExposedWebApp Service port (not the container port).
// The Service listens on port 80 and forwards to targetPort APP_PORT (8080).
// Source: @mrsimpson/homelab-core-components/ExposedWebApp.js (Service creation: port: 80, targetPort: args.port)
// ---------------------------------------------------------------------------

const loginDeployment = new k8s.apps.v1.Deployment(`${APP_NAME}-login`, {
  metadata: {
    name: `${APP_NAME}-login`,
    namespace: ns.metadata.name,
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        app: `${APP_NAME}-login`,
      },
    },
    template: {
      metadata: {
        labels: {
          app: `${APP_NAME}-login`,
        },
      },
      spec: {
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
        },
        // Service-link variables are injected with enableServiceLinks=true (default)
        // and read by ZITADEL as configuration (viper.AutomaticEnv with prefix ZITADEL_).
        // Source: https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/zitadel.go
        //         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
        enableServiceLinks: false,
        // Init container: wait for the core zitadel to be ready.
        // Uses wait4x HTTP probe against the main zitadel service.
        // The /debug/ready path returns HTTP 200 when ZITADEL is ready.
        // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/_helpers.tpl
        //         (wait4x.image template) + deployment_login.yaml
        initContainers: [{
          name: 'wait-for-zitadel',
          image: 'docker.io/wait4x/wait4x:3.6@sha256:bec7ac18547781d854562c3729d3195c3880116d6758c49fdf4573ad58805f14',
          command: [
            'wait4x',
            'http',
            pulumi.interpolate`http://zitadel:${app.service.spec.ports[0].port}/debug/ready`,
            '--insecure-skip-tls-verify',
            '--h2c',
            '--no-redirect',
            '--expect-status-code',
            '200',
            '--timeout',
            '5m',
            '--interval',
            '5s',
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            runAsNonRoot: true,
            capabilities: {
              drop: ['ALL'],
            },
            seccompProfile: {
              type: 'RuntimeDefault',
            },
          },
        }],
        containers: [{
          name: `${APP_NAME}-login`,
          image: LOGIN_IMAGE,
          // The login image has its own entrypoint (Node.js / Next.js);
          // no command override is needed.
          ports: [{
            containerPort: LOGIN_PORT,
            name: 'http-server',
            protocol: 'TCP',
          }],
          env: [
            // Base path for the Next.js app (deployment_login.yaml).
            // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
            { name: 'NEXT_PUBLIC_BASE_PATH', value: '/ui/v2/login' },
            // The external domain for audience verification. The .env file
            // (configmap_login.yaml) uses this env var to render AUDIENCE
            // and CUSTOM_REQUEST_HEADERS values.
            // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/configmap_login.yaml
            {
              name: 'ZITADEL_EXTERNALDOMAIN',
              value: loginDomain,
            },
            // Session cookie secret for signing the Login UI session cookie.
            // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
            {
              name: 'ZITADEL_SESSION_COOKIE_SECRET',
              valueFrom: {
                secretKeyRef: { name: sessionCookieSecretResource.metadata.name, key: 'ZITADEL_SESSION_COOKIE_SECRET' },
              },
            },
          ],
          volumeMounts: [
            // .env file with login connection config (configmap_login.yaml).
            { name: 'login-config-dotenv', mountPath: '/.env-file', readOnly: true },
            { name: 'login-service-key', mountPath: '/login-service-key', readOnly: true },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            runAsNonRoot: true,
            capabilities: {
              drop: ['ALL'],
            },
            seccompProfile: {
              type: 'RuntimeDefault',
            },
          },
          // Probes: the login container exposes these paths on port 3000.
          // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/_helpers.tpl
          //         (login.livenessProbePath, login.readinessProbePath)
          readinessProbe: {
            httpGet: { path: '/ui/v2/login/ready', port: LOGIN_PORT },
            initialDelaySeconds: 5,
            periodSeconds: 10,
          },
          livenessProbe: {
            httpGet: { path: '/ui/v2/login/healthy', port: LOGIN_PORT },
            initialDelaySeconds: 5,
            periodSeconds: 30,
          },
        }],
        volumes: [
          { name: 'login-config-dotenv', configMap: { name: loginConfigMap.metadata.name } },
          { name: 'login-service-key', secret: { secretName: loginKeySecret.metadata.name, defaultMode: 0o440, items: [{ key: 'tls.key', path: 'tls.key' }] } },
        ],
        restartPolicy: 'Always',
      },
    },
  },
}, { dependsOn: [ns, loginKeySecret, sessionCookieSecretResource] });

// ---------------------------------------------------------------------------
// GitHub as a linkable identity provider (homelab#149 step 2)
// ---------------------------------------------------------------------------
// The Job zitadel-configure runs configure/configure.mjs against the REST admin API inside the cluster:
// it creates or updates the GitHub provider (linking allowed, no user creation), allows external
// identity providers in the default login policy and offers GitHub there. Idempotent.
// It authenticates as the service account homelab-deploy (Instance Owner, created once by the owner in
// the console) with its key from Pulumi ESC. Native gRPC does not pass the Cloudflare tunnel, so the
// Pulumi Zitadel provider is not used; the REST calls stay in the cluster.
// Sources: README.md, "## Upstream facts".

// node:24.22-alpine3.24 (LTS), multi-arch index digest from the registry API (2026-11-20).
const CONFIGURE_IMAGE =
  'docker.io/library/node:24.22-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5';
const configureScript = readFileSync(path.join(__dirname, '..', 'configure', 'configure.mjs'), 'utf8');
// SMTP of the Mailpit app (apps/mailpit, Service mailpit-smtp); Zitadel needs host:port (command/smtp.go).
const SMTP_HOST = 'mailpit-smtp.mailpit.svc.cluster.local:1025';
// Raise to run the Job again without a script change (e.g. after rotating a value in ESC).
const CONFIGURE_REVISION = 1;
// Zitadel users linked to their GitHub account (explicit, reviewable in PRs; Login V2 has no way to link
// an IdP to an existing, verified user afterwards): [{ userId, githubId, githubLogin }].
const githubLinks = JSON.stringify(cfg.getObject<unknown[]>('githubLinks') ?? []);
const configureHash = createHash('sha256')
  .update(`${CONFIGURE_REVISION}\n${githubLinks}\n${configureScript}`)
  .digest('hex')
  .slice(0, 8);

const githubIdpSecret = new k8s.apiextensions.CustomResource(`${APP_NAME}-github-idp`, {
  apiVersion: 'external-secrets.io/v1beta1',
  kind: 'ExternalSecret',
  metadata: { name: `${APP_NAME}-github-idp`, namespace: ns.metadata.name },
  spec: {
    refreshInterval: '1h',
    secretStoreRef: { name: 'pulumi-esc', kind: 'ClusterSecretStore' },
    target: { name: `${APP_NAME}-github-idp`, creationPolicy: 'Owner' },
    data: [
      { secretKey: 'deploy-key', remoteRef: { key: 'zitadelDeployKey' } },
      { secretKey: 'github-client-id', remoteRef: { key: 'zitadelGithubClientId' } },
      { secretKey: 'github-client-secret', remoteRef: { key: 'zitadelGithubClientSecret' } },
    ],
  },
}, { dependsOn: [ns] });

const configureConfigMap = new k8s.core.v1.ConfigMap(`${APP_NAME}-configure`, {
  metadata: { name: `${APP_NAME}-configure-${configureHash}`, namespace: ns.metadata.name },
  data: { 'configure.mjs': configureScript },
}, { dependsOn: [ns] });

const fromIdpSecret = (name: string, key: string) => ({
  name,
  valueFrom: { secretKeyRef: { name: `${APP_NAME}-github-idp`, key } },
});

// A new name per script hash: Pulumi replaces the Job (and waits for it to complete) when the
// script or CONFIGURE_REVISION changes; a completed Job is not run again otherwise.
const configureJob = new k8s.batch.v1.Job(`${APP_NAME}-configure`, {
  metadata: { name: `${APP_NAME}-configure-${configureHash}`, namespace: ns.metadata.name },
  spec: {
    backoffLimit: 2,
    ttlSecondsAfterFinished: 7 * 24 * 3600,
    template: {
      spec: {
        restartPolicy: 'Never',
        enableServiceLinks: false,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
        containers: [{
          name: 'configure',
          image: CONFIGURE_IMAGE,
          command: ['node', '/configure/configure.mjs'],
          securityContext: {
            allowPrivilegeEscalation: false,
            runAsNonRoot: true,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
            seccompProfile: { type: 'RuntimeDefault' },
          },
          env: [
            { name: 'ZITADEL_HOST', value: loginDomain },
            { name: 'ZITADEL_API_URL', value: pulumi.interpolate`http://zitadel:${app.service.spec.ports[0].port}` },
            fromIdpSecret('ZITADEL_DEPLOY_KEY', 'deploy-key'),
            fromIdpSecret('GITHUB_CLIENT_ID', 'github-client-id'),
            fromIdpSecret('GITHUB_CLIENT_SECRET', 'github-client-secret'),
            // Mail goes to the in-cluster Mailpit (apps/mailpit), read at https://mail.<domain>.
            { name: 'GITHUB_LINKS', value: githubLinks },
            { name: 'SMTP_HOST', value: SMTP_HOST },
            { name: 'SMTP_SENDER', value: pulumi.interpolate`zitadel@${domain}` },
          ],
          volumeMounts: [{ name: 'script', mountPath: '/configure', readOnly: true }],
          resources: { requests: { cpu: '10m', memory: '64Mi' }, limits: { memory: '128Mi' } },
        }],
        volumes: [{ name: 'script', configMap: { name: configureConfigMap.metadata.name } }],
      },
    },
  },
}, { dependsOn: [githubIdpSecret, configureConfigMap, app, setupJob], deleteBeforeReplace: true });

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const url = pulumi.interpolate`https://id.${domain}`;
export const namespace = APP_NAME;
