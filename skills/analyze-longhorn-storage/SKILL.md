---
name: analyze-longhorn-storage
description: Read Longhorn volume, PVC, backup, and R2 size reports. Use when investigating homelab disk usage or backup storage.
---

# Analyze Longhorn Storage

Run the read-only report from the `homelab` repository:

```bash
./scripts/analyze-longhorn-storage.sh --context flinker
```

Interpret:

- `ALLOCATED`: provisioned volume capacity.
- `ACTUAL`: Longhorn data currently consumed locally.
- `CURRENT PVC`: authoritative Kubernetes PV/PVC binding.
- `HISTORICAL WORKLOAD`: older Longhorn application reference; may be stale.
- `BACKUPS` and `BACKUP DATA`: Longhorn backup inventory and stored size.
- `R2 status`: target availability and last synchronization, not a direct bucket listing.

Never infer current ownership from historical workload references alone.
