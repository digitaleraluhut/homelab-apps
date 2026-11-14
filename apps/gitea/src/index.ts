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
// Database credentials use valueFrom to map PostgresInstance env vars
// (POSTGRES_USER, POSTGRES_PASSWORD) to the GITEA__database__USER/PASSWD
// names Gitea reads (config cheat sheet, section database).
type GiteaEnvVar = { name: string; value?: string | pulumi.Output<string>; valueFrom?: { secretKeyRef: { name: pulumi.Input<string>; key: string } } };
// The env array includes valueFrom entries which the ExposedWebAppArgs type
// doesn't declare, but the underlying Pulumi Kubernetes provider supports.
const giteaEnv: GiteaEnvVar[] = [
  // Database — env vars map to GITEA__database__* which the Docker entrypoint
  // writes into /etc/gitea/app.ini on startup.
  { name: 'GITEA__database__DB_TYPE', value: 'postgres' },
  { name: 'GITEA__database__HOST', value: `${APP_NAME}-db-postgres-rw:5432` },
  { name: 'GITEA__database__NAME', value: APP_NAME },
  { name: 'GITEA__database__USER', valueFrom: { secretKeyRef: { name: db.credentialsSecretName, key: 'POSTGRES_USER' } } },
  { name: 'GITEA__database__PASSWD', valueFrom: { secretKeyRef: { name: db.credentialsSecretName, key: 'POSTGRES_PASSWORD' } } },
  // Server — ROOT_URL must match what the IngressRoute/HTTPRoute exposes.
  { name: 'GITEA__server__ROOT_URL', value: pulumi.interpolate`https://${APP_NAME}.${domain}` },
  { name: 'GITEA__server__DISABLE_SSH', value: 'true' },
  // Registration disabled; only invited accounts.
  { name: 'GITEA__service__DISABLE_REGISTRATION', value: 'true' },
  // Everything except the login page (and /api/healthz) requires an account, the API included:
  // no anonymous browsing of users or repositories (modules/setting/service.go, v28.3.0).
  { name: 'GITEA__service__REQUIRE_SIGNIN_VIEW', value: 'true' },
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
    // One writer: the data volume is ReadWriteOnce and Gitea locks its queue database in it, so a
    // rolling update (new pod next to the old one) crash-loops with "unable to lock level db".
    strategy: 'Recreate',
    auth: AuthType.NONE, // No auth — Gitea's own accounts; owner creates admin after deploy.
    securityContext: { runAsUser: RUN_AS, runAsGroup: RUN_AS, fsGroup: RUN_AS },
    env: giteaEnv as any,
    // Storage: PVC mounted at data and config directories.
    // Both /var/lib/gitea and /etc/gitea are VOLUMEs in Dockerfile.rootless;
    // the rootless docker-compose docs mount them as separate volumes.
    extraVolumes: [{ name: 'data', persistentVolumeClaim: { claimName: DATA_CLAIM } }],
    extraVolumeMounts: [
      { name: 'data', mountPath: DATA_MOUNT },
      { name: 'data', mountPath: CONFIG_MOUNT },
    ],
    probes: {
      readinessProbe: {
        httpGet: { path: '/api/healthz', port: APP_PORT },
        initialDelaySeconds: 10,
        periodSeconds: 10,
      },
      livenessProbe: {
        httpGet: { path: '/api/healthz', port: APP_PORT },
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
