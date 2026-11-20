import type { ClipboardMode, CLIPBOARD_LIMITS } from "./desktop-clipboard-protocol.js";

/** Runs in the trusted, focused controller page. The sandboxed player only carries channel packets. */
export function webClipboardSync(options: {
	post: (data: object) => void;
	status: (code: string) => void;
	limits: typeof CLIPBOARD_LIMITS;
}) {
	const win = Reflect.get(globalThis, "window") as any;
	const doc = win.document;
	const api = win.navigator.clipboard;
	const limits = options.limits;
	const focused = () => doc.visibilityState === "visible" && doc.hasFocus();
	const canSend = Boolean(win.isSecureContext && win.crypto?.subtle && (api?.read || api?.readText));
	const canReceive = Boolean(win.isSecureContext && win.crypto?.subtle && (api?.write || api?.writeText));
	const hash = async (bytes: Uint8Array) =>
		Array.from(new Uint8Array(await win.crypto.subtle.digest("SHA-256", bytes)), (v) =>
			v.toString(16).padStart(2, "0"),
		).join("");
	type Content = { mime: string; bytes: Uint8Array; digest: string };
	let active: { id: string; stop(): void; receive(value: any): void; retry(): void } | undefined;
	const supported = (mode: ClipboardMode) =>
		((mode !== "send" && mode !== "both") || canSend) && ((mode !== "receive" && mode !== "both") || canReceive);
	function stop() {
		const previous = active;
		active = undefined;
		previous?.stop();
	}
	function set(mode: ClipboardMode, interactive: boolean) {
		stop();
		if (mode === "off") return options.status("clipboard-off");
		if (!supported(mode)) return options.status("warning:clipboard-webcontext");
		const id = win.crypto.randomUUID();
		const reading = mode !== "receive",
			writing = mode !== "send";
		const current = () => active?.id === id;
		const post = (payload: object) => options.post({ type: "desktop-clipboard", channel: id, payload });
		const status = (code: string) => {
			if (current()) options.status(code);
		};
		let ready = false,
			stream = false,
			busyRead = false,
			busyWrite = false,
			dirty = false,
			readBlocked = false,
			revision = 0;
		let last: string | undefined;
		let pending: Content | undefined;
		let incoming:
			{ id: string; seq: number; mime: string; data: Uint8Array; offset: number; digest: string } | undefined;
		let outgoing:
			{ id: string; content: Content; seq: number; offset: number; acks: Set<number>; committed: boolean } | undefined;
		let timer: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
		const key = (v: Content) => v.mime + ":" + v.digest;
		function notifyReady() {
			if (dirty && current() && reading && focused() && !readBlocked && !pending && !incoming && !outgoing)
				queueMicrotask(sample);
			status(
				pending ? "warning:clipboard-webapply" : readBlocked ? "warning:clipboard-webpermission" : "clipboard-ready",
			);
		}
		function discard(transferId: string, code: string) {
			if (incoming?.id === transferId) incoming = undefined;
			if (outgoing?.id === transferId) outgoing = undefined;
			if (stream) post({ type: "abort", id: transferId });
			else {
				stop();
				options.status(code);
				return;
			}
			status(code);
		}
		function arm() {
			clearTimeout(deadline);
			if (!incoming && !outgoing) return;
			deadline = setTimeout(() => {
				if (!current()) return;
				if (incoming) discard(incoming.id, "warning:clipboard-timeout");
				if (outgoing) discard(outgoing.id, "warning:clipboard-timeout");
			}, limits.timeout);
		}
		function pump() {
			const out = outgoing;
			if (!out || out.committed) return;
			while (out.acks.size < (stream ? 8 : 1) && out.offset < out.content.bytes.length) {
				const chunk = out.content.bytes.subarray(out.offset, out.offset + limits.chunk);
				const offset = out.offset,
					seq = ++out.seq;
				out.offset += chunk.length;
				out.acks.add(seq);
				post({
					type: "chunk",
					id: out.id,
					item: 0,
					offset,
					data: btoa(String.fromCharCode(...chunk)),
					...(stream ? { seq } : {}),
				});
			}
			if (!out.acks.size && out.offset === out.content.bytes.length) {
				out.committed = true;
				const seq = ++out.seq;
				out.acks.add(seq);
				post({ type: "commit", id: out.id, ...(stream ? { seq } : {}) });
			}
			arm();
		}
		async function readContent(): Promise<Content | undefined> {
			let blob: Blob;
			if (api.read) {
				const items: { types: string[]; getType(mime: string): Promise<Blob> }[] = await api.read();
				if (!current()) return;
				const item =
					items.find((i) => i.types.includes("image/png")) ?? items.find((i) => i.types.includes("text/plain"));
				if (!item || (item.types.includes("text/uri-list") && !item.types.includes("image/png"))) return;
				blob = await item.getType(item.types.includes("image/png") ? "image/png" : "text/plain");
			} else blob = new Blob([await api.readText()], { type: "text/plain" });
			const mime = blob.type.split(";")[0];
			if (mime !== "image/png" && mime !== "text/plain") return;
			if (blob.size > (mime === "image/png" ? limits.image : limits.text)) throw new RangeError();
			const bytes =
				mime === "text/plain"
					? new TextEncoder().encode((await blob.text()).replace(/\r\n/g, "\n"))
					: new Uint8Array(await blob.arrayBuffer());
			return { mime, bytes, digest: await hash(bytes) };
		}
		async function sample() {
			if (
				!current() ||
				!reading ||
				!focused() ||
				busyRead ||
				busyWrite ||
				readBlocked ||
				incoming ||
				outgoing ||
				pending
			)
				return;
			const stamp = revision;
			dirty = false;
			busyRead = true;
			try {
				const v = await readContent();
				if (!current() || stamp !== revision || !focused()) return;
				const signature = v ? key(v) : "";
				if (last === undefined || !ready) {
					last = signature;
					return;
				}
				if (signature === last) return;
				last = signature;
				if (!v) return;
				const transferId = win.crypto.randomUUID();
				outgoing = { id: transferId, content: v, offset: 0, seq: 0, acks: new Set([0]), committed: false };
				const image = v.mime === "image/png";
				post({
					type: "offer",
					id: transferId,
					kind: image ? "image" : "text",
					items: [{ name: image ? "image.png" : "text.txt", size: v.bytes.length, sha256: v.digest }],
					...(stream ? { seq: 0 } : {}),
				});
				arm();
			} catch (e) {
				if (!current()) return;
				if (e instanceof RangeError) status("warning:clipboard-size");
				else {
					readBlocked = true;
					status("warning:clipboard-webpermission");
				}
			} finally {
				busyRead = false;
				if (dirty && current() && ready && !outgoing && !pending) queueMicrotask(sample);
			}
		}
		async function apply(v: Content) {
			if (!current() || !writing) return;
			pending = v;
			if (!focused() || busyWrite) {
				status("warning:clipboard-webapply");
				return;
			}
			busyWrite = true;
			revision++;
			try {
				if (v.mime === "text/plain" && api.writeText) await api.writeText(new TextDecoder().decode(v.bytes));
				else if (api.write && win.ClipboardItem)
					await api.write([new win.ClipboardItem({ [v.mime]: new win.Blob([v.bytes], { type: v.mime }) })]);
				else throw new Error("unsupported type");
				if (!current()) return;
				if (pending === v) pending = undefined;
				last = key(v);
				// Browsers can re-encode a PNG when writing it. Suppress this local write's echo.
				if (reading && !readBlocked && v.mime === "image/png") {
					try {
						const normalized = await readContent();
						if (normalized && current()) last = key(normalized);
					} catch {}
				}
				notifyReady();
			} catch {
				status("warning:clipboard-webapply");
			} finally {
				busyWrite = false;
				if (current() && pending && pending !== v && focused()) void apply(pending);
			}
		}
		const focus = () => {
			if (focused()) {
				if (pending) void apply(pending);
				else void sample();
			}
		};
		const change = () => {
			dirty = true;
			void sample();
		};
		let chain = Promise.resolve(),
			queued = 0;
		async function receive(v: any) {
			if (!current() || !v) return;
			if (v.type === "clipboard-capabilities") {
				stream = v.streamFiles === true;
				return;
			}
			if (v.type === "clipboard-ready") {
				ready = true;
				clearTimeout(deadline);
				notifyReady();
				return;
			}
			if (v.type === "clipboard-stopped" || (v.type === "clipboard-error" && !v.recoverable)) {
				stop();
				options.status("clipboard-unavailable");
				return;
			}
			if (v.type === "clipboard-error") {
				if (typeof v.code === "string") status("warning:" + v.code);
				return;
			}
			if (!ready || typeof v.id !== "string" || !/^[a-f\d-]{36}$/.test(v.id)) return;
			if (v.type === "abort") {
				if (outgoing?.id === v.id) outgoing = undefined;
				if (incoming?.id === v.id) incoming = undefined;
				arm();
				return;
			}
			if (v.type === "ack") {
				const out = outgoing;
				if (!out || v.id !== out.id) return;
				const seq = stream ? v.seq : out.acks.values().next().value;
				if (!out.acks.delete(seq)) return;
				if (out.committed) {
					outgoing = undefined;
					arm();
					notifyReady();
				} else pump();
				return;
			}
			if (!writing) return;
			if (v.type === "offer") {
				if (v.kind === "files") {
					discard(v.id, "warning:clipboard-webfiles");
					return;
				}
				const item = v.items?.[0];
				const mime = v.kind === "image" ? "image/png" : v.kind === "text" ? "text/plain" : "";
				if (
					!mime ||
					incoming ||
					!Array.isArray(v.items) ||
					v.items.length !== 1 ||
					!item ||
					!Number.isSafeInteger(item.size) ||
					item.size < 0 ||
					item.size > (mime === "image/png" ? limits.image : limits.text) ||
					typeof item.sha256 !== "string" ||
					!/^[a-f\d]{64}$/.test(item.sha256) ||
					(stream && v.seq !== 0)
				)
					return discard(v.id, "warning:clipboard-size");
				incoming = { id: v.id, seq: 0, mime, data: new Uint8Array(item.size), offset: 0, digest: item.sha256 };
				revision++;
			} else {
				const inc = incoming;
				if (!inc || inc.id !== v.id) return;
				if (stream && v.seq !== ++inc.seq) return discard(v.id, "warning:clipboard-integrity");
				if (v.type === "chunk") {
					if (
						v.item !== 0 ||
						v.offset !== inc.offset ||
						typeof v.data !== "string" ||
						!v.data.length ||
						v.data.length > Math.ceil(limits.chunk / 3) * 4
					)
						return discard(v.id, "warning:clipboard-integrity");
					const raw = atob(v.data);
					if (inc.offset + raw.length > inc.data.length) return discard(v.id, "warning:clipboard-integrity");
					for (let i = 0; i < raw.length; i++) inc.data[inc.offset++] = raw.charCodeAt(i);
				} else if (v.type === "commit") {
					if (inc.offset !== inc.data.length || (await hash(inc.data)) !== inc.digest)
						return discard(v.id, "warning:clipboard-integrity");
					if (!current()) return;
					if (inc.mime === "image/png") {
						const d = new DataView(inc.data.buffer);
						if (
							d.byteLength < 33 ||
							d.getUint32(0) !== 0x89504e47 ||
							d.getUint32(4) !== 0x0d0a1a0a ||
							d.getUint32(12) !== 0x49484452
						)
							return discard(v.id, "warning:clipboard-integrity");
						const w = d.getUint32(16),
							h = d.getUint32(20);
						if (!w || !h || w > 16384 || h > 16384 || w * h > 32 * 1024 * 1024)
							return discard(v.id, "warning:clipboard-size");
					}
					incoming = undefined;
					await apply({ mime: inc.mime, bytes: inc.data, digest: inc.digest });
				} else return;
			}
			if (current()) {
				post({ type: "ack", id: v.id, ...(stream ? { seq: v.seq } : {}) });
				arm();
			}
		}
		active = {
			id,
			stop() {
				clearInterval(timer);
				clearTimeout(deadline);
				api?.removeEventListener?.("clipboardchange", change);
				win.removeEventListener("focus", focus);
				doc.removeEventListener("visibilitychange", focus);
				post({ type: "bridge-stop" });
				outgoing = incoming = pending = undefined;
			},
			receive(v) {
				if (++queued > limits.window + 6) {
					stop();
					options.status("clipboard-unavailable");
					return;
				}
				chain = chain
					.then(() => receive(v))
					.catch(() => {
						if (current()) {
							stop();
							options.status("clipboard-unavailable");
						}
					})
					.finally(() => {
						queued--;
					});
			},
			retry() {
				if (pending) void apply(pending);
				if (reading && readBlocked) {
					readBlocked = false;
					void sample().then(() => {
						if (current() && !readBlocked) notifyReady();
					});
				}
			},
		};
		status("clipboard-connecting");
		if (reading) {
			if (interactive) void sample();
			else {
				readBlocked = true;
				void Promise.resolve()
					.then(() => win.navigator.permissions?.query({ name: "clipboard-read" }))
					.then((p: any) => {
						if (!current() || p?.state !== "granted") return;
						readBlocked = false;
						void sample();
					})
					.catch(() => {});
			}
			if ("onclipboardchange" in api) api.addEventListener("clipboardchange", change);
			else timer = setInterval(change, 1100);
		}
		win.addEventListener("focus", focus);
		doc.addEventListener("visibilitychange", focus);
		post({
			type: "bridge-start",
			mode,
			capabilities: { streamFiles: true, maxFileBytes: limits.bytes, browserMedia: true },
		});
		deadline = setTimeout(() => {
			if (current() && !ready) {
				stop();
				options.status("clipboard-unavailable");
			}
		}, 15000);
	}
	return {
		set,
		supported,
		stop,
		retry: () => active?.retry(),
		receive(data: any) {
			if (active && data?.type === "desktop-clipboard" && data.channel === active.id) active.receive(data.payload);
		},
	};
}
