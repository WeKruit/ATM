import { describe, expect, test } from 'bun:test';

import { resolveStackVerifyTargets } from './stack-verify-lib';

describe('stack-verify-lib', () => {
  test('resolves staging CI targets in branch order', () => {
    const targets = resolveStackVerifyTargets('staging', 'ci');
    expect(targets.map((target) => `${target.repo}:${target.workflowFile}:${target.ref}`)).toEqual([
      'WeKruit/ATM:ci-atm.yml:staging',
      'WeKruit/VALET:ci.yml:staging',
      'WeKruit/VALET:ci-integration.yml:staging',
      'WeKruit/GH-Desktop-App:ci.yml:staging',
      'WeKruit/GHOST-HANDS:ci.yml:staging',
    ]);
  });

  test('resolves production deploy targets only for deploy mode', () => {
    const targets = resolveStackVerifyTargets('production', 'deploy');
    expect(targets.map((target) => target.workflowName)).toEqual([
      'CD → ATM API (EC2)',
      'CD → ATM Dashboard (Fly.io)',
      'CD → Production',
    ]);
  });

  test('full mode includes both ci and deploy targets', () => {
    const targets = resolveStackVerifyTargets('production', 'full');
    expect(targets.some((target) => target.category === 'ci')).toBe(true);
    expect(targets.some((target) => target.category === 'deploy')).toBe(true);
  });
});
