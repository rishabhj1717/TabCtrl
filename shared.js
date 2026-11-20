// TabCtrl helpers shared by content.js and switcher.js.
// The shortcut lives in chrome://extensions/shortcuts. The background stores the
// text Chrome reports ("Alt+S" on Windows/Linux, "⌥S" on macOS) in
// chrome.storage.local.hotkey, and this file turns it into key matching rules.
(function () {
  if (globalThis.TabCtrlShared) return;

  const isMac = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');

  const MOD_SYMBOLS = { '⌘': 'meta', '⌃': 'ctrl', '⌥': 'alt', '⇧': 'shift' };
  const MOD_WORDS = {
    command: 'meta', cmd: 'meta', meta: 'meta', search: 'meta',
    ctrl: 'ctrl', control: 'ctrl', macctrl: 'ctrl',
    alt: 'alt', option: 'alt', shift: 'shift'
  };
  const KEY_CODES = {
    ',': 'Comma', comma: 'Comma',
    '.': 'Period', period: 'Period',
    space: 'Space',
    up: 'ArrowUp', '↑': 'ArrowUp',
    down: 'ArrowDown', '↓': 'ArrowDown',
    left: 'ArrowLeft', '←': 'ArrowLeft',
    right: 'ArrowRight', '→': 'ArrowRight',
    home: 'Home', '↖': 'Home',
    end: 'End', '↘': 'End',
    pageup: 'PageUp', '⇞': 'PageUp',
    pagedown: 'PageDown', '⇟': 'PageDown',
    insert: 'Insert',
    delete: 'Delete', del: 'Delete', '⌦': 'Delete'
  };
  const KEY_LABELS = {
    Comma: ',', Period: '.', Space: 'Space',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down',
    Insert: 'Insert', Delete: 'Delete'
  };
  const HOLD_KEYS = { alt: 'Alt', ctrl: 'Control', meta: 'Meta' };
  const HOLD_LABELS = isMac
    ? { alt: '⌥ Option', ctrl: '⌃ Control', meta: '⌘ Command' }
    : { alt: 'Alt', ctrl: 'Ctrl', meta: 'Meta' };

  function keyToCode(key) {
    if (!key) return null;
    if (/^[a-z]$/i.test(key)) return 'Key' + key.toUpperCase();
    if (/^[0-9]$/.test(key)) return 'Digit' + key;
    return KEY_CODES[key.toLowerCase()] || KEY_CODES[key] || null;
  }

  // Returns null when the shortcut is unset or unreadable.
  function parse(text) {
    if (!text || typeof text !== 'string') return null;
    const mods = { alt: false, ctrl: false, meta: false, shift: false };
    let rest = text.trim();
    let keyPart;

    if (rest.length > 1 && rest.includes('+')) {
      const parts = rest.split('+').map((part) => part.trim());
      keyPart = parts.pop();
      for (const part of parts) {
        const mod = MOD_WORDS[part.toLowerCase()];
        if (!mod) return null;
        mods[mod] = true;
      }
    } else {
      while (rest && MOD_SYMBOLS[rest[0]]) {
        mods[MOD_SYMBOLS[rest[0]]] = true;
        rest = rest.slice(1);
      }
      keyPart = rest.trim();
    }

    const code = keyToCode(keyPart);
    const hold = ['alt', 'ctrl', 'meta'].find((mod) => mods[mod]);
    if (!code || !hold) return null;

    return {
      ...mods,
      code,
      hold,
      holdKey: HOLD_KEYS[hold],
      holdLabel: HOLD_LABELS[hold],
      keyLabel: KEY_LABELS[code] || code.replace(/^(Key|Digit)/, '')
    };
  }

  // Exact match, used to open the switcher.
  function matchesOpen(hotkey, event) {
    return !!hotkey &&
      event.code === hotkey.code &&
      event.altKey === hotkey.alt &&
      event.ctrlKey === hotkey.ctrl &&
      event.metaKey === hotkey.meta &&
      event.shiftKey === hotkey.shift;
  }

  // While the switcher is open only the held modifier and the key matter.
  // Returns 1 (forward), -1 (backward) or 0 (not the shortcut key).
  function cycleDirection(hotkey, event) {
    if (!hotkey || event.code !== hotkey.code || !isHoldHeld(hotkey, event)) return 0;
    if (!hotkey.shift && event.shiftKey) return -1;
    return 1;
  }

  function isHoldHeld(hotkey, event) {
    return !!hotkey && !!event && event[hotkey.hold + 'Key'] === true;
  }

  function isHoldKeyEvent(hotkey, event) {
    return !!hotkey && event.key === hotkey.holdKey;
  }

  function hint(hotkey, skip = 'Esc to skip') {
    if (!hotkey) return `Arrows to move • Enter to select • ${skip}`;
    const back = hotkey.shift ? '' : ` • Shift+${hotkey.keyLabel} back`;
    return `Hold ${hotkey.holdLabel} • ${hotkey.keyLabel} forward${back} • release ${hotkey.holdLabel} to select • ${skip}`;
  }

  // Panel colors. "auto" follows Chrome's light/dark mode via CSS; a custom
  // hex color is applied as CSS variables with contrasting text.
  function themeVariables(panelColor) {
    if (typeof panelColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(panelColor)) return null;
    const r = parseInt(panelColor.slice(1, 3), 16);
    const g = parseInt(panelColor.slice(3, 5), 16);
    const b = parseInt(panelColor.slice(5, 7), 16);
    const dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.55;
    const mixWith = dark ? 'white' : 'black';
    return {
      '--tc-panel': panelColor,
      '--tc-card': `color-mix(in srgb, ${panelColor} 88%, ${mixWith})`,
      '--tc-card-hover': `color-mix(in srgb, ${panelColor} 80%, ${mixWith})`,
      '--tc-text': dark ? '#ffffff' : '#1f1f1f',
      '--tc-subtext': dark ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.6)',
      '--tc-ring': dark ? '#ffffff' : '#1f1f1f',
      '--tc-divider': dark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.12)'
    };
  }

  function applyTheme(element, panelColor) {
    if (!element) return;
    const vars = themeVariables(panelColor);
    for (const name of ['--tc-panel', '--tc-card', '--tc-card-hover', '--tc-text', '--tc-subtext', '--tc-ring', '--tc-divider']) {
      if (vars) element.style.setProperty(name, vars[name]);
      else element.style.removeProperty(name);
    }
  }

  // Up to 5 per row, balanced so 6 tabs show as 3 + 3 rather than 5 + 1.
  function columnsFor(count) {
    if (count <= 5) return Math.max(1, count);
    return Math.ceil(count / Math.ceil(count / 5));
  }

  // Scroll only the panel. scrollIntoView can also nudge the host page.
  function revealItem(panel, item) {
    if (!panel || !item) return;
    const pad = 12;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top - pad < panel.scrollTop) {
      panel.scrollTop = Math.max(0, top - pad);
    } else if (bottom + pad > panel.scrollTop + panel.clientHeight) {
      panel.scrollTop = bottom + pad - panel.clientHeight;
    }
  }

  // Swap the initial-letter placeholder for the site icon until a screenshot exists.
  function showPreviewIcon(preview, iconUrl) {
    if (!preview || !iconUrl || !iconUrl.startsWith('data:')) return;
    if (preview.querySelector('img.tab-preview-shot')) return;
    const existing = preview.querySelector('img.tab-preview-icon');
    if (existing) {
      existing.src = iconUrl;
      return;
    }
    const img = document.createElement('img');
    img.className = 'tab-preview-icon';
    img.alt = '';
    img.src = iconUrl;
    preview.replaceChildren(img);
  }

  function showPreviewShot(preview, thumbnail) {
    if (!preview || !thumbnail || !thumbnail.startsWith('data:')) return;
    const existing = preview.querySelector('img.tab-preview-shot');
    if (existing) {
      if (existing.src !== thumbnail) existing.src = thumbnail;
      return;
    }
    const img = document.createElement('img');
    img.className = 'tab-preview-shot';
    img.alt = '';
    img.src = thumbnail;
    preview.replaceChildren(img);
  }

  function letterPlaceholder(domain) {
    const placeholder = document.createElement('div');
    placeholder.className = 'tab-preview-placeholder';
    placeholder.textContent = domain.charAt(0).toUpperCase() || 'P';
    const hue = domain.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
    placeholder.style.background = `linear-gradient(135deg, hsl(${hue}, 55%, 50%), hsl(${hue + 40}, 55%, 60%))`;
    return placeholder;
  }

  globalThis.TabCtrlShared = {
    DEFAULT: parse('Alt+S'),
    parse,
    columnsFor,
    revealItem,
    showPreviewIcon,
    showPreviewShot,
    letterPlaceholder,
    // Stored value: undefined means never synced (use the default), '' means unset.
    fromStorage(value) {
      return value === undefined ? parse('Alt+S') : parse(value);
    },
    matchesOpen,
    cycleDirection,
    isHoldHeld,
    isHoldKeyEvent,
    hint,
    applyTheme
  };
})();
