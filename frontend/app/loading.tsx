export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: 'var(--app-height)',
        backgroundColor: '#f5f5f5',
      }}
    >
      <div
        style={{
          width: '40px',
          height: '40px',
          border: '4px solid #e5e7eb',
          borderTopColor: '#11074A',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
        }}
      />
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
