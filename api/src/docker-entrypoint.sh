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
# node. Clean up leftover sub-cgroups and recreate.
cleanup_isolate_cgroup() {
    [ -d /sys/fs/cgroup/isolate ] || return 0
    # Walk depth-first; move any stuck PIDs to root, then rmdir.
    find /sys/fs/cgroup/isolate -mindepth 1 -type d -depth 2>/dev/null | \
        while read -r dir; do
            if [ -f "$dir/cgroup.procs" ]; then
                while read -r pid; do
                    echo "$pid" > /sys/fs/cgroup/cgroup.procs 2>/dev/null || true
                done < "$dir/cgroup.procs"
            fi
            rmdir "$dir" 2>/dev/null || true
        done
    rmdir /sys/fs/cgroup/isolate 2>/dev/null || true
}

cleanup_isolate_cgroup

cd /sys/fs/cgroup && \
mkdir -p isolate && \
echo 1 > isolate/cgroup.procs && \
echo '+cpuset +cpu +io +memory +pids' > cgroup.subtree_control && \
cd isolate && \
mkdir -p init && \
echo 1 > init/cgroup.procs && \
echo '+cpuset +memory' > cgroup.subtree_control && \
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
