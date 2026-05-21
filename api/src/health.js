const config = require('./config');

const state = {
    started_at: Date.now(),
    runtimes_loaded: false,
    remote_files_ready: false,
    shutting_down: false,
};

function set_runtimes_loaded(value = true) {
    state.runtimes_loaded = value;
}

function set_remote_files_ready(value = true) {
    state.remote_files_ready = value;
}

function set_shutting_down(value = true) {
    state.shutting_down = value;
}

function uptime_ms() {
    return Date.now() - state.started_at;
}

function get_liveness() {
    return {
        status: 'ok',
        uptime_ms: uptime_ms(),
        pid: process.pid,
    };
}

function get_readiness() {
    const checks = {
        runtimes_loaded: state.runtimes_loaded,
        remote_files: !config.remote_files_enabled || state.remote_files_ready,
        not_shutting_down: !state.shutting_down,
    };
    const ready = Object.values(checks).every(Boolean);
    return {
        status: ready ? 'ready' : 'not_ready',
        ready,
        checks,
        uptime_ms: uptime_ms(),
        pid: process.pid,
    };
}

module.exports = {
    state,
    set_runtimes_loaded,
    set_remote_files_ready,
    set_shutting_down,
    get_liveness,
    get_readiness,
};
