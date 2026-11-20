import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

/** The Hub, connector, desktop WebSocket and browser are real. Both clipboards contain only fixture data. */
export async function verifyHubClipboard(browser, origin, target) {
	const context = await browser.newContext({ locale: "en-US" });
	try {
		await context.addCookies([{ name: "hub", value: "test", url: origin }]);
		await context.addInitScript(() => {
			if (window !== top) return;
			const store = new EventTarget();
			let value = new Blob(["initial controller text"], { type: "text/plain" });
			Object.assign(store, {
				onclipboardchange: null,
				readCount: 0,
				ready: 0,
				denied: false,
				blockWrite: false,
				copy(blob) {
					value = blob;
					store.dispatchEvent(new Event("clipboardchange"));
				},
				current: () => value,
				async read() {
					store.readCount++;
					if (store.denied) throw new DOMException("Denied", "NotAllowedError");
					return [new ClipboardItem({ [value.type]: value })];
				},
				async write(items) {
					if (store.blockWrite) throw new DOMException("Denied", "NotAllowedError");
					store.copy(await items[0].getType(items[0].types[0]));
				},
				async writeText(text) {
					if (store.blockWrite) throw new DOMException("Denied", "NotAllowedError");
					store.copy(new Blob([text], { type: "text/plain" }));
				},
			});
			addEventListener("message", (e) => {
				if (e.data?.type === "desktop-clipboard" && e.data.payload?.type === "clipboard-ready") store.ready++;
			});
			Object.defineProperty(navigator, "clipboard", { value: store });
		});
		const page = await context.newPage();
		await page.goto(origin + "/device/pc-b/");
		await page.evaluate(() => window.__piBrowserPeerReady);
		const app = page.frameLocator("body > iframe");
		await app.getByRole("button", { name: "Expand and control" }).click();
		const live = app.frameLocator(".remote-desktop-window iframe");
		await live.getByText("Connected · control enabled", { exact: true }).waitFor();
		const open = () => live.getByRole("button", { name: "Clipboard", exact: true }).click();
		await open();
		const mode = page.getByRole("combobox", { name: "Clipboard", exact: true });
		assert.equal(await mode.inputValue(), "off");
		assert.deepEqual(await mode.locator("option").evaluateAll((nodes) => nodes.map((n) => n.value)), [
			"off",
			"send",
			"receive",
			"both",
		]);
		assert.equal(await page.evaluate(() => navigator.clipboard.readCount), 0);
		const before = (await target.read()).items[0].data.toString();
		const change = async (value) => {
			const n = await page.evaluate(() => navigator.clipboard.ready);
			await mode.selectOption(value);
			if (value !== "off") await page.waitForFunction((n) => navigator.clipboard.ready > n, n);
		};
		const copyText = (text) =>
			page.evaluate((text) => navigator.clipboard.copy(new Blob([text], { type: "text/plain" })), text);
		const waitRemote = async (bytes) => {
			const end = Date.now() + 8000;
			while (!(await target.read()).items[0].data.equals(bytes)) {
				if (Date.now() > end) throw new Error("Controller copy did not reach the selected target");
				await sleep(30);
			}
		};
		await change("send");
		assert.equal((await target.read()).items[0].data.toString(), before, "enabling must not send the old clipboard");
		const text = "multichunk 文字\n".repeat(6200);
		await page.getByRole("button", { name: "Close", exact: true }).click();
		await live.locator("canvas").first().focus();
		await copyText(text);
		await waitRemote(Buffer.from(text));
		await open();
		await change("receive");
		await copyText("local only");
		await sleep(200);
		assert.equal((await target.read()).items[0].data.toString(), text);
		await target.copy({ kind: "text", items: [{ name: "text.txt", data: Buffer.from("from remote") }] });
		await page.waitForFunction(async () => (await navigator.clipboard.current().text()) === "from remote");
		await change("both");
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB8sAAAAASUVORK5CYII=";
		const pngBytes = Buffer.from(png, "base64");
		await page.evaluate(
			(png) =>
				navigator.clipboard.copy(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: "image/png" })),
			png,
		);
		await waitRemote(pngBytes);
		await target.copy({ kind: "text", items: [{ name: "text.txt", data: Buffer.from("intermediate") }] });
		await page.waitForFunction(async () => (await navigator.clipboard.current().text()) === "intermediate");
		await target.copy({ kind: "image", items: [{ name: "image.png", data: pngBytes }] });
		await page.waitForFunction(() => navigator.clipboard.current().type === "image/png");
		assert.deepEqual(
			Buffer.from(
				await page.evaluate(async () => Array.from(new Uint8Array(await navigator.clipboard.current().arrayBuffer()))),
			),
			pngBytes,
		);
		await page.evaluate(() => {
			navigator.clipboard.blockWrite = true;
		});
		await target.copy({ kind: "text", items: [{ name: "text.txt", data: Buffer.from("pending user gesture") }] });
		const apply = page.locator(".web-clipboard-modes").getByRole("button", { name: "Copy locally", exact: true });
		await apply.waitFor();
		await page.evaluate(() => {
			navigator.clipboard.blockWrite = false;
		});
		await apply.click();
		await page.waitForFunction(async () => (await navigator.clipboard.current().text()) === "pending user gesture");
		await change("off");
		await copyText("do not share");
		await sleep(200);
		assert.equal((await target.read()).items[0].data.toString(), "pending user gesture");
		const handoff = page.locator(".web-clipboard-native");
		await handoff.locator("summary").click();
		const link = handoff.getByRole("link");
		const localUrl = new URL(await link.getAttribute("href"));
		assert.equal(localUrl.origin, "http://127.0.0.1:8787");
		assert.equal(localUrl.searchParams.get("clipboardDevice"), "pc-b");
		assert.equal(localUrl.searchParams.get("clipboardHub"), origin);
		assert.deepEqual([...localUrl.searchParams.keys()].sort(), ["clipboardDevice", "clipboardHub", "view"]);
		await handoff.getByRole("spinbutton").fill("8998");
		assert.equal(new URL(await link.getAttribute("href")).port, "8998");
		await page.locator(".web-clipboard-modes").getByRole("button", { name: "File transfer", exact: true }).click();
		await page.locator("#file-transfer-dialog[open]").getByRole("button", { name: "Hide", exact: true }).click();
		await open();
		await change("both");
		await page.getByRole("button", { name: "Close", exact: true }).click();
		await live.locator("#viewonly").check();
		await live.getByText("Connected · view only", { exact: true }).waitFor();
		await open();
		assert.equal(await mode.inputValue(), "receive");
		assert.deepEqual(await mode.evaluate((el) => Array.from(el.options, (option) => [option.value, option.disabled])), [
			["off", false],
			["send", true],
			["receive", false],
			["both", true],
		]);
		await page.getByRole("button", { name: "Close", exact: true }).click();
		await live.locator("#viewonly").uncheck();
		await live.getByText("Connected · control enabled", { exact: true }).waitFor();
		await open();
		assert.equal(await mode.inputValue(), "both");
		await change("off");
		console.log(
			"PASS: trusted Hub direction selection, no initial or disabled reads, nested desktop focus, multichunk text, PNG both ways and permission recovery.",
		);
	} finally {
		await context.close();
	}
}
