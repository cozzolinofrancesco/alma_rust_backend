import React, { useEffect } from "react";
import ReactDOM from "react-dom";

interface CollectionPopupProps {
  isOpen: boolean;
  onClose: () => void;
  collection: {
    fileId: string;
    pageNumber: string;
    content: string;
    fileName: string;
    pdfName: string;
  }[];
  collectionIndex: number;
}

const CollectionPopup: React.FC<CollectionPopupProps> = ({
  isOpen,
  onClose,
  collection,
  collectionIndex,
}) => {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const content =
    collection.length > 0 ? (
      collection.map((entry, index) => (
        <div key={index} style={{ marginBottom: "1rem" }}>
          <p>
            <strong>PDF:</strong> {entry.pdfName}, <strong>Page:</strong>{" "}
            {entry.pageNumber}
          </p>
          <pre>{entry.content}</pre>
        </div>
      ))
    ) : (
      <div>This collection is empty.</div>
    );

  return ReactDOM.createPortal(
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        background: "rgba(0,0,0,0.5)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "#fff",
          padding: "1rem",
          borderRadius: "4px",
          maxWidth: "600px",
          width: "90%",
          maxHeight: "80%",
          overflowY: "auto",
        }}
      >
        <h2>Collection {collectionIndex + 1}</h2>
        <button onClick={onClose}>Close</button>
        {content}
      </div>
    </div>,
    document.body
  );
};

export default CollectionPopup;
