import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import { AuthType, createHomelabContextFromStack } from '@mrsimpson/homelab-core-components';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = 'wiki';
const NAMESPACE = APP_NAME;
const APP_PORT = 8080;
// nginx and git-sync both run as this non-root UID/GID (git-sync's default); fsGroup makes
// the shared emptyDir and the mounted SSH key readable by both.
const RUN_AS = 65533;

// Pinned by tag AND digest (override via config only with both).
const DEFAULT_SYNC_IMAGE =
  'registry.k8s.io/git-sync/git-sync:v4.8.0@sha256:a20644562fba94773e594885cb001aadb5a3172175f13ac1215e5b2033c9200e';
const DEFAULT_NGINX_IMAGE =
  'docker.io/nginxinc/nginx-unprivileged:1.31.7-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e';

// Public SSH host keys of github.com (https://api.github.com/meta -> ssh_keys).
// git-sync verifies the server against these; host key checking is NOT disabled.
const GITHUB_KNOWN_HOSTS = [
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
  'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
].join('\n') + '\n';

const NGINX_CONF = `worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events { worker_connections 256; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  access_log off;
  sendfile on;
  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml text/plain;
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;
  server {
    listen ${APP_PORT};
    server_tokens off;
    # git-sync publishes the checked-out branch as the symlink /git/current
    root /git/current;
    index index.html;
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy same-origin;
    location = /healthz { access_log off; default_type text/plain; return 200 "ok\\n"; }
    # Quartz emits extension-less links (/page -> page.html)
    location / { try_files $uri $uri.html $uri/ =404; }
    error_page 404 /404.html;
  }
}
`;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const cfg = new pulumi.Config(APP_NAME);
const homelabStack = new pulumi.StackReference(cfg.require('homelabStack'));
const domain = homelabStack.getOutput('domain') as pulumi.Output<string>;
const homelab = createHomelabContextFromStack(homelabStack);

const gitRepo = cfg.require('gitRepo');
const gitRef = cfg.get('gitRef') ?? 'site';
const syncPeriod = cfg.get('syncPeriod') ?? '60s';
const syncImage = cfg.get('syncImage') ?? DEFAULT_SYNC_IMAGE;
const nginxImage = cfg.get('nginxImage') ?? DEFAULT_NGINX_IMAGE;
const domainPrefix = cfg.get('domainPrefix') ?? APP_NAME;
const appDomain = pulumi.interpolate`${domainPrefix}.${domain}`;
// The private key ends with a newline (ssh rejects keys without one).
const gitSshKey = cfg.requireSecret('gitSshKey').apply((k) => (k.endsWith('\n') ? k : `${k}\n`));

// ---------------------------------------------------------------------------
// Namespace: created by the homelab stack (appNamespaces in homelab/src/index.ts).
// Only referenced here; this stack must not create it.
// ---------------------------------------------------------------------------

const ns = k8s.core.v1.Namespace.get(`${APP_NAME}-ns`, NAMESPACE);

// ---------------------------------------------------------------------------
// Config objects
// ---------------------------------------------------------------------------

const labels = { app: APP_NAME };

const nginxConf = new k8s.core.v1.ConfigMap(
  `${APP_NAME}-nginx`,
  {
    metadata: { name: `${APP_NAME}-nginx`, namespace: NAMESPACE, labels },
    data: { 'nginx.conf': NGINX_CONF },
  },
  { dependsOn: [ns] },
);

const knownHosts = new k8s.core.v1.ConfigMap(
  `${APP_NAME}-known-hosts`,
  {
    metadata: { name: `${APP_NAME}-known-hosts`, namespace: NAMESPACE, labels },
    data: { known_hosts: GITHUB_KNOWN_HOSTS },
  },
  { dependsOn: [ns] },
);

const sshSecret = new k8s.core.v1.Secret(
  `${APP_NAME}-git-ssh`,
  {
    metadata: { name: `${APP_NAME}-git-ssh`, namespace: NAMESPACE, labels },
    type: 'Opaque',
    stringData: { ssh: gitSshKey },
  },
  { dependsOn: [ns] },
);

// ---------------------------------------------------------------------------
// App: nginx (main container, via ExposedWebApp) + git-sync sidecar
// ---------------------------------------------------------------------------

const hardenedContainer = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
  runAsUser: RUN_AS,
  runAsGroup: RUN_AS,
  capabilities: { drop: ['ALL'] },
  seccompProfile: { type: 'RuntimeDefault' },
};

const gitSyncContainer = {
  name: 'git-sync',
  image: syncImage,
  args: [
    '--repo', gitRepo,
    '--ref', gitRef,
    '--depth', '1',
    '--period', syncPeriod,
    '--root', '/git',
    '--link', 'current',
    '--ssh-key-file', '/etc/git-secret/ssh',
    '--ssh-known-hosts-file', '/etc/git-known-hosts/known_hosts',
  ],
  env: [{ name: 'HOME', value: '/tmp' }],
  resources: {
    requests: { cpu: '10m', memory: '32Mi' },
    limits: { cpu: '200m', memory: '128Mi' },
  },
  securityContext: hardenedContainer,
  volumeMounts: [
    { name: 'git', mountPath: '/git' },
    { name: 'tmp', mountPath: '/tmp' },
    { name: 'git-ssh', mountPath: '/etc/git-secret', readOnly: true },
    { name: 'known-hosts', mountPath: '/etc/git-known-hosts', readOnly: true },
  ],
};

export const app = homelab.createExposedWebApp(
  APP_NAME,
  {
    namespace: ns,
    image: nginxImage,
    domain: appDomain,
    port: APP_PORT,
    replicas: 1,
    auth: AuthType.OAUTH2_PROXY,
    oauth2Proxy: { group: 'users' },
    securityContext: { runAsUser: RUN_AS, runAsGroup: RUN_AS, fsGroup: RUN_AS },
    resources: {
      requests: { cpu: '10m', memory: '16Mi' },
      limits: { cpu: '200m', memory: '64Mi' },
    },
    probes: {
      // Not ready until git-sync has published the first checkout.
      readinessProbe: {
        httpGet: { path: '/', port: APP_PORT },
        initialDelaySeconds: 5,
        periodSeconds: 10,
        failureThreshold: 6,
      },
      livenessProbe: {
        httpGet: { path: '/healthz', port: APP_PORT },
        initialDelaySeconds: 10,
        periodSeconds: 30,
        failureThreshold: 3,
      },
    },
    extraContainers: [gitSyncContainer],
    extraVolumes: [
      { name: 'git', emptyDir: {} },
      { name: 'tmp', emptyDir: {} },
      { name: 'nginx-conf', configMap: { name: `${APP_NAME}-nginx` } },
      { name: 'known-hosts', configMap: { name: `${APP_NAME}-known-hosts` } },
      { name: 'git-ssh', secret: { secretName: `${APP_NAME}-git-ssh`, defaultMode: 0o400 } },
    ],
    extraVolumeMounts: [
      { name: 'git', mountPath: '/git', readOnly: true },
      { name: 'tmp', mountPath: '/tmp' },
      { name: 'nginx-conf', mountPath: '/etc/nginx/nginx.conf', subPath: 'nginx.conf', readOnly: true },
    ],
    tags: ['wiki', 'docs'],
  },
  { dependsOn: [nginxConf, knownHosts, sshSecret] },
);

export const url = pulumi.interpolate`https://${appDomain}`;
export const namespace = NAMESPACE;
