# opencode with the tools for development: the upstream image (Alpine) has only the opencode binary.
# Built by .github/workflows/build-opencode-dev-image.yml as ghcr.io/digitaleraluhut/opencode-dev:<opencode version>.
# Renovate raises the base (tag and digest); the app pins the built image by digest.
FROM ghcr.io/anomalyco/opencode:2.2.7@sha256:7b1e3139a64121d12e572530974a18b9452967fb4d67516d8cfd9c0e763dd57d

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
