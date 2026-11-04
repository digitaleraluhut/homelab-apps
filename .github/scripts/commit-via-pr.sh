#!/usr/bin/env bash
# Commit files from a CI job, respecting the protected default branch.
#
# Usage:
#   .github/scripts/commit-via-pr.sh sync
#       Reset the working tree to the latest origin/<current branch>. Run this
#       BEFORE editing, so the edit applies to the current branch head and not
#       to the (possibly stale) commit the run was triggered for. Re-runs and
#       concurrent bot updates to the same file would otherwise conflict.
#   .github/scripts/commit-via-pr.sh commit "<commit message>" <file>...
#       On the default branch (PR-only via ruleset): commit to a bot/* branch,
#       open a PR and squash-merge it right away. If that fails, the PR is closed
#       and the branch deleted. Only works for files that need no code-owner
#       review (i.e. not under .github/).
#       On any other branch: push directly (with rebase retries).
#
# Needs: GH_TOKEN, job permissions "contents: write" + "pull-requests: write",
# and "Allow GitHub Actions to create and approve pull requests" (org + repo).
# Note: pushes/merges made with GITHUB_TOKEN do not trigger other workflows;
# dispatch follow-up deploys explicitly (gh workflow run ... --ref main).
set -euo pipefail

base=${GITHUB_REF_NAME:?}

case "${1:-}" in
sync)
  git fetch --no-tags --depth=1 origin "$base"
  git reset --hard "origin/$base"
  echo "Synced to origin/$base ($(git rev-parse --short HEAD))"
  ;;

commit)
  shift
  msg=${1:?commit message required}; shift
  (( $# )) || { echo "no files given" >&2; exit 2; }

  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git add -- "$@"
  if git diff --cached --quiet; then echo "Nothing to commit."; exit 0; fi
  git commit -m "$msg"

  default=$(gh repo view "$GITHUB_REPOSITORY" --json defaultBranchRef --jq .defaultBranchRef.name)
  if [[ $base != "$default" ]]; then
    for i in 1 2 3; do
      git pull --rebase origin "$base" && git push origin "HEAD:$base" && exit 0
      sleep $((i * 5))
    done
    echo "Push to $base failed" >&2; exit 1
  fi

  branch="bot/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}"
  url=""
  cleanup() {
    if [[ -n $url ]]; then gh pr close "$url" --delete-branch --comment "Automated merge failed; see run log." || true
    else git push origin --delete "$branch" 2>/dev/null || true; fi
  }
  trap 'rc=$?; (( rc == 0 )) || cleanup; exit $rc' EXIT

  git push origin "HEAD:refs/heads/$branch"
  url=$(gh pr create --repo "$GITHUB_REPOSITORY" --base "$base" --head "$branch" --title "$msg" \
    --body "Automated by \`${GITHUB_WORKFLOW}\`: ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}")
  gh pr merge "$url" --squash --delete-branch
  echo "Merged $url"
  ;;

*)
  echo "usage: $0 sync | commit \"<message>\" <file>..." >&2; exit 2
  ;;
esac
