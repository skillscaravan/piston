const logger = require('logplease').create('output_filter');

// Post-execution rewrite rules. Each rule looks for known sandbox-induced
// error signatures in the captured stderr and replaces the noisy traceback
// with a single clean line, matching the UX of the sitecustomize.py
// PermissionError handler. stdout is left untouched so users who explicitly
// catch and print errors still see their own output.
//
// A rule's `message` can be either a string (used as-is) or a function that
// receives the regex match array and returns a string (for dynamic context
// like file paths).
const RULES = [
    {
        name: 'network-disabled',
        match: /Temporary failure in name resolution|Network is unreachable|NameResolutionError|Failed to resolve|socket\.gaierror|\[Errno -?(3|101)\]/,
        message: 'Internet access is disabled in this environment.',
    },
    {
        // FileNotFoundError / PermissionError / OSError targeting paths that
        // are not mounted writable in the sandbox. /tmp and /box/submission
        // are explicitly excluded from this list since they ARE writable.
        name: 'filesystem-restricted',
        match: /(?:FileNotFoundError|PermissionError|OSError|IsADirectoryError):\s*\[Errno (?:1|2|13|30)\][^\n]*?'(\/(?:home|root|var|opt|etc|sys|proc|usr|piston|sbin|bin|lib|lib64|boot|dev|run|srv|media|mnt|box(?!\/submission))[^']*)'/,
        message: match =>
            `Cannot access '${match[1]}' — filesystem access outside the working directory is not permitted in this environment.`,
    },
    {
        // Triggered when user code tries to pickle/marshal/copy a built-in
        // that sitecustomize.py has replaced (os.system, subprocess.Popen,
        // shutil.rmtree, etc.). The native serializer error otherwise leaks
        // the internal wrapper name (`_make_blocker.<locals>._blocked`).
        // This also functionally blocks pickle-based RCE payloads that try
        // to ship a restricted callable as their `__reduce__` target —
        // pickle refuses to serialize the closure, so the malicious bytes
        // never get written in the first place.
        name: 'restricted-builtin-serialization',
        match: /_make_blocker\.<locals>\._blocked|(?:Can't pickle|cannot pickle)[^\n]*?_blocked/,
        message:
            'Cannot serialize a restricted built-in (e.g. os.system, subprocess.Popen). This operation is not permitted in this environment.',
    },
];

function resolve_message(rule, match) {
    if (typeof rule.message === 'function') return rule.message(match);
    return rule.message;
}

function find_matching_rule(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    for (const rule of RULES) {
        const match = text.match(rule.match);
        if (match) return { rule, match };
    }
    return null;
}

function rewrite_stage(stage) {
    if (!stage || typeof stage !== 'object') return stage;

    const hit = find_matching_rule(stage.stderr);
    if (!hit) return stage;

    logger.debug(`Rewriting output via rule '${hit.rule.name}'`);

    const clean = `${resolve_message(hit.rule, hit.match)}\n`;
    return {
        ...stage,
        stderr: clean,
        output: clean,
    };
}

function sanitize_result(result) {
    if (!result || typeof result !== 'object') return result;

    const sanitized = { ...result };
    if (result.compile) sanitized.compile = rewrite_stage(result.compile);
    if (result.run) sanitized.run = rewrite_stage(result.run);
    return sanitized;
}

module.exports = {
    sanitize_result,
    rewrite_stage,
    find_matching_rule,
};
