# Instructions for every agent

## Always work in worktrees

- Never change files in a repository's main checkout. Every task runs in its own git worktree on a new
  branch.
- Prefer opencode's own worktrees: start the session in a new worktree, or move it into one, before the
  first change. They are created under `~/projects/.worktrees/`.
- Without that, create one yourself next to them:
  `git -C <repo> worktree add ~/projects/.worktrees/<repo>-<branch> -b <branch>`, and work only there.
- Commit and push from the worktree; remove it when the work is merged (`git worktree remove`).
- If a task does not involve a git repository, say so before changing files.
