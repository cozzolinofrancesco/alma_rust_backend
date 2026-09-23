'use client';

import Main from './components/Main';

export default function CorpusValidationPage() {
    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-50 to-white">
            <div className="container mx-auto px-4 py-8">
                <div className="max-w-6xl mx-auto">
                    <header className="text-center mb-8">
                        <h3 className="text-xs sm:text-sm font-semibold tracking-wider text-amber-600 uppercase mb-2">
                            Experimental Tool - by Francesco Cozzolino
                        </h3>
                        <h1 className="text-4xl font-bold text-[#11074A] mb-2">
                            Knowledge Base Analysis
                        </h1>
                        <p className="text-xl text-[#4A4453] max-w-3xl mx-auto">
                            Select one or more knowledge bases and analyze them together through two visualizations:
                            <span className="font-semibold"> Claims-Evidence Sequence</span> and
                            <span className="font-semibold"> Evidence-References Network</span>
                        </p>
                    </header>

                    <Main />
                </div>
            </div>
        </div>
    );
}
