#!/bin/bash

CGROUP_FS="/sys/fs/cgroup"
if [ ! -e "$CGROUP_FS" ]; then
  echo "Cannot find $CGROUP_FS. Please make sure your system is using cgroup v2"
  exit 1
fi

if [ -e "$CGROUP_FS/unified" ]; then
  echo "Combined cgroup v1+v2 mode is not supported. Please make sure your system is using pure cgroup v2"
  exit 1
fi

if [ ! -e "$CGROUP_FS/cgroup.subtree_control" ]; then
  echo "Cgroup v2 not found. Please make sure cgroup v2 is enabled on your system"
  exit 1
fi

# On K8s with privileged + shared cgroup namespace, /sys/fs/cgroup is the
# host's tree, and 'isolate' may already exist from a prior pod run on this
# node — possibly with subtree controllers enabled, which makes it a non-leaf
# cgroup that cannot accept processes (causes EBUSY on cgroup.procs writes).
# Clean up leftover sub-cgroups, disable their subtree controllers, and recreate.
disable_subtree_controllers() {
    # $1 = path to a cgroup directory
    local f="$1/cgroup.subtree_control"
    [ -f "$f" ] || return 0
    # Read the currently-enabled controllers and disable each one in turn.
    local current
    current="$(cat "$f" 2>/dev/null || true)"
    for c in $current; do
        echo "-$c" > "$f" 2>/dev/null || true
    done
}

cleanup_isolate_cgroup() {
    [ -d /sys/fs/cgroup/isolate ] || return 0

    # Move any procs directly inside isolate out to the root cgroup first,
    # so that disabling subtree_control is allowed.
    if [ -f /sys/fs/cgroup/isolate/cgroup.procs ]; then
        while read -r pid; do
            echo "$pid" > /sys/fs/cgroup/cgroup.procs 2>/dev/null || true
        done < /sys/fs/cgroup/isolate/cgroup.procs
    fi

    # Walk depth-first; for each descendant cgroup, move PIDs to root,
    # disable its subtree controllers, then rmdir.
    find /sys/fs/cgroup/isolate -mindepth 1 -type d -depth 2>/dev/null | \
        while read -r dir; do
            if [ -f "$dir/cgroup.procs" ]; then
                while read -r pid; do
                    echo "$pid" > /sys/fs/cgroup/cgroup.procs 2>/dev/null || true
                done < "$dir/cgroup.procs"
            fi
            disable_subtree_controllers "$dir"
            rmdir "$dir" 2>/dev/null || true
        done

    # Disable subtree_control on isolate itself so it becomes a leaf and can
    # either be rmdir'd or reused for fresh process placement.
    disable_subtree_controllers /sys/fs/cgroup/isolate
    rmdir /sys/fs/cgroup/isolate 2>/dev/null || true
}

cleanup_isolate_cgroup

cd /sys/fs/cgroup || { echo "ERROR: cannot cd /sys/fs/cgroup" >&2; exit 1; }
mkdir -p isolate

# Belt-and-suspenders: if cleanup couldn't rmdir isolate (e.g. stale state we
# don't have permission to clear), make sure it's at least a leaf cgroup so
# the next write to cgroup.procs doesn't fail with EBUSY.
disable_subtree_controllers /sys/fs/cgroup/isolate

if ! echo 1 > isolate/cgroup.procs 2>/dev/null; then
    echo "ERROR: failed to place pid 1 into /sys/fs/cgroup/isolate (EBUSY?)." >&2
    echo "  This usually means a prior pod left the cgroup in a non-leaf state" >&2
    echo "  on a shared K8s node, or the cgroup namespace is not writable." >&2
    cat /sys/fs/cgroup/isolate/cgroup.subtree_control 2>/dev/null \
        | xargs -I{} echo "  isolate has subtree controllers active: {}" >&2
    exit 1
fi

echo '+cpuset +cpu +io +memory +pids' > cgroup.subtree_control
cd isolate
mkdir -p init
echo 1 > init/cgroup.procs
echo '+cpuset +memory' > cgroup.subtree_control
echo "Initialized cgroup"

# Restore any packages baked into the image (e.g. /opt/piston_pkg_cache/python/3.12.0)
# onto the /piston/packages volume if they aren't already installed. This lets us
# ship Python + libs + sitecustomize.py inside the image while still supporting
# a PVC-mounted /piston/packages for cross-restart persistence.
if [ -d /opt/piston_pkg_cache ]; then
    for lang_dir in /opt/piston_pkg_cache/*/; do
        lang="$(basename "$lang_dir")"
        for ver_dir in "$lang_dir"*/; do
            [ -d "$ver_dir" ] || continue
            ver="$(basename "$ver_dir")"
            dest="/piston/packages/$lang/$ver"
            if [ ! -f "$dest/.ppman-installed" ]; then
                echo "Restoring baked package $lang-$ver -> $dest"
                mkdir -p "$(dirname "$dest")"
                cp -a "$ver_dir" "$dest"
            fi
        done
    done
fi

chown -R piston:piston /piston && \
exec su -- piston -c 'ulimit -n 65536 && node /piston_api/src'
