#!/bin/bash

PREFIX=$(realpath $(dirname $0))

mkdir -p build

cd build

curl "https://www.python.org/ftp/python/3.12.0/Python-3.12.0.tgz" -o python.tar.gz
tar xzf python.tar.gz --strip-components=1
rm python.tar.gz

./configure --prefix "$PREFIX" --with-ensurepip=install
make -j$(nproc)
make install -j$(nproc)

cd ..

rm -rf build

bin/pip3 install numpy scipy pandas pycryptodome whoosh bcrypt passlib sympy xxhash base58 cryptography PyNaCl \
    matplotlib scikit-learn requests

cat > "$PREFIX/lib/python3.12/site-packages/sitecustomize.py" <<'EOF'
import os
import sys
import shutil
import subprocess

_USER_CODE_PREFIX = '/box/submission/'

def _is_user_invocation():
    try:
        caller = sys._getframe(2)
    except ValueError:
        return False
    return caller.f_code.co_filename.startswith(_USER_CODE_PREFIX)

def _make_blocker(module_name, func_name, original):
    def _blocked(*args, **kwargs):
        if _is_user_invocation():
            raise PermissionError(
                f"'{module_name}.{func_name}' is not permitted in this environment"
            )
        return original(*args, **kwargs)
    _blocked.__name__ = func_name
    return _blocked

def _patch(module, names):
    for name in names:
        if hasattr(module, name):
            original = getattr(module, name)
            setattr(module, name, _make_blocker(module.__name__, name, original))

_patch(subprocess, {
    # Functions
    'run', 'call', 'check_call', 'check_output',
    'getoutput', 'getstatusoutput',
    # Process class — the underlying primitive all the above use
    'Popen',
})

_patch(os, {
    'system', 'popen',
    'execv', 'execve', 'execvp', 'execvpe',
    'execl', 'execle', 'execlp', 'execlpe',
    'fork', 'forkpty', 'kill', 'killpg', 'abort',
    'spawnl', 'spawnle', 'spawnlp', 'spawnlpe',
    'spawnv', 'spawnve', 'spawnvp', 'spawnvpe',
    'posix_spawn', 'posix_spawnp', 'startfile',
    'listdir', 'scandir', 'walk', 'fwalk',
    'remove', 'unlink', 'rmdir', 'removedirs',
    'mkdir', 'makedirs', 'mkfifo', 'mknod',
    'rename', 'renames', 'replace',
    'chmod', 'chown', 'chflags', 'lchmod', 'lchown', 'lchflags',
    'link', 'symlink', 'truncate',
})

_patch(shutil, {
    'copy', 'copy2', 'copyfile', 'copyfileobj', 'copymode', 'copystat',
    'copytree', 'move', 'rmtree', 'make_archive', 'chown', 'which',
})

_original_excepthook = sys.excepthook

def _excepthook(exc_type, exc_value, exc_tb):
    if exc_type is PermissionError:
        print(str(exc_value), file=sys.stderr)
    else:
        _original_excepthook(exc_type, exc_value, exc_tb)

sys.excepthook = _excepthook
EOF
