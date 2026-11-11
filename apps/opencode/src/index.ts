import * as pulumi from '@pulumi/pulumi';
import {
  AuthType,
  createAppNamespace,
  createHomelabContextFromStack,
} from '@mrsimpson/homelab-core-components';
import * as k8s from '@pulumi/kubernetes';

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
// opencode 2.x always protects its server with a password (browsers sign in once per device
// with a pairing link, sessions last 30 days). Fixed here, so it is not printed to the log and
// sessions survive restarts. Set with: pulumi config set --secret opencode:serverPassword <pw>
const serverPassword = cfg.requireSecret('serverPassword');

// Own namespace plus the CI's deployer rights; resources using `ns` wait for both.
const { namespace: ns } = createAppNamespace(NAMESPACE);

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

const serverSecret = new k8s.core.v1.Secret(`${APP_NAME}-server`, {
  metadata: { name: `${APP_NAME}-server`, namespace: ns.metadata.name },
  stringData: { OPENCODE_PASSWORD: serverPassword },
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
    // opencode 2.x: `serve` starts the API and web UI (`web` no longer exists).
    args: ['serve', '--hostname', '0.0.0.0', '--port', String(APP_PORT)],
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
    envFrom: [{ secretRef: { name: serverSecret.metadata.name } }],
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
