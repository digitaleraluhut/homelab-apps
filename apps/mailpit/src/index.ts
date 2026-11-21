import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { AuthType, createAppNamespace, createHomelabContextFromStack } from '@mrsimpson/homelab-core-components';

// Mailpit: an SMTP sink for mail from homelab apps (first: Zitadel's verification and password mails).
// Mail never leaves the cluster; it is read in the web inbox at https://mail.<domain>, behind OAuth2-Proxy.
// SMTP is reachable only inside the cluster (Service mailpit-smtp, port 1025), without authentication.
// Sources: README.md, "## Upstream facts".

const APP_NAME = 'mailpit';
const UI_PORT = 8025;
const SMTP_PORT = 1025;
const RUN_AS = 1000;

// axllent/mailpit v1.34.0, multi-arch index digest from the registry API (2026-11-21).
const DEFAULT_IMAGE =
  'docker.io/axllent/mailpit:v1.34.0@sha256:23a2ef85bc50853ab3093645d1d64679afd8887e89da5e48a88940c172591a4e';

const cfg = new pulumi.Config(APP_NAME);
const homelabStack = new pulumi.StackReference(cfg.require('homelabStack'));
const domain = homelabStack.getOutput('domain') as pulumi.Output<string>;
const homelab = createHomelabContextFromStack(homelabStack);
const image = cfg.get('image') ?? DEFAULT_IMAGE;

const { namespace: ns } = createAppNamespace(APP_NAME);

const app = homelab.createExposedWebApp(APP_NAME, {
  namespace: ns,
  image,
  domain: pulumi.interpolate`mail.${domain}`,
  port: UI_PORT,
  auth: AuthType.OAUTH2_PROXY,
  oauth2Proxy: { group: 'users' },
  enableServiceLinks: false,
  securityContext: { runAsUser: RUN_AS, runAsGroup: RUN_AS, fsGroup: RUN_AS },
  env: [
    { name: 'MP_UI_BIND_ADDR', value: `0.0.0.0:${UI_PORT}` },
    { name: 'MP_SMTP_BIND_ADDR', value: `0.0.0.0:${SMTP_PORT}` },
    // Kept in an emptyDir: survives container restarts, not pod replacement (codes are short-lived).
    { name: 'MP_DATABASE', value: '/data/mailpit.db' },
    { name: 'MP_MAX_MESSAGES', value: '500' },
    // No calls to GitHub for new releases; Renovate tracks the version.
    { name: 'MP_DISABLE_VERSION_CHECK', value: 'true' },
  ],
  resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
  probes: {
    readinessProbe: { httpGet: { path: '/readyz', port: UI_PORT }, initialDelaySeconds: 2, periodSeconds: 10 },
    livenessProbe: { httpGet: { path: '/livez', port: UI_PORT }, initialDelaySeconds: 5, periodSeconds: 30 },
  },
  extraVolumes: [{ name: 'data', emptyDir: { sizeLimit: '256Mi' } }],
  extraVolumeMounts: [{ name: 'data', mountPath: '/data' }],
  tags: ['mail', 'tools'],
});

// SMTP for other apps in the cluster: mailpit-smtp.mailpit.svc:1025. Not exposed outside the cluster.
const smtpService = new k8s.core.v1.Service(`${APP_NAME}-smtp`, {
  metadata: { name: `${APP_NAME}-smtp`, namespace: ns.metadata.name, labels: { app: APP_NAME } },
  spec: {
    type: 'ClusterIP',
    selector: { app: APP_NAME },
    ports: [{ name: 'smtp', port: SMTP_PORT, targetPort: SMTP_PORT, protocol: 'TCP' }],
  },
}, { dependsOn: [ns, app] });

export const url = pulumi.interpolate`https://mail.${domain}`;
export const smtpHost = pulumi.interpolate`${smtpService.metadata.name}.${APP_NAME}.svc.cluster.local:${SMTP_PORT}`;
export const namespace = APP_NAME;
