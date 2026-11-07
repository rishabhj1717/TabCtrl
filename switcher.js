const root = document.getElementById('switcher');
const browserWindowId = Number(new URLSearchParams(location.search).get('windowId'));

let tabs = [];
let selectedIndex = 1;
let lastForwardAt = 0;
const openedAt = Date.now();

function domainOf(url) {
  try {
    return new URL(url).hostname || 'Page';
  } catch (error) {
    return 'Page';
  }
}

function render() {
  root.replaceChildren();
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
  tabs.forEach((tab, index) => {
    const domain = domainOf(tab.url);
    const item = document.createElement('li');
    item.className = 'tab-item' + (index === selectedIndex ? ' selected' : '');
    item.dataset.tabId = tab.id;

    const preview = document.createElement('div');
    preview.className = 'tab-preview';
    if (tab.thumbnail && tab.thumbnail.startsWith('data:')) {
      const img = document.createElement('img');
      img.src = tab.thumbnail;
      img.alt = '';
      img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
      preview.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'tab-preview-placeholder';
      placeholder.textContent = domain.charAt(0).toUpperCase() || 'P';
      const hue = domain.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
      placeholder.style.background = `linear-gradient(135deg, hsl(${hue}, 60%, 50%), hsl(${hue + 40}, 60%, 60%))`;
      preview.appendChild(placeholder);
    }

    const favicon = document.createElement('img');
    favicon.className = 'tab-favicon';
    favicon.alt = '';
    if (tab.favIconUrl && tab.favIconUrl.startsWith('data:')) {
      favicon.src = tab.favIconUrl;
    } else {
      favicon.style.display = 'none';
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
  hint.textContent = 'Hold Alt • S forward • Shift+S back • release Alt to select • Esc to skip';
  root.append(list, hint);

  const selected = root.querySelector('.tab-item.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
  render();
}

function forward() {
  const now = Date.now();
  if (now - lastForwardAt < 80) return;
  lastForwardAt = now;
  cycle(1);
}

function commit() {
  const tab = tabs[selectedIndex];
  if (!tab) {
    window.close();
    return;
  }
  chrome.runtime.sendMessage({ action: 'switchToTab', tabId: tab.id }, () => {
    window.close();
  });
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'popupCycle') forward();
  if (request.action === 'updateVisuals') applyVisuals(request.visuals);
});

window.addEventListener('keydown', (event) => {
  const isS = event.code === 'KeyS' && !event.metaKey && !event.ctrlKey;
  if (isS && event.shiftKey) {
    event.preventDefault();
    lastForwardAt = Date.now();
    cycle(-1);
    return;
  }
  if (isS) {
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
  if (event.key === 'Escape') {
    event.preventDefault();
    window.close();
  }
});

window.addEventListener('keyup', (event) => {
  if (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight') {
    commit();
  }
});

chrome.runtime.sendMessage({ action: 'getMruTabs', windowId: browserWindowId }, (response) => {
  tabs = response?.tabs || [];
  selectedIndex = tabs.length > 1 ? 1 : 0;
  render();
});
