'use client';

export default function AIAgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="ai-agents-scroll-wrapper">
      {children}
    </div>
  );
}
