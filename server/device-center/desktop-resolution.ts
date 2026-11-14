/** Pure, shared with the standalone player. The requested box never stretches the desktop. */
export function desktopResolution(
	mode: string,
	width: number,
	height: number,
	sourceWidth: number,
	sourceHeight: number,
	viewportEdge: number,
	limit = 2560,
) {
	limit = limit === 4096 ? 4096 : 2560;
	let edge: number;
	if (mode === "window") edge = viewportEdge;
	else if (mode === "native") edge = Math.max(sourceWidth, sourceHeight) || viewportEdge;
	else {
		if (mode !== "custom") {
			const match = /^(\d{3,4})x(\d{3,4})$/.exec(mode);
			if (!match) return;
			width = Number(match[1]);
			height = Number(match[2]);
		}
		if (![width, height].every((v) => Number.isInteger(v) && v >= 320 && v <= 4096)) return;
		edge =
			sourceWidth > 0 && sourceHeight > 0
				? Math.max(sourceWidth, sourceHeight) * Math.min(width / sourceWidth, height / sourceHeight, 1)
				: Math.max(width, height);
	}
	return Math.max(640, Math.min(limit, Math.floor(edge / 2) * 2));
}
