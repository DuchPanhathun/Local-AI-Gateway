#!/usr/bin/env bash
# Points thun-murex.duchpanhathun.com at Vercel with a CNAME in Route53, using
# the AWS profile `personal` (sign in with: aws login --profile personal
# --region us-east-1). Changes only that one record.
set -euo pipefail
export AWS_REGION="${AWS_REGION:-us-east-1}" # Route53 is global, but the CLI still wants a region: its API's
domain="${THUN_MUREX_DOMAIN:-thun-murex.duchpanhathun.com}"
zone_name="${domain#*.}"
target="${VERCEL_CNAME:-cname.vercel-dns.com}"
profile="${AWS_PROFILE_NAME:-personal}"

zone="$(aws route53 list-hosted-zones-by-name --dns-name "$zone_name" --max-items 1 --profile "$profile" --query 'HostedZones[0].Id' --output text)"
found="$(aws route53 get-hosted-zone --id "$zone" --profile "$profile" --query 'HostedZone.Name' --output text)"
[ "$found" = "$zone_name." ] || { echo "The $profile profile's account has no Route53 zone for $zone_name" >&2; exit 1; }

change="$(aws route53 change-resource-record-sets --hosted-zone-id "$zone" --profile "$profile" --query 'ChangeInfo.Id' --output text --change-batch "{
  \"Comment\": \"Thun Murex, on Vercel\",
  \"Changes\": [{\"Action\": \"UPSERT\", \"ResourceRecordSet\": {\"Name\": \"$domain\", \"Type\": \"CNAME\", \"TTL\": 300, \"ResourceRecords\": [{\"Value\": \"$target\"}]}}]
}")"
aws route53 wait resource-record-sets-changed --id "$change" --profile "$profile"
echo "$domain now points at $target. Vercel makes its certificate within a few minutes; then open https://$domain"
