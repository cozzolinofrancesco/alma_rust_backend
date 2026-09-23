'use client';

export default function UploadLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="upload-scroll-wrapper">
      {children}
    </div>
  );
}
