#!/usr/bin/env bash
# setup-app-ci.sh — Bind the shared homelab-apps CI SA to a new app namespace
#
# Usage: ./scripts/setup-app-ci.sh <namespace>
#
# Prerequisites:
#   - kubectl configured and pointing at the homelab cluster
#   - Namespace already exists (created via pulumi up)
#   - Shared SA 'homelab-apps' exists in namespace 'ci'
#     (created once via create-kubeconfig.sh ci homelab-apps in homelab repo)
#
# This script is idempotent: running it multiple times for the same namespace
# is safe (uses kubectl apply).

set -euo pipefail

NAMESPACE="${1:-}"
if [[ -z "$NAMESPACE" ]]; then
  echo "Usage: $0 <namespace>" >&2
  echo "" >&2
  echo "Bind the shared CI ServiceAccount (ci/homelab-apps) to a new app namespace" >&2
  echo "so deploy workflows for that app can read/write secrets in the namespace." >&2
  exit 1
fi

SA_NAMESPACE="ci"
SA_NAME="homelab-apps"
SECRETS_ROLE_NAME="homelab-ci-secrets"
ROLEBINDING_NAME="${SECRETS_ROLE_NAME}:${SA_NAME}"

# Verify shared SA exists
if ! kubectl get sa "${SA_NAME}" -n "${SA_NAMESPACE}" &> /dev/null; then
  echo "Error: Shared SA '${SA_NAMESPACE}/${SA_NAME}' not found." >&2
  echo "  Run this first (in the homelab repo):" >&2
  echo "    SERVER_OVERRIDE=https://<tailscale-host>:6443 \\" >&2
  echo "      ./scripts/create-kubeconfig.sh ci ${SA_NAME}" >&2
  exit 1
fi

# Verify namespace exists
if ! kubectl get namespace "${NAMESPACE}" &> /dev/null; then
  echo "Error: Namespace '${NAMESPACE}' does not exist." >&2
  echo "  Run 'pulumi up' locally to create it first." >&2
  exit 1
fi

echo "[INFO] Binding SA ${SA_NAMESPACE}/${SA_NAME} to namespace ${NAMESPACE}"

# Create the Role (idempotent — same rules as create-kubeconfig.sh)
kubectl apply -n "${NAMESPACE}" -f - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${SECRETS_ROLE_NAME}
  labels:
    app.kubernetes.io/managed-by: homelab-apps
rules:
- apiGroups: [""]
  resources: [secrets]
  verbs: [get, list, watch, create, update, patch, delete]
- apiGroups: ["rbac.authorization.k8s.io"]
  resources: [roles, rolebindings]
  verbs: [get, list, watch, create, update, patch, delete]
EOF
echo "[INFO] Role '${SECRETS_ROLE_NAME}' ensured in ${NAMESPACE}"

# Create the RoleBinding (idempotent)
kubectl apply -n "${NAMESPACE}" -f - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${ROLEBINDING_NAME}
  labels:
    app.kubernetes.io/managed-by: homelab-apps
subjects:
- kind: ServiceAccount
  name: ${SA_NAME}
  namespace: ${SA_NAMESPACE}
roleRef:
  kind: Role
  name: ${SECRETS_ROLE_NAME}
  apiGroup: rbac.authorization.k8s.io
EOF
echo "[INFO] RoleBinding '${ROLEBINDING_NAME}' ensured in ${NAMESPACE}"

echo ""
echo "Done. CI can now deploy to ${NAMESPACE}."
echo ""
echo "Next steps:"
echo "  1. Add path filter to .github/workflows/deploy-<app>.yml"
echo "  2. Add the workflow to .github/workflows/"
