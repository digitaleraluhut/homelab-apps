import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import {
  AuthType,
  createAppNamespace,
  createHomelabContextFromStack,
  PostgresInstance,
} from '@mrsimpson/homelab-core-components';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = 'gitea';
const APP_PORT = 3000; // Gitea HTTP port (rootless image)

// Pinned rootless image digest (looked up on Docker Hub).
// Source: https://hub.docker.com/v2/repositories/gitea/gitea/tags/28.3.0-rootless
const DEFAULT_IMAGE =
  'docker.io/gitea/gitea:28.3.0-rootless@sha256:40c5a68a0463c0940e1ae32626c8300dd0572f3558e390073ad8379ca67c0e1d';

// Gitea rootless runs as UID 1000 (git user).
// Source: https://raw.githubusercontent.com/go-gitea/gitea/v28.3.0/Dockerfile.rootless
const RUN_AS = 1000;

// Gitea rootless data and config directories.
// Source: https://docs.gitea.com/installation/install-with-docker-rootless
const DATA_MOUNT = '/var/lib/gitea';
const CONFIG_MOUNT = '/etc/gitea';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const cfg = new pulumi.Config(APP_NAME);
const homelabStack = new pulumi.StackReference(cfg.require('homelabStack'));
const domain = homelabStack.getOutput('domain') as pulumi.Output<string>;
const homelab = createHomelabContextFromStack(homelabStack);

// Get the CNPG operator from the homelab stack for dependency ordering.
const cnpgOperator = homelabStack.getOutput('cnpg') as unknown as k8s.helm.v3.Release;

const image = cfg.get('image') ?? DEFAULT_IMAGE;

// ---------------------------------------------------------------------------
// Namespace: created here, with the CI's deployer rights (createAppNamespace).
// ---------------------------------------------------------------------------

const { namespace: ns } = createAppNamespace(APP_NAME);

const labels = { app: APP_NAME };

// ---------------------------------------------------------------------------
// Database: CloudNativePG-managed PostgreSQL
// ---------------------------------------------------------------------------

const db = new PostgresInstance(`${APP_NAME}-db`, {
  namespace: ns,
  databaseName: APP_NAME,
  storageSize: '5Gi',
  cnpgOperator: cnpgOperator,
});

// ---------------------------------------------------------------------------
// PVC for persistent data (GITEA_WORK_DIR = /var/lib/gitea)
// ---------------------------------------------------------------------------

const DATA_CLAIM = `${APP_NAME}-data`;

new k8s.core.v1.PersistentVolumeClaim(DATA_CLAIM, {
  metadata: { name: DATA_CLAIM, namespace: ns.metadata.name, labels },
  spec: {
    accessModes: ['ReadWriteOnce'],
    storageClassName: 'longhorn-persistent',
    resources: { requests: { storage: '5Gi' } },
  },
});

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

// Gitea environment variables via GITEA__<section>__<KEY> convention.
// Source: https://docs.gitea.com/administration/config-cheat-sheet
// Database credentials come from envFrom (the adapter secret).
// Other settings are passed as direct env vars.
const giteaEnv: Array<{ name: string; value: string | pulumi.Output<string> }> = [
  // Database — env vars map to GITEA__database__* which the Docker entrypoint
  // writes into /etc/gitea/app.ini on startup.
  { name: 'GITEA__database__DB_TYPE', value: 'postgres' },
  { name: 'GITEA__database__HOST', value: `${APP_NAME}-db-postgres-rw:5432` },
  { name: 'GITEA__database__NAME', value: APP_NAME },
  // USER and PASSWD come from the adapter secret via envFrom.
  // Server — ROOT_URL must match what the IngressRoute/HTTPRoute exposes.
  { name: 'GITEA__server__ROOT_URL', value: pulumi.interpolate`https://${APP_NAME}.${domain}` },
  { name: 'GITEA__server__DISABLE_SSH', value: 'true' },
  // Registration disabled; only invited accounts.
  { name: 'GITEA__service__DISABLE_REGISTRATION', value: 'true' },
  // Lock the first-run installer immediately — prevents anyone from creating an admin.
  { name: 'GITEA__security__INSTALL_LOCK', value: 'true' },
];

const app = homelab.createExposedWebApp(
  APP_NAME,
  {
    namespace: ns,
    image,
    domain: pulumi.interpolate`${APP_NAME}.${domain}`,
    port: APP_PORT,
    replicas: 1,
    auth: AuthType.NONE, // No auth — Gitea's own accounts; owner creates admin after deploy.
    securityContext: { runAsUser: RUN_AS, runAsGroup: RUN_AS, fsGroup: RUN_AS },
    env: giteaEnv,
    envFrom: [{ secretRef: { name: db.credentialsSecretName } }],
    // Storage: the PVC mounted at the data directory.
    extraVolumes: [{ name: 'data', persistentVolumeClaim: { claimName: DATA_CLAIM } }],
    extraVolumeMounts: [{ name: 'data', mountPath: DATA_MOUNT }],
    probes: {
      readinessProbe: {
        httpGet: { path: '/api/health', port: APP_PORT },
        initialDelaySeconds: 10,
        periodSeconds: 10,
      },
      livenessProbe: {
        httpGet: { path: '/api/health', port: APP_PORT },
        initialDelaySeconds: 30,
        periodSeconds: 30,
      },
    },
    tags: ['gitea', 'git'],
  },
  { dependsOn: [ns] },
);

// ---------------------------------------------------------------------------
// NodePort for SSH-disabled but still needed internal SSH (port 2222 in container)
// Gitea's builtin SSH server listens on 2222 in the rootless image.
// Owner accesses Gitea from host via the NodePort for SSH git operations if needed.
// We expose only HTTP (3000) through NodePort 30300 as requested.
// ---------------------------------------------------------------------------

new k8s.core.v1.Service(
  `${APP_NAME}-nodeport`,
  {
    metadata: { name: `${APP_NAME}-nodeport`, namespace: ns.metadata.name, labels },
    spec: {
      type: 'NodePort',
      selector: app.deployment.spec.selector.matchLabels,
      ports: [
        { name: 'http', port: APP_PORT, targetPort: APP_PORT, nodePort: 30300 },
      ],
    },
  },
  { dependsOn: [app.deployment] },
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const url = pulumi.interpolate`https://${APP_NAME}.${domain}`;
export const namespace = APP_NAME;
