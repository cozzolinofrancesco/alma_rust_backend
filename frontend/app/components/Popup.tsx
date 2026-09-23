"use client";

import React, { useState } from 'react';
import '../styles/Popup2.css';

interface PopupProps {
  isOpen: boolean;
  onClose: () => void;
  masterExtract: {
    fileId: string;
    fileName: string;
    PDFName: string;
    pageNumber: string;
    content: string;
  }[];
  onClear: () => void;
  onTogglePage: (
    fileId: string,
    fileName: string,
    pageNumber: string,
    pdfName: string
  ) => void;
}

const Popup: React.FC<PopupProps> = ({
  isOpen,
  onClose,
  masterExtract,
  onClear,
  onTogglePage,
}) => {
  const groupedExtracts = masterExtract.reduce((acc, extract) => {
    const key = extract.PDFName || extract.fileId;
    if (!acc[key]) acc[key] = [];
    acc[key].push(extract);
    return acc;
  }, {} as Record<string, typeof masterExtract>);

  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
    new Set(
      Object.keys(groupedExtracts).length === 1
        ? Object.keys(groupedExtracts)
        : []
    )
  );
  const [visiblePages, setVisiblePages] = useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const toggleFileExpansion = (pdfName: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(pdfName)) {
        next.delete(pdfName);
      } else {
        next.add(pdfName);
      }
      return next;
    });
  };

  const togglePageContent = (pdfName: string, pageNumber: string) => {
    const key = `${pdfName}-${pageNumber}`;
    setVisiblePages(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="popup-header">
          <h3>Master Extract</h3>
          <div className="header-buttons">
            <button className="popup-button clear" onClick={onClear}>
              Clear Context
            </button>
            <button className="popup-button close" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="popup-body">
          {Object.entries(groupedExtracts).length === 0 && (
            <p className="empty-message">
              No extracts to display. Add some pages to the context.
            </p>
          )}

          {Object.entries(groupedExtracts).map(([pdfName, extracts]) => {
            const sorted = extracts
              .slice()
              .sort(
                (a, b) =>
                  parseInt(a.pageNumber, 10) - parseInt(b.pageNumber, 10)
              );
            const isFileExpanded = expandedFiles.has(pdfName);

            return (
              <div key={pdfName} className="file-group">
                <div
                  className="file-title"
                  onClick={() => toggleFileExpansion(pdfName)}
                >
                  <button
                    className="expand-button"
                    aria-label={
                      isFileExpanded ? 'Collapse' : 'Expand'
                    }
                  >
                    {isFileExpanded ? '▼' : '▶'}
                  </button>
                  <strong>{pdfName}</strong>
                  <span className="page-count">
                    ({sorted.length}{' '}
                    {sorted.length === 1 ? 'page' : 'pages'})
                  </span>
                </div>

                {isFileExpanded && (
                  <div className="table-container">
                    <table className="extract-table">
                      <thead>
                        <tr>
                          <th style={{ width: '15%' }}>Page</th>
                          <th style={{ width: '75%' }}>Content</th>
                          <th style={{ width: '10%' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((ext, idx) => {
                          const visKey = `${pdfName}-${ext.pageNumber}`;
                          const isVisible = visiblePages.has(visKey);
                          const rowKey = `${pdfName}-${ext.pageNumber}-${idx}`;

                          return (
                            <tr
                              key={rowKey}
                              className={isVisible ? 'content-visible' : ''}
                            >
                              <td className="page-cell">
                                <button
                                  className="page-toggle-button"
                                  onClick={e => {
                                    e.stopPropagation();
                                    togglePageContent(
                                      pdfName,
                                      ext.pageNumber
                                    );
                                  }}
                                >
                                  {isVisible
                                    ? 'Hide'
                                    : 'Show'}{' '}
                                  Pg. {ext.pageNumber}
                                </button>
                              </td>
                              <td className="content-cell">
                                {isVisible && (
                                  <pre className="content-preview">
                                    {ext.content}
                                  </pre>
                                )}
                              </td>
                              <td className="action-cell">
                                <button
                                  className="page-action-button remove"
                                  onClick={e => {
                                    e.stopPropagation();
                                    onTogglePage(
                                      ext.fileId,
                                      ext.fileName,
                                      ext.pageNumber,
                                      pdfName
                                    );
                                  }}
                                  title={`Remove Page ${
                                    ext.pageNumber
                                  } from context`}
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default Popup;
