import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = 'librechat';
const NAMESPACE = APP_NAME;
const APP_PORT = 3080;
const CHART_VERSION = '2.0.8';
const CHART_APP_VERSION = 'v0.8.8-rc1';
const CHART = 'oci://ghcr.io/danny-avila/librechat-chart/librechat';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const cfg = new pulumi.Config(APP_NAME);
const homelabStackName = cfg.require('homelabStack');
const homelabStack = new pulumi.StackReference(homelabStackName);
const domain = homelabStack.getOutput('domain') as pulumi.Output<string>;

const image = cfg.get('image') ?? `ghcr.io/danny-avila/librechat:${CHART_APP_VERSION}`;
const domainPrefix = cfg.get('domainPrefix') ?? APP_NAME;
const appDomain = pulumi.interpolate`${domainPrefix}.${domain}`;

function parseImage(reference: string): { registry: string; repository: string; tag: string } {
  const lastSlash = reference.lastIndexOf('/');
  const tagSeparator = reference.indexOf(':', lastSlash);
  const name = tagSeparator === -1 ? reference : reference.substring(0, tagSeparator);
  const configuredTag = tagSeparator === -1 ? undefined : reference.substring(tagSeparator + 1);
  const parts = name.split('/');
  const hasRegistry = parts.length > 1 && (parts[0].includes('.') || parts[0] === 'localhost');
  const registry = hasRegistry ? parts.shift()! : 'docker.io';
  return {
    registry,
    repository: parts.join('/'),
    tag: configuredTag ?? CHART_APP_VERSION,
  };
}

const imageReference = parseImage(image);

// These values remain encrypted in Pulumi state and are only materialized in
// Kubernetes Secrets. In particular, passwords are not passed as Helm values.
const mongodbPassword = cfg.requireSecret('mongodbPassword');
const mongodbRootPassword = cfg.requireSecret('mongodbRootPassword');
const credsKey = cfg.requireSecret('credsKey');
const credsIv = cfg.requireSecret('credsIv');
const jwtSecret = cfg.requireSecret('jwtSecret');
const jwtRefreshSecret = cfg.requireSecret('jwtRefreshSecret');
const meiliMasterKey = cfg.requireSecret('meiliMasterKey');
const githubClientId = cfg.requireSecret('githubClientId');
const githubClientSecret = cfg.requireSecret('githubClientSecret');
const awsAccessKeyId = cfg.requireSecret('awsAccessKeyId');
const awsSecretAccessKey = cfg.requireSecret('awsSecretAccessKey');

const s3Endpoint = cfg.require('s3Endpoint');
const s3Bucket = cfg.require('s3Bucket');
const s3Region = cfg.get('s3Region') ?? 'auto';

// The MongoDB sub-chart creates the custom user in the LibreChat database.
// Keep this URI in the application Secret so the password never appears in
// rendered Helm values or a ConfigMap.
const encodedMongoPassword = mongodbPassword.apply(encodeURIComponent);
const mongoUri = pulumi.interpolate`mongodb://librechat:${encodedMongoPassword}@librechat-mongodb.${NAMESPACE}.svc.cluster.local:27017/LibreChat?authSource=LibreChat`;

// ---------------------------------------------------------------------------
// Namespace and ServiceAccounts
// ---------------------------------------------------------------------------

const ns = new k8s.core.v1.Namespace(`${APP_NAME}-ns`, {
  metadata: {
    name: NAMESPACE,
    labels: {
      app: APP_NAME,
      'pod-security.kubernetes.io/enforce': 'restricted',
      'pod-security.kubernetes.io/enforce-version': 'latest',
      'pod-security.kubernetes.io/warn': 'restricted',
      'pod-security.kubernetes.io/warn-version': 'latest',
    },
  },
});

const serviceAccounts = [
  ['app', 'librechat'],
  ['mongodb', 'librechat-mongodb'],
  ['meilisearch', 'librechat-meilisearch'],
].map(([resourceName, name]) => new k8s.core.v1.ServiceAccount(
  `${APP_NAME}-${resourceName}-sa`,
  {
    metadata: { name, namespace: NAMESPACE, labels: { app: APP_NAME } },
    automountServiceAccountToken: false,
  },
  { dependsOn: [ns] },
));

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const mongodbCredentials = new k8s.core.v1.Secret(
  `${APP_NAME}-mongodb-credentials`,
  {
    metadata: {
      name: `${APP_NAME}-mongodb-credentials`,
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    type: 'Opaque',
    // Bitnami requires these exact keys when auth.existingSecret is used.
    stringData: {
      'mongodb-passwords': mongodbPassword,
      'mongodb-root-password': mongodbRootPassword,
    },
  },
  { dependsOn: [ns] },
);

const credentials = new k8s.core.v1.Secret(
  `${APP_NAME}-credentials`,
  {
    metadata: {
      name: `${APP_NAME}-credentials-env`,
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    type: 'Opaque',
    stringData: {
      CREDS_KEY: credsKey,
      CREDS_IV: credsIv,
      JWT_SECRET: jwtSecret,
      JWT_REFRESH_SECRET: jwtRefreshSecret,
      MEILI_MASTER_KEY: meiliMasterKey,
      GITHUB_CLIENT_ID: githubClientId,
      GITHUB_CLIENT_SECRET: githubClientSecret,
      MONGO_URI: mongoUri,
      AWS_ACCESS_KEY_ID: awsAccessKeyId,
      AWS_SECRET_ACCESS_KEY: awsSecretAccessKey,
    },
  },
  { dependsOn: [ns, mongodbCredentials] },
);

// ---------------------------------------------------------------------------
// Official LibreChat Helm chart
// ---------------------------------------------------------------------------

const librechatYaml = `version: 1.3.14
cache: true
fileStrategy: s3
endpoints:
  custom:
    - name: Flinker
      apiKey: "not-needed"
      baseURL: http://flinker:8080/v1
      models:
        default:
          - qwen3.8-27b-fp4-mtp
        fetch: true
      titleConvo: true
      modelDisplayLabel: Flinker
`;

const chart = new k8s.helm.v3.Release(
  APP_NAME,
  {
    // Pinned: the chart's subresources (e.g. the mongodb Service referenced
    // by mongoUri below, and the Service targeted by the IngressRoute) are
    // named from the release name, so it must stay stable and match
    // APP_NAME rather than being auto-suffixed.
    name: APP_NAME,
    chart: CHART,
    version: CHART_VERSION,
    namespace: NAMESPACE,
    createNamespace: false,
    dependencyUpdate: false,
    values: {
      replicaCount: 1,
      image: {
        registry: imageReference.registry,
        repository: imageReference.repository,
        tag: imageReference.tag,
        pullPolicy: 'IfNotPresent',
      },
      imagePullSecrets: [{ name: 'ghcr-pull-secret' }],
      serviceAccount: {
        create: false,
        name: 'librechat',
        automount: false,
      },
      podSecurityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
        seccompProfile: { type: 'RuntimeDefault' },
      },
      resources: {
        requests: { cpu: '100m', memory: '256Mi' },
        limits: { cpu: '1000m', memory: '1Gi' },
      },
      service: {
        type: 'ClusterIP',
        port: APP_PORT,
        targetPort: APP_PORT,
        containerPort: APP_PORT,
      },
      ingress: { enabled: false },
      livenessProbe: {
        httpGet: { path: '/health', port: APP_PORT },
        initialDelaySeconds: 30,
        periodSeconds: 30,
      },
      readinessProbe: {
        httpGet: { path: '/health', port: APP_PORT },
        initialDelaySeconds: 10,
        periodSeconds: 10,
      },
      global: {
        librechat: {
          existingSecretName: `${APP_NAME}-credentials-env`,
          existingSecretApiKey: 'AWS_ACCESS_KEY_ID',
        },
      },
      librechat: {
        adminPanelUrl: pulumi.interpolate`https://${appDomain}`,
        configEnv: {
          DOMAIN_CLIENT: pulumi.interpolate`https://${appDomain}`,
          DOMAIN_SERVER: pulumi.interpolate`https://${appDomain}`,
          TRUST_PROXY: '1',
          ALLOW_EMAIL_LOGIN: 'false',
          ALLOW_REGISTRATION: 'false',
          ALLOW_SOCIAL_LOGIN: 'true',
          ALLOW_SOCIAL_REGISTRATION: 'true',
          GITHUB_CALLBACK_URL: '/oauth/github/callback',
          // Suppress the chart's generated non-secret URI. The actual value is
          // supplied by the existingSecretName envFrom below.
          MONGO_URI: '${MONGO_URI}',
          SEARCH: 'true',
          MEILI_NO_ANALYTICS: 'true',
          AWS_ENDPOINT_URL: s3Endpoint,
          AWS_BUCKET_NAME: s3Bucket,
          AWS_REGION: s3Region,
          AWS_FORCE_PATH_STYLE: 'false',
        },
        configYamlContent: librechatYaml,
        imageVolume: {
          enabled: true,
          size: '10Gi',
          accessModes: 'ReadWriteOnce',
          storageClassName: 'longhorn-uncritical',
        },
      },
      'librechat-rag-api': { enabled: false },
      mongodb: {
        enabled: true,
        architecture: 'standalone',
        auth: {
          enabled: true,
          existingSecret: `${APP_NAME}-mongodb-credentials`,
          usernames: ['librechat'],
          databases: ['LibreChat'],
        },
        persistence: {
          enabled: true,
          storageClass: 'longhorn-uncritical',
          size: '8Gi',
          accessModes: ['ReadWriteOnce'],
        },
        serviceAccount: {
          create: false,
          name: 'librechat-mongodb',
          automountServiceAccountToken: false,
        },
        podSecurityContext: {
          enabled: true,
          fsGroup: 1001,
          fsGroupChangePolicy: 'OnRootMismatch',
        },
        containerSecurityContext: {
          enabled: true,
          runAsUser: 1001,
          runAsGroup: 1001,
          runAsNonRoot: true,
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
          seccompProfile: { type: 'RuntimeDefault' },
        },
        resources: {
          requests: { cpu: '100m', memory: '256Mi' },
          limits: { cpu: '500m', memory: '768Mi' },
        },
      },
      meilisearch: {
        enabled: true,
        persistence: {
          enabled: true,
          storageClass: 'longhorn-uncritical',
          size: '8Gi',
          accessMode: 'ReadWriteOnce',
        },
        auth: { existingMasterKeySecret: `${APP_NAME}-credentials-env` },
        serviceAccount: {
          create: false,
          name: 'librechat-meilisearch',
        },
        podSecurityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          fsGroupChangePolicy: 'OnRootMismatch',
          seccompProfile: { type: 'RuntimeDefault' },
        },
        securityContext: {
          capabilities: { drop: ['ALL'] },
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        resources: {
          requests: { cpu: '50m', memory: '128Mi' },
          limits: { cpu: '500m', memory: '512Mi' },
        },
      },
      redis: { enabled: false },
    },
  },
  { dependsOn: [ns, ...serviceAccounts, credentials, mongodbCredentials] },
);

// ---------------------------------------------------------------------------
// Traefik / Cloudflare Tunnel route
// ---------------------------------------------------------------------------

// The chart's Ingress template cannot express the homelab's Traefik entrypoint
// convention. Cloudflare terminates TLS at the tunnel, so Traefik receives web
// traffic and forwards it to the chart Service on port 3080.
const route = new k8s.apiextensions.CustomResource(
  `${APP_NAME}-route`,
  {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: {
      name: APP_NAME,
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    spec: {
      entryPoints: ['web'],
      routes: [
        {
          match: pulumi.interpolate`Host(\`${appDomain}\`)`,
          kind: 'Rule',
          // The chart names the app Service "<release-name>-librechat",
          // not the bare release name (see the mongoUri comment above for
          // the same convention on the mongodb subchart).
          services: [{ name: `${APP_NAME}-librechat`, port: APP_PORT }],
        },
      ],
    },
  },
  { dependsOn: [chart] },
);

// ---------------------------------------------------------------------------
// Stack outputs
// ---------------------------------------------------------------------------

export const url = pulumi.interpolate`https://${appDomain}`;
export const namespace = NAMESPACE;
export const ingressRoute = route.metadata.name;
