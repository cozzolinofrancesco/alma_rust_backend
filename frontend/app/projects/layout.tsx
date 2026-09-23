'use client';

export default function ProjectsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="projects-scroll-wrapper">
      {children}
    </div>
  );
}
