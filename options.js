const choices = document.querySelectorAll('input[name="maxMruSize"]');

chrome.storage.local.get(['maxMruSize'], (result) => {
  const size = result.maxMruSize === 10 ? '10' : '5';
  for (const choice of choices) {
    choice.checked = choice.value === size;
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
