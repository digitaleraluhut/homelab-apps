import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import { createHomelabContextFromStack } from '@mrsimpson/homelab-core-components';
import { deployConduit } from './conduit';
import { deployBridges } from './bridges';
import { deployBot } from './bot';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = 'matrix';
const NAMESPACE = APP_NAME;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const cfg = new pulumi.Config(APP_NAME);

// Stack reference to homelab base stack — provides tunnelCname, cloudflareZoneId, domain
const homelabStackName = cfg.get('homelabStack') ?? 'mrsimpson/homelab/dev';
const homelabStack = new pulumi.StackReference(homelabStackName);

const domain = homelabStack.getOutput('domain') as pulumi.Output<string>;
const homelab = createHomelabContextFromStack(homelabStack);

// Container images
const conduitImage = cfg.get('conduitImage') ?? 'matrixconduit/matrix-conduit:v0.9.0';
// Megabridge (latest) — works with current WhatsApp/Signal servers. Conduit v0.10 sends
// the startup ping with ?access_token= which the megabridge rejects (502), but the bridge
// retries harmlessly and stays running; actual event transactions flow fine.
const whatsappImage = cfg.get('whatsappImage') ?? 'dock.mau.dev/mautrix/whatsapp:latest';
const signalImage = cfg.get('signalImage') ?? 'dock.mau.dev/mautrix/signal:latest';
const botImage = cfg.get('botImage') ?? 'ghcr.io/mrsimpson/voice-transcription-bot:latest';

// LLM config (llama.cpp on flinker:8080)
const llmUrl = cfg.get('llmUrl') ?? 'http://flinker:8080/v1';
const llmModel = cfg.get('llmModel') ?? 'default';

// Secrets — appservice tokens (from bridge registration YAMLs, bootstrapped manually).
// Use getSecret (not requireSecret) so bridges can be skipped when tokens are not yet set.
// This allows incremental deployment: deploy Conduit first, add bridges later.
const whatsappAsToken = cfg.getSecret('whatsappAsToken');
const whatsappHsToken = cfg.getSecret('whatsappHsToken');
const signalAsToken = cfg.getSecret('signalAsToken');
const signalHsToken = cfg.getSecret('signalHsToken');

// Determine which appservices to enable based on which tokens are configured.
// A bridge is only mounted when its tokens are present — this prevents Conduit from
// failing to read a registration.yaml that doesn't exist yet.
const enabledAppservices = [
  ...(whatsappAsToken && whatsappHsToken ? ['whatsapp'] : []),
  ...(signalAsToken && signalHsToken ? ['signal'] : []),
];

// Conduit admin token — used for registration API during bootstrap
const conduitAdminToken = cfg.requireSecret('conduitAdminToken');

// ---------------------------------------------------------------------------
// 1. Namespace
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

// ---------------------------------------------------------------------------
// 2. Conduit homeserver (internet-exposed via Cloudflare Tunnel)
// ---------------------------------------------------------------------------

const serverName = pulumi.interpolate`matrix.${domain}`;
const conduitDomain = pulumi.interpolate`matrix.${domain}`;

const conduitOutputs = deployConduit({
  homelab,
  namespace: ns,
  image: conduitImage,
  serverName,
  domain: conduitDomain,
  adminToken: conduitAdminToken,
  enabledAppservices,
});

// ---------------------------------------------------------------------------
// 3. mautrix bridges (ClusterIP — outbound to WhatsApp/Signal cloud)
// ---------------------------------------------------------------------------

const bridgeOutputs = deployBridges({
  namespace: ns,
  conduitInClusterUrl: conduitOutputs.inClusterUrl,
  whatsappImage,
  signalImage,
  whatsappAsToken,
  whatsappHsToken,
  signalAsToken,
  signalHsToken,
});

// ---------------------------------------------------------------------------
// 4. Transcription bot (ClusterIP — listens for audio events)
// ---------------------------------------------------------------------------

const botUserId = pulumi.interpolate`@transcription-bot:matrix.${domain}`;

const botOutputs = deployBot({
  namespace: ns,
  image: botImage,
  homeserverUrl: conduitOutputs.inClusterUrl,
  botUserId,
  llmUrl,
  llmModel,
});

// ---------------------------------------------------------------------------
// Stack outputs
// ---------------------------------------------------------------------------

export const matrixDomain = conduitDomain;
export const matrixServerName = serverName;
export const matrixInClusterUrl = conduitOutputs.inClusterUrl;
export const botUserIdOutput = botUserId;
export const namespace = ns.metadata.name;
