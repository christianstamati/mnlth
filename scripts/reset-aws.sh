#!/usr/bin/env bash
#
# reset-aws.sh — delete every resource in one AWS region.
#
#   bun reset:aws --dry-run          # region from sst.config.ts
#   bun reset:aws
#   ./scripts/reset-aws.sh --region eu-central-1
#
# Written for this app's teardowns, where `sst remove` reports resources as
# "Deleted" that are still live (its retain list covers the VPC, subnets and
# the default security group) and where orphans outlive the stage that made
# them. It deletes by asking AWS what is there, not by reading SST state, so
# it finds both.
#
# Pass --keep-images to keep AMIs, their snapshots and key pairs: a prebaked
# AMI (the `amiId` option of ConvexBackend) takes a while to build and has no
# stage of its own.
#
# It keeps the SST bootstrap by default — the `sst-state-*` / `sst-asset-*`
# buckets and `/sst/*` parameters — because losing those loses every stage's
# state and passphrase. Pass --include-sst to take them too.
#
# Not covered, because none of it is regional: IAM users, roles and policies,
# Route 53 hosted zones, CloudFront distributions, and buckets outside the
# target region. Those are listed at the end as a report, never deleted.

set -euo pipefail

REGION=""
PROFILE=""
ASSUME_YES=0
DRY_RUN=0
INCLUDE_SST=0
INCLUDE_DEFAULT_VPC=0
KEEP_IMAGES=0
DELETED=0
FAILED=0

usage() {
  sed -n '3,25p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'
  cat <<'USAGE'

Options:
  -r, --region REGION     Region to empty. Defaults to sst.config.ts's.
  -p, --profile PROFILE   AWS profile. Defaults to the environment's.
  -y, --yes               Skip the typed confirmation.
      --dry-run           Print the inventory and what would be deleted, then stop.
      --include-sst       Also delete the sst-state/sst-asset buckets and /sst/* parameters.
      --include-default-vpc
                          Also delete the region's default VPC.
      --keep-images       Keep AMIs, their snapshots and key pairs.
  -h, --help              This text.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    -r|--region) REGION="${2:-}"; shift 2 ;;
    -p|--profile) PROFILE="${2:-}"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --include-sst) INCLUDE_SST=1; shift ;;
    --include-default-vpc) INCLUDE_DEFAULT_VPC=1; shift ;;
    --keep-images) KEEP_IMAGES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$REGION" ]; then
  CONFIG="$(dirname "$0")/../sst.config.ts"
  REGION="$(sed -n 's/.*const region = *"\([^"]*\)".*/\1/p' "$CONFIG" 2>/dev/null | head -1)"
  [ -n "$REGION" ] || { echo "--region is required (no region in $CONFIG)" >&2; usage >&2; exit 2; }
fi
command -v aws >/dev/null || { echo "aws cli not found" >&2; exit 1; }

export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"
if [ -n "$PROFILE" ]; then export AWS_PROFILE="$PROFILE"; fi

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
  RED=$(printf '\033[31m'); YELLOW=$(printf '\033[33m'); OFF=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; YELLOW=""; OFF=""
fi

section() { printf '\n%s== %s%s\n' "$BOLD" "$1" "$OFF"; }
note()    { printf '%s   %s%s\n' "$DIM" "$1" "$OFF"; }
warn()    { printf '%s   ! %s%s\n' "$YELLOW" "$1" "$OFF" >&2; }

# Every describe is best-effort: a service may be disabled in the region, or
# the caller may lack permission for it. Neither should stop the teardown.
q() { aws "$@" 2>/dev/null || true; }

# Run one mutating call. Never aborts the script: a dependency we have not
# reached yet is a normal, retryable failure, and the verify pass at the end
# is what decides whether the region is actually empty.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '   would: %s\n' "$*"
    return 0
  fi
  printf '   %s\n' "$*"
  local out
  if out=$("$@" 2>&1); then
    DELETED=$((DELETED + 1))
  else
    FAILED=$((FAILED + 1))
    warn "failed: $(printf '%s\n' "$out" | tail -n 1)"
  fi
}

wait_for() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  note "waiting: $*"
  aws "$@" >/dev/null 2>&1 || warn "waiter gave up: $*"
}

keep_bucket() {
  if [ "$INCLUDE_SST" -eq 1 ]; then return 1; fi
  case "$1" in sst-state-*|sst-asset-*) return 0 ;; esac
  return 1
}

keep_parameter() {
  if [ "$INCLUDE_SST" -eq 1 ]; then return 1; fi
  case "$1" in /sst/*) return 0 ;; esac
  return 1
}

# /sst/bootstrap records the asset repository by URL, so deleting it while
# the parameter stays breaks the next container deploy.
keep_repository() {
  if [ "$INCLUDE_SST" -eq 1 ]; then return 1; fi
  case "$1" in sst-asset) return 0 ;; esac
  return 1
}

# Buckets are global names with a home region; only touch the ones that live
# in the target region.
buckets_in_region() {
  local b loc
  for b in $(q s3api list-buckets --query 'Buckets[].Name' --output text); do
    loc=$(q s3api get-bucket-location --bucket "$b" --query 'LocationConstraint' --output text)
    # us-east-1 reports a null constraint.
    if [ "$loc" = "None" ] || [ "$loc" = "null" ] || [ -z "$loc" ]; then loc="us-east-1"; fi
    if [ "$loc" != "$REGION" ]; then continue; fi
    if keep_bucket "$b"; then continue; fi
    printf '%s\n' "$b"
  done
}

empty_bucket() {
  local bucket="$1"
  [ "$DRY_RUN" -eq 1 ] && { printf '   would: empty s3://%s\n' "$bucket"; return 0; }
  # Bulk pass for current objects, then versions and delete markers one at a
  # time — no jq dependency, and these buckets are small.
  aws s3 rm "s3://$bucket" --recursive --only-show-errors 2>/dev/null || true
  local key version
  q s3api list-object-versions --bucket "$bucket" \
    --query 'Versions[].[Key,VersionId]' --output text |
    while IFS=$'\t' read -r key version; do
      [ -n "${key:-}" ] || continue
      aws s3api delete-object --bucket "$bucket" --key "$key" --version-id "$version" >/dev/null 2>&1 || true
    done
  q s3api list-object-versions --bucket "$bucket" \
    --query 'DeleteMarkers[].[Key,VersionId]' --output text |
    while IFS=$'\t' read -r key version; do
      [ -n "${key:-}" ] || continue
      aws s3api delete-object --bucket "$bucket" --key "$key" --version-id "$version" >/dev/null 2>&1 || true
    done
}

# ---------------------------------------------------------------- inventory

IDENTITY=$(q sts get-caller-identity --query 'Account' --output text)
[ -n "$IDENTITY" ] || { echo "cannot reach AWS — check credentials" >&2; exit 1; }

count() { set -- $(q "$@"); echo $#; }

section "Inventory of $REGION (account $IDENTITY)"
printf '   %-22s %s\n' \
  "ec2 instances"      "$(count ec2 describe-instances --query 'Reservations[].Instances[?State.Name!=`terminated`].InstanceId' --output text)" \
  "load balancers"     "$(count elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerArn' --output text)" \
  "rds instances"      "$(count rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier' --output text)" \
  "lambda functions"   "$(count lambda list-functions --query 'Functions[].FunctionName' --output text)" \
  "vpcs"               "$(count ec2 describe-vpcs --query 'Vpcs[?!IsDefault].VpcId' --output text)" \
  "elastic ips"        "$(count ec2 describe-addresses --query 'Addresses[].AllocationId' --output text)" \
  "ebs volumes"        "$(count ec2 describe-volumes --query 'Volumes[].VolumeId' --output text)" \
  "s3 buckets"         "$(buckets_in_region | grep -c . || true)" \
  "ssm parameters"     "$(count ssm describe-parameters --query 'Parameters[].Name' --output text)" \
  "log groups"         "$(count logs describe-log-groups --query 'logGroups[].logGroupName' --output text)"

if [ "$DRY_RUN" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
  printf '\n%sThis permanently deletes the resources above. No snapshots are taken.%s\n' "$RED" "$OFF"
  printf 'Type the region name to confirm: '
  if [ -r /dev/tty ]; then read -r reply < /dev/tty; else read -r reply; fi
  [ "$reply" = "$REGION" ] || { echo "aborted"; exit 1; }
fi

# ------------------------------------------------------------------ compute

section "Auto Scaling groups"
for g in $(q autoscaling describe-auto-scaling-groups --query 'AutoScalingGroups[].AutoScalingGroupName' --output text); do
  run aws autoscaling delete-auto-scaling-group --auto-scaling-group-name "$g" --force-delete
done

section "ECS"
for c in $(q ecs list-clusters --query 'clusterArns[]' --output text); do
  for s in $(q ecs list-services --cluster "$c" --query 'serviceArns[]' --output text); do
    run aws ecs delete-service --cluster "$c" --service "$s" --force
  done
  run aws ecs delete-cluster --cluster "$c"
done

section "Lambda"
for f in $(q lambda list-functions --query 'Functions[].FunctionName' --output text); do
  run aws lambda delete-function --function-name "$f"
done

# Load balancers hold ENIs in the subnets, so they go before anything in the
# VPC and we wait for them to actually disappear.
section "Load balancers"
LB_ARNS=$(q elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerArn' --output text)
for lb in $LB_ARNS; do
  run aws elbv2 delete-load-balancer --load-balancer-arn "$lb"
done
for lb in $LB_ARNS; do
  wait_for elbv2 wait load-balancers-deleted --load-balancer-arns "$lb"
done
for tg in $(q elbv2 describe-target-groups --query 'TargetGroups[].TargetGroupArn' --output text); do
  run aws elbv2 delete-target-group --target-group-arn "$tg"
done

section "RDS"
DB_IDS=$(q rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier' --output text)
for db in $DB_IDS; do
  # Deletion protection is on by design in this app's config; clear it first.
  run aws rds modify-db-instance --db-instance-identifier "$db" \
    --no-deletion-protection --apply-immediately
  run aws rds delete-db-instance --db-instance-identifier "$db" \
    --skip-final-snapshot --delete-automated-backups
done
for db in $DB_IDS; do
  wait_for rds wait db-instance-deleted --db-instance-identifier "$db"
done
for c in $(q rds describe-db-clusters --query 'DBClusters[].DBClusterIdentifier' --output text); do
  run aws rds delete-db-cluster --db-cluster-identifier "$c" --skip-final-snapshot
done
for s in $(q rds describe-db-snapshots --snapshot-type manual --query 'DBSnapshots[].DBSnapshotIdentifier' --output text); do
  run aws rds delete-db-snapshot --db-snapshot-identifier "$s"
done
# These accumulate one per build and block nothing, so they are easy to miss.
for g in $(q rds describe-db-subnet-groups --query 'DBSubnetGroups[].DBSubnetGroupName' --output text); do
  [ "$g" = "default" ] && continue
  run aws rds delete-db-subnet-group --db-subnet-group-name "$g"
done
for g in $(q rds describe-db-parameter-groups --query 'DBParameterGroups[?!starts_with(DBParameterGroupName,`default.`)].DBParameterGroupName' --output text); do
  run aws rds delete-db-parameter-group --db-parameter-group-name "$g"
done

section "EC2 instances"
INSTANCE_IDS=$(q ec2 describe-instances --query 'Reservations[].Instances[?State.Name!=`terminated`].InstanceId' --output text)
if [ -n "$INSTANCE_IDS" ]; then
  for i in $INSTANCE_IDS; do
    # Set by the console's "termination protection"; sst never sets it.
    run aws ec2 modify-instance-attribute --instance-id "$i" --no-disable-api-termination
    run aws ec2 terminate-instances --instance-ids "$i"
  done
  wait_for ec2 wait instance-terminated --instance-ids $INSTANCE_IDS
fi

# ------------------------------------------------------------- vpc contents

section "NAT gateways"
NAT_IDS=$(q ec2 describe-nat-gateways --query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text)
for n in $NAT_IDS; do
  run aws ec2 delete-nat-gateway --nat-gateway-id "$n"
done
for n in $NAT_IDS; do
  wait_for ec2 wait nat-gateway-deleted --nat-gateway-ids "$n"
done

section "VPC endpoints"
for e in $(q ec2 describe-vpc-endpoints --query 'VpcEndpoints[].VpcEndpointId' --output text); do
  run aws ec2 delete-vpc-endpoints --vpc-endpoint-ids "$e"
done

section "Elastic IPs"
# An ALB's addresses report ServiceManaged and refuse release-address; they
# go with the load balancer. Skip them rather than log a false failure.
for a in $(q ec2 describe-addresses --query 'Addresses[].[AllocationId,ServiceManaged]' --output text | awk '$2=="None"{print $1}'); do
  run aws ec2 release-address --allocation-id "$a"
done

section "EBS volumes, snapshots and AMIs"
for v in $(q ec2 describe-volumes --query 'Volumes[?State==`available`].VolumeId' --output text); do
  run aws ec2 delete-volume --volume-id "$v"
done
if [ "$KEEP_IMAGES" -eq 1 ]; then
  note "keeping AMIs and snapshots"
else
  for a in $(q ec2 describe-images --owners self --query 'Images[].ImageId' --output text); do
    run aws ec2 deregister-image --image-id "$a"
  done
  for s in $(q ec2 describe-snapshots --owner-ids self --query 'Snapshots[].SnapshotId' --output text); do
    run aws ec2 delete-snapshot --snapshot-id "$s"
  done
fi

section "Launch templates and key pairs"
for t in $(q ec2 describe-launch-templates --query 'LaunchTemplates[].LaunchTemplateId' --output text); do
  run aws ec2 delete-launch-template --launch-template-id "$t"
done
if [ "$KEEP_IMAGES" -eq 1 ]; then
  note "keeping key pairs"
else
  for k in $(q ec2 describe-key-pairs --query 'KeyPairs[].KeyName' --output text); do
    run aws ec2 delete-key-pair --key-name "$k"
  done
fi

section "Network interfaces"
for e in $(q ec2 describe-network-interfaces --query 'NetworkInterfaces[?Status==`available`].NetworkInterfaceId' --output text); do
  run aws ec2 delete-network-interface --network-interface-id "$e"
done

# Groups reference each other, so strip every rule before deleting any group.
section "Security groups"
SG_IDS=$(q ec2 describe-security-groups --query 'SecurityGroups[?GroupName!=`default`].GroupId' --output text)
for g in $SG_IDS; do
  perms=$(q ec2 describe-security-groups --group-ids "$g" --query 'SecurityGroups[0].IpPermissions' --output json)
  [ -n "$perms" ] && [ "$perms" != "[]" ] &&
    run aws ec2 revoke-security-group-ingress --group-id "$g" --ip-permissions "$perms"
  perms=$(q ec2 describe-security-groups --group-ids "$g" --query 'SecurityGroups[0].IpPermissionsEgress' --output json)
  [ -n "$perms" ] && [ "$perms" != "[]" ] &&
    run aws ec2 revoke-security-group-egress --group-id "$g" --ip-permissions "$perms"
done
for g in $SG_IDS; do
  run aws ec2 delete-security-group --group-id "$g"
done

section "Subnets, route tables and gateways"
if [ "$INCLUDE_DEFAULT_VPC" -eq 1 ]; then
  VPC_IDS=$(q ec2 describe-vpcs --query 'Vpcs[].VpcId' --output text)
else
  VPC_IDS=$(q ec2 describe-vpcs --query 'Vpcs[?!IsDefault].VpcId' --output text)
fi
for v in $VPC_IDS; do
  for s in $(q ec2 describe-subnets --filters "Name=vpc-id,Values=$v" --query 'Subnets[].SubnetId' --output text); do
    run aws ec2 delete-subnet --subnet-id "$s"
  done
  # The main route table has no explicit association and goes with the VPC.
  for rt in $(q ec2 describe-route-tables --filters "Name=vpc-id,Values=$v" \
      --query 'RouteTables[?!(Associations[?Main])].RouteTableId' --output text); do
    for assoc in $(q ec2 describe-route-tables --route-table-ids "$rt" \
        --query 'RouteTables[0].Associations[].RouteTableAssociationId' --output text); do
      run aws ec2 disassociate-route-table --association-id "$assoc"
    done
    run aws ec2 delete-route-table --route-table-id "$rt"
  done
  for igw in $(q ec2 describe-internet-gateways --filters "Name=attachment.vpc-id,Values=$v" \
      --query 'InternetGateways[].InternetGatewayId' --output text); do
    run aws ec2 detach-internet-gateway --internet-gateway-id "$igw" --vpc-id "$v"
    run aws ec2 delete-internet-gateway --internet-gateway-id "$igw"
  done
done

section "VPCs"
for v in $VPC_IDS; do
  run aws ec2 delete-vpc --vpc-id "$v"
done

# ------------------------------------------------------------------- others

section "Cloud Map namespaces"
# sst's Vpc creates one of these; it surfaces as a private Route 53 zone.
for n in $(q servicediscovery list-namespaces --query 'Namespaces[].Id' --output text); do
  run aws servicediscovery delete-namespace --id "$n"
done

section "S3 buckets"
for b in $(buckets_in_region); do
  empty_bucket "$b"
  run aws s3api delete-bucket --bucket "$b"
done

section "CloudWatch log groups"
for l in $(q logs describe-log-groups --query 'logGroups[].logGroupName' --output text); do
  run aws logs delete-log-group --log-group-name "$l"
done

section "SSM parameters"
for p in $(q ssm describe-parameters --query 'Parameters[].Name' --output text); do
  if keep_parameter "$p"; then note "keeping $p"; continue; fi
  run aws ssm delete-parameter --name "$p"
done

section "Secrets Manager"
for s in $(q secretsmanager list-secrets --query 'SecretList[].ARN' --output text); do
  run aws secretsmanager delete-secret --secret-id "$s" --force-delete-without-recovery
done

section "ECR repositories"
for r in $(q ecr describe-repositories --query 'repositories[].repositoryName' --output text); do
  if keep_repository "$r"; then note "keeping $r"; continue; fi
  run aws ecr delete-repository --repository-name "$r" --force
done

section "ACM certificates"
for c in $(q acm list-certificates --query 'CertificateSummaryList[].CertificateArn' --output text); do
  run aws acm delete-certificate --certificate-arn "$c"
done

# --------------------------------------------------------------- verify

section "Verifying $REGION"
LEFT=0
check() {
  local label="$1"; shift
  local found
  found=$(q "$@")
  if [ -n "$found" ]; then
    LEFT=$((LEFT + 1))
    warn "$label still present: $(printf '%s' "$found" | tr '\n' ' ')"
  else
    printf '   %-22s clear\n' "$label"
  fi
}
# The default VPC is left alone unless asked for, so its subnets are not a
# leftover — scope the check the same way the deletion was scoped.
DEFAULT_VPC=$(q ec2 describe-vpcs --query 'Vpcs[?IsDefault].VpcId' --output text | awk 'NR==1{print $1}')
if [ "$INCLUDE_DEFAULT_VPC" -eq 1 ] || [ -z "$DEFAULT_VPC" ]; then
  SUBNET_QUERY='Subnets[].SubnetId'
else
  SUBNET_QUERY="Subnets[?VpcId!=\`$DEFAULT_VPC\`].SubnetId"
fi

check "ec2 instances"  ec2 describe-instances --query 'Reservations[].Instances[?State.Name!=`terminated`].InstanceId' --output text
check "vpcs"           ec2 describe-vpcs --query 'Vpcs[?!IsDefault].VpcId' --output text
check "subnets"        ec2 describe-subnets --query "$SUBNET_QUERY" --output text
check "security groups" ec2 describe-security-groups --query 'SecurityGroups[?GroupName!=`default`].GroupId' --output text
check "elastic ips"    ec2 describe-addresses --query 'Addresses[].PublicIp' --output text
check "volumes"        ec2 describe-volumes --query 'Volumes[].VolumeId' --output text
check "rds instances"  rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier' --output text
check "load balancers" elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName' --output text
check "lambda"         lambda list-functions --query 'Functions[].FunctionName' --output text
check "log groups"     logs describe-log-groups --query 'logGroups[].logGroupName' --output text

# Global resources this script deliberately leaves alone. Orphans hide here:
# an IAM user with a live access key outlived its stack in this account once.
section "Not touched (global — review by hand)"
# `--output text` prints "None" for an empty result, which reads like a name.
report() { for x in $2; do if [ "$x" != "None" ]; then note "$1 $x"; fi; done; }
report "iam user"    "$(q iam list-users --query 'Users[].UserName' --output text)"
report "iam role"    "$(q iam list-roles --query 'Roles[?!starts_with(RoleName,`AWSServiceRole`)].RoleName' --output text)"
report "iam policy"  "$(q iam list-policies --scope Local --query 'Policies[].PolicyName' --output text)"
report "hosted zone" "$(q route53 list-hosted-zones --query 'HostedZones[].Name' --output text)"
report "cloudfront"  "$(q cloudfront list-distributions --query 'DistributionList.Items[].Id' --output text)"

section "Done"
if [ "$DRY_RUN" -eq 1 ]; then
  note "dry run — nothing was deleted"
  exit 0
fi
printf '   %s deleted, %s failed, %s resource types still present\n' "$DELETED" "$FAILED" "$LEFT"
[ "$LEFT" -eq 0 ] || { warn "re-run to clear what remains — some deletes only unblock on a second pass"; exit 1; }
