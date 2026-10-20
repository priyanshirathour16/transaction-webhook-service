import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards against a deployment failure we hit for real: CloudFormation SHORTENS an auto-generated
 * resource name that exceeds the service's limit (EventBridge rules: 64 characters), and the deploy
 * user's "<stack>-*" permission then no longer matches, so the stack failed and rolled back.
 * Schedules therefore need explicit names.
 */
const template = readFileSync('template.yaml', 'utf8').split(/\r?\n/);

/** The lines belonging to each `Type: Schedule` event: everything indented deeper than that line. */
function scheduleBlocks() {
  const blocks = [];
  template.forEach((line, index) => {
    if (line.trim() !== 'Type: Schedule') return;
    const indent = line.length - line.trimStart().length;
    const block = [];
    for (let next = index + 1; next < template.length; next += 1) {
      const candidate = template[next];
      const candidateIndent = candidate.length - candidate.trimStart().length;
      if (candidate.trim() !== '' && candidateIndent < indent) break;
      block.push(candidate.trim());
    }
    blocks.push(block);
  });
  return blocks;
}

describe('template.yaml', () => {
  it('has the two schedules this guard is about (so the check below is not vacuous)', () => {
    expect(scheduleBlocks()).toHaveLength(2);
  });

  it('gives every schedule an explicit name derived from the stack name', () => {
    for (const block of scheduleBlocks()) {
      const name = block.find((line) => line.startsWith('Name:'));
      expect(name, `schedule without an explicit Name: ${block.join(' | ')}`).toBeDefined();
      expect(name).toContain('${AWS::StackName}-');
    }
  });

  it('keeps those names within the 64-character EventBridge limit for the real stack name', () => {
    const stackName = 'transaction-webhook-service';
    for (const block of scheduleBlocks()) {
      const name = block
        .find((line) => line.startsWith('Name:'))
        .replace(/^Name:\s*!Sub\s*/, '')
        .replace(/\s*#.*$/, '')
        .replaceAll("'", '')
        .replace('${AWS::StackName}', stackName);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name.startsWith(`${stackName}-`)).toBe(true);
    }
  });
});
