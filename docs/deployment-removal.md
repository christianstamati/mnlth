# What `sst remove` deletes, and what it leaves behind

`sst.config.ts` uses SST's stock removal policy:

```ts
removal: input?.stage === "production" ? "retain" : "remove",
protect: input?.stage === "production",
```

Two different guards. `protect` refuses `sst remove --stage production` before
it touches anything:

```
✕  Cannot remove protected stage. To remove a protected stage edit your
   sst.config.ts and remove the `protect` property.
```

`removal` decides what happens once a removal does run. Neither guard covers
the whole stack, and the gap is worth knowing before you tear anything down.

## Production keeps six things

`retain` is not a blanket. SST applies `retainOnDelete` to a fixed list of
resource types and removes everything else. The list lives in
`.sst/platform/src/auto/run.ts`. Intersected with what this app builds:

| Kept in AWS, dropped from SST state | Type |
| --- | --- |
| `VpcVpc` | `aws:ec2:Vpc` |
| `VpcPublicSubnet1`, `VpcPublicSubnet2`, `VpcPrivateSubnet1`, `VpcPrivateSubnet2` | `aws:ec2:Subnet` |
| `VpcSecurityGroup` | `aws:ec2:DefaultSecurityGroup` |
| `DatabaseInstance` (`mnlth-postgres`) | `aws:rds:Instance` |
| `DatabaseSubnetGroup` | `aws:rds:SubnetGroup` |
| `DatabaseParameterGroup` | `aws:rds:ParameterGroup` |

Everything else goes, including most of the VPC:

| Deleted | Type |
| --- | --- |
| `VpcInternetGateway` | `aws:ec2:InternetGateway` |
| `VpcPublicRouteTable1/2`, `VpcPrivateRouteTable1/2` | `aws:ec2:RouteTable` |
| the four route table associations | `aws:ec2:RouteTableAssociation` |
| `VpcCloudmapNamespace` | `aws:servicediscovery:PrivateDnsNamespace` |
| `ConvexInstance` | `aws:ec2:Instance` |
| `ConvexSecurityGroup` | `aws:ec2:SecurityGroup` |
| `ConvexEip`, `ConvexEipAssociation` | `aws:ec2:Eip`, `aws:ec2:EipAssociation` |
| `ConvexInstanceRole` and its policies and profile | `aws:iam:*` |
| `ConvexPostgresUrl` | `aws:ssm:Parameter` |
| `DatabaseProxySecret` (`mnlth-postgres-password`) and its version | `aws:secretsmanager:Secret` |
| `DatabasePassword` | `random:index:RandomPassword` |
| `ConvexApiRecord`, `ConvexSiteRecord`, `ConvexDashboardRecord` | `aws:route53:Record` |

## The retained set is not a working VPC

Read those two tables together and the result is a carcass. The VPC survives
with its subnets, and its internet gateway and route tables do not. An actual
one from 2026-08-31 held four subnets, the AWS main route table, the default
security group, no internet gateway, and no routing of any kind. Nothing in it
can reach the internet, and nothing new can be attached without rebuilding the
routing by hand.

Two consequences follow.

The database keeps billing. `mnlth-postgres` is a `t4g.micro` with 20 GB of
storage, and a retained instance runs until someone deletes it. VPCs and
subnets are free, so the carcass itself costs nothing.

The carcass keeps the name. Production creates the shared VPC whether or not
one is already there, so the next production deploy builds a second VPC named
`mnlth-vpc` alongside the retained one. Production itself succeeds. Every other
stage then fails on its next deploy, because `sst.aws.Vpc.get` resolves the VPC
by `tag:Name` and `sst.config.ts` treats two matches as an error rather than
picking one. The message names both ids. Recovering means deleting the carcass
and its subnets by hand, along with the retained RDS instance if that stack is
also being rebuilt.

## Other stages remove cleanly

`dev`, `staging` and anything else get `removal: "remove"` and no `protect`.
They also own far less. Both shared resources reach them through
`sst.aws.Vpc.get` and `sst.aws.Postgres.get`, which are references rather than
managed resources, so removing one of these stages cannot touch the shared VPC
or the shared database server no matter what the removal policy says.

What a non-production stage owns is its own EC2 instance, security group,
Elastic IP, instance role, SSM parameter and three Route 53 records. None of
those types appear on SST's retain list, so all of them go.

One thing survives that SST never knew about. `bootstrap.sh` creates a
Postgres database named after the stage inside the shared server, and nothing
in `sst.config.ts` manages it. `sst remove --stage dev` deletes the box and
leaves the `dev` database sitting in `mnlth-postgres` with its data intact.
Drop it yourself if you want the space back.

## SST never creates these, so it never removes them

- The Route 53 hosted zone `fullstackaws.dev`. `sst.config.ts` looks it up with
  `aws.route53.getZoneOutput`.
- The SST state and asset buckets, `sst-state-*` and `sst-asset-*`.
- The `github-actions-sst` IAM role used by CI.
- The AMI and the `ec2-instance-connect` managed prefix list, both lookups.

## Tearing production down for real

There is no environment variable for this. Both guards are code, and one of
them, RDS deletion protection, lives in AWS and can only be changed by a
deploy. The order matters.

1. Edit `sst.config.ts`. Set `removal: "remove"`, drop `protect`, and set
   `deletionProtection: false` in the Postgres `instance` transform.
2. `bun sst deploy --stage production`. This is the step people skip. Pulumi
   reads `retainOnDelete` out of state as the last deploy wrote it, and RDS
   reads `deletionProtection` off the live instance, so nothing you change in
   step 1 has any effect until a deploy carries it.
3. `bun sst remove --stage production`.
4. Check AWS anyway.

Skip step 2 and the removal half succeeds, which is worse than failing. SST
reports `Deleted` for the database, leaves the server running, and then dies
on the subnet group the server still occupies:

```
Error  Database sst:aws:Postgres → DatabaseSubnetGroup aws:rds:SubnetGroup
InvalidDBSubnetGroupStateFault: Cannot delete the subnet group
'mnlth-production-databasesubnetgroup-...' because at least one database
instance: mnlth-postgres is still using it.
```

To recover from that, delete the instance yourself and re-run the removal. It
completes from there.

```bash
aws rds delete-db-instance --db-instance-identifier mnlth-postgres \
  --skip-final-snapshot --delete-automated-backups
aws rds wait db-instance-deleted --db-instance-identifier mnlth-postgres
bun sst remove --stage production
```

## Verifying

SST has reported `Deleted` for subnets and VPCs that were still live, on more
than one teardown. Check the account directly rather than trusting the log:

```bash
aws ec2 describe-vpcs --query 'Vpcs[].VpcId' --output text
aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier' --output text
aws rds describe-db-subnet-groups --query 'DBSubnetGroups[].DBSubnetGroupName' --output text
aws secretsmanager list-secrets --query 'SecretList[].Name' --output text
aws ec2 describe-addresses --query 'Addresses[].PublicIp' --output text
```

Two leftovers are normal and clear themselves. A terminated EC2 instance stays
visible in `describe-instances` for about an hour. An automated RDS snapshot
named `rds:mnlth-postgres-<date>` cannot be deleted by hand at all, and goes
once the instance and its automated backups are gone.
