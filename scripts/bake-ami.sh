#!/usr/bin/env bash
# Bake the prebaked AMI that `amiId` in sst.config.ts points at: Amazon
# Linux 2023 arm64 with Docker, the compose plugin, the Caddy build and both
# Convex images already on the disk, so a fresh instance boots in under a
# minute instead of installing and pulling for ten.
#
# Everything comes from the repo so the image cannot drift from the code:
# the compose plugin version and Caddy URL from infra/convex-backend.ts, the
# image digests from docker/docker-compose.yml. Rebake after changing any
# of them, then put the printed id in sst.config.ts.
#
# Needs only the AWS CLI. It creates a throwaway VPC, boots a builder whose
# userData installs everything and shuts the box down, snapshots it into an
# AMI, boots a second instance from that AMI to verify it, and deletes the
# VPC and both instances again. About six minutes. Older AMIs are left in
# place; pass --replace to deregister them and their snapshots once the new
# one is verified.

set -euo pipefail

REGION=""
PROFILE=""
INSTANCE_TYPE="t4g.small"
REPLACE=0
VERIFY=1

usage() {
  sed -n '2,17p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'
  cat <<'USAGE'

Options:
  -r, --region REGION     Region to build in. Defaults to sst.settings.json's.
  -p, --profile PROFILE   AWS profile. Defaults to the environment's.
      --instance-type T   arm64 instance type for the builder. Default t4g.small.
      --replace           Deregister every other self-owned AMI named
                          convex-backend-* after the new one is verified.
      --no-verify         Skip the boot test of the finished AMI.
  -h, --help              This text.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    -r|--region) REGION="${2:-}"; shift 2 ;;
    -p|--profile) PROFILE="${2:-}"; shift 2 ;;
    --instance-type) INSTANCE_TYPE="${2:-}"; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "$REGION" ]; then
  REGION="$(sed -n 's/.*"region": *"\([^"]*\)".*/\1/p' "$ROOT/sst.settings.json" 2>/dev/null | head -1)"
  [ -n "$REGION" ] || { echo "--region is required (no region in sst.settings.json)" >&2; exit 2; }
fi
command -v aws >/dev/null || { echo "aws cli not found" >&2; exit 1; }
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
if [ -n "$PROFILE" ]; then export AWS_PROFILE="$PROFILE"; fi

# ---- what goes in the image, read from the code -----------------------------

COMPOSE_PLUGIN_VERSION=$(sed -n 's/^const COMPOSE_PLUGIN_VERSION = "\([^"]*\)".*/\1/p' "$ROOT/infra/convex-backend.ts")
CADDY_DOWNLOAD_URL=$(sed -n '/^const CADDY_DOWNLOAD_URL =/{n;s/^ *"\([^"]*\)".*/\1/p;}' "$ROOT/infra/convex-backend.ts")
IMAGES=$(sed -n 's/^ *image: *\(ghcr.io\/get-convex\/[^ ]*\).*/\1/p' "$ROOT/docker/docker-compose.yml" | tr '\n' ' ')
for v in COMPOSE_PLUGIN_VERSION CADDY_DOWNLOAD_URL IMAGES; do
  [ -n "${!v}" ] || { echo "could not read $v from the repo" >&2; exit 1; }
done
[ "$(echo $IMAGES | wc -w)" -eq 2 ] || { echo "expected two images in docker/docker-compose.yml" >&2; exit 1; }

BASE=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64 \
  --query Parameter.Value --output text)
NAME="convex-backend-al2023-arm64-$(date -u +%Y-%m-%d-%H%M)"
DESCRIPTION="AL2023 arm64 + docker, compose $COMPOSE_PLUGIN_VERSION, convex-backend/dashboard at the compose digests, caddy from ${CADDY_DOWNLOAD_URL##*/download/}"

echo "region      $REGION"
echo "base        $BASE"
echo "compose     $COMPOSE_PLUGIN_VERSION"
echo "caddy       $CADDY_DOWNLOAD_URL"
printf 'image       %s\n' $IMAGES
echo "name        $NAME"

# ---- the scripts the two instances run --------------------------------------

WORK=$(mktemp -d)
trap 'cleanup' EXIT

# The builder: mirror of the stock install path in infra/convex-backend.ts,
# then everything that makes the disk generic again. `shutdown` at the end is
# the done signal; a failure leaves the box running and the log on it.
cat > "$WORK/bake.sh" <<EOF
#!/bin/bash
set -euxo pipefail
exec > /var/log/bake.log 2>&1
dnf update -y
dnf install -y docker
install -m 0755 -d /usr/local/lib/docker/cli-plugins
curl -fsSL --retry 5 -o /usr/local/lib/docker/cli-plugins/docker-compose \\
  https://github.com/docker/compose/releases/download/${COMPOSE_PLUGIN_VERSION}/docker-compose-linux-aarch64
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
systemctl enable --now docker
curl -fsSL --retry 5 -o /usr/bin/caddy '${CADDY_DOWNLOAD_URL}'
chmod +x /usr/bin/caddy
groupadd --system caddy
useradd --system --gid caddy --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy
for image in $IMAGES; do
  for _ in \$(seq 1 20); do docker pull "\$image" && break; sleep 30; done
  docker image inspect "\$image" > /dev/null
done
systemctl stop docker
cloud-init clean --logs
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id
rm -rf /var/lib/dhcp/* /tmp/* /var/tmp/*
shutdown -h now
EOF

# The verifier: boots from the new AMI, prints its checks on the serial
# console (readable with get-console-output, no SSH) and shuts down only
# when they all pass. Docker takes a moment to come up on first boot.
cat > "$WORK/verify.sh" <<EOF
#!/bin/bash
exec > /dev/console 2>&1
echo VERIFY-START
ok=1
docker --version || ok=0
docker compose version || ok=0
caddy version || ok=0
id caddy || ok=0
systemctl is-enabled docker || ok=0
for _ in \$(seq 1 30); do systemctl is-active --quiet docker && break; sleep 2; done
systemctl is-active docker || ok=0
for image in $IMAGES; do docker image inspect "\$image" > /dev/null && echo "present \$image" || ok=0; done
echo "VERIFY-RESULT ok=\$ok"
[ "\$ok" = 1 ] && shutdown -h now
EOF

# ---- helpers ----------------------------------------------------------------

TAGS='{Key=Project,Value=mnlth},{Key=Purpose,Value=ami-bake-temp}'
tag() { printf 'ResourceType=%s,Tags=[{Key=Name,Value=mnlth-ami-builder},%s]' "$1" "$TAGS"; }

VPC="" SUBNET="" IGW="" SG="" BUILDER="" VERIFIER=""

wait_state() { # instance, state, timeout seconds
  local i=$1 want=$2 deadline=$(( $(date +%s) + $3 )) state
  while :; do
    state=$(aws ec2 describe-instances --instance-ids "$i" \
      --query 'Reservations[0].Instances[0].State.Name' --output text)
    [ "$state" = "$want" ] && return 0
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "$i is $state, not $want, after $3s" >&2
      return 1
    fi
    sleep 10
  done
}

cleanup() {
  local ids=""
  for i in $BUILDER $VERIFIER; do
    [ -n "$i" ] && ids="$ids $i"
  done
  if [ -n "$ids" ]; then
    echo "terminating$ids"
    aws ec2 terminate-instances --instance-ids $ids > /dev/null 2>&1 || true
    aws ec2 wait instance-terminated --instance-ids $ids 2>/dev/null || true
  fi
  [ -n "$SG" ] && aws ec2 delete-security-group --group-id "$SG" > /dev/null 2>&1 || true
  if [ -n "$IGW" ]; then
    aws ec2 detach-internet-gateway --internet-gateway-id "$IGW" --vpc-id "$VPC" 2>/dev/null || true
    aws ec2 delete-internet-gateway --internet-gateway-id "$IGW" 2>/dev/null || true
  fi
  [ -n "$SUBNET" ] && aws ec2 delete-subnet --subnet-id "$SUBNET" 2>/dev/null || true
  [ -n "$VPC" ] && aws ec2 delete-vpc --vpc-id "$VPC" 2>/dev/null || true
  rm -rf "$WORK"
}

# ---- throwaway network ------------------------------------------------------

echo
echo "== network"
VPC=$(aws ec2 create-vpc --cidr-block 10.99.0.0/24 --tag-specifications "$(tag vpc)" \
  --query Vpc.VpcId --output text)
aws ec2 modify-vpc-attribute --vpc-id "$VPC" --enable-dns-hostnames
SUBNET=$(aws ec2 create-subnet --vpc-id "$VPC" --cidr-block 10.99.0.0/24 --tag-specifications "$(tag subnet)" \
  --query Subnet.SubnetId --output text)
aws ec2 modify-subnet-attribute --subnet-id "$SUBNET" --map-public-ip-on-launch
IGW=$(aws ec2 create-internet-gateway --tag-specifications "$(tag internet-gateway)" \
  --query InternetGateway.InternetGatewayId --output text)
aws ec2 attach-internet-gateway --vpc-id "$VPC" --internet-gateway-id "$IGW"
RT=$(aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$VPC" \
  --query 'RouteTables[0].RouteTableId' --output text)
aws ec2 create-route --route-table-id "$RT" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW" > /dev/null
# No ingress rules: nothing needs to reach the builder, it only downloads.
SG=$(aws ec2 create-security-group --vpc-id "$VPC" --group-name "mnlth-ami-builder-$$" \
  --description "temporary AMI builder, egress only" --tag-specifications "$(tag security-group)" \
  --query GroupId --output text)
echo "$VPC $SUBNET $IGW $SG"

# ---- build ------------------------------------------------------------------

echo
echo "== builder"
BUILDER=$(aws ec2 run-instances --image-id "$BASE" --instance-type "$INSTANCE_TYPE" \
  --subnet-id "$SUBNET" --security-group-ids "$SG" \
  --instance-initiated-shutdown-behavior stop \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --user-data "file://$WORK/bake.sh" --tag-specifications "$(tag instance)" \
  --query 'Instances[0].InstanceId' --output text)
echo "$BUILDER installing, waits for it to shut itself down"
if ! wait_state "$BUILDER" stopped 1200; then
  echo "the bake did not finish; /var/log/bake.log on $BUILDER has the reason" >&2
  echo "the builder is left running for a look, delete it and VPC $VPC by hand" >&2
  BUILDER=""; VPC=""; SUBNET=""; IGW=""; SG=""
  exit 1
fi

echo
echo "== image"
AMI=$(aws ec2 create-image --instance-id "$BUILDER" --name "$NAME" --description "$DESCRIPTION" \
  --tag-specifications "ResourceType=image,Tags=[{Key=Name,Value=$NAME},{Key=Project,Value=mnlth}]" \
    "ResourceType=snapshot,Tags=[{Key=Name,Value=$NAME},{Key=Project,Value=mnlth}]" \
  --query ImageId --output text)
echo "$AMI creating"
aws ec2 wait image-available --image-ids "$AMI"
echo "$AMI available"

# ---- verify -----------------------------------------------------------------

if [ "$VERIFY" -eq 1 ]; then
  echo
  echo "== verify"
  VERIFIER=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
    --subnet-id "$SUBNET" --security-group-ids "$SG" \
    --instance-initiated-shutdown-behavior stop \
    --user-data "file://$WORK/verify.sh" --tag-specifications "$(tag instance)" \
    --query 'Instances[0].InstanceId' --output text)
  echo "$VERIFIER booting from $AMI"
  if wait_state "$VERIFIER" stopped 300; then
    echo "every check passed"
  else
    echo "the verifier did not shut down, so a check failed. Its console:" >&2
    aws ec2 get-console-output --instance-id "$VERIFIER" --latest --output text \
      | sed -n '/VERIFY-START/,/VERIFY-RESULT/p' >&2
    echo "deregistering $AMI" >&2
    SNAP=$(aws ec2 describe-images --image-ids "$AMI" --query 'Images[0].BlockDeviceMappings[0].Ebs.SnapshotId' --output text)
    aws ec2 deregister-image --image-id "$AMI" > /dev/null
    aws ec2 delete-snapshot --snapshot-id "$SNAP"
    exit 1
  fi
fi

# ---- replace ----------------------------------------------------------------

if [ "$REPLACE" -eq 1 ]; then
  echo
  echo "== replace"
  aws ec2 describe-images --owners self --filters "Name=name,Values=convex-backend-*" \
    --query "Images[?ImageId!='$AMI'].[ImageId,BlockDeviceMappings[0].Ebs.SnapshotId]" --output text \
  | while read -r old snap; do
      [ -n "$old" ] || continue
      echo "deregistering $old ($snap)"
      aws ec2 deregister-image --image-id "$old" > /dev/null
      [ "$snap" != None ] && aws ec2 delete-snapshot --snapshot-id "$snap"
    done
fi

echo
echo "AMI $AMI"
echo "Set it in sst.config.ts:  amiId: \"$AMI\""
