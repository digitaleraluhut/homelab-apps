import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

// ---------------------------------------------------------------------------
// agentic-office hub (https://github.com/mrsimpson/agentic-office)
//
// Deliberately NOT public: the hub speaks only TLS (self-signed certificate) and authenticates
// with its own Ed25519 keys and tokens. It is reachable inside the cluster only
// (https://office-hub.<namespace>.svc:8740). Public exposure is an open owner decision, see README.
// ---------------------------------------------------------------------------

const APP_NAME = 'agentic-office';
const NAMESPACE = APP_NAME;
const PORT = 8740;
const UID = 10001; // `office` user of the image

const cfg = new pulumi.Config(APP_NAME);
const hubImage = cfg.require('hubImage');
// Optional: content of the admin key file (see the hub's identity.LoadAdmins). Without it nobody can
// register keys. Public keys only, no secrets.
const admins = cfg.get('admins');

// Namespace is created by the homelab stack (appNamespaces); only referenced here.
const ns = k8s.core.v1.Namespace.get(`${APP_NAME}-ns`, NAMESPACE);

const labels = { app: 'office-hub' };

const data = new k8s.core.v1.PersistentVolumeClaim(
  'office-hub-data',
  {
    metadata: { name: 'office-hub-data', namespace: NAMESPACE, labels },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: 'longhorn',
      resources: { requests: { storage: '5Gi' } },
    },
  },
  { dependsOn: [ns] },
);

const adminsMap = admins
  ? new k8s.core.v1.ConfigMap(
      'office-hub-admins',
      { metadata: { name: 'office-hub-admins', namespace: NAMESPACE, labels }, data: { admins } },
      { dependsOn: [ns] },
    )
  : undefined;

const sec = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
  runAsUser: UID,
  capabilities: { drop: ['ALL'] },
  seccompProfile: { type: 'RuntimeDefault' },
};

const dataMount = { name: 'data', mountPath: '/data' };
const tmpMount = { name: 'tmp', mountPath: '/tmp' };

const deployment = new k8s.apps.v1.Deployment(
  'office-hub',
  {
    metadata: { name: 'office-hub', namespace: NAMESPACE, labels },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' }, // RWO volume, single writer
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          securityContext: { fsGroup: UID },
          initContainers: [
            {
              // The hub requires a signing key; create it once, keep it on the volume.
              name: 'keygen',
              image: hubImage,
              command: ['sh', '-c', 'test -f /data/signing.key || office-hub keygen /data/signing.key'],
              securityContext: sec,
              volumeMounts: [dataMount, tmpMount],
            },
          ],
          containers: [
            {
              name: 'office-hub',
              image: hubImage,
              args: [
                '-data-dir', '/data',
                '-addr', `0.0.0.0:${PORT}`,
                '-signing-key', '/data/signing.key',
                '-tls-hosts', `localhost,office-hub,office-hub.${NAMESPACE},office-hub.${NAMESPACE}.svc,office-hub.${NAMESPACE}.svc.cluster.local`,
                '-public-url', `https://office-hub.${NAMESPACE}.svc:${PORT}`,
              ],
              ports: [{ containerPort: PORT, name: 'https' }],
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '500m', memory: '256Mi' },
              },
              // The hub only speaks TLS; a TCP probe avoids certificate handling.
              readinessProbe: { tcpSocket: { port: PORT }, initialDelaySeconds: 3, periodSeconds: 10 },
              livenessProbe: { tcpSocket: { port: PORT }, initialDelaySeconds: 10, periodSeconds: 30 },
              securityContext: sec,
              volumeMounts: [
                dataMount,
                tmpMount,
                ...(adminsMap ? [{ name: 'admins', mountPath: '/data/admins', subPath: 'admins', readOnly: true }] : []),
              ],
            },
          ],
          volumes: [
            { name: 'data', persistentVolumeClaim: { claimName: data.metadata.name } },
            { name: 'tmp', emptyDir: {} },
            ...(adminsMap ? [{ name: 'admins', configMap: { name: 'office-hub-admins' } }] : []),
          ],
        },
      },
    },
  },
  { dependsOn: [ns] },
);

new k8s.core.v1.Service(
  'office-hub',
  {
    metadata: { name: 'office-hub', namespace: NAMESPACE, labels },
    spec: { type: 'ClusterIP', selector: labels, ports: [{ name: 'https', port: PORT, targetPort: PORT }] },
  },
  { dependsOn: [deployment] },
);

export const namespace = NAMESPACE;
export const internalUrl = `https://office-hub.${NAMESPACE}.svc:${PORT}`;
