# opencode with the tools for development: the upstream image (Alpine) has only the opencode binary.
# Built by .github/workflows/build-opencode-dev-image.yml as ghcr.io/digitaleraluhut/opencode-dev:<opencode version>.
# Renovate raises the base (tag and digest); the app pins the built image by digest.
FROM ghcr.io/anomalyco/opencode:2.4.2@sha256:04c029de93349712b64cc7da6c8400b9ab3e03ca068b98cfe0df11688ba51a30

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
