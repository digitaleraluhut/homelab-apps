import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it } from 'vitest';

type Created = { type: string; name: string; inputs: Record<string, any> };
const created: Created[] = [];
const ofType = (t: string) => created.filter((c) => c.type === `kubernetes:${t}`);

beforeAll(async () => {
  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        return { id: `${args.name}-id`, state: args.inputs };
      },
      call: (args) => args.inputs,
    },
    'soundtouch',
    'dev',
    false,
  );
  pulumi.runtime.setAllConfig({
    'soundtouch:serverHost': 'speakerhost',
    'soundtouch:mgmtUsername': 'u',
    'soundtouch:mgmtPassword': 'p',
    'soundtouch:discoverySubnets': '198.51.100.0/24',
  });
  const { deploySoundtouch } = await import('../src/app');
  deploySoundtouch();
  await new Promise((r) => setTimeout(r, 100));
});

const podSpec = () => ofType('apps/v1:Deployment')[0].inputs.spec.template.spec;
const app = () => podSpec().containers.find((c: { name: string }) => c.name === 'app');

describe('soundtouch', () => {
  it('lives in its own restricted app namespace', () => {
    const ns = ofType('core/v1:Namespace').find((n) => n.name === 'soundtouch-ns');
    expect(ns?.inputs.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
  });

  it('runs one pinned server image, without the retired web sidecar', () => {
    expect(podSpec().containers.map((c: { image: string }) => c.image)).toEqual([
      'ghcr.io/gesellix/bose-soundtouch:0.139.0@sha256:4ce91e437b3105689817b0836339ae5cdf3bccbac7c811b6ac52be045587edb5',
    ]);
  });

  it('satisfies pod-security restricted with the one capability the binary needs', () => {
    expect(podSpec().hostNetwork).toBeFalsy();
    expect(podSpec().securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 65532,
      runAsGroup: 65532,
      fsGroup: 65532,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    for (const c of podSpec().containers) {
      expect(c.ports.every((p: { hostPort?: number }) => p.hostPort === undefined)).toBe(true);
    }
    // cap_net_bind_service=+ep on the binary: without it in the bounding set exec fails (EPERM).
    expect(app().securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'], add: ['NET_BIND_SERVICE'] },
    });
  });

  // Speakers are migrated to these URLs; the port is part of the address.
  it('tells the speakers the LAN address and node ports they reach it on', () => {
    expect(app().env).toEqual(
      expect.arrayContaining([
        { name: 'SERVER_URL', value: 'http://speakerhost:30880' },
        { name: 'HTTPS_SERVER_URL', value: 'https://speakerhost:30883' },
        { name: 'DISCOVERY_SUBNETS', value: '198.51.100.0/24' },
        { name: 'DISCOVERY_SCAN_INTERVAL', value: '1h' },
      ]),
    );
  });

  // Not through Traefik: Go proxies rewrite the ETag header to "Etag", which the speaker
  // firmware ignores, and a TCP proxy hides the speaker IP the server pushes credentials to.
  // A NodePort with externalTrafficPolicy Local keeps the source IP and the bytes as they are.
  it('is reachable on the LAN only through node ports that keep the speaker IP', () => {
    const svcs = ofType('core/v1:Service');
    expect(svcs).toHaveLength(1);
    expect(svcs[0].inputs.spec).toMatchObject({
      type: 'NodePort',
      externalTrafficPolicy: 'Local',
      ports: [
        { name: 'http', port: 8000, targetPort: 8000, nodePort: 30880 },
        { name: 'https', port: 8443, targetPort: 8443, nodePort: 30883 },
      ],
    });
  });

  it('creates no route, ingress or DNS record (no internet exposure)', () => {
    const exposing = created.filter((c) =>
      /Ingress|HTTPRoute|IngressRoute|cloudflare|Gateway/i.test(c.type),
    );
    expect(exposing).toEqual([]);
  });

  // The CA the speakers trust lives in the data volume; losing it means re-migrating them.
  it('keeps its data, including the speaker CA, on a backed-up volume', () => {
    const pvc = ofType('core/v1:PersistentVolumeClaim')[0];
    expect(pvc.inputs.spec.storageClassName).toBe('longhorn-persistent');
  });
});
