/**
 * pi-image-fallback
 *
 * "Vision sidecar" for text-only models.
 *
 * pi's interactive paste (Ctrl+V) inserts an image as a *file path in the prompt
 * text* (e.g. /var/folders/.../pi-clipboard-<uuid>.png), not as an image content
 * block — so event.images is always empty for pasted images.
 *
 * When the active model is text-only and a turn references an image file, this
 * extension does NOT switch the session model. Instead it runs a one-shot
 * "describe this image" completion against the configured vision model
 * (modelRegistry.complete), reads the returned text, and injects it into the
 * turn's context as a message — so the text-only model "sees" the image as text.
 *
 * Benefits vs. model switching:
 * - No pi.setModel → settings.json defaultModel/provider are never touched.
 * - The text-only model stays active and its prompt cache stays warm.
 * - Descriptions persist as text in history, so follow-ups just work.
 *
 * Commands:
 *   /image-model            Open a searchable model picker (available models only)
 *   /image-model clear      Unset the vision model (disable the sidecar)
 *   /image-model status     Show the currently configured vision model
 *
 * Config persisted to ~/.pi/agent/image-fallback.json.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	Container,
	decodeKittyPrintable,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";

interface ModelRef {
	provider: string;
	id: string;
}

interface Config {
	imageModel?: ModelRef | null;
	/** Max wall-clock time per vision call before it is aborted. Default 90s. */
	timeoutMs?: number;
	/** Max completion tokens per vision call (reasoning + content). Default 1500. */
	maxTokens?: number;
}

// A stalled vision call (no response, no error) would otherwise hang the turn
// forever — the footer shows "describing…" and before_agent_start never
// resolves. AbortSignal.timeout() turns a stall into a caught error so the
// turn proceeds without a description (fail-open).
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TOKENS = 1500;

function configPath(): string {
	return join(getAgentDir(), "image-fallback.json");
}

const LOG_FILE = join(getAgentDir(), "image-fallback.log");
function log(...args: unknown[]): void {
	try {
		const dir = dirname(LOG_FILE);
		mkdirSync(dir, { recursive: true });
		const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`;
		appendFileSync(LOG_FILE, line);
	} catch {
		// logging must never break the hook
	}
}

function loadConfig(): Config {
	try {
		if (existsSync(configPath())) {
			const parsed = JSON.parse(readFileSync(configPath(), "utf-8"));
			if (parsed && typeof parsed === "object") return parsed;
		}
	} catch {
		// ignore corrupt/missing config
	}
	return {};
}

function saveConfig(config: Config): void {
	const target = configPath();
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, JSON.stringify(config, null, 2));
}

// Match image-file paths in the prompt. Handles both the no-space paste tokens
// (…/pi-clipboard-<uuid>.png) and rooted paths that contain spaces
// (~/Desktop/스크린샷 2026-…png). A path is either a root-led or slash-containing
// token (interior spaces allowed) or a bare no-space filename.
const IMAGE_PATH_RE =
	/(?:^|[\s"'(])((?:(?:~|\.{1,2}|[A-Za-z]:)[\/\\]|[\/\\]|[^\s"'<>()]+\/)[^"'<>()]*?\.(?:png|jpe?g|gif|webp|bmp|tiff?)|[^\s"'<>()]*\.(?:png|jpe?g|gif|webp|bmp|tiff?))(?=[\s"'<>),]|$)/i;

function imagePaths(prompt: string): string[] {
	const out: string[] = [];
	const re = new RegExp(IMAGE_PATH_RE.source, "gi");
	let m: RegExpExecArray | null;
	while ((m = re.exec(prompt)) !== null) {
		const p = m[1]?.replace(/\\ /g, " "); // unescape \-space shell escaping -> real space
		if (!p) continue;
		// Drop tokens that are just a suffix of a longer matched path (e.g. the
		// bare ".png" tail of a space-containing path) to avoid ENOENT noise.
		if (!out.some((other) => other.length > p.length && other.endsWith(p))) out.push(p);
	}
	return out;
}

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	tiff: "image/tiff",
	tif: "image/tiff",
};

function mimeForPath(p: string): string {
	const ext = p.split(".").pop()?.toLowerCase() ?? "";
	return MIME[ext] ?? "image/png";
}

export default function imageFallbackExtension(pi: ExtensionAPI) {
	const config = loadConfig();
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
	log("extension loaded, config=", JSON.stringify(config), "| timeoutMs=", timeoutMs, "| maxTokens=", maxTokens);

	// Cache descriptions per image path so re-referencing the same image (or a
	// follow-up) doesn't pay another vision round-trip.
	const descriptionCache = new Map<string, string>();

	function describeModel(model: Model<Api>): string {
		const parts: string[] = [];
		parts.push(model.input.includes("image") ? "vision" : "text-only");
		if (model.reasoning) parts.push("reasoning");
		return parts.join(" • ");
	}

	function resolveImageModel(ctx: ExtensionContext): Model<Api> | undefined {
		const ref = config.imageModel;
		if (!ref) return undefined;
		return ctx.modelRegistry.find(ref.provider, ref.id);
	}

	function updateStatus(ctx: ExtensionContext, suffix?: string): void {
		const ref = config.imageModel;
		const text = ref
			? ctx.ui.theme.fg("accent", suffix ? `img-fb:${ref.id} (${suffix})` : `img-fb:${ref.id}`)
			: undefined;
		ctx.ui.setStatus("image", text);
	}

	// Briefly show a transient state (e.g. ✓ done) then settle back to the plain
	// indicator, so the user sees each state transition.
	function flashStatus(ctx: ExtensionContext, suffix: string, delayMs = 1500): void {
		updateStatus(ctx, suffix);
		setTimeout(() => {
			try {
				updateStatus(ctx);
			} catch {
				// ignore
			}
		}, delayMs);
	}

	pi.on("session_start", (event, ctx) => {
		updateStatus(ctx);
	});

	// One-shot vision call: describe raw image bytes and return text.
	async function describeImageData(
		ctx: ExtensionContext,
		model: Model<Api>,
		data: Buffer,
		mimeType: string,
	): Promise<string> {
		const context: Context = {
			systemPrompt:
				"You are an image captioner. Describe the entire image accurately and completely. " +
				"Transcribe any visible text, code, tables, or UI labels verbatim. " +
				"Your reply is the only thing a text-only model will see, so leave nothing out.",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Describe this image in full detail." },
						{ type: "image", data: data.toString("base64"), mimeType },
					],
					timestamp: Date.now(),
				},
			],
		};
		const res = await ctx.modelRegistry.complete(model, context, {
			// Stall guard: without a signal, a hung upstream (e.g. OpenRouter
			// "processing" delays on reasoning models) blocks the turn forever.
			signal: AbortSignal.timeout(timeoutMs),
			// Cap output so a runaway reasoning pass can't balloon cost/latency.
			maxTokens,
		});
		const text = res.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text" && !!c.text)
			.map((c) => c.text);
		return text.join("\n").trim();
	}

	// One-shot vision call: describe a single image file and return text.
	async function describeImage(
		ctx: ExtensionContext,
		model: Model<Api>,
		filePath: string,
	): Promise<string> {
		return describeImageData(ctx, model, readFileSync(filePath), mimeForPath(filePath)); // throws if unreadable
	}

	// Describe a list of image paths, hitting the cache where possible.
	async function describePaths(
		ctx: ExtensionContext,
		model: Model<Api>,
		paths: string[],
	): Promise<string[]> {
		const descriptions: string[] = [];
		for (const p of paths) {
			try {
				if (descriptionCache.has(p)) {
					descriptions.push(descriptionCache.get(p)!);
					log("  cache hit", p);
					continue;
				}
				log("  describing", p);
				const txt = await describeImage(ctx, model, p);
				if (txt) {
					descriptionCache.set(p, txt);
					descriptions.push(txt);
					log("  described chars=", txt.length);
				}
			} catch (err) {
				const timedOut =
					err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
				log(timedOut ? `  describe timed out after ${timeoutMs}ms for` : "  describe failed for", p, String(err));
			}
		}
		return descriptions;
	}

	function buildBody(descriptions: string[]): string {
		return descriptions
			.map((d, i) => (descriptions.length > 1 ? `[이미지 ${i + 1} 내용]\n${d}` : d))
			.join("\n\n");
	}

	pi.on("before_agent_start", async (event, ctx) => {
		const current = ctx.model;
		if (!current) return;

		const img = resolveImageModel(ctx);
		const paths = imagePaths(event.prompt);
		log(
			"before_agent_start | current=",
			`${current.provider}/${current.id}`,
			"| input=",
			JSON.stringify(current.input),
			"| imagePaths=",
			paths.length,
			"| img=",
			img ? `${img.provider}/${img.id}` : "none",
		);

		// Multimodal model sees images natively — nothing to do.
		if (current.input.includes("image")) return;
		if (paths.length === 0) return;
		if (!img) {
			log("  image(s) but no sidecar model configured, skip");
			return;
		}

		// Live feedback while the vision sidecar works (turns would otherwise be
		// silent until the description arrives).
		updateStatus(ctx, "describing…");
		try {
			const descriptions = await describePaths(ctx, img, paths);
			if (descriptions.length === 0) return;

			flashStatus(ctx, "✓");
			log("  injecting description chars=", buildBody(descriptions).length);
			return {
				message: {
					customType: "image-description",
					content: buildBody(descriptions),
					// Internal-only context for the model — not shown in the transcript.
					display: false,
				},
			};
		} finally {
			updateStatus(ctx);
		}
	});

	// Cover the queued case: when the user submits an image while the agent is
	// mid-stream, pi injects it via steer()/followUp() and before_agent_start does
	// NOT fire. The input event DOES fire for those submissions (streamingBehavior
	// is set). The only way to reach the model here is to bake the description into
	// the message text, so it is visible in the transcript for queued images.
	pi.on("input", async (event, ctx) => {
		if (!event.streamingBehavior) return; // idle turns handled by before_agent_start
		const current = ctx.model;
		if (!current || current.input.includes("image")) return;
		const img = resolveImageModel(ctx);
		if (!img) return;
		const paths = imagePaths(event.text);
		if (paths.length === 0) return;

		log("input(queued) imagePaths=", paths.length, "| streamingBehavior=", event.streamingBehavior);
		updateStatus(ctx, "describing…");
		try {
			const descriptions = await describePaths(ctx, img, paths);
			if (descriptions.length === 0) return;
			flashStatus(ctx, "✓");
			// Queued (mid-stream) messages bypass before_agent_start, and injecting a
			// hidden display:false custom message via steer was experimentally flaky
			// (the model sometimes didn't receive it). Baking into the visible text is
			// deterministic, so queued descriptions show in the transcript.
			log("  injected queued description chars=", buildBody(descriptions).length);
			return {
				action: "transform",
				text: `${event.text}\n\n[이미지 내용]\n${buildBody(descriptions)}`,
			};
		} finally {
			updateStatus(ctx);
		}
	});

	// ---- Agent-loop images (read tool) ----
	// When the model calls read on an image, pi's tool result is a text note plus
	// an image content block, and for text-only models the image is dropped
	// ("The image will be omitted from this request."). Remember the file path per
	// toolCallId so we can describe the ORIGINAL file (higher fidelity than the
	// possibly-resized base64 in the message) and reuse the paste-path cache.
	const readToolPaths = new Map<string, { path: string; cwd: string }>();

	pi.on("tool_execution_start", (event, ctx) => {
		if (event.toolName === "read" && typeof event.args?.path === "string") {
			if (readToolPaths.size > 500) readToolPaths.clear(); // bound the map
			readToolPaths.set(event.toolCallId, { path: event.args.path, cwd: ctx.cwd });
		}
	});

	// Describe one image content block found in a tool result. Prefers the original
	// file (via the read-tool path correlation); falls back to the base64 data in
	// the message. Cache key = resolved file path or a sha1 of the data.
	async function describeToolResultImage(
		ctx: ExtensionContext,
		model: Model<Api>,
		block: { type: "image"; data: string; mimeType: string },
		ref: { path: string; cwd: string } | undefined,
	): Promise<{ text: string }> {
		const abs = ref ? (isAbsolute(ref.path) ? ref.path : join(ref.cwd, ref.path)) : undefined;
		if (abs) {
			const hit = descriptionCache.get(abs);
			if (hit) return { text: hit };
			try {
				const text = await describeImage(ctx, model, abs);
				descriptionCache.set(abs, text);
				return { text };
			} catch (err) {
				log("  tool-result file describe failed for", abs, String(err));
			}
		}
		const dataKey = `data:${createHash("sha1").update(block.data).digest("hex")}`;
		const dataHit = descriptionCache.get(dataKey);
		if (dataHit) return { text: dataHit };
		const text = await describeImageData(
			ctx,
			model,
			Buffer.from(block.data, "base64"),
			block.mimeType ?? "image/png",
		);
		descriptionCache.set(dataKey, text);
		return { text };
	}

	// Replace image blocks in a read tool result with a text description, so the
	// text-only model "sees" the image in the agent loop. The replacement is
	// applied in-place before persistence, so it lands in session history and
	// follow-ups just work (same philosophy as the paste path).
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "toolResult") return;
		const current = ctx.model;
		if (!current || current.input.includes("image")) return;
		const img = resolveImageModel(ctx);
		if (!img) return;

		const imageBlocks = msg.content.filter(
			(c): c is { type: "image"; data: string; mimeType: string } => c.type === "image",
		);
		if (imageBlocks.length === 0) return;

		const ref = readToolPaths.get(msg.toolCallId);
		readToolPaths.delete(msg.toolCallId);

		updateStatus(ctx, "describing…");
		try {
			const descriptions: string[] = [];
			for (const block of imageBlocks) {
				try {
					const { text } = await describeToolResultImage(ctx, img, block, ref);
					if (text) {
						descriptions.push(text);
						log("  tool-result described chars=", text.length);
					}
				} catch (err) {
					log("  tool-result describe failed:", String(err));
				}
			}
			if (descriptions.length === 0) return;

			flashStatus(ctx, "✓");
			// Keep the original text note ("Read image file [image/png]") but drop the
			// "image will be omitted" line — the image is no longer omitted.
			const keptText = msg.content.filter(
				(c): c is { type: "text"; text: string } =>
					c.type === "text" && !c.text.includes("The image will be omitted"),
			);
			const descText = { type: "text" as const, text: buildBody(descriptions) };
			log("  replacing toolResult image blocks chars=", buildBody(descriptions).length);
			return { message: { ...msg, content: [...keptText, descText] } };
		} finally {
			updateStatus(ctx);
		}
	});

	pi.registerCommand("image-model", {
		description:
			"Set the vision sidecar model used to describe images for a text-only model",
		getArgumentCompletions(prefix: string) {
			return ["clear", "status"]
				.filter((c) => c.startsWith(prefix))
				.map((c) => ({ value: c, label: c, description: "image-model subcommand" }));
		},
		async handler(args, ctx) {
			const arg = args.trim();

			if (arg === "clear") {
				config.imageModel = null;
				saveConfig(config);
				updateStatus(ctx);
				ctx.ui.notify("Image sidecar model cleared", "info");
				return;
			}

			if (arg === "status") {
				const ref = config.imageModel;
				ctx.ui.notify(
					ref
						? `Image sidecar model: ${ref.provider}/${ref.id}`
						: "Image sidecar model: not set",
					"info",
				);
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("Use /image-model in an interactive session to pick a model", "info");
				return;
			}

			const models = ctx.modelRegistry.getAvailable();
			if (models.length === 0) {
				ctx.ui.notify("No available models (check API keys)", "warning");
				return;
			}

			const current = ctx.model;
			const setRef = config.imageModel;

			const sorted = [...models].sort((a, b) => {
				const av = a.input.includes("image") ? 0 : 1;
				const bv = b.input.includes("image") ? 0 : 1;
				if (av !== bv) return av - bv;
				return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
			});

			const items: SelectItem[] = sorted.map((m) => {
				const key = `${m.provider}/${m.id}`;
				const displayName = m.name && m.name !== m.id ? m.name : key;
				const tags: string[] = [key, describeModel(m)];
				if (current && current.id === m.id) tags.push("current");
				if (setRef && setRef.id === m.id && setRef.provider === m.provider) tags.push("set");
				return {
					value: key,
					label: displayName,
					description: tags.join(" • "),
				};
			});

			const result = await ctx.ui.custom<string | null>(
				(tui, theme, kb, done) => {
					let filter = "";
					let list = buildList();

					function filterItems(all: SelectItem[], query: string): SelectItem[] {
						const terms = query
							.toLowerCase()
							.split(/\s+/)
							.filter(Boolean);
						if (terms.length === 0) return all;
						return all.filter((item) => {
							const haystack = `${item.value} ${item.label}`.toLowerCase();
							return terms.every((t) => haystack.includes(t));
						});
					}

					function buildList(): SelectList {
						const filtered = filterItems(items, filter);
						const l = new SelectList(filtered, Math.min(Math.max(filtered.length, 1), 12), {
							selectedPrefix: (text) => theme.fg("accent", text),
							selectedText: (text) => theme.fg("accent", text),
							description: (text) => theme.fg("muted", text),
							scrollInfo: (text) => theme.fg("dim", text),
							noMatch: (text) => theme.fg("warning", text),
						});
						l.onSelect = (item) => done(item.value);
						l.onCancel = () => done(null);
						return l;
					}

					return {
						render(width: number) {
							const container = new Container();
							container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
							container.addChild(
								new Text(theme.fg("accent", theme.bold("Select image sidecar model"))),
							);
							container.addChild(
								new Text(theme.fg("dim", `filter: ${filter || "(type to search)"}`)),
							);
							container.addChild(list);
							container.addChild(
								new Text(
									theme.fg(
										"dim",
										"type to search • ↑↓ navigate • enter select • backspace clear • esc cancel",
									),
								),
							);
							container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
							return container.render(width);
						},
						invalidate() {
							list.invalidate();
						},
						handleInput(data: string) {
							const kitty = decodeKittyPrintable(data);
							const printable = kitty !== undefined ? kitty : data;
							const hasControl = [...printable].some((ch) => {
								const code = ch.charCodeAt(0);
								return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
							});
							if (!hasControl && printable.length > 0) {
								filter += printable;
								list = buildList();
								return;
							}
							if (kb.matches(data, "tui.editor.deleteCharBackward")) {
								filter = filter.slice(0, -1);
								list = buildList();
								return;
							}
							list.handleInput(data);
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						width: "80%",
						maxHeight: "70%",
					},
				},
			);

			if (!result) return;

			const slash = result.indexOf("/");
			if (slash === -1) return;
			const provider = result.slice(0, slash);
			const id = result.slice(slash + 1);
			config.imageModel = { provider, id };
			saveConfig(config);
			updateStatus(ctx);
			ctx.ui.notify(`Image sidecar → ${provider}/${id}`, "info");
		},
	});
}
