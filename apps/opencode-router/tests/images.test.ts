import { describe, expect, it, vi } from "vitest"
import { resolveImage } from "../src/images"

const DIGEST = "sha256:" + "a".repeat(64)

function registry(status = 200) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://ghcr.io/token")) {
      expect(url).toBe("https://ghcr.io/token?scope=repository:digitaleraluhut/opencode:pull")
      return new Response(JSON.stringify({ token: "t" }), { status: 200 })
    }
    expect(url).toBe("https://ghcr.io/v2/digitaleraluhut/opencode/manifests/latest")
    expect(init?.method).toBe("HEAD")
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer t")
    return new Response(null, { status, headers: status === 200 ? { "docker-content-digest": DIGEST } : {} })
  })
}

describe("resolveImage", () => {
  it("pins a tag to the digest the registry serves now", async () => {
    const fetchFn = registry()
    expect(await resolveImage("ghcr.io/digitaleraluhut/opencode:latest", fetchFn)).toBe(
      `ghcr.io/digitaleraluhut/opencode@${DIGEST}`,
    )
  })

  it("keeps a reference that is already pinned by digest", async () => {
    const fetchFn = vi.fn()
    const ref = `ghcr.io/digitaleraluhut/opencode@${DIGEST}`
    expect(await resolveImage(ref, fetchFn)).toBe(ref)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("fails the deploy when the tag does not exist", async () => {
    await expect(resolveImage("ghcr.io/digitaleraluhut/opencode:latest", registry(404))).rejects.toThrow(/404/)
  })

  it("only resolves ghcr.io references", async () => {
    await expect(resolveImage("docker.io/library/nginx:latest", vi.fn())).rejects.toThrow(/ghcr\.io/)
  })
})
