// October Rally 2026 — server-confirmed API. Keep your existing /exec URL here.
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwl_F2578W7aFxNS3Npe55Fd7ogmZZ6l4pUje_Lwo1IZNkhCdfXA0_h6xIV2FFFnudz/exec";
const QUEUE_KEY = 'avs_offline_queue_v1';
const STATION_KEY = 'avs_station';
const AVS = {
  isSyncing: false,
  lastSyncError: '',
  getStation() { return localStorage.getItem(STATION_KEY) || ''; },
  setStation(name) { localStorage.setItem(STATION_KEY, name || ''); },
  isOnline() { return navigator.onLine; },
  getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (_) { return []; } },
  saveQueue(items) { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); this.notifyStatusChange(); },
  getQueueCount() { return this.getQueue().length; },
  _listeners: [],
  onStatusChange(fn) { this._listeners.push(fn); fn(this.status()); },
  status() { return { online: this.isOnline(), queueCount: this.getQueueCount(), syncing: this.isSyncing, error: this.lastSyncError }; },
  notifyStatusChange() { this._listeners.forEach(fn => { try { fn(this.status()); } catch (_) {} }); },
  async get(action, params = {}) {
    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([key, val]) => url.searchParams.set(key, val));
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error('Server HTTP ' + response.status);
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data;
  },
  async send(body) {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error('Server HTTP ' + response.status);
    return response.json();
  },
  async post(body) {
    const payload = { ...body, clientRequestId: body.clientRequestId ||
      'req_' + Date.now() + '_' + Math.random().toString(36).slice(2) };
    try {
      const result = await this.send(payload);
      if (!result || result.success !== true) return { success: false, error: result?.error || 'Server did not confirm the write.' };
      return result;
    } catch (err) {
      const queue = this.getQueue();
      queue.push({ id: payload.clientRequestId, queuedAt: new Date().toISOString(), payload, attempts: 0 });
      this.saveQueue(queue);
      return { success: false, queued: true, error: 'Write not confirmed. Saved on this device for retry. Check the sync badge.' };
    }
  },
  async processNextQueueItem() {
    if (this.isSyncing || !this.isOnline()) return;
    const queue = this.getQueue();
    if (!queue.length) return;
    this.isSyncing = true; this.notifyStatusChange();
    const item = queue[0];
    try {
      // Old queued visitor payloads must reach the new registerVisitor handler.
      const payload = { ...item.payload, clientRequestId: item.payload.clientRequestId || item.id };
      const result = await this.send(payload);
      if (!result || result.success !== true) {
        this.lastSyncError = result?.error || 'Server rejected a pending write.';
        return;
      }
      queue.shift(); this.saveQueue(queue);
      this.lastSyncError = '';
    } catch (err) {
      this.lastSyncError = 'Pending write could not reach server.';
    } finally {
      this.isSyncing = false; this.notifyStatusChange();
    }
  },
  syncQueue() { return this.processNextQueueItem(); },
  injectSyncBar() {
    if (document.getElementById('avs-sync-badge')) return;
    const header = document.querySelector('header'); if (!header) return;
    const badge = document.createElement('button'); badge.id = 'avs-sync-badge';
    badge.type = 'button';
    badge.style.cssText = 'border:0;border-radius:20px;padding:5px 12px;background:#334155;color:white;cursor:pointer';
    this.onStatusChange(st => {
      badge.textContent = st.error ? `⚠ Sync error · ${st.queueCount} pending` :
        st.syncing ? `Syncing · ${st.queueCount} pending` :
        st.queueCount ? `${st.queueCount} pending — tap to retry` : '✓ Server confirmed';
      badge.title = st.error || 'Entries are confirmed only after the server saves them.';
    });
    badge.onclick = () => this.syncQueue();
    header.appendChild(badge);
  }
};
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => AVS.syncQueue());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => AVS.injectSyncBar());
  else AVS.injectSyncBar();
  setTimeout(() => AVS.syncQueue(), 1500);
  setInterval(() => AVS.syncQueue(), 15000);
}
