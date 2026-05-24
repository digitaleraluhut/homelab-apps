import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import { AuthType, type ExposedWebAppArgs } from '@mrsimpson/homelab-core-components';
import type { HomelabContext } from '@mrsimpson/homelab-core-components';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConduitArgs {
  /** Pulumi homelab context (provides createExposedWebApp) */
  homelab: HomelabContext;
  /** Pre-created namespace resource */
  namespace: k8s.core.v1.Namespace;
  /** Conduit container image */
  image: string;
  /** Matrix server_name — IMMUTABLE after first run (baked into Matrix IDs) */
  serverName: pulumi.Output<string>;
  /** Fully-qualified domain name exposed via Cloudflare Tunnel */
  domain: pulumi.Output<string>;
  /** Conduit admin token (for registration API) — stored as k8s Secret */
  adminToken: pulumi.Output<string>;
  /** Which appservices to mount (default: all). Bridges are skipped if their tokens are not set. */
  enabledAppservices?: string[];
}

export interface ConduitOutputs {
  /** In-cluster base URL for the homeserver: http://conduit.matrix.svc.cluster.local (port 80 via Service) */
  inClusterUrl: pulumi.Output<string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPONENT = 'conduit';
const CONDUIT_PORT = 6167;
const LABELS = {
  'app.kubernetes.io/name': COMPONENT,
  'app.kubernetes.io/part-of': 'matrix-pipeline',
};

// ---------------------------------------------------------------------------
// deployConduit
// ---------------------------------------------------------------------------

/**
 * Deploys the Conduit Matrix homeserver as a StatefulSet with:
 * - RocksDB data on a 20 Gi PVC (longhorn-persistent)
 * - Appservice registration YAMLs mounted from pre-existing k8s Secrets
 *   (conduit-appservice-whatsapp, conduit-appservice-signal)
 * - Internet exposure via createExposedWebApp (Cloudflare Tunnel)
 *
 * IMPORTANT: `server_name` is permanently baked into Matrix IDs.
 * Set it to `matrix.<domain>` before the first `pulumi up` and never change it.
 *
 * Bootstrap:
 *   1. kubectl create secret -n matrix conduit-appservice-whatsapp --from-file=registration.yaml
 *   2. kubectl create secret -n matrix conduit-appservice-signal   --from-file=registration.yaml
 *   3. pulumi up
 */
export function deployConduit(args: ConduitArgs): ConduitOutputs {
  const ns = args.namespace;
  const nsName = ns.metadata.name;
  const enabled = args.enabledAppservices ?? ['whatsapp', 'signal'];

  // ---------------------------------------------------------------------------
  // ServiceAccount — automount disabled; Conduit needs no k8s API access
  // ---------------------------------------------------------------------------

  const sa = new k8s.core.v1.ServiceAccount(
    `${COMPONENT}-sa`,
    {
      metadata: {
        name: COMPONENT,
        namespace: nsName,
        labels: LABELS,
      },
      automountServiceAccountToken: false,
    },
    { dependsOn: [ns] },
  );

  // ---------------------------------------------------------------------------
  // ConfigMap — conduit.toml (non-secret configuration)
  // Federation disabled; registration disabled; appservices mounted from Secrets.
  // ---------------------------------------------------------------------------

  // Build appservice_config_files list dynamically based on enabled bridges
  const appserviceFiles = [
    ...(enabled.includes('whatsapp') ? ['    "/var/lib/conduit/appservices/whatsapp/registration.yaml"'] : []),
    ...(enabled.includes('signal') ? ['    "/var/lib/conduit/appservices/signal/registration.yaml"'] : []),
  ];
  const appserviceConfigSection = appserviceFiles.length > 0
    ? `\n# Appservice registration files are mounted from k8s Secrets into this directory.\n# Each file must be named *.yaml and contain a valid appservice registration.\nappservice_config_files = [\n${appserviceFiles.join(',\n')}\n]`
    : '';

  // conduit.toml is stored as a Secret (not ConfigMap) because it contains
  // emergency_password — the credential used to log in as @conduit:<server_name>
  // for admin room access during bootstrap.
  const configMap = new k8s.core.v1.Secret(
    `${COMPONENT}-config`,
    {
      metadata: {
        name: `${COMPONENT}-config`,
        namespace: nsName,
        labels: LABELS,
      },
      type: 'Opaque',
      stringData: {
        'conduit.toml': pulumi.interpolate`[global]
server_name = "${args.serverName}"
database_path = "/var/lib/conduit/db"
database_backend = "rocksdb"
port = ${CONDUIT_PORT}
max_request_size = 20_000_000  # 20 MB — sufficient for voice message media
allow_registration = false
allow_guest_registration = false
allow_federation = false
allow_public_rooms_without_login = false
allow_public_rooms_over_federation = false
trusted_servers = []
# Must be 0.0.0.0 in a container — default 127.0.0.1 is loopback-only and
# prevents k8s readiness/liveness probes from reaching the pod IP.
address = "0.0.0.0"
# emergency_password enables login as @conduit:<server_name> for admin room access.
# Used once during bootstrap to register the bot user; keep set so admin room stays accessible.
emergency_password = "${args.adminToken}"

# Media storage — explicit filesystem backend
[global.media]
backend = "filesystem"
path = "/var/lib/conduit/db/media"
${appserviceConfigSection}
`,
      },
    },
    { dependsOn: [ns] },
  );

  // ---------------------------------------------------------------------------
  // Secret — admin token (used by CI/bootstrap scripts to register the bot user)
  // ---------------------------------------------------------------------------

  const adminSecret = new k8s.core.v1.Secret(
    `${COMPONENT}-admin`,
    {
      metadata: {
        name: `${COMPONENT}-admin`,
        namespace: nsName,
        labels: LABELS,
      },
      type: 'Opaque',
      stringData: {
        CONDUIT_ADMIN_TOKEN: args.adminToken,
      },
    },
    { dependsOn: [ns] },
  );

  // ---------------------------------------------------------------------------
  // PVC — RocksDB data store (longhorn-persistent: replicated, important data)
  // ---------------------------------------------------------------------------

  const pvc = new k8s.core.v1.PersistentVolumeClaim(
    `${COMPONENT}-pvc`,
    {
      metadata: {
        name: `${COMPONENT}-data`,
        namespace: nsName,
        labels: LABELS,
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'longhorn-persistent',
        resources: { requests: { storage: '20Gi' } },
      },
    },
    { dependsOn: [ns] },
  );

  // ---------------------------------------------------------------------------
  // ExposedWebApp — Conduit is the only internet-facing component.
  // AuthType.NONE: Matrix clients authenticate via Matrix protocol, not HTTP auth.
  // ---------------------------------------------------------------------------

  const conduitApp = args.homelab.createExposedWebApp(
    COMPONENT,
    {
      namespace: ns,
      image: args.image,
      domain: args.domain,
      port: CONDUIT_PORT,
      replicas: 1,
      auth: AuthType.NONE,
      serviceAccountName: COMPONENT,
      securityContext: {
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
      },
      resources: {
        requests: { cpu: '50m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
      },
      // Override default storage PVC — we manage the StatefulSet-style PVC ourselves
      // for finer control (storageClass: longhorn-persistent, not longhorn-uncritical).
      // The main conduit-data PVC is mounted via extraVolumes.
      extraVolumes: [
        {
          name: 'conduit-data',
          persistentVolumeClaim: { claimName: `${COMPONENT}-data` },
        },
        {
          name: 'conduit-config',
          secret: { secretName: `${COMPONENT}-config` },
        },
        // Appservice registration YAMLs — only mount when bridge tokens are configured.
        ...(enabled.includes('whatsapp')
          ? [{
              name: 'appservice-whatsapp',
              secret: { secretName: 'conduit-appservice-whatsapp', optional: true },
            }]
          : []),
        ...(enabled.includes('signal')
          ? [{
              name: 'appservice-signal',
              secret: { secretName: 'conduit-appservice-signal', optional: true },
            }]
          : []),
      ],
      extraVolumeMounts: [
        { name: 'conduit-data', mountPath: '/var/lib/conduit/db' },
        { name: 'conduit-config', mountPath: '/etc/conduit', readOnly: true },
        ...(enabled.includes('whatsapp')
          ? [{ name: 'appservice-whatsapp', mountPath: '/var/lib/conduit/appservices/whatsapp', readOnly: true }]
          : []),
        ...(enabled.includes('signal')
          ? [{ name: 'appservice-signal', mountPath: '/var/lib/conduit/appservices/signal', readOnly: true }]
          : []),
      ],
      // Init container to create media directory with correct permissions
      initContainers: [
        {
          name: 'create-media-dir',
          image: 'busybox:1.36',
          command: ['sh', '-c', 'mkdir -p /var/lib/conduit/db/media && chown 1000:1000 /var/lib/conduit/db/media'],
          volumeMounts: [
            { name: 'conduit-data', mountPath: '/var/lib/conduit/db' },
          ],
          securityContext: {
            runAsUser: 0,
            runAsGroup: 0,
          },
        },
      ],
      env: [
        // Conduit reads its config from CONDUIT_CONFIG env var
        { name: 'CONDUIT_CONFIG', value: '/etc/conduit/conduit.toml' },
        // k8s auto-injects CONDUIT_PORT=tcp://<clusterIP>:<port> from the Service named "conduit"
        // in the same namespace. Conduit's env-var config parser reads CONDUIT_<FIELD> vars, so
        // it tries to parse that URL string as a u16 port number and crashes. Override it
        // explicitly with the correct integer value so our setting wins.
        { name: 'CONDUIT_PORT', value: String(CONDUIT_PORT) },
      ],
      probes: {
        readinessProbe: {
          httpGet: { path: '/_matrix/client/versions', port: CONDUIT_PORT },
          initialDelaySeconds: 30,
          periodSeconds: 15,
          failureThreshold: 6,  // 90 s window total
        },
        livenessProbe: {
          // Conduit first-boot initialises RocksDB + admin room; allow 2 min before killing.
          httpGet: { path: '/_matrix/client/versions', port: CONDUIT_PORT },
          initialDelaySeconds: 120,
          periodSeconds: 30,
          failureThreshold: 5,
        },
      },
    } satisfies Omit<ExposedWebAppArgs, 'tls' | 'gatewayApi' | 'externalSecrets'>,
    { dependsOn: [ns, sa, configMap, pvc] },
  );

  return {
    // The Service exposes port 80 → 6167; use the Service port (80) so bridges connect via the Service.
    inClusterUrl: pulumi.interpolate`http://${COMPONENT}.${nsName}.svc.cluster.local`,
  };
}
