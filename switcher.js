const root = document.getElementById('switcher');
const browserWindowId = Number(new URLSearchParams(location.search).get('windowId'));

let tabs = [];
let selectedIndex = 1;
let lastForwardAt = 0;
const openedAt = Date.now();
let holdSeen = false;
let commitWhenReady = false;
let closed = false;
let hotkey = TabCtrlShared.DEFAULT;
let panelColor = 'auto';

function domainOf(url) {
  try {
    return new URL(url).hostname || 'Page';
  } catch (error) {
    return 'Page';
  }
}

function render() {
  root.replaceChildren();
  TabCtrlShared.applyTheme(root, panelColor);
  if (tabs.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'keyboard-hint';
    hint.textContent = 'No recent tabs in this window yet';
    root.appendChild(hint);
    return;
  }
  if (selectedIndex >= tabs.length) selectedIndex = tabs.length - 1;
  if (selectedIndex < 0) selectedIndex = 0;

  const list = document.createElement('ul');
  list.className = 'tab-list';
  list.style.setProperty('--tc-cols', String(TabCtrlShared.columnsFor(tabs.length)));
  tabs.forEach((tab, index) => {
    const domain = domainOf(tab.url);
    const item = document.createElement('li');
    item.className = 'tab-item' + (index === selectedIndex ? ' selected' : '');
    item.dataset.tabId = tab.id;

    const preview = document.createElement('div');
    preview.className = 'tab-preview';
    if (tab.thumbnail && tab.thumbnail.startsWith('data:')) {
      TabCtrlShared.showPreviewShot(preview, tab.thumbnail);
    } else if (tab.favIconUrl && tab.favIconUrl.startsWith('data:')) {
      TabCtrlShared.showPreviewIcon(preview, tab.favIconUrl);
    } else {
      preview.appendChild(TabCtrlShared.letterPlaceholder(domain));
    }

    const favicon = document.createElement('img');
    favicon.className = 'tab-favicon';
    favicon.alt = '';
    if (tab.favIconUrl && tab.favIconUrl.startsWith('data:')) {
      favicon.src = tab.favIconUrl;
    } else {
      favicon.style.visibility = 'hidden';
    }

    const info = document.createElement('div');
    info.className = 'tab-info';
    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || 'Untitled';
    const url = document.createElement('div');
    url.className = 'tab-url';
    url.textContent = domain;
    info.appendChild(title);
    info.appendChild(url);

    item.append(preview, favicon, info);
    item.addEventListener('click', () => {
      selectedIndex = index;
      commit();
    });
    list.appendChild(item);
  });

  const hint = document.createElement('div');
  hint.className = 'keyboard-hint';
  hint.textContent = TabCtrlShared.hint(hotkey);
  root.append(list, hint);

  TabCtrlShared.revealItem(root, root.querySelector('.tab-item.selected'));
}

function applyVisuals(visuals) {
  if (!Array.isArray(visuals)) return;
  let changed = false;
  for (const visual of visuals) {
    const tab = tabs.find((item) => item.id === visual.id);
    if (!tab) continue;
    if (visual.favIconUrl) tab.favIconUrl = visual.favIconUrl;
    if (visual.thumbnail) tab.thumbnail = visual.thumbnail;
    changed = true;
  }
  if (changed) render();
}

function cycle(step) {
  if (tabs.length === 0) return;
  selectedIndex = (selectedIndex + step + tabs.length) % tabs.length;
  const items = root.querySelectorAll('.tab-item');
  items.forEach((item, index) => item.classList.toggle('selected', index === selectedIndex));
  TabCtrlShared.revealItem(root, items[selectedIndex]);
}

// The popup can see the same press as a keydown and as a relayed command.
function forward() {
  const now = Date.now();
  if (now - lastForwardAt < 80) return;
  lastForwardAt = now;
  cycle(1);
}

function finishWithHoldRelease() {
  if (closed) return;
  if (tabs.length === 0) {
    commitWhenReady = true;
    return;
  }
  commit();
}

function commit() {
  if (closed) return;
  closed = true;
  const tab = tabs[selectedIndex];
  if (!tab) {
    window.close();
    return;
  }
  chrome.runtime.sendMessage({ action: 'switchToTab', tabId: tab.id }, () => {
    window.close();
  });
  // Close immediately so a slow switch cannot leave the popup stranded.
  setTimeout(() => {
    try { window.close(); } catch (error) { /* ignore */ }
  }, 0);
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'popupCycle') {
    holdSeen = true;
    forward();
  }
  if (request.action === 'updateVisuals') applyVisuals(request.visuals);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closed = true;
    window.close();
    return;
  }

  if (TabCtrlShared.isHoldHeld(hotkey, event)) holdSeen = true;

  const direction = TabCtrlShared.cycleDirection(hotkey, event);
  if (direction < 0) {
    event.preventDefault();
    lastForwardAt = Date.now();
    cycle(-1);
    return;
  }
  if (direction > 0) {
    event.preventDefault();
    if (Date.now() - openedAt < 300) return;
    forward();
    return;
  }
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault();
    cycle(1);
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    event.preventDefault();
    cycle(-1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    commit();
    return;
  }

  // Missed modifier keyup: a later non-navigation key without it commits.
  if (holdSeen && !TabCtrlShared.isHoldHeld(hotkey, event) && event.code !== hotkey?.code) {
    finishWithHoldRelease();
  }
});

window.addEventListener('keyup', (event) => {
  if (TabCtrlShared.isHoldKeyEvent(hotkey, event)) {
    finishWithHoldRelease();
    return;
  }
  if (holdSeen && !TabCtrlShared.isHoldHeld(hotkey, event)) {
    finishWithHoldRelease();
  }
});

// Popup create is slow enough that the modifier is often already released before focus.
// Blur dismisses without switching; click / Enter / modifier keyup still commit.
window.addEventListener('blur', () => {
  if (closed) return;
  closed = true;
  window.close();
});

let pointerSeen = false;
window.addEventListener('pointerdown', () => { pointerSeen = true; }, true);
window.addEventListener('mousemove', () => { pointerSeen = true; }, { once: true, capture: true });

chrome.storage.local.get(['hotkey', 'panelColor'], (settings) => {
  hotkey = TabCtrlShared.fromStorage(settings?.hotkey);
  panelColor = settings?.panelColor || 'auto';

  chrome.runtime.sendMessage({ action: 'getMruTabs', windowId: browserWindowId }, (response) => {
    tabs = response?.tabs || [];
    selectedIndex = tabs.length > 1 ? 1 : 0;
    render();
    if (commitWhenReady) {
      commitWhenReady = false;
      commit();
      return;
    }
    // Quick shortcut tap: keyup usually fired on the previous page before this
    // popup focused. If the user is not holding the modifier or aiming with the
    // pointer, complete the common “go to previous tab” gesture.
    setTimeout(() => {
      if (closed || holdSeen || pointerSeen) return;
      finishWithHoldRelease();
    }, 280);
  });
});
