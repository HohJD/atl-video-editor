const fileInput = document.getElementById('fileInput');
const uploadArea = document.getElementById('uploadArea');
const mediaList = document.getElementById('mediaList');
const generateBtn = document.getElementById('generateBtn');
const exportBtn = document.getElementById('exportBtn');
const outputVideo = document.getElementById('outputVideo');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const generating = document.getElementById('generating');
const aiEnabled = document.getElementById('aiEnabled');
const aiSettings = document.getElementById('aiSettings');
const aiProvider = document.getElementById('aiProvider');
const aiModel = document.getElementById('aiModel');
const aiApiKey = document.getElementById('aiApiKey');
const toggleKey = document.getElementById('toggleKey');
const promptEl = document.getElementById('prompt');
const templateCards = document.querySelectorAll('.template-card');
const aspectPicker = document.getElementById('aspectPicker');
const playhead = document.getElementById('playhead');
const timelineDuration = document.getElementById('timelineDuration');
const toastEl = document.getElementById('toast');

let assets = [];
let selectedTemplate = 'auto';
let currentOutput = null;
let statusTimeout;

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

const TEMPLATE_DEFAULTS = {
  'simple-title': { w: 1920, h: 1080 },
  'product-intro': { w: 1920, h: 1080 },
  'slideshow': { w: 1920, h: 1080 },
  'social-clip': { w: 1080, h: 1920 }
};

function showToast(text, type = 'info', duration = 4000) {
  clearTimeout(statusTimeout);
  toastEl.textContent = text;
  toastEl.className = `toast show ${type}`;
  statusTimeout = setTimeout(() => toastEl.classList.remove('show'), duration);
}

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

function showGenerating(show) {
  generating.classList.toggle('hidden', !show);
  generateBtn.disabled = show;
  generateBtn.textContent = show ? 'Generating…' : 'Generate';
}

function setOutput(url) {
  currentOutput = url;
  outputVideo.src = url;
  outputVideo.classList.remove('hidden');
  previewPlaceholder.classList.add('hidden');
  exportBtn.disabled = !url;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getStyleValues() {
  return {
    title: document.getElementById('title').value,
    subtitle: document.getElementById('subtitle').value,
    duration: Number(document.getElementById('duration').value),
    width: Number(document.getElementById('width').value),
    height: Number(document.getElementById('height').value),
    fps: Number(document.getElementById('fps').value),
    quality: document.getElementById('quality').value,
    bgColor: document.getElementById('bgColor').value,
    textColor: document.getElementById('textColor').value
  };
}

function updatePreviewAspect(w, h) {
  const wrap = document.getElementById('previewWrap');
  wrap.style.aspectRatio = `${w} / ${h}`;
}

function setDimensions(w, h) {
  document.getElementById('width').value = w;
  document.getElementById('height').value = h;
  updatePreviewAspect(w, h);
}

function setActiveAspectButton(w, h) {
  aspectPicker.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  const match = [...aspectPicker.querySelectorAll('button')].find(b => b.dataset.w === String(w) && b.dataset.h === String(h));
  if (match) match.classList.add('active');
}

function renderMedia() {
  mediaList.innerHTML = '';
  assets.forEach((asset, i) => {
    const el = document.createElement('div');
    el.className = 'media-item';
    el.setAttribute('data-type', asset.type);

    let thumb = `<div class="thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:0.7rem;text-transform:uppercase;">${asset.type}</div>`;
    if (asset.type === 'image') {
      thumb = `<img class="thumb" src="${asset.url}" alt="">`;
    } else if (asset.type === 'video') {
      thumb = `<video class="thumb" src="${asset.url}" muted></video>`;
    }

    el.innerHTML = `
      <span class="tag">${asset.type}</span>
      <button class="remove" data-index="${i}" title="Remove">×</button>
      ${thumb}
      <div class="name">${escapeHtml(asset.name)}</div>
    `;
    el.querySelector('button.remove').addEventListener('click', () => {
      assets.splice(i, 1);
      renderMedia();
      renderTimeline();
      showToast('Asset removed', 'info');
    });
    mediaList.appendChild(el);
  });
}

async function uploadFiles(files) {
  if (!files.length) return;
  showToast('Uploading…', 'info', 10000);
  const formData = new FormData();
  for (const f of files) formData.append('files', f);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) throw new Error('Upload failed');
    const { assets: uploaded } = await res.json();
    assets = assets.concat(uploaded);
    renderMedia();
    renderTimeline();
    showToast(`${assets.length} asset(s) imported`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

uploadArea.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => uploadFiles(e.target.files));
uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  uploadFiles(e.dataTransfer.files);
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab + 'Tab').classList.add('active');
  });
});

function resolveTemplateUI(template, prompt, assets) {
  if (template && template !== 'auto') return template;
  const p = (prompt || '').toLowerCase();
  const hasVideo = assets.some(a => a.type === 'video');
  const hasImage = assets.some(a => a.type === 'image');
  if (hasImage && p.includes('slideshow')) return 'slideshow';
  if (hasVideo && (p.includes('social') || p.includes('tiktok') || p.includes('reels') || p.includes('vertical') || p.includes('story'))) return 'social-clip';
  if (hasVideo && (p.includes('intro') || p.includes('promo') || p.includes('trailer'))) return 'product-intro';
  if (hasVideo) return 'product-intro';
  if (hasImage) return 'slideshow';
  return 'simple-title';
}

function applyTemplateDefaults(template) {
  const defs = TEMPLATE_DEFAULTS[template];
  if (defs) {
    setDimensions(defs.w, defs.h);
    setActiveAspectButton(defs.w, defs.h);
  }
}

templateCards.forEach(card => {
  card.addEventListener('click', () => {
    templateCards.forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    selectedTemplate = card.dataset.template;
    if (selectedTemplate !== 'auto') applyTemplateDefaults(selectedTemplate);
    renderTimeline();
    showToast(`${card.querySelector('strong').textContent} template selected`, 'info');
  });
});

aiEnabled.addEventListener('change', () => {
  aiSettings.classList.toggle('hidden', !aiEnabled.checked);
  showToast(aiEnabled.checked ? 'AI Director enabled' : 'AI Director disabled', 'info');
});
aiProvider.addEventListener('change', populateModels);

toggleKey.addEventListener('click', () => {
  const isPassword = aiApiKey.type === 'password';
  aiApiKey.type = isPassword ? 'text' : 'password';
  toggleKey.textContent = isPassword ? 'Hide' : 'Show';
});

aspectPicker.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  aspectPicker.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  setDimensions(btn.dataset.w, btn.dataset.h);
});

['width', 'height'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    const w = document.getElementById('width').value;
    const h = document.getElementById('height').value;
    updatePreviewAspect(w, h);
    aspectPicker.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  });
});

function renderTimeline() {
  const duration = Number(document.getElementById('duration').value) || 5;
  timelineDuration.textContent = duration.toFixed(1) + 's';

  const textLane = document.getElementById('textLane');
  const videoLane = document.getElementById('videoLane');
  const audioLane = document.getElementById('audioLane');
  textLane.innerHTML = '';
  videoLane.innerHTML = '';
  audioLane.innerHTML = '';

  const template = resolveTemplateUI(selectedTemplate, promptEl.value, assets);
  const videos = assets.filter(a => a.type === 'video');
  const images = assets.filter(a => a.type === 'image');
  const audios = assets.filter(a => a.type === 'audio');

  const makeClip = (lane, cls, start, dur, label) => {
    const left = (start / duration) * 100;
    const width = (dur / duration) * 100;
    const el = document.createElement('div');
    el.className = `clip ${cls}`;
    el.style.left = left + '%';
    el.style.width = Math.max(width, 0) + '%';
    el.textContent = label;
    lane.appendChild(el);
  };

  makeClip(textLane, 'text', 0, duration, getStyleValues().title);

  if (template === 'slideshow' && images.length) {
    const per = duration / images.length;
    images.forEach((img, i) => makeClip(videoLane, 'image', i * per, per, img.name));
  } else if (videos.length) {
    makeClip(videoLane, 'video', 0, duration, videos[0].name);
  }

  if (audios.length) {
    makeClip(audioLane, 'audio', 0, duration, audios[0].name);
  }
}

['title', 'subtitle', 'duration', 'width', 'height', 'fps', 'quality', 'bgColor', 'textColor'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderTimeline);
});
promptEl.addEventListener('input', renderTimeline);

async function generate() {
  if (aiEnabled.checked && !aiApiKey.value.trim()) {
    showToast('Please enter an API key to use AI generation.', 'error');
    return;
  }

  const resolved = resolveTemplateUI(selectedTemplate, promptEl.value, assets);
  if (!assets.length && resolved !== 'simple-title') {
    showToast('Import at least one media file, or choose the Title / Auto template.', 'error');
    return;
  }

  showGenerating(true);
  showToast('Building composition…', 'info', 120000);
  const style = getStyleValues();

  const payload = {
    ...style,
    template: selectedTemplate,
    prompt: promptEl.value,
    assets,
    ai: aiEnabled.checked ? {
      enabled: true,
      provider: aiProvider.value,
      model: aiModel.value,
      apiKey: aiApiKey.value.trim(),
      prompt: promptEl.value
    } : { enabled: false }
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

    const data = await res.json();
    setOutput(data.outputUrl);
    if (data.plan) {
      setDimensions(data.plan.width, data.plan.height);
      document.getElementById('duration').value = data.plan.duration;
      if (data.plan.template && data.plan.template !== 'auto') {
        selectedTemplate = data.plan.template;
        templateCards.forEach(c => c.classList.toggle('active', c.dataset.template === selectedTemplate));
      }
    }
    renderTimeline();
    showToast(`Done — ${Math.round(data.size / 1024)} KB · ${data.template}`, 'success');
  } catch (err) {
    showToast(err.message, 'error', 8000);
  } finally {
    showGenerating(false);
  }
}

generateBtn.addEventListener('click', generate);

exportBtn.addEventListener('click', () => {
  if (!currentOutput) return;
  const a = document.createElement('a');
  a.href = currentOutput + '?download=1';
  a.download = 'atl-video.mp4';
  a.click();
  showToast('MP4 download started', 'success');
});

outputVideo.addEventListener('timeupdate', () => {
  if (outputVideo.duration) {
    const pct = (outputVideo.currentTime / outputVideo.duration) * 100;
    playhead.style.left = pct + '%';
  }
});

outputVideo.addEventListener('loadedmetadata', () => {
  playhead.style.left = '0%';
});

populateModels();
setDimensions(1920, 1080);
setActiveAspectButton(1920, 1080);
renderTimeline();
showToast('Ready — import media and click Generate', 'info');
