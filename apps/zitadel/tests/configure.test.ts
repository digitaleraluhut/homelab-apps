import { execFileSync } from 'node:child_process';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error: plain ES module without types (it runs in the Job as is)
import * as cfg from '../configure/configure.mjs';

// The Job's script, against the admin API as admin.proto (zitadel v4.20.3) defines it; README.md,
// "## Upstream facts", names each source.

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyFile = {
  type: 'serviceaccount',
  keyId: 'key-1',
  key: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  userId: 'user-1',
};
const deployKey = Buffer.from(JSON.stringify(keyFile)).toString('base64');

describe('pure functions', () => {
  it('decodes the base64 key file and checks its fields (machine_key.go:62-70)', () => {
    expect(cfg.decodeKey(deployKey).userId).toBe('user-1');
    expect(() => cfg.decodeKey(Buffer.from('{"keyId":"k"}').toString('base64'))).toThrow(/field key missing/);
  });

  it('signs a jwt-bearer assertion: RS256, kid, iss = sub = userId, aud = issuer (private-key-jwt.mdx)', () => {
    const jwt: string = cfg.assertion(keyFile, 'https://id.example.org', 1000);
    const [h, b, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', kid: 'key-1' });
    expect(JSON.parse(Buffer.from(b, 'base64url').toString())).toEqual({
      iss: 'user-1', sub: 'user-1', aud: 'https://id.example.org', iat: 1000, exp: 1300,
    });
    expect(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('builds AddGitHubProviderRequest with linking allowed and no user creation (admin.proto, idp.proto Options)', () => {
    expect(cfg.githubProvider('cid', 'csecret')).toEqual({
      name: 'GitHub',
      clientId: 'cid',
      clientSecret: 'csecret',
      scopes: ['read:user', 'user:email'],
      providerOptions: { isLinkingAllowed: true, isCreationAllowed: false, isAutoCreation: false, isAutoUpdate: true },
    });
  });

  it('finds the GitHub provider in ListProvidersResponse.result only by name and GitHub config', () => {
    expect(cfg.findGithub({})).toBeUndefined();
    expect(cfg.findGithub({ result: [{ id: 'a', name: 'GitHub', config: { google: {} } }] })).toBeUndefined();
    expect(cfg.findGithub({ result: [{ id: 'b', name: 'GitHub', config: { github: { clientId: 'x' } } }] })).toBe('b');
  });

  it('changes the login policy only when external IdPs are not allowed, keeping every other setting', () => {
    expect(cfg.loginPolicyUpdate({ allowExternalIdp: true })).toBeNull();
    const policy = {
      allowUsernamePassword: true, allowRegister: false, allowExternalIdp: false, forceMfa: false,
      passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED', isDefault: true, hidePasswordReset: false,
      ignoreUnknownUsernames: true, defaultRedirectUri: '', passwordCheckLifetime: '864000s',
      externalLoginCheckLifetime: '864000s', mfaInitSkipLifetime: '2592000s', secondFactorCheckLifetime: '64800s',
      multiFactorCheckLifetime: '43200s', secondFactors: [], multiFactors: [], idps: [], allowDomainDiscovery: true,
      disableLoginWithEmail: false, disableLoginWithPhone: false, forceMfaLocalOnly: false,
    };
    const req = cfg.loginPolicyUpdate(policy);
    expect(req.allowExternalIdp).toBe(true);
    // Exactly the fields of UpdateLoginPolicyRequest (admin.proto), nothing read-only like isDefault or idps.
    expect(Object.keys(req).sort()).toEqual([
      'allowDomainDiscovery', 'allowExternalIdp', 'allowRegister', 'allowUsernamePassword', 'defaultRedirectUri',
      'disableLoginWithEmail', 'disableLoginWithPhone', 'externalLoginCheckLifetime', 'forceMfa', 'forceMfaLocalOnly',
      'hidePasswordReset', 'ignoreUnknownUsernames', 'mfaInitSkipLifetime', 'multiFactorCheckLifetime',
      'passwordCheckLifetime', 'passwordlessType', 'secondFactorCheckLifetime',
    ]);
    expect(req.allowRegister).toBe(false);
    expect(req.ignoreUnknownUsernames).toBe(true);
    expect(req.passwordCheckLifetime).toBe('864000s');
  });
});

describe('a run against an admin API double', () => {
  type Seen = { method: string; path: string; host?: string; pub?: string; auth?: string; body: string };
  const seen: Seen[] = [];
  const state = { providers: [] as any[], allowExternalIdp: false, links: [] as string[], refuse: false };
  let server: http.Server;
  let api = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '', path: req.url ?? '', host: req.headers.host,
          pub: req.headers['x-zitadel-public-host'] as string, auth: req.headers.authorization, body,
        });
        const json = (o: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
        const route = `${req.method} ${req.url}`;
        if (state.refuse) { res.statusCode = 400; return res.end('{"message":"Errors.Invalid.Argument"}'); }
        if (route === 'POST /oauth/v2/token') return json({ access_token: 'tok', token_type: 'Bearer' });
        if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{}'); }
        if (route === 'POST /admin/v1/idps/templates/_search') return json({ result: state.providers });
        if (route === 'POST /admin/v1/idps/github') {
          state.providers.push({ id: 'idp-1', name: 'GitHub', config: { github: { clientId: JSON.parse(body).clientId } } });
          return json({ id: 'idp-1' });
        }
        if (route === 'PUT /admin/v1/idps/github/idp-1') return json({});
        if (route === 'GET /admin/v1/policies/login') return json({ policy: { allowExternalIdp: state.allowExternalIdp } });
        if (route === 'PUT /admin/v1/policies/login') { state.allowExternalIdp = JSON.parse(body).allowExternalIdp; return json({}); }
        if (route === 'POST /admin/v1/policies/login/idps/_search') return json({ result: state.links.map((idpId) => ({ idpId })) });
        if (route === 'POST /admin/v1/policies/login/idps') {
          if (state.links.includes(JSON.parse(body).idpId)) { res.statusCode = 409; return res.end('{"message":"already exists"}'); }
          state.links.push(JSON.parse(body).idpId);
          return json({});
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const env = () => ({
    ZITADEL_HOST: 'id.example.org', ZITADEL_API_URL: api, ZITADEL_DEPLOY_KEY: deployKey,
    GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret',
  });

  it('creates the provider, allows external IdPs and offers GitHub; the public host on every request', async () => {
    const log: string[] = [];
    await cfg.main(env(), (l: string) => log.push(l));
    expect(log).toEqual([
      'token: ok',
      'identity provider GitHub: created (idp-1)',
      'login policy: external identity providers allowed',
      'login policy: GitHub offered',
    ]);
    expect(seen.every((s) => s.host === 'id.example.org' && s.pub === 'id.example.org')).toBe(true);
    const token = new URLSearchParams(seen[0].body);
    expect(token.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(token.get('scope')).toBe('openid urn:zitadel:iam:org:project:id:zitadel:aud');
    expect(JSON.parse(seen[1].body)).toEqual(cfg.providerQuery);
    expect(JSON.parse(seen[2].body).clientSecret).toBe('csecret');
    expect(log.join(' ')).not.toContain('csecret');
  });

  it('is idempotent: a second run updates the provider and changes nothing else', async () => {
    seen.length = 0;
    const log: string[] = [];
    await cfg.main(env(), (l: string) => log.push(l));
    expect(log).toEqual([
      'token: ok',
      'identity provider GitHub: updated (idp-1)',
      'login policy: external identity providers already allowed',
      'login policy: GitHub already offered',
    ]);
    expect(seen.map((s) => `${s.method} ${s.path}`)).not.toContain('POST /admin/v1/policies/login/idps');
  });

  it('fails with the status and the answer when a call is refused', async () => {
    state.refuse = true;
    await expect(cfg.main(env(), () => {})).rejects.toThrow(/POST \/oauth\/v2\/token: HTTP 400 .*Errors.Invalid.Argument/);
    state.refuse = false;
  });
});

describe('started as a program', () => {
  it('runs main also when started through a symlink, as a ConfigMap mounts it, and fails without input', () => {
    // A ConfigMap volume is a chain of symlinks; Node resolves the main module to the real path.
    const dir = mkdtempSync(path.join(tmpdir(), 'configure-'));
    const link = path.join(dir, 'configure.mjs');
    symlinkSync(path.join(__dirname, '../configure/configure.mjs'), link);
    const r = spawnSync('node', [link], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/argument|undefined|must be/i);
  });
});

describe('rendered resources', () => {
  const root = path.resolve(__dirname, '../../..');
  type Rendered = { type: string; name: string; inputs: any };
  const rendered: Rendered[] = JSON.parse(
    execFileSync('node', [path.join(root, '.github/scripts/render_app.cjs'), path.join(root, 'apps/zitadel')], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  const one = (type: string, name: string) => rendered.find((r) => r.type === `kubernetes:${type}` && r.name === name)!.inputs;
  const job = one('batch/v1:Job', 'zitadel-configure');
  const pod = job.spec.template.spec;
  const container = pod.containers[0];

  it('reads the three ESC keys through the store pulumi-esc', () => {
    const es = one('external-secrets.io/v1beta1:ExternalSecret', 'zitadel-github-idp');
    expect(es.spec.secretStoreRef).toEqual({ name: 'pulumi-esc', kind: 'ClusterSecretStore' });
    expect(es.spec.data.map((d: any) => d.remoteRef.key)).toEqual([
      'zitadelDeployKey', 'zitadelGithubClientId', 'zitadelGithubClientSecret',
    ]);
  });

  it('mounts exactly the script file the tests run, named after its hash', () => {
    const cm = one('core/v1:ConfigMap', 'zitadel-configure');
    expect(cm.data['configure.mjs']).toBe(readFileSync(path.join(__dirname, '../configure/configure.mjs'), 'utf8'));
    expect(cm.metadata.name).toBe(job.metadata.name);
    expect(job.metadata.name).toMatch(/^zitadel-configure-[0-9a-f]{8}$/);
  });

  it('calls the core Service on its Service port with the public host', () => {
    const svc = rendered.find((r) => r.type === 'kubernetes:core/v1:Service' && r.inputs.metadata?.name === 'zitadel')!.inputs;
    const env = Object.fromEntries(container.env.map((e: any) => [e.name, e]));
    expect(env.ZITADEL_API_URL.value).toBe(`http://zitadel:${svc.spec.ports[0].port}`);
    expect(env.ZITADEL_HOST.value).toBe('id.example.org');
    for (const n of ['ZITADEL_DEPLOY_KEY', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'])
      expect(env[n].valueFrom.secretKeyRef.name).toBe('zitadel-github-idp');
  });

  it('runs a digest-pinned image under pod security restricted, without service links', () => {
    expect(container.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(pod.enableServiceLinks).toBe(false);
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' },
    });
  });
});
