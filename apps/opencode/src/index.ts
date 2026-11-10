import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import { AuthType, createHomelabContextFromStack } from '@mrsimpson/homelab-core-components';

// ---------------------------------------------------------------------------
// opencode v2 (upstream release). Independent of namespace `code` (opencode-router).
// ---------------------------------------------------------------------------

const APP_NAME = 'opencode';
const NAMESPACE = APP_NAME;
const APP_PORT = 4096;
const RUN_AS = 1000;
const DATA_DIR = '/data';

// Public upstream image (no pull secret), pinned by tag AND digest (multi-arch index).
// Bump: new tag from https://github.com/anomalyco/opencode/releases, digest from the registry.
const DEFAULT_IMAGE =
  'ghcr.io/anomalyco/opencode:2.2.7@sha256:7b1e3139a64121d12e572530974a18b9452967fb4d67516d8cfd9c0e763dd57d';

const cfg = new pulumi.Config(APP_NAME);
const homelabStack = new pulumi.StackReference(cfg.require('homelabStack'));
const domain = homelabStack.getOutput('domain') as pulumi.Output<string>;
const homelab = createHomelabContextFromStack(homelabStack);

const image = cfg.get('image') ?? DEFAULT_IMAGE;
const domainPrefix = cfg.get('domainPrefix') ?? APP_NAME;
const storageSize = cfg.get('storageSize') ?? '5Gi';
// local-ai router (OpenAI-compatible); only the resident models answer (see wiki: local-ai-services).
const llmBaseUrl = cfg.get('llmBaseUrl') ?? 'http://flinker:8080/v1';
const model = cfg.get('model') ?? 'qwen3.6-35b-a3b';
const appDomain = pulumi.interpolate`${domainPrefix}.${domain}`;

// Namespace is created by the homelab stack (appNamespaces); only referenced here.
const ns = k8s.core.v1.Namespace.get(`${APP_NAME}-ns`, NAMESPACE);

// Provider config: local-ai only; no keys needed.
const opencodeConfig = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  model: `local-ai/${model}`,
  provider: {
    'local-ai': {
      npm: '@ai-sdk/openai-compatible',
      name: 'local-ai',
      options: { baseURL: llmBaseUrl },
      models: { [model]: { name: model } },
    },
  },
});

export const app = homelab.createExposedWebApp(
  APP_NAME,
  {
    namespace: ns,
    image,
    domain: appDomain,
    port: APP_PORT,
    replicas: 1,
    auth: AuthType.OAUTH2_PROXY,
    oauth2Proxy: { group: 'developers' },
    args: ['web', '--hostname', '0.0.0.0', '--port', String(APP_PORT)],
    securityContext: { runAsUser: RUN_AS, runAsGroup: RUN_AS, fsGroup: RUN_AS },
    // One persistent volume holds config, data, state and cache (own config dir, not shared with `code`).
    storage: { size: storageSize, mountPath: DATA_DIR, storageClass: 'longhorn-persistent' },
    env: [
      { name: 'HOME', value: `${DATA_DIR}/home` },
      { name: 'XDG_CONFIG_HOME', value: `${DATA_DIR}/config` },
      { name: 'XDG_DATA_HOME', value: `${DATA_DIR}/share` },
      { name: 'XDG_STATE_HOME', value: `${DATA_DIR}/state` },
      { name: 'XDG_CACHE_HOME', value: `${DATA_DIR}/cache` },
      { name: 'OPENCODE_CONFIG_CONTENT', value: opencodeConfig },
    ],
    resources: {
      requests: { cpu: '100m', memory: '256Mi' },
      limits: { cpu: '2', memory: '2Gi' },
    },
    probes: {
      readinessProbe: { tcpSocket: { port: APP_PORT }, initialDelaySeconds: 10, periodSeconds: 15, failureThreshold: 6 },
      livenessProbe: { tcpSocket: { port: APP_PORT }, initialDelaySeconds: 30, periodSeconds: 30, failureThreshold: 5 },
    },
    tags: ['opencode', 'coding'],
  },
);

export const url = pulumi.interpolate`https://${appDomain}`;
export const namespace = NAMESPACE;
