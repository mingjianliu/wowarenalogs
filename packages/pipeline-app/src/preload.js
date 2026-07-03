const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('walpilot', {
  getDefaults: () => ipcRenderer.invoke('walpilot:getDefaults'),
  pickFolder: () => ipcRenderer.invoke('walpilot:pickFolder'),
  saveConfig: (cfg) => ipcRenderer.invoke('walpilot:saveConfig', cfg),
});
