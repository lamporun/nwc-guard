// @ts-check
import { createHash, randomBytes } from "node:crypto";
import { Nip47ReplyTimeoutError, Nip47WalletError } from "@getalby/sdk/nwc";
import bolt11 from "bolt11";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Guard, withDefaults } from "../src/guard.js";
import { AuditLog, PaymentState } from "../src/store.js";

// Throwaway node keys, used only to sign test invoices.
export const SHOP_KEY = "e126f68f7eafcc8b74f54d269fe206be715000f94dac067d1c04a8ca3b2db734";
export const EVIL_KEY = "a7c0bd0f9b7a6e0a3a1c5c3e7b9d1f2e4a6c8e0b2d4f6a8c0e2a4c6e8a0b2d4f";
/** @param {string} key */
export const pubkeyOf = (key) => Buffer.from(secp256k1.getPublicKey(Buffer.from(key, "hex"), true)).toString("hex");

/**
 * invoiceFor signs a mainnet invoice.
 *
 * @param {{ sats?: number | null, key?: string, expireSeconds?: number, ageSeconds?: number, description?: string }} [o]
 */
export function invoiceFor(o = {}) {
	const preimage = randomBytes(32).toString("hex");
	const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
	const encoded = bolt11.encode({
		network: { bech32: "bc", pubKeyHash: 0, scriptHash: 5, validWitnessVersions: [0, 1] },
		...(o.sats === null ? {} : { satoshis: o.sats ?? 1_000 }),
		timestamp: Math.floor(Date.now() / 1000) - (o.ageSeconds ?? 0),
		tags: [
			{ tagName: "payment_hash", data: hash },
			{ tagName: "payment_secret", data: randomBytes(32).toString("hex") },
			{ tagName: "description", data: o.description ?? "test" },
			{ tagName: "expire_time", data: o.expireSeconds ?? 600 },
		],
	});
	return { invoice: /** @type {string} */ (bolt11.sign(encoded, o.key ?? SHOP_KEY).paymentRequest), preimage, hash };
}

/**
 * fakeUpstream is the real wallet, as far as the guard can tell.
 *
 * @param {{ mode?: "ok" | "insufficient" | "timeout", balanceSat?: number }} [o]
 */
export function fakeUpstream(o = {}) {
	const paid = /** @type {string[]} */ ([]);
	/** @type {Map<string, string>} */
	const preimages = new Map();
	return {
		paid,
		preimages,
		async getInfo() {
			return { alias: "Fake wallet", network: "mainnet", methods: ["pay_invoice", "get_balance"] };
		},
		async getBalance() {
			return { balance: (o.balanceSat ?? 50_000) * 1000 };
		},
		/** @param {{ invoice: string }} r */
		async payInvoice({ invoice }) {
			if (o.mode === "insufficient") {
				throw new Nip47WalletError("not enough funds", "INSUFFICIENT_BALANCE");
			}
			paid.push(invoice);
			if (o.mode === "timeout") {
				throw new Nip47ReplyTimeoutError("reply timeout", "INTERNAL");
			}
			return { preimage: preimages.get(invoice) ?? "00".repeat(32), fees_paid: 2_000 };
		},
		async makeInvoice() {
			return { invoice: "lnbc1made" };
		},
		async lookupInvoice() {
			return { state: "settled" };
		},
	};
}

/**
 * makeGuard builds a guard around a fake wallet and a scripted approver.
 *
 * @param {{
 *   rules?: Partial<import("../src/guard.js").Rules>,
 *   upstream?: ReturnType<typeof fakeUpstream>,
 *   answers?: Array<import("../src/guard.js").ApprovalAnswer>,
 *   now?: () => number,
 *   paused?: boolean,
 * }} [o]
 */
export function makeGuard(o = {}) {
	const upstream = o.upstream ?? fakeUpstream();
	let rules = withDefaults(o.rules);
	const asked = /** @type {import("../src/guard.js").ApprovalRequest[]} */ ([]);
	const answers = [...(o.answers ?? [])];
	const audit = new AuditLog(null);
	const entries = /** @type {Record<string, unknown>[]} */ ([]);
	audit.write = (e) => entries.push(e);
	const guard = new Guard({
		upstream,
		state: new PaymentState(null, o.now),
		audit,
		approver: { ask: async (r) => (asked.push(r), answers.shift() ?? "deny") },
		rulesFor: () => rules,
		onAllowPayee: (_c, payee) => {
			rules = withDefaults({ ...rules, payees: { ...rules.payees, allow: [...rules.payees.allow, payee] } });
		},
		isPaused: () => o.paused === true,
		now: o.now,
	});
	return { guard, upstream, asked, entries, rules: () => rules };
}
