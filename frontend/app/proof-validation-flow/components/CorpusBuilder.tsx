'use client';

import React, { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { useCorpora } from '@/app/lib/hooks/useCorpora';

type CorpusMode = 'new' | 'existing';
type Source = 'local' | 'drive';

const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024;

const formatFileSize = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

interface CorpusBuilderProps {
  onCorpusReady?: (corpusId: string, displayName: string) => void;
}

const CorpusBuilder: React.FC<CorpusBuilderProps> = ({ onCorpusReady }) => {
  const { corpora, loading: corporaLoading, refetch } = useCorpora();

  const [source, setSource] = useState<Source>('local');
  const [mode, setMode] = useState<CorpusMode>('new');
  const [displayName, setDisplayName] = useState('');
  const [existingCorpusId, setExistingCorpusId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming) return;
    const next: File[] = [];
    for (const file of Array.from(incoming)) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        setError(`"${file.name}" exceeds the 30MB limit.`);
        continue;
      }
      next.push(file);
    }
    if (next.length > 0) {
      setError(null);
      setFiles((prev) => [...prev, ...next]);
    }
  }, []);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      if (submitting) return;
      addFiles(e.dataTransfer.files);
    },
    [addFiles, submitting]
  );

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const canSubmit =
    !submitting &&
    (mode === 'new'
      ? displayName.trim().length > 0 && files.length > 0
      : existingCorpusId.length > 0);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError(null);
    setJobId(null);

    if (mode === 'existing' && files.length === 0) {
      const displayName =
        corpora.find((c) => c.id === existingCorpusId)?.displayName ?? existingCorpusId;
      onCorpusReady?.(existingCorpusId, displayName);
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('mode', mode);
      formData.append('allowPartialSuccess', 'true');
      if (mode === 'new') formData.append('displayName', displayName.trim());
      else formData.append('existingCorpusId', existingCorpusId);
      files.forEach((file) => formData.append('file', file));

      const res = await fetch('/api/rag/corpora/local', { method: 'POST', body: formData });
      const data = (await res.json()) as { jobId?: string; error?: string };

      if (!res.ok || !data.jobId) {
        throw new Error(data.error || 'Failed to start corpus job');
      }

      setJobId(data.jobId);
      setFiles([]);
      setDisplayName('');
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start corpus job');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto">
      <div className="bg-white rounded-2xl shadow-lg border-2 border-gray-100 p-8">
        <h2 className="text-2xl font-bold text-[#11074A] mb-6 text-center">
          Add to Knowledge Base (RAG)
        </h2>

        {}
        <div className="flex justify-center gap-2 mb-6">
          {(['local', 'drive'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSource(s)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                source === s ? 'bg-[#11074A] text-white' : 'bg-[#AFA8BA]/20 text-[#4A4453] hover:bg-[#AFA8BA]/30'
              }`}
            >
              {s === 'local' ? 'Local Upload' : 'Google Drive'}
            </button>
          ))}
        </div>

        {source === 'drive' ? (
          <div className="text-center space-y-4 py-8">
            <p className="text-[#4A4453]">
              Build a corpus from your Google Drive documents using the full search, browse, and
              background-job interface.
            </p>
            <Link
              href="/rag-corpus"
              className="inline-flex items-center px-6 py-3 bg-[#11074A] text-white font-medium rounded-lg hover:bg-[#11074A]/90 transition-colors"
            >
              Open RAG Corpus Manager
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            {}
            <div className="flex justify-center gap-2">
              {(['new', 'existing'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    mode === m ? 'bg-[#11074A] text-white' : 'bg-[#AFA8BA]/20 text-[#4A4453] hover:bg-[#AFA8BA]/30'
                  }`}
                >
                  {m === 'new' ? 'New Corpus' : 'Add to Existing'}
                </button>
              ))}
            </div>

            {mode === 'new' ? (
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Corpus name"
                className="w-full px-4 py-3 border-2 border-[#AFA8BA] rounded-lg focus:border-[#11074A] focus:outline-none"
              />
            ) : (
              <select
                value={existingCorpusId}
                onChange={(e) => setExistingCorpusId(e.target.value)}
                className="w-full px-4 py-3 border-2 border-[#AFA8BA] rounded-lg focus:border-[#11074A] focus:outline-none"
              >
                <option value="">{corporaLoading ? 'Loading corpora…' : 'Select a corpus'}</option>
                {corpora.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            )}

            {}
            <div
              className={`relative border-2 border-dashed rounded-xl p-10 text-center transition-all duration-300 ${
                dragActive ? 'border-[#11074A] bg-[#11074A]/5' : 'border-[#AFA8BA]'
              } ${submitting ? 'opacity-50' : 'hover:border-[#11074A] hover:bg-gray-50 cursor-pointer'}`}
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => inputRef.current?.click()}
            >
              <input
                ref={inputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.txt,.md,.csv,.json,.xml,.xlsx,.xls,.pptx"
                onChange={(e) => addFiles(e.target.files)}
                disabled={submitting}
                className="absolute inset-0 w-full h-full cursor-pointer z-10"
                style={{ opacity: 0.01 }}
              />
              <p className="text-lg font-medium text-[#11074A] mb-1">
                Drop files here or click to browse
              </p>
              <p className="text-sm text-[#4A4453]">PDF, DOCX, TXT, CSV, and more · up to 30MB each</p>
            </div>

            {files.length > 0 && (
              <ul className="space-y-2">
                {files.map((file, index) => (
                  <li
                    key={`${file.name}-${index}`}
                    className="flex items-center justify-between bg-[#AFA8BA]/10 rounded-lg px-4 py-2"
                  >
                    <span className="text-[#11074A] text-sm truncate">
                      {file.name} · {formatFileSize(file.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      disabled={submitting}
                      className="text-red-600 text-sm hover:underline ml-4"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full px-6 py-3 bg-[#11074A] text-white font-medium rounded-lg hover:bg-[#11074A]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting
                ? 'Starting…'
                : mode === 'new'
                  ? 'Create Corpus'
                  : files.length === 0
                    ? 'Continue with this Corpus'
                    : 'Add to Corpus'}
            </button>

            {jobId && (
              <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-green-800">
                Processing started in the background (job <span className="font-mono">{jobId}</span>).
                Track progress on the{' '}
                <Link href="/rag-corpus" className="underline font-medium">
                  RAG Corpus page
                </Link>
                .
              </div>
            )}

            {error && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">{error}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default CorpusBuilder;
