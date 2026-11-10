import { defineConfig } from 'vitest/config';

// Every app is its own test project with its own root (and config, if it has one).
// Nested npm projects with their own lockfile (e.g. the cloudflare operator) are
// tested by their own pipeline, not from here.
export default defineConfig({
  test: { projects: ['apps/*'] },
});
