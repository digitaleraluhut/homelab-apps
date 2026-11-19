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
// Login V2 Deployment
// ---------------------------------------------------------------------------
// Login V2 is a separate Next.js application that handles the user-facing
// authentication interface (login, registration, password reset). It runs
// on the same container image as the core but starts the Next.js dev server.
//
// Authentication to the core: X.509 certificate-based JWT authentication
// via ZITADEL's SystemAPIUsers mechanism. The login container mounts the
// private key and uses it to sign JWTs; the core verifies them with the
// public cert (mounted at /secrets/login-client/tls.crt).
//
// The init container waits for the core zitadel to be ready before the login
// UI starts, preventing a race condition.
//
// Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
//         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/_helpers.tpl
//         (login.containerPort = 3000, livenessProbePath, readinessProbePath)
//         https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/configmap_login.yaml
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
        // Init container: wait for the core zitadel to be ready.
        // Uses wait-for-zitadel HTTP probe against the main zitadel service.
        // The /debug/healthz path uses HTTP/1.1 (no h2c needed).
        // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
        //         (wait-for-zitadel initContainer)
        initContainers: [{
          name: 'wait-for-zitadel',
          image: 'docker.io/lovoo/wait-for-it:latest',
          command: ['sh', '-c', 'until curl -sf http://zitadel:8080/debug/healthz; do echo "waiting for zitadel"; sleep 2; done;'],
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
          image: DEFAULT_IMAGE,
          // The login container uses the zitadel binary to start the Next.js
          // app. The binary entrypoint detects the login command and starts
          // the Next.js development server on port 3000.
          command: ['/app/zitadel', 'login', 'start'],
          ports: [{
            containerPort: LOGIN_PORT,
            name: 'http-server',
            protocol: 'TCP',
          }],
          env: [
            // Base path for the Next.js app.
            // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/deployment_login.yaml
            { name: 'NEXT_PUBLIC_BASE_PATH', value: '/ui/v2/login' },
            // The external domain for audience verification.
            // Source: https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/configmap_login.yaml
            //         (AUDIENCE uses ${ZITADEL_EXTERNALDOMAIN})
            {
              name: 'ZITADEL_EXTERNALDOMAIN',
              value: pulumi.interpolate`id.${domain}`,
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
          { name: 'login-service-key', secret: { secretName: loginKeySecret.metadata.name, defaultMode: 0o440, items: [{ key: 'tls.key', path: 'tls.key' }] } },
        ],
        restartPolicy: 'Always',
      },
    },
  },
}, { dependsOn: [ns, loginKeySecret, sessionCookieSecretResource] });

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const url = pulumi.interpolate`https://id.${domain}`;
export const namespace = APP_NAME;
