'use client';

import { useState } from 'react';
import { FaSync, FaTrash, FaSpinner } from 'react-icons/fa';
import { useCollectionContext } from './CollectionContext';
import { UniquePageId } from "./ListExtracts";
import "../styles/collections.css";

interface Extract {
  fileId: string;
  pageNumber: string;
  content: string;
  fileName: string;
  PDFName: string;
  collection?: number;
}

interface CollectionManagerProps {
  masterExtract: Extract[];
  setMasterExtract: React.Dispatch<React.SetStateAction<Extract[]>>;
  setSelectedPages: React.Dispatch<React.SetStateAction<Set<UniquePageId>>>;
  setContext: React.Dispatch<React.SetStateAction<string>>;
  onContextUpdate: (context: string) => void;
  setSelectedCollectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
  isDownloading?: boolean;
  onRefreshData?: () => Promise<void>;
}

export default function CollectionManager({
  masterExtract,
  setMasterExtract,
  setSelectedPages,
  setContext,
  onContextUpdate,
  setSelectedCollectionIndex,
  isDownloading = false,
  onRefreshData,
}: CollectionManagerProps) {
  const { collections, setCollections } = useCollectionContext();
  const [isAssigning, setIsAssigning] = useState(false);
  const [assigningToCollection, setAssigningToCollection] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const assignMasterExtractToCollection = async (collectionIndex: number) => {
    if (isAssigning || isDownloading || masterExtract.length === 0) return;
    
    setIsAssigning(true);
    setAssigningToCollection(collectionIndex);

    try {
      await new Promise(resolve => setTimeout(resolve, Math.min(masterExtract.length * 100, 2000)));
      
      const newCollections = [...collections];
      newCollections[collectionIndex] = masterExtract.map((ex) => ({
        fileId: ex.fileId,
        pageNumber: ex.pageNumber,
        content: ex.content,
        fileName: ex.fileName,
        PDFName: ex.PDFName,
        collection: ex.collection,
      }));

      setCollections(newCollections);
      setMasterExtract([]);
      setSelectedPages(new Set());
      setContext("");
      onContextUpdate("");
      setSelectedCollectionIndex(collectionIndex);
    } finally {
      setIsAssigning(false);
      setAssigningToCollection(null);
    }
  };

  const clearCollection = (index: number) => {
    const updated = [...collections];
    updated[index] = [];
    setCollections(updated);
    setMasterExtract((prev) =>
      prev.map((extract) =>
        extract.collection === index + 1 ? { ...extract, collection: undefined } : extract
      )
    );
  };

  const handleRefresh = async () => {
    if (isRefreshing || isAssigning || isDownloading) return;
    
    setIsRefreshing(true);
    
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('fileContent_')) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key));
      
      if (onRefreshData) {
        await onRefreshData();
        console.log('🔄 Collections: Refreshed data from Google Drive');
      }
      
      setMasterExtract([]);
      setSelectedPages(new Set());
      setContext("");
      onContextUpdate("");
      
    } catch (error) {
      console.error('❌ Error refreshing data:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="collection-manager">
      <div className="collection-header-wrapper">
        <h2 className="collection-header">
          Collections
        </h2>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing || isAssigning || isDownloading}
          className="collection-refresh-btn"
          title="Refresh data from Google Drive"
        >
          <FaSync 
            className={`collection-refresh-icon ${isRefreshing ? 'spinning' : ''}`} 
            size={12}
          />
        </button>
      </div>
      <div className="collection-list">
        {collections.map((coll, index) => {
          const isThisCollectionAssigning = assigningToCollection === index;
          const isDisabled = (isAssigning && !isThisCollectionAssigning) || isDownloading;
          const hasPages = masterExtract.length > 0;
          
          return (
            <div
              key={index}
              className={`collection-item ${coll.length > 0 ? "active" : ""} ${isDisabled ? "disabled" : ""} ${isThisCollectionAssigning ? "assigning" : ""}`}
            >
              {}
              <div
                className="collection-content"
                onClick={() => !isDisabled && hasPages && assignMasterExtractToCollection(index)}
                title={
                  isDownloading
                    ? "Downloading pages..."
                    : isDisabled 
                      ? "Please wait..." 
                      : !hasPages 
                        ? "Select pages first" 
                        : `Assign ${masterExtract.length} page(s) to collection ${index + 1}`
                }
                style={{
                  cursor: isDisabled || !hasPages ? 'not-allowed' : 'pointer',
                  opacity: isDisabled ? 0.5 : 1
                }}
              >
                {isThisCollectionAssigning ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                    <FaSpinner className="spinning-icon" size={12} />
                    <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                      Adding {masterExtract.length} pages...
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="collection-number">{index + 1}</div>
                    <div className="collection-pages">{coll.length}</div>
                  </>
                )}
              </div>
              <div className="collection-icons">
                {coll.length > 0 && !isAssigning && (
                  <>
                    <FaTrash 
                      className="collection-icon" 
                      size={12} 
                      onClick={(e) => {
                        e.stopPropagation();
                        clearCollection(index);
                      }}
                      title="Clear collection"
                    />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
