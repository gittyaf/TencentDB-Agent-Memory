import http from "node:http";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { URL as URL$1 } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, openSync } from "node:fs";
import net from "node:net";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
//#region lib/gateway-client.ts
/**
* HTTP client for the TDAI Gateway, with Bearer token authentication and
* silent-failure semantics suitable for cc hook handlers (any error returns
* an empty / no-op response rather than throwing). Failures are also
* appended to an optional log file so the daemon's health can be diagnosed
* via /memory-status without re-attaching a debugger.
*/
var GatewayClient = class {
	baseUrl;
	token;
	timeoutMs;
	logPath;
	constructor(config) {
		this.baseUrl = new URL$1(config.baseUrl);
		this.token = config.token;
		this.timeoutMs = config.timeoutMs ?? 5e3;
		this.logPath = config.logPath;
	}
	async logFailure(method, path, detail) {
		if (!this.logPath) return;
		try {
			await appendFile(this.logPath, `[${(/* @__PURE__ */ new Date()).toISOString()}] gateway-client ${method} ${path}: ${detail}\n`);
		} catch {}
	}
	describeStatus(status, body) {
		return `HTTP ${status} ${body.length > 200 ? body.slice(0, 200) + "…" : body}`;
	}
	async health() {
		try {
			const { status, body } = await this.request("GET", "/health");
			if (status === 200) return true;
			await this.logFailure("GET", "/health", this.describeStatus(status, body));
			return false;
		} catch (err) {
			await this.logFailure("GET", "/health", err instanceof Error ? err.message : String(err));
			return false;
		}
	}
	async recall(query, sessionKey) {
		try {
			const { status, body } = await this.request("POST", "/recall", {
				query,
				session_key: sessionKey
			});
			if (status !== 200) {
				await this.logFailure("POST", "/recall", this.describeStatus(status, body));
				return { context: "" };
			}
			const parsed = JSON.parse(body);
			return {
				context: parsed.context ?? "",
				strategy: parsed.strategy,
				memory_count: parsed.memory_count
			};
		} catch (err) {
			await this.logFailure("POST", "/recall", err instanceof Error ? err.message : String(err));
			return { context: "" };
		}
	}
	async captureTurn(payload) {
		try {
			const { status, body } = await this.request("POST", "/capture", payload);
			if (status !== 200) {
				await this.logFailure("POST", "/capture", this.describeStatus(status, body));
				return null;
			}
			return JSON.parse(body);
		} catch (err) {
			await this.logFailure("POST", "/capture", err instanceof Error ? err.message : String(err));
			return null;
		}
	}
	async searchMemories(query, opts) {
		try {
			const { status, body } = await this.request("POST", "/search/memories", {
				query,
				limit: opts?.limit,
				type: opts?.type,
				scene: opts?.scene
			});
			if (status !== 200) {
				await this.logFailure("POST", "/search/memories", this.describeStatus(status, body));
				return {
					results: "",
					total: 0
				};
			}
			return JSON.parse(body);
		} catch (err) {
			await this.logFailure("POST", "/search/memories", err instanceof Error ? err.message : String(err));
			return {
				results: "",
				total: 0
			};
		}
	}
	async searchConversations(query, opts) {
		try {
			const { status, body } = await this.request("POST", "/search/conversations", {
				query,
				limit: opts?.limit,
				session_key: opts?.sessionKey
			});
			if (status !== 200) {
				await this.logFailure("POST", "/search/conversations", this.describeStatus(status, body));
				return {
					results: "",
					total: 0
				};
			}
			return JSON.parse(body);
		} catch (err) {
			await this.logFailure("POST", "/search/conversations", err instanceof Error ? err.message : String(err));
			return {
				results: "",
				total: 0
			};
		}
	}
	async sessionEnd(sessionKey) {
		try {
			const { status, body } = await this.request("POST", "/session/end", { session_key: sessionKey });
			if (status !== 200) await this.logFailure("POST", "/session/end", this.describeStatus(status, body));
		} catch (err) {
			await this.logFailure("POST", "/session/end", err instanceof Error ? err.message : String(err));
		}
	}
	request(method, path, bodyObj) {
		return new Promise((resolve, reject) => {
			const bodyStr = bodyObj ? JSON.stringify(bodyObj) : void 0;
			const headers = {};
			if (this.token) headers.Authorization = `Bearer ${this.token}`;
			if (bodyStr) {
				headers["Content-Type"] = "application/json";
				headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
			}
			const opts = {
				protocol: this.baseUrl.protocol,
				hostname: this.baseUrl.hostname,
				port: this.baseUrl.port,
				method,
				path,
				headers
			};
			const req = http.request(opts, (res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({
					status: res.statusCode ?? 0,
					body: Buffer.concat(chunks).toString("utf-8")
				}));
			});
			req.setTimeout(this.timeoutMs, () => {
				req.destroy(/* @__PURE__ */ new Error(`Timeout after ${this.timeoutMs}ms`));
			});
			req.on("error", reject);
			if (bodyStr) req.write(bodyStr);
			req.end();
		});
	}
};
//#endregion
//#region lib/session-key.ts
/**
* Compute a stable session key for a given working directory.
*
* Default: SHA-256 of the normalized absolute path, first 16 hex chars (64 bits).
* Override: TDAI_SESSION_KEY env var, if non-empty.
*
* Used by hook handlers to partition memory by project rather than by
* Claude Code session, so multiple cc terminals on the same project share
* recall results.
*/
function getSessionKey(cwd) {
	const override = process.env.TDAI_SESSION_KEY;
	if (override && override.length > 0) return override;
	const normalized = resolve(cwd);
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
//#endregion
//#region lib/transcript.ts
/**
* Parse cc transcript jsonl files defensively. cc's transcript format is
* NOT a documented stable API — fields may rename across versions. This
* module returns null on any unexpected shape rather than throwing.
*/
/**
* Parse a single JSONL line. Returns null on malformed or unrecognized shape.
*/
function parseTranscriptLine(line) {
	let obj;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}
	if (!obj || typeof obj !== "object") return null;
	const o = obj;
	const type = typeof o.type === "string" ? o.type : null;
	if (!type) return null;
	const message = o.message;
	if (!message || typeof message !== "object") return null;
	const role = typeof message.role === "string" ? message.role : type;
	const content = extractContent(message.content);
	if (content === null) return null;
	return {
		type,
		role,
		content,
		contentIsArray: Array.isArray(message.content),
		uuid: typeof o.uuid === "string" ? o.uuid : void 0,
		parentUuid: typeof o.parentUuid === "string" ? o.parentUuid : void 0,
		timestamp: typeof o.timestamp === "string" ? o.timestamp : void 0
	};
}
function extractContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts = [];
		for (const item of content) {
			if (!item || typeof item !== "object") continue;
			const it = item;
			if (typeof it.text === "string") parts.push(it.text);
		}
		return parts.length > 0 ? parts.join("\n") : null;
	}
	return null;
}
/**
* Read ALL complete user+assistant turns from a transcript. Each turn
* merges multi-part assistant responses (split by tool cycles) into a
* single string, same as {@link readLatestTurn}.
*/
async function readAllTurns(path) {
	let raw;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return [];
	}
	const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
	if (lines.length === 0) return [];
	const turns = [];
	let currentUser = null;
	let assistantParts = [];
	for (const line of lines) {
		const entry = parseTranscriptLine(line);
		if (!entry) continue;
		if (entry.role === "user" && !entry.contentIsArray) {
			if (currentUser !== null && assistantParts.length > 0) turns.push({
				user: currentUser,
				assistant: assistantParts.join("\n\n")
			});
			currentUser = entry.content;
			assistantParts = [];
		} else if (entry.role === "assistant" && entry.content) assistantParts.push(entry.content);
	}
	if (currentUser !== null && assistantParts.length > 0) turns.push({
		user: currentUser,
		assistant: assistantParts.join("\n\n")
	});
	return turns;
}
//#endregion
//#region lib/daemon.ts
/**
* Daemon manager — spawns the TdaiGateway as a long-lived sidecar bound
* to the parent cc process. Mirrors the supervisor.py pattern from
* hermes-plugin/.
*/
const DEFAULT_PORT_START = 8421;
const DEFAULT_PORT_END = 8430;
const STATE_FILE = "state.json";
async function readDaemonState(dataDir) {
	const path = join(dataDir, STATE_FILE);
	if (!existsSync(path)) return null;
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
async function writeDaemonState(dataDir, state) {
	await mkdir(dataDir, { recursive: true });
	const tmp = join(dataDir, `${STATE_FILE}.tmp`);
	const final = join(dataDir, STATE_FILE);
	await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 384 });
	await rename(tmp, final);
}
async function clearDaemonState(dataDir) {
	const path = join(dataDir, STATE_FILE);
	try {
		await unlink(path);
	} catch {}
}
var DaemonManager = class {
	dataDir;
	portStart;
	portEnd;
	constructor(config) {
		this.dataDir = config.dataDir;
		this.portStart = config.portStart ?? DEFAULT_PORT_START;
		this.portEnd = config.portEnd ?? DEFAULT_PORT_END;
	}
	async generateToken() {
		await mkdir(this.dataDir, { recursive: true });
		const token = randomBytes(32).toString("base64url");
		const tokenPath = join(this.dataDir, "token");
		await writeFile(tokenPath, token, { mode: 384 });
		return tokenPath;
	}
	async readToken(tokenPath) {
		if (!tokenPath) return "";
		try {
			await stat(tokenPath);
		} catch {
			return "";
		}
		const st = await stat(tokenPath);
		if (process.platform !== "win32" && (st.mode & 63) !== 0) throw new Error(`Token file permission too loose: ${tokenPath}`);
		if (process.platform !== "win32" && typeof process.getuid === "function") {
			const uid = process.getuid();
			if (st.uid !== uid) throw new Error(`Token file owner mismatch: expected uid=${uid}, got uid=${st.uid} for ${tokenPath}`);
		}
		return (await readFile(tokenPath, "utf-8")).trim();
	}
	async findFreePort(start = this.portStart, end = this.portEnd) {
		for (let p = start; p <= end; p++) if (await this.isPortFree(p)) return p;
		throw new Error(`No free port in ${start}..${end}`);
	}
	isPortFree(port) {
		return new Promise((resolve) => {
			const tester = net.createServer();
			tester.once("error", () => resolve(false));
			tester.once("listening", () => {
				tester.close(() => resolve(true));
			});
			tester.listen(port, "127.0.0.1");
		});
	}
	async probe() {
		const state = await readDaemonState(this.dataDir);
		if (!state) return false;
		let token;
		try {
			token = await this.readToken(state.tokenPath);
		} catch {
			return false;
		}
		return this.healthCheck(state.port, token);
	}
	healthCheck(port, token, timeoutMs = 2e3) {
		return new Promise((resolve) => {
			const headers = {};
			if (token) headers.Authorization = `Bearer ${token}`;
			const req = http.request({
				host: "127.0.0.1",
				port,
				path: "/health",
				method: "GET",
				headers
			}, (res) => resolve(res.statusCode === 200));
			req.setTimeout(timeoutMs, () => {
				req.destroy();
				resolve(false);
			});
			req.on("error", () => resolve(false));
			req.end();
		});
	}
	/**
	* Probe well-known ports for a gateway that was started externally (e.g.
	* by CodeBuddy, another Claude session, or manually). If found, write a
	* state.json so subsequent hooks can reuse it without re-probing.
	*/
	async discoverExternalGateway() {
		for (let port = this.portStart; port <= this.portEnd; port++) if (await this.healthCheck(port, "", 1500)) {
			const state = {
				pid: 0,
				port,
				ccPid: 0,
				startedAt: "external",
				tokenPath: ""
			};
			await writeDaemonState(this.dataDir, state);
			return state;
		}
		return null;
	}
	async ensureRunning(ccPid) {
		const reuseExisting = async () => {
			const existing = await readDaemonState(this.dataDir);
			if (!existing) return null;
			if (existing.ccPid !== 0 && existing.ccPid !== ccPid) return null;
			let token = "";
			try {
				token = await this.readToken(existing.tokenPath);
			} catch {
				return null;
			}
			if (await this.healthCheck(existing.port, token)) return existing;
			const deadline = Date.now() + 1e4;
			while (Date.now() < deadline) {
				await sleep(500);
				if (await this.healthCheck(existing.port, token)) return existing;
			}
			return null;
		};
		const reused = await reuseExisting();
		if (reused) return reused;
		const discovered = await this.discoverExternalGateway();
		if (discovered) return discovered;
		const lock = await this.acquireSpawnLock();
		if (!lock) {
			const deadline = Date.now() + 35e3;
			while (Date.now() < deadline) {
				await sleep(500);
				const r = await reuseExisting();
				if (r) return r;
			}
			throw new Error("daemon spawn lock contention timed out");
		}
		try {
			const r = await reuseExisting();
			if (r) return r;
			const d = await this.discoverExternalGateway();
			if (d) return d;
			return await this.spawn(ccPid);
		} finally {
			await lock.release();
		}
	}
	/**
	* Returns a held lock handle, or null if another process owns the lock.
	* Stale locks (>60s old) are forcibly broken so a crashed hook never wedges
	* the daemon-up path.
	*/
	async acquireSpawnLock() {
		await mkdir(this.dataDir, { recursive: true });
		const lockPath = join(this.dataDir, "spawn.lock");
		const tryCreate = async () => {
			try {
				const fh = await open(lockPath, "wx");
				await fh.write(`${process.pid}\n`);
				await fh.close();
				return { release: async () => {
					try {
						await unlink(lockPath);
					} catch {}
				} };
			} catch (err) {
				if (err.code === "EEXIST") return null;
				throw err;
			}
		};
		const first = await tryCreate();
		if (first) return first;
		try {
			const st = await stat(lockPath);
			if (Date.now() - st.mtimeMs > 6e4) {
				await unlink(lockPath).catch(() => {});
				return tryCreate();
			}
		} catch {
			return tryCreate();
		}
		return null;
	}
	/**
	* Spawn the Gateway daemon by invoking `npx tdai-memory-gateway`.
	*
	* The user must have `@tencentdb-agent-memory/memory-tencentdb` installed,
	* either globally (`npm install -g`) or in the current project (which exposes
	* the `tdai-memory-gateway` bin via npx's PATH resolution).
	*/
	async spawn(ccPid) {
		const port = await this.findFreePort();
		const tokenPath = await this.generateToken();
		const token = await this.readToken(tokenPath);
		const command = process.env.TDAI_GATEWAY_COMMAND ?? "npx";
		const args = process.env.TDAI_GATEWAY_COMMAND ? [] : ["--yes", "tdai-memory-gateway"];
		const childEnv = {
			...process.env,
			TDAI_GATEWAY_PORT: String(port),
			TDAI_CC_PID: String(ccPid),
			TDAI_TOKEN_PATH: tokenPath,
			TDAI_DATA_DIR: process.env.TDAI_DATA_DIR ?? this.dataDir
		};
		delete childEnv.TDAI_GATEWAY_TOKEN;
		await mkdir(this.dataDir, { recursive: true });
		const logPath = join(this.dataDir, "daemon.log");
		let logFd = "ignore";
		try {
			logFd = openSync(logPath, "a");
		} catch {}
		const isWindows = process.platform === "win32";
		const child = spawn(command, args, {
			env: childEnv,
			cwd: this.dataDir,
			detached: true,
			shell: isWindows,
			stdio: [
				"ignore",
				logFd,
				logFd
			]
		});
		child.unref();
		if (!child.pid) throw new Error("Failed to spawn daemon: child has no pid");
		const pendingState = {
			pid: child.pid,
			port,
			ccPid,
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			tokenPath
		};
		await writeDaemonState(this.dataDir, pendingState);
		const deadline = Date.now() + 3e4;
		while (Date.now() < deadline) {
			if (await this.healthCheck(port, token, 500)) return pendingState;
			await sleep(200);
		}
		await clearDaemonState(this.dataDir);
		throw new Error(`Daemon did not become healthy on port ${port} within 30s`);
	}
};
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
//#endregion
//#region lib/hook.ts
/**
* Unified hook entry point. Dispatched by the first CLI arg.
*
* Usage from cc plugin hook config:
*   node ${CLAUDE_PLUGIN_ROOT}/dist/lib/hook.mjs <event-name>
*
* Where <event-name> is one of:
*   session-start | user-prompt-submit | post-tool-use | stop |
*   search | status | clear-session
*/
const MAX_INJECT_CHARS = 1e4;
const MAX_CAPTURE_TURNS = 50;
async function handleHook(event, input) {
	const data = parseStdin(input.stdin);
	switch (event) {
		case "session-start": return handleSessionStart(data, input.client);
		case "user-prompt-submit": return handleUserPromptSubmit(data, input.client);
		case "post-tool-use": return handlePostToolUse(data, input.client);
		case "stop": return handleStop(data, input.client);
		case "search": return handleSearch(input.args ?? [], input.client);
		case "search-stdin": return handleSearchStdin(input.stdin, input.client);
		case "status": return handleStatus(input.client);
		case "clear-session": return handleClearSession(data, input.client);
		default: return "";
	}
}
function parseStdin(raw) {
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}
async function handleSessionStart(_data, client) {
	await client.health();
	return "";
}
async function handleUserPromptSubmit(data, client) {
	const prompt = data.prompt ?? "";
	const cwd = data.cwd ?? process.cwd();
	if (!prompt) return "";
	const sessionKey = getSessionKey(cwd);
	let context = (await client.recall(prompt, sessionKey)).context ?? "";
	if (!context) {
		const conv = await client.searchConversations(prompt, {
			limit: 3,
			sessionKey
		});
		if (conv.total > 0 && conv.results) context = `## Past conversations (relevant to current prompt)\n\n${conv.results}`;
	}
	if (!context) {
		const dataDir = process.env.TDAI_DATA_DIR;
		if (dataDir) context = await searchL0JsonlDirect(join(dataDir, "conversations"), prompt, sessionKey, 3);
	}
	if (!context) return "";
	if (context.length > MAX_INJECT_CHARS) context = context.slice(0, MAX_INJECT_CHARS - 100) + "\n\n[…recall truncated — use /memory-search for full results…]";
	return JSON.stringify({ hookSpecificOutput: {
		hookEventName: "UserPromptSubmit",
		additionalContext: context
	} });
}
async function handlePostToolUse(_data, _client) {
	return "";
}
async function handleStop(data, client) {
	if (data.stop_hook_active === true) return "";
	if (!data.transcript_path) return "";
	await waitForTranscriptStable(data.transcript_path, 2e3);
	const allTurns = await readAllTurns(data.transcript_path);
	if (allTurns.length === 0) return "";
	const dataDir = resolveDataDir();
	const cursorId = sanitizeCursorId(data.session_id ?? (basename(data.transcript_path).replace(/\.jsonl$/, "") || "default"));
	const lastSent = await readCursor(dataDir, cursorId);
	let newTurns = allTurns.slice(lastSent);
	if (newTurns.length === 0) return "";
	if (newTurns.length > MAX_CAPTURE_TURNS) newTurns = newTurns.slice(-MAX_CAPTURE_TURNS);
	const sessionKey = getSessionKey(data.cwd ?? process.cwd());
	const messages = newTurns.flatMap((t) => [{
		role: "user",
		content: t.user
	}, {
		role: "assistant",
		content: t.assistant
	}]);
	const lastTurn = newTurns[newTurns.length - 1];
	await client.captureTurn({
		user_content: lastTurn.user,
		assistant_content: lastTurn.assistant,
		messages,
		session_key: sessionKey,
		session_id: data.session_id
	});
	await writeCursor(dataDir, cursorId, allTurns.length);
	return "";
}
async function waitForTranscriptStable(path, maxMs) {
	const start = Date.now();
	let lastSize = -1;
	let stableTicks = 0;
	while (Date.now() - start < maxMs) {
		try {
			const st = await stat(path);
			if (st.size === lastSize) {
				stableTicks++;
				if (stableTicks >= 2) return;
			} else {
				stableTicks = 0;
				lastSize = st.size;
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
}
function resolveDataDir() {
	return process.env.CLAUDE_PLUGIN_DATA ?? join(homedir(), ".tdai-memory");
}
function sanitizeCursorId(id) {
	return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "default";
}
async function readCursor(dataDir, cursorId) {
	try {
		const raw = await readFile(join(dataDir, "cursors", `${cursorId}.json`), "utf-8");
		const obj = JSON.parse(raw);
		return typeof obj.lastSentIndex === "number" && obj.lastSentIndex >= 0 ? obj.lastSentIndex : 0;
	} catch {
		return 0;
	}
}
async function writeCursor(dataDir, cursorId, lastSentIndex) {
	const dir = join(dataDir, "cursors");
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `${cursorId}.json.tmp`);
	const final = join(dir, `${cursorId}.json`);
	await writeFile(tmp, JSON.stringify({
		lastSentIndex,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	}), { mode: 384 });
	await rename(tmp, final);
}
async function handleSearch(args, client) {
	const query = args.join(" ").trim();
	if (!query) return "Usage: /memory-search <query>";
	return (await client.searchMemories(query, { limit: 10 })).results || "No memories found.";
}
/**
* Read the query from stdin instead of argv. Used by the memory-search skill
* to avoid the cc `$ARGUMENTS` literal-replaceAll RCE surface (see Anthropic
* GH issue #16163) — when the query rides on stdin it never touches a shell
* word-split or expansion stage.
*/
async function handleSearchStdin(rawStdin, client) {
	const query = rawStdin.trim();
	if (!query) return "Usage: pipe the query to stdin";
	return (await client.searchMemories(query, { limit: 10 })).results || "No memories found.";
}
async function handleStatus(client) {
	const ok = await client.health();
	const dataDir = resolveDataDir();
	const hookLog = join(dataDir, "hook.log");
	const daemonLog = join(dataDir, "daemon.log");
	return `${ok ? "TDAI memory daemon: healthy" : "TDAI memory daemon: unreachable"}\nhook log:   ${hookLog}\ndaemon log: ${daemonLog}`;
}
async function handleClearSession(data, client) {
	const sessionKey = getSessionKey(data.cwd ?? process.cwd());
	await client.sessionEnd(sessionKey);
	return `Cleared session buffer for: ${sessionKey}`;
}
async function searchL0JsonlDirect(convDir, query, sessionKey, limit) {
	let files;
	try {
		files = (await readdir(convDir)).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return "";
	}
	if (files.length === 0) return "";
	const withMtime = await Promise.all(files.map(async (f) => {
		try {
			return {
				name: f,
				mtime: (await stat(join(convDir, f))).mtimeMs
			};
		} catch {
			return {
				name: f,
				mtime: 0
			};
		}
	}));
	withMtime.sort((a, b) => b.mtime - a.mtime);
	const sortedFiles = withMtime.map((e) => e.name);
	const CJK_STOP = new Set([
		"之前",
		"前聊",
		"聊的",
		"还记",
		"记得",
		"得么",
		"得吗",
		"一下",
		"怎么",
		"什么",
		"关于",
		"知道",
		"以前",
		"上次",
		"如何",
		"为何",
		"为啥",
		"哪里",
		"哪些",
		"为什",
		"请问",
		"请帮",
		"帮我",
		"麻烦"
	]);
	const keywords = [];
	for (const seg of query.toLowerCase().replace(/[^\w一-鿿]/g, " ").split(/\s+/)) {
		if (!seg) continue;
		if (/[一-鿿]/.test(seg)) for (let i = 0; i <= seg.length - 2; i++) {
			const gram = seg.slice(i, i + 2);
			if (!CJK_STOP.has(gram)) keywords.push(gram);
		}
		else if (seg.length >= 2) keywords.push(seg);
	}
	if (keywords.length === 0) return "";
	const matches = [];
	const seen = /* @__PURE__ */ new Set();
	for (const f of sortedFiles) {
		let rl;
		try {
			rl = createInterface({
				input: createReadStream(join(convDir, f), { encoding: "utf-8" }),
				crlfDelay: Infinity
			});
		} catch {
			continue;
		}
		try {
			for await (const line of rl) {
				if (!line.trim()) continue;
				try {
					const rec = JSON.parse(line);
					if (rec.sessionKey !== sessionKey) continue;
					const text = rec.content ?? "";
					const textLower = text.toLowerCase();
					const hits = keywords.filter((kw) => textLower.includes(kw)).length;
					if (hits === 0) continue;
					const fingerprint = text.slice(0, 120);
					if (seen.has(fingerprint)) continue;
					seen.add(fingerprint);
					matches.push({
						role: rec.role ?? "unknown",
						content: text.length > 2e3 ? text.slice(0, 2e3) + "…" : text,
						recordedAt: rec.recordedAt ?? "",
						hits
					});
				} catch {}
			}
		} finally {
			rl.close();
		}
	}
	if (matches.length === 0) return "";
	const rolePriority = (r) => r === "assistant" ? 1 : 0;
	matches.sort((a, b) => rolePriority(b.role) - rolePriority(a.role) || b.hits - a.hits || b.content.length - a.content.length);
	const selected = matches.slice(0, limit);
	const lines = [`Found ${selected.length} matching conversation(s):`, ""];
	for (const m of selected) {
		lines.push("---");
		lines.push(`**[${m.role}]** ${m.recordedAt}`);
		lines.push("");
		lines.push(m.content);
		lines.push("");
	}
	return `## Past conversations (relevant to current prompt)\n\n${lines.join("\n")}`;
}
async function main() {
	const event = process.argv[2] ?? "";
	const args = process.argv.slice(3);
	const dataDir = resolveDataDir();
	const logPath = join(dataDir, "hook.log");
	try {
		const stdin = await readStdin();
		const mgr = new DaemonManager({ dataDir });
		let state = await readDaemonState(dataDir);
		if (!state && event === "session-start") try {
			state = await mgr.ensureRunning(process.ppid);
		} catch (err) {
			await safeLog(logPath, `session-start: spawn failed: ${err.message}`);
		}
		if (!state) try {
			state = await mgr.discoverExternalGateway();
			if (state) await safeLog(logPath, `${event}: discovered external gateway on port ${state.port}`);
		} catch {}
		if (!state) {
			await safeLog(logPath, `${event}: no daemon, skipped`);
			return;
		}
		const token = await mgr.readToken(state.tokenPath);
		const out = await handleHook(event, {
			stdin,
			client: new GatewayClient({
				baseUrl: `http://127.0.0.1:${state.port}`,
				token,
				timeoutMs: event === "user-prompt-submit" ? 4e3 : 1e4,
				logPath
			}),
			args
		});
		if (out) process.stdout.write(out);
	} catch (err) {
		await safeLog(logPath, `${event}: ${err.message}`);
	}
}
function readStdin() {
	return new Promise((resolve) => {
		if (process.stdin.isTTY) {
			resolve("");
			return;
		}
		const chunks = [];
		process.stdin.on("data", (c) => chunks.push(c));
		process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		process.stdin.on("error", () => resolve(""));
	});
}
async function safeLog(path, msg) {
	try {
		await appendFile(path, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}\n`);
	} catch {}
}
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) main().catch(() => process.exit(0));
//#endregion
export { handleHook };
