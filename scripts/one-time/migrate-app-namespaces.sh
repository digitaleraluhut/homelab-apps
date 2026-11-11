#!/bin/bash
# One-time migration to "apps create their own namespaces" (homelab#119, homelab-apps#56).
# Run by the owner, locally on flinker, with the owner's kubectl and pulumi login.
# Delete this file once all phases have run (one-time migration, no permanent legacy).
#
# Order (see homelab-apps#56):
#   1. backup         before anything is merged
#   2. (homelab#119 merged and deployed: homelab deletes namespaces wiki and opencode)
#   3. prepare        label librechat, rename the router stack, refresh the wiki stack
#   4. verify         the admission policies fence the CI as intended
#   5. workflows <branch>   delete the old per-app workflows on the homelab-apps PR branch
#   6. (homelab-apps PR merged: apps deploy and create their namespaces)
#
#   scripts/one-time/migrate-app-namespaces.sh <phase> [args]
set -euo pipefail

BASE=${BASE:-$HOME/projects/privat/digitaleraluhut}
APPS="$BASE/homelab-apps"
ORG=mrsimpson
CI_SA=system:serviceaccount:ci-access:homelab-apps

die() { echo "error: $*" >&2; exit 1; }
confirm() { local a; read -r -p "$1 [y/N] " a </dev/tty; [ "$a" = y ] || [ "$a" = Y ]; }
run() { echo "+ $*"; confirm "run?" && "$@" || echo "skipped"; }

backup() {
  local dir="$HOME/pulumi-backup-$(date +%F)"
  mkdir -p "$dir"
  # Secrets stay encrypted in the export.
  for stack in opencode librechat wiki aftertouch; do
    echo "export $ORG/$stack/dev"
    pulumi stack export --stack "$ORG/$stack/dev" --file "$dir/$stack.json" || echo "  (no such stack)"
  done
  ls -l "$dir"
}

prepare() {
  # librechat already enforces PSS restricted (checked 2026-11-11); it only needs the deployer label.
  run kubectl label ns librechat homelab/deployer=homelab-apps --overwrite

  # The router's live state sits in stack opencode (project name collision, homelab-apps#43).
  # Renaming keeps state and secrets; afterwards the name opencode is free for the new app.
  run pulumi stack rename "$ORG/opencode-router/dev" --stack "$ORG/opencode/dev" --cwd "$APPS/apps/opencode-router"
  run pulumi stack init "$ORG/opencode/dev" --cwd "$APPS/apps/opencode"

  # homelab#119 deleted namespace wiki with everything in it. The wiki stack still believes its
  # Deployment, Service and Secret exist; refresh drops them so the next deploy recreates them.
  # The wiki content is in the homelab-wiki repo, nothing is lost; only wiki.<domain> is down until then.
  kubectl get ns wiki >/dev/null 2>&1 && die "namespace wiki still exists: deploy homelab#119 first"
  run pulumi refresh --yes --stack "$ORG/wiki/dev" --cwd "$APPS/apps/wiki"
}

verify() {
  local fail=0 tmp
  tmp=$(mktemp -d)
  cat >"$tmp/ok.yaml" <<'YAML'
apiVersion: v1
kind: Namespace
metadata:
  name: vap-check-ok
  labels: {homelab/deployer: homelab-apps, pod-security.kubernetes.io/enforce: restricted, pod-security.kubernetes.io/enforce-version: latest}
YAML
  cat >"$tmp/privileged.yaml" <<'YAML'
apiVersion: v1
kind: Namespace
metadata:
  name: vap-check-privileged
  labels: {homelab/deployer: homelab-apps, pod-security.kubernetes.io/enforce: privileged}
YAML
  expect() { # expect allow|deny <description> <kubectl args...>
    local want=$1 what=$2; shift 2
    if kubectl --as="$CI_SA" "$@" --dry-run=server >/dev/null 2>&1; then got=allow; else got=deny; fi
    if [ "$got" = "$want" ]; then echo "ok    $what ($got)"; else echo "FAIL  $what: expected $want, got $got"; fail=1; fi
  }
  expect allow "CI creates a restricted, labelled namespace" create -f "$tmp/ok.yaml"
  expect deny  "CI creates a privileged namespace"           create -f "$tmp/privileged.yaml"
  expect deny  "CI creates an unlabelled namespace"          create namespace vap-check-bare
  expect deny  "CI relabels kube-system"                     label ns kube-system foo=bar
  expect deny  "CI creates a RoleBinding in kube-system"     create rolebinding x -n kube-system --clusterrole=ci-access:homelab-apps:deployer --user=x
  rm -rf "$tmp"
  [ $fail = 0 ] || die "admission policies do not fence the CI as intended"
}

workflows() {
  local branch=${1:?usage: workflows <homelab-apps PR branch>}
  # The operator's workflow handoff can add and edit, not delete. These deploys now run through deploy-apps.yml.
  local files=(deploy-aftertouch.yml deploy-wiki.yml deploy-opencode-router.yml deploy-lobehub.yml deploy-matrix.yml
               build-voice-transcription-bot.yml build-sandbox-mcp.yml)
  [ "$(cd "$APPS" && gh pr view "$branch" --json state -q .state)" = OPEN ] || die "no open PR for $branch"
  [ -z "$(git -C "$APPS" status --porcelain --untracked-files=no)" ] || die "$APPS has uncommitted changes"
  git -C "$APPS" fetch -q origin "$branch"
  git -C "$APPS" switch -q -C "$branch" "origin/$branch"
  for f in "${files[@]}"; do git -C "$APPS" rm -q --ignore-unmatch ".github/workflows/$f"; done
  git -C "$APPS" --no-pager diff --cached --stat
  if confirm "Commit and push to $branch?"; then
    git -C "$APPS" -c commit.gpgsign=false commit -q -m "chore(ci): delete per-app workflows, deploy-apps.yml deploys every app"
    git -C "$APPS" push -q origin "$branch"
  else
    git -C "$APPS" reset -q --hard
  fi
  git -C "$APPS" switch -q -
}

case "${1:-}" in
  backup|prepare|verify) "$1" ;;
  workflows) shift; workflows "$@" ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
