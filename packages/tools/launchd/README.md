# Scheduled collection + analysis (macOS launchd)

Points at the MAIN repo checkout (not a worktree). Install after merging:

    mkdir -p ~/wal-sync
    # one-time: ~/wal-sync/collector.config.json with your storage block, and
    # ANTHROPIC_API_KEY in packages/tools/.env (dotenv loads it; never leaves this Mac)
    cp packages/tools/launchd/com.wowarenalogs.collect.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/com.wowarenalogs.collect.plist

Interval: edit StartInterval (seconds; 21600 = 6h) and `launchctl unload` + `load`.
Manual run: `bash packages/tools/launchd/collect-and-analyze.sh` (same overlap lock).
Logs: ~/wal-sync/launchd.log. Uninstall: `launchctl unload ...` and delete the plist.

Stuck? A hard crash (power loss, kill -9) can orphan the overlap lock; clear it with `rmdir ~/wal-sync/run.lock`.
