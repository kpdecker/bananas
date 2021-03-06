'use strict';

// Load modules

const Os = require('os');
const Hoek = require('hoek');
const Wreck = require('wreck');
const FastSafeStringify = require('fast-safe-stringify');


// Declare internals

const internals = {
    defaults: {
        intervalMsec: 1000,
        root: false,
        exclude: [],
        uncaughtException: false
    }
};


exports.register = function (server, options, next) {

    Hoek.assert(options.token, 'Missing Loggly API token');

    const settings = Hoek.applyToDefaults(internals.defaults, options);
    server = (settings.root ? server.root : server);

    // Setup log queue

    const uri = `https://logs-01.loggly.com/bulk/${settings.token}`;
    let updates = [];
    const flush = function (callback) {

        callback = callback || Hoek.ignore;

        if (!updates.length) {
            return callback();
        }

        const holder = updates;
        updates = [];

        const payload = holder.map(FastSafeStringify).join('\n');
        Wreck.post(uri, { payload, headers: { 'content-type': 'application/json' }, json: true }, callback);
    };

    // Setup flush intervals

    const timerId = setInterval(flush, settings.intervalMsec);

    // Listen to system exceptions

    if (settings.uncaughtException) {
        process.once('uncaughtException', (err) => {

            const uncaught = internals.update('error');
            uncaught.error = {
                message: err.message,
                stack: err.stack,
                data: err.data
            };

            uncaught.tags = ['bananas', 'uncaught', 'error'];
            updates.push(uncaught);

            return flush((ignore) => {

                process.exit(1);
            });
        });
    }

    // Listen to server events

    const onPostStop = function (srv, nextExt) {

        clearInterval(timerId);
        return nextExt();
    };

    server.ext('onPostStop', onPostStop);

    // Subscribe to server events

    server.on('log', (event, tags) => {

        const update = internals.update('server');
        update.tags = event.tags;
        update.data = event.data;

        updates.push(update);
    });

    server.on('response', (request) => {

        if (settings.exclude.indexOf(request.path) !== -1) {
            return;
        }

        const update = internals.update('response', request);
        update.code = request.raw.res.statusCode;

        if (update.code >= 400) {
            update.error = request.response.source;
        }

        updates.push(update);
    });

    server.on('request-error', (request, err) => {

        const update = internals.update('error', request);
        update.error = {
            message: err.message,
            stack: err.stack,
            data: err.data
        };

        updates.push(update);
    });

    // Log initialization

    const init = internals.update('server');
    init.tags = ['bananas', 'initialized'];
    updates.push(init);
    return flush(next);
};


exports.register.attributes = {
    pkg: require('../package.json')
};


internals.update = function (event, request) {

    const now = Date.now();

    const update = {
        event: event,
        timestamp: now,
        host: Os.hostname()
    };

    if (request) {
        update.path = request.path;
        update.query = request.query;
        update.method = request.method;
        update.request = {
            id: request.id,
            received: request.info.received,
            elapsed: now - request.info.received
        };
    }

    return update;
};
