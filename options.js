const choices = document.querySelectorAll('input[name="maxMruSize"]');
const colorChoices = document.querySelectorAll('input[name="panelColor"]');
const colorPicker = document.getElementById('panel-color-picker');
const shortcutLabel = document.getElementById('shortcut');

chrome.storage.local.get(['maxMruSize', 'panelColor'], (result) => {
  const size = result.maxMruSize === 10 ? '10' : '5';
  for (const choice of choices) {
    choice.checked = choice.value === size;
  }

  const custom = typeof result.panelColor === 'string' && result.panelColor.startsWith('#');
  if (custom) colorPicker.value = result.panelColor;
  for (const choice of colorChoices) {
    choice.checked = choice.value === (custom ? 'custom' : 'auto');
  }
});

for (const choice of choices) {
  choice.addEventListener('change', () => {
    if (!choice.checked) return;
    chrome.storage.local.set({
      maxMruSize: choice.value === '10' ? 10 : 5
    });
  });
}

function savePanelColor() {
  const custom = document.querySelector('input[name="panelColor"][value="custom"]').checked;
  chrome.storage.local.set({ panelColor: custom ? colorPicker.value : 'auto' });
}

for (const choice of colorChoices) {
  choice.addEventListener('change', savePanelColor);
}

colorPicker.addEventListener('input', () => {
  document.querySelector('input[name="panelColor"][value="custom"]').checked = true;
  savePanelColor();
});

async function showShortcut() {
  const commands = await chrome.commands.getAll();
  const command = commands.find((item) => item.name === 'toggle-tab-switcher');
  const shortcut = command?.shortcut || '';
  shortcutLabel.textContent = shortcut || 'Not set';
  // Keep the in-page switcher in step even if the background has not re-read it yet.
  chrome.storage.local.set({ hotkey: shortcut });
}

showShortcut();
window.addEventListener('focus', showShortcut);

document.getElementById('change-shortcut').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
