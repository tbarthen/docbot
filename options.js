// DocBot options page

const fields = ['recordInputValues', 'enableAutoFill', 'useRealisticData'];
const defaults = { recordInputValues: false, enableAutoFill: false, useRealisticData: true };

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get(fields);
  for (const id of fields) {
    const box = document.getElementById(id);
    box.checked = stored[id] === undefined ? defaults[id] : stored[id] === true;
    box.addEventListener('change', save);
  }
});

async function save() {
  const values = {};
  for (const id of fields) values[id] = document.getElementById(id).checked;
  await chrome.storage.local.set(values);
  const saved = document.getElementById('saved');
  saved.textContent = 'Saved';
  setTimeout(() => { saved.textContent = ''; }, 1500);
}
