import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
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
const firstAdminPassword = pulumi.secret(
  new random.RandomPassword('first-admin-password', { length: 24, special: true }).result,
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
// Runtime configuration as a ConfigMap (mounted at /config/zitadel.yaml)
// ---------------------------------------------------------------------------

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
`,
  },
}, { dependsOn: [ns] });

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
    ],
    extraVolumeMounts: [
      { name: 'config', mountPath: '/config/zitadel.yaml', subPath: 'zitadel.yaml', readOnly: true },
      { name: 'masterkey', mountPath: '/masterkey', readOnly: true },
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
    tags: ['zitadel', 'auth', 'oidc'],
  },
  { dependsOn: [ns, setupJob] },
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const url = pulumi.interpolate`https://id.${domain}`;
export const namespace = APP_NAME;
