const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  setInteractive: (on) => ipcRenderer.send('interactive', Boolean(on)),
  resize: (height, menuOpen) => ipcRenderer.send('resize', Number(height), menuOpen === true),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', Number(dx), Number(dy)),
  dragEnd: () => ipcRenderer.send('drag-end'),
  copy: (text) => ipcRenderer.invoke('copy', String(text)),
  focusSession: (id) => ipcRenderer.invoke('focus-session', String(id)),
  onPointerLeft: (callback) => ipcRenderer.on('pointer-left', () => callback()),
  openHistory: () => ipcRenderer.send('open-history'),
  resumeSession: (id) => ipcRenderer.invoke('resume-session', String(id)),
  setEditing: (on) => ipcRenderer.invoke('set-editing', on === true),
  getAppearance: () => ipcRenderer.invoke('get-appearance'),
  setAppearance: (value) => ipcRenderer.send('set-appearance', value),
  recentDirs: () => ipcRenderer.invoke('recent-dirs'),
  newSession: (cwd) => ipcRenderer.send('new-session', String(cwd)),
  pickDirectory: () => ipcRenderer.send('pick-directory'),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (on) => ipcRenderer.send('set-autostart', on === true),
  getPinned: () => ipcRenderer.invoke('get-pinned'),
  setPinned: (on) => ipcRenderer.send('set-pinned', Boolean(on)),
});
