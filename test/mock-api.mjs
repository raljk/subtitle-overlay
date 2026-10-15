// Minimal OpenAI-compatible mock for tests: translates "x" to "EN: x" and answers Whisper endpoints with fixed text.
import http from 'node:http';

export function startMockApi() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && url.endsWith('/models')) return json(200, { data: [{ id: 'whisper-1' }] });
      if (req.method === 'POST' && url.endsWith('/chat/completions')) {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          return json(400, { error: { message: 'bad json' } });
        }
        const user = (parsed.messages || []).find((m) => m.role === 'user')?.content || '';
        const after = user.slice(user.indexOf('Translate these'));
        const lines = [...after.matchAll(/^\d+\. (.*)$/gm)].map((m) => `EN: ${m[1]}`);
        calls.push({ url, batch: lines.length, model: parsed.model });
        return json(200, { choices: [{ message: { role: 'assistant', content: JSON.stringify({ lines }) } }] });
      }
      if (req.method === 'POST' && /\/audio\/(translations|transcriptions)$/.test(url)) {
        calls.push({ url, bytes: body.length });
        return json(200, { text: 'Mock speech result' });
      }
      json(404, { error: { message: `no route for ${req.method} ${url}` } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}
