import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const PROJECTS_DIR = path.join(__dirname, 'projects');
const CLI = path.join(__dirname, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildComposition({ title, subtitle, duration, width, height, bgColor, textColor }) {
  const safeTitle = escapeHtml(title || 'ATL Video Editor');
  const safeSubtitle = escapeHtml(subtitle || 'Powered by HyperFrames');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"><\/script>
</head>
<body>
  <div id="root"
       data-composition-id="root"
       data-start="0"
       data-width="${width}"
       data-height="${height}"
       data-duration="${duration}"
       style="width:${width}px;height:${height}px;background:${bgColor};display:flex;flex-direction:column;justify-content:center;align-items:center;overflow:hidden;">
    <h1 id="title" class="clip"
        data-start="0" data-duration="${duration}" data-track-index="0"
        style="font-family:sans-serif;font-size:120px;color:${textColor};text-align:center;margin:0;padding:0 60px;">
      ${safeTitle}
    </h1>
    <p id="subtitle" class="clip"
       data-start="0.5" data-duration="${duration - 0.5}" data-track-index="1"
       style="font-family:sans-serif;font-size:48px;color:${textColor};text-align:center;margin:20px 0 0;padding:0 80px;">
      ${safeSubtitle}
    </p>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("#title", { opacity: 0, y: -60, scale: 0.9, duration: 1 }, 0);
    tl.from("#subtitle", { opacity: 0, y: 40, duration: 1 }, 0.6);
    tl.to("#title", { opacity: 0, y: -40, duration: 0.8 }, ${Math.max(0, duration - 1)});
    tl.to("#subtitle", { opacity: 0, y: 20, duration: 0.8 }, ${Math.max(0, duration - 0.8)});
    tl.set({}, {}, ${duration});
    window.__timelines = window.__timelines || {};
    window.__timelines["root"] = tl;
  <\/script>
</body>
</html>`;
}

app.post('/api/render', async (req, res) => {
  const {
    title = 'ATL Video Editor',
    subtitle = 'Powered by HyperFrames',
    duration = 5,
    width = 1920,
    height = 1080,
    fps = 30,
    quality = 'standard',
    bgColor = '#0f172a',
    textColor = '#ffffff'
  } = req.body;

  const dur = Math.max(1, Math.min(60, Number(duration) || 5));
  const w = Number(width) || 1920;
  const h = Number(height) || 1080;
  const f = Number(fps) || 30;

  const jobId = randomUUID();
  const projectDir = path.join(PROJECTS_DIR, jobId);
  await fs.mkdir(projectDir, { recursive: true });

  const html = buildComposition({ title, subtitle, duration: dur, width: w, height: h, bgColor, textColor });
  await fs.writeFile(path.join(projectDir, 'index.html'), html, 'utf-8');

  const outputName = 'output.mp4';
  const outputPath = path.join(projectDir, outputName);

  const args = ['render', '-o', outputName, '-f', String(f), '-q', quality];
  const child = spawn('node', [CLI, ...args], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data.toString(); });
  child.stderr.on('data', (data) => { stderr += data.toString(); });

  child.on('error', (err) => {
    console.error('Render spawn error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start render', detail: err.message });
    }
  });

  child.on('close', async (code) => {
    try {
      await fs.access(outputPath);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Render failed', detail: stderr || stdout });
      }
      return;
    }

    if (code === 0) {
      const stats = await fs.stat(outputPath);
      if (!res.headersSent) {
        res.json({
          jobId,
          outputUrl: `/api/outputs/${jobId}/${outputName}`,
          size: stats.size,
          duration: dur,
          width: w,
          height: h,
          fps: f,
          quality
        });
      }
    } else {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Render failed', detail: stderr || stdout });
      }
    }
  });
});

app.get('/api/outputs/:jobId/:fileName', async (req, res) => {
  const { jobId, fileName } = req.params;
  const filePath = path.join(PROJECTS_DIR, jobId, fileName);
  if (!filePath.startsWith(path.join(PROJECTS_DIR))) {
    return res.status(400).send('Invalid path');
  }
  try {
    await fs.access(filePath);
    res.setHeader('Content-Type', 'video/mp4');
    res.sendFile(path.resolve(filePath));
  } catch {
    res.status(404).send('Not found');
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

await fs.mkdir(PROJECTS_DIR, { recursive: true });
app.listen(PORT, () => {
  console.log(`ATL Video Editor server running at http://localhost:${PORT}`);
});
