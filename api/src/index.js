#!/usr/bin/env node
require('nocamel');
const Logger = require('logplease');
const express = require('express');
const expressWs = require('express-ws');
const globals = require('./globals');
const config = require('./config');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const body_parser = require('body-parser');
const runtime = require('./runtime');
const remote_files = require('./remote_files');
const health = require('./health');

const ISOLATE_BOX_ROOT = '/var/local/lib/isolate';

async function init_remote_files_cache() {
    if (!config.remote_files_enabled) {
        logger.info(
            'remote_files feature is disabled (set PISTON_REMOTE_FILES_ENABLED=true to enable)'
        );
        return;
    }

    logger.info(
        `remote_files enabled; cache_dir=${config.remote_files_cache_dir}, host_allowlist=${config.remote_files_host_allowlist.join(',')}`
    );

    await fs.mkdir(config.remote_files_cache_dir, {
        recursive: true,
        mode: 0o700,
    });

    // The api process runs as the unprivileged `piston` user (see api/Dockerfile),
    // and /var/local/lib is root-owned 755 in the upstream image — so a pre-create
    // here will EACCES. That's expected: isolate itself creates the box root with
    // the right setuid ownership when it processes its first job. We swallow EACCES
    // and surface anything else.
    try {
        await fs.mkdir(ISOLATE_BOX_ROOT, { recursive: true, mode: 0o755 });
    } catch (e) {
        if (e.code !== 'EACCES') {
            logger.warn(
                `Unexpected error creating ${ISOLATE_BOX_ROOT}: ${e.message}`
            );
        }
    }

    try {
        const [cache_stat, isolate_stat] = await Promise.all([
            fs.stat(config.remote_files_cache_dir),
            fs.stat(ISOLATE_BOX_ROOT),
        ]);
        if (cache_stat.dev !== isolate_stat.dev) {
            logger.error(
                `remote_files cache dir (${config.remote_files_cache_dir}) is on a different filesystem than the isolate box root (${ISOLATE_BOX_ROOT}). Hardlinks will fail; cache will fall back to copy and lose its performance benefit. Reconfigure PISTON_REMOTE_FILES_CACHE_DIR or your volume mounts so they share a filesystem.`
            );
            process.exit(1);
        }
        logger.info(
            `remote_files cache dir and isolate box root share a filesystem (dev=${cache_stat.dev})`
        );
    } catch (e) {
        if (e.code === 'ENOENT') {
            logger.info(
                `remote_files cross-device check deferred: ${e.path} not yet created (isolate will create it on first job; remote_files hardlinks when possible, copies on EXDEV)`
            );
        } else {
            logger.error(`remote_files filesystem check failed: ${e.message}`);
            process.exit(1);
        }
    }

    await remote_files.init();
}

const logger = Logger.create('index');
const app = express();
expressWs(app);

(async () => {
    logger.info('Setting loglevel to', config.log_level);
    Logger.setLogLevel(config.log_level);
    logger.debug('Ensuring data directories exist');

    Object.values(globals.data_directories).for_each(dir => {
        let data_path = path.join(config.data_directory, dir);

        logger.debug(`Ensuring ${data_path} exists`);

        if (!fss.exists_sync(data_path)) {
            logger.info(`${data_path} does not exist.. Creating..`);

            try {
                fss.mkdir_sync(data_path);
            } catch (e) {
                logger.error(`Failed to create ${data_path}: `, e.message);
            }
        }
    });

    logger.info('Loading packages');
    const pkgdir = path.join(
        config.data_directory,
        globals.data_directories.packages
    );

    const pkglist = await fs.readdir(pkgdir);

    const languages = await Promise.all(
        pkglist.map(lang => {
            return fs.readdir(path.join(pkgdir, lang)).then(x => {
                return x.map(y => path.join(pkgdir, lang, y));
            });
        })
    );

    const installed_languages = languages
        .flat()
        .filter(pkg =>
            fss.exists_sync(path.join(pkg, globals.pkg_installed_file))
        );

    installed_languages.for_each(pkg => runtime.load_package(pkg));

    health.set_runtimes_loaded(true);

    await init_remote_files_cache();
    if (config.remote_files_enabled) {
        health.set_remote_files_ready(true);
    }

    logger.info('Starting API Server');
    logger.debug('Constructing Express App');
    logger.debug('Registering middleware');

    app.use(body_parser.urlencoded({ extended: true }));
    app.use(body_parser.json());

    app.use((err, req, res, next) => {
        return res.status(400).send({
            stack: err.stack,
        });
    });

    logger.debug('Registering Routes');

    app.get('/healthz', (req, res) => {
        return res.status(200).send(health.get_liveness());
    });

    app.get('/readyz', (req, res) => {
        const payload = health.get_readiness();
        return res.status(payload.ready ? 200 : 503).send(payload);
    });

    const api_v2 = require('./api/v2');
    app.use('/api/v2', api_v2);

    const { version } = require('../package.json');

    app.get('/', (req, res, next) => {
        return res.status(200).send({ message: `Piston v${version}` });
    });

    app.use((req, res, next) => {
        return res.status(404).send({ message: 'Not Found' });
    });

    logger.debug('Calling app.listen');
    const [address, port] = config.bind_address.split(':');

    const server = app.listen(port, address, () => {
        logger.info('API server started on', config.bind_address);
    });

    const graceful_shutdown_ms = 25000;
    const handle_shutdown = signal => {
        logger.info(
            `Received ${signal}, marking unready and closing server (drain up to ${graceful_shutdown_ms}ms)`
        );
        health.set_shutting_down(true);
        const force_exit_timer = set_timeout(() => {
            logger.warn('Forced exit after graceful shutdown timeout');
            process.exit(1);
        }, graceful_shutdown_ms);
        force_exit_timer.unref();

        server.close(err => {
            if (err) {
                logger.error(`Error closing server: ${err.message}`);
                process.exit(1);
            }
            logger.info('Server closed cleanly');
            process.exit(0);
        });
    };

    process.on('SIGTERM', () => handle_shutdown('SIGTERM'));
    process.on('SIGINT', () => handle_shutdown('SIGINT'));
})();
