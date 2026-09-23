'use client';

import ClaimValidationFlow from './ClaimValidationFlow';

// The Claim Validation flow now lives in ClaimValidationFlow so it can be reused
// by the unified Validation page (app/validation). This route keeps the original
// /claim-validation URL working and inherits Theme + IntegrityChain providers
// from layout.tsx.
export default function ClaimValidationPage() {
  return <ClaimValidationFlow />;
}
