const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  setInteractive: (on) => ipcRenderer.send('interactive', Boolean(on)),
  resize: (height) => ipcRenderer.send('resize', Number(height)),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', Number(dx), Number(dy)),
  dragEnd: () => ipcRenderer.send('drag-end'),
  copy: (text) => ipcRenderer.invoke('copy', String(text)),
  focusSession: (id) => ipcRenderer.invoke('focus-session', String(id)),
  openHistory: () => ipcRenderer.send('open-history'),
  resumeSession: (id) => ipcRenderer.invoke('resume-session', String(id)),
  getPinned: () => ipcRenderer.invoke('get-pinned'),
  setPinned: (on) => ipcRenderer.send('set-pinned', Boolean(on)),
});
