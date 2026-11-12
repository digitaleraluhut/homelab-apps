#!/usr/bin/env bash
# One-time: creates the stack mrsimpson/soundtouch/dev and copies its config from the old
# stack mrsimpson/aftertouch/dev. Delete this script once Pulumi.dev.yaml is committed.
#
#   aftertouch:nodeName              -> soundtouch:serverHost
#   aftertouch:nodeIp (its /24)      -> soundtouch:discoverySubnets (override: DISCOVERY_SUBNETS=...)
#   aftertouch:mgmtUsername/Password -> soundtouch:mgmtUsername/Password (secrets)
#
# Run from anywhere inside a homelab-apps checkout of this branch, logged in to Pulumi Cloud.
set -euo pipefail

OLD_STACK=mrsimpson/aftertouch/dev
NEW_STACK=mrsimpson/soundtouch/dev
OLD_COMMIT=38ebced # last commit with apps/aftertouch

repo=$(git rev-parse --show-toplevel)
app="$repo/apps/soundtouch"

# `pulumi config get` needs the old project's Pulumi.yaml and its stack config file.
old=$(mktemp -d)
trap 'rm -rf "$old"' EXIT
git -C "$repo" show "$OLD_COMMIT:apps/aftertouch/Pulumi.yaml" >"$old/Pulumi.yaml"
git -C "$repo" show "$OLD_COMMIT:apps/aftertouch/Pulumi.dev.yaml" >"$old/Pulumi.dev.yaml"
get() { pulumi config get "aftertouch:$1" -s "$OLD_STACK" --cwd "$old"; }

server_host=$(get nodeName)
node_ip=$(get nodeIp)
subnets=${DISCOVERY_SUBNETS:-${node_ip%.*}.0/24}

cd "$app"
pulumi stack select "$NEW_STACK" 2>/dev/null || pulumi stack init "$NEW_STACK"
set_new() { pulumi config set -s "$NEW_STACK" "$@"; }
set_new soundtouch:serverHost "$server_host"
set_new soundtouch:discoverySubnets "$subnets"
set_new --secret soundtouch:mgmtUsername "$(get mgmtUsername)"
set_new --secret soundtouch:mgmtPassword "$(get mgmtPassword)"

echo
echo "Stack $NEW_STACK configured:"
pulumi config -s "$NEW_STACK"
echo
echo "Speakers will be migrated to http://$server_host:30880 (scan: $subnets)."
echo "Next: git add apps/soundtouch/Pulumi.dev.yaml && git commit && git push"
