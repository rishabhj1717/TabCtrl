// TabCtrl Background Service Worker
// Manages MRU (Most Recently Used) tab tracking and tab switching

// Per-window MRU queues: { [windowId]: number[] }, persisted in chrome.storage.local
let mruByWindow = Object.create(null);
let maxMruSize = 5;
let isInitialized = false;

function normalizeMaxMruSize(value) {
  return Number(value) === 10 ? 10 : 5;
}

function windowKey(windowId) {
  return String(windowId);
}

function getMruList(windowId) {
  const key = windowKey(windowId);
  if (!Array.isArray(mruByWindow[key])) {
    mruByWindow[key] = [];
  }
  return mruByWindow[key];
}

function setMruList(windowId, ids) {
  mruByWindow[windowKey(windowId)] = ids;
}

function allMruIds() {
  const ids = new Set();
  for (const list of Object.values(mruByWindow)) {
    if (!Array.isArray(list)) continue;
    for (const id of list) ids.add(id);
  }
  return ids;
}

function serializeMru() {
  const out = {};
  for (const [key, list] of Object.entries(mruByWindow)) {
    if (Array.isArray(list) && list.length) out[key] = list;
  }
  return out;
}

async function loadPreferences() {
  const result = await chrome.storage.local.get(['maxMruSize']);
  if (result.maxMruSize !== 5 && result.maxMruSize !== 10) {
    await chrome.storage.local.set({ maxMruSize: 5 });
  }
  maxMruSize = normalizeMaxMruSize(result.maxMruSize);
}

function trimMruToLimit() {
  let changed = false;
  for (const key of Object.keys(mruByWindow)) {
    const list = mruByWindow[key];
    if (!Array.isArray(list) || list.length <= maxMruSize) continue;
    mruByWindow[key] = list.slice(0, maxMruSize);
    changed = true;
  }
  if (changed) saveMruToStorage();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.maxMruSize) return;
  maxMruSize = normalizeMaxMruSize(changes.maxMruSize.newValue);
  trimMruToLimit();
});

async function validateTabId(tabId, expectedWindowId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (expectedWindowId != null && tab.windowId !== Number(expectedWindowId)) {
      return null;
    }
    return tab;
  } catch (error) {
    return null;
  }
}

// Load MRU from storage on startup. Migrates legacy flat mruTabIds if present.
async function loadMruFromStorage() {
  await loadPreferences();
  try {
    const result = await chrome.storage.local.get(['mruByWindow', 'mruTabIds']);
    const next = Object.create(null);

    if (result.mruByWindow && typeof result.mruByWindow === 'object' && !Array.isArray(result.mruByWindow)) {
      for (const [wid, ids] of Object.entries(result.mruByWindow)) {
        if (!Array.isArray(ids)) continue;
        const valid = [];
        for (const tabId of ids) {
          if (await validateTabId(tabId, wid)) valid.push(tabId);
        }
        if (valid.length) next[wid] = valid.slice(0, maxMruSize);
      }
    } else if (Array.isArray(result.mruTabIds)) {
      for (const tabId of result.mruTabIds) {
        const tab = await validateTabId(tabId);
        if (!tab) continue;
        const key = windowKey(tab.windowId);
        if (!next[key]) next[key] = [];
        if (!next[key].includes(tabId) && next[key].length < maxMruSize) {
          next[key].push(tabId);
        }
      }
    }

    mruByWindow = next;
    await chrome.storage.local.set({ mruByWindow: serializeMru() });
    if (result.mruTabIds !== undefined) {
      await chrome.storage.local.remove('mruTabIds');
    }
    console.log('Loaded MRU from storage:', serializeMru());
  } catch (error) {
    console.error('Error loading MRU from storage:', error);
  }
  isInitialized = true;
}

// Eager load so the first Alt+S after SW wake does not wait on a cold storage round-trip alone.
loadMruFromStorage();

async function saveMruToStorage() {
  try {
    await chrome.storage.local.set({ mruByWindow: serializeMru() });
  } catch (error) {
    console.error('Error saving MRU to storage:', error);
  }
}

function isStoreUrl(url) {
  return url.includes('chrome.google.com/webstore') ||
    url.includes('chromewebstore.google.com');
}

function isScriptableUrl(url) {
  if (!url) return false;
  if (url === 'about:blank') return true;
  const blocked = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'data:', 'file://', 'devtools://'];
  return !blocked.some((prefix) => url.startsWith(prefix)) && !isStoreUrl(url);
}

// Inject into tabs that were already open. Parallel, so a window with 100+
// tabs does not stall the shortcut behind a one-by-one walk.
async function injectContentScripts() {
  try {
    const tabs = await chrome.tabs.query({});
    const pending = tabs.filter((tab) => tab.id && isScriptableUrl(tab.url));
    const workers = Array.from({ length: 8 }, async () => {
      while (pending.length) {
        const tab = pending.shift();
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
        } catch (error) {
          // Restricted pages and discarded tabs can refuse injection.
        }
      }
    });
    await Promise.all(workers);
  } catch (error) {
    console.error('Error in injectContentScripts:', error);
  }
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (response?.loaded) return true;
  } catch (error) {
    // Not loaded yet. Inject below.
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
  return true;
}

// Initialize on service worker startup
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('TabCtrl installed/updated');

  await loadPreferences();
  await loadMruFromStorage();

  // Inject content scripts into all existing tabs
  if (details.reason === 'install' || details.reason === 'update') {
    console.log('Injecting content scripts into existing tabs...');
    await injectContentScripts();
    console.log('Content scripts injection complete');
  }
});

// Load preferences and MRU on service worker wake
chrome.runtime.onStartup.addListener(async () => {
  await loadPreferences();
  await loadMruFromStorage();
  console.log('Service worker started, MRU loaded:', serializeMru());
});

// Track tab activations for MRU ordering (per window)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!isInitialized) {
    await loadMruFromStorage();
  }

  let activatedTab = null;
  try {
    activatedTab = await chrome.tabs.get(activeInfo.tabId);
  } catch (error) {
    return;
  }
  // The switcher popup is an extension page. It must not enter the recent list.
  if (activatedTab.url?.startsWith('chrome-extension://')) return;

  const tabId = activeInfo.tabId;
  const windowId = activeInfo.windowId;
  let list = getMruList(windowId).filter((id) => id !== tabId);
  list.unshift(tabId);
  if (list.length > maxMruSize) {
    list = list.slice(0, maxMruSize);
  }
  setMruList(windowId, list);

  console.log('MRU updated for window', windowId, ':', list);

  await saveMruToStorage();
  scheduleThumbnailCapture(windowId, tabId);
});

// Clean up removed tabs from the window's MRU list
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (removeInfo?.windowId != null) {
    setMruList(
      removeInfo.windowId,
      getMruList(removeInfo.windowId).filter((id) => id !== tabId)
    );
  } else {
    for (const key of Object.keys(mruByWindow)) {
      mruByWindow[key] = mruByWindow[key].filter((id) => id !== tabId);
    }
  }
  thumbnailCache.delete(tabId);
  console.log('Tab removed from MRU:', tabId);
  await saveMruToStorage();
  persistThumbnails();
});

const DEFAULT_FAVICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="%23999"/></svg>'
);

let overlayCssText = null;
let overlayCssRequest = null;
const faviconDataUrls = new Map();

// Read content.css from the extension origin. Doing this in the service
// worker avoids loading a chrome-extension:// URL from the page frame.
function getOverlayCss() {
  if (overlayCssText !== null) {
    return Promise.resolve(overlayCssText);
  }
  if (!overlayCssRequest) {
    overlayCssRequest = fetch(chrome.runtime.getURL('content.css'))
      .then((response) => {
        if (!response.ok) {
          throw new Error('content.css request failed: ' + response.status);
        }
        return response.text();
      })
      .then((css) => {
        overlayCssText = css;
        return css;
      })
      .catch((error) => {
        console.error('Error reading content.css:', error);
        return '';
      })
      .finally(() => {
        overlayCssRequest = null;
      });
  }
  return overlayCssRequest;
}

// Turn a tab favicon into a data URL so the content script never asks the
// page frame to load another site's icon (blocked on pages such as YouTube).
async function faviconToDataUrl(url) {
  if (!url) return DEFAULT_FAVICON;
  if (url.startsWith('data:')) return url;
  if (faviconDataUrls.has(url)) return faviconDataUrls.get(url);
  if (!/^https?:\/\//i.test(url)) return DEFAULT_FAVICON;

  let dataUrl = DEFAULT_FAVICON;
  try {
    const response = await fetch(url);
    if (response.ok) {
      const blob = await response.blob();
      if (blob.type.startsWith('image/') && blob.size <= 256 * 1024) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        dataUrl = `data:${blob.type};base64,${btoa(binary)}`;
      }
    }
  } catch (error) {
    dataUrl = DEFAULT_FAVICON;
  }
  faviconDataUrls.set(url, dataUrl);
  return dataUrl;
}

const thumbnailCache = new Map();
let thumbnailTimer = null;

function canCaptureUrl(url) {
  if (!url) return false;
  const blocked = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'data:', 'file://', 'devtools://'];
  return !blocked.some((prefix) => url.startsWith(prefix)) && !isStoreUrl(url);
}

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
  });
}

async function downscaleDataUrl(dataUrl, maxWidth) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return blobToDataUrl(out);
}

async function loadThumbnails() {
  try {
    const stored = await chrome.storage.session.get('thumbnails');
    const thumbnails = stored.thumbnails || {};
    for (const [id, url] of Object.entries(thumbnails)) {
      if (typeof url === 'string' && url.startsWith('data:')) {
        thumbnailCache.set(Number(id), url);
      }
    }
  } catch (error) {
    console.log('Could not load thumbnails:', error);
  }
}

function persistThumbnails() {
  const thumbnails = {};
  for (const [id, url] of thumbnailCache) {
    thumbnails[id] = url;
  }
  chrome.storage.session.set({ thumbnails }).catch((error) => {
    console.log('Could not store thumbnails:', error);
  });
}

// captureVisibleTab only sees the tab that is on screen, so each visit
// stores a small JPEG for later. Inactive tabs cannot be snapped directly.
async function captureActiveThumbnail(windowId, expectedTabId) {
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (!active || !canCaptureUrl(active.url)) return null;
  if (expectedTabId && active.id !== expectedTabId) return null;

  const shot = await chrome.tabs.captureVisibleTab(windowId, {
    format: 'jpeg',
    quality: 40
  });
  let thumb = shot;
  try {
    thumb = await downscaleDataUrl(shot, 480);
  } catch (error) {
    console.log('Thumbnail resize failed:', error?.message || error);
  }
  thumbnailCache.set(active.id, thumb);
  // Keep only recent ids so session storage stays small.
  const keep = allMruIds();
  keep.add(active.id);
  for (const id of thumbnailCache.keys()) {
    if (!keep.has(id)) thumbnailCache.delete(id);
  }
  persistThumbnails();
  return thumb;
}

function scheduleThumbnailCapture(windowId, tabId) {
  clearTimeout(thumbnailTimer);
  thumbnailTimer = setTimeout(() => {
    captureActiveThumbnail(windowId, tabId).catch((error) => {
      console.log('Thumbnail capture failed:', error?.message || error);
    });
  }, 400);
}

// Fill a thin per-window MRU from tabs already open in that window.
async function seedMruFromWindow(windowId) {
  if (!windowId) return;
  const existing = getMruList(windowId);
  if (existing.length > 1) return;
  const windowTabs = await chrome.tabs.query({ windowId });
  const ranked = windowTabs
    .filter((tab) => tab.id && isScriptableUrl(tab.url))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .slice(0, maxMruSize)
    .map((tab) => tab.id);
  if (ranked.length > existing.length) {
    setMruList(windowId, ranked);
  }
}

// Get enriched MRU tabs with metadata (title, favicon, URL, thumbnail).
// Favicon downloads and screenshots are not on this path. With 100+ tabs
// those waits were what made the panel feel stuck.
async function getEnrichedMruTabs(windowId, activeTabId) {
  if (!isInitialized) {
    await loadMruFromStorage();
  }
  await seedMruFromWindow(windowId);

  // The tab that requested the list is the one on screen. Keep it first so
  // the highlight (index 1) is always the previous tab.
  let list = getMruList(windowId).slice();
  if (activeTabId) {
    list = list.filter((id) => id !== activeTabId);
    list.unshift(activeTabId);
    if (list.length > maxMruSize) {
      list = list.slice(0, maxMruSize);
    }
  }
  setMruList(windowId, list);
  saveMruToStorage();

  if (thumbnailCache.size === 0) {
    await loadThumbnails();
  }

  const lookedUp = await Promise.all(list.map(async (tabId) => {
    try {
      return await chrome.tabs.get(tabId);
    } catch (error) {
      return null;
    }
  }));

  const enrichedTabs = [];
  for (const tab of lookedUp) {
    if (!tab || (windowId && tab.windowId !== windowId)) continue;
    const cachedIcon = tab.favIconUrl && faviconDataUrls.has(tab.favIconUrl)
      ? faviconDataUrls.get(tab.favIconUrl)
      : DEFAULT_FAVICON;
    enrichedTabs.push({
      id: tab.id,
      title: tab.title || 'Untitled',
      url: tab.url || '',
      favIconUrl: cachedIcon,
      thumbnail: thumbnailCache.get(tab.id) || null,
      sourceFavIcon: tab.favIconUrl || ''
    });
  }

  return enrichedTabs;
}

function deliverVisuals(visuals, targetTabId) {
  const message = { action: 'updateVisuals', visuals };
  if (targetTabId) {
    chrome.tabs.sendMessage(targetTabId, message).catch(() => {});
    return;
  }
  chrome.runtime.sendMessage(message).catch(() => {});
}

// Icons and any missing preview fill in after the panel is already open.
function refreshVisuals(targetTabId, tabs) {
  Promise.all(tabs.map(async (tab) => ({
    id: tab.id,
    favIconUrl: await faviconToDataUrl(tab.sourceFavIcon),
    thumbnail: thumbnailCache.get(tab.id) || null
  }))).then((visuals) => {
    deliverVisuals(visuals, targetTabId);
  }).catch((error) => {
    console.log('Visual refresh failed:', error?.message || error);
  });
}

// Message handler for content script communication
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getOverlayCss') {
    getOverlayCss()
      .then((css) => sendResponse({ css }))
      .catch((error) => sendResponse({ css: '', error: error.message }));
    return true;
  }

  // Handle getMruTabs action
  if (request.action === 'getMruTabs') {
    const windowId = request.windowId || sender.tab?.windowId || chrome.windows.WINDOW_ID_CURRENT;
    const resolveActiveTab = sender.tab?.id
      ? Promise.resolve(sender.tab.id)
      : chrome.tabs.query({ windowId, active: true }).then((tabs) => tabs[0]?.id);

    resolveActiveTab
      .then((activeTabId) => getEnrichedMruTabs(windowId, activeTabId))
      .then(tabs => {
        const payload = tabs.map(({ sourceFavIcon, ...tab }) => tab);
        sendResponse({ tabs: payload });
        refreshVisuals(sender.tab?.id, tabs);
      })
      .catch(error => {
        console.error('Error getting MRU tabs:', error);
        sendResponse({ tabs: [], error: error.message });
      });

    return true; // Keep channel open for async response
  }

  // Handle switchToTab action
  if (request.action === 'switchToTab') {
    const tabId = request.tabId;

    chrome.tabs.update(tabId, { active: true })
      .then(() => {
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('Error switching to tab:', error);
        sendResponse({
          success: false,
          error: 'Tab no longer exists or cannot be activated'
        });
      });

    return true; // Keep channel open for async response
  }

  // Handle closeTab action
  if (request.action === 'closeTab') {
    const tabId = request.tabId;

    chrome.tabs.remove(tabId)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('Error closing tab:', error);
        sendResponse({
          success: false,
          error: 'Tab cannot be closed'
        });
      });

    return true; // Keep channel open for async response
  }

  // Return false for unknown actions (don't keep channel open)
  return false;
});

// Cmd+T lands on a chrome:// new tab page, where a content script cannot run.
// The same switcher opens in a focused popup over that window instead.
let switcherWindowId = null;

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === switcherWindowId) switcherWindowId = null;
  if (mruByWindow[windowKey(windowId)]) {
    delete mruByWindow[windowKey(windowId)];
    saveMruToStorage();
  }
});

async function focusSwitcherWindow() {
  await chrome.windows.update(switcherWindowId, { focused: true });
  chrome.runtime.sendMessage({ action: 'popupCycle' }).catch(() => {});
}

async function openSwitcherWindow(browserWindowId) {
  if (switcherWindowId != null) {
    try {
      await chrome.windows.get(switcherWindowId);
      await focusSwitcherWindow();
      return;
    } catch (error) {
      switcherWindowId = null;
    }
  }

  let left = 80;
  let top = 80;
  const width = 980;
  const height = 460;
  try {
    const parent = await chrome.windows.get(browserWindowId);
    left = Math.max(0, Math.round((parent.left || 0) + ((parent.width || width) - width) / 2));
    top = Math.max(0, Math.round((parent.top || 0) + ((parent.height || height) - height) / 2));
  } catch (error) {
    // Keep the default position.
  }

  const created = await chrome.windows.create({
    url: 'switcher.html?windowId=' + encodeURIComponent(browserWindowId),
    type: 'popup',
    width,
    height,
    left,
    top,
    focused: true
  });
  switcherWindowId = created.id;
}

// Handle command from manifest commands API
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-tab-switcher') {
    console.log('Tab switcher command triggered');

    try {
      if (switcherWindowId != null) {
        try {
          await chrome.windows.get(switcherWindowId);
          await focusSwitcherWindow();
          return;
        } catch (error) {
          switcherWindowId = null;
        }
      }

      // Get the active tab
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!activeTab || !activeTab.id) {
        console.error('No active tab found');
        return;
      }

      let tab = activeTab;
      if (!tab.url || tab.url === 'about:blank') {
        tab = await chrome.tabs.get(tab.id);
      }

      if (!isScriptableUrl(tab.url)) {
        await openSwitcherWindow(tab.windowId);
        return;
      }

      // New website tabs and tabs open before install do not have the script yet.
      try {
        await ensureContentScript(tab.id);
        await chrome.tabs.sendMessage(tab.id, { action: 'showSwitcher' });
      } catch (error) {
        console.log('Could not open switcher on this tab:', error?.message || error);
        await openSwitcherWindow(tab.windowId);
      }
    } catch (error) {
      console.error('Error in command handler:', error);
    }
  }
});
