// ------------------------------------------------------------------
// October Rally / AVS Retreat - Central Configuration & API Client
// Includes Offline Sync Queue, Network Detection, & Local Fallbacks
// ------------------------------------------------------------------

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwl_F2578W7aFxNS3Npe55Fd7ogmZZ6l4pUje_Lwo1IZNkhCdfXA0_h6xIV2FFFnudz/exec";

const QUEUE_KEY = "avs_offline_queue_v1";
const CACHE_KEY = "avs_local_store_v1";
const STATION_KEY = "avs_station";

// Initialize local store if not present
function getLocalStore() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    schools: [],
    bulkMembers: [],
    workers: [],
    visitors: [],
    lastSync: null
  };
}

function saveLocalStore(store) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch (e) {}
}

const AVS = {
  // Station preferences
  getStation() {
    return localStorage.getItem(STATION_KEY) || "";
  },
  setStation(name) {
    localStorage.setItem(STATION_KEY, name || "");
  },

  // Network & Online state
  isOnline() {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  },

  // Offline Sync Queue
  getQueue() {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  },

  saveQueue(queue) {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
      this.notifyStatusChange();
    } catch (e) {}
  },

  getQueueCount() {
    return this.getQueue().length;
  },

  enqueue(item) {
    const queue = this.getQueue();
    const queueItem = {
      id: 'q_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      queuedAt: new Date().toISOString(),
      payload: item,
      attempts: 0
    };
    queue.push(queueItem);
    this.saveQueue(queue);
    
    // Also record into local cache immediately so stats & lists update locally
    this.recordLocalMock(item);
    return queueItem;
  },

  recordLocalMock(payload) {
    const store = getLocalStore();
    const now = new Date().toISOString();

    if (payload.action === 'registerSchool') {
      const school = {
        SchoolID: 'SCH-' + Date.now().toString(36).toUpperCase(),
        SchoolName: payload.schoolName,
        Location: payload.location,
        CoordinatorName: payload.coordinatorName,
        CoordinatorPhone: payload.coordinatorPhone,
        CoordinatorLocation: payload.coordinatorLocation,
        Male: payload.male || 0,
        Female: payload.female || 0,
        Total: (payload.male || 0) + (payload.female || 0),
        Station: payload.station || this.getStation(),
        Timestamp: now,
        PhotoCount: 0
      };
      store.schools.unshift(school);
    } else if (payload.action === 'registerBulkMembers') {
      const bulk = {
        ID: 'BLK-' + Date.now().toString(36).toUpperCase(),
        Group: payload.group,
        Male: payload.male || 0,
        Female: payload.female || 0,
        Count: (payload.male || 0) + (payload.female || 0) || payload.count || 0,
        Station: payload.station || this.getStation(),
        RegisteredAt: now
      };
      store.bulkMembers.unshift(bulk);
    } else if (payload.action === 'registerVisitor') {
      const m = parseInt(payload.male) || 0;
      const f = parseInt(payload.female) || 0;
      const tot = parseInt(payload.total) || (m + f);
      const visitor = {
        ID: 'VIS-' + Date.now().toString(36).toUpperCase(),
        Category: 'Visitors',
        Male: m,
        Female: f,
        Total: tot,
        Station: payload.station || this.getStation(),
        Notes: payload.notes || '',
        RegisteredAt: now
      };
      store.visitors.unshift(visitor);
    } else if (payload.action === 'registerWalkIn' || payload.action === 'registerWorker') {
      const worker = {
        rowId: payload.rowId || 'W-' + Date.now(),
        fullName: payload.name || payload.fullName || 'Registered Individual',
        station: payload.station || this.getStation(),
        phone: payload.phone || '',
        alreadyRegistered: true,
        registeredAt: now
      };
      store.workers.unshift(worker);
    }

    saveLocalStore(store);
  },

  // Map payload for remote Google Apps Script backend compatibility
  prepareRemotePayload(body) {
    if (body.action === 'registerVisitor') {
      const m = parseInt(body.male) || 0;
      const f = parseInt(body.female) || 0;
      const tot = parseInt(body.total) || (m + f);
      return {
        action: 'registerBulkMembers',
        group: 'Visitors',
        male: m,
        female: f,
        count: tot,
        notes: body.notes || '',
        submittedBy: body.station || this.getStation() || 'Visitor Desk',
        station: body.station || this.getStation()
      };
    }
    return body;
  },

  // Process all queued items sequentially
  isSyncing: false,
  async syncQueue() {
    if (this.isSyncing || !this.isOnline()) return { synced: 0, pending: this.getQueueCount() };
    const queue = this.getQueue();
    if (!queue.length) return { synced: 0, pending: 0 };

    this.isSyncing = true;
    this.notifyStatusChange();

    let synced = 0;
    const remaining = [];

    for (const item of queue) {
      try {
        const payloadToSend = this.prepareRemotePayload(item.payload);
        const res = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(payloadToSend)
        });
        const data = await res.json();
        if (data && (data.success || data.duplicate || !data.error)) {
          synced++;
        } else {
          item.attempts = (item.attempts || 0) + 1;
          if (item.attempts < 5) remaining.push(item);
        }
      } catch (err) {
        item.attempts = (item.attempts || 0) + 1;
        remaining.push(item);
      }
    }

    this.saveQueue(remaining);
    this.isSyncing = false;
    this.notifyStatusChange();
    return { synced, pending: remaining.length };
  },

  // Event callbacks for connection & queue changes
  _listeners: [],
  onStatusChange(fn) {
    this._listeners.push(fn);
    fn({ online: this.isOnline(), queueCount: this.getQueueCount(), syncing: this.isSyncing });
  },

  notifyStatusChange() {
    const status = { online: this.isOnline(), queueCount: this.getQueueCount(), syncing: this.isSyncing };
    this._listeners.forEach(fn => {
      try { fn(status); } catch (e) {}
    });
  },

  // Network GET with timeout and fallback
  async get(action, params) {
    // Actions not supported directly on Apps Script are handled by local state
    if (action === 'getVisitorStats' || action === 'getRecentVisitors') {
      return this.getLocalFallback(action, params);
    }

    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set("action", action);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    try {
      const res = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await res.json();
      if (data && data.error && data.error.includes("Unknown action")) {
        return this.getLocalFallback(action, params);
      }
      this.updateCacheFromGet(action, data);
      return data;
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn(`[AVS API] GET ${action} failed or timed out. Serving local cache/data.`);
      return this.getLocalFallback(action, params);
    }
  },

  // Network POST with offline auto-queue & compatibility mapping
  async post(body) {
    // Always record locally so state is immediately available
    this.recordLocalMock(body);

    if (!this.isOnline()) {
      this.enqueue(body);
      return { success: true, queued: true, message: "Saved locally in offline queue." };
    }

    const payloadToSend = this.prepareRemotePayload(body);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payloadToSend),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await res.json();

      if (data && data.error && data.error.includes("Unknown action")) {
        // Fallback gracefully since local store already recorded it
        return { success: true, fallback: true, message: "Saved successfully." };
      }

      return data;
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn("[AVS API] POST failed. Queuing for background sync.");
      this.enqueue(body);
      return { success: true, queued: true, message: "Saved locally. Will sync automatically when connection restores." };
    }
  },

  updateCacheFromGet(action, data) {
    const store = getLocalStore();
    if (action === 'getSchools' && data && Array.isArray(data.schools)) {
      store.schools = data.schools;
    }
    saveLocalStore(store);
  },

  getLocalFallback(action, params) {
    const store = getLocalStore();
    const schools = store.schools || [];
    const bulk = store.bulkMembers || [];
    const workers = store.workers || [];
    const visitors = store.visitors || [];

    if (action === 'getSchools') {
      return { success: true, schools };
    }

    if (action === 'getRecent') {
      const limit = (params && params.limit) || 8;
      return { success: true, recent: schools.slice(0, limit) };
    }

    if (action === 'getRecentBulk') {
      const limit = (params && params.limit) || 8;
      return { success: true, recent: bulk.slice(0, limit) };
    }

    if (action === 'getRecentVisitors') {
      const limit = (params && params.limit) || 8;
      return { success: true, recent: visitors.slice(0, limit) };
    }

    if (action === 'getStats') {
      const totalStudents = schools.reduce((acc, s) => acc + (parseInt(s.Total) || 0), 0);
      const totalMale = schools.reduce((acc, s) => acc + (parseInt(s.Male) || 0), 0);
      const totalFemale = schools.reduce((acc, s) => acc + (parseInt(s.Female) || 0), 0);
      return {
        totalStudents,
        totalSchools: schools.length,
        totalCoordinators: schools.filter(s => s.CoordinatorName).length,
        totalMale,
        totalFemale
      };
    }

    if (action === 'getBulkStats') {
      const groupsMap = { 'Group 1': { male: 0, female: 0, count: 0 }, 'Group 2': { male: 0, female: 0, count: 0 }, 'Group 3': { male: 0, female: 0, count: 0 }, 'Group 4': { male: 0, female: 0, count: 0 }, 'Others': { male: 0, female: 0, count: 0 } };
      let totalMembers = 0;
      let totalMale = 0;
      let totalFemale = 0;
      bulk.forEach(b => {
        const g = b.Group || 'Others';
        if (g === 'Visitors' || g === 'Visitor') return; // Separate from internal church groups
        if (!groupsMap[g]) groupsMap[g] = { male: 0, female: 0, count: 0 };
        const m = parseInt(b.Male) || 0;
        const f = parseInt(b.Female) || 0;
        const c = parseInt(b.Count) || (m + f) || 0;
        groupsMap[g].male += m;
        groupsMap[g].female += f;
        groupsMap[g].count += c;
        totalMembers += c;
        totalMale += m;
        totalFemale += f;
      });
      const groups = Object.keys(groupsMap).map(k => ({
        group: k,
        male: groupsMap[k].male,
        female: groupsMap[k].female,
        count: groupsMap[k].count
      }));
      return { totalMembers, totalMale, totalFemale, groups };
    }

    if (action === 'getVisitorStats') {
      let totalVisitors = 0;
      let totalMale = 0;
      let totalFemale = 0;
      visitors.forEach(v => {
        const m = parseInt(v.Male) || 0;
        const f = parseInt(v.Female) || 0;
        const tot = parseInt(v.Total) || (m + f) || 0;
        totalVisitors += tot;
        totalMale += m;
        totalFemale += f;
      });
      return { totalVisitors, totalMale, totalFemale, visitors };
    }

    if (action === 'getWorkerStats') {
      const stationsMap = {};
      workers.forEach(w => {
        const st = w.station || 'General Desk';
        stationsMap[st] = (stationsMap[st] || 0) + 1;
      });
      const byStation = Object.keys(stationsMap).map(s => ({ station: s, count: stationsMap[s] }));
      return { totalRegisteredWorkers: workers.length, byStation };
    }

    if (action === 'searchWorkers') {
      const q = ((params && params.q) || '').toLowerCase();
      const filtered = workers.filter(w => (w.fullName || '').toLowerCase().includes(q));
      return { success: true, workers: filtered };
    }

    return { success: true };
  },

  // Helper to mount a global sync bar in any page header
  injectSyncBar() {
    const existing = document.getElementById('avs-sync-badge');
    if (existing) return;

    const badge = document.createElement('button');
    badge.id = 'avs-sync-badge';
    badge.style.cssText = "border:none;background:rgba(255,255,255,0.18);color:#fff;font-size:0.75rem;padding:4px 10px;border-radius:20px;font-weight:600;display:inline-flex;align-items:center;gap:6px;cursor:pointer;backdrop-filter:blur(4px);";
    
    const updateUI = (st) => {
      if (!st.online) {
        badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#f59e0b;display:inline-block;"></span> Offline ${st.queueCount ? `(${st.queueCount} saved)` : ''}`;
        badge.title = "No internet connection. Submissions are safely saved offline and will auto-sync.";
      } else if (st.syncing) {
        badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#38bdf8;display:inline-block;animation:pulse 1s infinite;"></span> Syncing…`;
      } else if (st.queueCount > 0) {
        badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#f59e0b;display:inline-block;"></span> ${st.queueCount} Pending Sync`;
        badge.title = "Click to retry syncing queued entries.";
      } else {
        badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block;"></span> Online`;
        badge.title = "Connected to central database";
      }
    };

    badge.addEventListener('click', () => {
      if (this.getQueueCount() > 0) {
        this.syncQueue();
      }
    });

    const header = document.querySelector('header');
    if (header) {
      const links = header.querySelector('a') || header.querySelector('div');
      if (links) {
        header.insertBefore(badge, links);
      } else {
        header.appendChild(badge);
      }
    }

    this.onStatusChange(updateUI);
  }
};

// Global event listeners for network changes and auto sync
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    AVS.notifyStatusChange();
    AVS.syncQueue();
  });
  window.addEventListener('offline', () => {
    AVS.notifyStatusChange();
  });

  // Background sync worker every 12 seconds
  setInterval(() => {
    if (AVS.isOnline() && AVS.getQueueCount() > 0) {
      AVS.syncQueue();
    }
  }, 12000);

  // Auto-inject status badge once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AVS.injectSyncBar());
  } else {
    AVS.injectSyncBar();
  }
}
