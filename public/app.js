const form = document.getElementById('editor');
const statusEl = document.getElementById('status');
const videoEl = document.getElementById('outputVideo');
const renderBtn = document.getElementById('renderBtn');
const fileInput = document.getElementById('fileInput');
const uploadArea = document.getElementById('uploadArea');
const browseBtn = document.getElementById('browseBtn');
const assetList = document.getElementById('assetList');

let assets = [];

function setStatus(text, type = 'info') {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove('hidden');
}

function renderAssetItem(asset, index) {
  const li = document.createElement('li');
  li.innerHTML = `
    <span class="asset-type">${asset.type}</span>
    <span class="asset-name">${escapeHtml(asset.name)}</span>
    <button type="button" data-index="${index}">Remove</button>
  `;
  li.querySelector('button').addEventListener('click', () => {
    assets.splice(index, 1);
    renderAssetList();
  });
  return li;
}

function renderAssetList() {
  assetList.innerHTML = '';
  assets.forEach((asset, i) => assetList.appendChild(renderAssetItem(asset, i)));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function uploadFiles(files) {
  if (!files.length) return;
  setStatus('Uploading…', 'info');
  const formData = new FormData();
  for (const file of files) formData.append('files', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) throw new Error('Upload failed');
    const { assets: uploaded } = await res.json();
    assets = assets.concat(uploaded);
    renderAssetList();
    setStatus(`${assets.length} asset(s) ready`, 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => uploadFiles(e.target.files));

uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  uploadFiles(e.dataTransfer.files);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  renderBtn.disabled = true;
  renderBtn.textContent = 'Rendering…';
  videoEl.classList.add('hidden');
  setStatus('Generating composition and rendering…', 'info');

  const payload = {
    template: document.getElementById('template').value,
    prompt: document.getElementById('prompt').value,
    title: document.getElementById('title').value,
    subtitle: document.getElementById('subtitle').value,
    duration: Number(document.getElementById('duration').value),
    fps: Number(document.getElementById('fps').value),
    quality: document.getElementById('quality').value,
    width: Number(document.getElementById('width').value),
    height: Number(document.getElementById('height').value),
    bgColor: document.getElementById('bgColor').value,
    textColor: document.getElementById('textColor').value,
    assets
  };

  try {
    const res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Render failed (${res.status})`);
    }

    const { outputUrl, size, template } = await res.json();
    videoEl.src = outputUrl;
    videoEl.classList.remove('hidden');
    const kb = Math.round(size / 1024);
    setStatus(`Done — ${kb} KB · template: ${template}`, 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    renderBtn.disabled = false;
    renderBtn.textContent = 'Render Video';
  }
});
