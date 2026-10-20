#!/usr/bin/env bash
# Probes which AWS actions the deployment identity may perform, in one or more regions, so
# restrictions imposed by an AWS Organization (service control policies) show up in ONE run instead
# of one failed deploy at a time. A common restriction is "regional services are only allowed in
# certain regions", which a single-region probe cannot distinguish from "blocked everywhere".
#
# For each action the deploy needs, it makes a real call against a throwaway resource named
# "<stack>-probe", records the outcome, then deletes what it created. Outcomes:
#   allowed      the call worked
#   BLOCKED      an organization policy denies it: nothing in the account can undo this
#   our IAM      the deploy user's own policy lacks it: fixable in infra/github-deploy-access.yaml
#   authorized   permission was granted; the call failed for an unrelated reason
#
# Environment: AWS_REGIONS (comma-separated, default AWS_REGION or ap-south-1), STACK_NAME.
# Run it from the "Diagnose AWS access" GitHub workflow (credentials come from the environment).

set -uo pipefail

REGIONS="${AWS_REGIONS:-${AWS_REGION:-ap-south-1}}"
STACK="${STACK_NAME:-transaction-webhook-service}"
PROBE="${STACK}-probe"
TEMPLATE='{"Resources":{"Probe":{"Type":"AWS::CloudFormation::WaitConditionHandle"}}}'
LAMBDA_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

declare -A STATUS # "<action>|<region>" -> classification
declare -A SEEN
ACTIONS=()
REGION_LIST=()
ACCOUNT=""
LAST_STATUS=""
LAST_OUTPUT=""

# classify <exit-code> <output>  ->  prints the outcome label
classify() {
  local code="$1" output="$2"
  if [ "$code" -eq 0 ]; then
    echo "allowed"
  elif grep -qi "service control policy" <<<"$output"; then
    echo "BLOCKED"
  elif grep -qiE "no identity-based policy|not authorized to perform|AccessDenied|UnauthorizedOperation" <<<"$output"; then
    echo "our IAM"
  else
    echo "authorized"
  fi
}

# record <region> <label> <exit-code> <output>  ->  classifies, prints and stores one outcome
record() {
  local region="$1" label="$2" code="$3"
  LAST_OUTPUT="$4"
  LAST_STATUS="$(classify "$code" "$LAST_OUTPUT")"
  STATUS["$label|$region"]="$LAST_STATUS"
  if [ -z "${SEEN[$label]:-}" ]; then
    SEEN["$label"]=1
    ACTIONS+=("$label")
  fi
  printf '  [%s] %-50s %s\n' "$region" "$label" "$LAST_STATUS"
  case "$LAST_STATUS" in
    BLOCKED | "our IAM") printf '        -> %s\n' "$(head -c 300 <<<"$LAST_OUTPUT" | tr '\n' ' ')" ;;
  esac
}

# probe <region> <label> <command...>  ->  runs the command once and records the outcome
probe() {
  local region="$1" label="$2" output code
  shift 2
  output="$("$@" 2>&1)"
  code=$?
  record "$region" "$label" "$code" "$output"
}

quiet() { "$@" >/dev/null 2>&1 || true; }

delete_stack() {
  quiet aws cloudformation delete-stack --stack-name "$STACK" --region "$1"
  quiet aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$1"
}

# Probes everything that is regional. Needs the probe role (global) to exist already.
probe_region() {
  local region="$1" bucket="aws-sam-cli-managed-default-probe-${ACCOUNT}-$1"
  echo
  echo "== $region =="

  probe "$region" "cloudformation: CreateChangeSet (sam deploy)" \
    aws cloudformation create-change-set --stack-name "$STACK" --change-set-name probe \
    --change-set-type CREATE --template-body "$TEMPLATE" --region "$region"
  delete_stack "$region"
  probe "$region" "cloudformation: CreateStack" \
    aws cloudformation create-stack --stack-name "$STACK" --template-body "$TEMPLATE" --region "$region"
  delete_stack "$region"

  probe "$region" "s3: CreateBucket" \
    aws s3api create-bucket --bucket "$bucket" --region "$region" \
    --create-bucket-configuration "LocationConstraint=$region"
  quiet aws s3api delete-bucket --bucket "$bucket" --region "$region"

  probe "$region" "sqs: CreateQueue" aws sqs create-queue --queue-name "$PROBE" --region "$region"
  local queue_arn="arn:aws:sqs:${region}:${ACCOUNT}:${PROBE}"
  probe "$region" "sns: CreateTopic" aws sns create-topic --name "$PROBE" --region "$region"
  probe "$region" "events: PutRule (schedule)" \
    aws events put-rule --name "$PROBE" --schedule-expression 'rate(1 day)' --state DISABLED --region "$region"
  probe "$region" "logs: CreateLogGroup" \
    aws logs create-log-group --log-group-name "/aws/lambda/${PROBE}" --region "$region"
  probe "$region" "cloudwatch: PutMetricAlarm" \
    aws cloudwatch put-metric-alarm --alarm-name "$PROBE" --namespace AWS/Lambda --metric-name Errors \
    --statistic Sum --period 300 --evaluation-periods 1 --threshold 1 \
    --comparison-operator GreaterThanThreshold --region "$region"

  # A brand-new role can take a little while before Lambda accepts it: retry that one specific error.
  local create_output create_code
  for _ in 1 2 3 4 5 6; do
    create_output="$(aws lambda create-function --function-name "$PROBE" --runtime nodejs22.x \
      --role "arn:aws:iam::${ACCOUNT}:role/${PROBE}-role" --handler index.handler \
      --zip-file "fileb://${WORKDIR}/probe.zip" --region "$region" 2>&1)"
    create_code=$?
    grep -qi "cannot be assumed" <<<"$create_output" || break
    sleep 10
  done
  record "$region" "lambda: CreateFunction" "$create_code" "$create_output"
  if [ "$LAST_STATUS" = "allowed" ]; then
    probe "$region" "lambda: CreateFunctionUrlConfig (PUBLIC)" \
      aws lambda create-function-url-config --function-name "$PROBE" --auth-type NONE --region "$region"
    probe "$region" "lambda: AddPermission InvokeFunctionUrl" \
      aws lambda add-permission --function-name "$PROBE" --statement-id probe-url \
      --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE --region "$region"
    probe "$region" "lambda: AddPermission InvokeFunction (URL)" \
      aws lambda add-permission --function-name "$PROBE" --statement-id probe-invoke \
      --action lambda:InvokeFunction --principal '*' --invoked-via-function-url --region "$region"
    probe "$region" "lambda: CreateEventSourceMapping (SQS)" \
      aws lambda create-event-source-mapping --function-name "$PROBE" --event-source-arn "$queue_arn" \
      --batch-size 1 --region "$region"
  fi

  # Clean up this region's probe resources.
  local uuid
  for uuid in $(aws lambda list-event-source-mappings --function-name "$PROBE" --region "$region" \
    --query 'EventSourceMappings[].UUID' --output text 2>/dev/null || true); do
    quiet aws lambda delete-event-source-mapping --uuid "$uuid" --region "$region"
  done
  quiet aws lambda delete-function-url-config --function-name "$PROBE" --region "$region"
  quiet aws lambda delete-function --function-name "$PROBE" --region "$region"
  quiet aws cloudwatch delete-alarms --alarm-names "$PROBE" --region "$region"
  quiet aws logs delete-log-group --log-group-name "/aws/lambda/${PROBE}" --region "$region"
  quiet aws events delete-rule --name "$PROBE" --region "$region"
  quiet aws sns delete-topic --topic-arn "arn:aws:sns:${region}:${ACCOUNT}:${PROBE}" --region "$region"
  local queue_url
  queue_url="$(aws sqs get-queue-url --queue-name "$PROBE" --region "$region" --query QueueUrl --output text 2>/dev/null || true)"
  if [ -n "$queue_url" ]; then quiet aws sqs delete-queue --queue-url "$queue_url" --region "$region"; fi
}

# Markdown table: one row per action, one column per region.
render_table() {
  local header="| Action |" divider="|---|" region action row
  for region in "${REGION_LIST[@]}"; do
    header+=" $region |"
    divider+="---|"
  done
  echo "$header"
  echo "$divider"
  for action in "${ACTIONS[@]}"; do
    row="| $action |"
    for region in "${REGION_LIST[@]}"; do
      # Global services (IAM) are probed once and apply to every region.
      local value="${STATUS["$action|$region"]:-${STATUS["$action|global"]:--}}"
      [ "$value" = "BLOCKED" ] && value="**BLOCKED**"
      row+=" $value |"
    done
    echo "$row"
  done
}

# Regions where nothing was blocked and the stack can be created one way or the other.
usable_regions() {
  local region action blocked usable=()
  for region in "${REGION_LIST[@]}"; do
    blocked=0
    for action in "${ACTIONS[@]}"; do
      [ "${STATUS["$action|$region"]:-}" = "BLOCKED" ] && blocked=1
    done
    if [ "$blocked" -eq 0 ] && [ -n "${STATUS["lambda: CreateFunction|$region"]:-}" ]; then
      usable+=("$region")
    fi
  done
  echo "${usable[*]:-}"
}

main() {
  IFS=',' read -r -a REGION_LIST <<<"$REGIONS"
  ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
  echo "Identity: $(aws sts get-caller-identity --query Arn --output text)"
  echo "Regions:  ${REGION_LIST[*]}"
  echo "Probe:    $PROBE"

  WORKDIR="$(mktemp -d)"
  echo 'exports.handler = async () => ({ statusCode: 200 });' >"$WORKDIR/index.js"
  (cd "$WORKDIR" && zip -q probe.zip index.js)

  echo
  echo "== global (IAM) =="
  probe "global" "iam: CreateRole (Lambda execution role)" \
    aws iam create-role --role-name "${PROBE}-role" --assume-role-policy-document "$LAMBDA_TRUST"
  sleep 10 # let the new role propagate before Lambda is asked to use it

  local region
  for region in "${REGION_LIST[@]}"; do
    probe_region "$region"
  done

  quiet aws iam delete-role --role-name "${PROBE}-role"
  rm -rf "$WORKDIR"

  echo
  echo "== Summary =="
  local table usable
  table="$(render_table)"
  echo "$table"
  usable="$(usable_regions)"
  echo
  if [ -n "$usable" ]; then
    echo "Regions where NOTHING is blocked: $usable"
  else
    echo "No probed region is fully usable."
  fi

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### AWS access diagnostics"
      echo "Probe name \`$PROBE\`. **allowed** = works, **BLOCKED** = forbidden by the AWS Organization,"
      echo "**our IAM** = missing from our own policy (fixable), **authorized** = permitted but failed for another reason."
      echo
      echo "$table"
      echo
      if [ -n "$usable" ]; then
        echo "**Regions where nothing is blocked:** $usable"
      else
        echo "**No probed region is fully usable.**"
      fi
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

# Run only when executed directly, so the functions above can be sourced and tested.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
