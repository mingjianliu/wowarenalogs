---
name: worktree-automation
description: Automates creating a git worktree when development starts ("develop <branch>"), switching context to the worktree, and automatically committing, pushing, and cleaning up the worktree when finished.
---

# Git Worktree Automation

Automate the lifecycle of git worktrees when tasked with developing features or fixing bugs on a specific branch.

## 1. Start Development ("develop <branch-name>" or "start task on <branch-name>")

When the user requests to start development on a new branch or worktree:

1. Run the local git command: `git start-dev <branch-name>` (this creates the worktree under `.worktrees/<branch-name>` and runs `npm install`).
2. Update your internal state: all subsequent file reads, writes, and command executions for the rest of this session MUST be done relative to or inside the new worktree directory `.worktrees/<branch-name>/`.
3. Report back to the user that you are now working inside the isolated worktree `.worktrees/<branch-name>/`.

## 2. Commit, Push, and Clean Up ("commit and push" or implicitly when the task is complete)

When the task is complete and you are ready to push:

1. Verify the branch is clean and compile/test baseline checks pass.
2. Stage and commit the changes inside the worktree `.worktrees/<branch-name>/`.
3. Run the local git push command inside the worktree: `git push-clean` (this pushes the branch to origin).
4. Run the cleanup command from the main repository root directory: `git worktree remove --force .worktrees/<branch-name>` and `git worktree prune`.
5. Inform the user that the branch has been successfully committed, pushed to origin, and the worktree has been cleaned up.
