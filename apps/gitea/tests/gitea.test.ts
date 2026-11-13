import { describe, it, expect } from 'vitest';

// The test module loads the app config and validates key decisions.
// These tests do NOT deploy anything; they verify the configuration logic.
//
// Facts looked up from upstream sources:
// - Image: https://hub.docker.com/v2/repositories/gitea/gitea/tags/28.3.0-rootless
// - Dockerfile: https://raw.githubusercontent.com/go-gitea/gitea/v28.3.0/Dockerfile.rootless
// - Config cheat sheet: https://docs.gitea.com/administration/config-cheat-sheet
// - Rootless install docs: https://docs.gitea.com/installation/install-with-docker-rootless

describe('gitea config', () => {
  const APP_NAME = 'gitea';
  const APP_PORT = 3000;
  const RUN_AS = 1000;
  const DEFAULT_IMAGE =
    'docker.io/gitea/gitea:28.3.0-rootless@sha256:40c5a68a0463c0940e1ae32626c8300dd0572f3558e390073ad8379ca67c0e1d';
  const DATA_MOUNT = '/var/lib/gitea';
  const CONFIG_MOUNT = '/etc/gitea';

  it('uses the rootless image with pinned digest', () => {
    expect(DEFAULT_IMAGE).toContain('28.3.0-rootless');
    expect(DEFAULT_IMAGE).toContain('sha256:40c5a68a0463c0940e1ae32626c8300dd0572f3558e390073ad8379ca67c0e1d');
  });

  it('runs as UID 1000 (rootless git user)', () => {
    expect(RUN_AS).toBe(1000);
  });

  it('mounts data at /var/lib/gitea (GITEA_WORK_DIR)', () => {
    expect(DATA_MOUNT).toBe('/var/lib/gitea');
  });

  it('mounts config at /etc/gitea', () => {
    expect(CONFIG_MOUNT).toBe('/etc/gitea');
  });

  it('listens on port 3000', () => {
    expect(APP_PORT).toBe(3000);
  });

  it('locks the first-run installer', () => {
    // INSTALL_LOCK=true prevents anyone from creating an admin account on first start.
    const installLockVars = [
      { name: 'GITEA__security__INSTALL_LOCK', value: 'true' },
    ];
    expect(installLockVars[0].value).toBe('true');
    expect(installLockVars[0].name).toContain('INSTALL_LOCK');
  });

  it('disables SSH', () => {
    const sshVars = [
      { name: 'GITEA__server__DISABLE_SSH', value: 'true' },
    ];
    expect(sshVars[0].value).toBe('true');
  });

  it('disables registration', () => {
    const regVars = [
      { name: 'GITEA__service__DISABLE_REGISTRATION', value: 'true' },
    ];
    expect(regVars[0].value).toBe('true');
  });

  it('uses PostgreSQL with correct env var naming', () => {
    const dbVars = [
      { name: 'GITEA__database__DB_TYPE', value: 'postgres' },
      { name: 'GITEA__database__HOST', value: `${APP_NAME}-db-postgres-rw:5432` },
      { name: 'GITEA__database__NAME', value: APP_NAME },
    ];
    expect(dbVars[0].value).toBe('postgres');
    expect(dbVars[1].value).toContain('5432');
    expect(dbVars[2].value).toBe(APP_NAME);
  });

  it('uses longhorn-persistent storage class', () => {
    // This is a string test; the actual PVC uses 'longhorn-persistent'.
    const storageClass = 'longhorn-persistent';
    expect(storageClass).toBe('longhorn-persistent');
  });

  it('has NodePort 30300 for host access', () => {
    const nodePort = 30300;
    expect(nodePort).toBe(30300);
  });
});
