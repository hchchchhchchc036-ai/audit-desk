import { contextBridge, ipcRenderer } from 'electron';

const actions = new Set(['state', 'project:import', 'project:rescan', 'settings:save', 'model:test', 'ocr:install', 'task:start', 'task:cancel', 'skill:importLocal', 'skill:importGithub', 'skill:enable', 'skill:remove', 'skill:inspect', 'skill:updateContent', 'report:open', 'report:export', 'report:exportEvidence', 'diagram:export']);
contextBridge.exposeInMainWorld('audit', {
  invoke(action: string, payload?: unknown) {
    const added=new Set(['telemetry','project:select','project:archive','context:get','context:compress','context:reset','context:handoffOpen','tool:save','tool:enable','tool:remove','tool:run']);
    if (!added.has(action) && !actions.has(action)) return Promise.reject(new Error('不支持的操作'));
    return ipcRenderer.invoke('audit:invoke', action, payload);
  },
  onTask(callback: (task: unknown) => void) {
    const listener = (_event: unknown, task: unknown) => callback(task);
    ipcRenderer.on('audit:task', listener);
    return () => ipcRenderer.removeListener('audit:task', listener);
  }
});
