# soundtouch

[AfterTouch](https://github.com/gesellix/Bose-SoundTouch), the local replacement for the Bose
SoundTouch cloud, as an ordinary unprivileged app: pod-security `restricted`, deployed by CI.

## How the speakers reach it

LAN only. No Traefik route, no DNS record, nothing on the Cloudflare tunnel. The speakers
talk to `http://<serverHost>:30880` and `https://<serverHost>:30883`, a NodePort Service with
`externalTrafficPolicy: Local`.

Why not Traefik:
- Traefik rewrites the response header `ETag` to `Etag`. The speaker firmware ignores that,
  and preset sync breaks.
- A TCP passthrough would hide the speaker's IP, which the server needs to push credentials
  back.

The NodePort keeps both the response bytes and the source IP.

Speakers are found by a unicast scan of `discoverySubnets` ("Scan Again" in the admin UI,
plus every hour). Multicast does not leave the pod network.

## Things that are expensive to change

- **`serverHost` and the two node ports** form the address each speaker is migrated to.
  Changing any of them means re-migrating every speaker.
- **The data volume** holds the CA the speakers trust. Losing it also means re-migrating.
  It uses `longhorn-persistent`.
- **The environment is only read once.** On first start the server copies `SERVER_URL`
  into its `settings.json`; after that the file wins over the environment.

## Setup (owner)

```bash
cd apps/soundtouch
pulumi stack init mrsimpson/soundtouch/dev
pulumi config set soundtouch:serverHost <node-hostname>
pulumi config set soundtouch:discoverySubnets <lan-cidr>
pulumi config set --secret soundtouch:mgmtUsername <user>
pulumi config set --secret soundtouch:mgmtPassword <password>
```

Commit `Pulumi.dev.yaml`. After the merge, `deploy-apps.yml` deploys the app. The admin UI is
then at `http://<serverHost>:30880`.
