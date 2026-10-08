// Слушает сеть вкладки (по подстроке title) и пишет в файл первый POST, тело которого содержит подстроку.
// Аргументы: <titleSubstring> <outFile> [timeoutSec=600] [bodySubstring - без нее первый POST]. Порт из CDP_PORT (9333).
import { writeFileSync } from 'node:fs';
const [title, outFile, timeoutSec = '600', needle = ''] = process.argv.slice(2);
const PORT = process.env.CDP_PORT || 9333;
const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');
const tab = tabs.find(t => (t.title || '').includes(title));
if (!tab) { console.error('no tab', title); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const my = ++id; pending.set(my, { res, rej }); ws.send(JSON.stringify({ id: my, method, params })); });
ws.addEventListener('open', async () => { await send('Network.enable'); console.log('listening on', tab.url.slice(0, 60)); });
ws.addEventListener('message', ev => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); return; }
	if (m.method === 'Network.requestWillBeSent') {
		const r = m.params.request;
		if (r.method === 'POST' && r.postData && r.postData.includes(needle)) {
			writeFileSync(outFile, JSON.stringify({ url: r.url, postData: r.postData, at: new Date().toISOString() }, null, 2));
			console.log('captured POST to', r.url.slice(0, 80)); ws.close(); process.exit(0);
		}
	}
});
setTimeout(() => { console.log('timeout'); process.exit(2); }, Number(timeoutSec) * 1000);
