// @ts-check
// The decision core. Every request an agent sends to its guarded connection
// comes through Guard.handle, which applies the connection's rules, asks a
// human when the rules say so, and only then forwards the request to the
// real wallet. Answers use NIP-47 error codes, so agents and their tools see
// an ordinary wallet that said no, with a reason.

import { parseInvoice } from "./invoice.js";

/**
 * @typedef {{
 *   maxSatsPerPayment: number,
 *   budgets: { hour: number, day: number },
 *   maxPaymentsPerMinute: number,
 *   payees: { mode: "any" | "allowlist" | "ask", allow: string[], names?: Record<string, string> },
 *   approveAbove: number | null,
 *   allowAmountless: boolean,
 *   allowGetBalance: boolean,
 *   allowMakeInvoice: boolean,
 * }} Rules
 */

/** @type {Rules} */
export const DEFAULT_RULES = {
	maxSatsPerPayment: 1_000,
	budgets: { hour: 3_000, day: 10_000 },
	maxPaymentsPerMinute: 5,
	payees: { mode: "ask", allow: [], names: {} },
	approveAbove: null,
	allowAmountless: false,
	allowGetBalance: true,
	allowMakeInvoice: true,
};

/**
 * withDefaults fills in any rule a connection's config leaves out.
 *
 * @param {Partial<Rules> | undefined} rules
 * @returns {Rules}
 */
export function withDefaults(rules = {}) {
	return {
		...DEFAULT_RULES,
		...rules,
		budgets: { ...DEFAULT_RULES.budgets, ...(rules.budgets ?? {}) },
		payees: {
			...DEFAULT_RULES.payees,
			...(rules.payees ?? {}),
			allow: [...(rules.payees?.allow ?? [])],
			names: { ...(rules.payees?.names ?? {}) },
		},
	};
}

/**
 * NwcError is a NIP-47 error answer.
 */
export class NwcError extends Error {
	/**
	 * @param {string} code a NIP-47 error code
	 * @param {string} message
	 */
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/**
 * @typedef {{
 *   connection: string,
 *   amountSat: number,
 *   payee: string,
 *   payeeName: string | undefined,
 *   description: string,
 *   reason: string,
 *   via?: string[],
 * }} ApprovalRequest
 *
 * @typedef {"approve" | "approve-always" | "deny"} ApprovalAnswer
 *
 * @typedef {{ ask(request: ApprovalRequest): Promise<ApprovalAnswer> }} Approver
 *
 * @typedef {{
 *   payInvoice(r: { invoice: string, amount?: number }): Promise<{ preimage: string, fees_paid?: number }>,
 *   getBalance(): Promise<{ balance: number }>,
 *   getInfo(): Promise<{ alias?: string, network?: string, methods?: string[] }>,
 *   makeInvoice(r: Record<string, unknown>): Promise<Record<string, unknown>>,
 *   lookupInvoice(r: { payment_hash?: string, invoice?: string }): Promise<Record<string, unknown>>,
 * }} Upstream
 */

// Upstream errors after which no payment happened.
const DEFINITE = new Set([
	"RATE_LIMITED",
	"NOT_IMPLEMENTED",
	"INSUFFICIENT_BALANCE",
	"QUOTA_EXCEEDED",
	"RESTRICTED",
	"UNAUTHORIZED",
	"PAYMENT_FAILED",
	"NOT_FOUND",
]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export class Guard {
	/**
	 * @param {{
	 *   upstream: Upstream,
	 *   state: import("./store.js").PaymentState,
	 *   audit: import("./store.js").AuditLog,
	 *   approver: Approver,
	 *   rulesFor: (connection: string) => Rules,
	 *   onAllowPayee?: (connection: string, payee: string) => void,
	 *   isPaused?: () => boolean,
	 *   now?: () => number,
	 * }} options
	 */
	constructor(options) {
		this.upstream = options.upstream;
		this.state = options.state;
		this.audit = options.audit;
		this.approver = options.approver;
		this.rulesFor = options.rulesFor;
		this.onAllowPayee = options.onAllowPayee ?? (() => {});
		this.isPaused = options.isPaused ?? (() => false);
		this.now = options.now ?? Date.now;
	}

	/**
	 * methods lists what a connection may call, for get_info.
	 *
	 * @param {string} connection
	 */
	methods(connection) {
		const rules = this.rulesFor(connection);
		return [
			"get_info",
			"pay_invoice",
			"lookup_invoice",
			"list_transactions",
			...(rules.allowGetBalance ? ["get_balance"] : []),
			...(rules.allowMakeInvoice ? ["make_invoice"] : []),
		];
	}

	/**
	 * handle answers one NIP-47 request for a connection. It resolves to the
	 * result, or throws an NwcError.
	 *
	 * @param {string} connection
	 * @param {string} method
	 * @param {Record<string, any>} params
	 * @returns {Promise<any>}
	 */
	async handle(connection, method, params = {}) {
		const rules = this.rulesFor(connection);
		switch (method) {
			case "get_info": {
				/** @type {{ alias?: string, network?: string }} */
				const info = await this.upstream.getInfo().catch(() => ({}));
				return {
					alias: `nwc-guard${info.alias ? ` (${info.alias})` : ""}`,
					color: "",
					pubkey: "",
					network: info.network ?? "mainnet",
					block_height: 0,
					block_hash: "",
					methods: this.methods(connection),
				};
			}
			case "get_balance": {
				if (!rules.allowGetBalance) {
					throw new NwcError("RESTRICTED", "get_balance is not allowed on this connection");
				}
				// The agent sees what it may still spend today, capped by the
				// wallet's real balance.
				const { balance } = await this.upstream.getBalance();
				const left = Math.max(0, rules.budgets.day - this.committedSince(connection, this.now() - DAY)) * 1000;
				return { balance: Math.min(balance, left) };
			}
			case "make_invoice": {
				if (!rules.allowMakeInvoice) {
					throw new NwcError("RESTRICTED", "make_invoice is not allowed on this connection");
				}
				return this.upstream.makeInvoice(params);
			}
			case "lookup_invoice":
				return this.upstream.lookupInvoice(params);
			case "list_transactions":
				// Only this connection's own payments, never the wallet's
				// whole history.
				return {
					transactions: this.state
						.forConnection(connection)
						.slice(-(Number(params.limit) || 50))
						.reverse()
						.map((p) => ({
							type: "outgoing",
							state: p.status === "paid" ? "settled" : p.status === "failed" ? "failed" : "pending",
							invoice: "",
							description: "",
							description_hash: "",
							preimage: "",
							payment_hash: p.paymentHash,
							amount: p.amountSat * 1000,
							fees_paid: p.feesSat * 1000,
							created_at: Math.floor(p.ts / 1000),
							settled_at: p.status === "paid" ? Math.floor(p.ts / 1000) : 0,
							expires_at: 0,
						})),
				};
			case "pay_invoice":
				return this.pay(connection, rules, params);
			default:
				throw new NwcError("NOT_IMPLEMENTED", `${method} is blocked by nwc-guard`);
		}
	}

	/**
	 * committedSince is what a connection has spent or has in flight since a
	 * time: a payment is recorded as pending before it waits for approval or
	 * for the wallet, so it counts from the start.
	 *
	 * @param {string} connection
	 * @param {number} sinceMs
	 */
	committedSince(connection, sinceMs) {
		return this.state.committed(connection, sinceMs);
	}

	/**
	 * deny logs a refusal and throws it.
	 *
	 * @param {string} connection
	 * @param {Record<string, unknown>} details
	 * @param {string} code
	 * @param {string} message
	 * @returns {never}
	 */
	deny(connection, details, code, message) {
		this.audit.write({ connection, method: "pay_invoice", decision: "denied", code, reason: message, ...details });
		throw new NwcError(code, `nwc-guard: ${message}`);
	}

	/**
	 * pay applies the rules to one pay_invoice request.
	 *
	 * @param {string} connection
	 * @param {Rules} rules
	 * @param {Record<string, any>} params
	 */
	async pay(connection, rules, params) {
		if (this.isPaused()) {
			this.deny(connection, {}, "RESTRICTED", "payments are paused by the wallet owner");
		}
		let invoice;
		try {
			invoice = parseInvoice(String(params.invoice ?? ""));
		} catch (err) {
			this.deny(connection, {}, "OTHER", `the invoice could not be read (${err instanceof Error ? err.message : err})`);
		}
		const details = { paymentHash: invoice.paymentHash, payee: invoice.payee };

		let amountSat = invoice.amountSat;
		if (amountSat === null) {
			if (!rules.allowAmountless || !Number.isFinite(Number(params.amount))) {
				this.deny(connection, details, "RESTRICTED", "invoices without an amount are not allowed");
			}
			amountSat = Math.ceil(Number(params.amount) / 1000);
		} else if (params.amount !== undefined && Math.ceil(Number(params.amount) / 1000) !== amountSat) {
			this.deny(connection, details, "RESTRICTED", "the requested amount differs from the invoice amount");
		}
		Object.assign(details, { amountSat });
		if (!(amountSat > 0)) {
			this.deny(connection, details, "RESTRICTED", "the payment has no amount");
		}
		const now = this.now();
		if (invoice.expiresAt <= now) {
			this.deny(connection, details, "OTHER", "the invoice has expired");
		}
		if (this.state.find(invoice.paymentHash)) {
			this.deny(connection, details, "RESTRICTED", "this invoice was already paid or attempted through the guard");
		}
		if (amountSat > rules.maxSatsPerPayment) {
			this.deny(connection, details, "QUOTA_EXCEEDED", `${amountSat} sats is above the limit of ${rules.maxSatsPerPayment} per payment`);
		}
		if (this.state.count(connection, now - MINUTE) >= rules.maxPaymentsPerMinute) {
			this.deny(connection, details, "RATE_LIMITED", `more than ${rules.maxPaymentsPerMinute} payments in a minute`);
		}
		for (const [window, ms] of /** @type {const} */ ([["hour", HOUR], ["day", DAY]])) {
			const used = this.committedSince(connection, now - ms);
			if (used + amountSat > rules.budgets[window]) {
				this.deny(connection, details, "QUOTA_EXCEEDED", `the ${window}ly budget of ${rules.budgets[window]} sats would be exceeded (${used} already used)`);
			}
		}

		const known = rules.payees.allow.includes(invoice.payee);
		if (rules.payees.mode === "allowlist" && !known) {
			this.deny(connection, details, "RESTRICTED", `the payee ${invoice.payee.slice(0, 16)}… is not on this connection's allowlist`);
		}
		const reasons = [];
		if (rules.payees.mode === "ask" && !known) {
			reasons.push("new payee");
		}
		if (rules.approveAbove !== null && amountSat > rules.approveAbove) {
			reasons.push(`above ${rules.approveAbove} sats`);
		}

		// Record the payment as pending before anything waits, so a second
		// request cannot slip past the limits or reuse the invoice meanwhile.
		this.state.add({ ts: now, connection, paymentHash: invoice.paymentHash, amountSat, feesSat: 0, payee: invoice.payee, status: "pending" });
		try {
			if (reasons.length > 0) {
				const answer = await this.approver
					.ask({
						connection,
						amountSat,
						payee: invoice.payee,
						payeeName: rules.payees.names?.[invoice.payee],
						description: invoice.description,
						reason: reasons.join(", "),
						via: invoice.via,
					})
					.catch(() => /** @type {ApprovalAnswer} */ ("deny"));
				if (answer === "deny") {
					this.state.update(invoice.paymentHash, { status: "failed" });
					this.deny(connection, details, "RESTRICTED", `the wallet owner did not approve this payment (${reasons.join(", ")})`);
				}
				if (answer === "approve-always") {
					this.onAllowPayee(connection, invoice.payee);
				}
				this.audit.write({ connection, method: "pay_invoice", decision: "approved", answer, ...details });
			}

			let result;
			try {
				result = await this.upstream.payInvoice({ invoice: String(params.invoice) });
			} catch (err) {
				const code = /** @type {{ code?: string }} */ (err).code ?? "INTERNAL";
				const message = err instanceof Error ? err.message : String(err);
				const definite = DEFINITE.has(code);
				this.state.update(invoice.paymentHash, { status: definite ? "failed" : "unknown" });
				this.audit.write({ connection, method: "pay_invoice", decision: definite ? "failed" : "unknown", code, reason: message.slice(0, 300), ...details });
				throw new NwcError(definite ? code : "INTERNAL", definite ? message : `the wallet did not confirm the payment: ${message}`);
			}
			const feesSat = Math.ceil((Number(result.fees_paid) || 0) / 1000);
			this.state.update(invoice.paymentHash, { status: "paid", feesSat });
			this.audit.write({ connection, method: "pay_invoice", decision: "paid", feesSat, ...details });
			return result;
		} catch (err) {
			// A refusal or failure that left the record pending (an error
			// thrown by the approver path) must not hold budget forever.
			if (this.state.find(invoice.paymentHash)?.status === "pending") {
				this.state.update(invoice.paymentHash, { status: "failed" });
			}
			throw err;
		}
	}
}
