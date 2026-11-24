// @ts-check
// The NWC side: each guarded connection is a wallet service of its own on a
// Nostr relay, with its own keys. Agents get that connection's
// nostr+walletconnect:// string; the guard answers them and, when the rules
// allow, makes the call on the real wallet.

import { randomBytes } from "node:crypto";
import { NWCWalletService, NWCWalletServiceKeyPair } from "@getalby/sdk/nwc";
import { getPublicKey } from "nostr-tools";
import { NwcError } from "./guard.js";

/**
 * @typedef {{ name: string, walletSecret: string, clientSecret: string, rules?: Partial<import("./guard.js").Rules> }} Connection
 */

/**
 * newConnection makes the keys for a guarded connection.
 *
 * @param {string} name
 * @returns {Connection}
 */
export function newConnection(name) {
	return { name, walletSecret: randomBytes(32).toString("hex"), clientSecret: randomBytes(32).toString("hex") };
}

/**
 * walletPubkey is the public key agents address their requests to.
 *
 * @param {Connection} connection
 */
export function walletPubkey(connection) {
	return getPublicKey(Buffer.from(connection.walletSecret, "hex"));
}

/**
 * connectionUrl is the string an agent is given for a connection.
 *
 * @param {Connection} connection
 * @param {string[]} relays
 */
export function connectionUrl(connection, relays) {
	const query = relays.map((r) => `relay=${encodeURIComponent(r)}`).join("&");
	return `nostr+walletconnect://${walletPubkey(connection)}?${query}&secret=${connection.clientSecret}`;
}

/**
 * serve starts a wallet service for every connection and returns a stop
 * function.
 *
 * @param {{
 *   connections: Connection[],
 *   relays: string[],
 *   guard: import("./guard.js").Guard,
 *   log?: (line: string) => void,
 * }} options
 */
export async function serve({ connections, relays, guard, log = () => {} }) {
	const service = new NWCWalletService({ relayUrls: relays });
	// Relays may deliver an event twice; each request is handled once.
	const processed = new Set();
	const recordEvent = async (/** @type {string} */ id) => {
		if (processed.has(id)) {
			return /** @type {const} */ ("ALREADY_PROCESSED");
		}
		processed.add(id);
		if (processed.size > 10_000) {
			processed.delete(processed.values().next().value);
		}
		return undefined;
	};

	/** @type {Array<() => void>} */
	const unsubscribers = [];
	for (const connection of connections) {
		const keypair = new NWCWalletServiceKeyPair(
			connection.walletSecret,
			getPublicKey(Buffer.from(connection.clientSecret, "hex")),
		);
		await service.publishWalletServiceInfoEvent(connection.walletSecret, /** @type {any} */ (guard.methods(connection.name)), []);

		/**
		 * @param {string} method
		 * @param {any} [params]
		 */
		const answer = async (method, params) => {
			try {
				return { result: await guard.handle(connection.name, method, params), error: undefined };
			} catch (err) {
				const code = err instanceof NwcError ? err.code : "INTERNAL";
				const message = err instanceof Error ? err.message : String(err);
				if (method === "pay_invoice") {
					log(`✋ ${connection.name}: ${message}`);
				}
				return { result: undefined, error: { code, message } };
			}
		};

		unsubscribers.push(
			await service.subscribe(keypair, /** @type {any} */ ({
				recordEvent,
				getInfo: () => answer("get_info"),
				getBalance: () => answer("get_balance"),
				payInvoice: (/** @type {any} */ p) => answer("pay_invoice", p),
				makeInvoice: (/** @type {any} */ p) => answer("make_invoice", p),
				lookupInvoice: (/** @type {any} */ p) => answer("lookup_invoice", p),
				listTransactions: (/** @type {any} */ p) => answer("list_transactions", p),
				payKeysend: () => answer("pay_keysend"),
				signMessage: () => answer("sign_message"),
			})),
		);
	}
	return () => {
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
		service.close();
	};
}
