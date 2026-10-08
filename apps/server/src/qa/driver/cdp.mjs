// Драйвер Chrome через CDP для QA-прогонов на тестовых стендах: QA-браузер Task Pilot.
// Использование: SHOT_DIR=<папка скриншотов> [CDP_PORT=9333] node cdp.mjs '<json-массив действий>'
// Chrome должен быть запущен с --remote-debugging-port (см. scripts/chrome_start.sh).
// Действия: {navigate}, {wait}, {waitFor,timeout}, {click}, {type:{selector,text}}, {eval}, {shot},
// {viewport:{width,height,mobile}}, {clearCookies:true}, {block:[urlPatterns]}, {unblock:true},
// {newTab:url}, {useTab:index}, {useTabUrl:substr}, {useTabTitle:substr}, {useTabWhere:{urlIncludes,titleExcludes}},
// {mark:'A'} (пометка вкладки в title), {listTabs:true}, {closeTabUrl:substr}, {cookies:true}, {log}
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9333);
const OUT = process.env.SHOT_DIR;
const actions = JSON.parse(process.argv[2]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
	const res = await fetch(`http://127.0.0.1:${PORT}/json`);
	return (await res.json()).filter(t => t.type === 'page');
}

function connect(wsUrl) {
	const ws = new WebSocket(wsUrl);
	let id = 0;
	const pending = new Map();
	const events = [];
	ws.addEventListener('message', ev => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
		} else if (msg.method) {
			events.push(msg);
		}
	});
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const myId = ++id;
		pending.set(myId, { resolve, reject });
		ws.send(JSON.stringify({ id: myId, method, params }));
	});
	return new Promise(r => ws.addEventListener('open', () => r({ ws, send, events })));
}

async function evalJs(send, expression) {
	const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
	if (exceptionDetails) throw new Error('eval: ' + JSON.stringify(exceptionDetails.exception?.description || exceptionDetails.text));
	return result.value;
}

async function waitFor(send, selector, timeout = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (await evalJs(send, `!!document.querySelector(${JSON.stringify(selector)})`)) return true;
		await sleep(250);
	}
	throw new Error('waitFor timeout: ' + selector);
}

async function center(send, selector) {
	const rect = await evalJs(send, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
	if (!rect) throw new Error('not found: ' + selector);
	return rect;
}

async function click(send, selector) {
	const { x, y } = await center(send, selector);
	for (const type of ['mousePressed', 'mouseReleased']) {
		await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
	}
}

async function typeText(send, selector, text) {
	await click(send, selector);
	await evalJs(send, `document.querySelector(${JSON.stringify(selector)}).focus()`);
	for (const ch of text) {
		await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
		await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
		await sleep(30);
	}
}

let tabs = await targets();
let tabIdx = 0;
let conn = await connect(tabs[tabIdx].webSocketDebuggerUrl);
await conn.send('Page.enable');
await conn.send('Runtime.enable');
await conn.send('Network.enable');

for (const a of actions) {
	const { send } = conn;
	if (a.navigate) { await send('Page.navigate', { url: a.navigate }); await sleep(a.settle ?? 4000); console.log('navigated', a.navigate.slice(0, 80)); }
	else if (a.wait) { await sleep(a.wait); }
	else if (a.waitFor) { await waitFor(send, a.waitFor, a.timeout); console.log('found', a.waitFor); }
	else if (a.click) { await click(send, a.click); await sleep(a.settle ?? 800); console.log('clicked', a.click); }
	else if (a.type) { await typeText(send, a.type.selector, a.type.text); console.log('typed into', a.type.selector); }
	else if (a.eval) { console.log('eval =>', JSON.stringify(await evalJs(send, a.eval))); }
	else if (a.shot) {
		const { data } = await send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(`${OUT}/${a.shot}.png`, Buffer.from(data, 'base64'));
		console.log('shot', a.shot);
	}
	else if (a.viewport) {
		if (a.viewport === 'reset') await send('Emulation.clearDeviceMetricsOverride');
		else await send('Emulation.setDeviceMetricsOverride', { width: a.viewport.width, height: a.viewport.height, deviceScaleFactor: a.viewport.mobile ? 2 : 1, mobile: !!a.viewport.mobile });
		console.log('viewport', JSON.stringify(a.viewport));
	}
	else if (a.clearCookies) { await send('Network.clearBrowserCookies'); console.log('cookies cleared'); }
	else if (a.cookies) { const { cookies } = await send('Network.getCookies'); console.log('cookies =>', cookies.map(c => `${c.name}@${c.domain}`).join(', ')); }
	else if (a.block) { await send('Network.setBlockedURLs', { urls: a.block }); console.log('blocked', a.block); }
	else if (a.unblock) { await send('Network.setBlockedURLs', { urls: [] }); console.log('unblocked'); }
	else if (a.newTab) {
		await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(a.newTab)}`, { method: 'PUT' });
		await sleep(3000); tabs = await targets(); console.log('tabs', tabs.length);
	}
	else if (a.useTab !== undefined) {
		tabs = await targets(); conn.ws.close(); conn = await connect(tabs[a.useTab].webSocketDebuggerUrl);
		await conn.send('Page.enable'); await conn.send('Runtime.enable'); await conn.send('Network.enable'); console.log('using tab', a.useTab, tabs[a.useTab].url.slice(0, 80));
	}
	else if (a.useTabUrl) {
		tabs = await targets(); const idx = tabs.findIndex(t => t.url.includes(a.useTabUrl)); if (idx < 0) throw new Error('no tab ' + a.useTabUrl);
		conn.ws.close(); conn = await connect(tabs[idx].webSocketDebuggerUrl);
		await conn.send('Page.enable'); await conn.send('Runtime.enable'); await conn.send('Network.enable'); console.log('using tab', tabs[idx].url.slice(0, 60));
	}
	else if (a.useTabTitle) {
		tabs = await targets(); const idx = tabs.findIndex(t => (t.title||'').includes(a.useTabTitle)); if (idx < 0) throw new Error('no tab titled ' + a.useTabTitle);
		conn.ws.close(); conn = await connect(tabs[idx].webSocketDebuggerUrl);
		await conn.send('Page.enable'); await conn.send('Runtime.enable'); await conn.send('Network.enable'); console.log('using tab titled', a.useTabTitle);
	}
	else if (a.mark) { await evalJs(send, `document.title = document.title.replace(/ \\[[A-Z]\\]$/, '') + ' [${a.mark}]'`); console.log('marked', a.mark); }
	else if (a.listTabs) { tabs = await targets(); console.log(tabs.map((t,i) => i + ': ' + (t.title||'').slice(0,40) + ' ' + t.url.slice(0,50)).join('\n')); }
	else if (a.closeTabUrl) { tabs = await targets(); for (const t of tabs.filter(t => t.url.includes(a.closeTabUrl))) { await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`); } console.log('closed tabs', a.closeTabUrl); }
	else if (a.useTabWhere) {
		tabs = await targets(); const idx = tabs.findIndex(t => t.url.includes(a.useTabWhere.urlIncludes || '') && !(a.useTabWhere.titleExcludes && (t.title||'').includes(a.useTabWhere.titleExcludes))); if (idx < 0) throw new Error('no tab for ' + JSON.stringify(a.useTabWhere));
		conn.ws.close(); conn = await connect(tabs[idx].webSocketDebuggerUrl);
		await conn.send('Page.enable'); await conn.send('Runtime.enable'); await conn.send('Network.enable'); console.log('using tab', (tabs[idx].title||'').slice(0,40));
	}
	else if (a.log) { console.log(a.log); }
}
conn.ws.close();
