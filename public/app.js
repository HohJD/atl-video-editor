const form = document.getElementById('editor');
const statusEl = document.getElementById('status');
const videoEl = document.getElementById('outputVideo');
const renderBtn = document.getElementById('renderBtn');
const fileInput = document.getElementById('fileInput');
const uploadArea = document.getElementById('uploadArea');
const browseBtn = document.getElementById('browseBtn');
const assetList = document.getElementById('assetList');
const aiEnabled = document.getElementById('aiEnabled');
const aiSettings = document.getElementById('aiSettings');
const aiProvider = document.getElementById('aiProvider');
const aiModel = document.getElementById('aiModel');
const aiApiKey = document.getElementById('aiApiKey');
const toggleKey = document.getElementById('toggleKey');
const promptEl = document.getElementById('prompt');
const templateEl = document.getElementById('template');
const downloadBtn = document.getElementById('downloadBtn');
const planBox = document.getElementById('planBox');
const aspectRatio = document.getElementById('aspectRatio');

let assets = [];

const MODELS = {
  anthropic: [
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' }
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' }
  ]
};

function populateModels() {
  const provider = aiProvider.value;
  aiModel.innerHTML = '';
  MODELS[provider].forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    aiModel.appendChild(opt);
  });
}

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
    <button type="button" class="remove" data-index="${index}">Remove</button>
  `;
  li.querySelector('button.remove').addEventListener('click', () => {
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

uploadArea.addEventListener('click', (e) => { if (e.target === uploadArea || e.target.closest('svg') || e.target.tagName === 'P') fileInput.click(); });
uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  uploadFiles(e.dataTransfer.files);
});

aiEnabled.addEventListener('change', () => {
  aiSettings.classList.toggle('hidden', !aiEnabled.checked);
  templateEl.disabled = aiEnabled.checked;
  templateEl.closest('label').style.opacity = aiEnabled.checked ? '0.5' : '1';
});

aiProvider.addEventListener('change', populateModels);

toggleKey.addEventListener('click', () => {
  const isPassword = aiApiKey.type === 'password';
  aiApiKey.type = isPassword ? 'text' : 'password';
  toggleKey.textContent = isPassword ? 'Hide' : 'Show';
});

aspectRatio.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  [...aspectRatio.children].forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('width').value = btn.dataset.w;
  document.getElementById('height').value = btn.dataset.h;
});

function getPayload() {
  return {
    template: templateEl.value,
    prompt: promptEl.value,
    title: document.getElementById('title').value,
    subtitle: document.getElementById('subtitle').value,
    duration: Number(document.getElementById('duration').value),
    fps: Number(document.getElementById('fps').value),
    quality: document.getElementById('quality').value,
    width: Number(document.getElementById('width').value),
    height: Number(document.getElementById('height').value),
    bgColor: document.getElementById('bgColor').value,
    textColor: document.getElementById('textColor').value,
    assets,
    ai: aiEnabled.checked ? {
      enabled: true,
      provider: aiProvider.value,
      model: aiModel.value,
      apiKey: aiApiKey.value.trim(),
      prompt: promptEl.value
    } : { enabled: false }
  };
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  renderBtn.disabled = true;
  renderBtn.textContent = 'Rendering…';
  videoEl.classList.add('hidden');
  downloadBtn.classList.add('hidden');
  planBox.classList.add('hidden');
  setStatus('Generating composition and rendering…', 'info');

  const payload = getPayload();

  if (payload.ai.enabled && !payload.ai.apiKey) {
    setStatus('Please enter an API key to use AI generation.', 'error');
    renderBtn.disabled = false;
    renderBtn.textContent = 'Render Video';
    return;
  }

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

    const data = await res.json();
    videoEl.src = data.outputUrl;
    videoEl.classList.remove('hidden');
    downloadBtn.href = data.outputUrl + '?download=1';
    downloadBtn.classList.remove('hidden');

    let msg = `Done — ${Math.round(data.size / 1024)} KB · template: ${data.template}`;
    if (data.plan) {
      msg += ` · AI chose ${data.plan.width}x${data.plan.height}`;
      planBox.textContent = 'AI plan:\n' + JSON.stringify(data.plan, null, 2);
      planBox.classList.remove('hidden');
    }
    setStatus(msg, 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    renderBtn.disabled = false;
    renderBtn.textContent = 'Render Video';
  }
});

populateModels();
