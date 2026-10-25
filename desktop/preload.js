'use strict';
/**
 * contextIsolation-safe bridge. The renderer only ever sees this API surface;
 * no node/electron primitives leak through.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rb', {
  // branding / config
  getBranding: () => ipcRenderer.invoke('branding:get'),
  getPaths: () => ipcRenderer.invoke('app:paths'),

  // license (fail-closed)
  validateLicense: (code) => ipcRenderer.invoke('license:validate', code),

  // ISO select + hash pin
  discoverIso: () => ipcRenderer.invoke('iso:discover'),
  pickIso: () => ipcRenderer.invoke('iso:pick'),
  inspectIso: (filePath) => ipcRenderer.invoke('iso:inspect', filePath),

  // USB listing (USB BusType only, read-only)
  listUsbDisks: () => ipcRenderer.invoke('usb:list'),

  // writer launch (dryRun => non-elevated checks, real => UAC)
  startWrite: (opts) => ipcRenderer.invoke('write:start', opts),
  onWriteEvent: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('write:event', handler);
    return () => ipcRenderer.removeListener('write:event', handler);
  },

  // misc
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openTechnicianDoc: () => ipcRenderer.invoke('app:openTechnician'),
  copyText: (text) => ipcRenderer.invoke('app:copyText', text),
  quit: () => ipcRenderer.invoke('app:quit')
});
