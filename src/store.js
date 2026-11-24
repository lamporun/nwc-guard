// @ts-check
// Files the guard keeps under its data directory, all readable by the owner
// only: the config (connection secrets and rules), the payment state the
// limits are computed from, and an append-only audit log.

import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * writePrivate replaces a file atomically, readable by the owner only.
 *
 * @param {string} path
 * @param {string} content
 */
export function writePrivate(path, content) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, content, { mode: 0o600 });
	renameSync(tmp, path);
}

/**
 * readJson reads a JSON file, or returns the fallback when it is missing.
 *
 * @template T
 * @param {string} path
 * @param {T} fallback
 * @returns {T}
 */
export function readJson(path, fallback) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
			return fallback;
		}
		throw err;
	}
	return JSON.parse(raw);
}

/**
 * @typedef {{
 *   ts: number,
 *   connection: string,
 *   paymentHash: string,
 *   amountSat: number,
 *   feesSat: number,
 *   payee: string,
 *   status: "pending" | "paid" | "failed" | "unknown",
 * }} PaymentRecord
 */

// KEEP_MS is how long payment records are kept for the limits and for
// list_transactions: a week.
const KEEP_MS = 7 * 24 * 3600 * 1000;

/** PaymentState holds recent payments per connection, persisted as JSON. */
export class PaymentState {
	/**
	 * @param {string | null} path null keeps the state in memory only
	 * @param {() => number} [now]
	 */
	constructor(path, now = Date.now) {
		this.path = path;
		this.now = now;
		/** @type {PaymentRecord[]} */
		this.payments = path ? readJson(path, { payments: [] }).payments ?? [] : [];
	}

	save() {
		const cutoff = this.now() - KEEP_MS;
		this.payments = this.payments.filter((p) => p.ts >= cutoff || p.status === "pending" || p.status === "unknown");
		if (this.path) {
			writePrivate(this.path, JSON.stringify({ version: 1, payments: this.payments }));
		}
	}

	/** @param {PaymentRecord} record */
	add(record) {
		this.payments.push(record);
		this.save();
	}

	/**
	 * @param {string} paymentHash
	 * @param {Partial<PaymentRecord>} patch
	 */
	update(paymentHash, patch) {
		const record = this.payments.find((p) => p.paymentHash === paymentHash);
		if (record) {
			Object.assign(record, patch);
			this.save();
		}
	}

	/** @param {string} paymentHash */
	find(paymentHash) {
		return this.payments.find((p) => p.paymentHash === paymentHash);
	}

	/**
	 * committed sums what a connection's payments since a time cost or may
	 * cost: paid ones with fees, and pending or unknown ones at their amount.
	 *
	 * @param {string} connection
	 * @param {number} sinceMs
	 */
	committed(connection, sinceMs) {
		let total = 0;
		for (const p of this.payments) {
			if (p.connection === connection && p.ts >= sinceMs && p.status !== "failed") {
				total += p.amountSat + (p.status === "paid" ? p.feesSat : 0);
			}
		}
		return total;
	}

	/**
	 * count is how many payment attempts a connection made since a time.
	 *
	 * @param {string} connection
	 * @param {number} sinceMs
	 */
	count(connection, sinceMs) {
		return this.payments.filter((p) => p.connection === connection && p.ts >= sinceMs).length;
	}

	/** @param {string} connection */
	forConnection(connection) {
		return this.payments.filter((p) => p.connection === connection);
	}
}

/** AuditLog appends one JSON line per decision. It never logs secrets. */
export class AuditLog {
	/** @param {string | null} path */
	constructor(path) {
		this.path = path;
	}

	/** @param {Record<string, unknown>} entry */
	write(entry) {
		if (!this.path) {
			return;
		}
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		appendFileSync(this.path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
		chmodSync(this.path, 0o600);
	}
}
