import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const entry = resolve(
	process.argv.slice(2).find((arg) => !arg.startsWith("--")) ||
		fileURLToPath(new URL("../dist/server/index.js", import.meta.url)),
);
const baseline = process.argv.includes("--baseline");
const root = mkdtempSync(join(tmpdir(), "pi-scheduler-ownership-"));
const project = join(root, "project");
const neutral = join(root, "neutral");
const data = join(root, "data");
const agent = join(root, "agent");
for (const dir of [project, neutral, data, agent]) mkdirSync(dir);
console.log("Isolated reproduction:", root);
const task = {
	id: "ownership-test",
	name: "定时任务验收",
	cwd: project,
	kind: "interval",
	spec: "60000",
	prompt: "回复 TEST",
	model: "main/mock",
	catchUp: "once",
	conversationId: "",
	sessionFile: "",
};
const titles = ["项目笔记", "DtTool 易语言功能移植与验收"];
const schedule = () => JSON.parse(readFileSync(join(data, "scheduler-tasks.json"), "utf8")).tasks;
function transcripts(dir = agent) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		if (e.isDirectory()) return transcripts(path);
		if (!e.name.endsWith(".jsonl")) return [];
		const bytes = readFileSync(path);
		const rows = bytes
			.toString()
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		if (rows[0]?.type !== "session" || rows[0].cwd !== project) return [];
		return [
			{
				uuid: rows[0].id,
				path,
				title: rows.filter((r) => r.type === "session_info").at(-1)?.name,
				hash: createHash("sha256").update(bytes).digest("hex"),
				messages: rows.filter((r) => r.type === "message").length,
			},
		];
	});
}
async function until(fn, label, seconds = 30) {
	const end = Date.now() + seconds * 1000;
	while (Date.now() < end) {
		const result = await fn();
		if (result) return result;
		await sleep(50);
	}
	throw Error("Timed out: " + label);
}
const gates = [];
const mock = createServer(async (req, res) => {
	let buf = "";
	for await (const part of req) buf += part;
	const payload = JSON.parse(buf);
	const last = JSON.stringify(payload.messages?.at(-1)?.content);
	const scheduled = last?.includes("回复 TEST");
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	const chunk = (delta, finish_reason = null) =>
		res.write(
			"data: " +
				JSON.stringify({
					id: "mock",
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "mock",
					choices: [{ index: 0, delta, finish_reason }],
				}) +
				"\n\n",
		);
	chunk({ role: "assistant", content: scheduled ? "TE" : "OK" });
	if (scheduled)
		await new Promise((done) => {
			gates.push(done);
			res.on("close", done);
		});
	chunk({ content: scheduled ? "ST" : "" });
	chunk({}, "stop");
	res.end("data: [DONE]\n\n");
});
const listener = createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
writeFileSync(
	join(agent, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:" + mock.address().port,
				apiKey: "test",
				models: [{ id: "mock", name: "mock", input: ["text"], contextWindow: 32000, maxTokens: 512 }],
			},
		},
	}),
);
writeFileSync(join(agent, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "test" } }));
// Deliver the normal shutdown signal in-process on Windows, where child.kill("SIGTERM") terminates immediately.
const wrapper = join(root, "server.mjs");
writeFileSync(
	wrapper,
	'process.on("message", m => { if(m==="stop") process.emit("SIGTERM"); });\nawait import(' +
		JSON.stringify(pathToFileURL(entry).href) +
		");\n",
);
let child;
let ws;
let messages = [];
let state;
let restartIndex = 0;
async function start() {
	const log = openSync(join(root, "server-" + ++restartIndex + ".log"), "w");
	child = fork(wrapper, [], {
		cwd: neutral,
		stdio: ["ignore", log, log, "ipc"],
		execArgv: [],
		windowsHide: true,
		env: {
			...process.env,
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_PORT: String(port),
			PI_WEB_CWD: neutral,
			PI_WEB_DATA_DIR: data,
			PI_CODING_AGENT_DIR: agent,
			PI_CODING_AGENT_SESSION_DIR: "",
			PI_WEB_TOKEN: "",
			PI_WEB_REQUIRE_AUTH: "0",
		},
	});
	closeSync(log);
	await until(async () => {
		if (child.exitCode !== null) throw Error("Server exited: " + child.exitCode);
		try {
			return (await fetch("http://127.0.0.1:" + port + "/health")).ok;
		} catch {
			return false;
		}
	}, "server startup");
}
async function stop() {
	ws?.terminate();
	ws = undefined;
	if (!child || child.exitCode !== null) return;
	const stopped = once(child, "exit");
	child.send("stop");
	await stopped;
}
async function connect(id) {
	messages = [];
	state = undefined;
	ws = new WebSocket("ws://127.0.0.1:" + port + "/ws");
	ws.on("message", (data) => {
		const m = JSON.parse(data);
		messages.push(m);
		if (m.type === "snapshot") state = m.state;
		if (m.type === "snapshot_delta" && state?.rev === m.baseRev) state = { ...state, ...m.state };
	});
	await once(ws, "open");
	send({ type: "hello", clientId: id });
	await until(() => state?.conversationId, "client ready");
}
function send(msg) {
	ws.send(JSON.stringify(msg));
}
async function openHistory(row) {
	messages = [];
	send({ type: "switch_session", path: row.path, sessionId: row.uuid });
	return until(
		() =>
			messages.find(
				(m) =>
					(m.type === "notice" && m.level !== "info") ||
					(m.type === "transition_progress" && m.kind === "session" && m.phase === "done"),
			),
		"open " + row.title,
	);
}
async function verifyTaskLink(row) {
	assert(CHROME_PATH, "Chrome is required for --browser");
	const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	try {
		const page = await browser.newPage();
		await page.addInitScript(() => {
			const send = WebSocket.prototype.send;
			WebSocket.prototype.send = function (data) {
				if (typeof data === "string" && JSON.parse(data).type === "hello") {
					window.testChatSocket = this;
					this.addEventListener("message", (event) => {
						if (JSON.parse(event.data).type === "snapshot") window.testChatReady = true;
					});
				}
				return send.call(this, data);
			};
		});
		await page.goto("http://127.0.0.1:" + port + "/");
		await page.waitForFunction(() => window.testChatReady);
		await page.evaluate(
			(path) => window.testChatSocket.send(JSON.stringify({ type: "switch_session", path })),
			row.path,
		);
		await page.locator(".notice .scheduler-link").click();
		const focused = page
			.locator(".scheduler-item")
			.filter({ has: page.locator(".scheduler-name", { hasText: task.name }) });
		await focused.locator(".scheduler-history li").first().waitFor();
		assert.equal(await page.locator(".scheduler-history").count(), 1);
		console.log("Chrome notice opened the matching scheduled task and its run history.");
	} finally {
		await browser.close();
	}
}
async function saveTask(fields) {
	send({ type: "schedule_save", task: fields });
	await until(() => {
		try {
			return schedule()[fields.id];
		} catch {
			return false;
		}
	}, "save task");
}
try {
	await start();
	await connect("seed-browser");
	send({ type: "set_cwd", path: project });
	await until(() => state.cwd === project, "project");
	for (const [index, title] of titles.entries()) {
		if (index) {
			const prev = state.conversationId;
			send({ type: "new_chat" });
			await until(() => state.conversationId !== prev, "second conversation");
		}
		send({ type: "set_model", modelId: "main/mock" });
		await until(() => state.model?.id === "mock", "model");
		send({ type: "prompt", text: "seed " + index });
		await until(() => transcripts().filter((r) => r.messages >= 2).length === index + 1, "seed transcript");
		send({ type: "rename_conversation", id: state.conversationId, name: title });
		await until(() => transcripts().some((r) => r.title === title), "rename");
	}
	await saveTask(task);
	const before = transcripts();
	console.log("Before restart", JSON.stringify(before));
	await stop();
	await start();
	await until(() => gates.length, "automatic invocation before opening any browser", 95);
	await connect("history-browser");
	const during = [];
	for (const row of before) during.push(await openHistory(row));
	console.log("Opening ordinary chats during run:", JSON.stringify(during.map((m) => m.text || m.phase)));
	gates.shift()();
	await until(() => schedule()[task.id].history[0], "recorded completion");
	const after = transcripts();
	console.log("After run", JSON.stringify(after));
	const opened = [];
	for (const row of before) opened.push(await openHistory(row));
	console.log("Opening ordinary chats after run:", JSON.stringify(opened.map((m) => m.text || m.phase)));
	if (baseline) {
		assert(
			after.some(
				(r) =>
					before.some((b) => b.uuid === r.uuid && b.path === r.path && b.title !== r.title) && r.title === task.name,
			),
		);
		assert(opened.some((m) => m.type === "notice" && m.text.includes("定时任务")));
	} else {
		for (const row of before)
			assert.deepEqual(
				after.find((r) => r.uuid === row.uuid),
				row,
			);
		assert(during.every((m) => m.phase === "done"));
		assert(opened.every((m) => m.phase === "done"));
		const owned = after.find((r) => r.title === task.name);
		assert(owned && !before.some((r) => r.uuid === owned.uuid));
		send({ type: "schedule_toggle", id: task.id, enabled: false });
		await until(() => !schedule()[task.id].enabled, "disable automatic runs");
		await stop();
		await start();
		await connect("second-viewer");
		send({ type: "schedule_run", id: task.id });
		await until(() => gates.length, "second run");
		const held = await openHistory(owned);
		console.log("Opening task history during its next run:", JSON.stringify(held));
		assert.equal(held.schedulerTaskId, task.id);
		if (process.argv.includes("--browser")) await verifyTaskLink(owned);
		gates.shift()();
		await until(() => schedule()[task.id].history.length === 2, "second completion");
		const again = transcripts().filter((r) => r.title === task.name);
		assert.equal(again.length, 1);
		assert.equal(again[0].uuid, owned.uuid);
		assert.equal(again[0].path, owned.path);
		assert(again[0].messages > owned.messages);
		assert.equal((await openHistory(owned)).phase, "done");
		await openHistory(before[0]);
		const missing = {
			...task,
			id: "missing-file",
			enabled: false,
			oneShot: true,
			conversationId: state.conversationId,
			sessionFile: join(dirname(before[0].path), "absent.jsonl"),
		};
		await saveTask(missing);
		send({ type: "schedule_run", id: missing.id });
		await until(() => schedule()[missing.id].history[0], "missing history");
		const failed = schedule()[missing.id];
		assert.equal(failed.history[0].ok, false);
		assert.equal(failed.history[0].error, `找不到绑定的会话文件：${missing.sessionFile}`);
		assert.equal(failed.sessionFile, missing.sessionFile);
		assert.equal(failed.conversationId, missing.conversationId);
		const explicitId = { ...task, id: "saved-by-browser", enabled: false, conversationId: state.conversationId };
		await saveTask(explicitId);
		assert.equal(schedule()[explicitId.id].sessionFile, before[0].path);
		for (const row of before)
			assert.deepEqual(
				transcripts().find((r) => r.uuid === row.uuid),
				row,
			);
		const bound = { ...task, id: "exact-file", enabled: false, conversationId: "c1", sessionFile: before[1].path };
		await saveTask(bound);
		await stop();
		await start();
		await connect("bound-viewer");
		assert.equal(schedule()[missing.id].enabled, false);
		assert.equal(schedule()[missing.id].history[0].ok, false);
		// Give the stale runtime ID to a different live conversation before the bound file is opened cold.
		await openHistory(before[0]);
		send({ type: "schedule_run", id: bound.id });
		await until(() => gates.length, "exact cold binding");
		const boundHeld = await openHistory(before[1]);
		assert.equal(boundHeld.schedulerTaskId, bound.id);
		gates.shift()();
		await until(() => schedule()[bound.id].history[0], "bound completion");
		assert.equal(schedule()[bound.id].history[0].ok, true);
		assert.equal(schedule()[bound.id].history[0].sessionFile, before[1].path);
		assert.equal((await openHistory(before[1])).phase, "done");
		// Deliver once more while a browser owns this exact transcript.
		send({ type: "schedule_run", id: bound.id });
		await until(() => gates.length, "live binding");
		gates.shift()();
		await until(() => schedule()[bound.id].history.length === 2, "live completion");
		const final = transcripts();
		const boundRow = final.find((r) => r.uuid === before[1].uuid);
		assert.equal(boundRow.path, before[1].path);
		assert.equal(boundRow.title, before[1].title);
		assert(boundRow.messages > before[1].messages);
		assert.deepEqual(
			final.find((r) => r.uuid === before[0].uuid),
			before[0],
		);
		assert.equal(final.length, 3);
		console.log(
			"Missing binding persisted with its failure; valid cold and live bindings reached only the original file.",
		);
	}
	console.log(baseline ? "Reproduced the original defect." : "Scheduler ownership checks passed.");
} finally {
	for (const done of gates) done();
	await stop();
	mock.closeAllConnections();
	mock.close();
}
