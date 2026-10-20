#!/usr/bin/env bash
# Probes which AWS actions the deployment identity may perform, so restrictions imposed by an AWS
# Organization (service control policies) show up in ONE run instead of one failed deploy at a time.
#
# For each action the deploy needs, it makes a real call against a throwaway resource named
# "<stack>-probe", reports the outcome, then deletes what it created. Outcomes:
#   ALLOWED                         the call worked
#   BLOCKED BY ORGANIZATION (SCP)   an organization policy denies it: nothing in the account can undo this
#   DENIED BY OUR IAM POLICY        the deploy user's own policy lacks it: fixable in infra/github-deploy-access.yaml
#   AUTHORIZED (other failure)      permission was granted; the call failed for an unrelated reason
#
# Run it from the "Diagnose AWS access" GitHub workflow (credentials come from the environment).

set -uo pipefail

REGION="${AWS_REGION:-ap-south-1}"
STACK="${STACK_NAME:-transaction-webhook-service}"
PROBE="${STACK}-probe"
TEMPLATE='{"Resources":{"Probe":{"Type":"AWS::CloudFormation::WaitConditionHandle"}}}'
LAMBDA_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

RESULTS=()
ACCOUNT=""

# classify <exit-code> <output>  ->  prints the outcome label
classify() {
  local code="$1" output="$2"
  if [ "$code" -eq 0 ]; then
    echo "ALLOWED"
  elif grep -qi "service control policy" <<<"$output"; then
    echo "BLOCKED BY ORGANIZATION (SCP)"
  elif grep -qiE "no identity-based policy|not authorized to perform|AccessDenied|UnauthorizedOperation" <<<"$output"; then
    echo "DENIED BY OUR IAM POLICY"
  else
    echo "AUTHORIZED (other failure)"
  fi
}

# record <label> <exit-code> <output>  ->  classifies, prints and stores one outcome
# (sets LAST_STATUS / LAST_OUTPUT for the caller)
record() {
  local label="$1" code="$2"
  LAST_OUTPUT="$3"
  LAST_STATUS="$(classify "$code" "$LAST_OUTPUT")"
  printf '%-58s %s\n' "$label" "$LAST_STATUS"
  RESULTS+=("| $label | $LAST_STATUS |")
  case "$LAST_STATUS" in
    BLOCKED* | DENIED*) printf '      -> %s\n' "$(head -c 400 <<<"$LAST_OUTPUT" | tr '\n' ' ')" ;;
  esac
}

# probe <label> <command...>  ->  runs the command once and records the outcome
probe() {
  local label="$1" output code
  shift
  output="$("$@" 2>&1)"
  code=$?
  record "$label" "$code" "$output"
}

quiet() { "$@" >/dev/null 2>&1 || true; }

delete_stack() {
  quiet aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION"
  quiet aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION"
}

main() {
  ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
  echo "Identity: $(aws sts get-caller-identity --query Arn --output text)"
  echo "Region:   $REGION    Probe name: $PROBE"
  echo

  echo "== CloudFormation (how the stack is created) =="
  probe "cloudformation: CreateChangeSet   (sam deploy uses this)" \
    aws cloudformation create-change-set --stack-name "$STACK" --change-set-name probe \
    --change-set-type CREATE --template-body "$TEMPLATE" --region "$REGION"
  delete_stack
  probe "cloudformation: CreateStack       (no change set)" \
    aws cloudformation create-stack --stack-name "$STACK" --template-body "$TEMPLATE" --region "$REGION"
  delete_stack

  echo
  echo "== Artifact bucket =="
  local bucket="aws-sam-cli-managed-default-probe-${ACCOUNT}"
  probe "s3: CreateBucket" \
    aws s3api create-bucket --bucket "$bucket" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION"
  quiet aws s3api delete-bucket --bucket "$bucket" --region "$REGION"

  echo
  echo "== Application resources =="
  probe "sqs: CreateQueue" aws sqs create-queue --queue-name "$PROBE" --region "$REGION"
  local queue_arn="arn:aws:sqs:${REGION}:${ACCOUNT}:${PROBE}"
  probe "sns: CreateTopic" aws sns create-topic --name "$PROBE" --region "$REGION"
  probe "events: PutRule (schedule)" \
    aws events put-rule --name "$PROBE" --schedule-expression 'rate(1 day)' --state DISABLED --region "$REGION"
  probe "logs: CreateLogGroup" \
    aws logs create-log-group --log-group-name "/aws/lambda/${PROBE}" --region "$REGION"
  probe "cloudwatch: PutMetricAlarm" \
    aws cloudwatch put-metric-alarm --alarm-name "$PROBE" --namespace AWS/Lambda --metric-name Errors \
    --statistic Sum --period 300 --evaluation-periods 1 --threshold 1 \
    --comparison-operator GreaterThanThreshold --region "$REGION"
  probe "iam: CreateRole (Lambda execution role)" \
    aws iam create-role --role-name "${PROBE}-role" --assume-role-policy-document "$LAMBDA_TRUST"

  echo
  echo "== Lambda =="
  local workdir
  workdir="$(mktemp -d)"
  echo 'exports.handler = async () => ({ statusCode: 200 });' >"$workdir/index.js"
  (cd "$workdir" && zip -q probe.zip index.js)
  # A brand-new role can take a little while before Lambda accepts it: retry that one specific error.
  local create_output create_code
  for _ in 1 2 3 4 5 6; do
    sleep 10
    create_output="$(aws lambda create-function --function-name "$PROBE" --runtime nodejs22.x \
      --role "arn:aws:iam::${ACCOUNT}:role/${PROBE}-role" --handler index.handler \
      --zip-file "fileb://${workdir}/probe.zip" --region "$REGION" 2>&1)"
    create_code=$?
    grep -qi "cannot be assumed" <<<"$create_output" || break
  done
  record "lambda: CreateFunction" "$create_code" "$create_output"
  if [ "$LAST_STATUS" = "ALLOWED" ]; then
    probe "lambda: CreateFunctionUrlConfig (PUBLIC, AuthType NONE)" \
      aws lambda create-function-url-config --function-name "$PROBE" --auth-type NONE --region "$REGION"
    probe "lambda: AddPermission InvokeFunctionUrl (public)" \
      aws lambda add-permission --function-name "$PROBE" --statement-id probe-url \
      --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE --region "$REGION"
    probe "lambda: AddPermission InvokeFunction (via function URL)" \
      aws lambda add-permission --function-name "$PROBE" --statement-id probe-invoke \
      --action lambda:InvokeFunction --principal '*' --invoked-via-function-url --region "$REGION"
    probe "lambda: CreateEventSourceMapping (SQS trigger)" \
      aws lambda create-event-source-mapping --function-name "$PROBE" --event-source-arn "$queue_arn" \
      --batch-size 1 --region "$REGION"
  else
    echo "(function was not created, so the function URL and trigger probes are skipped)"
    RESULTS+=("| lambda: function URL / trigger probes | skipped: function not created |")
  fi

  echo
  echo "== Cleaning up the probe resources =="
  local mapping
  mapping="$(aws lambda list-event-source-mappings --function-name "$PROBE" --region "$REGION" \
    --query 'EventSourceMappings[].UUID' --output text 2>/dev/null || true)"
  for uuid in $mapping; do quiet aws lambda delete-event-source-mapping --uuid "$uuid" --region "$REGION"; done
  quiet aws lambda delete-function-url-config --function-name "$PROBE" --region "$REGION"
  quiet aws lambda delete-function --function-name "$PROBE" --region "$REGION"
  quiet aws iam delete-role --role-name "${PROBE}-role"
  quiet aws cloudwatch delete-alarms --alarm-names "$PROBE" --region "$REGION"
  quiet aws logs delete-log-group --log-group-name "/aws/lambda/${PROBE}" --region "$REGION"
  quiet aws events delete-rule --name "$PROBE" --region "$REGION"
  quiet aws sns delete-topic --topic-arn "arn:aws:sns:${REGION}:${ACCOUNT}:${PROBE}" --region "$REGION"
  local queue_url
  queue_url="$(aws sqs get-queue-url --queue-name "$PROBE" --region "$REGION" --query QueueUrl --output text 2>/dev/null || true)"
  [ -n "$queue_url" ] && quiet aws sqs delete-queue --queue-url "$queue_url" --region "$REGION"
  rm -rf "$workdir"
  echo "done"

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### AWS access diagnostics"
      echo "Region \`$REGION\`, probe name \`$PROBE\`"
      echo
      echo "| Action | Outcome |"
      echo "|---|---|"
      printf '%s\n' "${RESULTS[@]}"
    } >>"$GITHUB_STEP_SUMMARY"
  fi

  echo
  if printf '%s\n' "${RESULTS[@]}" | grep -q "BLOCKED BY ORGANIZATION"; then
    echo "Some actions are blocked by the organization. See the lines marked BLOCKED above."
  elif printf '%s\n' "${RESULTS[@]}" | grep -q "DENIED BY OUR IAM POLICY"; then
    echo "Some actions are missing from our own IAM policy (fixable). See the lines marked DENIED above."
  else
    echo "No blocked or denied actions found."
  fi
}

# Run only when executed directly, so the functions above can be sourced and tested.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
