// Minimal stand-in for the engines, for tests:
// - OpenAI-compatible routes (/v1/chat/completions, /v1/audio/*, /v1/models) like OpenAI or the mlx-audio server
// - Ollama routes (/api/chat, /api/tags, /api/generate)
// Translations come back as "EN: <original>". Every call is recorded in `calls`.
import http from 'node:http';

function multipartFields(body) {
  const fields = {};
  for (const m of body.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) fields[m[1]] = m[2];
  return fields;
}

function linesFromPrompt(text) {
  const after = text.slice(text.indexOf('Translate these'));
  return [...after.matchAll(/^\d+\. (.*)$/gm)].map((m) => `EN: ${m[1]}`);
}

export function startMockApi({ ollamaModels = ['qwen3:8b'], noThinkModels = [] } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('latin1'); // keeps binary audio intact enough for field parsing
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];
      const origin = req.headers.origin || null;
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const parse = () => {
        try {
          return JSON.parse(Buffer.from(body, 'latin1').toString('utf8'));
        } catch {
          return null;
        }
      };

      if (req.method === 'GET' && url.endsWith('/v1/models')) return json(200, { object: 'list', data: [] });

      if (req.method === 'POST' && url.endsWith('/chat/completions')) {
        const p = parse();
        if (!p) return json(400, { error: { message: 'bad json' } });
        const user = (p.messages || []).find((m) => m.role === 'user')?.content || '';
        const lines = linesFromPrompt(user);
        calls.push({ url, batch: lines.length, model: p.model, origin });
        return json(200, { choices: [{ message: { role: 'assistant', content: JSON.stringify({ lines }) } }] });
      }

      if (req.method === 'POST' && /\/audio\/(translations|transcriptions)$/.test(url)) {
        const fields = multipartFields(body);
        calls.push({ url, model: fields.model, language: fields.language, responseFormat: fields.response_format, bytes: body.length, origin });
        return json(200, { text: 'Mock speech result' });
      }

      if (req.method === 'GET' && url === '/api/tags') {
        calls.push({ url, origin });
        return json(200, { models: ollamaModels.map((name) => ({ name, model: name })) });
      }

      if (req.method === 'POST' && url === '/api/generate') {
        const p = parse() || {};
        calls.push({ url, model: p.model, origin });
        return json(200, { model: p.model, done: true });
      }

      if (req.method === 'POST' && url === '/api/chat') {
        const p = parse();
        if (!p) return json(400, { error: 'bad json' });
        if (!ollamaModels.includes(p.model)) return json(404, { error: `model '${p.model}' not found` });
        if (noThinkModels.includes(p.model) && 'think' in p) return json(400, { error: `"${p.model}" does not support thinking` });
        const user = (p.messages || []).find((m) => m.role === 'user')?.content || '';
        const lines = linesFromPrompt(user);
        calls.push({ url, batch: lines.length, model: p.model, think: p.think, format: p.format, keepAlive: p.keep_alive, origin });
        return json(200, { model: p.model, message: { role: 'assistant', content: JSON.stringify({ lines }) }, done: true });
      }

      json(404, { error: { message: `no route for ${req.method} ${url}` } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, calls, origin, baseUrl: `${origin}/v1` });
    });
  });
}
