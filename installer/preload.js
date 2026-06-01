// Bridge from the installer's renderer (HTML/CSS UI) to the main process.
// Only the few endpoints the wizard actually needs are exposed — no fs,
// no shell, nothing the page could abuse.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  defaultPath:  () => ipcRenderer.invoke('installer:default-path'),
  pickFolder:   () => ipcRenderer.invoke('installer:pick-folder'),
  install:      (opts) => ipcRenderer.invoke('installer:install', opts),
  onProgress:   (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('installer:progress', handler);
    return () => ipcRenderer.off('installer:progress', handler);
  },
  close:    () => ipcRenderer.send('installer:close'),
  minimize: () => ipcRenderer.send('installer:minimize'),
  openUrl:  (url) => ipcRenderer.send('installer:open-url', url),
});
