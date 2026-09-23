'use client';

export default function ProofValidationFlowLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="proof-validation-scroll-wrapper">
      {children}
    </div>
  );
}
