const form = document.getElementById('editor');
const statusEl = document.getElementById('status');
const videoEl = document.getElementById('outputVideo');
const renderBtn = document.getElementById('renderBtn');

function setStatus(text, type = 'info') {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove('hidden');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  renderBtn.disabled = true;
  renderBtn.textContent = 'Rendering…';
  videoEl.classList.add('hidden');
  setStatus('Rendering video, this may take a few seconds…', 'info');

  const payload = {
    title: document.getElementById('title').value,
    subtitle: document.getElementById('subtitle').value,
    duration: Number(document.getElementById('duration').value),
    fps: Number(document.getElementById('fps').value),
    quality: document.getElementById('quality').value,
    width: Number(document.getElementById('width').value),
    height: Number(document.getElementById('height').value),
    bgColor: document.getElementById('bgColor').value,
    textColor: document.getElementById('textColor').value
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

    const { outputUrl, size } = await res.json();
    videoEl.src = outputUrl;
    videoEl.classList.remove('hidden');
    const kb = Math.round(size / 1024);
    setStatus(`Done — ${kb} KB`, 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    renderBtn.disabled = false;
    renderBtn.textContent = 'Render Video';
  }
});
