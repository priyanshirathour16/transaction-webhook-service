import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression test for a mistake that took the live application down: the diagnostic script probed
 * CloudFormation with the REAL stack's name and then deleted that stack. It must only ever create
 * and delete its own "<stack>-probe" stack.
 *
 * The script runs for real against a fake `aws` command that records every call, so nothing leaves
 * the machine. It needs `bash` (always present in CI and on macOS/Linux, and with Git for Windows).
 */
const REAL_STACK = 'transaction-webhook-service';
const hasBash = spawnSync('bash', ['--version']).status === 0;

let workdir;
let callLog;
let run;

function writeShim(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

beforeAll(() => {
  if (!hasBash) return;
  workdir = mkdtempSync(join(tmpdir(), 'diagnose-test-'));
  callLog = join(workdir, 'aws-calls.log');
  writeShim(
    workdir,
    'aws',
    `echo "$*" >> "${callLog.replaceAll('\\', '/')}"
case "$1" in
  sts) if [[ "$*" == *"--query Arn"* ]]; then echo "arn:aws:iam::123456789012:user/x"; else echo "123456789012"; fi ;;
esac
exit 0`,
  );
  writeShim(workdir, 'zip', 'exit 0');
  writeShim(workdir, 'sleep', 'exit 0');

  run = (env = {}) =>
    spawnSync('bash', ['scripts/diagnose-aws-access.sh'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${workdir}${delimiter}${process.env.PATH}`,
        AWS_REGIONS: 'ap-southeast-2',
        STACK_NAME: REAL_STACK,
        ...env,
      },
    });
});

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe.skipIf(!hasBash)('scripts/diagnose-aws-access.sh', () => {
  const calls = () => readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
  const stackCalls = () => calls().filter((line) => line.startsWith('cloudformation '));
  // "--stack-name transaction-webhook-service" followed by a space or the end: the REAL stack,
  // not "transaction-webhook-service-probe".
  const touchesRealStack = (line) => /--stack-name transaction-webhook-service(\s|$)/.test(line);

  it('never creates, changes or deletes the real application stack', () => {
    writeFileSync(callLog, '');
    const result = run();

    expect(result.status).toBe(0);
    const offending = stackCalls().filter(touchesRealStack);
    expect(offending).toEqual([]);
  });

  it('does exercise CloudFormation, using its own probe stack (so the check above is not vacuous)', () => {
    writeFileSync(callLog, '');
    run();

    const probeCalls = stackCalls().filter((line) =>
      line.includes(`--stack-name ${REAL_STACK}-probe`),
    );
    expect(probeCalls.some((line) => line.startsWith('cloudformation create-change-set'))).toBe(
      true,
    );
    expect(probeCalls.some((line) => line.startsWith('cloudformation create-stack'))).toBe(true);
    expect(probeCalls.some((line) => line.startsWith('cloudformation delete-stack'))).toBe(true);
  });

  it('refuses to delete a stack that is not named like a probe, even if configured to', () => {
    writeFileSync(callLog, '');
    // A cooked-up setup where the "probe" name would be the real stack.
    const result = spawnSync(
      'bash',
      [
        '-c',
        `source scripts/diagnose-aws-access.sh
         PROBE="${REAL_STACK}"; STACK="${REAL_STACK}"
         delete_probe_stack ap-southeast-2; echo "exit=$?"`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${workdir}${delimiter}${process.env.PATH}` },
      },
    );

    expect(result.stdout).toContain('exit=1');
    expect(result.stderr).toContain('REFUSING to delete');
    expect(stackCalls().filter((line) => line.startsWith('cloudformation delete-stack'))).toEqual(
      [],
    );
  });
});
