import { manualClipboardControls } from "./desktop-clipboard-manual.js";
import { webClipboardSync } from "./desktop-clipboard-web.js";
import { clipboardStatus } from "./desktop-clipboard-status.js";
import { CLIPBOARD_LIMITS, type ClipboardMode } from "./desktop-clipboard-protocol.js";
import type { desktopPreferences } from "./desktop-preferences.js";

export const clipboardDirections = [
	["off", "关闭", "Off"],
	["send", "我方 → 对方", "Local → remote"],
	["receive", "对方 → 我方", "Remote → local"],
	["both", "双向同步", "Both directions"],
] as const;
type Options = Parameters<typeof manualClipboardControls>[0] & {
	preferences: ReturnType<typeof desktopPreferences>;
	nativeHandoff?: boolean;
	rootDevice?: string;
	openFiles?: () => void;
};
const dependencies = {
	manual: manualClipboardControls,
	sync: webClipboardSync,
	message: clipboardStatus,
	limits: CLIPBOARD_LIMITS,
	directions: clipboardDirections,
};
function mount(options: Options, deps: typeof dependencies) {
	const { zh, host, post, preferences } = options;
	const doc = Reflect.get(globalThis, "document") as any;
	const bar = doc.createElement("div"),
		label = doc.createElement("label"),
		select = doc.createElement("select"),
		note = doc.createElement("span"),
		retry = doc.createElement("button"),
		extra = doc.createElement("div");
	bar.className = "web-clipboard-modes";
	label.textContent = zh ? "剪贴板 " : "Clipboard ";
	select.setAttribute("aria-label", label.textContent.trim());
	for (const [value, cn, en] of deps.directions) {
		const o = doc.createElement("option");
		o.value = value;
		o.textContent = zh ? cn : en;
		select.append(o);
	}
	note.setAttribute("role", "status");
	retry.type = "button";
	retry.hidden = true;
	label.append(select);
	bar.append(label, retry, note);
	host.append(bar);
	host.append(extra);
	// Opening the authenticated loopback app never grants the Hub access to a local service.
	let targetId = "";
	const nestedModes = new Map<string, ClipboardMode>();
	const nestedTarget = () => Boolean(options.rootDevice && options.rootDevice !== targetId);
	if (options.openFiles) {
		const files = doc.createElement("button");
		files.type = "button";
		files.textContent = zh ? "文件传输" : "File transfer";
		files.onclick = options.openFiles;
		bar.append(files);
	}
	let updateLink: (() => void) | undefined;
	if (options.nativeHandoff) {
		const details = doc.createElement("details"),
			title = doc.createElement("summary"),
			portLabel = doc.createElement("label"),
			port = doc.createElement("input"),
			link = doc.createElement("a");
		details.className = "web-clipboard-native";
		title.textContent = zh ? "系统文件剪贴板" : "System file clipboard";
		portLabel.textContent = zh ? "本机 pi-web-ui 端口 " : "Local pi-web-ui port ";
		port.type = "number";
		port.min = "1";
		port.max = "65535";
		port.value = "8787";
		link.textContent = zh ? "通过本机 pi-web-ui 打开远程桌面" : "Open remote desktop in local pi-web-ui";
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		updateLink = () => {
			const n = Number(port.value);
			if (!Number.isInteger(n) || n < 1 || n > 65535) {
				link.removeAttribute("href");
				return;
			}
			const u = new URL("http://127.0.0.1:" + n + "/");
			u.searchParams.set("view", "devices");
			if (targetId) {
				u.searchParams.set("clipboardDevice", targetId);
				u.searchParams.set("clipboardHub", doc.location.origin);
			}
			link.href = u.href;
		};
		port.oninput = updateLink;
		updateLink();
		portLabel.append(port);
		details.append(title, portLabel, link);
		host.append(details);
	}
	const manual = deps.manual({ ...options, host: extra });
	let mode: ClipboardMode = "off",
		connected = false,
		readOnly = true,
		lastCode = "";
	const sync = deps.sync({
		post,
		limits: deps.limits,
		status(code) {
			if (code !== lastCode) post({ type: "desktop-clipboard-status", code });
			lastCode = code;
			const idle = code === "clipboard-off" || code === "clipboard-ready";
			const denied = code === "warning:clipboard-webpermission",
				apply = code === "warning:clipboard-webapply";
			retry.hidden =
				idle ||
				code === "clipboard-connecting" ||
				code === "warning:clipboard-webfiles" ||
				code === "warning:clipboard-webcontext";
			retry.textContent = apply
				? zh
					? "复制到本机"
					: "Copy locally"
				: denied
					? zh
						? "允许读取剪贴板"
						: "Allow clipboard access"
					: zh
						? "重试"
						: "Retry";
			note.textContent = idle
				? zh
					? "浏览器同步文本和 PNG 图片；文件和文件夹请用「文件传输」。"
					: "Sync text and PNG images. Use File transfer for files and folders."
				: code === "clipboard-connecting"
					? zh
						? "正在连接…"
						: "Connecting…"
					: (deps.message(code, zh) ?? (zh ? "剪贴板连接中断。" : "Clipboard connection interrupted."));
		},
	});
	function choose(next: ClipboardMode, interactive: boolean) {
		mode = readOnly ? (next === "both" ? "receive" : next === "send" ? "off" : next) : next;
		select.value = mode;
		for (const o of select.options)
			o.disabled = (readOnly && (o.value === "both" || o.value === "send")) || !sync.supported(o.value);
		manual.cancel();
		extra.hidden = mode !== "off" && sync.supported(mode);
		sync.set(connected ? mode : "off", interactive);
		if (!sync.supported("send") && !sync.supported("receive"))
			note.textContent = deps.message("warning:clipboard-webcontext", zh);
	}
	select.onchange = () => {
		if (!connected) return;
		const next = select.value as ClipboardMode;
		if (nestedTarget()) nestedModes.set(targetId, next);
		else preferences.write({ clipboard: next });
		choose(next, true);
	};
	retry.onclick = () => {
		if (!connected) return;
		if (lastCode === "warning:clipboard-webpermission" || lastCode === "warning:clipboard-webapply") sync.retry();
		else choose(mode, true);
	};
	select.disabled = true;
	return {
		cancel: manual.cancel,
		open() {
			if (!connected || (!sync.supported("send") && !sync.supported("receive"))) manual.open();
			else select.focus();
		},
		receive(data: any) {
			if (data?.type === "desktop-clipboard-available") {
				const on = data.connected === true,
					ro = data.viewOnly !== false;
				const reported =
					typeof data.deviceId === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(data.deviceId) ? data.deviceId : "";
				const switched = on && connected && reported !== targetId;
				if (on) targetId = reported;
				updateLink?.();
				const changed = on !== connected || ro !== readOnly || switched;
				connected = on;
				readOnly = ro;
				select.disabled = !on;
				if (changed)
					choose(
						nestedTarget() ? (nestedModes.get(targetId) ?? "off") : (preferences.read().clipboard ?? "off"),
						false,
					);
			}
			manual.receive(data);
			sync.receive(data);
		},
		close() {
			sync.stop();
			manual.close();
			bar.remove();
			extra.remove();
		},
	};
}
export function browserClipboardControls(options: Options) {
	return mount(options, dependencies);
}
/** The Hub portal and standalone viewer embed the same controller, outside remote iframes. */
export function browserClipboardFactoryScript() {
	return `(()=>{const __name=fn=>fn;return options=>(${mount.toString()})(options,{manual:${manualClipboardControls.toString()},sync:${webClipboardSync.toString()},message:${clipboardStatus.toString()},limits:${JSON.stringify(CLIPBOARD_LIMITS)},directions:${JSON.stringify(clipboardDirections)}})})()`;
}
