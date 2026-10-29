import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const ALLOWED = /^(app|conn|db|job|csv|history|vpn|group|roles):/;

contextBridge.exposeInMainWorld('ksdb', {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!ALLOWED.test(channel)) return Promise.reject(new Error(`Canal non autorisé : ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  onJob: (cb: (ev: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, ev: unknown) => cb(ev);
    ipcRenderer.on('job:event', listener);
    return () => ipcRenderer.removeListener('job:event', listener);
  },
  onVpn: (cb: (ev: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, ev: unknown) => cb(ev);
    ipcRenderer.on('vpn:event', listener);
    return () => ipcRenderer.removeListener('vpn:event', listener);
  },
  onUpdate: (cb: (ev: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, ev: unknown) => cb(ev);
    ipcRenderer.on('app:update', listener);
    return () => ipcRenderer.removeListener('app:update', listener);
  },
  platform: process.platform,
});
