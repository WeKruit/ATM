export type StackVerifyEnvironment = 'staging' | 'production' | 'all';
export type StackVerifyMode = 'ci' | 'deploy' | 'full';

export interface StackVerifyTarget {
  environment: 'staging' | 'production';
  category: 'ci' | 'deploy';
  repo: string;
  workflowFile: string;
  workflowName: string;
  ref: string;
  inputs?: Record<string, string>;
}

function target(
  environment: 'staging' | 'production',
  category: 'ci' | 'deploy',
  repo: string,
  workflowFile: string,
  workflowName: string,
  ref: string,
  inputs?: Record<string, string>,
): StackVerifyTarget {
  return { environment, category, repo, workflowFile, workflowName, ref, inputs };
}

export function resolveStackVerifyTargets(
  environment: StackVerifyEnvironment,
  mode: StackVerifyMode,
): StackVerifyTarget[] {
  const stagingCi: StackVerifyTarget[] = [
    target('staging', 'ci', 'WeKruit/ATM', 'ci-atm.yml', 'CI — ATM', 'staging'),
    target('staging', 'ci', 'WeKruit/VALET', 'ci.yml', 'CI', 'staging'),
    target('staging', 'ci', 'WeKruit/VALET', 'ci-integration.yml', 'Integration Tests', 'staging'),
    target('staging', 'ci', 'WeKruit/GH-Desktop-App', 'ci.yml', 'CI/CD', 'staging'),
    target('staging', 'ci', 'WeKruit/GHOST-HANDS', 'ci.yml', 'CI/CD', 'staging'),
  ];

  const stagingDeploy: StackVerifyTarget[] = [
    target('staging', 'deploy', 'WeKruit/VALET', 'cd-staging.yml', 'CD → Staging', 'staging'),
  ];

  const productionCi: StackVerifyTarget[] = [
    target('production', 'ci', 'WeKruit/ATM', 'ci-atm.yml', 'CI — ATM', 'main'),
    target('production', 'ci', 'WeKruit/VALET', 'ci.yml', 'CI', 'main'),
    target('production', 'ci', 'WeKruit/GH-Desktop-App', 'ci.yml', 'CI/CD', 'main'),
    target('production', 'ci', 'WeKruit/GHOST-HANDS', 'ci.yml', 'CI/CD', 'main'),
  ];

  const productionDeploy: StackVerifyTarget[] = [
    target('production', 'deploy', 'WeKruit/ATM', 'cd-atm-api.yml', 'CD → ATM API (EC2)', 'main'),
    target('production', 'deploy', 'WeKruit/ATM', 'cd-atm-dashboard.yml', 'CD → ATM Dashboard (Fly.io)', 'main'),
    target('production', 'deploy', 'WeKruit/VALET', 'cd-prod.yml', 'CD → Production', 'main'),
  ];

  const stagingTargets =
    mode === 'ci' ? stagingCi : mode === 'deploy' ? stagingDeploy : [...stagingCi, ...stagingDeploy];
  const productionTargets =
    mode === 'ci'
      ? productionCi
      : mode === 'deploy'
        ? productionDeploy
        : [...productionCi, ...productionDeploy];

  if (environment === 'staging') return stagingTargets;
  if (environment === 'production') return productionTargets;
  return [...stagingTargets, ...productionTargets];
}
