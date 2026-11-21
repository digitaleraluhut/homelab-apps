// Configures GitHub as a linkable identity provider in Zitadel, through the REST admin API inside the
// cluster. Runs in the Job zitadel-configure (src/index.ts); idempotent: a second run changes nothing.
// Node built-ins only. Sources (zitadel v4.20.3) are listed in README.md, "## Upstream facts".
import { createSign } from 'node:crypto';
import { realpathSync } from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** The service account key file (machine_key.go:62-70), from its base64 form in ESC. */
export function decodeKey(base64) {
  const key = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  for (const f of ['keyId', 'key', 'userId']) if (!key[f]) throw new Error(`deploy key: field ${f} missing`);
  return key;
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** JWT for the jwt-bearer grant (private-key-jwt.mdx): RS256, kid = keyId, iss = sub = userId, aud = issuer. */
export function assertion(key, issuer, now = Math.floor(Date.now() / 1000)) {
  const head = b64url({ alg: 'RS256', kid: key.keyId });
  const body = b64url({ iss: key.userId, sub: key.userId, aud: issuer, iat: now, exp: now + 300 });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key.key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/** Body of AddGitHubProviderRequest / UpdateGitHubProviderRequest (admin.proto), JSON names. */
export function githubProvider(clientId, clientSecret) {
  return {
    name: 'GitHub',
    clientId,
    clientSecret,
    scopes: ['read:user', 'user:email'],
    providerOptions: { isLinkingAllowed: true, isCreationAllowed: false, isAutoCreation: false, isAutoUpdate: true },
  };
}

/** ListProvidersRequest: providers named exactly "GitHub". */
export const providerQuery = {
  queries: [{ idpNameQuery: { name: 'GitHub', method: 'TEXT_QUERY_METHOD_EQUALS' } }],
};

/** The id of the GitHub provider in a ListProvidersResponse, or undefined. */
export function findGithub(list) {
  return (list.result ?? []).find((p) => p.name === 'GitHub' && p.config?.github)?.id;
}

const DURATIONS = [
  'passwordCheckLifetime',
  'externalLoginCheckLifetime',
  'mfaInitSkipLifetime',
  'secondFactorCheckLifetime',
  'multiFactorCheckLifetime',
];
const FLAGS = [
  'allowUsernamePassword',
  'allowRegister',
  'forceMfa',
  'hidePasswordReset',
  'ignoreUnknownUsernames',
  'allowDomainDiscovery',
  'disableLoginWithEmail',
  'disableLoginWithPhone',
  'forceMfaLocalOnly',
];

/**
 * UpdateLoginPolicyRequest from GetLoginPolicyResponse.policy with external IdPs allowed, or null when
 * they already are. All other settings are kept as read.
 */
export function loginPolicyUpdate(policy) {
  if (policy.allowExternalIdp === true) return null;
  const req = { allowExternalIdp: true };
  for (const f of FLAGS) req[f] = policy[f] === true;
  for (const d of DURATIONS) if (policy[d] !== undefined) req[d] = policy[d];
  if (policy.passwordlessType !== undefined) req.passwordlessType = policy.passwordlessType;
  if (policy.defaultRedirectUri !== undefined) req.defaultRedirectUri = policy.defaultRedirectUri;
  return req;
}

const SMTP_DESCRIPTION = 'homelab mailpit';

/** AddSMTPConfigRequest / UpdateSMTPConfigRequest for the in-cluster Mailpit (no TLS, no auth). */
export function smtpConfig(host, senderAddress) {
  return { description: SMTP_DESCRIPTION, host, senderAddress, senderName: 'Homelab', tls: false, user: '', replyToAddress: '' };
}

/**
 * What to do with the SMTP configuration, from ListSMTPConfigsResponse: add it, update it when a field
 * differs, activate it when it is not active (Zitadel sends only through the active one).
 */
export function smtpPlan(list, want) {
  const have = (list.result ?? []).find((c) => c.description === SMTP_DESCRIPTION);
  if (!have) return { add: true, update: false, activate: true };
  const differs = ['host', 'senderAddress', 'senderName', 'tls', 'user', 'replyToAddress'].some(
    (f) => (have[f] ?? (typeof want[f] === 'boolean' ? false : '')) !== want[f],
  );
  return { id: have.id, add: false, update: differs, activate: have.state !== 'SMTP_CONFIG_ACTIVE' };
}

/** Whether a ListLoginPolicyIDPsResponse already links the provider. */
export const linked = (list, idpId) => (list.result ?? []).some((l) => l.idpId === idpId);

/** One request to the core Service with the public host as Host (fetch cannot set Host). */
function call(api, host, method, path, { token, json, form } = {}) {
  const body = json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form).toString() : '';
  const headers = { Host: host, 'X-Zitadel-Public-Host': host, Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) {
    headers['Content-Type'] = json !== undefined ? 'application/json' : 'application/x-www-form-urlencoded';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  const url = new URL(path, api);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        if (res.statusCode >= 300) return reject(new Error(`${method} ${path}: HTTP ${res.statusCode} ${text.slice(0, 500)}`));
        resolve(text ? JSON.parse(text) : {});
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${path}: timeout`)));
    req.end(body);
  });
}

export async function main(env = process.env, log = console.log) {
  const host = env.ZITADEL_HOST; // id.<domain>, the instance's ExternalDomain
  const api = env.ZITADEL_API_URL; // http://zitadel:<service port>
  const issuer = `https://${host}`;
  const key = decodeKey(env.ZITADEL_DEPLOY_KEY);

  const tokenRes = await call(api, host, 'POST', '/oauth/v2/token', {
    form: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      scope: 'openid urn:zitadel:iam:org:project:id:zitadel:aud',
      assertion: assertion(key, issuer),
    },
  });
  const token = tokenRes.access_token;
  log('token: ok');

  const provider = githubProvider(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET);
  let id = findGithub(await call(api, host, 'POST', '/admin/v1/idps/templates/_search', { token, json: providerQuery }));
  if (id) {
    await call(api, host, 'PUT', `/admin/v1/idps/github/${id}`, { token, json: provider });
    log(`identity provider GitHub: updated (${id})`);
  } else {
    id = (await call(api, host, 'POST', '/admin/v1/idps/github', { token, json: provider })).id;
    log(`identity provider GitHub: created (${id})`);
  }

  const { policy } = await call(api, host, 'GET', '/admin/v1/policies/login', { token });
  const update = loginPolicyUpdate(policy ?? {});
  if (update) {
    await call(api, host, 'PUT', '/admin/v1/policies/login', { token, json: update });
    log('login policy: external identity providers allowed');
  } else log('login policy: external identity providers already allowed');

  if (linked(await call(api, host, 'POST', '/admin/v1/policies/login/idps/_search', { token, json: {} }), id))
    log('login policy: GitHub already offered');
  else {
    await call(api, host, 'POST', '/admin/v1/policies/login/idps', { token, json: { idpId: id } });
    log('login policy: GitHub offered');
  }

  if (env.SMTP_HOST) {
    const want = smtpConfig(env.SMTP_HOST, env.SMTP_SENDER);
    const plan = smtpPlan(await call(api, host, 'POST', '/admin/v1/smtp/_search', { token, json: {} }), want);
    let smtpId = plan.id;
    if (plan.add) {
      smtpId = (await call(api, host, 'POST', '/admin/v1/smtp', { token, json: want })).id;
      log(`smtp: added (${smtpId})`);
    } else if (plan.update) {
      await call(api, host, 'PUT', `/admin/v1/smtp/${smtpId}`, { token, json: want });
      log(`smtp: updated (${smtpId})`);
    } else log(`smtp: unchanged (${smtpId})`);
    if (plan.activate) {
      await call(api, host, 'POST', `/admin/v1/smtp/${smtpId}/_activate`, { token, json: {} });
      log('smtp: activated');
    }
  }
}

// Run when started as a program. A ConfigMap mounts the file through symlinks, and Node resolves the
// main module's URL to the real path, so compare with the real path of argv[1].
const started = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (started) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
