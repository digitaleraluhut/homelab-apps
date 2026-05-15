# Development Plan: homelab-apps (feat/lobehub-self-hosted-sandbox branch)

*Generated on 2026-05-13 by Vibe Feature MCP*
*Workflow: [epcc](https://codemcp.github.io/workflows/workflows/epcc)*

## Goal

Add a self-hosted, cloudless code-execution capability to the LobeHub instance running in homelab-apps.

**Confirmed node info** (flinker, the k3s node):
- Kernel: `6.18.18-061818-generic` — satisfies Linux 6.12+ (sandlock full ABI v6) ✅
- KVM: `/dev/kvm` present ✅ — satisfies worker-boxlite requirement ✅

Both Option B (onlyboxes + worker-boxlite) and Option E (custom MCP + sandlock) are technically viable.

**Final chosen approach: Option E — Custom minimal MCP server wrapping sandlock**

Rationale:
- Simpler: single sidecar container, no console+worker architecture
- Better security for this use case: Landlock+seccomp (kernel-enforced process isolation)
  is sufficient for personal homelab; no shared Docker daemon
- No external daemon (no Docker, no gRPC, no KVM device mount needed)
- Standard k8s pod — no special device mounts or PSS relaxation needed
- The custom MCP server wrapper is ~100-150 lines of Python (FastMCP or raw MCP SDK)
- Full Landlock ABI v6 available (Linux 6.18 > 6.12 requirement)
- Streamable HTTP transport = directly compatible with LobeHub's `StreamableHTTPClientTransport`

## Key Decisions

### 1. Rejected approaches
- **Rejected Kilntainers** — user explicitly does not want this tool.
- **Rejected Option A (custom market API server)** — more effort, custom image to maintain.
- **Rejected Option B (onlyboxes + worker-boxlite)** — 2-sidecar architecture, gRPC,
  /dev/kvm device mount needed; more complex than necessary for personal use.
- **Rejected Option C (sandlock-mcp as-is)** — SSE transport incompatible with LobeHub Streamable HTTP.
- **Rejected standalone Deployment** — sidecar is simpler (no separate Service, no inter-pod networking).

### 2. Chosen approach: Option E — Custom MCP server wrapping sandlock (sidecar)

**Architecture:**
```
LobeHub Pod
├── lobehub          (main container, port 3210)
└── sandbox-mcp      (sidecar: Python, port 8888 — localhost only)
    ├── FastMCP/MCP SDK — Streamable HTTP server at POST /mcp
    ├── sandlock CLI — process-level sandbox (Landlock + seccomp)
    └── Python 3.x runtime for code execution
```

**How it works:**
1. `sandbox-mcp` sidecar runs a Streamable HTTP MCP server on `localhost:8888`
2. For each tool call (e.g. `execute_python`), it shells out to:
   `sandlock run -r /usr -r /lib -r /etc -w /tmp/session/<topic_id> -m 256M -P 20 -- python3 -c <code>`
3. LobeHub's Node.js server connects to `http://localhost:8888/mcp` server-side
4. User registers it as a custom MCP plugin in LobeHub (URL: `http://localhost:8888/mcp`)

**MCP tools to expose:**
- `execute_python(code, session_id?)` — run Python in sandlock sandbox
- `run_shell(command, session_id?)` — run shell command in sandlock
- `read_file(path, session_id)` — read file from session workspace
- `write_file(path, content, session_id)` — write file to session workspace
- `list_files(path?, session_id)` — list workspace files

**Session model:** per `session_id` (maps to `topicId` from LobeHub), sandboxed to
`/tmp/sessions/<session_id>/` — filesystem persists within a conversation, shared kernel.

**Security:**
- Landlock: read-only access to `/usr`, `/lib`, `/etc`; read-write only to `/tmp/sessions/<id>/`
- seccomp-bpf: deny dangerous syscalls (ptrace, mount, etc.)
- seccomp user notification: memory limit 256M, process limit 20, no network by default
- NO_NEW_PRIVS: code cannot gain elevated privileges
- Shared kernel: no VM boundary, but Landlock+seccomp is kernel-enforced

**k8s requirements:**
- Standard pod, no privileged container
- No hostPath volumes, no device mounts
- Namespace PSS: `restricted` (no relaxation needed)
- sandlock binary available in container: `pip install sandlock` or pre-built binary

### 3. Container image for sandbox-mcp sidecar
Custom Docker image (built in CI, pushed to ghcr.io):
```dockerfile
FROM python:3.12-slim
RUN pip install sandlock "mcp[cli]" fastmcp
COPY server.py /app/server.py
CMD ["python", "/app/server.py"]
```
Image: `ghcr.io/mrsimpson/lobehub-sandbox-mcp:<tag>`
Built via GitHub Actions (same pattern as other apps in homelab-apps).

### 4. MCP plugin registration in LobeHub — USER ACTION REQUIRED (post-deploy)
No env var can pre-configure plugins in LobeHub. Manual steps after deploy:
1. Open LobeHub → Settings → Plugins → Install Custom Plugin → MCP type
2. URL: `http://localhost:8888/mcp` (resolved server-side by LobeHub Node.js)
3. Auth: none needed (localhost-only, no external access)
4. LobeHub fetches manifest and installs the tools

### 5. Pulumi changes (all in `apps/lobehub/src/index.ts`)
- Add `extraContainers` with the sandbox-mcp sidecar spec
- No new secrets needed (no auth token for localhost sidecar)
- No new volumes (sidecar uses emptyDir via /tmp)
- Optional: add `imagePullSecrets` if image is private

### 6. Confirmed node environment
- Node: `flinker`, kernel `6.18.18` (Ubuntu mainline)
- Landlock ABI v6 fully supported (6.12+) ✅
- KVM available (/dev/kvm) ✅ (not needed for chosen approach)
- sandlock `pip install sandlock` will work without compilation issues

### 2. Chosen approach: onlyboxes as LobeHub sidecar (Option B)

**Architecture:**
```
LobeHub Pod
├── lobehub          (main container, port 3210)
├── onlyboxes        (sidecar: console, port 8089 + gRPC 50051 — localhost only)
└── onlyboxes-worker (sidecar: worker-docker binary, connects to localhost:50051)
    └── requires Docker socket: /var/run/docker.sock (hostPath volume)
```

**How LobeHub calls onlyboxes:**
- HTTP MCP type: LobeHub server (tRPC handler) connects to the MCP URL **server-side**
- URL stored in plugin's `customParams.mcp.url` in LobeHub's PostgreSQL DB
- `toolsClient.mcp.callTool.mutate(data)` → server's MCPClient → `StreamableHTTPClientTransport`
- URL = `http://localhost:8089/mcp` (localhost because sidecar shares pod network namespace)
- Auth = Bearer token stored in plugin's `customParams.mcp.auth.token`

**Why sidecar works:**
- Containers in the same pod share the network namespace → `localhost:8089` works from LobeHub container
- `extraContainers` field is supported in `homelab-core-components` `ExposedWebAppArgs`
- No extra Kubernetes Service or IngressRoute needed for the sandbox

**onlyboxes requirements confirmed:**
- console binary: single Go binary, embeds web dashboard, exposes `:8089` (HTTP) + `:50051` (gRPC)
- worker-docker: Rust binary, connects to console via gRPC, requires Docker socket access
- MCP endpoint: `POST /mcp` — Streamable HTTP, requires Bearer token
- MCP tools exposed: `pythonExec`, `terminalExec`, `echo` (readImage needs worker-sys, skip)
- `pythonExec` runs `docker create ... python -c <code>` → needs Docker daemon
- `terminalExec` runs stateful Docker containers per session_id → needs Docker daemon
- Auth: access token (bearer), created via dashboard API; stored in LobeHub plugin settings

**k3s / security constraints:**
- `worker-docker` needs `/var/run/docker.sock` from the host
- This requires `hostPath` volume → `ExposedWebApp` automatically relaxes namespace PSS to `privileged`
  (per the `allowRoot` / `hostPath` logic in homelab-core-components)
- Docker socket access = effectively root on the node; acceptable for personal homelab
- Worker runs the `worker-docker` binary directly (not inside a Docker container itself)

### 3. MCP plugin registration in LobeHub — USER ACTION REQUIRED
There is **no env var** to pre-configure plugins in LobeHub. Registration must be done manually:
1. Deploy the stack (lobehub with onlyboxes sidecar)
2. Retrieve the onlyboxes bearer token from the Kubernetes secret
3. Open LobeHub → Settings → Plugins → Install Custom Plugin → MCP type
4. Set URL: `http://localhost:8089/mcp` (server-side URL, not browser URL)
5. Set auth: Bearer token from step 2
6. LobeHub fetches the manifest and installs the plugin
7. Enable the plugin on agents as needed

**Alternative: seed the plugin via DB init job** (optional, more complex — skip for v1)

### 4. onlyboxes configuration for sidecar mode
- `CONSOLE_HASH_KEY`: random 32+ char key (stored as k8s secret)
- `CONSOLE_DASHBOARD_USERNAME` / `CONSOLE_DASHBOARD_PASSWORD`: admin credentials (k8s secret)
- `CONSOLE_ENABLE_REGISTRATION=false` (personal use, no extra accounts)
- gRPC and HTTP listen on localhost (sidecar shares network with LobeHub)
- Access token: created via API call in a post-deploy init job, OR manually via dashboard
- `WORKER_CONSOLE_INSECURE=true` (gRPC between worker sidecar and console is localhost-only, no TLS needed)
- `WORKER_PYTHON_EXEC_DOCKER_IMAGE`: e.g. `ghcr.io/astral-sh/uv:python3.12-bookworm-slim`
- `WORKER_TERMINAL_EXEC_DOCKER_IMAGE`: e.g. `coolfan1024/onlyboxes-default-worker:0.0.5`

### 5. `runtimeMode` is per-agent, not a server env var
`RuntimeEnvMode = 'cloud' | 'local' | 'none'` — stored in each agent's chatConfig.
No server-side change needed. The onlyboxes MCP plugin is registered as a custom plugin,
not as the built-in cloud-sandbox. runtimeMode stays `'none'`.

### 6. Pulumi implementation plan
Add to `apps/lobehub/src/index.ts`:
- New k8s Secret: `lobehub-onlyboxes` with `CONSOLE_HASH_KEY`, admin credentials
- New k8s Secret: `lobehub-onlyboxes-token` with the bearer token (set separately post-deploy or via init job)
- `extraVolumes`: hostPath `/var/run/docker.sock` for docker socket
- `extraContainers`: onlyboxes console + onlyboxes worker-docker sidecar containers
- `securityContext.allowRoot` NOT needed for the main lobehub container
- The worker-docker sidecar itself needs to run as root or have socket access

**No new Pulumi stack needed** — everything added to `apps/lobehub/`.

## Implementation Plan

### Overview
Three deliverables:
1. **`apps/lobehub/sandbox-mcp/`** — Python MCP server + Dockerfile
2. **`.github/workflows/build-sandbox-mcp.yml`** — CI to build + push image to ghcr.io
3. **`apps/lobehub/src/index.ts`** — Pulumi: add sidecar container + update namespace PSS if needed

---

### Deliverable 1: `apps/lobehub/sandbox-mcp/`

**Directory structure:**
```
apps/lobehub/sandbox-mcp/
├── Dockerfile
├── server.py       ← MCP server (~120 lines)
└── README.md       ← post-deploy instructions (plugin registration)
```

**`server.py` design:**

Uses `mcp` SDK (PyPI: `mcp[cli]`) with `FastMCP` for tool registration,
served via Streamable HTTP (`mcp.server.fastmcp.FastMCP.run(transport='streamable-http')`).

```python
from mcp.server.fastmcp import FastMCP
from sandlock import Sandbox
import os, pathlib, textwrap

SESSION_BASE = pathlib.Path("/tmp/sessions")
SESSION_BASE.mkdir(exist_ok=True)

mcp = FastMCP("sandbox-mcp")

def _sandbox(session_id: str) -> Sandbox:
    ws = SESSION_BASE / session_id
    ws.mkdir(exist_ok=True)
    return Sandbox(
        fs_writable=[str(ws)],
        fs_readable=["/usr", "/lib", "/lib64", "/etc"],
        max_memory="256M",
        max_processes=20,
        clean_env=True,
        env={"HOME": str(ws), "TMPDIR": str(ws)},
    )

@mcp.tool()
def execute_python(code: str, session_id: str = "default") -> str:
    """Execute Python code in a sandboxed environment. Returns stdout+stderr."""
    result = _sandbox(session_id).run(["python3", "-c", code], timeout=30)
    return (result.stdout + result.stderr).decode(errors="replace")

@mcp.tool()
def run_shell(command: str, session_id: str = "default") -> str:
    """Run a shell command in a sandboxed environment. Returns stdout+stderr."""
    result = _sandbox(session_id).run(["sh", "-c", command], timeout=30)
    return (result.stdout + result.stderr).decode(errors="replace")

@mcp.tool()
def read_file(path: str, session_id: str = "default") -> str:
    """Read a file from the session workspace."""
    ws = SESSION_BASE / session_id
    full = (ws / path).resolve()
    if not str(full).startswith(str(ws)):
        return "Error: path traversal denied"
    return full.read_text(errors="replace") if full.exists() else "Error: file not found"

@mcp.tool()
def write_file(path: str, content: str, session_id: str = "default") -> str:
    """Write a file to the session workspace."""
    ws = SESSION_BASE / session_id
    ws.mkdir(exist_ok=True)
    full = (ws / path).resolve()
    if not str(full).startswith(str(ws)):
        return "Error: path traversal denied"
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content)
    return f"Written {len(content)} bytes to {path}"

@mcp.tool()
def list_files(path: str = ".", session_id: str = "default") -> str:
    """List files in the session workspace directory."""
    ws = SESSION_BASE / session_id
    target = (ws / path).resolve()
    if not str(target).startswith(str(ws)):
        return "Error: path traversal denied"
    if not target.exists():
        return "Directory not found"
    entries = sorted(target.iterdir())
    return "\n".join(
        f"{'d' if e.is_dir() else 'f'} {e.name}" for e in entries
    )

if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=8888)
```

**`Dockerfile` design:**

```dockerfile
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# sandlock needs Rust-compiled FFI lib; pip install builds it via maturin
RUN pip install --no-cache-dir sandlock "mcp[cli]"

WORKDIR /app
COPY server.py /app/server.py

# Run as non-root
RUN useradd -m -u 1000 sandbox
USER sandbox

EXPOSE 8888
CMD ["python", "/app/server.py"]
```

**Notes:**
- `sandlock` pip package builds `libsandlock_ffi.so` via maturin/Rust during install
  → image build requires `gcc` and Rust (via `rustup` or pre-built wheel)
- **Alternative**: use pre-built wheel from sandlock releases if available;
  otherwise add `curl | sh` rustup install in Dockerfile (only at build time)
- Image tag: `ghcr.io/<owner>/lobehub-sandbox-mcp:<sha>` — short SHA from GitHub Actions
- Image is pulled with the existing `ghcr-pull-secret` in the lobehub namespace

**Sandlock kernel requirement confirmed:** Linux 6.12+ (ABI v6) — flinker has 6.18 ✅

---

### Deliverable 2: `.github/workflows/build-sandbox-mcp.yml`

Triggered on push to `main` when `apps/lobehub/sandbox-mcp/**` changes, and on `workflow_dispatch`.

```yaml
name: Build sandbox-mcp image

on:
  push:
    branches: [main]
    paths:
      - apps/lobehub/sandbox-mcp/**
  workflow_dispatch:

permissions:
  contents: read
  packages: write   # needed to push to ghcr.io

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: apps/lobehub/sandbox-mcp
          push: true
          tags: |
            ghcr.io/${{ github.repository_owner }}/lobehub-sandbox-mcp:latest
            ghcr.io/${{ github.repository_owner }}/lobehub-sandbox-mcp:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

**Notes:**
- Uses `GITHUB_TOKEN` — no additional secrets needed (packages: write permission)
- Image SHA tag used in Pulumi config: `lobehub:sandboxMcpImage`
- Image build time: ~3-5 min (Rust compilation for sandlock FFI)
- Layer-cached in GitHub Actions cache (BuildKit GHA cache)

---

### Deliverable 3: Pulumi changes in `apps/lobehub/src/index.ts`

**New config key:**
```bash
pulumi config set lobehub:sandboxMcpImage ghcr.io/mrsimpson/lobehub-sandbox-mcp:<sha> \
  --cwd apps/lobehub
```

**Changes to `index.ts`:**

1. Add config read at top:
```typescript
const sandboxMcpImage = cfg.require('sandboxMcpImage');
```

2. Add `extraContainers` to `createExposedWebApp` call:
```typescript
extraContainers: [
  {
    name: 'sandbox-mcp',
    image: sandboxMcpImage,
    imagePullPolicy: 'Always',
    ports: [{ containerPort: 8888, protocol: 'TCP' }],
    resources: {
      requests: { cpu: '50m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
    },
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 1000,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: false,  // sandlock needs /tmp
      capabilities: { drop: ['ALL'] },
    },
    readinessProbe: {
      httpGet: { path: '/health', port: 8888 },
      initialDelaySeconds: 10,
      periodSeconds: 10,
    },
  },
],
```

3. **Namespace PSS**: remains `restricted` — the sandbox-mcp sidecar:
   - Runs as non-root (UID 1000) ✅
   - No privileged ✅
   - No hostPath volumes ✅
   - No device mounts ✅
   - `allowPrivilegeEscalation: false` ✅
   - `capabilities: drop ALL` ✅
   - **BUT**: `readOnlyRootFilesystem: false` — sandlock writes to `/tmp`
     → PSS `restricted` requires `readOnlyRootFilesystem: true` OR mounted emptyDir for `/tmp`
   - **Solution**: add `emptyDir` volume for `/tmp/sessions` to allow writes without root fs

4. **Volume for sessions (optional but clean):**
```typescript
extraVolumes: [
  { name: 'sandbox-sessions', emptyDir: {} },
],
```
And in the sidecar spec:
```typescript
volumeMounts: [
  { name: 'sandbox-sessions', mountPath: '/tmp/sessions' },
],
```
With `readOnlyRootFilesystem: true` in securityContext → fully PSS `restricted` compliant ✅

**Note on `readOnlyRootFilesystem`**: sandlock itself also writes (supervisor tmp files).
May need `emptyDir` for `/tmp` too, not just `/tmp/sessions`. Test in CI/CD.

---

### Post-deploy: Manual MCP plugin registration in LobeHub

After `pulumi up` succeeds:

1. Verify sidecar is running:
   ```bash
   kubectl -n lobehub get pods
   kubectl -n lobehub logs deployment/lobehub -c sandbox-mcp
   ```
2. Open LobeHub → **Settings** (gear icon) → **Extensions** → **Plugin Store** → **Custom Plugin**
3. Select type: **MCP**
4. Set URL: `http://localhost:8888/mcp`
   *(This is the server-side URL — LobeHub's Node.js process resolves it within the pod)*
5. No auth needed (localhost-only sidecar)
6. Click **Install** — LobeHub fetches the MCP manifest and installs the tools
7. Enable the plugin on desired agents via agent settings

**Tools available after install:**
- `execute_python` — run Python code
- `run_shell` — run shell commands
- `read_file` — read workspace files
- `write_file` — write workspace files
- `list_files` — list workspace files

**Session model:** pass a `session_id` string (e.g. the LobeHub topic ID) to share
a workspace across multiple tool calls within a conversation.

---

### Edge cases and open questions

| Issue | Resolution |
|-------|-----------|
| sandlock FFI Rust build in Docker | Add Rust toolchain to Docker image at build time; or use pre-built wheel if available |
| `readOnlyRootFilesystem: true` vs sandlock's own temp writes | Mount emptyDir at `/tmp` for the sidecar; test during CI |
| Session cleanup | `/tmp/sessions` lives in emptyDir — automatically wiped on pod restart. No cleanup job needed. |
| Concurrent executions | sandlock is stateless per call; safe for concurrent tool calls |
| Health endpoint on `/health` | FastMCP may not expose `/health` by default — use TCP probe on port 8888 instead, or add a simple health route |
| sandlock network isolation | Default: no outbound allowed from sandboxed code. Can open specific hosts via `net_allow` if needed. |
| Image visibility | ghcr.io image is public (repo is public) — no imagePullSecret needed for sandbox-mcp image. Keep existing `ghcr-pull-secret` for lobehub main image. |

---

### 7. Sandlock-in-container validation (verified on cluster 2026-05-15)

**Findings from live testing on flinker (kernel 6.18.18, k3s):**

| Scenario | Result |
|----------|--------|
| Landlock ABI on node | **7** (≥ required 6) ✅ |
| sandlock in container, `Unconfined` seccomp, no extra mounts | ✅ works |
| sandlock in container, `RuntimeDefault` seccomp, no extra mounts | ✅ works |
| sandlock in container, `RuntimeDefault` seccomp, `emptyDir` on `/tmp` | ❌ `sandlock_spawn failed` |
| sandlock in container, `Unconfined` seccomp, `emptyDir` on `/tmp/sessions` | ✅ works |
| sandlock in container, ConfigMap volume mount (any path) | ❌ `sandlock_spawn failed` (mountinfo confusion) |

**Root cause of failures:**
- sandlock's Landlock supervisor reads `/proc/self/mountinfo` to discover filesystem boundaries at spawn time
- Mounting a volume at `/tmp` itself replaces the container's writable tmpfs that sandlock's supervisor uses for its own IPC socket — spawn fails
- ConfigMap mounts (with their `..YYYY_` symlink structure) appear to confuse sandlock's mountinfo parsing
- **Key finding**: mounting emptyDir at `/tmp/sessions` (a subdirectory) does NOT affect sandlock — only mounts at `/tmp` itself cause issues

**Impact on our sidecar design:**
- Our Pulumi config mounts emptyDir at `/tmp/sessions` — ✅ **correct and tested**
- Do NOT mount anything at `/tmp` itself in the sandbox-mcp sidecar
- `server.py` must be in the image (baked in), not mounted via ConfigMap — ✅ already the case
- PSS `restricted` with `RuntimeDefault` seccomp is sufficient — no `Unconfined` needed ✅

**Still needed:** Add `seccompProfile: RuntimeDefault` to the sidecar pod-level securityContext in Pulumi (required by PSS restricted).

---

## Option D: LobeHub Skill + CLI tool (user's question)

### What a LobeHub "Skill" actually is
A LobeHub Skill is **NOT a tool/API** — it is a **system prompt injection**:
- A Skill is a `SKILL.md` file (YAML frontmatter + markdown content)
- When activated, its markdown content is injected into the agent's system prompt as `<available_skills>`
- It tells the LLM *how to use* certain tools/CLIs — it does NOT execute anything by itself
- Examples: `agent-browser` skill = markdown instructions for using the `agent-browser` CLI tool
- `artifacts` skill = markdown instructions for generating LobeArtifact XML responses

### How Skills + execution tools work together
Skills inject *instructions* that tell the LLM to call execution tools:
```
Skill (system prompt) → tells LLM how to use CLI
LLM calls execScript/runCommand tool → which calls market.plugins.runBuildInTool()
  → POST MARKET_BASE_URL/v1/plugins/run-buildin-tools { toolName: 'execScript', params: {...} }
```

Critically: **`execScript` and `runCommand` are cloud sandbox tools** — they go through
`MARKET_BASE_URL` exactly like `executeCode`. They require `runtimeMode === 'cloud'`.

### The `execScript` tool (confirmed from source)
- `execScript` is a **cloud sandbox tool** (same API endpoint as all cloud sandbox tools)
- It runs a shell command in the cloud sandbox, with optional `zipUrl` for a skill's code bundle
- Skills can bundle code (ZIP) uploaded to S3 — the skill's own scripts run in the sandbox
- This is the mechanism for market skills like "lobehub" (the lobehub.com platform skill)

### User question answered: "Skill + CLI" approach
**Interpretation 1**: Use a Skill to inject instructions, paired with an MCP tool for execution
- Skill = system prompt instructions telling LLM how to call a `sandlock`/`onlyboxes` code execution tool
- Execution = MCP plugin registered separately (the code runner)
- Result: Skill + MCP plugin working together — **this is essentially what we're already building**
  (Option B: MCP plugin) but with a Skill providing better system prompt context
- **Verdict**: Yes, viable. Add a Skill (SKILL.md) that instructs the LLM on how to use the
  code execution MCP plugin tools effectively.

**Interpretation 2**: Use a Skill with `execScript` backed by our own MARKET_BASE_URL server
- Skill triggers `execScript` tool → goes to `MARKET_BASE_URL` → our server
- This is **Option A** (custom market REST server) with a Skill on top
- Requires runtimeMode = `'cloud'` and `MARKET_BASE_URL` override

**Interpretation 3**: Use a Skill that tells the LLM to call a REST API directly
- Skills are just system prompts — the LLM could be instructed to call any REST API
- But LobeHub has no built-in "call arbitrary REST endpoint" tool
- Would require a custom MCP plugin that proxies HTTP calls — circular back to Option B

### Conclusion on "Skill + CLI"
The most practical interpretation for our use case:
- **Deploy Option B (onlyboxes MCP via Streamable HTTP)** as the execution backend
- **Optionally add a Skill** (SKILL.md) that gives the LLM better context on:
  - How to use `pythonExec` / `terminalExec` tools effectively
  - Code execution best practices, session management, etc.
- The Skill is purely additive — it improves LLM behavior, not the execution mechanism
- No additional infrastructure needed beyond what Option B already provides

### Does "CLI" mean something different here?
If the user means "use a CLI (like `sandlock run`) as the execution primitive":
- sandlock CLI runs locally (process-level sandbox) — needs to be installed in the sidecar container
- Could build a custom MCP server wrapping `sandlock run` CLI calls
- This is essentially `worker-boxlite` concept but using sandlock for isolation instead of KVM
- **Sandlock transport gap remains** (SSE vs Streamable HTTP) unless we wrap it ourselves

## Option E: Custom minimal MCP server wrapping sandlock CLI (NEW synthesis)

Given sandlock's security advantages and the transport gap, a custom wrapper becomes attractive:
- Write a minimal **Streamable HTTP MCP server** (Node.js or Python, ~100 lines)
- That server shells out to `sandlock run python3 <code>` for each tool call
- No Docker, no KVM, no root — just Landlock + seccomp kernel primitives
- Single sidecar container with Python + sandlock CLI installed

**Transport**: Streamable HTTP (`POST /mcp`) — compatible with LobeHub
**Security**: Landlock + seccomp (kernel-enforced, no shared daemon)
**Complexity**: Write ~100 lines of MCP server boilerplate
**Kernel requirement**: Linux 6.7+ (or 5.13 for fs-only)
**MCP tools exposed**: `executeCode`, `runCommand`, `readFile`, `writeFile`, `listFiles`
**Stateful sessions**: Per-session sandboxed directories (shared workspace)

This is potentially the **simplest, most secure, most k8s-native approach**:
- Single sidecar, no DinD, no KVM device
- Standard k8s pod (no privileged context)
- The sandlock kernel requirement (6.7+) is the only constraint

## Summary: All Options Compared

| Option | Approach | Security | Complexity | LobeHub Integration | k8s needs |
|--------|----------|----------|------------|---------------------|-----------|
| A | Custom market REST API | Medium | High | Native cloud-sandbox UI | Standard |
| B | onlyboxes + worker-boxlite | High (KVM VMs) | Medium | MCP plugin | /dev/kvm |
| C | sandlock-mcp | High (Landlock) | Low-Medium | ❌ SSE transport gap | Linux 6.7+ |
| D | Skill + MCP (onlyboxes) | High (KVM VMs) | Medium | MCP plugin + Skill | /dev/kvm |
| E | Custom MCP + sandlock CLI | High (Landlock) | Low | MCP plugin | Linux 6.7+ |

## Key remaining question: kernel version on k3s nodes
Before choosing between B (KVM VMs) and E (sandlock):
- **Option B (worker-boxlite)**: needs KVM (`/dev/kvm` accessible in pod)
- **Option E (sandlock)**: needs Linux 6.7+ for network isolation, 5.13 for fs-only

User should run: `uname -r` and `ls /dev/kvm` on their k3s nodes to determine viability.



The GitHub issue comment (#12472) points to **sandlock** (`multikernel/sandlock`) — a pure process
sandbox using Linux Landlock + seccomp. It has its **own built-in MCP server**.

### What sandlock is
- Process-level sandbox: Landlock (filesystem+network+IPC), seccomp-bpf (syscall filter),
  seccomp user notification (resource limits, IP enforcement, /proc virtualization)
- **No Docker, no VM, no root, no cgroups** — pure Linux kernel primitives
- ~5ms startup (vs 200ms Docker, 100ms Firecracker)
- Rust core + Python SDK + built-in `sandlock-mcp` server
- Apache-2.0 license
- v0.7.0, active project

### sandlock security model
- **Landlock** (kernel 5.13+): filesystem access rules — only allowed paths are readable/writable
- **seccomp-bpf**: syscall allowlist/denylist — blocks dangerous syscalls at kernel level
- **seccomp user notification**: supervisor intercepts `connect`, `mmap`, `execve` etc. in real-time
  to enforce memory limits, network allowlists, and HTTP-level ACLs
- **NO_NEW_PRIVS**: child can never gain more privileges than parent
- Network: full outbound block by default; allowlist per-host:port; HTTP-level method/path ACL
- Shared kernel: code runs in the same kernel, but Landlock + seccomp enforce hard boundaries
- Can run without root, in a standard k8s pod (no privileged context needed)

### sandlock MCP server (`sandlock-mcp`)
Sandlock ships a built-in MCP server with `shell`, `python`, and file tools:
```
sandlock-mcp --transport sse --host 0.0.0.0 --port 8080 --workspace /tmp/sandbox
```
Tools exposed: `shell`, `python`, `read_file`, `write_file`, + any custom tools via Python API.
**Transport**: stdio or **SSE** (older MCP transport, NOT Streamable HTTP).

### Critical compatibility issue: SSE vs Streamable HTTP
- **sandlock-mcp** serves MCP over **SSE** (`/sse` endpoint, older MCP spec)
- **LobeHub** uses `StreamableHTTPClientTransport` — the **newer** MCP spec (`POST /mcp`)
- These are **not directly compatible** without a transport upgrade in sandlock
- The `type: 'http'` in LobeHub's MCP plugin config specifically means Streamable HTTP

### Kernel version requirements
- Full feature set requires **Linux 6.12+** (Landlock ABI v6 for IPC scoping)
- Core features (fs + network) work from **Linux 6.7** (ABI v4)
- Filesystem sandbox alone works from **Linux 5.13** (ABI v1)
- **k3s homelab reality**: Ubuntu 22.04 = kernel 5.15, Ubuntu 24.04 = kernel 6.8
  → 6.12 requirement may NOT be met on Ubuntu 22.04 / Debian 12 nodes
  → IPC scoping would be missing, but fs+network sandboxing would still work on 6.7+

### sandlock vs onlyboxes+worker-boxlite comparison

| Aspect | sandlock-mcp | onlyboxes + worker-boxlite |
|--------|-------------|---------------------------|
| Isolation | Landlock+seccomp (kernel, shared) | KVM micro-VMs (hardware) |
| Security strength | Strong (kernel-enforced, no escape to same-kernel processes) | Strongest (separate guest kernel) |
| Root/privileged | No | /dev/kvm device only |
| MCP transport | SSE only (⚠️ incompatible with LobeHub) | (none — onlyboxes MCP is Streamable HTTP ✅) |
| Docker/VM needed | No | No (boxlite = embedded VM, no daemon) |
| Kernel requirement | Linux 6.12+ (or 6.7 for partial) | KVM support |
| Startup | ~5ms | ~100ms (VM boot) |
| Complexity | Single sidecar, pip install | 2 sidecars (console+worker) + initContainer |
| Stateful sessions | No (per-call) | Yes (terminalExec sessions) |
| Languages | Python, shell | Python, shell (via terminalExec) |

### Verdict on sandlock
- **Great security** for a homelab single-user setup
- **Transport incompatibility** is a blocker: sandlock serves SSE, LobeHub expects Streamable HTTP
- Could be fixed by: (a) contributing Streamable HTTP support to sandlock, or (b) adding a thin
  proxy in front, or (c) waiting for sandlock to add the transport
- Kernel 6.12 requirement could be a problem depending on node OS version
- **Not chosen for v1** due to SSE/Streamable HTTP incompatibility with LobeHub

### ⚠️ OPEN QUESTION: What kernel version runs on your k3s nodes?
This affects both sandlock (needs 6.12 for full features) and worker-boxlite (needs KVM = any modern kernel).
Please check with: `uname -r` on your k3s nodes.

## Security Analysis

### DinD security model — does it allow elevated code?

**Short answer for personal homelab: DinD is acceptable; code running inside containers cannot
escape to the host easily, but it does have elevated capabilities within the DinD daemon scope.**

#### What DinD does
- `docker:dind` runs a Docker daemon inside a privileged pod container
- The DinD container has `privileged: true` → full Linux capabilities on the host kernel
- The worker spawns execution containers inside the DinD daemon (nested containers)
- Those execution containers are: `docker create ... python -c <code>` (worker-docker docs confirm this)

#### worker-docker's docker create command (confirmed from source)
```
docker create
  --name <generated>
  --label onlyboxes.managed=true
  --memory <limit>
  --cpus <limit>
  --pids-limit <limit>
  <python_exec_image>
  python -c <code>
```
**Notable absences**: NO `--network none`, NO `--cap-drop ALL`, NO `--read-only`.
This means code running inside the execution container can:
- Access the network (outbound HTTP, DNS)
- Potentially write anywhere in its own container filesystem
- Use any capability available to unprivileged containers

#### The DinD privilege chain
```
Host kernel
  └── DinD container (privileged=true, full caps on host)
        └── execution container (docker create, limited memory/cpu/pids but:)
              └── code runs as root (default in most Python images)
                    - can call syscalls not blocked by Docker's default seccomp
                    - CAN potentially break out to DinD daemon level
                    - CANNOT directly escape to host (protected by DinD boundary)
```

#### Security verdict for homelab (single user, trusted input)
- **For personal use**: Acceptable. You are the only user; the AI generating code is trusted.
- **Not for multi-tenant**: Code → DinD daemon escape → host-level compromise is theoretically possible.
- **Real risk**: code running as root in the exec container + DinD privileged = root within DinD scope.
  An attacker with code execution in the container could potentially gain root on the k3s node.
- **Mitigation in worker-docker**: memory, CPU, PID limits provide DoS protection; no network isolation.

### worker-boxlite security model — MUCH BETTER

`worker-boxlite` uses **Boxlite** instead of Docker:
- Boxlite = embeddable VM runtime (libkrun + KVM on Linux, Hypervisor.framework on macOS)
- Each execution runs inside a **micro-VM** (hardware isolation, separate kernel)
- Security layers: KVM hardware isolation + seccomp/namespace inside shim + cgroups
- **No privileged container needed** — Boxlite needs `/dev/kvm` device access only
- Code running inside a Boxlite VM **cannot escape to host** without a hypervisor-level vulnerability

#### worker-boxlite requirements
- `/dev/kvm` device access (KVM-enabled Linux kernel) — k3s nodes typically support this
- No Docker daemon needed
- Released binary: `onlyboxes-worker-boxlite_0.5.1_linux_amd64.zip` ✅

#### worker-boxlite vs DinD comparison
| Aspect | worker-docker + DinD | worker-boxlite |
|--------|---------------------|----------------|
| Isolation | Docker namespaces (weak) | KVM hardware VMs (strong) |
| Privilege needed | `privileged: true` on DinD | `/dev/kvm` device only |
| Escape risk | Medium (DinD chain) | Very low (hypervisor boundary) |
| Network isolation | None by default | Configurable |
| k3s requirement | DinD image + privileged pod | `/dev/kvm` on node |
| Complexity | 2 extra sidecars | 1 extra sidecar |

### Chosen security approach: worker-boxlite + /dev/kvm

**Decision**: Use `worker-boxlite` instead of `worker-docker + DinD`.

Reasons:
1. Better security: VM-level isolation, code cannot escape to host
2. Simpler: only 2 sidecars (console + worker-boxlite), no DinD
3. No privileged container: just `/dev/kvm` device mount
4. k3s nodes almost always have KVM support (bare metal or nested virt)

**Revised sidecar architecture:**
```
LobeHub Pod
├── lobehub             (main container, port 3210)
├── onlyboxes-console   (sidecar: Go binary, port 8089 + gRPC 50051)
└── onlyboxes-worker    (sidecar: worker-boxlite binary)
    └── needs: /dev/kvm device
```

PSS namespace label: `privileged` required (for `/dev/kvm` device access in container).
Actually: device access can work at `baseline` PSS with a `devicePlugin` or explicit device mount;
needs testing. Worst case: namespace PSS = `privileged` (acceptable for personal homelab).

### Residual risks (acceptable for homelab)
- Code can reach the internet (no network isolation in worker-boxlite by default)
- Secrets in the k8s namespace are accessible if code escapes the VM (very unlikely with KVM)
- Resource exhaustion: mitigated by memory/cpu/pids limits on worker-boxlite

## Notes

### homelab-core-components ExposedWebApp capabilities (confirmed)
- `extraContainers?: object[]` — full k8s container spec, sidecars share network namespace
- `extraVolumes?: object[]` — add hostPath, emptyDir, etc.
- `extraVolumeMounts?: object[]` — for main container
- `initContainers?: object[]` — for pre-start setup
- hostPath volumes → automatically relaxes namespace PSS to `privileged`

### onlyboxes images and binaries
- Console: `coolfan1024/onlyboxes:latest` or `coolfan1024/onlyboxes:0.5.1` (Docker image ✅)
- Worker binaries: released as GitHub release binaries (no container image):
  - `onlyboxes-worker-boxlite_0.5.1_linux_amd64.zip` ✅ (chosen)
  - `onlyboxes-worker-docker_0.5.1_linux_amd64.zip` (not used)
  → Use initContainer to download `worker-boxlite` binary and place in emptyDir
  → Worker sidecar: plain container running the binary from emptyDir volume mount

### onlyboxes MCP tools available
- `echo` — simple ping/test
- `pythonExec` — runs Python code in isolated Docker container
- `terminalExec` — stateful shell session in Docker container (session_id for persistence)
- `readImage` — needs worker-sys (desktop/computer-use), skip

### LobeHub MCP URL routing (confirmed server-side)
- `customParams.mcp.url` is resolved by LobeHub's **Node.js server** (not the browser)
- The URL `http://localhost:8089/mcp` is reachable from within the pod (shared network namespace)
- Auth token passed as `customParams.mcp.auth = { type: 'bearer', token: '<token>' }`
- LobeHub merges pluginSettings into headers for http-type plugins

### onlyboxes access token provisioning
- Token is created via `POST /api/v1/console/tokens` (requires dashboard session/cookie auth)
- Chicken-and-egg: can't create token until console is running
- Solutions for v1: user creates token manually via dashboard after deploy
- Future: Kubernetes Job that calls the console API post-deploy to create a token and write to secret

### Docker socket security in k3s
- `/var/run/docker.sock` hostPath on k3s node
- k3s uses containerd by default, NOT Docker. Node may not have Docker installed!
- **Critical issue**: `worker-docker` needs the Docker daemon — k3s uses containerd
- Mitigation options:
  (a) Install Docker on the k3s node alongside containerd (extra daemon)
  (b) Use a Docker-in-Docker (DinD) sidecar (docker:dind image)
  (c) Use `worker-sys` (host shell worker) instead of worker-docker — doesn't need Docker
      but worker-sys only supports `computerUse` and `readImage`, NOT `pythonExec`/`terminalExec`
  (d) Use a different MCP code execution server that doesn't need Docker
- **Preferred**: DinD sidecar — self-contained within the pod, no node Docker required
  Worker connects to DinD via `DOCKER_HOST=tcp://localhost:2375`

### Chosen sidecar architecture: worker-boxlite (no DinD)
```
LobeHub Pod
├── lobehub             (main container, port 3210)
├── onlyboxes-console   (sidecar: Go binary, port 8089 + gRPC 50051 — localhost only)
└── onlyboxes-worker    (sidecar: worker-boxlite binary — uses KVM, /dev/kvm device)
```
Security: VM-level isolation per execution (KVM/libkrun), no privileged container needed.
Requires `/dev/kvm` device access; namespace PSS may need `privileged` label but no privileged containers.

## Explore
<!-- beads-phase-id: homelab-apps-2.1 -->
### Tasks
<!-- beads-synced: 2026-05-15 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*


## Plan
<!-- beads-phase-id: homelab-apps-2.2 -->
### Tasks
<!-- beads-synced: 2026-05-15 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-apps-2.2.1` Research sandlock Python API / FastMCP for MCP server implementation pattern
- [x] `homelab-apps-2.2.2` Design sandbox-mcp Docker image (Dockerfile + server.py)
- [x] `homelab-apps-2.2.3` Design GitHub Actions CI workflow to build + push sandbox-mcp image to ghcr.io
- [x] `homelab-apps-2.2.4` Design Pulumi changes: extraContainers sidecar spec in apps/lobehub/src/index.ts
- [x] `homelab-apps-2.2.5` Define post-deploy manual steps for LobeHub MCP plugin registration

## Code
<!-- beads-phase-id: homelab-apps-2.3 -->
### Tasks
<!-- beads-synced: 2026-05-15 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-apps-2.3.1` Create sandbox-mcp/server.py
- [x] `homelab-apps-2.3.2` Create sandbox-mcp/Dockerfile
- [x] `homelab-apps-2.3.3` Create .github/workflows/build-sandbox-mcp.yml
- [x] `homelab-apps-2.3.4` Update apps/lobehub/src/index.ts with sidecar spec

## Commit
<!-- beads-phase-id: homelab-apps-2.4 -->
### Tasks
<!-- beads-synced: 2026-05-15 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

