#!/usr/bin/env node
// MCP server for ATL Video Editor.
// Lets Claude Code (or any MCP client) drive the editor through the same op
// layer the UI and built-in agent use. Proxies to the running app's HTTP API,
// so every edit shows up live in the editor window.
//
// Register once:  claude mcp add atl-video -- node /path/to/mcp-server.mjs
// The ATL Video Editor app (or `npm run dev`) must be running.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions } from './server/edl.mjs';

const CANDIDATE_URLS = [
  process.env.ATL_URL,
  'http://localhost:3000',   // npm run dev
  'http://localhost:34197'   // packaged Electron app
].filter(Boolean);

let baseUrl = null;

async function resolveBaseUrl() {
  if (baseUrl) {
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return baseUrl;
    } catch { baseUrl = null; }
  }
  for (const url of CANDIDATE_URLS) {
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { baseUrl = url; return url; }
    } catch { /* try next */ }
  }
  throw new Error('ATL Video Editor is not running. Launch the app (or `npm run dev` in the project) and try again.');
}

async function api(method, route, body) {
  const url = await resolveBaseUrl();
  const res = await fetch(`${url}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.detail || json.error || `${route} failed (${res.status})`);
  return json;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForAsset(assetId, timeoutMs = 180000) {
  const start = Date.now();
  for (;;) {
    const { assets } = await api('GET', '/api/assets');
    const asset = assets.find(a => a.id === assetId);
    if (!asset) throw new Error(`Asset ${assetId} disappeared`);
    if (asset.status === 'ready') return asset;
    if (asset.status === 'error') throw new Error(`Analysis failed for ${assetId}`);
    if (Date.now() - start > timeoutMs) return asset; // still analyzing; return as-is
    await sleep(1000);
  }
}

function describeAsset(a) {
  const an = a.analysis;
  if (!an) return `${a.id} ("${a.name}"): ${a.status}`;
  const bits = [`${a.type}`, `${an.meta.duration}s`];
  if (an.meta.width) bits.push(`${an.meta.width}x${an.meta.height}`);
  if (an.scenes?.length) bits.push(`scene cuts at [${an.scenes.join(', ')}]`);
  if (an.bpm) bits.push(`${an.bpm} BPM`);
  if (an.hasTranscript) bits.push('speech transcript available');
  if (an.highlight) bits.push(`suggested highlight ${an.highlight.start}-${an.highlight.end}s`);
  return `${a.id} ("${a.name}"): ${bits.join(', ')}`;
}

// --- extra (non-op) tools ----------------------------------------------------

const EXTRA_TOOLS = [
  {
    name: 'getProject',
    description: 'Get the current state of the editor: imported assets (with their analysis: scenes, BPM, transcript availability, highlights) and the timeline. Call this first.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async run() {
      const d = await api('GET', '/api/describe');
      return `ASSETS:\n${d.assets}\n\nTIMELINE:\n${d.timeline}`;
    }
  },
  {
    name: 'importFile',
    description: 'Import a media file from this machine into the editor by absolute path. Waits for automatic analysis (scenes, beats, transcription) to finish and returns the results.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to a video/image/audio file' } },
      required: ['path']
    },
    async run(input) {
      const { asset } = await api('POST', '/api/import-path', { path: input.path });
      const ready = await waitForAsset(asset.id);
      return `Imported. ${describeAsset(ready)}${ready.status !== 'ready' ? ' (analysis still running — beats/transcript may not be available yet)' : ''}`;
    }
  },
  {
    name: 'autoCaptions',
    description: 'Generate captions on C1 from the speech transcript of the clips on V1, synced to the timeline. style: bold | serif | karaoke.',
    inputSchema: {
      type: 'object',
      properties: { style: { type: 'string', enum: ['bold', 'serif', 'karaoke'] } },
      required: []
    },
    async run(input) {
      const r = await api('POST', '/api/tools/autoCaptions', input);
      return r.summary;
    }
  },
  {
    name: 'cutOnBeats',
    description: 'Split the clips on a track at the beats of the music (precomputed beat grid from A1, falling back to V1 audio). every=2 cuts every 2nd beat.',
    inputSchema: {
      type: 'object',
      properties: {
        trackId: { type: 'string', description: 'default V1' },
        every: { type: 'number', description: 'cut every Nth beat (default 2)' },
        minGap: { type: 'number', description: 'min seconds between cuts (default 0.5)' }
      },
      required: []
    },
    async run(input) {
      const r = await api('POST', '/api/tools/cutOnBeats', input);
      return r.summary;
    }
  },
  {
    name: 'getTranscript',
    description: 'Read the speech transcript of an asset with timestamped cues (media time). Use to find quotes/moments before trimming.',
    inputSchema: {
      type: 'object',
      properties: { assetId: { type: 'string' } },
      required: ['assetId']
    },
    async run(input) {
      const r = await api('POST', '/api/tools/getTranscript', input);
      return JSON.stringify(r.info);
    }
  },
  {
    name: 'undo',
    description: 'Undo the last edit.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async run() {
      const r = await api('POST', '/api/undo');
      return `Undone. Timeline is now ${r.duration}s (history position ${r.cursor}).`;
    }
  },
  {
    name: 'redo',
    description: 'Redo the last undone edit.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async run() {
      const r = await api('POST', '/api/redo');
      return `Redone. Timeline is now ${r.duration}s (history position ${r.cursor}).`;
    }
  },
  {
    name: 'exportVideo',
    description: 'Render the timeline to an MP4 file. Blocks until the render finishes (can take a few minutes). Returns the output file path.',
    inputSchema: {
      type: 'object',
      properties: { quality: { type: 'string', enum: ['draft', 'standard', 'high'], description: 'default standard' } },
      required: []
    },
    async run(input) {
      const { jobId } = await api('POST', '/api/export', { quality: input.quality || 'standard' });
      const start = Date.now();
      for (;;) {
        await sleep(1500);
        const job = await api('GET', `/api/jobs/${jobId}`);
        if (job.status === 'done') {
          return `Export complete: ${job.result.outputPath} (${Math.round(job.result.size / 1024)} KB, ${job.result.duration}s, ${job.result.width}x${job.result.height})`;
        }
        if (job.status === 'error') throw new Error(job.error || 'Export failed');
        if (job.status === 'cancelled') throw new Error('Export was cancelled');
        if (Date.now() - start > 15 * 60 * 1000) throw new Error('Export timed out after 15 minutes');
      }
    }
  }
];

// --- MCP wiring ---------------------------------------------------------------

const OP_PREAMBLE = 'Timeline edit op. Tracks: V1 video/images, O1+O2 text overlays, C1 captions, A1 audio. ';

const server = new Server(
  { name: 'atl-video-editor', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...EXTRA_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ...toolDefinitions()
      .filter(t => !['addCaptions'].includes(t.name)) // autoCaptions supersedes hand-written captions over MCP
      .map(t => ({ name: t.name, description: OP_PREAMBLE + t.description, inputSchema: t.input_schema }))
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  try {
    const extra = EXTRA_TOOLS.find(t => t.name === name);
    let text;
    if (extra) {
      text = await extra.run(args);
    } else {
      const r = await api('POST', '/api/ops', { op: name, params: args });
      text = `${r.summary}. Timeline is now ${r.duration}s.`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[atl-video-editor] MCP server ready (stdio)');
