/* static server for C:/Users/RHV/Documents/GitHub/seedworld + POST /snap?name=x
   (page posts JSON state dumps; saved to this scratchpad for offline diffing) */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = 'C:/Users/RHV/Documents/GitHub/seedworld';
const OUT = process.env.TEMP + "/seedworld-snaps"; require("fs").mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname === '/snap') {
    const name = (u.searchParams.get('name') || 'snap').replace(/[^\w-]/g, '');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const f = path.join(OUT, 'snap-' + name + '.json');
      fs.writeFileSync(f, Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      res.end('saved ' + f + ' (' + Buffer.concat(chunks).length + ' bytes)');
    });
    return;
  }
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  if (p.startsWith('/harness/')) {
    const hf = path.join(ROOT, 'tools', p.slice(9));
    if (!hf.startsWith(path.resolve(path.join(ROOT, 'tools')))) { res.writeHead(403); return res.end(); }
    return fs.readFile(hf, (err, data) => {
      if (err) { res.writeHead(404); return res.end('404 ' + p); }
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      res.end(data);
    });
  }
  const f = path.join(ROOT, p);
  if (!f.startsWith(path.resolve(ROOT))) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404 ' + p); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(8961, () => console.log('seedworld-gh on :8961, root ' + ROOT));
