#!/bin/bash

# git-worktree-helper.sh: Backend script for managing development worktrees
# Designed to be called directly, via git aliases, or via sourced shell functions.

ACTION="$1"
BRANCH_NAME="$2"

# Prune any stale worktree registrations
git worktree prune

start_dev() {
  if [ -z "$BRANCH_NAME" ]; then
    echo "Error: Branch name not specified."
    echo "Usage: git start-dev <branch-name>"
    exit 1
  fi

  MAIN_REPO_PATH=$(git worktree list | head -n 1 | awk '{print $1}')
  WORKTREE_PATH="$MAIN_REPO_PATH/.worktrees/$BRANCH_NAME"

  # Check if directory already exists
  if [ -d "$WORKTREE_PATH" ]; then
    echo "Worktree directory already exists at: $WORKTREE_PATH"
    echo "To switch, run: cd $WORKTREE_PATH"
    exit 0
  fi

  echo "Creating new worktree for branch '$BRANCH_NAME' at '$WORKTREE_PATH'..."

  # Check if branch exists locally or on origin
  if git -C "$MAIN_REPO_PATH" show-ref --verify --quiet "refs/heads/$BRANCH_NAME" || \
     git -C "$MAIN_REPO_PATH" show-ref --verify --quiet "refs/remotes/origin/$BRANCH_NAME"; then
    echo "Branch '$BRANCH_NAME' already exists. Checking out existing branch..."
    git -C "$MAIN_REPO_PATH" worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
  else
    echo "Branch '$BRANCH_NAME' does not exist. Creating new branch..."
    git -C "$MAIN_REPO_PATH" worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME"
  fi

  if [ $? -ne 0 ]; then
    echo "Error: Failed to create worktree."
    exit 1
  fi

  # Run project setup in worktree
  echo "Installing dependencies in the new worktree..."
  if [ -f "$WORKTREE_PATH/package.json" ]; then
    (cd "$WORKTREE_PATH" && npm install --no-audit --no-fund)
  fi

  echo ""
  echo "=================================================="
  echo "Worktree successfully set up!"
  echo "To start developing, run:"
  echo "  cd $WORKTREE_PATH"
  echo "=================================================="
}

push_clean() {
  MAIN_REPO_PATH=$(git worktree list | head -n 1 | awk '{print $1}')
  CURRENT_TOP=$(git rev-parse --show-toplevel)

  # Check if we are in the main worktree
  if [ "$CURRENT_TOP" = "$MAIN_REPO_PATH" ]; then
    echo "Error: You are in the main worktree. This command must be run inside a development worktree."
    exit 1
  fi

  # Double check that we are inside the .worktrees directory
  if [[ "$CURRENT_TOP" != *"/$MAIN_REPO_PATH/.worktrees/"* && "$CURRENT_TOP" != *".worktrees"* ]]; then
    echo "Error: Current directory ($CURRENT_TOP) is not inside the project's .worktrees directory."
    exit 1
  fi

  BRANCH_NAME=$(git branch --show-current)
  if [ -z "$BRANCH_NAME" ]; then
    echo "Error: Could not determine current branch name."
    exit 1
  fi

  # Check for uncommitted/untracked changes
  if [ -n "$(git status --porcelain)" ]; then
    echo "Error: You have uncommitted or untracked changes in this worktree."
    echo "Please commit, stash, or discard them before cleaning up."
    git status
    exit 1
  fi

  echo "Pushing branch '$BRANCH_NAME' to origin..."
  git push -u origin HEAD

  if [ $? -ne 0 ]; then
    echo "Error: git push failed. Aborting cleanup."
    exit 1
  fi

  echo "Push successful!"
  echo ""
  echo "=================================================="
  echo "Push complete! To finish cleaning up, run:"
  echo "  cd $MAIN_REPO_PATH && git worktree remove $CURRENT_TOP"
  echo "=================================================="
}

case "$ACTION" in
  start)
    start_dev
    ;;
  push-clean)
    push_clean
    ;;
  *)
    echo "Usage: $0 {start|push-clean} [args]"
    exit 1
    ;;
esac
