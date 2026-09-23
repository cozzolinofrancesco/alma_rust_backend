'use client';

export default function CorpusValidationLayout({
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
