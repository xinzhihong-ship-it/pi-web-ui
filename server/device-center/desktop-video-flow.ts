/** Receiver-paced video. The minimum measured round trip estimates propagation;
 * excess delay is queueing. Both the map and the allowed window are bounded. */
export class DesktopVideoFlow {
	private pending = new Map<number, number>();
	private sizes = new Map<number, number>();
	private pendingBytes = 0;
	private deliveryAt = 0;
	private deliveryRate = 0;
	private progress = 0;
	private sequence = 0;
	private baseline = Infinity;
	private latestAck = 0;
	private lastSample: number | undefined;
	private sampleAck = Infinity;
	private sampleDecode = Infinity;
	private lastAdjustment = -Infinity;
	private good = 0;
	private bad = 0;
	private qualityScale = 1;
	private fpsScale = 1;
	ackMs = 0;
	queueMs = 0;
	measured = false;
	constructor(private readonly options: { deliveryBudgetMs?: number } = {}) {}
	private window(fps: number) {
		return Math.min(
			64,
			Math.max(3, Math.ceil((((Number.isFinite(this.baseline) ? this.baseline : 60) + 24) * fps) / 1000)),
		);
	}
	blocked(fps: number, bytes = 0) {
		if (this.options.deliveryBudgetMs !== undefined && bytes > 0) {
			// A frame's first ACK includes serialization, not just network propagation.
			// Never multiply that delay by the requested FPS to fill a slow link with
			// seconds of JPEGs. Grow from two frames using actual acknowledged bytes.
			if (!this.deliveryRate) return this.pending.size >= 2;
			const budget = Math.max(2 * bytes, this.deliveryRate * (this.baseline + this.options.deliveryBudgetMs));
			if (this.pending.size && this.pendingBytes + bytes > budget) return true;
		}
		return this.pending.size >= this.window(fps);
	}
	get count() {
		return this.pending.size;
	}
	get oldest() {
		return this.pending.values().next().value as number | undefined;
	}
	get progressAt() {
		return this.pending.size ? this.progress : undefined;
	}
	frame(now: number, bytes = 0) {
		if (this.pending.size >= 128) throw new Error("Video feedback window exceeded");
		if (!this.pending.size) this.progress = this.deliveryAt = now;
		const id = ++this.sequence;
		this.pending.set(id, now);
		this.sizes.set(id, bytes);
		this.pendingBytes += bytes;
		return id;
	}
	reset() {
		this.pending.clear();
		this.sizes.clear();
		this.pendingBytes = 0;
		// A replacement encoder has startup/keyframe latency, not steady-state load.
		this.lastSample = undefined;
		this.sampleAck = this.sampleDecode = Infinity;
		this.bad = this.good = 0;
	}
	ack(id: number, decodeQueue: number, now: number) {
		if (!Number.isSafeInteger(id) || !Number.isInteger(decodeQueue) || decodeQueue < 0 || decodeQueue > 128)
			return false;
		const sentAt = this.pending.get(id);
		if (id <= this.latestAck || sentAt === undefined) return false;
		this.latestAck = id;
		let delivered = 0;
		for (const key of this.pending.keys()) {
			if (key <= id) {
				delivered += this.sizes.get(key) ?? 0;
				this.sizes.delete(key);
				this.pending.delete(key);
			}
		}
		this.pendingBytes -= delivered;
		if (delivered && now > this.deliveryAt) {
			const rate = delivered / (now - this.deliveryAt);
			this.deliveryRate =
				!this.deliveryRate || rate < this.deliveryRate ? rate : this.deliveryRate * 0.75 + rate * 0.25;
		}
		this.progress = this.deliveryAt = now;
		this.ackMs = Math.max(0, now - sentAt);
		this.measured = true;
		this.baseline = Math.min(this.baseline, this.ackMs);
		this.queueMs = Math.max(0, this.ackMs - this.baseline);
		this.sampleAck = Math.min(this.sampleAck, this.ackMs);
		this.sampleDecode = Math.min(this.sampleDecode, decodeQueue);
		if (this.lastSample === undefined) this.lastSample = now;
		if (now - this.lastSample < 1000) return true;
		this.lastSample = now;
		// ACKs arrive in bursts over mobile/WAN links. Sampling only the first
		// ACK each second mistakes a recovered burst for persistent congestion,
		// repeatedly reconfiguring encoders that need a restart for every change.
		const queued = Math.max(0, this.sampleAck - this.baseline),
			decoded = this.sampleDecode;
		this.sampleAck = this.sampleDecode = Infinity;
		this.bad = queued > 80 || decoded > 3 ? this.bad + 1 : 0;
		this.good = queued < 30 && decoded < 2 ? this.good + 1 : 0;
		if (now - this.lastAdjustment < 3000) return true;
		// Reduce encoder bitrate first; lower capture FPS only after quality reaches its floor.
		if (this.bad >= 2 || queued > 250 || decoded > 8) {
			if (this.qualityScale > 0.6) this.qualityScale = Math.max(0.6, this.qualityScale * 0.85);
			else this.fpsScale = Math.max(0.25, this.fpsScale * 0.8);
			this.lastAdjustment = now;
			this.bad = this.good = 0;
		} else if (this.good >= 8) {
			if (this.fpsScale < 1) this.fpsScale = Math.min(1, this.fpsScale + 0.1);
			else this.qualityScale = Math.min(1, this.qualityScale + 0.1);
			this.lastAdjustment = now;
			this.good = 0;
		}
		return true;
	}
	profile<T extends { fps: number; quality: number }>(base: T, automatic: boolean): T {
		return automatic
			? {
					...base,
					fps: Math.max(5, Math.round(base.fps * this.fpsScale)),
					quality: Math.max(35, Math.round(base.quality * this.qualityScale)),
				}
			: base;
	}
}
