import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const PROJECTS_DIR = path.join(__dirname, 'projects');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CLI = path.join(__dirname, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-]/g, '-').replace(/-+/g, '-');
      cb(null, `${randomUUID().slice(0, 8)}-${safe}`);
    }
  }),
  limits: { fileSize: 1024 * 1024 * 1024 } // 1 GB per file
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function assetType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'].includes(ext)) return 'video';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac'].includes(ext)) return 'audio';
  return 'other';
}

function resolveTemplate(template, prompt, assets) {
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

const VALID_TEMPLATES = ['simple-title', 'product-intro', 'slideshow', 'social-clip'];
const VALID_QUALITY = ['draft', 'standard', 'high'];
const VALID_FPS = [24, 25, 30, 50, 60];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isHexColor(c) {
  return /^#([0-9A-Fa-f]{3}){1,2}$/.test(String(c));
}

function sanitizePlan(plan, defaults) {
  if (!plan || typeof plan !== 'object') return null;
  const out = { ...defaults };
  if (VALID_TEMPLATES.includes(plan.template)) out.template = plan.template;
  if (typeof plan.title === 'string') out.title = plan.title.slice(0, 120);
  if (typeof plan.subtitle === 'string') out.subtitle = plan.subtitle.slice(0, 240);
  if (typeof plan.duration === 'number') out.duration = clamp(Math.round(plan.duration), 1, 120);
  if (typeof plan.width === 'number') out.width = clamp(Math.round(plan.width), 64, 3840);
  if (typeof plan.height === 'number') out.height = clamp(Math.round(plan.height), 64, 3840);
  if (VALID_FPS.includes(plan.fps)) out.fps = plan.fps;
  if (VALID_QUALITY.includes(plan.quality)) out.quality = plan.quality;
  if (isHexColor(plan.bgColor)) out.bgColor = plan.bgColor;
  if (isHexColor(plan.textColor)) out.textColor = plan.textColor;
  return out;
}

function parseJSON(text) {
  const cleaned = String(text).trim().replace(/^```json\s*|\s*```$/g, '');
  return JSON.parse(cleaned);
}

function buildPlanPrompt({ prompt, assets, defaults }) {
  const counts = { video: 0, image: 0, audio: 0 };
  for (const a of assets) counts[a.type] = (counts[a.type] || 0) + 1;

  const system = `You are a video editor AI for HyperFrames, an HTML-to-MP4 renderer. Your job is to choose a template and style based on the user's uploaded assets and description. Available templates:
- simple-title: text only, no media
- product-intro: best with one background video + title/subtitle + optional music
- slideshow: best with multiple images + title/subtitle + optional music
- social-clip: best for vertical 9:16 short videos with a background video

Output ONLY a JSON object with these fields: template, title, subtitle, duration (seconds, integer, 1-120), width, height, fps (24/30/60), quality (draft/standard/high), bgColor (hex), textColor (hex). Do not include markdown or explanations. Ensure colors and dimensions fit the template (e.g., social-clip is 1080x1920, product-intro is 1920x1080).`;

  const user = `User request: "${prompt || 'create a video'}"
Available assets: ${counts.video} video(s), ${counts.image} image(s), ${counts.audio} audio file(s).
Current defaults: ${JSON.stringify({ title: defaults.title, subtitle: defaults.subtitle, duration: defaults.duration, width: defaults.width, height: defaults.height, fps: defaults.fps, quality: defaults.quality, bgColor: defaults.bgColor, textColor: defaults.textColor })}.`;

  return { system, user };
}

async function callAnthropic({ apiKey, model, system, user }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.content?.[0]?.text || '';
}

async function callOpenAI({ apiKey, model, system, user }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

async function generateScenePlan({ ai, assets, defaults }) {
  const provider = ai.provider || 'anthropic';
  const model = ai.model;
  const apiKey = ai.apiKey || (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY);
  if (!apiKey) throw new Error('No API key provided for AI generation');

  const { system, user } = buildPlanPrompt({ prompt: ai.prompt || defaults.prompt, assets, defaults });

  const raw = provider === 'openai'
    ? await callOpenAI({ apiKey, model, system, user })
    : await callAnthropic({ apiKey, model, system, user });

  const plan = parseJSON(raw);
  return sanitizePlan(plan, defaults);
}

function buildComposition({ title, subtitle, duration, width, height, bgColor, textColor, template, assets }) {
  const safeTitle = escapeHtml(title || 'ATL Video Editor');
  const safeSubtitle = escapeHtml(subtitle || 'Powered by HyperFrames');
  const videos = assets.filter(a => a.type === 'video');
  const images = assets.filter(a => a.type === 'image');
  const audios = assets.filter(a => a.type === 'audio');

  if (template === 'simple-title') return buildSimpleTitle({ safeTitle, safeSubtitle, duration, width, height, bgColor, textColor });
  if (template === 'slideshow') return buildSlideshow({ safeTitle, safeSubtitle, duration, width, height, bgColor, textColor, images, audios });
  if (template === 'social-clip') return buildSocialClip({ safeTitle, safeSubtitle, duration, width, height, bgColor, textColor, videos, audios });
  return buildProductIntro({ safeTitle, safeSubtitle, duration, width, height, bgColor, textColor, videos, audios });
}

function pageHead() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"><\/script>
</head>`;
}

function rootOpen({ width, height, bgColor, duration }) {
  return `<body>
  <div id="root"
       data-composition-id="root"
       data-start="0"
       data-width="${width}"
       data-height="${height}"
       data-duration="${duration}"
       style="width:${width}px;height:${height}px;background:${bgColor};position:relative;overflow:hidden;">`;
}

function textOverlay({ id, text, start, duration, width, height, textColor, fontSize, y, track }) {
  const yPos = y ?? (height * 0.45);
  return `    <h1 id="${id}" class="clip"
        data-start="${start}" data-duration="${duration}" data-track-index="${track}"
        style="position:absolute;left:0;top:${yPos}px;width:${width}px;text-align:center;font-family:sans-serif;font-size:${fontSize}px;color:${textColor};margin:0;padding:0 40px;text-shadow:0 2px 10px rgba(0,0,0,0.5);">
      ${escapeHtml(text)}
    </h1>`;
}

function buildSimpleTitle({ safeTitle, safeSubtitle, duration, width, height, bgColor, textColor }) {
  let html = pageHead();
  html += rootOpen({ width, height, bgColor, duration });
  html += textOverlay({ id: 'title', text: safeTitle, start: 0, duration, width, height, textColor, fontSize: Math.min(120, width / 10), y: height * 0.4, track: 0 });
  html += textOverlay({ id: 'subtitle', text: safeSubtitle, start: 0.6, duration: Math.max(0, duration - 0.6), width, height, textColor, fontSize: Math.min(48, width / 25), y: height * 0.55, track: 1 });
  html += `  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("#title", { opacity: 0, y: -60, scale: 0.9, duration: 1 }, 0);
    tl.from("#subtitle", { opacity: 0, y: 40, duration: 1 }, 0.6);
    tl.to("#title", { opacity: 0, y: -40, duration: 0.8 }, ${Math.max(0, duration - 1)});
    tl.to("#subtitle", { opacity: 0, y: 20, duration: 0.8 }, ${Math.max(0, duration - 0.8)});
    window.__timelines["root"] = tl;
  <\/script>`;
  html += `</body>
</html>`;
  return html;
}

function buildProductIntro({ safeTitle, safeSubtitle, duration, width, height, bgColor, textColor, videos, audios }) {
  let html = pageHead();
  html += rootOpen({ width, height, bgColor, duration });

  if (videos[0]) {
    html += `    <video id="bg-video" class="clip" src="assets/${videos[0].filename}" data-start="0" data-track-index="0"
      style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;" data-volume="0.4"><\/video>`;
  }

  html += textOverlay({ id: 'title', text: safeTitle, start: 0.3, duration: Math.max(0, duration - 0.6), width, height, textColor, fontSize: Math.min(width > height ? 120 : 140, width / 10), y: height * 0.38, track: 1 });
  html += textOverlay({ id: 'subtitle', text: safeSubtitle, start: 0.9, duration: Math.max(0, duration - 1.2), width, height, textColor, fontSize: Math.min(width > height ? 48 : 54, width / 22), y: height * 0.54, track: 2 });

  if (audios[0]) {
    html += `    <audio src="assets/${audios[0].filename}" data-start="0" data-track-index="99" data-volume="0.6"><\/audio>`;
  }

  html += `  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("#title", { opacity: 0, y: -50, scale: 0.95, duration: 1 }, 0.3);
    tl.from("#subtitle", { opacity: 0, y: 30, duration: 1 }, 0.9);
    tl.to("#title", { opacity: 0, y: -30, duration: 0.8 }, ${Math.max(0.3, duration - 1)});
    tl.to("#subtitle", { opacity: 0, y: 15, duration: 0.8 }, ${Math.max(0.9, duration - 0.8)});
    window.__timelines["root"] = tl;
  <\/script>`;
  html += `</body>
</html>`;
  return html;
}

function buildSocialClip({ safeTitle, safeSubtitle, duration, width, height, bgColor, textColor, videos, audios }) {
  let html = pageHead();
  html += rootOpen({ width, height, bgColor, duration });

  if (videos[0]) {
    html += `    <video id="bg-video" class="clip" src="assets/${videos[0].filename}" data-start="0" data-track-index="0"
      style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;" data-volume="0.6"><\/video>`;
  }

  html += textOverlay({ id: 'title', text: safeTitle, start: 0.2, duration: Math.max(0, duration - 0.4), width, height, textColor, fontSize: Math.min(width > height ? 96 : 130, width / 8), y: height * 0.35, track: 1 });
  html += textOverlay({ id: 'subtitle', text: safeSubtitle, start: 0.6, duration: Math.max(0, duration - 0.8), width, height, textColor, fontSize: Math.min(width > height ? 40 : 52, width / 16), y: height * 0.55, track: 2 });

  if (audios[0]) {
    html += `    <audio src="assets/${audios[0].filename}" data-start="0" data-track-index="99" data-volume="0.7"><\/audio>`;
  }

  html += `  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("#title", { opacity: 0, y: 80, scale: 1.1, duration: 0.8 }, 0.2);
    tl.from("#subtitle", { opacity: 0, y: 40, duration: 0.8 }, 0.6);
    tl.to("#title", { opacity: 0, y: -40, duration: 0.8 }, ${Math.max(0.2, duration - 1)});
    tl.to("#subtitle", { opacity: 0, y: 20, duration: 0.8 }, ${Math.max(0.6, duration - 0.8)});
    window.__timelines["root"] = tl;
  <\/script>`;
  html += `</body>
</html>`;
  return html;
}

function buildSlideshow({ safeTitle, safeSubtitle, duration, width, height, bgColor, textColor, images, audios }) {
  let html = pageHead();
  html += rootOpen({ width, height, bgColor, duration });

  if (images.length === 0) {
    return buildSimpleTitle({ safeTitle, safeSubtitle, duration, width, height, bgColor, textColor });
  }

  const slideDuration = duration / images.length;
  images.forEach((img, i) => {
    const start = i * slideDuration;
    html += `    <img id="slide-${i}" class="clip" src="assets/${img.filename}" data-start="${start}" data-duration="${slideDuration}" data-track-index="0"
      style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;background:${bgColor};"><\/img>`;
  });

  const titleDuration = Math.min(duration, 2.5);
  html += textOverlay({ id: 'title', text: safeTitle, start: 0, duration: titleDuration, width, height, textColor, fontSize: Math.min(width > height ? 80 : 96, width / 14), y: height * 0.08, track: 1 });
  html += textOverlay({ id: 'subtitle', text: safeSubtitle, start: 0.5, duration: Math.max(0, titleDuration - 0.5), width, height, textColor, fontSize: Math.min(width > height ? 32 : 40, width / 26), y: height * 0.26, track: 2 });

  if (audios[0]) {
    html += `    <audio src="assets/${audios[0].filename}" data-start="0" data-track-index="99" data-volume="0.5"><\/audio>`;
  }

  html += `  <script>
    const tl = gsap.timeline({ paused: true });
    ${images.map((_, i) => `tl.fromTo("#slide-${i}", { opacity: 0, scale: 1.05 }, { opacity: 1, scale: 1, duration: 0.5 }, ${i * slideDuration});
tl.to("#slide-${i}", { opacity: 0, duration: 0.4 }, ${(i + 1) * slideDuration - 0.4});`).join('\n    ')}
    tl.from("#title", { opacity: 0, y: -30, duration: 0.8 }, 0);
    tl.from("#subtitle", { opacity: 0, y: 20, duration: 0.8 }, 0.4);
    window.__timelines["root"] = tl;
  <\/script>`;
  html += `</body>
</html>`;
  return html;
}

app.post('/api/upload', upload.array('files'), (req, res) => {
  const files = req.files || [];
  const assets = files.map(f => ({
    id: f.filename,
    filename: f.filename,
    name: f.originalname,
    type: assetType(f.originalname),
    size: f.size,
    url: `/api/uploads/${encodeURIComponent(f.filename)}`
  }));
  res.json({ assets });
});

app.get('/api/uploads/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) return res.status(400).send('Invalid path');
  try {
    await fs.access(filePath);
    res.sendFile(path.resolve(filePath));
  } catch {
    res.status(404).send('Not found');
  }
});

app.post('/api/render', async (req, res) => {
  const payload = {
    title: 'ATL Video Editor',
    subtitle: 'Powered by HyperFrames',
    duration: 5,
    width: 1920,
    height: 1080,
    fps: 30,
    quality: 'standard',
    bgColor: '#0f172a',
    textColor: '#ffffff',
    template: 'auto',
    prompt: '',
    assets: [],
    ...req.body
  };

  payload.duration = clamp(Math.round(Number(payload.duration) || 5), 1, 120);
  payload.width = clamp(Math.round(Number(payload.width) || 1920), 64, 3840);
  payload.height = clamp(Math.round(Number(payload.height) || 1080), 64, 3840);
  payload.fps = VALID_FPS.includes(Number(payload.fps)) ? Number(payload.fps) : 30;
  payload.quality = VALID_QUALITY.includes(payload.quality) ? payload.quality : 'standard';

  // AI scene plan generation
  let plan = null;
  const ai = req.body.ai;
  if (ai?.enabled) {
    try {
      plan = await generateScenePlan({ ai, assets: payload.assets, defaults: payload });
      console.log('AI plan:', plan);
    } catch (err) {
      console.error('AI plan failed:', err);
      return res.status(500).json({ error: 'AI scene generation failed', detail: err.message });
    }
  }

  const selectedTemplate = plan?.template || resolveTemplate(payload.template, payload.prompt, payload.assets);

  // Adjust duration for slideshows so each slide gets at least 1.5s
  const images = payload.assets.filter(a => a.type === 'image');
  if (selectedTemplate === 'slideshow' && images.length > 0) {
    payload.duration = Math.max(payload.duration, images.length * 1.5);
  }

  const final = {
    ...payload,
    title: plan?.title ?? payload.title,
    subtitle: plan?.subtitle ?? payload.subtitle,
    duration: plan?.duration ?? payload.duration,
    width: plan?.width ?? payload.width,
    height: plan?.height ?? payload.height,
    fps: plan?.fps ?? payload.fps,
    quality: plan?.quality ?? payload.quality,
    bgColor: plan?.bgColor ?? payload.bgColor,
    textColor: plan?.textColor ?? payload.textColor,
    template: selectedTemplate
  };

  const jobId = randomUUID();
  const projectDir = path.join(PROJECTS_DIR, jobId);
  await fs.mkdir(projectDir, { recursive: true });

  if (final.assets.length) {
    const assetsDir = path.join(projectDir, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });
    for (const asset of final.assets) {
      const src = path.join(UPLOADS_DIR, path.basename(asset.filename || asset.id));
      const dst = path.join(assetsDir, path.basename(asset.filename || asset.id));
      try {
        await fs.access(src);
        await fs.copyFile(src, dst);
      } catch (err) {
        console.error('Missing asset', asset, err.message);
      }
    }
  }

  const html = buildComposition(final);
  await fs.writeFile(path.join(projectDir, 'index.html'), html, 'utf-8');

  const outputName = 'output.mp4';
  const outputPath = path.join(projectDir, outputName);

  const args = ['render', '-o', outputName, '-f', String(final.fps), '-q', final.quality];
  const child = spawn('node', [CLI, ...args], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data.toString(); });
  child.stderr.on('data', (data) => { stderr += data.toString(); });

  child.on('error', (err) => {
    console.error('Render spawn error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to start render', detail: err.message });
  });

  child.on('close', async (code) => {
    try {
      await fs.access(outputPath);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'Render failed', detail: stderr || stdout });
      return;
    }

    if (code === 0) {
      const stats = await fs.stat(outputPath);
      if (!res.headersSent) {
        res.json({
          jobId,
          outputUrl: `/api/outputs/${jobId}/${outputName}`,
          size: stats.size,
          duration: final.duration,
          width: final.width,
          height: final.height,
          fps: final.fps,
          quality: final.quality,
          template: selectedTemplate,
          plan
        });
      }
    } else {
      if (!res.headersSent) res.status(500).json({ error: 'Render failed', detail: stderr || stdout });
    }
  });
});

app.get('/api/outputs/:jobId/:fileName', async (req, res) => {
  const { jobId, fileName } = req.params;
  const filePath = path.join(PROJECTS_DIR, jobId, fileName);
  if (!filePath.startsWith(path.join(PROJECTS_DIR))) return res.status(400).send('Invalid path');
  try {
    await fs.access(filePath);
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.sendFile(path.resolve(filePath));
  } catch {
    res.status(404).send('Not found');
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

await fs.mkdir(PROJECTS_DIR, { recursive: true });
await fs.mkdir(UPLOADS_DIR, { recursive: true });
app.listen(PORT, () => {
  console.log(`ATL Video Editor server running at http://localhost:${PORT}`);
});
