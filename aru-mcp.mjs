import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

const H = process.env.HOME + '/aru-host/';
const WEB = H + 'web';
const key = fs.readFileSync(H + 'ip-key.pem');
const cert = fs.readFileSync(H + 'ip-cert.pem');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
};

let state = { current: null, playing: false, pos: 0, dur: 0, msgs: [] };
let queue = [];

function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  const m = Math.floor(t / 60), s = t % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function apiGet(p) {
  return new Promise(res => {
    const r = http.request({ hostname: '127.0.0.1', port: 3000, path: p, method: 'GET' }, resp => {
      let b = '';
      resp.on('data', c => b += c);
      resp.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } });
    });
    r.on('error', () => res(null));
    r.end();
  });
}

const TOOLS = [
  { name: 'search_song', description: '搜歌，返回候选列表', inputSchema: { type: 'object', properties: { keyword: { type: 'string' }, limit: { type: 'number' } }, required: ['keyword'] } },
  { name: 'play_song', description: '按歌名切歌，网页会立刻播放', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'now_playing', description: '现在在放什么、唱到哪', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_interface', description: '读整个界面：当前歌、进度、播放状态、聊天记录', inputSchema: { type: 'object', properties: {} } },
  { name: 'send_messages', description: '往网页聊天框发消息，可一次发多条', inputSchema: { type: 'object', properties: { messages: { type: 'array', items: { type: 'string' } } }, required: ['messages'] } },
  { name: 'read_messages', description: '读网页聊天里的消息', inputSchema: { type: 'object', properties: {} } }
];

async function callTool(name, args) {
  args = args || {};
  if (name === 'search_song') {
    const d = await apiGet('/search?keywords=' + encodeURIComponent(args.keyword || '') + '&limit=' + (args.limit || 8));
    const list = (d && d.result && d.result.songs) || [];
    if (!list.length) return '没找到';
    return list.map((s, i) => (i + 1) + '. ' + s.name + ' — ' + (s.artists || s.ar || []).map(a => a.name).join('/')).join('\n');
  }
  if (name === 'play_song') {
    const d = await apiGet('/search?keywords=' + encodeURIComponent(args.name || '') + '&limit=1');
    const s = d && d.result && d.result.songs && d.result.songs[0];
    if (!s) return '没找到这首';
    queue.push({
      type: 'play',
      song: {
        id: s.id, name: s.name,
        artist: (s.artists || s.ar || []).map(a => a.name).join(' / '),
        cover: (s.al && s.al.picUrl) || '', fee: s.fee
      }
    });
    return '切到「' + s.name + '」了';
  }
  if (name === 'now_playing') {
    if (!state.current) return '还没放歌';
    return '在放：' + state.current.name + ' — ' + (state.current.artist || '') +
      '（' + fmt(state.pos) + ' / ' + fmt(state.dur) + '，' + (state.playing ? '在放' : '停着') + '）';
  }
  if (name === 'get_interface') {
    const c = state.current;
    const head = c
      ? '在放：' + c.name + ' — ' + (c.artist || '') + '，' + fmt(state.pos) + ' / ' + fmt(state.dur) + '，' + (state.playing ? '在放' : '停着')
      : '还没放歌';
    const tail = state.msgs.length
      ? '\n\n聊天最后几条：\n' + state.msgs.slice(-6).map(m => (m.side === 'me' ? '我' : (m.who || '你')) + '：' + m.text).join('\n')
      : '\n\n聊天是空的';
    return head + tail;
  }
  if (name === 'send_messages') {
    const list = Array.isArray(args.messages) ? args.messages : [args.messages];
    const clean = list.filter(x => x && String(x).trim());
    if (!clean.length) return '没东西可发';
    queue.push({ type: 'msg', texts: clean });
    return '发了 ' + clean.length + ' 条';
  }
  if (name === 'read_messages') {
    if (!state.msgs.length) return '聊天是空的';
    return state.msgs.slice(-20).map(m => (m.side === 'me' ? '我' : (m.who || '你')) + '：' + m.text).join('\n');
  }
  return '不认识这个工具';
}

function mcp(body) {
  const { id, method, params } = body || {};
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'yiting', version: '1.0.0' } } };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    return callTool(name, args).then(text => ({
      jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] }
    })).catch(e => ({
      jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '出错了：' + e.message }], isError: true }
    }));
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } };
}

function readBody(req) {
  return new Promise(res => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => res(b));
  });
}

function json(res, obj, code) {
  res.writeHead(code || 200, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

https.createServer({ key, cert }, async (req, res) => {
  const u = decodeURIComponent((req.url || '/').split('?')[0]);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
    res.end();
    return;
  }

  if (u === '/api/report' && req.method === 'POST') {
    try {
      const d = JSON.parse(await readBody(req));
      state.current = d.current || state.current;
      state.playing = !!d.playing;
      state.pos = d.pos || 0;
      state.dur = d.dur || 0;
      if (Array.isArray(d.msgs)) state.msgs = d.msgs;
    } catch (e) {}
    json(res, { ok: true });
    return;
  }

  if (u === '/api/poll') {
    const out = queue;
    queue = [];
    json(res, out);
    return;
  }

  if (u === '/mcp') {
    if (req.method !== 'POST') { json(res, { ok: true }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { json(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    const out = await mcp(body);
    if (!out) { res.writeHead(202, { 'access-control-allow-origin': '*' }); res.end(); return; }
    json(res, out);
    return;
  }

  let f = u === '/web' || u === '/web/' ? '/index.html' : (u.startsWith('/web/') ? u.slice(4) : null);
  if (f) {
    const p = path.join(WEB, f);
    fs.readFile(p, (e, data) => {
      if (e) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    });
    return;
  }

  const p2 = http.request({ hostname: '127.0.0.1', port: 3000, path: req.url, method: req.method, headers: req.headers }, r => {
    const h = Object.assign({}, r.headers);
    h['access-control-allow-origin'] = '*';
    res.writeHead(r.statusCode || 502, h);
    r.pipe(res);
  });
  p2.on('error', () => { res.writeHead(502); res.end('upstream'); });
  req.pipe(p2);
}).listen(3443, '0.0.0.0', () => console.log('web + api + mcp on 3443'));
