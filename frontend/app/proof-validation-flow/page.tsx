'use client';

import { useState, useEffect, useRef } from 'react';
import Main from './components/Main';

interface JobFile {
    id: string;
    name: string;
    status: string;
}

interface JobDetails {
    status: string;
    processedFiles?: number;
    totalFiles?: number;
    currentFile?: string;
    currentOperation?: string;
    corpusId?: string;
    error?: string;
    files?: JobFile[];
}

function AutoSeeder() {
    const [status, setStatus] = useState<'idle' | 'fetching' | 'uploading' | 'polling' | 'success' | 'failed'>('idle');
    const [message, setMessage] = useState('');
    const [progress, setProgress] = useState(0);
    const [jobId, setJobId] = useState<string | null>(null);
    const [jobDetails, setJobDetails] = useState<JobDetails | null>(null);
    const hasRun = useRef(false);

    const runSeeder = async () => {
        if (hasRun.current) return;
        hasRun.current = true;
        
        try {
            setStatus('fetching');
            setMessage('Fetching 20 PDF files from public directory...');
            setProgress(5);

            const filesToFetch = Array.from({ length: 20 }, (_, i) => `test_pdf_${i + 1}.pdf`);
            const files: File[] = [];

            for (let i = 0; i < filesToFetch.length; i++) {
                const fileName = filesToFetch[i];
                const res = await fetch(`/test_pdfs/${fileName}`);
                if (!res.ok) {
                    throw new Error(`Failed to fetch /test_pdfs/${fileName}`);
                }
                const blob = await res.blob();
                files.push(new File([blob], fileName, { type: 'application/pdf' }));
                setProgress(5 + Math.round(((i + 1) / filesToFetch.length) * 35));
            }

            setStatus('uploading');
            setMessage('Uploading and indexing files in Gemini (creating corpus "automatic test")...');
            setProgress(45);

            const formData = new FormData();
            formData.append('mode', 'new');
            formData.append('displayName', 'automatic test');
            formData.append('allowPartialSuccess', 'true');
            files.forEach((file) => {
                formData.append('file', file);
            });

            const res = await fetch('/api/rag/corpora/local', {
                method: 'POST',
                body: formData,
            });

            const result = await res.json();
            if (!res.ok) {
                throw new Error(result.error || result.details || 'Upload failed');
            }

            const activeJobId = result.jobId;
            setJobId(activeJobId);
            setStatus('polling');
            setMessage(`Corpus creation job ${activeJobId} initiated. Querying status...`);
            setProgress(50);
        } catch (error) {
            console.error('Seeder error:', error);
            setStatus('failed');
            setMessage(error instanceof Error ? error.message : 'An error occurred during seeding');
            setProgress(100);
            hasRun.current = false;
        }
    };

    useEffect(() => {
        if (status !== 'polling' || !jobId) return;

        let active = true;
        const interval = setInterval(async () => {
            try {
                const res = await fetch(`/api/rag/jobs/${jobId}`);
                if (!res.ok) {
                    throw new Error(`Failed to fetch job: ${res.statusText}`);
                }
                const data = await res.json();
                if (!active) return;

                setJobDetails(data);
                
                const processed = data.processedFiles || 0;
                const total = data.totalFiles || 1;
                const jobProgress = 50 + Math.round((processed / total) * 50);
                setProgress(jobProgress);

                const currentFileStr = data.currentFile ? ` [${data.currentFile}]` : '';
                const currentOpStr = data.currentOperation ? ` - ${data.currentOperation}` : '';
                setMessage(`Processing: ${processed}/${total} files${currentFileStr}${currentOpStr}`);

                if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(data.status)) {
                    clearInterval(interval);
                    if (data.status === 'completed' || data.status === 'completed_with_errors') {
                        setStatus('success');
                        setMessage(`Success! Job finished with status: ${data.status}. Corpus ID: ${data.corpusId || 'Ready'}`);
                    } else {
                        setStatus('failed');
                        setMessage(`Job stopped with status: ${data.status}. Error: ${data.error || 'Check server logs'}`);
                    }
                    setProgress(100);
                }
            } catch (err) {
                console.error('Polling error:', err);
                setMessage(`Polling error: ${err instanceof Error ? err.message : String(err)}. Retrying...`);
            }
        }, 3000);

        return () => {
            active = false;
            clearInterval(interval);
        };
    }, [status, jobId]);

    useEffect(() => {
        if (typeof window !== 'undefined') {
            const params = new URLSearchParams(window.location.search);
            if (params.get('seed') === 'true' || params.get('autostart') === 'true') {
                runSeeder();
            }
        }
    }, []);

    return (
        <div className="mb-8 p-6 bg-amber-50 border border-amber-200 rounded-xl shadow-sm">
            <h2 className="text-lg font-bold text-amber-900 mb-2 flex items-center gap-2">
                ⚡ Automatic Indexing Seeder
            </h2>
            <p className="text-sm text-amber-800 mb-4">
                This utility automatically fetches the 20 pre-generated PDF files and uploads them to the RAG backend 
                to create the corpus named <strong className="font-semibold">"automatic test"</strong>.
            </p>
            <div className="flex flex-wrap items-center gap-4 mb-4">
                <button
                    onClick={() => { hasRun.current = false; runSeeder(); }}
                    disabled={status === 'fetching' || status === 'uploading' || status === 'polling'}
                    className={`px-4 py-2 font-medium rounded-lg text-sm transition-colors ${
                        status === 'fetching' || status === 'uploading' || status === 'polling'
                            ? 'bg-amber-200 text-amber-500 cursor-not-allowed'
                            : 'bg-amber-600 hover:bg-amber-700 text-white shadow-sm'
                    }`}
                >
                    {status === 'fetching' || status === 'uploading' || status === 'polling' ? 'Seeding in Progress...' : '🚀 Start Seeding "automatic test"'}
                </button>
                
                {status !== 'idle' && (
                    <div className="text-xs font-semibold uppercase px-2 py-1 rounded bg-amber-100 text-amber-800">
                        Status: {status}
                    </div>
                )}
            </div>

            {status !== 'idle' && (
                <div className="space-y-4">
                    <div className="space-y-2">
                        <div className="w-full bg-amber-200 rounded-full h-2.5 overflow-hidden">
                            <div 
                                className="bg-amber-600 h-2.5 rounded-full transition-all duration-300" 
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                        <p className="text-xs text-amber-700 font-mono italic">{message}</p>
                    </div>

                    {jobDetails?.files && (
                        <div className="max-h-40 overflow-y-auto border border-amber-200 rounded-lg bg-white p-3 text-xs">
                            <h4 className="font-bold text-amber-900 mb-2">File Ingestion Details:</h4>
                            <div className="grid grid-cols-2 gap-2">
                                {jobDetails.files.map((file: JobFile) => (
                                    <div key={file.id} className="flex justify-between items-center p-1 border-b border-gray-50">
                                        <span className="truncate pr-2 font-mono text-[10px] text-gray-700">{file.name}</span>
                                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                                            file.status === 'indexed' ? 'bg-green-100 text-green-800' :
                                            file.status === 'indexing' ? 'bg-blue-100 text-blue-800' :
                                            file.status === 'error' ? 'bg-red-100 text-red-800' :
                                            file.status === 'skipped' ? 'bg-gray-100 text-gray-800' :
                                            'bg-yellow-100 text-yellow-800'
                                        }`}>
                                            {file.status}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default function PDFSequenceAnalyzerPage() {
    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-50 to-white">
            <div className="container mx-auto px-4 py-8">
                <div className="max-w-6xl mx-auto">
                    <header className="text-center mb-8">
                        <h3 className="text-xs sm:text-sm font-semibold tracking-wider text-amber-600 uppercase mb-2">
                            Experimental Tool - by Francesco Cozzolino
                        </h3>
                        <h1 className="text-4xl font-bold text-[#11074A] mb-2">
                            Proof Validation Flow
                        </h1>
                        <p className="text-xl text-[#4A4453] max-w-3xl mx-auto">
                            Upload your research paper and analyze it through two powerful visualizations:
                            <span className="font-semibold"> Claims-Evidence Sequence</span> and
                            <span className="font-semibold"> Evidence-References Network</span>
                        </p>
                    </header>

                    <AutoSeeder />

                    <Main />
                </div>
            </div>
        </div>
    );
} 