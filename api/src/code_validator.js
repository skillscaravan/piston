const logger = require('logplease').create('code_validator');

// Per-language source-text denylists. This is the FIRST line of defence:
// catches the obvious literal calls cheaply and returns a clean HTTP 400 so
// the request never reaches Isolate. It is intentionally NOT a security
// boundary on its own — the real per-call enforcement lives in
// packages/python/<ver>/sitecustomize.py (frame-aware, catches dynamic
// lookups, aliasing, getattr, etc.). Keep both layers in sync.

const PYTHON_BLOCKED = [
    // os — shell execution
    { pattern: /\bos\s*\.\s*system\s*\(/, name: 'os.system' },
    { pattern: /\bos\s*\.\s*popen\s*\(/, name: 'os.popen' },

    // os — process spawning / signalling
    { pattern: /\bos\s*\.\s*exec[a-z]+\s*\(/, name: 'os.exec*' },
    { pattern: /\bos\s*\.\s*spawn[a-z]+\s*\(/, name: 'os.spawn*' },
    { pattern: /\bos\s*\.\s*posix_spawn[a-z]*\s*\(/, name: 'os.posix_spawn*' },
    { pattern: /\bos\s*\.\s*fork(pty)?\s*\(/, name: 'os.fork' },
    { pattern: /\bos\s*\.\s*kill(pg)?\s*\(/, name: 'os.kill' },
    { pattern: /\bos\s*\.\s*abort\s*\(/, name: 'os.abort' },

    // os — filesystem enumeration
    { pattern: /\bos\s*\.\s*listdir\s*\(/, name: 'os.listdir' },
    { pattern: /\bos\s*\.\s*scandir\s*\(/, name: 'os.scandir' },
    { pattern: /\bos\s*\.\s*f?walk\s*\(/, name: 'os.walk' },

    // os — filesystem mutation
    {
        pattern: /\bos\s*\.\s*(remove|unlink|rmdir|removedirs)\s*\(/,
        name: 'os.remove/unlink',
    },
    { pattern: /\bos\s*\.\s*makedirs?\s*\(/, name: 'os.mkdir' },
    {
        pattern: /\bos\s*\.\s*(rename|renames|replace)\s*\(/,
        name: 'os.rename',
    },
    {
        pattern: /\bos\s*\.\s*(chmod|chown|chflags|lchmod|lchown|lchflags)\s*\(/,
        name: 'os.chmod/chown',
    },
    {
        pattern: /\bos\s*\.\s*(link|symlink|truncate)\s*\(/,
        name: 'os.link/symlink',
    },

    // subprocess — entire module is dangerous
    { pattern: /\bsubprocess\s*\.\s*\w+\s*\(/, name: 'subprocess.*' },

    // shutil — copy / move / delete
    {
        pattern:
            /\bshutil\s*\.\s*(copy2?|copyfile(obj)?|copytree|move|rmtree|make_archive|chown|which)\s*\(/,
        name: 'shutil.*',
    },
];

const RULES_BY_LANGUAGE = {
    python: PYTHON_BLOCKED,
    python2: PYTHON_BLOCKED,
};

function get_rules_for_language(language) {
    if (typeof language !== 'string') return null;
    return RULES_BY_LANGUAGE[language.toLowerCase()] || null;
}

function validate_code(files, language) {
    const rules = get_rules_for_language(language);
    if (!rules) return;
    if (!Array.isArray(files) || files.length === 0) return;

    const combined = files
        .filter(f => typeof f.content === 'string')
        .map(f => f.content)
        .join('\n');

    for (const { pattern, name } of rules) {
        if (pattern.test(combined)) {
            logger.warn(
                `Rejected ${language} submission: blocked pattern '${name}'`
            );
            const err = new Error(
                `Use of '${name}' is not permitted in this environment`
            );
            err.status = 400;
            err.kind = 'code_blocked';
            err.blocked_name = name;
            throw err;
        }
    }
}

// Synthesizes a /execute-shaped response describing a sandbox-style rejection,
// so the API-layer regex block looks identical to the Python sitecustomize
// PermissionError path on the wire.
function make_blocked_response({ language, version, blocked_name }) {
    const msg = `Use of '${blocked_name}' is not permitted in this environment\n`;
    return {
        run: {
            signal: null,
            stdout: '',
            stderr: msg,
            code: 1,
            output: msg,
            memory: 0,
            message: 'Exited with error status 1',
            status: 'RE',
            cpu_time: 0,
            wall_time: 0,
        },
        language,
        version,
    };
}

module.exports = {
    validate_code,
    get_rules_for_language,
    make_blocked_response,
};
