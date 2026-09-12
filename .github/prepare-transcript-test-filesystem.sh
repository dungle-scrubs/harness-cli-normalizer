#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then exit 0; fi

sudo apt-get update
sudo apt-get install --yes xfsprogs
snapshot_image="$RUNNER_TEMP/hcn-snapshot.xfs"
snapshot_mount="$RUNNER_TEMP/hcn-snapshot-mount"
truncate -s 512M "$snapshot_image"
mkfs.xfs -m reflink=1 "$snapshot_image"
mkdir "$snapshot_mount"
sudo mount -o loop "$snapshot_image" "$snapshot_mount"
sudo chown "$(id -u):$(id -g)" "$snapshot_mount"
chmod 700 "$snapshot_mount"
echo "TMPDIR=$snapshot_mount" >> "$GITHUB_ENV"
