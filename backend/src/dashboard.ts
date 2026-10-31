import { createServer, type Server } from "node:http";
import { readDemoEvents, recordedReplay } from "./events.js";

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Supercuts funded-run evidence</title><style>body{font:15px system-ui;margin:0;background:#0b1020;color:#eef2ff}header{position:sticky;top:0;padding:18px 24px;background:#111936;border-bottom:1px solid #334155}main{max-width:980px;margin:auto;padding:24px}.event{display:grid;grid-template-columns:9rem 10rem 1fr;gap:14px;padding:14px;border-bottom:1px solid #27334f}.mode{color:#fbbf24;font-weight:700}.complete,.allowed{color:#86efac}.failed,.rejected{color:#fca5a5}code{color:#bfdbfe;white-space:pre-wrap}</style></head><body><header><b>Supercuts</b> · <span class="mode" id="mode">loading evidence…</span></header><main id="events"></main><script>const out=document.querySelector('#events');const source=new EventSource('/events');source.onmessage=e=>{const v=JSON.parse(e.data);document.querySelector('#mode').textContent=v.mode==='live'?'LIVE FUNDED RUN':'RECORDED FUNDED RUN';const n=document.createElement('div');n.className='event';n.innerHTML='<span>#'+v.sequence+' '+v.actor+'</span><span class="'+v.status+'">'+v.stage+' · '+v.status+'</span><code></code>';n.querySelector('code').textContent=JSON.stringify(v.publicDetails,null,2);out.append(n)};</script></body></html>`;

export function serveEventDashboard(path: string, port: number, replay = false): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    if (request.url === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return response.end(html); }
    if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "access-control-allow-origin": "http://127.0.0.1" });
      const source = readDemoEvents(path), events = replay ? recordedReplay(source) : source;
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      return response.end();
    }
    response.writeHead(404); response.end("Not Found");
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${port}/` })); });
}
