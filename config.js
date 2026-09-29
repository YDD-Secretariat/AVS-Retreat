// ------------------------------------------------------------------
// October Rally / AVS Retreat - High Performance Configuration & API
// Features: Instant Optimistic Submission, Background Sync Worker,
// In-Memory Fast Caching, 0ms Local Search, & Concurrency Shield
// ------------------------------------------------------------------

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwl_F2578W7aFxNS3Npe55Fd7ogmZZ6l4pUje_Lwo1IZNkhCdfXA0_h6xIV2FFFnudz/exec";

const QUEUE_KEY = "avs_offline_queue_v1";
const CACHE_KEY = "avs_local_store_v1";
const STATION_KEY = "avs_station";

// Memory cache for sub-second reads
const MEMORY_CACHE = new Map();
const CACHE_TTL_MS = 8000; // 8 seconds cache for repetitive reads

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
  getStation() {
    return localStorage.getItem(STATION_KEY) || "";
  },
  setStation(name) {
    localStorage.setItem(STATION_KEY, name || "");
  },

  isOnline() {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  },

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
    
    // Immediate local record for instant UI reflections
    this.recordLocalMock(item);
    
    // Trigger background worker non-blocking
    setTimeout(() => this.processNextQueueItem(), 50);
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
      // Prevent duplicates in local store
      if (!store.schools.some(s => s.SchoolName === school.SchoolName && Math.abs(new Date(s.Timestamp) - new Date(now)) < 5000)) {
        store.schools.unshift(school);
      }
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
    // Invalidate cached stats so next read calculates fresh local numbers
    MEMORY_CACHE.delete('getStats');
    MEMORY_CACHE.delete('getBulkStats');
    MEMORY_CACHE.delete('getVisitorStats');
    MEMORY_CACHE.delete('getWorkerStats');
    MEMORY_CACHE.delete('getSchools');
  },

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

  // High performance background queue processor
  isSyncing: false,
  async processNextQueueItem() {
    if (this.isSyncing || !this.isOnline()) return;
    const queue = this.getQueue();
    if (!queue.length) return;

    this.isSyncing = true;
    this.notifyStatusChange();

    const item = queue[0];
    const payloadToSend = this.prepareRemotePayload(item.payload);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9000);
      const res = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payloadToSend),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await res.json();
      
      // Successfully accepted by server
      queue.shift();
      this.saveQueue(queue);
    } catch (err) {
      item.attempts = (item.attempts || 0) + 1;
      if (item.attempts >= 8) {
        // Move to end if repeatedly failing so it doesn't block other queue items
        queue.shift();
        queue.push(item);
      }
      this.saveQueue(queue);
    } finally {
      this.isSyncing = false;
      this.notifyStatusChange();
      // If more items remain, process next after brief pause
      if (this.getQueueCount() > 0 && this.isOnline()) {
        setTimeout(() => this.processNextQueueItem(), 400);
      }
    }
  },

  async syncQueue() {
    return this.processNextQueueItem();
  },

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

  // Optimized GET with memory cache + background revalidation
  async get(action, params) {
    const cacheKey = action + '_' + JSON.stringify(params || {});
    const cached = MEMORY_CACHE.get(cacheKey);
    const now = Date.now();

    if (cached && (now - cached.time) < CACHE_TTL_MS) {
      return cached.data;
    }

    if (action === 'getVisitorStats' || action === 'getRecentVisitors') {
      const local = this.getLocalFallback(action, params);
      MEMORY_CACHE.set(cacheKey, { time: now, data: local });
      return local;
    }

    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set("action", action);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500); // 4.5s fast timeout to prevent blocking
      const res = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await res.json();
      
      if (data && data.error && data.error.includes("Unknown action")) {
        const fallback = this.getLocalFallback(action, params);
        MEMORY_CACHE.set(cacheKey, { time: now, data: fallback });
        return fallback;
      }

      this.updateCacheFromGet(action, data);
      MEMORY_CACHE.set(cacheKey, { time: now, data });
      return data;
    } catch (err) {
      const fallback = this.getLocalFallback(action, params);
      MEMORY_CACHE.set(cacheKey, { time: now, data: fallback });
      return fallback;
    }
  },

  // Ultra-Fast Optimistic POST (returns in < 5ms to the user UI)
  async post(body) {
    // 1. Immediately record in local device memory & cache
    this.recordLocalMock(body);

    // 2. Queue for background transmission
    this.enqueue(body);

    // 3. Return instant optimistic success to UI so desks are never blocked
    return {
      success: true,
      optimistic: true,
      queued: !this.isOnline(),
      message: "Recorded instantly"
    };
  },

  updateCacheFromGet(action, data) {
    const store = getLocalStore();
    if (action === 'getSchools' && data && Array.isArray(data.schools)) {
      store.schools = data.schools;
    }
    if (action === 'searchWorkers' && data && Array.isArray(data.workers)) {
      // Store in memory for instant offline searching
      MEMORY_CACHE.set('workers_roster', { time: Date.now(), data: data.workers });
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
        if (g === 'Visitors' || g === 'Visitor') return;
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

  injectSyncBar() {
    const existing = document.getElementById('avs-sync-badge');
    if (existing) return;

    const badge = document.createElement('button');
    badge.id = 'avs-sync-badge';
    badge.style.cssText = "border:none;background:rgba(255,255,255,0.18);color:#fff;font-size:0.75rem;padding:4px 10px;border-radius:20px;font-weight:600;display:inline-flex;align-items:center;gap:6px;cursor:pointer;backdrop-filter:blur(4px);";
    
    const updateUI = (st) => {
      if (!st.online) {
        badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#f59e0b;display:inline-block;"></span> Offline ${st.queueCount ? `(${st.queueCount} saved)` : ''}`;
        badge.title = "Offline: Submissions are saved locally and will auto-sync.";
      } else if (st.syncing) {
        badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#38bdf8;display:inline-block;animation:pulse 1s infinite;"></span> Syncing (${st.queueCount} remaining)`;
      } else if (st.queueCount > 0) {
        badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#f59e0b;display:inline-block;"></span> ${st.queueCount} in Queue`;
        badge.title = "Submissions syncing in background.";
      } else {
        badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block;"></span> Fast Mode (Online)`;
        badge.title = "Direct instant submissions active";
      }
    };

    badge.addEventListener('click', () => {
      if (this.getQueueCount() > 0) {
        this.processNextQueueItem();
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

// Global background auto-sync runner
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    AVS.notifyStatusChange();
    AVS.processNextQueueItem();
  });
  window.addEventListener('offline', () => {
    AVS.notifyStatusChange();
  });

  // Background worker runs every 5 seconds
  setInterval(() => {
    if (AVS.isOnline() && AVS.getQueueCount() > 0 && !AVS.isSyncing) {
      AVS.processNextQueueItem();
    }
  }, 5000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AVS.injectSyncBar());
  } else {
    AVS.injectSyncBar();
  }
}
