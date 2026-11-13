#!/usr/bin/env node
// Render one app (apps/<name>/) with Pulumi mocks and print its resources as JSON.
//
//   node render_app.cjs <app-dir>
//
// Used by data_loss.py. No credentials, no cluster, no Pulumi Cloud, no network:
// - config comes from Pulumi.yaml defaults and Pulumi.dev.yaml; secrets become a placeholder
// - every StackReference (e.g. mrsimpson/homelab/dev) answers with fixed placeholder outputs
// - global fetch answers every request with a fixed, empty response (model lists, image digests)
// - the clock stands still (Date.now(), new Date()), so time-stamped names render the same twice
// - TypeScript is transpiled in place by the repository's own `typescript` (no tsx/ts-node)
// Output: [{urn, type, name, inputs}] sorted by URN. The URN carries the parent chain, as in a
// real stack, so a renamed component shows up as new URNs for its children.

'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const SECRET_PLACEHOLDER = 'render-placeholder-secret';
// Keys of Secrets that apps read instead of create (CNPG's `<cluster>-app` and the like).
const SECRET_READ_DATA = Object.fromEntries(
  ['username', 'user', 'password', 'dbname', 'host', 'port', 'uri', 'jdbc-uri', 'pgpass'].map((k) => [
    k,
    Buffer.from(SECRET_PLACEHOLDER).toString('base64'),
  ]),
);
// Outputs of the homelab base stack the apps and homelab-core-components read.
const STACK_OUTPUTS = {
  domain: 'example.org',
  cloudflareZoneId: 'render-zone-id',
  tunnelId: 'render-tunnel-id',
  tunnelCname: 'render-tunnel.example.org',
};

const appDir = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(appDir, 'Pulumi.yaml'))) {
  console.error(`usage: render_app.cjs <app-dir with Pulumi.yaml>, got ${appDir}`);
  process.exit(2);
}
// Modules resolve from the app, so the app and this script share one @pulumi/pulumi.
const appRequire = createRequire(path.join(appDir, 'package.json'));
const yaml = appRequire('js-yaml');
const ts = appRequire('typescript');

// --- TypeScript: transpile .ts on require, like ts-node with transpileOnly -----------------
require.extensions['.ts'] = (module, filename) => {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      sourceMap: false,
    },
  });
  module._compile(out.outputText, filename);
};

// --- Network: a fixed answer for every fetch -------------------------------------------------
globalThis.fetch = async () =>
  new Response(JSON.stringify({ data: [], token: 'render-token' }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'docker-content-digest': `sha256:${'0'.repeat(64)}`,
    },
  });

// --- Time: one fixed instant, so names like `job-${Date.now()}` render the same twice --------
const FIXED_NOW = Date.parse('2000-01-01T00:00:00Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [FIXED_NOW]));
  }
  static now() {
    return FIXED_NOW;
  }
};

// --- Config ---------------------------------------------------------------------------------
const project = yaml.load(fs.readFileSync(path.join(appDir, 'Pulumi.yaml'), 'utf8'));
const qualify = (key) => (key.includes(':') ? key : `${project.name}:${key}`);
const asConfig = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const config = {};
const secretKeys = [];
for (const [key, spec] of Object.entries(project.config || {})) {
  const v = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec.default ?? spec.value : spec;
  if (v !== undefined) config[qualify(key)] = asConfig(v);
}
const stackFile = path.join(appDir, 'Pulumi.dev.yaml');
const stackConfig = fs.existsSync(stackFile) ? (yaml.load(fs.readFileSync(stackFile, 'utf8')) || {}).config || {} : {};
for (const [key, v] of Object.entries(stackConfig)) {
  if (v && typeof v === 'object' && 'secure' in v) {
    config[qualify(key)] = SECRET_PLACEHOLDER;
    secretKeys.push(qualify(key));
  } else {
    config[qualify(key)] = asConfig(v);
  }
}

// --- Mocks ----------------------------------------------------------------------------------
const pulumi = appRequire('@pulumi/pulumi');
const records = [];
pulumi.runtime.setMocks(
  {
    newResource: (args) => {
      if (args.type === 'pulumi:pulumi:StackReference') {
        return { id: args.name, state: { name: args.inputs.name, outputs: STACK_OUTPUTS, secretOutputNames: [] } };
      }
      if (args.id) {
        // A read (Kind.get(name, id)), e.g. createAppNamespace's namespace handle: Kubernetes
        // ids are "name" or "namespace/name"; give the object that name, as the cluster would.
        const [a, b] = args.id.split('/');
        const metadata = b === undefined ? { name: a } : { namespace: a, name: b };
        const state = { ...args.inputs, metadata: { ...(args.inputs.metadata || {}), ...metadata } };
        // A Secret read returns the keys a controller would have written (e.g. CNPG's `<cluster>-app`,
        // which PostgresInstance reads); the values are base64 placeholders, as the cluster sends them.
        if (args.type === 'kubernetes:core/v1:Secret' && !state.data) state.data = SECRET_READ_DATA;
        return { id: args.id, state };
      }
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: (args) => args.inputs,
  },
  project.name,
  'dev',
  false,
);
pulumi.runtime.setAllConfig(config, secretKeys);

// Secret values arrive wrapped ({<sig>: <secret sig>, value}); the placeholder is enough.
const SIG = '4dabf18193072939515e22adb298388d';
const unwrapSecrets = (v) => {
  if (Array.isArray(v)) return v.map(unwrapSecrets);
  if (!v || typeof v !== 'object') return v;
  if (SIG in v) return unwrapSecrets(v.value);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrapSecrets(x)]));
};

// Record each registration with the URN the mock monitor computes (parent chain included).
const monitor = pulumi.runtime.getMonitor();
const register = monitor.registerResource.bind(monitor);
monitor.registerResource = (req, callback) =>
  register(req, (err, resp) => {
    if (!err && req.getCustom() && req.getType() !== 'pulumi:pulumi:StackReference') {
      const { deserializeProperties } = appRequire('@pulumi/pulumi/runtime/rpc');
      records.push({
        urn: resp.getUrn(),
        type: req.getType(),
        name: req.getName(),
        inputs: unwrapSecrets(deserializeProperties(req.getObject())),
      });
    }
    callback(err, resp);
  });

// --- Run ------------------------------------------------------------------------------------
const fail = (err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
};
process.on('unhandledRejection', fail);

(async () => {
  appRequire(path.resolve(appDir, project.main || '.'));
  // Wait until no more resources appear (some are created inside apply callbacks).
  let seen = -1;
  while (seen !== records.length) {
    seen = records.length;
    await new Promise((r) => setTimeout(r, 200));
  }
  records.sort((a, b) => (a.urn < b.urn ? -1 : a.urn > b.urn ? 1 : 0));
  process.stdout.write(JSON.stringify(records));
  process.exit(0);
})().catch(fail);
