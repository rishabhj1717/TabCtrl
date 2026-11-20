// TabCtrl Content Script
// Handles UI injection, keyboard events, and tab switching

// The overlay can only live in the top document. Frames that load this script
// would try to pull in extension CSS and other tabs' favicons, which Chrome
// rejects with "Domains, protocols and ports must match."
if (window.top !== window) {
  // Nested frame: nothing to do.
} else if (window.tabCtrlLoaded) {
  console.log('TabCtrl already loaded, skipping duplicate injection');
} else {
  window.tabCtrlLoaded = true;

// State management
let switcherActive = false;
let selectedIndex = 1;
let tabs = [];
let overlayElement = null;
let shadowRoot = null;
let overlayGeneration = 0;
let mruRequestId = 0;
let overlayCssText = '';
let commitWhenReady = false;
let pendingMoves = 0;
let pendingVisuals = null;
let holdWasDown = false;
let hotkey = TabCtrlShared.DEFAULT;
let panelColor = 'auto';

// One shortcut press can arrive twice: as a page keydown and as the Chrome
// command relayed by the background, in either order. Each source records its
// presses; a press from the other source within the window is the same one.
const PAIR_WINDOW_MS = 400;
let keyPresses = [];
let commandPresses = [];

const FALLBACK_CSS = `
  .tabctrl-switcher {
    pointer-events: auto;
    background: var(--tc-panel, #202124);
    color: var(--tc-text, #e8eaed);
    border-radius: 16px;
    padding: 16px;
    max-width: 92vw;
    max-height: 86vh;
    overflow-y: auto;
    scrollbar-width: none;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .tab-list { display: grid; grid-template-columns: repeat(var(--tc-cols, 5), minmax(0, 180px)); gap: 12px; list-style: none; padding: 0; margin: 0; }
  .tab-item { background: var(--tc-card, #35363a); border: 3px solid transparent; border-radius: 12px; padding: 10px; cursor: pointer; }
  .tab-item.selected { border-color: var(--tc-ring, #a8c7fa); }
`;

// Initialize content script. CSS is loaded lazily on first overlay open
// so every navigation does not wake the service worker.
function init() {
  console.log('TabCtrl content script loaded');
  loadSettings();
  attachKeyboardListeners();
  attachLifecycleListeners();
  attachMessageListener();
}

// Storage reads do not wake the service worker.
function loadSettings() {
  chrome.storage.local.get(['hotkey', 'panelColor'], (result) => {
    if (chrome.runtime.lastError || !result) return;
    hotkey = TabCtrlShared.fromStorage(result.hotkey);
    panelColor = result.panelColor || 'auto';
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.hotkey) hotkey = TabCtrlShared.fromStorage(changes.hotkey.newValue);
    if (changes.panelColor) panelColor = changes.panelColor.newValue || 'auto';
  });
}

// Returns false when this press was already handled through the other source.
function claimPress(source) {
  const now = performance.now();
  const mine = source === 'key' ? keyPresses : commandPresses;
  const other = source === 'key' ? commandPresses : keyPresses;
  while (other.length && now - other[0] > PAIR_WINDOW_MS) other.shift();
  if (other.length) {
    other.shift();
    return false;
  }
  while (mine.length && now - mine[0] > PAIR_WINDOW_MS) mine.shift();
  mine.push(now);
  return true;
}

// CSS is read by the service worker and sent as text. Fetching
// chrome-extension://content.css from the page is what Chrome blocks.
function loadOverlayCss() {
  if (overlayCssText) return Promise.resolve(overlayCssText);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getOverlayCss' }, (response) => {
      const css = chrome.runtime.lastError ? '' : (response?.css || '');
      if (css) overlayCssText = css;
      resolve(css);
    });
  });
}

function isOverlayMounted() {
  return !!(overlayElement && shadowRoot && overlayElement.isConnected);
}

function recoverDesyncedState() {
  if (switcherActive && !isOverlayMounted()) {
    switcherActive = false;
    tabs = [];
    commitWhenReady = false;
    pendingMoves = 0;
    pendingVisuals = null;
  }
}

// Listen for messages from background script
function attachMessageListener() {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
      // Respond to ping to indicate script is loaded
      if (request.action === 'ping') {
        sendResponse({ loaded: true });
        return true;
      }
      
      if (request.action === 'showSwitcher') {
        console.log('Show switcher command received');
        recoverDesyncedState();
        if (!switcherActive) {
          openSwitcher('command');
        } else if (claimPress('command')) {
          // Chrome often consumes the shortcut, so a press may arrive only as this command.
          cycleForward();
        }
        sendResponse({ success: true });
        return true;
      }

      if (request.action === 'updateVisuals' && Array.isArray(request.visuals)) {
        applyVisuals(request.visuals);
        sendResponse({ success: true });
        return true;
      }
    } catch (error) {
      console.error('Error in message listener:', error);
      sendResponse({ success: false, error: error.message });
    }
    return false;
  });
}

// Attach global keyboard event listeners
function attachKeyboardListeners() {
  // Window capture runs before the page sees the key, including YouTube.
  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('keyup', handleKeyUp, true);
}

// Focus/visibility loses the modifier keyup. Commit or dismiss so the overlay cannot stick.
function attachLifecycleListeners() {
  window.addEventListener('blur', handleWindowBlur, true);
  document.addEventListener('visibilitychange', handleVisibilityChange, true);
}

function handleWindowBlur() {
  if (!switcherActive) return;
  // Keyup for Alt often never reaches this document after a focus change.
  // Dismiss (do not commit) so a focus blip cannot switch tabs by surprise.
  closeSwitcher();
}

function handleVisibilityChange() {
  if (!switcherActive || document.visibilityState === 'visible') return;
  closeSwitcher();
}

function finishWithHoldRelease() {
  if (!switcherActive) return;
  if (tabs.length === 0) {
    commitWhenReady = true;
    return;
  }
  commitSelection();
}

// Handle keydown events
function handleKeyDown(event) {
  // Matching uses event.code: with Option held on macOS, event.key for S is "ß".
  if (!switcherActive) {
    if (TabCtrlShared.matchesOpen(hotkey, event)) {
      event.preventDefault();
      event.stopPropagation();
      openSwitcher('key');
    }
    return;
  }

  // Escape dismisses the panel and leaves the current tab active.
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeSwitcher();
    return;
  }

  if (TabCtrlShared.isHoldHeld(hotkey, event)) holdWasDown = true;

  // Modifier stays held: the key moves forward, Shift+key moves backward.
  const direction = TabCtrlShared.cycleDirection(hotkey, event);
  if (direction) {
    event.preventDefault();
    event.stopPropagation();
    if (direction < 0) {
      cycleSelectionUp();
    } else if (claimPress('key')) {
      cycleForward();
    }
    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
    event.preventDefault();
    event.stopPropagation();
    cycleSelectionDown();
    return;
  }

  if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
    event.preventDefault();
    event.stopPropagation();
    cycleSelectionUp();
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    commitSelection();
    return;
  }

  // Missed modifier keyup failsafe: a later non-navigation key without it commits.
  if (holdWasDown && !TabCtrlShared.isHoldHeld(hotkey, event) && event.code !== hotkey?.code) {
    finishWithHoldRelease();
  }
}

function handleKeyUp(event) {
  if (!switcherActive) return;
  if (!TabCtrlShared.isHoldKeyEvent(hotkey, event)) {
    // Modifier state can clear without its own keyup on some OS/Chrome paths.
    if (holdWasDown && !TabCtrlShared.isHoldHeld(hotkey, event)) {
      finishWithHoldRelease();
    }
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  holdWasDown = false;
  finishWithHoldRelease();
}

// source is 'key' or 'command': whichever delivered the opening press.
function openSwitcher(source) {
  selectedIndex = 1; // Start at the previous tab, not the one already showing.
  pendingMoves = 0;
  commitWhenReady = false;
  pendingVisuals = null;
  holdWasDown = true;
  keyPresses = [];
  commandPresses = [];
  claimPress(source);

  if (!mountOverlay()) {
    switcherActive = false;
    return;
  }

  switcherActive = true;
  const hint = document.createElement('div');
  hint.className = 'keyboard-hint';
  hint.style.position = 'relative';
  hint.style.zIndex = '1';
  hint.textContent = 'Loading recent tabs…';
  shadowRoot.appendChild(hint);
  requestMruData();
}

function applyVisuals(visuals) {
  pendingVisuals = visuals;
  if (!shadowRoot || !switcherActive) return;
  for (const visual of visuals) {
    const item = shadowRoot.querySelector('.tab-item[data-tab-id="' + visual.id + '"]');
    if (!item) continue;
    const preview = item.querySelector('.tab-preview');
    if (visual.thumbnail) {
      TabCtrlShared.showPreviewShot(preview, visual.thumbnail);
    } else {
      TabCtrlShared.showPreviewIcon(preview, visual.favIconUrl);
    }
    const favicon = item.querySelector('.tab-favicon');
    if (favicon && visual.favIconUrl && visual.favIconUrl.startsWith('data:')) {
      favicon.style.visibility = '';
      favicon.src = visual.favIconUrl;
    }
  }
}

function cycleForward() {
  cycleSelectionDown();
}

// Request MRU tab data from background script
function requestMruData() {
  const requestId = ++mruRequestId;
  console.log('Requesting MRU data from background...');
  chrome.runtime.sendMessage(
    { action: 'getMruTabs' },
    async (response) => {
      if (requestId !== mruRequestId) return;
      console.log('Received response:', response);
      if (chrome.runtime.lastError) {
        console.error('getMruTabs failed:', chrome.runtime.lastError.message);
        closeSwitcher();
        return;
      }
      if (response && response.tabs) {
        tabs = response.tabs;
        console.log('MRU tabs:', tabs.length, 'tabs');

        if (tabs.length > 0 && pendingMoves) {
          const count = tabs.length;
          selectedIndex = ((selectedIndex + pendingMoves) % count + count) % count;
          pendingMoves = 0;
        }
        
        if (!switcherActive || requestId !== mruRequestId) return;

        if (tabs.length === 0) {
          showEmptyPanel();
          return;
        }
        
        // Ensure selectedIndex is valid
        if (selectedIndex >= tabs.length) {
          selectedIndex = tabs.length - 1;
        }
        
        await renderSwitcherUI();
        if (requestId !== mruRequestId || !switcherActive) return;
        if (commitWhenReady) {
          commitWhenReady = false;
          commitSelection();
        }
      } else {
        console.error('Failed to get MRU tabs:', response?.error);
        closeSwitcher();
      }
    }
  );
}

function mountOverlay() {
  if (overlayElement && shadowRoot && overlayElement.isConnected) return true;
  if (!document.documentElement) return false;

  const host = document.createElement('div');
  host.id = 'tabctrl-overlay';
  host.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 2147483647;
    pointer-events: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;
  // Closed mode keeps titles, URLs, and thumbnails out of page JS
  // (document.getElementById('tabctrl-overlay').shadowRoot is null).
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = overlayCssText || FALLBACK_CSS;
  shadow.appendChild(style);

  // Backdrop lives inside the shadow so hit-testing is not retargeted to the host.
  const backdrop = document.createElement('div');
  backdrop.className = 'tabctrl-backdrop';
  backdrop.style.cssText = 'position:absolute;inset:0;pointer-events:auto;';
  backdrop.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeSwitcher();
  });
  shadow.appendChild(backdrop);

  document.documentElement.appendChild(host);
  overlayElement = host;
  shadowRoot = shadow;

  if (!overlayCssText) {
    loadOverlayCss().then((css) => {
      if (css && style.isConnected) style.textContent = css;
    });
  }
  return true;
}

function showEmptyPanel() {
  if (!mountOverlay()) {
    closeSwitcher();
    return;
  }
  while (shadowRoot.childNodes.length > 2) {
    shadowRoot.removeChild(shadowRoot.lastChild);
  }
  const hint = document.createElement('div');
  hint.className = 'keyboard-hint';
  hint.style.position = 'relative';
  hint.style.zIndex = '1';
  hint.textContent = 'No recent tabs in this window yet';
  shadowRoot.appendChild(hint);
}

// Render the switcher UI overlay
async function renderSwitcherUI() {
  const generation = overlayGeneration;
  try {
    if (!document.documentElement || !switcherActive) return;
    if (!mountOverlay()) {
      closeSwitcher();
      return;
    }
    if (generation !== overlayGeneration || !switcherActive) return;
    if (!shadowRoot || !overlayElement) return;

    // Clear existing content (keep style + backdrop)
    while (shadowRoot.childNodes.length > 2) {
      shadowRoot.removeChild(shadowRoot.lastChild);
    }
    
    // Create switcher container
    const switcherContainer = document.createElement('div');
    switcherContainer.className = 'tabctrl-switcher';
    switcherContainer.style.position = 'relative';
    switcherContainer.style.zIndex = '1';
    TabCtrlShared.applyTheme(switcherContainer, panelColor);
    
    // Create tab list
    const tabList = document.createElement('ul');
    tabList.className = 'tab-list';
    tabList.style.setProperty('--tc-cols', String(TabCtrlShared.columnsFor(tabs.length)));
    
    // Create tab items
    tabs.forEach((tab, index) => {
      const tabItem = createTabElement(tab, index);
      tabList.appendChild(tabItem);
    });
    
    // Create keyboard hint
    const hint = document.createElement('div');
    hint.className = 'keyboard-hint';
    hint.textContent = TabCtrlShared.hint(hotkey, 'Esc or click outside to skip');
    
    // Assemble UI
    switcherContainer.appendChild(tabList);
    switcherContainer.appendChild(hint);
    shadowRoot.appendChild(switcherContainer);
    
    TabCtrlShared.revealItem(switcherContainer, shadowRoot.querySelector('.tab-item.selected'));
    if (pendingVisuals) applyVisuals(pendingVisuals);
  } catch (error) {
    console.error('Error rendering switcher UI:', error);
    closeSwitcher();
  }
}

// Create a tab element (safer than template strings)
function createTabElement(tab, index) {
  const li = document.createElement('li');
  li.className = 'tab-item' + (index === selectedIndex ? ' selected' : '');
  li.dataset.index = index;
  li.dataset.tabId = tab.id;
  
  // Preview area
  const preview = document.createElement('div');
  preview.className = 'tab-preview';
  
  // Extract domain safely
  let domain = 'Page';
  try {
    const url = new URL(tab.url);
    domain = url.hostname || 'Page';
  } catch (e) {
    domain = 'Page';
  }
  
  // Screenshot if this tab has been on screen, else its site icon, else its initial.
  if (tab.thumbnail && tab.thumbnail.startsWith('data:')) {
    TabCtrlShared.showPreviewShot(preview, tab.thumbnail);
  } else if (tab.favIconUrl && tab.favIconUrl.startsWith('data:')) {
    TabCtrlShared.showPreviewIcon(preview, tab.favIconUrl);
  } else {
    preview.appendChild(TabCtrlShared.letterPlaceholder(domain));
  }
  
  // Favicon
  const favicon = document.createElement('img');
  favicon.className = 'tab-favicon';
  favicon.alt = '';
  favicon.onerror = function() { this.style.visibility = 'hidden'; };
  // Only data URLs. A remote favicon is a cross-origin load from this frame,
  // which Chrome reports as an unsafe load on sites such as YouTube.
  if (tab.favIconUrl && tab.favIconUrl.startsWith('data:')) {
    favicon.src = tab.favIconUrl;
  } else {
    favicon.style.visibility = 'hidden';
  }
  
  // Tab info
  const info = document.createElement('div');
  info.className = 'tab-info';
  
  const title = document.createElement('div');
  title.className = 'tab-title';
  title.textContent = tab.title || 'Untitled';
  title.title = tab.title || '';
  
  const url = document.createElement('div');
  url.className = 'tab-url';
  url.textContent = domain;
  url.title = tab.url || '';
  
  info.appendChild(title);
  info.appendChild(url);
  
  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close tab';
  closeBtn.dataset.tabId = tab.id;
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab.id);
  });
  
  // Index badge
  const indexBadge = document.createElement('span');
  indexBadge.className = 'tab-index';
  indexBadge.textContent = (index + 1).toString();
  
  // Assemble tab item
  li.appendChild(preview);
  li.appendChild(favicon);
  li.appendChild(info);
  li.appendChild(closeBtn);
  li.appendChild(indexBadge);
  
  // Click handler for tab item
  li.addEventListener('click', (e) => {
    if (!e.target.classList.contains('tab-close')) {
      selectedIndex = index;
      commitSelection();
    }
  });
  
  return li;
}

// Cycle selection down (next item)
function cycleSelectionDown() {
  if (tabs.length === 0) {
    pendingMoves += 1;
    return;
  }
  selectedIndex = (selectedIndex + 1) % tabs.length;
  updateSelection();
}

// Cycle selection up (previous item)
function cycleSelectionUp() {
  if (tabs.length === 0) {
    pendingMoves -= 1;
    return;
  }
  selectedIndex = (selectedIndex - 1 + tabs.length) % tabs.length;
  updateSelection();
}

function highlightedIndex() {
  if (shadowRoot) {
    const selected = shadowRoot.querySelector('.tab-item.selected');
    const index = Number(selected?.dataset.index);
    if (Number.isInteger(index) && index >= 0 && index < tabs.length) {
      return index;
    }
  }
  return selectedIndex;
}

// Update the UI to reflect current selection
function updateSelection() {
  if (!shadowRoot) return;
  
  const tabItems = shadowRoot.querySelectorAll('.tab-item');
  tabItems.forEach((item, index) => {
    item.classList.toggle('selected', index === selectedIndex);
  });
  TabCtrlShared.revealItem(
    shadowRoot.querySelector('.tabctrl-switcher'),
    tabItems[selectedIndex]
  );
}

// Commit the current selection and switch tabs
function commitSelection() {
  selectedIndex = highlightedIndex();
  if (tabs.length === 0 || selectedIndex >= tabs.length || selectedIndex < 0) {
    closeSwitcher();
    return;
  }
  
  const selectedTab = tabs[selectedIndex];
  // Clear the overlay immediately so a slow tabs.update cannot leave it stuck.
  const tabId = selectedTab.id;
  closeSwitcher(true);

  chrome.runtime.sendMessage(
    { 
      action: 'switchToTab',
      tabId
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error('Failed to switch tab:', chrome.runtime.lastError.message);
        return;
      }
      if (response && !response.success) {
        console.error('Failed to switch tab:', response.error);
      }
    }
  );
}

// Close a tab
function closeTab(tabId) {
  console.log('Closing tab:', tabId);

  chrome.runtime.sendMessage(
    { action: 'closeTab', tabId: tabId },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error('Failed to close tab:', chrome.runtime.lastError.message);
        return;
      }
      if (!response?.success) {
        console.error('Failed to close tab:', response?.error || 'unknown error');
        return;
      }

      const tabIndex = tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return;

      tabs.splice(tabIndex, 1);

      if (tabIndex < selectedIndex) {
        selectedIndex -= 1;
      }
      if (selectedIndex >= tabs.length) {
        selectedIndex = Math.max(0, tabs.length - 1);
      }

      if (tabs.length === 0) {
        closeSwitcher();
      } else {
        renderSwitcherUI();
      }
    }
  );
}

// Close the switcher and reset state. A commit reports itself through
// switchToTab; any other close tells the background the session ended.
function closeSwitcher(committing = false) {
  if (switcherActive && !committing) {
    try {
      chrome.runtime.sendMessage({ action: 'switcherClosed' }).catch(() => {});
    } catch (error) {
      // Extension was reloaded; nothing to notify.
    }
  }
  commitWhenReady = false;
  pendingMoves = 0;
  pendingVisuals = null;
  holdWasDown = false;
  keyPresses = [];
  commandPresses = [];
  mruRequestId++;
  overlayGeneration++;
  if (overlayElement) {
    overlayElement.remove();
    overlayElement = null;
    shadowRoot = null;
  }
  
  switcherActive = false;
  selectedIndex = 1;
  tabs = [];
}

// Initialize when script loads
init();

} // End of double-injection check
