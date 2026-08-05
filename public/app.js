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

let assets = [];
let selectedTemplate = 'auto';
let currentOutput = null;

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

function showGenerating(show) {
  generating.classList.toggle('hidden', !show);
  generateBtn.disabled = show;
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

function renderMedia() {
  mediaList.innerHTML = '';
  assets.forEach((asset, i) => {
    const el = document.createElement('div');
    el.className = 'media-item';
    el.setAttribute('data-type', asset.type);

    let thumb = `<div class="thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:0.7rem;">${asset.type}</div>`;
    if (asset.type === 'image') {
      thumb = `<img class="thumb" src="${asset.url}" alt="">`;
    } else if (asset.type === 'video') {
      thumb = `<video class="thumb" src="${asset.url}" muted></video>`;
    }

    el.innerHTML = `
      <span class="tag">${asset.type}</span>
      <button class="remove" data-index="${i}">X</button>
      ${thumb}
      <div class="name">${escapeHtml(asset.name)}</div>
    `;
    el.querySelector('button.remove').addEventListener('click', () => {
      assets.splice(i, 1);
      renderMedia();
      renderTimeline();
    });
    mediaList.appendChild(el);
  });
}

async function uploadFiles(files) {
  if (!files.length) return;
  const formData = new FormData();
  for (const f of files) formData.append('files', f);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) throw new Error('Upload failed');
    const { assets: uploaded } = await res.json();
    assets = assets.concat(uploaded);
    renderMedia();
    renderTimeline();
  } catch (err) {
    alert(err.message);
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

templateCards.forEach(card => {
  card.addEventListener('click', () => {
    templateCards.forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    selectedTemplate = card.dataset.template;
    renderTimeline();
  });
});

aiEnabled.addEventListener('change', () => aiSettings.classList.toggle('hidden', !aiEnabled.checked));
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
  document.getElementById('width').value = btn.dataset.w;
  document.getElementById('height').value = btn.dataset.h;
  updatePreviewAspect(btn.dataset.w, btn.dataset.h);
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

  const template = selectedTemplate;
  const videos = assets.filter(a => a.type === 'video');
  const images = assets.filter(a => a.type === 'image');
  const audios = assets.filter(a => a.type === 'audio');

  const makeClip = (lane, cls, start, dur, label) => {
    const left = (start / duration) * 100;
    const width = (dur / duration) * 100;
    const el = document.createElement('div');
    el.className = `clip ${cls}`;
    el.style.left = left + '%';
    el.style.width = width + '%';
    el.textContent = label;
    lane.appendChild(el);
  };

  // Text overlay spans full duration
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

async function generate() {
  if (aiEnabled.checked && !aiApiKey.value.trim()) {
    alert('Please enter an API key to use AI generation.');
    return;
  }

  showGenerating(true);
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
      document.getElementById('width').value = data.plan.width;
      document.getElementById('height').value = data.plan.height;
      document.getElementById('duration').value = data.plan.duration;
      updatePreviewAspect(data.plan.width, data.plan.height);
    }
    renderTimeline();
  } catch (err) {
    alert(err.message);
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
});

outputVideo.addEventListener('timeupdate', () => {
  if (outputVideo.duration) {
    const pct = (outputVideo.currentTime / outputVideo.duration) * 100;
    playhead.style.left = pct + '%';
  }
});

populateModels();
updatePreviewAspect(1920, 1080);
renderTimeline();
