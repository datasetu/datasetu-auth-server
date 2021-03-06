/* vim: set ts=8 sw=4 tw=0 noet : */

/*
 * Copyright (c) 2020, Indian Institute of Science, Bengaluru
 *
 * Authors:
 * --------
 * Arun Babu    {barun       <at> iisc <dot> ac <dot> in}
 * Bryan Robert {bryanrobert <at> iisc <dot> ac <dot> in}
 *
 * Permission to use, copy, modify, and distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

"use strict";

const os			= require("os");
const Pool			= require("pg").Pool;
const lodash			= require("lodash");
const chroot			= require("chroot");
const Slimbot			= require('slimbot');

const pgNativeClient		= require("pg-native");
const pg			= new pgNativeClient();

const EUID			= process.geteuid();
const is_openbsd		= os.type() === "OpenBSD";
const pledge			= is_openbsd ? require("node-pledge")	: null;
const unveil			= is_openbsd ? require("openbsd-unveil"): null;

const is_dev_env		= process.env.NODE_ENV === "development";
const config			= require (is_dev_env ? "./config-dev" : "./config-prod");

const slimbot			= new Slimbot(config.BOT_TELEGRAM_APIKEY);

// async postgres connection
const pool = new Pool ({
	host		: config.DB_SERVER,
	port		: 5432,
	user		: "bot",
	database	: "postgres",
	password	: config.DB_PASSWORD,
});

pool.connect();

// sync postgres connection
pg.connectSync (
	"postgresql://bot:"+ config.DB_PASSWORD + "@" + config.DB_SERVER + ":5432/postgres",
		(err) =>
		{
			if (err) {
				throw err;
			}
		}
);

if (is_openbsd)
{
	if (EUID === 0)
	{
		process.setgid("_bot");
		process.setuid("_bot");
	}

	unveil("/usr/lib",			"r" );
	unveil("/usr/libexec/ld.so",		"r" );
	unveil(__dirname + "/node_modules",	"r" );

	unveil();

	pledge.init ("error stdio tty prot_exec inet dns");
}
else
{
	if (EUID === 0)
	{
		process.setgid("_bot");
		chroot("/home/datasetu-auth-server","_bot");
		process.chdir ("/");
	}
}

slimbot.on('message', (message) => {

	// update chat id for this user ....

	const provider = message.from.username || message.chat.username;

	if (provider)
	{
		const rows = pg.querySync (
			"SELECT chat_id FROM telegram WHERE telegram_id = $1::text LIMIT 1", [provider]
		);

		if (rows.length === 0) // provider does not exist
		{
			pg.querySync (
				"INSERT INTO telegram VALUES($1::text,$2::text)",
				[
					provider,
					message.chat.id	
				]
			);
		}
		else
		{
			pg.querySync (
				"UPDATE telegram SET chat_id = $1::text WHERE telegram_id = $2::text",
				[
					message.chat.id,
					provider	
				]
			);
		}
	}

	if (message.text === "/start")
		return slimbot.sendMessage(message.chat.id, "Hi, I am DataSetu bot");
});

slimbot.on('callback_query', (query) => {

	const provider	= query.from.username || query.chat.username;
	const chat_id	= query.message.chat.id;

	if (query.data === "DENY")
	{
		// TODO delete from DB ?
		return slimbot.sendMessage(chat_id, "Access denied to the user");
	}

	if (query.data === "ALLOW")
	{
		/* banner # array index # sha256 hash of token # rest of the message */

		const split = query.message.text.split("#");

		if (split.length < 4)
			return slimbot.sendMessage(chat_id, "Invalid input");

		const index	= split[1];
		const token	= split[2];

		pool.query (
			"SELECT request,manual_authorization_array"	+
				" FROM token"				+
				" WHERE token = $1::text"		+
				" AND revoked = false"			+
				" AND expiry > NOW()"			+
				" LIMIT 1",
				[
					token,				// 1
				],
			(error, results) =>
			{
				if (error)
					return slimbot.sendMessage(chat_id, "Internal error!");

				if (results.rowCount === 0)
					return slimbot.sendMessage(chat_id, "Invalid or expired token!");

				const expected_provider = results.rows[0]
								.manual_authorization_array[index]["manual-authorization"];

				if ("telegram:" + provider !== expected_provider)
				{
					// TODO serious security issue ?
					return slimbot.sendMessage(chat_id, "Invalid provider!");
				}

				const request			= results.rows[0].request;
				const manual_authorization	= results.rows[0].manual_authorization_array[index];

				if (! manual_authorization)
					return slimbot.sendMessage(chat_id, "Invalid index!");

				if (typeof manual_authorization !== "object")
					return slimbot.sendMessage(chat_id, "Invalid data in database!");

				Object.freeze (manual_authorization);

				for (const r of request)
				{
					// if request was already authorized
					Object.freeze(r);

					if (lodash.isEqual(r,manual_authorization))
						return slimbot.sendMessage(chat_id, "Request was already authorized");
				}

				// Else append the approved item from "manual_authorization_array" to "request"

				pool.query (
					"UPDATE token SET"							+
						" request = request || "					+ 
						" CONCAT('[',manual_authorization_array->>$1::int,']')::jsonb"	+
						" WHERE token = $2::text"					+
						" AND manual_authorization_array->>$1::int IS NOT NULL",
						[
							index,
							token
						],
					(update_error, update_results) =>
					{
						if (update_error)
							return slimbot.sendMessage(chat_id, "Internal error!");

						if (update_results.rowCount === 0)
							return slimbot.sendMessage(chat_id, "Invalid input!");

						return slimbot.sendMessage(chat_id, "Access granted to the user");

						// TODO remove the approved item from "manual_authorization_array"
						// manual_authorization_array = manual_authorization_array::jsonb - index;
					}
				);
			}
		);
	}
	else
	{
		// TODO delete from manual_authorization_array ?
	}
});

slimbot.startPolling();
