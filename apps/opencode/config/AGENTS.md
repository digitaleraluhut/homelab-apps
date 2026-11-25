# Instructions for every agent

## Always work in worktrees

- Never change files in a repository's main checkout. For every task, create a git worktree on a new
  branch and work only there:
  `git -C <repo> worktree add ../<repo>-<branch> -b <branch>` (inside `~/projects`).
- Commit and push from the worktree; remove it when the work is merged:
  `git -C <repo> worktree remove ../<repo>-<branch>`.
- If a task does not involve a git repository, say so before changing files.
