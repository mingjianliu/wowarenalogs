# worktree-env.sh: Shell functions for interactive shell worktree workflow.
# Source this file in your ~/.zshrc or ~/.bashrc to enable:
#   develop <branch-name>
#   gw-start <branch-name>
#   gw-push-clean
#   gw-install

develop() {
  local branch="$1"
  if [ -z "$branch" ]; then
    echo "Usage: develop <branch-name>"
    return 1
  fi

  local main_repo
  main_repo=$(git worktree list 2>/dev/null | head -n 1 | awk '{print $1}')
  if [ -z "$main_repo" ]; then
    echo "Error: Not in a git repository."
    return 1
  fi

  local worktree_path="$main_repo/.worktrees/$branch"

  # 1. Start the worktree (creates worktree, checks out branch, runs npm install)
  bash "$main_repo/scripts/git-worktree-helper.sh" start "$branch"
  if [ $? -ne 0 ]; then
    return 1
  fi

  # 2. Change shell directory to the new worktree
  cd "$worktree_path" || return 1
  echo "Moved to worktree: $(pwd)"

  # 3. Detect available agent CLI (prefer gemini, then claude, then agy)
  local agent=""
  if command -v gemini &>/dev/null; then
    agent="gemini"
  elif command -v claude &>/dev/null; then
    agent="claude"
  elif command -v agy &>/dev/null; then
    agent="agy"
  fi

  if [ -z "$agent" ]; then
    echo "Warning: No AI agent CLI (gemini, claude, agy) found in PATH. Sinking into shell."
    echo "Type 'exit' when done."
    $SHELL
  else
    echo "Launching $agent agent inside the isolated worktree..."
    $agent
  fi

  # 4. Post-agent execution check: check if changes are committed & pushed
  local current_top
  current_top=$(git rev-parse --show-toplevel 2>/dev/null)

  if [ "$current_top" = "$worktree_path" ]; then
    local branch_name=$(git branch --show-current)
    if [ -n "$branch_name" ]; then
      local local_sha=$(git rev-parse HEAD 2>/dev/null)
      local remote_sha=$(git rev-parse "origin/$branch_name" 2>/dev/null)

      if [ -n "$local_sha" ] && [ "$local_sha" = "$remote_sha" ] && [ -z "$(git status --porcelain 2>/dev/null)" ]; then
        echo ""
        echo "=================================================="
        echo "Detected branch '$branch_name' is fully committed & pushed to origin, and worktree is clean."
        echo "Cleaning up worktree automatically..."
        cd "$main_repo" || return 1
        git worktree remove "$worktree_path"
        git worktree prune
        echo "Returned to main repository: $(pwd)"
        echo "Worktree successfully removed!"
        echo "=================================================="
        return 0
      fi
    fi
  fi

  echo ""
  echo "=================================================="
  echo "Worktree kept at: $worktree_path"
  echo "Branch is not pushed or has uncommitted changes."
  echo "To push and clean up later, run: gw-push-clean"
  echo "=================================================="
}

gw-start() {
  local branch="$1"
  if [ -z "$branch" ]; then
    echo "Usage: gw-start <branch-name>"
    return 1
  fi

  local main_repo
  main_repo=$(git worktree list 2>/dev/null | head -n 1 | awk '{print $1}')
  if [ -z "$main_repo" ]; then
    echo "Error: Not in a git repository."
    return 1
  fi

  local worktree_path="$main_repo/.worktrees/$branch"

  # Run the helper script
  bash "$main_repo/scripts/git-worktree-helper.sh" start "$branch"
  local exit_code=$?

  if [ $exit_code -eq 0 ] && [ -d "$worktree_path" ]; then
    cd "$worktree_path" || return 1
    echo "Moved to worktree: $(pwd)"
  fi
}

gw-push-clean() {
  local main_repo
  main_repo=$(git worktree list 2>/dev/null | head -n 1 | awk '{print $1}')
  if [ -z "$main_repo" ]; then
    echo "Error: Not in a git repository."
    return 1
  fi

  local current_top
  current_top=$(git rev-parse --show-toplevel 2>/dev/null)

  if [ "$current_top" = "$main_repo" ]; then
    echo "Error: You are in the main worktree. This command must be run inside a development worktree."
    return 1
  fi

  # Run the helper script to push and check
  bash "$main_repo/scripts/git-worktree-helper.sh" push-clean
  local exit_code=$?

  if [ $exit_code -eq 0 ]; then
    echo "Cleaning up worktree..."
    cd "$main_repo" || return 1
    git worktree remove "$current_top"
    git worktree prune
    echo "Returned to main repo: $(pwd)"
    echo "Worktree successfully removed!"
  fi
}

gw-install() {
  local shell_rc
  case "$SHELL" in
    */zsh) shell_rc="$HOME/.zshrc" ;;
    */bash) shell_rc="$HOME/.bashrc" ;;
    *)
      echo "Unsupported shell: $SHELL. Please manually source this script in your shell configuration file."
      return 1
      ;;
  esac

  local script_path
  script_path=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/worktree-env.sh

  if grep -q "source.*worktree-env.sh" "$shell_rc" 2>/dev/null; then
    echo "worktree-env.sh is already configured in $shell_rc."
  else
    echo "" >> "$shell_rc"
    echo "# WoW Arena Logs worktree automation" >> "$shell_rc"
    echo "source \"$script_path\"" >> "$shell_rc"
    echo "Added worktree helper to $shell_rc. Please restart your terminal or run: source $shell_rc"
  fi

  # Configure local git aliases
  local main_repo
  main_repo=$(git worktree list 2>/dev/null | head -n 1 | awk '{print $1}')
  if [ -n "$main_repo" ]; then
    git -C "$main_repo" config --local alias.start-dev "!f() { MAIN_REPO=\$(git worktree list | head -n 1 | awk '{print \$1}'); bash \"\$MAIN_REPO/scripts/git-worktree-helper.sh\" start \"\$@\"; }; f"
    git -C "$main_repo" config --local alias.push-clean "!f() { MAIN_REPO=\$(git worktree list | head -n 1 | awk '{print \$1}'); bash \"\$MAIN_REPO/scripts/git-worktree-helper.sh\" push-clean \"\$@\"; }; f"
    echo "Git aliases 'git start-dev' and 'git push-clean' configured locally."
  fi
}

