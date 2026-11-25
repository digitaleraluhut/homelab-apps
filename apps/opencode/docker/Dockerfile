# opencode with the tools for development: the upstream image (Alpine) has only the opencode binary.
# Built by .github/workflows/build-opencode-dev-image.yml as ghcr.io/digitaleraluhut/opencode-dev:<opencode version>.
# Renovate raises the base (tag and digest); the app pins the built image by digest.
FROM ghcr.io/anomalyco/opencode:2.4.1@sha256:10e340e3e86d7b23e95cd9960f5a934beae8a87593d7398b5629b6112ed1fc63

# From Alpine's own packages (no installer scripts): version control and shell tools, Node.js with
# npm/npx and pnpm, Python with pip, Go, a C/C++ toolchain for native npm modules, ripgrep, jq, gh.
RUN apk add --no-cache \
      git bash curl openssh-client \
      nodejs npm pnpm \
      python3 py3-pip \
      go build-base \
      ripgrep jq github-cli

# bun is not packaged for this Alpine release; npm installs its musl build, pinned.
RUN npm install -g --no-fund --no-audit bun@1.4.5 && bun --version

# The upstream entrypoint stays: opencode.
