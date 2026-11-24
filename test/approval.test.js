// @ts-check
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import { describe, TelegramApprover, TerminalApprover } from "../src/approval.js";

const REQUEST = { connection: "agent", amountSat: 1_000, payee: `02${"ab".repeat(32)}`, payeeName: undefined, description: "bundle", reason: "new payee" };

/** @type {Array<() => void>} */
let cleanups = [];
afterEach(() => {
	for (const c of cleanups) c();
	cleanups = [];
});

/** fakeTelegram serves the few Bot API methods the approver uses. */
async function fakeTelegram() {
	const sent = /** @type {any[]} */ ([]);
	const edits = /** @type {any[]} */ ([]);
	/** @type {any[]} */
	let queue = [];
	let updateId = 1;
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", async () => {
			const body = raw ? JSON.parse(raw) : {};
			const method = String(req.url).split("/").pop();
			const reply = (/** @type {unknown} */ result) => res.end(JSON.stringify({ ok: true, result }));
			if (method === "sendMessage") {
				sent.push(body);
				return reply({ message_id: sent.length });
			}
			if (method === "editMessageText") {
				edits.push(body);
				return reply(true);
			}
			if (method === "answerCallbackQuery") return reply(true);
			if (method === "getUpdates") {
				for (let i = 0; i < 20 && queue.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
				const out = queue;
				queue = [];
				return reply(out);
			}
			res.end(JSON.stringify({ ok: false, description: "unknown method" }));
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
	cleanups.push(() => server.close());
	const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
	return {
		apiBase: `http://127.0.0.1:${port}`,
		sent,
		edits,
		/** @param {string} chatId @param {string} data */
		press: (chatId, data) => queue.push({ update_id: updateId++, callback_query: { id: "q", data, message: { chat: { id: Number(chatId) }, message_id: 1 } } }),
		/** @param {string} chatId @param {string} text */
		say: (chatId, text) => queue.push({ update_id: updateId++, message: { chat: { id: Number(chatId) }, text } }),
	};
}

/** @param {() => boolean} cond */
async function until(cond) {
	for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

test("describe says who, how much, through whom and why", () => {
	const text = describe({ ...REQUEST, payeeName: "lampo.run", via: ["021c97a90a411ff2b10dc2a8e32de2f29d2fa49d41bfbb52bd416e460db0747d0d"] });
	assert.match(text, /Routed via Lightning Labs Loop/);
	assert.match(text, /1,000 sats to lampo\.run \(02abababab/);
	assert.match(text, /Why you are asked: new payee/);
});

test("Telegram: the owner's button decides, presses from other chats are ignored", async () => {
	const tg = await fakeTelegram();
	const approver = new TelegramApprover({ token: "T", chatId: "42", apiBase: tg.apiBase, timeoutMs: 5_000 });
	cleanups.push(() => approver.stop());
	const answer = approver.ask(REQUEST);
	await until(() => tg.sent.length === 1);
	const buttons = tg.sent[0].reply_markup.inline_keyboard.flat().map((/** @type {any} */ b) => b.callback_data);
	const id = buttons[0].split(":")[0];
	tg.press("999", `${id}:yes`);
	tg.press("42", `${id}:always`);
	assert.equal(await answer, "approve-always");
	await until(() => tg.edits.length === 1);
	assert.match(tg.edits[0].text, /Approved, payee remembered/);
});

test("Telegram: no answer in time is a denial", async () => {
	const tg = await fakeTelegram();
	const approver = new TelegramApprover({ token: "T", chatId: "42", apiBase: tg.apiBase, timeoutMs: 150 });
	cleanups.push(() => approver.stop());
	assert.equal(await approver.ask(REQUEST), "deny");
	await until(() => tg.edits.length === 1);
	assert.match(tg.edits[0].text, /No answer in time/);
});

test("Telegram: /stop from the owner's chat reaches the guard", async () => {
	const tg = await fakeTelegram();
	const commands = /** @type {string[]} */ ([]);
	const approver = new TelegramApprover({
		token: "T",
		chatId: "42",
		apiBase: tg.apiBase,
		onCommand: (c) => (commands.push(c), "paused"),
	});
	cleanups.push(() => approver.stop());
	approver.start();
	tg.say("7", "/stop");
	tg.say("42", "/stop");
	await until(() => commands.length === 1 && tg.sent.length === 1);
	assert.deepEqual(commands, ["/stop"]);
	assert.equal(tg.sent[0].text, "paused");
});

test("terminal: y approves, a remembers, anything else denies", async () => {
	for (const [typed, expected] of [["y", "approve"], ["always", "approve-always"], ["", "deny"], ["sure", "deny"]]) {
		const input = new PassThrough();
		const output = new PassThrough();
		const approver = new TerminalApprover({ input, output, timeoutMs: 2_000 });
		const answer = approver.ask(REQUEST);
		input.write(`${typed}\n`);
		assert.equal(await answer, expected, `typed ${JSON.stringify(typed)}`);
	}
});
