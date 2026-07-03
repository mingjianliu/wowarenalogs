import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from 'electron';
import { mkdirSync } from 'fs';
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
  resolveRole,
  savePilotConfig,
  toAgentConfig,
  toCollectorConfig,
  withDefaults,
} from './pilotConfig';
import { StreamerService, StreamerState } from './streamerService';

let tray: Tray | null = null;
let dashboardPort = 0;
let paused = false;
let streamer: StreamerService | null = null;
let collector: CollectorService | null = null;
let localState: StreamerState = { status: 'idle', lastFlushAt: null, lastError: null };
let collectorPhase = 'idle';
let restartDelayMs = 10_000;

const isMac = process.platform === 'darwin';

function trayGlyph(state: 'active' | 'idle' | 'error'): string {
  return state === 'active' ? '▶' : state === 'error' ? '⚠' : '○';
}

function updateTray(state: 'active' | 'idle' | 'error', tooltip: string): void {
  if (!tray) return;
  if (isMac) tray.setTitle(trayGlyph(state));
  tray.setToolTip(`wal-pilot — ${tooltip}`);
}

async function makeTray(role: string): Promise<Tray> {
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
    t.setContextMenu(
      Menu.buildFromTemplate([
        { label: `wal-pilot (${role})`, enabled: false },
        { label: 'Open Dashboard', click: () => openDashboard() },
        ...(role === 'collector' ? [{ label: 'Run Now', click: () => void collector?.runNow() }] : []),
        {
          label: paused ? 'Resume' : 'Pause',
          click: () => {
            paused = !paused;
            if (paused) stopServices();
            else startServices();
            rebuildMenu();
          },
        },
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

function startServices(): void {
  const cfg = currentConfig();
  if (!cfg || paused) return;
  const role = resolveRole(cfg, process.platform, process.env);
  try {
    if (role === 'streamer') {
      streamer = new StreamerService({
        agentConfig: toAgentConfig(cfg),
        statePath: path.join(app.getPath('userData'), 'wal-pilot.state.json'),
        onState: (s) => {
          localState = s;
          updateTray(
            s.status === 'error' ? 'error' : s.status === 'streaming' ? 'active' : 'idle',
            s.lastError ?? s.status,
          );
        },
      });
      streamer.start();
      restartDelayMs = 10_000;
    } else {
      const syncDir = syncDirPath();
      mkdirSync(syncDir, { recursive: true });
      collector = new CollectorService({
        collectorConfig: toCollectorConfig(cfg, syncDir),
        scheduleHours: cfg.scheduleHours,
        cleanupAfterDays: cfg.cleanupAfterDays,
        onPhase: (phase, detail) => {
          collectorPhase = phase;
          updateTray(phase === 'idle' ? (detail === 'ok' ? 'idle' : 'error') : 'active', `${phase}: ${detail}`);
        },
      });
      collector.start();
    }
  } catch (e) {
    // Service constructor/start failure (e.g. missing wowDirectory): surface + retry with backoff.
    const msg = e instanceof Error ? e.message : String(e);
    localState = { status: 'error', lastFlushAt: null, lastError: msg };
    updateTray('error', msg);
    setTimeout(startServices, restartDelayMs);
    restartDelayMs = Math.min(restartDelayMs * 2, 300_000);
  }
}

function stopServices(): void {
  streamer?.stop();
  streamer = null;
  collector?.stop();
  collector = null;
  updateTray('idle', 'paused');
}

function openWizard(role: string): void {
  const win = new BrowserWindow({
    width: 560,
    height: 480,
    title: 'wal-pilot setup',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  void win.loadFile(path.join(__dirname, 'wizard.html'));

  ipcMain.handle('walpilot:getDefaults', () => {
    const probe = realFsProbe();
    const syncCandidates = detectSyncFolderCandidates({ platform: process.platform, home: os.homedir(), probe });
    const wowCandidates = detectWowDirCandidates({ platform: process.platform, probe });
    return {
      role,
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
      if (role === 'streamer' && !input.wowDirectory) return { error: 'Pick the WoW _retail_ folder.' };
      try {
        mkdirSync(input.syncFolder, { recursive: true });
        const cfg = withDefaults({ syncFolder: input.syncFolder, wowDirectory: input.wowDirectory });
        savePilotConfig(configPathFor(app.getPath('userData')), cfg);
        app.setLoginItemSettings({ openAtLogin: input.openAtLogin });
        win.close();
        startServices();
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

  const cfg = currentConfig();
  const role = cfg
    ? resolveRole(cfg, process.platform, process.env)
    : process.platform === 'win32'
      ? 'streamer'
      : 'collector';
  tray = await makeTray(role);
  updateTray('idle', 'starting');

  const { port } = await createDashboardServer({
    htmlPath: path.join(__dirname, 'dashboard.html'),
    extraStatus: async () => ({
      role,
      state: role === 'streamer' ? localState : { status: collectorPhase, lastFlushAt: null, lastError: null },
    }),
    onRunNow: async () => {
      if (!collector) return 'busy';
      const result = await collector.runNow();
      return result === 'busy' ? 'busy' : 'started';
    },
  });
  dashboardPort = port;

  if (!cfg) openWizard(role);
  else startServices();
}

app.on('window-all-closed', () => {
  /* tray app: stay alive */
});
void main();
