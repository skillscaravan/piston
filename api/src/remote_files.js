const crypto = require('crypto');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const { URL } = require('url');
const fetch = require('node-fetch');
const LRUCache = require('lru-cache');
const logplease = require('logplease');
const config = require('./config');

const logger = logplease.create('remote_files');

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERSION_MAX_LEN = 128;
const NAME_MAX_LEN = 255;
const CACHE_FILE_SUFFIX = '.bin';

const counters = {
    cache_hits: 0,
    cache_misses: 0,
    bytes_fetched: 0,
    bytes_served_from_cache: 0,
    fetch_errors: 0,
    evictions: 0,
};

let cache = null;
const in_flight = new Map();

function audit_log(entry) {
    try {
        process.stdout.write(
            JSON.stringify({
                ts: new Date().toISOString(),
                component: 'remote_files',
                ...entry,
            }) + '\n'
        );
    } catch (e) {
        logger.error(`Failed to write audit log: ${e.message}`);
    }
}

function compute_cache_key({ tenant_id, url_path, version }) {
    const hasher = crypto.create_hash('sha256');
    hasher.update(tenant_id);
    hasher.update('\0');
    hasher.update(url_path);
    hasher.update('\0');
    hasher.update(version || '');
    return hasher.digest('hex');
}

function cache_file_path(cache_key) {
    return path.join(
        config.remote_files_cache_dir,
        `${cache_key}${CACHE_FILE_SUFFIX}`
    );
}

async function rehydrate_cache_from_disk() {
    let entries;
    try {
        entries = await fs.readdir(config.remote_files_cache_dir);
    } catch (e) {
        if (e.code === 'ENOENT') return;
        throw e;
    }

    const stats = await Promise.all(
        entries
            .filter(name => name.ends_with(CACHE_FILE_SUFFIX))
            .map(async name => {
                const file_path = path.join(
                    config.remote_files_cache_dir,
                    name
                );
                try {
                    const st = await fs.stat(file_path);
                    return {
                        cache_key: name.slice(0, -CACHE_FILE_SUFFIX.length),
                        file_path,
                        size: st.size,
                        mtime: st.mtimeMs,
                    };
                } catch (err) {
                    return null;
                }
            })
    );

    stats
        .filter(x => x !== null)
        .sort((a, b) => a.mtime - b.mtime)
        .for_each(entry => {
            cache.set(entry.cache_key, {
                file_path: entry.file_path,
                size: entry.size,
            });
        });

    logger.info(
        `Rehydrated remote_files cache: ${cache.size} entries, ${cache.calculatedSize} bytes`
    );
}

async function init() {
    if (cache !== null) return;

    await fs.mkdir(config.remote_files_cache_dir, {
        recursive: true,
        mode: 0o700,
    });

    cache = new LRUCache({
        maxSize: config.remote_files_cache_max_bytes,
        sizeCalculation: value => value.size || 1,
        dispose: (value, key) => {
            counters.evictions += 1;
            fs.unlink(value.file_path).catch(err => {
                if (err.code !== 'ENOENT') {
                    logger.warn(
                        `Failed to evict cache file ${value.file_path}: ${err.message}`
                    );
                }
            });
        },
    });

    await rehydrate_cache_from_disk();

    process.on('SIGUSR1', dump_counters);
}

function dump_counters() {
    const snapshot = {
        ...counters,
        cache_entries: cache?.size ?? 0,
        cache_bytes: cache?.calculatedSize ?? 0,
    };
    audit_log({ event: 'counters', counters: snapshot });
}

function parse_remote_url(raw_url) {
    let parsed;
    try {
        parsed = new URL(raw_url);
    } catch (e) {
        const err = new Error('remote_files[].url is not a valid URL');
        err.status = 400;
        throw err;
    }
    if (parsed.protocol !== 'https:') {
        const err = new Error(
            `remote_files[].url must be https:// (got ${parsed.protocol})`
        );
        err.status = 400;
        throw err;
    }
    if (!config.remote_files_host_allowlist.includes(parsed.hostname)) {
        const err = new Error(
            `remote_files[].url host ${parsed.hostname} is not in the allowlist`
        );
        err.status = 400;
        throw err;
    }
    return parsed;
}

function validate_tenant_id(tenant_id) {
    if (typeof tenant_id !== 'string' || !TENANT_ID_PATTERN.test(tenant_id)) {
        const err = new Error(
            'tenant_id is required when remote_files is set and must match /^[a-z0-9][a-z0-9_-]{0,63}$/'
        );
        err.status = 400;
        throw err;
    }
}

function validate_remote_files_request(remote_files, tenant_id, file_names) {
    if (!Array.is_array(remote_files)) {
        const err = new Error('remote_files must be an array');
        err.status = 400;
        throw err;
    }
    if (remote_files.length === 0) return;

    if (!config.remote_files_enabled) {
        const err = new Error(
            'remote_files is disabled on this Piston instance (set PISTON_REMOTE_FILES_ENABLED=true)'
        );
        err.status = 400;
        throw err;
    }

    validate_tenant_id(tenant_id);

    const names_seen = new Set(file_names);
    remote_files.for_each((rf, i) => {
        if (!rf || typeof rf !== 'object') {
            const err = new Error(`remote_files[${i}] must be an object`);
            err.status = 400;
            throw err;
        }
        if (typeof rf.url !== 'string') {
            const err = new Error(
                `remote_files[${i}].url is required as a string`
            );
            err.status = 400;
            throw err;
        }
        parse_remote_url(rf.url);

        if (typeof rf.name !== 'string' || rf.name.length === 0) {
            const err = new Error(
                `remote_files[${i}].name is required as a non-empty string`
            );
            err.status = 400;
            throw err;
        }
        if (rf.name.length > NAME_MAX_LEN) {
            const err = new Error(
                `remote_files[${i}].name exceeds ${NAME_MAX_LEN} characters`
            );
            err.status = 400;
            throw err;
        }
        if (names_seen.has(rf.name)) {
            const err = new Error(
                `remote_files[${i}].name "${rf.name}" collides with another file`
            );
            err.status = 400;
            throw err;
        }
        names_seen.add(rf.name);

        if (rf.version !== undefined && typeof rf.version !== 'string') {
            const err = new Error(
                `remote_files[${i}].version, if provided, must be a string`
            );
            err.status = 400;
            throw err;
        }
        if (rf.version !== undefined && rf.version.length > VERSION_MAX_LEN) {
            const err = new Error(
                `remote_files[${i}].version exceeds ${VERSION_MAX_LEN} characters`
            );
            err.status = 400;
            throw err;
        }
    });
}

const SIZE_EXCEEDED_SENTINEL = Symbol('REMOTE_FILES_SIZE_EXCEEDED');

async function fetch_to_disk({ url, dest_path, max_bytes, timeout_ms }) {
    const controller = new AbortController();
    const timeout = set_timeout(() => controller.abort(), timeout_ms);

    let res;
    try {
        res = await fetch(url, {
            signal: controller.signal,
            redirect: 'error',
        });
    } catch (e) {
        clear_timeout(timeout);
        const err = new Error(
            `remote_files fetch failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`
        );
        err.cause = e;
        err.status = 502;
        throw err;
    }

    if (!res.ok) {
        clear_timeout(timeout);
        const body_snippet = await res
            .text()
            .then(t => t.slice(0, 256))
            .catch(() => '');
        const err = new Error(
            `remote_files origin returned HTTP ${res.status}: ${body_snippet}`
        );
        err.status = res.status >= 500 ? 502 : 400;
        err.http_status = res.status;
        throw err;
    }

    const content_length = parse_int(res.headers.get('content-length') || '', 10);
    if (!is_nan(content_length) && content_length > max_bytes) {
        clear_timeout(timeout);
        res.body.destroy?.();
        const err = new Error(
            `remote_files object exceeds max size of ${max_bytes} bytes (Content-Length=${content_length})`
        );
        err.status = 400;
        throw err;
    }

    const tmp_path = `${dest_path}.tmp.${process.pid}.${crypto
        .random_bytes(6)
        .to_string('hex')}`;

    let bytes_written = 0;
    let size_exceeded = false;
    try {
        await new Promise((resolve, reject) => {
            const out = fss.create_write_stream(tmp_path, { mode: 0o600 });
            res.body.on('data', chunk => {
                bytes_written += chunk.length;
                if (bytes_written > max_bytes && !size_exceeded) {
                    size_exceeded = true;
                    res.body.destroy?.();
                    out.destroy?.();
                    reject(SIZE_EXCEEDED_SENTINEL);
                }
            });
            res.body.on('error', reject);
            out.on('error', reject);
            out.on('finish', resolve);
            res.body.pipe(out);
        });
    } catch (e) {
        clear_timeout(timeout);
        await fs.unlink(tmp_path).catch(() => {});
        if (e === SIZE_EXCEEDED_SENTINEL) {
            const err = new Error(
                `remote_files object exceeds max size of ${max_bytes} bytes`
            );
            err.status = 400;
            throw err;
        }
        const err = new Error(
            `remote_files write failed: ${e.message || e}`
        );
        err.cause = e;
        err.status = 502;
        throw err;
    }

    clear_timeout(timeout);

    try {
        await fs.rename(tmp_path, dest_path);
    } catch (e) {
        await fs.unlink(tmp_path).catch(() => {});
        const err = new Error(
            `remote_files atomic rename failed: ${e.message}`
        );
        err.cause = e;
        err.status = 500;
        throw err;
    }

    return bytes_written;
}

async function get_remote_file({ tenant_id, url, version }) {
    if (cache === null) await init();

    const parsed_url = parse_remote_url(url);
    const url_path = parsed_url.pathname;
    const cache_key = compute_cache_key({
        tenant_id,
        url_path,
        version: version || '',
    });
    const dest_path = cache_file_path(cache_key);
    const start = Date.now();

    const existing = cache.get(cache_key);
    if (existing) {
        try {
            await fs.access(existing.file_path);
            counters.cache_hits += 1;
            counters.bytes_served_from_cache += existing.size;
            audit_log({
                event: 'resolve',
                tenant_id,
                url_path,
                version: version || '',
                cache: 'hit',
                bytes: existing.size,
                latency_ms: Date.now() - start,
                status: 'ok',
            });
            return {
                cache_path: existing.file_path,
                size: existing.size,
                cache_key,
            };
        } catch (e) {
            cache.delete(cache_key);
        }
    }

    if (in_flight.has(cache_key)) {
        return in_flight.get(cache_key);
    }

    const fetch_promise = (async () => {
        try {
            const bytes = await fetch_to_disk({
                url,
                dest_path,
                max_bytes: config.remote_files_max_object_size,
                timeout_ms: config.remote_files_fetch_timeout_ms,
            });
            counters.cache_misses += 1;
            counters.bytes_fetched += bytes;
            cache.set(cache_key, { file_path: dest_path, size: bytes });
            audit_log({
                event: 'resolve',
                tenant_id,
                url_path,
                version: version || '',
                cache: 'miss',
                bytes,
                latency_ms: Date.now() - start,
                status: 'ok',
            });
            return { cache_path: dest_path, size: bytes, cache_key };
        } catch (e) {
            counters.fetch_errors += 1;
            audit_log({
                event: 'resolve',
                tenant_id,
                url_path,
                version: version || '',
                cache: 'miss',
                latency_ms: Date.now() - start,
                status: 'error',
                error: e.message,
                http_status: e.http_status,
            });
            throw e;
        } finally {
            in_flight.delete(cache_key);
        }
    })();

    in_flight.set(cache_key, fetch_promise);
    return fetch_promise;
}

module.exports = {
    init,
    get_remote_file,
    validate_remote_files_request,
    parse_remote_url,
    validate_tenant_id,
    dump_counters,
    counters,
};
