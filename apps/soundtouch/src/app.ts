import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { createAppNamespace } from '@mrsimpson/homelab-core-components';

/**
 * AfterTouch (upstream gesellix/Bose-SoundTouch): local replacement for the Bose SoundTouch
 * cloud. Speakers are migrated to SERVER_URL and talk to it directly over the LAN.
 *
 * LAN only, without Traefik and without a DNS record:
 * - Traefik (a Go proxy) rewrites the response header "ETag" to "Etag"; the speaker firmware
 *   then ignores it and preset sync breaks. A TCP passthrough avoids that but hides the
 *   speaker's IP, which the server uses to push credentials back (no PROXY protocol support).
 * - A NodePort with externalTrafficPolicy Local keeps both: bytes untouched, source IP kept.
 * Multicast discovery does not leave the pod network; speakers are found by a unicast scan of
 * DISCOVERY_SUBNETS instead.
 */

const APP_NAME = 'soundtouch';
// Before raising the version, read the upstream release notes in between
// (https://github.com/gesellix/Bose-SoundTouch/releases) and snapshot the data volume.
const IMAGE =
  'ghcr.io/gesellix/bose-soundtouch:0.139.0@sha256:4ce91e437b3105689817b0836339ae5cdf3bccbac7c811b6ac52be045587edb5';
const HTTP_PORT = 8000;
const HTTPS_PORT = 8443;
// Part of the address each speaker is migrated to: changing one means re-migrating every speaker.
const NODE_PORT_HTTP = 30880;
const NODE_PORT_HTTPS = 30883;
// The image defaults to root but ships this unprivileged user.
const RUN_AS = 65532;
const DATA_CLAIM = `${APP_NAME}-data`;

export function deploySoundtouch() {
  const cfg = new pulumi.Config(APP_NAME);
  const serverHost = cfg.require('serverHost');
  const mgmtUsername = cfg.requireSecret('mgmtUsername');
  const mgmtPassword = cfg.requireSecret('mgmtPassword');
  const discoverySubnets = cfg.get('discoverySubnets');

  const serverUrl = `http://${serverHost}:${NODE_PORT_HTTP}`;
  const httpsServerUrl = `https://${serverHost}:${NODE_PORT_HTTPS}`;
  const labels = { app: APP_NAME };

  const { namespace: ns } = createAppNamespace(APP_NAME);

  const mgmt = new k8s.core.v1.Secret(`${APP_NAME}-mgmt`, {
    metadata: { name: `${APP_NAME}-mgmt`, namespace: ns.metadata.name, labels },
    type: 'Opaque',
    stringData: { MGMT_USERNAME: mgmtUsername, MGMT_PASSWORD: mgmtPassword },
  });

  // Holds settings, device state and the CA the speakers trust: losing it means re-migrating them.
  new k8s.core.v1.PersistentVolumeClaim(`${APP_NAME}-data`, {
    metadata: { name: DATA_CLAIM, namespace: ns.metadata.name, labels },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: 'longhorn-persistent',
      resources: { requests: { storage: '500Mi' } },
    },
  });

  // On first start the server copies these into settings.json; afterwards settings.json wins.
  const env: k8s.types.input.core.v1.EnvVar[] = [
    { name: 'SERVER_URL', value: serverUrl },
    { name: 'HTTPS_SERVER_URL', value: httpsServerUrl },
    ...(discoverySubnets
      ? [
          { name: 'DISCOVERY_SUBNETS', value: discoverySubnets },
          { name: 'DISCOVERY_SCAN_INTERVAL', value: '1h' },
        ]
      : []),
  ];

  const deployment = new k8s.apps.v1.Deployment(
    APP_NAME,
    {
      metadata: { name: APP_NAME, namespace: ns.metadata.name, labels },
      spec: {
        replicas: 1,
        // ReadWriteOnce volume: the old pod must let go before the new one mounts it.
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
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'app',
                image: IMAGE,
                ports: [
                  { name: 'http', containerPort: HTTP_PORT },
                  { name: 'https', containerPort: HTTPS_PORT },
                ],
                env,
                envFrom: [{ secretRef: { name: mgmt.metadata.name } }],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  // The binary carries the file capability cap_net_bind_service=+ep; without it
                  // in the bounding set exec fails with EPERM. "restricted" allows this one.
                  capabilities: { drop: ['ALL'], add: ['NET_BIND_SERVICE'] },
                },
                resources: {
                  requests: { cpu: '50m', memory: '128Mi' },
                  limits: { cpu: '500m', memory: '512Mi' },
                },
                volumeMounts: [{ name: 'data', mountPath: '/app/data' }],
                readinessProbe: {
                  httpGet: { path: '/', port: HTTP_PORT },
                  initialDelaySeconds: 10,
                  periodSeconds: 15,
                },
                livenessProbe: {
                  httpGet: { path: '/', port: HTTP_PORT },
                  initialDelaySeconds: 30,
                  periodSeconds: 30,
                },
              },
            ],
            // By name, not data.metadata.name: longhorn-persistent binds only once a pod uses
            // the claim (WaitForFirstConsumer), so the Deployment must not wait for it.
            volumes: [{ name: 'data', persistentVolumeClaim: { claimName: DATA_CLAIM } }],
          },
        },
      },
    },
  );

  new k8s.core.v1.Service(
    APP_NAME,
    {
      metadata: { name: APP_NAME, namespace: ns.metadata.name, labels },
      spec: {
        type: 'NodePort',
        // Keeps the speaker's source IP (no SNAT); the server pushes credentials to it.
        externalTrafficPolicy: 'Local',
        selector: labels,
        ports: [
          { name: 'http', port: HTTP_PORT, targetPort: HTTP_PORT, nodePort: NODE_PORT_HTTP },
          { name: 'https', port: HTTPS_PORT, targetPort: HTTPS_PORT, nodePort: NODE_PORT_HTTPS },
        ],
      },
    },
    { dependsOn: [deployment] },
  );

  return { serverUrl, httpsServerUrl, namespace: ns.metadata.name };
}
