/*
 * Copyright © 2018, Octave Online LLC
 *
 * This file is part of Octave Online Server.
 *
 * Octave Online Server is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * Octave Online Server is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public
 * License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Octave Online Server.  If not, see
 * <https://www.gnu.org/licenses/>.
 */

"use strict";

const async = require("async");
const child_process = require("child_process");
const logger = require("@oo/shared").logger;
const StdioMessenger = require("@oo/shared").StdioMessenger;

class DockerHandler extends StdioMessenger {
	constructor(sessCode, dockerImage) {
		super();
		this._log = logger(`docker-handler:${dockerImage}:${sessCode}`);
		this.sessCode = sessCode;
	}

	_doCreate(next, dockerArgs) {
		async.series([
			(_next) => {
				// Create the session
				this._spwn = child_process.spawn("docker", dockerArgs);
				this._log.trace("Docker args:", dockerArgs.join(" "));
				this._log.debug("Launched process with ID:", this._spwn.pid);

				// Create stderr listener
				this._spwn.stderr.on("data", this._handleLog.bind(this));

				// Create exit listener
				this._spwn.on("exit", this._handleExit.bind(this));

				// Listen to main read stream
				this.setReadStream(this._spwn.stdout);

				// Wait until we get an acknowledgement before continuing.  Two conditions: receipt of the acknowledgement message, and premature exit.
				var ack = false;
				this.once("message", (name /*,  content */) => {
					if (ack) return;
					ack = true;

					// Error if the message is docker-exit
					if (name === "docker-exit") return _next(new Error("Process exited prematurely"));

					// Don't enable the write stream until down here because we don't want to write messages to the child's STDIN until we've acknowledged that it is online
					this.setWriteStream(this._spwn.stdin);
					_next(null);
				});
			}
		], (err) => {
			if (err) return next(err);
			this._log.debug("Finished creating");
			return next(null);
		});
	}

	_doDestroy(next) {
		// Since the child process is actually the docker client and not the daemon, the SIGKILL will never get forwarded to the actual octave host process.  We need to delegate the task to docker.
		child_process.execFile("docker", ["stop", "-t", 0, this._dockerName], (err, stdout, stderr) => {
		// child_process.execFile("docker", ["rm", "-f", this._dockerName], (err, stdout, stderr) => {
			if (err) this._log.warn(err, stderr);
			this._log.debug("Finished destroying");
			return next(null);
		});
	}

	signal(name) {
		if (this._state !== "ONLINE") return this._log.warn("Will not send SIGINT to child process: process not online");

		// Although the child process is actually the docker client and not the daemon, the client will forward simple signals like SIGINT to the actual octave host process.
		this._spwn.kill(name);
		this._log.debug("Sent " + name + " to child process");
	}

	_handleLog(data) {
		// Log message to console
		data.toString().trim().split("\n").forEach((line) => {
			this._log.log(line);
		});

		// Special handling of certain messages
		// TODO: Make this message get sent from host.c instead of from here
		if (/Process exited with status 0, signal 9/.test(data)) {
			this.emit("message", "octave-killed");
		}
	}

	_handleExit(code, signal) {
		this._log.debug("Docker Exit:", code, signal);
		this.emit("message", "docker-exit", { code, signal });
	}
}

module.exports = DockerHandler;
