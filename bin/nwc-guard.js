#!/usr/bin/env node
// @ts-check
// nwc-guard: a spending firewall between AI agents and a Lightning wallet.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { NWCClient } from "@getalby/sdk/nwc";
import { denyAll, TelegramApprover, TerminalApprover } from "../src/approval.js";
import { Guard, withDefaults } from "../src/guard.js";
import { parseInvoice } from "../src/invoice.js";
import { connectionUrl, newConnection, serve } from "../src/service.js";
import { AuditLog, PaymentState, readJson, writePrivate } from "../src/store.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const DEFAULT_RELAY = "wss://relay.getalby.com/v1";

const HELP = `nwc-guard ${VERSION}

A spending firewall between AI agents and your Lightning wallet. Agents get a
Nostr Wallet Connect string that points to the guard; the guard checks every
payment against your rules (payees, amounts, budgets, rate), asks you on
Telegram or in the terminal when the rules say so, and only then pays from
your real wallet.

Usage:
  nwc-guard init [--name agent]        create the config and a first connection
  nwc-guard add <name>                 add a connection for another agent
  nwc-guard url <name>                 print a connection's NWC string
  nwc-guard allow <name> <payee> [label]
                                       trust a payee: a node key, or an invoice
                                       from that payee
  nwc-guard start                      run the guard (the default)

The real wallet (for start):
  NWC_UPSTREAM_URL                     your wallet's NWC string, with pay_invoice
  --upstream-file <path>               or a file holding it

Approvals (for start):
  NWC_GUARD_TELEGRAM_TOKEN and NWC_GUARD_TELEGRAM_CHAT
                                       ask on Telegram, with buttons; the bot must
                                       be used by nwc-guard only. /stop pauses all
                                       payments, /resume restarts them.
  otherwise                            ask in this terminal, or deny if there is none

Options:
  --data-dir <dir>                     config, state and audit log (default ~/.nwc-guard)
  --relay <url>                        relay for new connections (default ${DEFAULT_RELAY})
  --approval-timeout <seconds>         how long to wait for your answer (default 55;
                                       most NWC clients give up after 60)
  -h, --help, -v, --version

Rules live per connection in <data-dir>/config.json. Defaults: 1,000 sats per
payment, 3,000 per hour, 10,000 per day, 5 payments a minute, approval for every
new payee. Creating <data-dir>/STOP pauses all payments.
`;

/** @param {string} message */
function fail(message) {
	console.error(`nwc-guard: ${message}`);
	process.exit(1);
}

/**
 * @typedef {{ version: 1, relays: string[], connections: import("../src/service.js").Connection[] }} Config
 */

async function main() {
	let parsed;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			options: {
				name: { type: "string" },
				"data-dir": { type: "string" },
				relay: { type: "string", multiple: true },
				"upstream-file": { type: "string" },
				"approval-timeout": { type: "string" },
				help: { type: "boolean", short: "h" },
				version: { type: "boolean", short: "v" },
			},
		});
	} catch (err) {
		fail(`${err instanceof Error ? err.message : err}\n\n${HELP}`);
		return;
	}
	const { values: args, positionals } = parsed;
	if (args.help) {
		process.stdout.write(HELP);
		return;
	}
	if (args.version) {
		console.log(VERSION);
		return;
	}

	const dataDir = args["data-dir"] ?? process.env.NWC_GUARD_DATA_DIR ?? join(homedir(), ".nwc-guard");
	const configPath = join(dataDir, "config.json");
	/** @type {Config} */
	const config = readJson(configPath, { version: 1, relays: args.relay ?? [DEFAULT_RELAY], connections: [] });
	const save = () => writePrivate(configPath, `${JSON.stringify(config, null, "\t")}\n`);
	/** @param {string} name */
	const byName = (name) => config.connections.find((c) => c.name === name);
	const [command = "start", ...rest] = positionals;

	if (command === "init" || command === "add") {
		const name = command === "add" ? rest[0] : (args.name ?? "agent");
		if (!name || !/^[A-Za-z0-9_.-]{1,40}$/.test(name)) {
			fail("give the connection a name of letters, digits, dots, dashes or underscores");
		}
		if (byName(name)) {
			fail(`a connection named "${name}" already exists; nwc-guard url ${name} prints it`);
		}
		const connection = { ...newConnection(name), rules: withDefaults({}) };
		config.connections.push(connection);
		save();
		console.log(`Created connection "${name}" in ${configPath}.

Give this NWC string to the agent (keep it secret: whoever has it can ask the guard to pay):

  ${connectionUrl(connection, config.relays)}

Its rules are in the config file. Trust a payee in advance with:
  nwc-guard allow ${name} <node key or an invoice from that payee> [label]
Then start the guard with your real wallet:
  NWC_UPSTREAM_URL="nostr+walletconnect://..." nwc-guard start`);
		return;
	}

	if (command === "url") {
		const connection = byName(rest[0] ?? "");
		if (!connection) {
			fail(`no connection named "${rest[0] ?? ""}"`);
			return;
		}
		console.log(connectionUrl(connection, config.relays));
		return;
	}

	if (command === "allow") {
		const [name, payeeArg, ...label] = rest;
		const connection = byName(name ?? "");
		if (!connection || !payeeArg) {
			fail("usage: nwc-guard allow <name> <node key or invoice> [label]");
			return;
		}
		let payee = payeeArg.toLowerCase();
		let note = "";
		if (!/^0[23][0-9a-f]{64}$/.test(payee)) {
			try {
				const invoice = parseInvoice(payeeArg);
				payee = invoice.payee;
				if (invoice.via.length > 0) {
					note =
						"\nNote: this payee sits behind a private channel. Some wallets (Wavelength, for one) sign every invoice " +
						"with a new key, so this rule matches only if its next invoices use the same key. For such payees, rely " +
						"on approval and on the amount and budget limits.";
				}
			} catch {
				fail("the payee must be a 33-byte node key in hex, or an invoice from that payee");
			}
		}
		const rules = withDefaults(connection.rules);
		if (!rules.payees.allow.includes(payee)) {
			rules.payees.allow.push(payee);
		}
		if (label.length > 0) {
			rules.payees.names = { ...rules.payees.names, [payee]: label.join(" ").slice(0, 60) };
		}
		connection.rules = rules;
		save();
		console.log(`"${name}" may now pay ${payee}${label.length ? ` (${label.join(" ")})` : ""} without asking.${note}`);
		return;
	}

	if (command !== "start") {
		fail(`unknown command "${command}"\n\n${HELP}`);
	}
	if (config.connections.length === 0) {
		fail("no connections yet: run nwc-guard init first");
	}

	let upstreamUrl = process.env.NWC_UPSTREAM_URL;
	if (args["upstream-file"]) {
		upstreamUrl = readFileSync(args["upstream-file"], "utf8").trim();
	}
	if (!upstreamUrl) {
		fail("set NWC_UPSTREAM_URL to your real wallet's NWC string, or use --upstream-file");
		return;
	}
	let upstream;
	try {
		NWCClient.parseWalletConnectUrl(upstreamUrl, true);
		upstream = new NWCClient({ nostrWalletConnectUrl: upstreamUrl });
	} catch {
		fail("NWC_UPSTREAM_URL is not a valid nostr+walletconnect:// string");
		return;
	}
	if (config.connections.some((c) => connectionUrl(c, config.relays) === upstreamUrl)) {
		fail("NWC_UPSTREAM_URL is one of the guard's own connections; use your real wallet's string");
	}
	let walletName = "your wallet";
	try {
		const info = await Promise.race([
			upstream.getInfo(),
			new Promise((_, reject) => setTimeout(() => reject(new Error("no answer")), 20_000).unref()),
		]);
		if (Array.isArray(info.methods) && !info.methods.includes("pay_invoice")) {
			fail("the upstream connection cannot pay invoices");
		}
		walletName = info.alias || walletName;
	} catch (err) {
		console.log(`note: the wallet did not answer get_info (${err instanceof Error ? err.message : err}); continuing`);
	}

	const timeoutRaw = args["approval-timeout"] ?? "55";
	if (!/^\d+$/.test(timeoutRaw) || Number(timeoutRaw) < 10 || Number(timeoutRaw) > 3600) {
		fail("--approval-timeout must be between 10 and 3600 seconds");
	}
	const approvalTimeoutMs = Number(timeoutRaw) * 1000;
	const stopFile = join(dataDir, "STOP");
	let pausedByChat = false;
	const isPaused = () => pausedByChat || existsSync(stopFile);
	const state = new PaymentState(join(dataDir, "state.json"));
	const audit = new AuditLog(join(dataDir, "audit.ndjson"));

	/** @type {import("../src/guard.js").Approver} */
	let approver = denyAll;
	let approvals = "none: anything that needs approval is denied";
	const token = process.env.NWC_GUARD_TELEGRAM_TOKEN;
	const chat = process.env.NWC_GUARD_TELEGRAM_CHAT;
	if (token && chat) {
		const telegram = new TelegramApprover({
			token,
			chatId: chat,
			timeoutMs: approvalTimeoutMs,
			onCommand: (command) => {
				if (command === "/stop") {
					pausedByChat = true;
					return "⛔ nwc-guard: all payments are paused. /resume to restart them.";
				}
				if (command === "/resume") {
					pausedByChat = false;
					rmSync(stopFile, { force: true });
					return "▶️ nwc-guard: payments resumed.";
				}
				if (command === "/status") {
					const day = Date.now() - 24 * 3600 * 1000;
					return config.connections
						.map((c) => `${c.name}: ${state.committed(c.name, day)} / ${withDefaults(c.rules).budgets.day} sats today`)
						.concat(isPaused() ? ["⛔ paused"] : [])
						.join("\n");
				}
				return "";
			},
		});
		telegram.start();
		approver = telegram;
		approvals = "Telegram (/stop, /resume, /status)";
	} else if (process.stdin.isTTY) {
		approver = new TerminalApprover({ timeoutMs: approvalTimeoutMs });
		approvals = "this terminal";
	}

	const guard = new Guard({
		upstream: /** @type {any} */ (upstream),
		state,
		audit,
		approver,
		isPaused,
		rulesFor: (name) => withDefaults(byName(name)?.rules),
		onAllowPayee: (name, payee) => {
			const connection = byName(name);
			if (connection) {
				const rules = withDefaults(connection.rules);
				if (!rules.payees.allow.includes(payee)) {
					rules.payees.allow.push(payee);
				}
				connection.rules = rules;
				save();
			}
		},
	});

	const stop = await serve({ connections: config.connections, relays: config.relays, guard, log: (l) => console.log(l) });
	console.log(`🛡  nwc-guard ${VERSION} is guarding ${walletName}

  connections  ${config.connections.map((c) => c.name).join(", ")}
  relays       ${config.relays.join(", ")}
  approvals    ${approvals}
  audit log    ${join(dataDir, "audit.ndjson")}
  pause        create ${stopFile}
`);
	const shutdown = () => {
		stop();
		upstream.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
