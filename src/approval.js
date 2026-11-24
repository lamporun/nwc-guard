// @ts-check
// Asking the wallet owner. A payment the rules flag (a new payee, a large
// amount) waits for an answer: on Telegram, with buttons, or in the terminal
// the guard runs in. No answer in time means no.

import { createInterface } from "node:readline";
import { KNOWN_NODES } from "./invoice.js";

/** @typedef {import("./guard.js").ApprovalRequest} ApprovalRequest */
/** @typedef {import("./guard.js").ApprovalAnswer} ApprovalAnswer */

/**
 * describe renders an approval request as a short message.
 *
 * @param {ApprovalRequest} r
 */
export function describe(r) {
	const payee = r.payeeName ? `${r.payeeName} (${r.payee.slice(0, 12)}…)` : `${r.payee.slice(0, 16)}…`;
	return [
		`Payment request from "${r.connection}"`,
		`${r.amountSat.toLocaleString("en-US")} sats to ${payee}`,
		r.via?.length
			? `Routed via ${r.via.map((k) => /** @type {Record<string, string>} */ (KNOWN_NODES)[k] ?? `${k.slice(0, 12)}…`).join(", ")}`
			: "",
		r.description ? `Invoice says: ${r.description}` : "",
		`Why you are asked: ${r.reason}`,
	]
		.filter(Boolean)
		.join("\n");
}

/** denyAll refuses everything that needs approval, for guards without one. */
export const denyAll = { ask: async () => /** @type {ApprovalAnswer} */ ("deny") };

/**
 * TerminalApprover asks on the terminal the guard runs in.
 */
export class TerminalApprover {
	/** @param {{ timeoutMs?: number, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [options] */
	constructor(options = {}) {
		this.timeoutMs = options.timeoutMs ?? 55_000;
		this.input = options.input ?? process.stdin;
		this.output = options.output ?? process.stdout;
		/** @type {Promise<unknown>} */
		this.queue = Promise.resolve();
	}

	/**
	 * @param {ApprovalRequest} request
	 * @returns {Promise<ApprovalAnswer>}
	 */
	ask(request) {
		// One question at a time.
		const run = this.queue.then(
			() =>
				new Promise((resolve) => {
					const rl = createInterface({ input: this.input, output: this.output });
					const timer = setTimeout(() => {
						rl.close();
						this.output.write("\nNo answer in time: denied.\n");
						resolve("deny");
					}, this.timeoutMs);
					rl.question(`\n${describe(request)}\nApprove? [y]es / [a]lways for this payee / [N]o: `, (line) => {
						clearTimeout(timer);
						rl.close();
						const a = line.trim().toLowerCase();
						resolve(a === "a" || a === "always" ? "approve-always" : a === "y" || a === "yes" ? "approve" : "deny");
					});
				}),
		);
		this.queue = run.catch(() => {});
		return /** @type {Promise<ApprovalAnswer>} */ (run);
	}
}

/**
 * TelegramApprover asks in a Telegram chat with inline buttons, and takes
 * /stop, /resume and /status from the same chat. It long-polls the bot's
 * updates, so the bot must be dedicated to the guard: two programs polling
 * one bot steal each other's updates.
 */
export class TelegramApprover {
	/**
	 * @param {{
	 *   token: string,
	 *   chatId: string,
	 *   timeoutMs?: number,
	 *   apiBase?: string,
	 *   fetchFn?: typeof fetch,
	 *   onCommand?: (command: string) => string,
	 * }} options
	 */
	constructor(options) {
		this.token = options.token;
		this.chatId = String(options.chatId);
		this.timeoutMs = options.timeoutMs ?? 55_000;
		this.apiBase = options.apiBase ?? "https://api.telegram.org";
		this.fetchFn = options.fetchFn ?? fetch;
		this.onCommand = options.onCommand ?? (() => "");
		/** @type {Map<string, { resolve: (a: ApprovalAnswer) => void, messageId: number, text: string }>} */
		this.pending = new Map();
		this.offset = 0;
		this.running = false;
		this.seq = 0;
	}

	/**
	 * call invokes a Bot API method.
	 *
	 * @param {string} method
	 * @param {Record<string, unknown>} body
	 * @param {number} [timeoutMs]
	 */
	async call(method, body, timeoutMs = 15_000) {
		const res = await this.fetchFn(`${this.apiBase}/bot${this.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const json = await res.json();
		if (!json.ok) {
			throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
		}
		return json.result;
	}

	/** @param {string} text */
	notify(text) {
		return this.call("sendMessage", { chat_id: this.chatId, text }).catch(() => {});
	}

	/** start begins polling for button presses and commands. */
	start() {
		if (this.running) {
			return;
		}
		this.running = true;
		void this.loop();
	}

	stop() {
		this.running = false;
	}

	async loop() {
		while (this.running) {
			try {
				const updates = await this.call(
					"getUpdates",
					{ offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
					35_000,
				);
				for (const update of updates) {
					this.offset = update.update_id + 1;
					await this.dispatch(update);
				}
			} catch {
				// A network hiccup: wait a little and poll again.
				await new Promise((r) => setTimeout(r, 3_000));
			}
		}
	}

	/** @param {any} update */
	async dispatch(update) {
		const query = update.callback_query;
		if (query) {
			if (String(query.message?.chat?.id) !== this.chatId) {
				return;
			}
			const [id, choice] = String(query.data ?? "").split(":");
			const wait = this.pending.get(id);
			await this.call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
			if (!wait) {
				return;
			}
			this.pending.delete(id);
			/** @type {ApprovalAnswer} */
			const answer = choice === "always" ? "approve-always" : choice === "yes" ? "approve" : "deny";
			const label = { approve: "✅ Approved", "approve-always": "✅ Approved, payee remembered", deny: "❌ Denied" }[answer];
			await this.call("editMessageText", { chat_id: this.chatId, message_id: wait.messageId, text: `${wait.text}\n\n${label}` }).catch(() => {});
			wait.resolve(answer);
			return;
		}
		const message = update.message;
		if (message && String(message.chat?.id) === this.chatId && typeof message.text === "string" && message.text.startsWith("/")) {
			const reply = this.onCommand(message.text.trim().split(/\s+/)[0].toLowerCase());
			if (reply) {
				await this.notify(reply);
			}
		}
	}

	/**
	 * @param {ApprovalRequest} request
	 * @returns {Promise<ApprovalAnswer>}
	 */
	async ask(request) {
		this.start();
		const id = `${Date.now().toString(36)}${(this.seq++).toString(36)}`;
		const text = describe(request);
		const sent = await this.call("sendMessage", {
			chat_id: this.chatId,
			text,
			reply_markup: {
				inline_keyboard: [
					[
						{ text: "✅ Approve", callback_data: `${id}:yes` },
						{ text: "✅ Always for this payee", callback_data: `${id}:always` },
					],
					[{ text: "❌ Deny", callback_data: `${id}:no` }],
				],
			},
		});
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					void this.call("editMessageText", { chat_id: this.chatId, message_id: sent.message_id, text: `${text}\n\n⌛ No answer in time: denied` }).catch(() => {});
					resolve("deny");
				}
			}, this.timeoutMs);
			this.pending.set(id, {
				messageId: sent.message_id,
				text,
				resolve: (answer) => {
					clearTimeout(timer);
					resolve(answer);
				},
			});
		});
	}
}
