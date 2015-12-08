#!/usr/bin/env node
var exec       = require("child_process").exec,
	debug      = require("debug"),
	_          = require("lodash"),
	async      = require("async"),
	Spinner    = require('cli-spinner').Spinner,
	chalk      = require("chalk"),
	Q          = require('q'),
	readline   = require('readline'),
	murmurhash = require('murmurhash'),
	ejs        = require('ejs'),
	salvator   = require('salvator'),
	humanize   = require("humanize-duration"),
	logger;

var argv = require('yargs')
    .usage('Usage: $0 -p [string] -l [string] --prepare')
    // .demand(['p'])
    .argv;

var config = require(argv.c);

['SIGINT', 'SIGTERM', 'uncaughtException'].forEach(function(signal) {
	process.on(signal, function(err) {
		logger.notice('got event %s', signal);
		if (err) {
			logger.error(err);
		}

		async.during(
			function(cb) {
				cb(null, context.length > 0);
			},
			function(next) {
				leaveAndThen(next)();
			},
			function(err) {
				logger.error(err);
				process.exit(0);
			}
		);
	})
});

logger = {
	debug: debug("debug"),
	info: debug("info"),
	notice: debug("notice"),
	warning: debug("warning"),
	error: debug("error"),
	fatal: debug("fatal"),
	pending: function(type, message) {
		var control, pad, spinner, spinnerIndex, intervalID,
			start;

		start = Date.now();

		type = type || "pending";
		message = message || "";

		pre = "  " + type + " ";
		successState = "✓ ";
		errorState = "✗ ";
		pad = new Array(pre.length + 1).join(" ") + "  ";

		function refresh(str) {
			readline.clearLine(process.stdout);
			readline.cursorTo(process.stdout, 0);
			process.stdout.write(str);
		}

		function wait() {
			var spinner = "|/-\\";
			var spinnerIndex = 0;

			function getSpinnerSymbol() {
				return spinner[spinnerIndex++ % spinner.length];
			}

			function write() {
				refresh(chalk.cyan(pre) + getSpinnerSymbol() + " " + message);
			}

			write();

			return setInterval(write, 100);
		}

		intervalID = wait();

		function prepareSub(str) {
			return str.toString()
				.split('\n')
				.filter(function(str) {
					return !_.isEmpty(str);
				})
				.map(function(line, index) {
					return pad + (index == 0 ? '' : '  ') + line;
				})
				.join('\n');
		}

		return function(err, result) {
			var duration;

			clearInterval(intervalID);

			duration = humanize(Date.now() - start);

			if (err) {
				refresh(chalk.cyan(pre) + chalk.red(errorState + message) + "\n");
				process.stdout.write(chalk.magenta(prepareSub(duration)) + "\n");
				process.stdout.write(chalk.gray(prepareSub(err)) + "\n");

				return;
			}

			refresh(chalk.cyan(pre) + chalk.green(successState + message) + "\n");
			process.stdout.write(chalk.magenta(prepareSub(duration)) + "\n");

			if (!_.isEmpty(result)) {
				process.stdout.write(chalk.gray(prepareSub(result)) + "\n");
			}
		};
	}
};



var current = [];
var context = [current];

function enter() {
	context.push(current = []);
}

function leaveAndThen(cb) {
	return function() {
		var victims, args;

		args = arguments;

		victims = context.pop();
		current = context[context.length - 1];

		killEmAll(victims, function(killError) {
			if (killError) {
				return cb(killError);
			}

			cb.apply(null, args);
		});
	};
}

function killEmAll(victims, cb) {
	async.forEach(victims, function(victim, next) {
		victim.then(function(pid) {
			logger.debug("kill %d", pid);

			command("kill " + pid, function(err) {
				if (err) {
					logger.error("could not kill %d", pid);
				}

				next();
			});
		});

		victim.catch(function() {
			next();
		});
	}, function() {
		victims = [];
		cb();
	});
}

function background(str, callback) {
	var deferred;

	logger.debug("run in background", str);

	deferred = Q.defer();

	current.push(deferred.promise)

	command(str + " & echo $!", function(err, stdout, stderr) {
		if (err) {
			deferred.reject();
			return callback(err);
		}

		pid = parseInt(stdout, 10);
		deferred.resolve(pid);

		logger.debug("started background task %d", pid);

		callback(null, pid);
	});
}

var execs = 0;
function command(str, config, callback) {
	var id, pending;

	if (_.isFunction(config)) {
		callback = config;
		config = {};
	}

	id = execs++;

	logger.debug("exec #%d, %s", id, str);
	pending = logger.pending("exec", str);

	exec(str, _.extend({ timeout: 3000 }, config), function(err, stdout, stderr) {
		if (err) {
			pending(err);
			return callback(err);
		}

		pending(null, stdout);
		logger.debug("exec #%d done", id);

		return callback(null, stdout);
	});
}

function prepare(hash, cb) {
	async.eachSeries(
		Object.keys(hash),
		function(key, next) {
			logger.debug("preparing '%s'", key);
			background(hash[key], next);
		},
		cb
	);
}

function report(reports, input, name, callback) {
	var tpl;

	tpl = _.template(
		"java -jar " + config.cmd_runner + " " +
		"--tool Reporter --generate-<%= type %> \"<%= output %>\" " +
		"--input-jtl \"<%= input %>\" --plugin-type <%= plugin %>" +
		"<% _.forEach(options, function(value, option) { %> --<%= option %> <%= value %><% }); %>"
	);

	async.eachSeries(
		reports,
		function(def, next) {
			async.eachSeries(def.plugin, function(plugin, next) {
				var data, output;

				output = "./report/" + [ name, plugin, def.type ].join(".");

				salvator.safe(output)
					.then(function(output) {
						data = _.extend({}, def, {
							plugin: plugin,
							input:  input,
							output: output
						});

						async.series(
							[
								async.apply(command, "rm -f \"" + output + "\""),
								async.apply(command, tpl(data), { timeout: config.timeout * 60 * 1000 })
							],
							next
						);
					})
					.catch(next);

			}, next);
		},
		callback
	);
}

function start(input, output, callback) {
	command(config.jmeter + " -n -t " + input + " -l " + output, { timeout: config.timeout * 60 * 1000 }, callback);
}

function source(servers, template, level, output, name, callback) {
	var fs = require('fs');

	async.mapSeries(
		_.filter(servers, function(server) {
			return !server.disabled;
		}),
		function(def, next) {
			background(def.bin, function(err, pid) {
				if (err) {
					return next(err);
				}

				next(null, _.extend({
					pid: pid
				}, def));
			});
		},
		function(err, servers) {
			async.waterfall(
				[
					async.apply(fs.readFile, template),
					function(tpl, next) {
						var path, data;

						filename = murmurhash(tpl + JSON.stringify([ servers, template, level ]));

						path = "./tmp/" + filename + ".jmx";
						perfmonPath = "./target/" + name + ".perfmon.csv"; 

						data = {
							servers: servers,
							level:   level,
							perfmon: perfmonPath,
							random: function(min, max) {
								min = min || 1000000;
								max = max || 9999999;

								return Math.floor(Math.random() * (max - min)) + min + 1;
							}
						};

						async.parallel(
							[
								function(next) {
									// create empty perfmon file
									fs.open(perfmonPath, "wx", function (err, fd) {
										if (err) {
											return next(err);
										}

									    fs.close(fd, function (err) {
									        if (err) {
									        	return next(err);
									        }

									        next();
									    });
									});
								},
								function(next) {
									try {
										fs.writeFile(path, ejs.render(tpl.toString(), data), function(err) {
											if (err) {
												return next(err);
											}

											next();
										});
									} catch (err) {
										next(err);
									}
								}
							],
							function(err) {
								if (err) {
									return next(err);
								}

								next(null, path);
							}
						);
					}						
				],
				function(err, path) {
					var readline = require('readline'),
						rl;

					if (err) {
						return callback(err);
					}

					if (!argv.prepare) {
						command(config.jmeter + " -n -t " + path + " -l \"" + output + "\"", { timeout: config.timeout * 60 * 1000 }, callback);
					} else {
						var rl = readline.createInterface({
						  input: process.stdin,
						  output: process.stdout
						});

						console.log("You could open now", path);

						rl.question('Type something to kill em all?', function(answer) {
						   callback(new Error(answer));
						});
					}
				}
			);
		}
	);
}

function run(name, plan, level, reports, cb) {
	var input, output;

	output = "./target/" + name + ".report.jtl";

	salvator.safe(output)
		.then(function(output) {
			enter();

			async.series(
				[
					async.apply(prepare, plan.env),
					async.apply(command, "rm -f \"" + output + "\""),
					async.apply(source, plan.server, plan.template, level, output, name),
					async.apply(report, reports, output, name),
				],
				leaveAndThen(cb)
			);
		})
		.catch(cb);
}


var veryStart = Date.now();
async.eachSeries(
	// plans
	(function() {
		var plans;

		if ( _.isUndefined(argv.p) || _.isEmpty(plans = argv.p.split(",")) ) {
			plans = _.keys(config.plan);
		}

		return plans;
	})(),

	function(plan, next) {

		async.eachSeries(
			// levels
			(function() {
				var levels;

				if ( _.isUndefined(argv.l) || _.isEmpty(levels = argv.l.split(",")) ) {
					levels = _.keys(config.plan[plan].level);
				}

				return levels;
			})(),

			function(level, next) {
				var name;

				process.stdout.write('\n');

				name = [ plan, level ].join(".");

				logger.notice("%s@%s", plan, level);

				run(name, config.plan[plan], config.plan[plan].level[level], config.report, function(err) {
					var release;

					if (err) {
						logger.error("%s %s errored %s", plan, level, err.stack);
						return next(err);
					}

					logger.notice("%s@%s done", plan, level);
					release = logger.pending("chilling");

					setTimeout(function() {
						release();
						next();
					}, 15000);
				});
			},
			next
		);

	},

	function(err) {
		if (err) {
			return logger.error(err.stack);
		}

		logger.notice(humanize(Date.now() - veryStart));
		logger.notice("OK");
	}
);
