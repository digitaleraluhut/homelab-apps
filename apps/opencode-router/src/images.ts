// Images built in this repository (build-opencode-image.yml, build-cloudflare-operator.yml) are
// not written into the stack config. The build pushes the tag `latest` from main, and each deploy
// pins whatever `latest` points to at that moment, by digest. A config value can still pin a
// specific image (e.g. for a rollback).

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",")

/** Returns `ghcr.io/<repo>@<digest>` for `ghcr.io/<repo>:<tag>` (public images, anonymous pull). */
export async function resolveImage(ref: string, fetchFn: Fetch = fetch): Promise<string> {
  if (ref.includes("@")) return ref
  const match = /^ghcr\.io\/([^:]+):([^:/]+)$/.exec(ref)
  if (!match) throw new Error(`resolveImage: only ghcr.io/<repo>:<tag> references are supported, got ${ref}`)
  const [, repo, tag] = match

  const tokenRes = await fetchFn(`https://ghcr.io/token?scope=repository:${repo}:pull`)
  if (!tokenRes.ok) throw new Error(`resolveImage: token for ${repo}: HTTP ${tokenRes.status}`)
  const { token } = (await tokenRes.json()) as { token: string }

  const res = await fetchFn(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_TYPES },
  })
  const digest = res.headers.get("docker-content-digest")
  if (!res.ok || !digest) throw new Error(`resolveImage: ${ref}: HTTP ${res.status}, no digest`)
  return `ghcr.io/${repo}@${digest}`
}
