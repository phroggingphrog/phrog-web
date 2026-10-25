import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import test from "node:test";

const ROOT = process.cwd();

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return address.port;
}

async function waitForPort(port: number, child: ReturnType<typeof spawn>, diagnostics: () => string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (child.exitCode !== null) throw new Error(`Feynman MCP exited before listening: ${diagnostics()}`);
		try {
			await new Promise<void>((resolve, reject) => {
				const socket = connect(port, "127.0.0.1");
				socket.once("connect", () => { socket.destroy(); resolve(); });
				socket.once("error", reject);
			});
			return;
		} catch {
			await delay(25);
		}
	}
	throw new Error(`Feynman MCP did not listen: ${diagnostics()}`);
}

test("Feynman MCP accepts consecutive stateless HTTP requests", { timeout: 15_000 }, async () => {
	const workspace = await mkdtemp(join(tmpdir(), "feynman-mcp-http-"));
	const port = await unusedPort();
	const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "mcp", "--mcp-host", "127.0.0.1", "--mcp-port", String(port)], {
		cwd: ROOT,
		env: { ...process.env, FEYNMAN_MCP_WORKSPACE: workspace, FEYNMAN_TELEMETRY: "off" },
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
	try {
		const endpoint = `http://127.0.0.1:${port}/mcp`;
		await waitForPort(port, child, () => stderr);
		const post = async (message: Record<string, unknown>, initialized = false): Promise<Response> => fetch(endpoint, {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				...(initialized ? { "mcp-protocol-version": "2025-03-26" } : {}),
			},
			body: JSON.stringify(message),
		});
		const initialize = await post({
			jsonrpc: "2.0", id: 1, method: "initialize",
			params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "feynman-test", version: "1.0" } },
		});
		await initialize.arrayBuffer();
		assert.equal(initialize.status, 200, "initialize should succeed");

		const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, true);
		await initialized.arrayBuffer();
		assert.equal(initialized.status, 202, "initialized notification should be accepted");

		const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, true);
		const body = await tools.text();
		assert.equal(tools.status, 200, body);
		assert.match(body, /feynman_vault_status/);
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			await Promise.race([once(child, "exit"), delay(5_000)]);
			if (child.exitCode === null) child.kill("SIGKILL");
		}
		await rm(workspace, { recursive: true, force: true });
	}
});
