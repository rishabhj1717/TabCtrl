// TabCtrl Background Service Worker
// Manages MRU (Most Recently Used) tab tracking and tab switching

// In-memory MRU queue with persistence
let mruTabIds = [];
let maxMruSize = 5;
let isInitialized = false;

function normalizeMaxMruSize(value) {
  return Number(value) === 10 ? 10 : 5;
}

async function loadPreferences() {
  const result = await chrome.storage.local.get(['maxMruSize']);
  if (result.maxMruSize !== 5 && result.maxMruSize !== 10) {
    await chrome.storage.local.set({ maxMruSize: 5 });
  }
  maxMruSize = normalizeMaxMruSize(result.maxMruSize);
}

function trimMruToLimit() {
  if (mruTabIds.length <= maxMruSize) return;
  mruTabIds = mruTabIds.slice(0, maxMruSize);
  saveMruToStorage();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.maxMruSize) return;
  maxMruSize = normalizeMaxMruSize(changes.maxMruSize.newValue);
  trimMruToLimit();
});

// Load MRU from storage on startup
async function loadMruFromStorage() {
  await loadPreferences();
  try {
    const result = await chrome.storage.local.get(['mruTabIds']);
    if (result.mruTabIds && Array.isArray(result.mruTabIds)) {
      // Validate that tabs still exist
      const validTabIds = [];
      for (const tabId of result.mruTabIds) {
        try {
          await chrome.tabs.get(tabId);
          validTabIds.push(tabId);
        } catch (e) {
          // Tab doesn't exist anymore
        }
      }
      mruTabIds = validTabIds.slice(0, maxMruSize);
      console.log('Loaded MRU from storage:', mruTabIds);
    }
  } catch (error) {
    console.error('Error loading MRU from storage:', error);
  }
  isInitialized = true;
}

loadPreferences();

// Save MRU to storage
async function saveMruToStorage() {
  try {
    await chrome.storage.local.set({ mruTabIds: mruTabIds });
  } catch (error) {
    console.error('Error saving MRU to storage:', error);
  }
}

function isScriptableUrl(url) {
  if (!url) return false;
  if (url === 'about:blank') return true;
  const blocked = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'data:', 'file://', 'devtools://'];
  return !blocked.some((prefix) => url.startsWith(prefix)) &&
    !url.includes('chrome.google.com/webstore');
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
  console.log('Service worker started, MRU loaded:', mruTabIds);
});

// Track tab activations for MRU ordering
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Ensure MRU is loaded
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
  
  // Remove any existing occurrence of this tabId
  mruTabIds = mruTabIds.filter(id => id !== tabId);
  
  // Add to front of array
  mruTabIds.unshift(tabId);
  
  // Trim to max size
  if (mruTabIds.length > maxMruSize) {
    mruTabIds = mruTabIds.slice(0, maxMruSize);
  }
  
  console.log('MRU updated:', mruTabIds);
  
  // Save to storage
  await saveMruToStorage();
  scheduleThumbnailCapture(activeInfo.windowId, tabId);
});

// Clean up removed tabs from MRU array
chrome.tabs.onRemoved.addListener(async (tabId) => {
  mruTabIds = mruTabIds.filter(id => id !== tabId);
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
  return !blocked.some((prefix) => url.startsWith(prefix)) &&
    !url.includes('chrome.google.com/webstore');
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
  const keep = new Set(mruTabIds);
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

// Fill a thin MRU from tabs the user already had open, newest first.
// This is the list right after install, before anyone has switched tabs.
async function seedMruFromWindow(windowId) {
  if (!windowId || mruTabIds.length > 1) return;
  const windowTabs = await chrome.tabs.query({ windowId });
  const ranked = windowTabs
    .filter((tab) => tab.id && isScriptableUrl(tab.url))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .slice(0, maxMruSize)
    .map((tab) => tab.id);
  if (ranked.length > mruTabIds.length) {
    mruTabIds = ranked;
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
  if (activeTabId) {
    mruTabIds = mruTabIds.filter((id) => id !== activeTabId);
    mruTabIds.unshift(activeTabId);
    if (mruTabIds.length > maxMruSize) {
      mruTabIds = mruTabIds.slice(0, maxMruSize);
    }
  }

  if (thumbnailCache.size === 0) {
    await loadThumbnails();
  }

  const lookedUp = await Promise.all(mruTabIds.map(async (tabId) => {
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
