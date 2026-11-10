import { defineConfig } from 'vitest/config';

// Only the router's own tests; cloudflare-operator/ is a separate npm project
// with its own tests (build-cloudflare-operator.yml).
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
});
