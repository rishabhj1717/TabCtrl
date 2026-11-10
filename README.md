# TabCtrl

A Manifest V3 Chrome extension for visual MRU (Most Recently Used) tab navigation. Hold Alt and tap S to move through recent tabs, then release Alt to switch. The overlay works like macOS Cmd+Tab or Arc's tab switcher. You can find it on chrome webstore or it shall open as soon as you click this link - https://chromewebstore.google.com/detail/tabctrl/dedipklofclnllandojfbocifjpeikif

## Features

- **MRU tab list**: Shows the tabs you used most recently in the current window. The default is 5, and you can raise it to 10.
- **Hold-Alt navigation**: Alt+S opens the switcher on the previous tab. Keep Alt held, tap S to move forward, and Shift+S to move backward.
- **Release to switch**: Letting go of Alt opens the highlighted tab. Enter and a click do the same.
- **Skip without switching**: Esc closes the panel and leaves you on the current tab.
- **Previews**: Each card shows a small screenshot taken the last time that tab was on screen, plus the page title and favicon.
- **Arrow keys**: Left/Up moves backward. Right/Down moves forward.
- **Current window only**: Tabs from other windows are not listed.
- **Dark mode**: The panel follows the system color scheme.

## Installation

### Load unpacked

1. Clone or download this repository.
2. Open `chrome://extensions/`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the `TabCtrl` directory.
5. After code changes, click the refresh icon on the TabCtrl card, then reload any open web page so the content script updates.

### Chrome Web Store

Not published yet. To submit a package, zip the runtime files with `manifest.json` at the root of the archive:

- `manifest.json`
- `background.js`
- `content.js`
- `content.css`
- `options.html`
- `options.js`
- `icons/`

Do not include this README, other notes, or `.git`. The store listing needs a privacy-policy URL because the extension reads tab titles, URLs, favicons, and page screenshots. That data stays in the browser.

## Usage

1. Press **Alt+S** on a normal web page. The switcher opens with the previous tab highlighted.
2. Keep **Alt** held.
   - **S** moves forward.
   - **Shift+S** moves backward.
   - Arrow keys move as well.
3. Release **Alt** to open the highlighted tab. **Enter** or a click also switches.
4. Press **Esc** to close the panel without switching.

One press of S or Shift+S moves exactly one card. The tab you are already on stays at the front of the list, so the first highlight is the previous tab.

### How many tabs to show

Click the TabCtrl icon in the toolbar and choose **5 tabs** or **10 tabs**. The choice is saved in `chrome.storage.local`. Extra slots fill as you visit more tabs. Dropping back to 5 removes the oldest entries past that limit.

You can change the same setting from the extension's options page.

## How it works

```
TabCtrl/
├── manifest.json    # Manifest V3, Alt+S command, toolbar popup
├── background.js    # MRU list, previews, favicons, tab switching
├── content.js       # Overlay, keyboard handling
├── content.css      # Overlay styles, inlined into the shadow root
├── options.html     # 5 or 10 tab setting
├── options.js
└── icons/
```

### Background service worker

- Records tab activations and persists the MRU list in `chrome.storage.local`.
- Drops ids when a tab closes, and drops ids that no longer exist when the list is loaded.
- Puts the tab you are on at the front of the list each time the switcher opens.
- Reads `content.css` and sends the text to the page. The page never loads a `chrome-extension://` stylesheet.
- Fetches favicons in the service worker and sends them as data URLs, so the page does not request another site's icon.
- Photographs the visible tab with `captureVisibleTab`, shrinks it to a JPEG, and keeps it in `chrome.storage.session` for the browser session.

### Content script

- Runs only in the top frame, not inside iframes.
- Builds the panel in a shadow root and styles the host element directly.
- Listens for Alt+S, Shift+S, arrows, Enter, and Esc.
- Treats the browser command and the key event as one press, so the highlight moves one card per tap.
- On Alt release, switches to the card that is actually highlighted.

### Styling

- The overlay uses the maximum z-index so it sits above the page.
- Shadow DOM keeps page CSS from restyling the panel.
- The card row scrolls horizontally when 10 tabs do not fit.

## Known limitations

The overlay cannot run on Chrome's own pages. Alt+S does nothing on:

- `chrome://` pages, including `chrome://extensions`
- `chrome-extension://` pages
- the Chrome Web Store
- `about:`, `data:`, and `file://` pages

Chrome can only screenshot the tab that is visible. A card shows a letter placeholder until you have opened that tab once with the extension loaded. Previews from the current browser session are kept; they are cleared when the browser quits. The MRU list itself is saved across restarts, and closed tabs are removed from it.

## Development

1. Edit the source files.
2. On `chrome://extensions/`, refresh TabCtrl.
3. Reload the web page you are testing. An old content script stays in the page until you do.

**Service worker logs:** on `chrome://extensions/`, open **Inspect views: service worker**.

**Page logs:** open DevTools on the page and filter the console for TabCtrl.

**MRU contents:** in the service worker console, inspect `mruTabIds` after the worker has woken up by opening the switcher once.

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Test on a normal web page, including Alt+S, Shift+S, Alt release, and Esc.
4. Open a pull request that explains the change.

## License

MIT License - see LICENSE file for details

## Credits

Inspired by the macOS Cmd+Tab switcher, Arc's tab switcher, and Chrome's built-in tab management.
