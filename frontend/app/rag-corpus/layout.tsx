'use client';

export default function RagCorpusLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="rag-corpus-scroll-wrapper">
      {children}
    </div>
  );
}
