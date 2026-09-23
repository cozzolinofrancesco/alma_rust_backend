'use client';

import Image from 'next/image';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { FaMinus, FaPlus } from 'react-icons/fa';
import pubmedApiService, {
  PubMedApiError,
  PubMedErrorType,
  ScientificPaper,
  SelectedPaper
} from '../lib/pubmedApiService';
import HowlChat from './HowlChat';

interface ScientificPaperSearchProps {
  onPapersSelected: (papers: SelectedPaper[]) => void;
  selectedPapers: SelectedPaper[];
}

const ScientificPaperSearch: React.FC<ScientificPaperSearchProps> = ({
  onPapersSelected,
  selectedPapers
}) => {
  const [scientificQuery, setScientificQuery] = useState<string>('');
  const [scientificResults, setScientificResults] = useState<ScientificPaper[]>([]);
  const [scientificLoading, setScientificLoading] = useState<boolean>(false);
  const [selectedAbstract, setSelectedAbstract] = useState<{ title: string; abstract: string } | null>(null);
  const [showHowlChat, setShowHowlChat] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [errorType, setErrorType] = useState<PubMedErrorType | null>(null);

  const [currentOffset, setCurrentOffset] = useState<number>(0);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);

  const searchScientificPapers = async (query: string) => {
    if (!query.trim()) {
      setScientificResults([]);
      setErrorMessage('');
      setErrorType(null);
      setCurrentOffset(0);
      setTotalCount(0);
      setHasMore(false);
      return;
    }

    setScientificLoading(true);
    setErrorMessage('');
    setErrorType(null);
    setCurrentOffset(0);

    try {
      const result = await pubmedApiService.searchPapersWithPagination(query, 0, 25);
      setScientificResults(result.results);
      setTotalCount(result.totalCount);
      setHasMore(result.hasMore);
      setCurrentOffset(25);
    } catch (error) {
      if (error instanceof PubMedApiError) {
        setErrorMessage(error.message);
        setErrorType(error.type);
        console.error(`PubMed API Error (${error.type}):`, error.message);
      } else {
        setErrorMessage('An unexpected error occurred while searching. Please try again.');
        setErrorType(PubMedErrorType.UNKNOWN);
        console.error('Unexpected error searching scientific papers:', error);
      }
      setScientificResults([]);
      setTotalCount(0);
      setHasMore(false);
    } finally {
      setScientificLoading(false);
    }
  };

  const loadMoreScientificPapers = async () => {
    if (!scientificQuery.trim() || !hasMore || loadingMore) {
      return;
    }

    setLoadingMore(true);
    setErrorMessage('');
    setErrorType(null);

    try {
      const result = await pubmedApiService.searchPapersWithPagination(scientificQuery, currentOffset, 25);
      setScientificResults(prev => [...prev, ...result.results]);
      setHasMore(result.hasMore);
      setCurrentOffset(prev => prev + 25);
    } catch (error) {
      if (error instanceof PubMedApiError) {
        setErrorMessage(error.message);
        setErrorType(error.type);
        console.error(`PubMed API Error (${error.type}):`, error.message);
      } else {
        setErrorMessage('An unexpected error occurred while loading more results. Please try again.');
        setErrorType(PubMedErrorType.UNKNOWN);
        console.error('Unexpected error loading more scientific papers:', error);
      }
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      searchScientificPapers(scientificQuery);
    }, 500);

    return () => clearTimeout(timer);
  }, [scientificQuery]);

  const addPaperToSelection = (paper: ScientificPaper) => {
    const selectedPaper: SelectedPaper = {
      id: paper.doi || paper.title,
      title: paper.title,
      abstract: paper.abstract,
      authors: paper.authors,
      pubdate: paper.pubdate,
      doi: paper.doi
    };
    const newSelectedPapers = [...selectedPapers, selectedPaper];
    onPapersSelected(newSelectedPapers);
  };

  const removePaperFromSelection = (paperId: string) => {
    const newSelectedPapers = selectedPapers.filter(p => p.id !== paperId);
    onPapersSelected(newSelectedPapers);
  };

  const isPaperSelected = (paper: ScientificPaper): boolean => {
    const paperId = paper.doi || paper.title;
    return selectedPapers.some(p => p.id === paperId);
  };

  const prepareSelectedPapersContext = (): string => {
    if (selectedPapers.length === 0) {
      return "No scientific papers have been selected yet.";
    }

    const papersContext = selectedPapers.map((paper, index) => {
      return `
**Paper ${index + 1}:**
Title: ${paper.title}
Authors: ${paper.authors.join(', ')}
Publication Date: ${paper.pubdate}
DOI: ${paper.doi || 'Not available'}

Abstract:
${paper.abstract || 'No abstract available.'}

---
`;
    }).join('\n');

    return `Here are the ${selectedPapers.length} selected scientific paper${selectedPapers.length !== 1 ? 's' : ''} for your reference:

${papersContext}

Please help me analyze, discuss, or answer questions about these scientific papers.`;
  };

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      {}
      <h2 className="collection-header" style={{ marginBottom: '1rem' }}>
        Scientific Papers
      </h2>
      {}
      {selectedPapers.length > 0 && (
        <div style={{
          marginBottom: '1rem',
          padding: '0.5rem',
          backgroundColor: '#E8E3F3',
          border: '1px solid #12074A',
          borderRadius: '6px',
          fontSize: '0.9rem',
          width: '89%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <span>
            <strong>Selected:</strong> {selectedPapers.length} paper{selectedPapers.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => onPapersSelected([])}
            style={{
              background: 'none',
              border: 'none',
              color: '#ef4444',
              cursor: 'pointer',
              padding: '0.25rem',
              borderRadius: '3px',
              fontSize: '0.8rem'
            }}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#fee2e2'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            title="Clear all selections"
          >
            Clear All
          </button>
        </div>
      )}

      {}
      <div style={{
        marginBottom: '0.75rem',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center'
      }}>
        <input
          type="text"
          placeholder="Search scientific papers or enter DOI..."
          value={scientificQuery}
          onChange={(e) => setScientificQuery(e.target.value)}
          style={{
            width: '100%',
            maxWidth: '600px',
            padding: '0.5rem',
            border: '1px solid #e5e7eb',
            borderRadius: '6px',
            fontSize: '0.9rem',
            outline: 'none'
          }}
          onFocus={(e) => e.target.style.borderColor = '#12074A'}
          onBlur={(e) => e.target.style.borderColor = '#e5e7eb'}
        />
      </div>

      {}
      {scientificQuery.trim() && (
        <div style={{ marginBottom: '1rem', width: '100%' }}>
          {scientificLoading ? (
            <div style={{
              textAlign: 'center',
              padding: '1rem',
              color: '#6b7280',
              fontStyle: 'italic'
            }}>
              Searching scientific papers...
            </div>
          ) : errorMessage ? (
            <div style={{
              padding: '1rem',
              backgroundColor: errorType === PubMedErrorType.RATE_LIMIT ? '#fef3c7' : '#fee2e2',
              border: `1px solid ${errorType === PubMedErrorType.RATE_LIMIT ? '#f59e0b' : '#ef4444'}`,
              borderRadius: '6px',
              color: errorType === PubMedErrorType.RATE_LIMIT ? '#92400e' : '#991b1b',
              fontSize: '0.9rem'
            }}>
              <div style={{ fontWeight: '600', marginBottom: '0.5rem' }}>
                {errorType === PubMedErrorType.RATE_LIMIT ? '⚠️ Rate Limit Exceeded' :
                  errorType === PubMedErrorType.SERVER_ERROR ? '🔧 Server Error' :
                    errorType === PubMedErrorType.NOT_FOUND ? '🔍 No Results' :
                      errorType === PubMedErrorType.INVALID_QUERY ? '❌ Invalid Query' :
                        '⚠️ Search Error'}
              </div>
              <div>{errorMessage}</div>
              {errorType === PubMedErrorType.RATE_LIMIT && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                  <strong>Tip:</strong> The search will automatically retry. You can also get an API key from your NCBI account for higher rate limits.
                </div>
              )}
              {errorType === PubMedErrorType.SERVER_ERROR && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                  <strong>Note:</strong> This is usually temporary. The search will automatically retry.
                </div>
              )}
            </div>
          ) : scientificResults.length > 0 ? (
            <div>
              <h4 style={{
                margin: '0 0 0.5rem 0',
                fontSize: '0.95rem',
                color: '#374151',
                fontWeight: '600'
              }}>
                Search Results ({scientificResults.length}{totalCount > 0 ? ` of ${totalCount} total` : ''})
              </h4>
              <div style={{ maxHeight: '100vh', overflowY: 'auto' }}>
                {scientificResults.map((paper, index) => {
                  const isSelected = isPaperSelected(paper);

                  return (
                    <div
                      key={paper.doi || `${paper.title}-${index}`}
                      style={{
                        padding: '0.75rem',
                        marginBottom: '0.5rem',
                        backgroundColor: isSelected ? '#E8E3F3' : '#F8FAFC',
                        border: `1px solid ${isSelected ? '#12074A' : '#e5e7eb'}`,
                        borderRadius: '6px',
                        fontSize: '0.9rem',
                        transition: 'all 0.2s',
                        width: '100%',
                        boxSizing: 'border-box',
                        overflow: 'hidden'
                      }}
                    >
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        marginBottom: '0.5rem'
                      }}>
                        <h5 style={{
                          margin: '0',
                          fontSize: '1rem',
                          fontWeight: '600',
                          color: '#1f2937',
                          flex: 1,
                          lineHeight: '1.4',
                          minWidth: 0,
                          wordWrap: 'break-word',
                          wordBreak: 'break-word'
                        }}>
                          {paper.title}
                        </h5>
                        <button
                          onClick={() => isSelected ? removePaperFromSelection(paper.doi || paper.title) : addPaperToSelection(paper)}
                          style={{
                            marginLeft: '0.75rem',
                            padding: '0.25rem 0.5rem',
                            backgroundColor: isSelected ? '#ef4444' : '#12074A',
                            color: '#ffffff',
                            border: 'none',
                            borderRadius: '4px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            flexShrink: 0
                          }}
                          onMouseOver={(e) => {
                            e.currentTarget.style.opacity = '0.8';
                          }}
                          onMouseOut={(e) => {
                            e.currentTarget.style.opacity = '1';
                          }}
                        >
                          {isSelected ? <FaMinus size={10} /> : <FaPlus size={10} />}
                          {isSelected ? 'Remove' : 'Add'}
                        </button>
                      </div>

                      <div style={{
                        fontSize: '0.8rem',
                        color: '#6b7280',
                        marginBottom: '0.5rem',
                        wordWrap: 'break-word',
                        wordBreak: 'break-word',
                        overflow: 'hidden'
                      }}>
                        <strong>Authors:</strong> {paper.authors.join(', ')} |
                        <strong> Date:</strong> {paper.pubdate}
                        {paper.doi && <><strong> | DOI:</strong> {paper.doi}</>}
                      </div>

                      <div style={{
                        fontSize: '0.85rem',
                        color: '#374151',
                        lineHeight: '1.4',
                        marginBottom: '0.5rem'
                      }}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '0.5rem'
                        }}>
                          <div style={{
                            maxHeight: '120px',
                            overflow: 'hidden',
                            wordWrap: 'break-word',
                            wordBreak: 'break-word',
                            flex: 1
                          }}>
                            <strong>Abstract:</strong> {paper.abstract || 'No abstract available.'}
                          </div>
                          {paper.abstract && (
                            <button
                              onClick={() => setSelectedAbstract({
                                title: paper.title,
                                abstract: paper.abstract
                              })}
                              style={{
                                background: 'none',
                                border: 'none',
                                padding: '2px 4px',
                                fontSize: '0.8rem',
                                color: '#12074A',
                                cursor: 'pointer',
                                minWidth: '20px',
                                flexShrink: 0
                              }}
                              onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#F5F3FB'}
                              onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                              title="Read full abstract"
                            >
                              [ ]
                            </button>
                          )}
                        </div>
                      </div>

                      {isSelected && (
                        <div style={{
                          marginTop: '0.5rem',
                          padding: '0.25rem 0.5rem',
                          backgroundColor: '#E8E3F3',
                          borderRadius: '4px',
                          fontSize: '0.8rem',
                          color: '#12074A',
                          fontWeight: '500'
                        }}>
                          ✓ Selected for agent use
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {}
              {(hasMore || loadingMore) && (
                <div style={{
                  marginTop: '1rem',
                  textAlign: 'center'
                }}>
                  <button
                    onClick={loadMoreScientificPapers}
                    disabled={loadingMore}
                    style={{
                      padding: '0.75rem 1.5rem',
                      backgroundColor: loadingMore ? '#9ca3af' : '#12074A',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '6px',
                      fontSize: '0.9rem',
                      cursor: loadingMore ? 'not-allowed' : 'pointer',
                      fontWeight: '500',
                      transition: 'all 0.2s'
                    }}
                    onMouseOver={(e) => {
                      if (!loadingMore) {
                        e.currentTarget.style.backgroundColor = '#0f0645';
                      }
                    }}
                    onMouseOut={(e) => {
                      if (!loadingMore) {
                        e.currentTarget.style.backgroundColor = '#12074A';
                      }
                    }}
                  >
                    {loadingMore ? 'Loading more papers...' : `Load More Papers (${totalCount - scientificResults.length} remaining)`}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div style={{
              textAlign: 'center',
              padding: '1rem',
              color: '#6b7280',
              fontStyle: 'italic'
            }}>
              No papers found for "{scientificQuery}"
            </div>
          )}
        </div>
      )}

      {}
      {selectedAbstract && ReactDOM.createPortal(
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem'
        }}>
          <div style={{
            backgroundColor: '#ffffff',
            borderRadius: '8px',
            width: '90vw',
            height: '90vh',
            padding: '2rem',
            overflow: 'auto',
            position: 'relative'
          }}>
            <button
              onClick={() => setSelectedAbstract(null)}
              style={{
                position: 'absolute',
                top: '1rem',
                right: '1rem',
                background: 'none',
                border: 'none',
                fontSize: '1.5rem',
                cursor: 'pointer',
                color: '#6b7280',
                fontWeight: 'bold'
              }}
              onMouseOver={(e) => e.currentTarget.style.color = '#12074A'}
              onMouseOut={(e) => e.currentTarget.style.color = '#6b7280'}
              title="Close"
            >
              ×
            </button>

            {}
            <div
              style={{
                position: 'absolute',
                top: '1rem',
                right: '3rem',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '30px',
                height: '30px',
                cursor: 'pointer'
              }}
              onClick={() => {
                setSelectedAbstract(null);
                setShowHowlChat(true);
              }}
              title="Chat with Alma"
            >
              <Image
                src="/images/dark fav private/apple-icon.png"
                alt="Chat"
                width={30}
                height={30}
                style={{ width: "100%", height: "100%" }}
              />
            </div>

            <h3 style={{
              margin: '0 0 1.5rem 0',
              fontSize: '1.25rem',
              fontWeight: '600',
              color: '#1f2937',
              paddingRight: '2rem',
              lineHeight: '1.4'
            }}>
              {selectedAbstract.title}
            </h3>

            <div style={{
              fontSize: '1rem',
              lineHeight: '1.6',
              color: '#374151',
              whiteSpace: 'pre-wrap',
              wordWrap: 'break-word'
            }}>
              <strong>Abstract:</strong><br /><br />
              {selectedAbstract.abstract}
            </div>
          </div>
        </div>,
        document.body
      )}

      {}
      {showHowlChat && ReactDOM.createPortal(
        <HowlChat
          initialPrompt={prepareSelectedPapersContext()}
          onClose={() => setShowHowlChat(false)}
        />,
        document.body
      )}
    </div>
  );
};

export type { ScientificPaper, SelectedPaper } from '../lib/pubmedApiService';

export default ScientificPaperSearch; 