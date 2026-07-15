import { OlcliError } from './errors/olcli-error.js';

export function isExperimentalReviewEnabled(value = process.env.OLCLI_EXPERIMENTAL_REVIEW): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function requireExperimentalReview(enabled: boolean, action: string): void {
  if (enabled) return;
  throw new OlcliError(
    'EXPERIMENTAL_FEATURE_DISABLED',
    `Experimental review mutation is disabled for ${action}.`,
    {
      details: {
        action,
        enableWith: 'OLCLI_EXPERIMENTAL_REVIEW=1',
      },
    }
  );
}
