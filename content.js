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
let overlayCssText = '';
let commitWhenReady = false;
let ignoreNextCommandForward = false;
let pendingMoves = 0;
let pendingVisuals = null;

const FALLBACK_CSS = `
  .tabctrl-switcher {
    pointer-events: auto;
    background: linear-gradient(135deg, rgba(100, 120, 200, 0.95) 0%, rgba(80, 100, 180, 0.95) 100%);
    border-radius: 16px;
    padding: 20px;
    max-width: 90vw;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .tab-list { display: flex; gap: 16px; list-style: none; padding: 0; margin: 0; }
  .tab-item { background: white; border-radius: 12px; padding: 12px; min-width: 200px; cursor: pointer; }
`;

// Initialize content script
function init() {
  console.log('TabCtrl content script loaded');
  attachKeyboardListeners();
  attachMessageListener();
  loadOverlayCss();
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
        if (!switcherActive) {
          openSwitcher();
        } else if (ignoreNextCommandForward) {
          // This command is the same keypress the page already handled.
          ignoreNextCommandForward = false;
        } else {
          // Chrome consumes Alt+S, so a press often arrives only as this command.
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

// Handle keydown events
function handleKeyDown(event) {
  // event.code stays "KeyS" when Alt is held. On macOS, event.key becomes "ß".
  const isS = event.code === 'KeyS' && !event.metaKey && !event.ctrlKey;

  if (!switcherActive) {
    if ((event.altKey && isS && !event.shiftKey) || (event.ctrlKey && event.key === 'Tab')) {
      event.preventDefault();
      event.stopPropagation();
      console.log('✓ Opening switcher');
      ignoreNextCommandForward = true;
      openSwitcher();
    }
    return;
  }

  // Alt stays held: S moves forward, Shift+S moves backward.
  // The browser command for Alt+S is the same keypress, so mark it handled.
  if (event.altKey && isS) {
    event.preventDefault();
    event.stopPropagation();
    ignoreNextCommandForward = true;
    if (event.shiftKey) {
      console.log('← Cycling backward (Alt+Shift+S), index:', selectedIndex);
      cycleSelectionUp();
    } else {
      console.log('→ Cycling forward (Alt+S), index:', selectedIndex);
      cycleForward();
    }
    return;
  }

  if (event.ctrlKey && event.key === 'Tab') {
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) {
      cycleSelectionUp();
    } else {
      cycleSelectionDown();
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

  // Escape dismisses the panel and leaves the current tab active.
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeSwitcher();
  }
}

function handleKeyUp(event) {
  if (event.key !== 'Alt' && event.code !== 'AltLeft' && event.code !== 'AltRight') return;
  if (!switcherActive) return;
  event.preventDefault();
  event.stopPropagation();
  // The list can still be loading. Commit after it renders.
  if (tabs.length === 0) {
    commitWhenReady = true;
    return;
  }
  commitSelection();
}

function openSwitcher() {
  switcherActive = true;
  selectedIndex = 1; // Start at the previous tab, not the one already showing.
  pendingMoves = 0;
  if (mountOverlay()) {
    const hint = document.createElement('div');
    hint.className = 'keyboard-hint';
    hint.textContent = 'Loading recent tabs…';
    shadowRoot.appendChild(hint);
  }
  requestMruData();
}

function applyVisuals(visuals) {
  pendingVisuals = visuals;
  if (!shadowRoot || !switcherActive) return;
  for (const visual of visuals) {
    const item = shadowRoot.querySelector('.tab-item[data-tab-id="' + visual.id + '"]');
    if (!item) continue;
    const preview = item.querySelector('.tab-preview');
    if (preview && visual.thumbnail && visual.thumbnail.startsWith('data:') && !preview.querySelector('img')) {
      preview.replaceChildren();
      const img = document.createElement('img');
      img.src = visual.thumbnail;
      img.alt = '';
      img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
      preview.appendChild(img);
    }
    const favicon = item.querySelector('.tab-favicon');
    if (favicon && visual.favIconUrl && visual.favIconUrl.startsWith('data:')) {
      favicon.style.display = '';
      favicon.src = visual.favIconUrl;
    }
  }
}

function cycleForward() {
  cycleSelectionDown();
}

// Request MRU tab data from background script
function requestMruData() {
  console.log('Requesting MRU data from background...');
  chrome.runtime.sendMessage(
    { action: 'getMruTabs' },
    async (response) => {
      console.log('Received response:', response);
      if (response && response.tabs) {
        tabs = response.tabs;
        console.log('MRU tabs:', tabs.length, 'tabs');

        if (tabs.length > 0 && pendingMoves) {
          const count = tabs.length;
          selectedIndex = ((selectedIndex + pendingMoves) % count + count) % count;
          pendingMoves = 0;
        }
        
        if (!switcherActive) return;

        if (tabs.length === 0) {
          showEmptyPanel();
          return;
        }
        
        // Ensure selectedIndex is valid
        if (selectedIndex >= tabs.length) {
          selectedIndex = tabs.length - 1;
        }
        
        await renderSwitcherUI();
        if (commitWhenReady && switcherActive) {
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
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(8px);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = overlayCssText || FALLBACK_CSS;
  shadow.appendChild(style);
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
  if (!mountOverlay()) return;
  while (shadowRoot.childNodes.length > 1) {
    shadowRoot.removeChild(shadowRoot.lastChild);
  }
  const hint = document.createElement('div');
  hint.className = 'keyboard-hint';
  hint.textContent = 'No recent tabs in this window yet';
  shadowRoot.appendChild(hint);
}

// Render the switcher UI overlay
async function renderSwitcherUI() {
  const generation = overlayGeneration;
  try {
    if (!document.documentElement || !switcherActive) return;
    if (!mountOverlay()) return;
    if (generation !== overlayGeneration || !switcherActive) return;
    if (!shadowRoot || !overlayElement) return;

    // Clear existing content (keep the style element)
    while (shadowRoot.childNodes.length > 1) {
      shadowRoot.removeChild(shadowRoot.lastChild);
    }
    
    // Create switcher container
    const switcherContainer = document.createElement('div');
    switcherContainer.className = 'tabctrl-switcher';
    
    // Create tab list
    const tabList = document.createElement('ul');
    tabList.className = 'tab-list';
    
    // Create tab items
    tabs.forEach((tab, index) => {
      const tabItem = createTabElement(tab, index);
      tabList.appendChild(tabItem);
    });
    
    // Create keyboard hint
    const hint = document.createElement('div');
    hint.className = 'keyboard-hint';
    hint.textContent = 'Hold Alt • S forward • Shift+S back • release Alt to select • Esc to skip';
    
    // Assemble UI
    switcherContainer.appendChild(tabList);
    switcherContainer.appendChild(hint);
    shadowRoot.appendChild(switcherContainer);
    
    const selectedItem = shadowRoot.querySelector('.tab-item.selected');
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
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
  
  // Show thumbnail if available, otherwise show placeholder
  if (tab.thumbnail && tab.thumbnail.startsWith('data:')) {
    const img = document.createElement('img');
    img.src = tab.thumbnail;
    img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
    img.alt = tab.title;
    preview.appendChild(img);
  } else {
    // Create better placeholder with gradient and icon
    const placeholder = document.createElement('div');
    placeholder.className = 'tab-preview-placeholder';
    
    // Use first letter or favicon-style icon
    const displayText = domain.charAt(0).toUpperCase();
    placeholder.textContent = displayText;
    
    // Add gradient based on domain for visual variety
    const hue = domain.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
    placeholder.style.background = `linear-gradient(135deg, hsl(${hue}, 60%, 50%), hsl(${hue + 40}, 60%, 60%))`;
    
    preview.appendChild(placeholder);
  }
  
  // Favicon
  const favicon = document.createElement('img');
  favicon.className = 'tab-favicon';
  favicon.alt = '';
  favicon.onerror = function() { this.style.display = 'none'; };
  // Only data URLs. A remote favicon is a cross-origin load from this frame,
  // which Chrome reports as an unsafe load on sites such as YouTube.
  if (tab.favIconUrl && tab.favIconUrl.startsWith('data:')) {
    favicon.src = tab.favIconUrl;
  } else {
    favicon.style.display = 'none';
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
    if (index === selectedIndex) {
      item.classList.add('selected');
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      item.classList.remove('selected');
    }
  });
}

// Commit the current selection and switch tabs
function commitSelection() {
  selectedIndex = highlightedIndex();
  if (tabs.length === 0 || selectedIndex >= tabs.length || selectedIndex < 0) {
    closeSwitcher();
    return;
  }
  
  const selectedTab = tabs[selectedIndex];
  
  // Send switch command to background
  chrome.runtime.sendMessage(
    { 
      action: 'switchToTab',
      tabId: selectedTab.id
    },
    (response) => {
      if (response && !response.success) {
        console.error('Failed to switch tab:', response.error);
        // Remove invalid tab from list and try next one
        tabs.splice(selectedIndex, 1);
        if (tabs.length > 0) {
          selectedIndex = Math.min(selectedIndex, tabs.length - 1);
          renderSwitcherUI();
        } else {
          closeSwitcher();
        }
      } else {
        closeSwitcher();
      }
    }
  );
}

// Close a tab
function closeTab(tabId) {
  console.log('Closing tab:', tabId);
  
  // Send message to background to close the tab
  chrome.runtime.sendMessage(
    { action: 'closeTab', tabId: tabId },
    (response) => {
      // Remove tab from local list
      const tabIndex = tabs.findIndex(t => t.id === tabId);
      if (tabIndex !== -1) {
        tabs.splice(tabIndex, 1);
        
        // Adjust selected index if needed
        if (selectedIndex >= tabs.length) {
          selectedIndex = Math.max(0, tabs.length - 1);
        }
        
        // Re-render or close if no tabs left
        if (tabs.length === 0) {
          closeSwitcher();
        } else {
          renderSwitcherUI();
        }
      }
    }
  );
}

// Close the switcher and reset state
function closeSwitcher() {
  commitWhenReady = false;
  ignoreNextCommandForward = false;
  pendingMoves = 0;
  pendingVisuals = null;
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

// Utility: Escape HTML to prevent XSS
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Initialize when script loads
init();

} // End of double-injection check
