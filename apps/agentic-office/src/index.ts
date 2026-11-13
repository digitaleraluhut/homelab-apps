import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { createAppNamespace } from '@mrsimpson/homelab-core-components';

// ---------------------------------------------------------------------------
// agentic-office hub (office-hub): https://github.com/mrsimpson/agentic-office
//
// Not built with createExposedWebApp: the hub speaks TLS only (its own self-signed certificate),
// but ExposedWebApp routes plain HTTP to its Service (port 80) and cannot set the Deployment
// strategy. This app therefore creates Deployment, Service and the Traefik route itself.
// See README.md ("Why not ExposedWebApp").
// ---------------------------------------------------------------------------

const APP_NAME = 'agentic-office';
const NAMESPACE = APP_NAME;
const APP_PORT = 8740;
// The image's user "office" (Dockerfile: useradd --uid 10001). fsGroup makes the PVC writable.
const RUN_AS = 10001;
const DATA_DIR = '/data';
const SIGNING_KEY = `${DATA_DIR}/signing.key`;
const DATA_CLAIM = `${APP_NAME}-data`;

const cfg = new pulumi.Config(APP_NAME);
const homelabStack = new pulumi.StackReference(cfg.require('homelabStack'));
const domain = homelabStack.getOutput('domain') as pulumi.Output<string>;

// Public image on ghcr.io (no pull secret). Key name ends in "Image" so the Renovate custom
// manager matches it in Pulumi.dev.yaml: `hubImage: ghcr.io/mrsimpson/agentic-office/office-hub:<tag>`.
const hubImage = cfg.require('hubImage');
const domainPrefix = cfg.get('domainPrefix') ?? 'office';
const storageSize = cfg.get('storageSize') ?? '5Gi';
const appDomain = pulumi.interpolate`${domainPrefix}.${domain}`;
// Behind the tunnel the hub is reached on 443 of the public name, not on its listen port.
const publicUrl = cfg.get('publicUrl') ?? pulumi.interpolate`https://${appDomain}`;
// First system admin: only used at the first start, the hub ignores it later. The public key is no secret.
const systemAdminId = cfg.require('systemAdminId');
const systemAdminPublicKey = cfg.require('systemAdminPublicKey');

// ---------------------------------------------------------------------------
// Namespace: created here, with the CI's deployer rights (createAppNamespace).
// ---------------------------------------------------------------------------

const { namespace: ns } = createAppNamespace(NAMESPACE);

const labels = { app: APP_NAME };

// ---------------------------------------------------------------------------
// Storage: /data holds users and keys, TLS certificate, the archive and the signing key.
// ---------------------------------------------------------------------------

new k8s.core.v1.PersistentVolumeClaim(DATA_CLAIM, {
  metadata: { name: DATA_CLAIM, namespace: ns.metadata.name, labels },
  spec: {
    accessModes: ['ReadWriteOnce'],
    storageClassName: 'longhorn-persistent',
    resources: { requests: { storage: storageSize } },
  },
});

// ---------------------------------------------------------------------------
// Deployment: one replica, Recreate (the volume is ReadWriteOnce, the hub is the only writer
// of its git archive, so old and new pod must never run at the same time).
// ---------------------------------------------------------------------------

const containerSecurity = {
  allowPrivilegeEscalation: false,
  runAsNonRoot: true,
  runAsUser: RUN_AS,
  runAsGroup: RUN_AS,
  capabilities: { drop: ['ALL'] },
  seccompProfile: { type: 'RuntimeDefault' },
};

// The hub never creates its signing key and refuses to start without it. Create it once; `keygen`
// writes the private key with mode 0600 and refuses to overwrite, the guard makes a restart a no-op.
// chmod 0400: the hub rejects a key that others can read. The container runs as the image's user
// (uid 10001), so the file is owned by it; the public key keygen prints is no secret.
const keygenInit = {
  name: 'signing-key',
  image: hubImage,
  command: ['sh', '-c'],
  args: [
    `if [ ! -e ${SIGNING_KEY} ]; then office-hub keygen ${SIGNING_KEY} && chmod 0400 ${SIGNING_KEY}; fi`,
  ],
  securityContext: { ...containerSecurity, readOnlyRootFilesystem: true },
  volumeMounts: [{ name: 'data', mountPath: DATA_DIR }],
  resources: {
    requests: { cpu: '10m', memory: '16Mi' },
    limits: { cpu: '100m', memory: '64Mi' },
  },
};

const deployment = new k8s.apps.v1.Deployment(
  APP_NAME,
  {
    metadata: { name: APP_NAME, namespace: ns.metadata.name, labels },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          securityContext: {
            runAsNonRoot: true,
            runAsUser: RUN_AS,
            runAsGroup: RUN_AS,
            fsGroup: RUN_AS,
          },
          initContainers: [keygenInit],
          containers: [
            {
              name: 'app',
              image: hubImage,
              // All flags are passed, as the image's CMD is replaced as a whole.
              args: [
                '-data-dir', DATA_DIR,
                '-addr', `0.0.0.0:${APP_PORT}`,
                '-signing-key', SIGNING_KEY,
                '-public-url', publicUrl,
                '-first-system-admin', pulumi.interpolate`${systemAdminId}=${systemAdminPublicKey}`,
              ],
              ports: [{ name: 'https', containerPort: APP_PORT }],
              securityContext: containerSecurity,
              resources: {
                requests: { cpu: '50m', memory: '128Mi' },
                limits: { cpu: '500m', memory: '512Mi' },
              },
              // The hub answers TLS only and needs a token for every call: TCP is the check that works.
              readinessProbe: {
                tcpSocket: { port: APP_PORT },
                initialDelaySeconds: 5,
                periodSeconds: 10,
              },
              livenessProbe: {
                tcpSocket: { port: APP_PORT },
                initialDelaySeconds: 30,
                periodSeconds: 30,
              },
              volumeMounts: [{ name: 'data', mountPath: DATA_DIR }],
            },
          ],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: DATA_CLAIM } }],
        },
      },
    },
  },
  { dependsOn: [ns] },
);

// ---------------------------------------------------------------------------
// Service on 8740 (TLS only) and the tunnel route.
// The tunnel sends plain HTTP to Traefik (entry point "web"); Traefik speaks TLS to the hub.
// The hub's certificate is self-signed for its own host names, so Traefik cannot verify it
// (ServersTransport insecureSkipVerify). This hop stays inside the cluster; the hub
// authenticates every call itself (key-based login), so no OAuth in front.
// ---------------------------------------------------------------------------

const service = new k8s.core.v1.Service(
  APP_NAME,
  {
    metadata: { name: APP_NAME, namespace: ns.metadata.name, labels },
    spec: {
      type: 'ClusterIP',
      selector: labels,
      ports: [{ name: 'https', port: APP_PORT, targetPort: APP_PORT, protocol: 'TCP' }],
    },
  },
  { dependsOn: [deployment] },
);

const transport = new k8s.apiextensions.CustomResource(
  `${APP_NAME}-transport`,
  {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'ServersTransport',
    metadata: { name: `${APP_NAME}-tls`, namespace: ns.metadata.name },
    spec: { insecureSkipVerify: true },
  },
  { dependsOn: [ns] },
);

new k8s.apiextensions.CustomResource(
  `${APP_NAME}-route`,
  {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: { name: APP_NAME, namespace: ns.metadata.name },
    spec: {
      // Cloudflare terminates the public TLS; the tunnel delivers HTTP to the "web" entry point.
      entryPoints: ['web'],
      routes: [
        {
          match: pulumi.interpolate`Host(\`${appDomain}\`)`,
          kind: 'Rule',
          services: [
            {
              name: service.metadata.name,
              port: APP_PORT,
              scheme: 'https',
              serversTransport: transport.metadata.name,
            },
          ],
        },
      ],
    },
  },
  { dependsOn: [service, transport] },
);

export const url = pulumi.interpolate`https://${appDomain}`;
export const namespace = NAMESPACE;
