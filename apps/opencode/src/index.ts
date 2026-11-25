import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
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
// Projects (repositories, work in progress): own volume `opencode-projects`, mounted at ~/projects; opencode
// starts there, so its web UI opens in that directory (owner, 2026-11-25).
const projectsSize = cfg.get('projectsSize') ?? '20Gi';
const PROJECTS_DIR = `${DATA_DIR}/home/projects`; // HOME is ${DATA_DIR}/home
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
// Plugins (owner, 2026-11-25), pinned. opencode 2.x reads `plugins` (plural; 1.x: `plugin`) and installs
// them from npm at start. v1 and v2 plugin builds do not load across major versions.
// - anthropic-auth: sign in with a Claude Pro/Max subscription. Unofficial; its README warns that this may
//   break Anthropic's terms and get the account banned (owner's decision). v2 line = npm tag `next`.
// - workflows: structured development workflows (codemcp), v1 and v2 hooks in one package.
// - antigravity-auth: sign in with Google Antigravity. Unofficial; Google may restrict such accounts.
// Sign-ins happen once in the web UI's connect dialog; the tokens live under /data (backed-up volume).
const PLUGINS = [
  '@ex-machina/opencode-anthropic-auth@2.0.0-next.8',
  '@codemcp/workflows-opencode@6.25.0',
  'opencode-antigravity-auth@2.1.2',
];
const opencodeConfig = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  plugins: PLUGINS,
  // The workflow agent (config/agents/workflow.md); the workflows plugin switches domains itself.
  default_agent: 'workflow',
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

// Kept apart from the config volume, so projects survive a reset of opencode's state (and vice versa).
// longhorn-uncritical: no backup. Longhorn backs up whole blocks and cannot skip paths, so ignored
// build output and dependencies would be backed up every night; projects live in their git remotes
// instead (owner, 2026-11-25). Reclaim Delete: deleting the claim deletes unpushed work.
// The Deployment names the claim as a plain string, not as this resource's output: the Longhorn classes
// bind on first use (WaitForFirstConsumer), so a Deployment waiting for the claim would never start the
// pod the claim waits for (deploy of 2026-11-25 timed out). As in apps/agentic-office.
const PROJECTS_CLAIM = `${APP_NAME}-projects`;
new k8s.core.v1.PersistentVolumeClaim(PROJECTS_CLAIM, {
  metadata: { name: PROJECTS_CLAIM, namespace: ns.metadata.name, labels: { app: APP_NAME } },
  spec: {
    accessModes: ['ReadWriteOnce'],
    storageClassName: 'longhorn-uncritical',
    resources: { requests: { storage: projectsSize } },
  },
});

// Agent and global instructions, from config/ in this app: opencode reads ~/.config/opencode/agents/*.md
// and ~/.config/opencode/AGENTS.md (the global file for every agent; docs: agents.mdx, instructions.mdx).
// XDG_CONFIG_HOME is ${DATA_DIR}/config. The ConfigMap's name carries a hash of the files, so a change
// replaces the pod (subPath mounts do not follow ConfigMap updates).
const CONFIG_SRC = path.join(__dirname, '..', 'config');
const configFiles = {
  'workflow.md': readFileSync(path.join(CONFIG_SRC, 'agents', 'workflow.md'), 'utf8'),
  'AGENTS.md': readFileSync(path.join(CONFIG_SRC, 'AGENTS.md'), 'utf8'),
};
const configHash = createHash('sha256').update(JSON.stringify(configFiles)).digest('hex').slice(0, 8);
const agentsConfigMap = new k8s.core.v1.ConfigMap(`${APP_NAME}-agents`, {
  metadata: { name: `${APP_NAME}-agents-${configHash}`, namespace: ns.metadata.name, labels: { app: APP_NAME } },
  data: configFiles,
});
const OPENCODE_CONFIG_DIR = `${DATA_DIR}/config/opencode`;

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
    // opencode 2.x: `serve` starts the API and web UI (`web` no longer exists). It has no directory
    // argument; the server's working directory is where the UI opens, so start it in ~/projects.
    // The image is Alpine with /bin/sh; its entrypoint is `opencode` (/usr/local/bin).
    command: ['/bin/sh', '-c'],
    args: [`cd ${PROJECTS_DIR} && exec opencode serve --hostname 0.0.0.0 --port ${APP_PORT}`],
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
    extraVolumes: [
      { name: 'projects', persistentVolumeClaim: { claimName: PROJECTS_CLAIM } },
      { name: 'agents', configMap: { name: agentsConfigMap.metadata.name } },
    ],
    extraVolumeMounts: [
      { name: 'projects', mountPath: PROJECTS_DIR },
      { name: 'agents', mountPath: `${OPENCODE_CONFIG_DIR}/agents/workflow.md`, subPath: 'workflow.md', readOnly: true },
      { name: 'agents', mountPath: `${OPENCODE_CONFIG_DIR}/AGENTS.md`, subPath: 'AGENTS.md', readOnly: true },
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
