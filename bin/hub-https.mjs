import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { httpsPlan } from "./hub-https-install.mjs";
import { writeAtomicFileSync } from "./lib/atomic-file.mjs";
import { randomUUID } from "node:crypto";

export function automaticHttps(publicUrl, platform = process.platform) {
	if (platform !== "linux") return false;
	try {
		const url = new URL(publicUrl);
		url.protocol = "https:";
		httpsPlan({ publicUrl: url.origin, upstream: "http://127.0.0.1:8790" });
		return true;
	} catch {
		return false;
	}
}
export function secureHubSettings(saved, publicUrl) {
	const source = publicUrl || saved.PI_DEVICE_HUB_PUBLIC_URL;
	const url = new URL(source);
	if (url.origin !== source || url.username || url.password || !["http:", "https:"].includes(url.protocol))
		throw Error("HTTPS public URL must be a canonical HTTP(S) origin");
	if (url.protocol === "http:") {
		url.protocol = "https:";
		url.port = "";
	}
	const input = {
		publicUrl: url.origin,
		upstream: "http://127.0.0.1:" + saved.PI_DEVICE_HUB_PORT,
		serviceName: saved.PI_DEVICE_HUB_SERVICE_NAME || "pi-device-hub",
	};
	const plan = httpsPlan(input);
	if (plan.port === Number(saved.PI_DEVICE_HUB_PORT))
		throw Error("The HTTPS port must differ from the internal Hub port (default HTTPS 443, Hub 8790)");
	const legacy = JSON.parse(saved.PI_DEVICE_HUB_LEGACY_ORIGINS || "[]");
	if (saved.PI_DEVICE_HUB_PUBLIC_URL.startsWith("http:")) legacy.push(saved.PI_DEVICE_HUB_PUBLIC_URL);
	return {
		input,
		settings: {
			...saved,
			PI_DEVICE_HUB_PUBLIC_URL: plan.publicUrl,
			PI_DEVICE_HUB_LEGACY_ORIGINS: JSON.stringify([...new Set(legacy)]),
			PI_DEVICE_HUB_HTTPS: "managed",
		},
	};
}
async function privileged(file, signal) {
	const script = fileURLToPath(new URL("./hub-https-install.mjs", import.meta.url));
	const root = process.getuid?.() === 0;
	const child = spawn(
		root ? process.execPath : "sudo",
		root
			? [script, "--apply", file]
			: [...(process.stdin.isTTY ? [] : ["-n"]), process.execPath, script, "--apply", file],
		{ stdio: "inherit", signal },
	);
	const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
	try {
		await new Promise((r, j) => {
			child.on("error", j);
			child.on("exit", (code) =>
				code === 0 ? r() : j(Error("HTTPS certificate/proxy installation failed (" + code + ")")),
			);
		});
	} finally {
		clearTimeout(timer);
	}
}
export async function enableHubHttps({
	plan,
	publicUrl,
	run,
	probe,
	wait,
	signal,
	log = console.log,
	install = privileged,
	verify = fetch,
}) {
	if (process.platform !== "linux" && install === privileged)
		throw Error(
			"Managed HTTPS currently supports Linux systemd. Use --https=external with your HTTPS proxy on other platforms",
		);
	const original = await readFile(plan.config, "utf8"),
		saved = JSON.parse(original);
	const current = await probe(saved);
	if (!current || current.instanceId !== saved.PI_DEVICE_HUB_INSTANCE_ID)
		throw Error("HTTPS setup requires the installed, owned Hub to be running");
	const { input, settings } = secureHubSettings(saved, publicUrl);
	const file = join(plan.root, "https-install.json");
	await writeFile(file, JSON.stringify(input), { mode: 0o600 });
	log("Configuring trusted HTTPS and automatic certificate renewal. Administrator access may be requested.");
	await install(file, signal);
	const save = async (text) => writeAtomicFileSync(plan.config, text, { nonce: randomUUID(), mode: 0o600 });
	try {
		signal?.throwIfAborted();
		await save(JSON.stringify(settings, null, 2) + "\n");
		for (const args of plan.commands.restart) run(plan.manager, args);
		await wait(settings);
		const response = await verify(settings.PI_DEVICE_HUB_PUBLIC_URL + "/health", {
			signal: AbortSignal.timeout(15000),
		});
		const health = await response.json();
		if (!response.ok || health.service !== "pi-device-hub" || health.instanceId !== saved.PI_DEVICE_HUB_INSTANCE_ID)
			throw Error("HTTPS endpoint does not identify this Hub");
		log("HTTPS ready: " + settings.PI_DEVICE_HUB_PUBLIC_URL);
		return settings;
	} catch (error) {
		await save(original);
		for (const args of plan.commands.restart) run(plan.manager, args);
		await wait(saved, true);
		throw Error(
			"HTTPS verification failed; restored the previous Hub configuration. Check public TCP 443/cloud firewall and certificate trust. " +
				error.message,
		);
	}
}
