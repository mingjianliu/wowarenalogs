import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from 'electron';
import { existsSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

import { syncDirPath } from '../../tools/src/collect/collectorConfig';
import { createDashboardServer } from '../../tools/src/dashboard/server';
import { CollectorService } from './collectorService';
import { detectSyncFolderCandidates, detectWowDirCandidates, realFsProbe } from './detect';
import {
  configPathFor,
  loadPilotConfig,
  PilotConfig,
  PilotRole,
  resolveRole,
  savePilotConfig,
  toAgentConfig,
  toCollectorConfig,
  withDefaults,
} from './pilotConfig';
import { StreamerService, StreamerState } from './streamerService';

// Tray app: services below have their own recovery (retry/backoff, tray error state). An
// uncaught throw here must never take down the whole process — log and keep running.
process.on('uncaughtException', (e) => console.error('[wal-pilot] uncaught:', e));
process.on('unhandledRejection', (e) => console.error('[wal-pilot] unhandled rejection:', e));

let tray: Tray | null = null;
let rebuildTrayMenu: (() => void) | null = null;
let dashboardPort = 0;
let paused = false;
let streamer: StreamerService | null = null;
let collector: CollectorService | null = null;
let localState: StreamerState = { status: 'idle', lastFlushAt: null, lastError: null };
let collectorPhase = 'idle';
let restartDelayMs = 10_000;
let serviceGeneration = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let wizardWin: BrowserWindow | null = null;

// Platform-only placeholder — deliberately does NOT call computeRole()/resolveRole() here: this
// runs synchronously during module evaluation (before main()'s try/catch exists), so a bad
// WAL_PILOT_ROLE would throw before the tray/wizard can ever be created. Refined safely inside
// main() instead. Kept live so the tray/wizard/dashboard never read a stale startup value.
let activeRole: PilotRole = process.platform === 'win32' ? 'streamer' : 'collector';

const isMac = process.platform === 'darwin';

function computeRole(cfg: PilotConfig | null): PilotRole {
  return resolveRole(cfg ?? withDefaults({ syncFolder: '' }), process.platform, process.env);
}

function trayGlyph(state: 'active' | 'idle' | 'error'): string {
  return state === 'active' ? '▶' : state === 'error' ? '⚠' : '○';
}

function updateTray(state: 'active' | 'idle' | 'error', tooltip: string): void {
  if (!tray) return;
  if (isMac) tray.setTitle(trayGlyph(state));
  tray.setToolTip(`wal-pilot — ${tooltip}`);
}

async function makeTray(getRole: () => PilotRole): Promise<Tray> {
  // macOS: empty image + title glyph in the menu bar. Windows: reuse the exe's own icon.
  let image = nativeImage.createEmpty();
  if (!isMac) {
    try {
      image = await app.getFileIcon(process.execPath, { size: 'small' });
    } catch {
      /* keep empty image */
    }
  }
  const t = new Tray(image);
  const rebuildMenu = () => {
    const role = getRole();
    t.setContextMenu(
      Menu.buildFromTemplate([
        { label: `wal-pilot (${role})`, enabled: false },
        { label: 'Open Dashboard', click: () => openDashboard() },
        ...(role === 'collector' ? [{ label: 'Run Now', click: () => void collector?.runNow() }] : []),
        {
          label: paused ? 'Resume' : 'Pause',
          click: () => {
            paused = !paused;
            // finally: keep the Pause/Resume label in sync with `paused` even if starting the
            // service throws (startServices() rethrows after its own tray/backoff handling).
            try {
              if (paused) stopServices();
              else startServices();
            } finally {
              rebuildMenu();
            }
          },
        },
        { label: 'Setup…', click: () => openWizard() },
        {
          label: 'Start at Login',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
  };
  rebuildTrayMenu = rebuildMenu;
  rebuildMenu();
  return t;
}

function openDashboard(): void {
  const win = new BrowserWindow({ width: 980, height: 720, title: 'wal-pilot' });
  void win.loadURL(`http://127.0.0.1:${dashboardPort}`);
}

function currentConfig(): PilotConfig | null {
  return loadPilotConfig(configPathFor(app.getPath('userData')));
}

function teardownServices(): void {
  serviceGeneration += 1; // invalidate any in-flight onState/onPhase from the outgoing services
  if (retryTimer) {
    clearTimeout(retryTimer); // an armed error-retry belongs to the outgoing services too
    retryTimer = null;
  }
  streamer?.stop();
  streamer = null;
  collector?.stop();
  collector = null;
}

function startServices(): void {
  if (paused) return;
  // Guard against re-entrancy: clear any pending retry timer and stop existing services
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  teardownServices();

  const gen = serviceGeneration;
  try {
    const cfg = currentConfig();
    if (!cfg) return;
    const role = resolveRole(cfg, process.platform, process.env);
    activeRole = role;
    rebuildTrayMenu?.();
    if (role === 'streamer') {
      streamer = new StreamerService({
        agentConfig: toAgentConfig(cfg),
        statePath: path.join(app.getPath('userData'), 'wal-pilot.state.json'),
        onState: (s) => {
          if (gen !== serviceGeneration) return;
          localState = s;
          updateTray(
            s.status === 'error' ? 'error' : s.status === 'streaming' ? 'active' : 'idle',
            s.lastError ?? s.status,
          );
        },
      });
      streamer.start();
    } else {
      const syncDir = syncDirPath();
      mkdirSync(syncDir, { recursive: true });
      collector = new CollectorService({
        collectorConfig: toCollectorConfig(cfg, syncDir),
        scheduleHours: cfg.scheduleHours,
        cleanupAfterDays: cfg.cleanupAfterDays,
        onPhase: (phase, detail) => {
          if (gen !== serviceGeneration) return;
          collectorPhase = phase;
          updateTray(phase === 'idle' ? (detail === 'ok' ? 'idle' : 'error') : 'active', `${phase}: ${detail}`);
        },
      });
      collector.start();
    }
    restartDelayMs = 10_000;
  } catch (e) {
    // Config/role/service-start failure (malformed config, bad WAL_PILOT_ROLE, missing
    // wowDirectory, ...): surface + retry with backoff, then rethrow so a caller that wants
    // immediate feedback (the wizard's saveConfig handler) can report it; callers that don't
    // care (timer retry, Resume click, main()'s initial call) rely on the process-level
    // uncaughtException/unhandledRejection safety net above.
    const msg = e instanceof Error ? e.message : String(e);
    localState = { status: 'error', lastFlushAt: null, lastError: msg };
    updateTray('error', msg);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      startServices();
    }, restartDelayMs);
    restartDelayMs = Math.min(restartDelayMs * 2, 300_000);
    throw e;
  }
}

function stopServices(): void {
  teardownServices();
  updateTray('idle', 'paused');
}

function openWizard(): void {
  // Singleton: focus existing wizard window if it's still open
  if (wizardWin && !wizardWin.isDestroyed()) {
    wizardWin.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 560,
    height: 480,
    title: 'wal-pilot setup',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  void win.loadFile(path.join(__dirname, 'wizard.html'));

  wizardWin = win;
  win.on('closed', () => {
    if (wizardWin === win) wizardWin = null;
  });

  // Reopening (Setup… while a previous wizard window is still open, or a reconfiguration after
  // a malformed-config startup) would otherwise throw "second handler for X" on ipcMain.handle.
  ipcMain.removeHandler('walpilot:getDefaults');
  ipcMain.removeHandler('walpilot:pickFolder');
  ipcMain.removeHandler('walpilot:saveConfig');

  ipcMain.handle('walpilot:getDefaults', () => {
    const probe = realFsProbe();
    const syncCandidates = detectSyncFolderCandidates({ platform: process.platform, home: os.homedir(), probe });
    const wowCandidates = detectWowDirCandidates({ platform: process.platform, probe });
    return {
      role: activeRole,
      syncFolder: syncCandidates[0] ? path.join(syncCandidates[0], 'wal-logs') : '',
      wowDirectory: wowCandidates[0] ?? '',
    };
  });
  ipcMain.handle('walpilot:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle(
    'walpilot:saveConfig',
    (_evt, input: { syncFolder: string; wowDirectory?: string; openAtLogin: boolean }) => {
      if (!input.syncFolder) return { error: 'Pick a synced folder first.' };
      if (activeRole === 'streamer' && !input.wowDirectory) return { error: 'Pick the WoW _retail_ folder.' };
      try {
        mkdirSync(input.syncFolder, { recursive: true });
        const cfg = withDefaults({ syncFolder: input.syncFolder, wowDirectory: input.wowDirectory });
        savePilotConfig(configPathFor(app.getPath('userData')), cfg);
        app.setLoginItemSettings({ openAtLogin: input.openAtLogin });
        // Inside the try so a start failure (still-thrown after startServices' own tray/backoff
        // handling) surfaces to the wizard instead of silently closing it. The button says
        // "Save & start": explicitly un-pause so a paused app doesn't silently no-op here.
        paused = false;
        startServices();
        win.close();
        return { error: null };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  );
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  if (isMac) app.dock?.hide();

  let cfg: PilotConfig | null = null;
  let configLoadError: string | null = null;
  try {
    cfg = currentConfig();
  } catch (e) {
    // Malformed config JSON: never crash on startup. Treat as reconfiguration — do NOT delete
    // the existing file, the wizard only overwrites it on Save.
    configLoadError = e instanceof Error ? e.message : String(e);
    console.error('[wal-pilot] config load failed:', configLoadError);
  }
  try {
    activeRole = computeRole(cfg);
  } catch (e) {
    // Bad WAL_PILOT_ROLE: keep the safe platform-default role rather than dying before the tray
    // ever exists; still surface it as a tray error below.
    configLoadError = configLoadError ?? (e instanceof Error ? e.message : String(e));
    console.error('[wal-pilot] role resolution failed:', configLoadError);
  }

  tray = await makeTray(() => activeRole);
  updateTray(configLoadError ? 'error' : 'idle', configLoadError ?? 'starting');

  const { port } = await createDashboardServer({
    htmlPath: path.join(__dirname, 'dashboard.html'),
    extraStatus: async () => ({
      role: activeRole,
      state: activeRole === 'streamer' ? localState : { status: collectorPhase, lastFlushAt: null, lastError: null },
    }),
    onRunNow: async () => {
      if (!collector) return 'busy';
      if (existsSync(collector.lockPath())) return 'busy';
      void collector.runNow();
      return 'started';
    },
  });
  dashboardPort = port;

  if (!cfg) openWizard();
  else startServices();
}

app.on('window-all-closed', () => {
  /* tray app: stay alive */
});
void main();
