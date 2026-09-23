import React, { useEffect, useState } from 'react';
import '../styles/uploadLoadingBar.css';

interface UploadLoadingBarProps {
    loadingExtract: boolean;
    fileName: string;
    startPage: number;
    endPage: number;
    completedPages: { file: string; page: string }[];
    addCompletedPage: (file: string, page: string) => void;
}

const UploadLoadingBar: React.FC<UploadLoadingBarProps> = ({
    loadingExtract,
    fileName,
    startPage,
    endPage,
    completedPages,
    addCompletedPage,
}) => {
    const [currentPage, setCurrentPage] = useState<number>(startPage);
    const [pageProgress, setPageProgress] = useState<number>(0);

    useEffect(() => {
        if (loadingExtract) {
            const timePerPage = 50000;
            let startTime = Date.now();

            const interval = setInterval(() => {
                const elapsedTime = Date.now() - startTime;
                const currentProgress = Math.min((elapsedTime / timePerPage) * 100, 100);
                setPageProgress(currentProgress);

                if (currentProgress >= 100) {
                    const pageKey = `Page ${currentPage} of ${endPage}`;
                    
                    if (!completedPages.find((entry) => entry.file === fileName && entry.page === pageKey)) {
                        addCompletedPage(fileName, pageKey);
                    }

                    if (currentPage < endPage) {
                        setCurrentPage((prevPage) => prevPage + 1);
                        setPageProgress(0);
                        startTime = Date.now();
                    } else {
                        clearInterval(interval);
                    }
                }
            }, 1000);

            return () => clearInterval(interval);
        } else {
            setCurrentPage(startPage);
            setPageProgress(0);
        }
    }, [loadingExtract, startPage, endPage, currentPage, fileName, completedPages, addCompletedPage]);


    return (
        <div className="upload-loading-bar">
            {}
            {loadingExtract && (
                <>
                    <p>Processing page {currentPage} of {endPage}</p>
                    <div className="progress-bar-container">
                        <div
                            className="progress-bar"
                            style={{ width: `${pageProgress}%` }}
                        ></div>
                    </div>
                    <p>{Math.floor(pageProgress)}% complete for page {currentPage}</p>
                </>
            )}

            {}
            <div className="completed-pages-list">
                {completedPages
                    .filter((entry) => entry.file === fileName)
                    .map(({ page }, index) => (
                        <div key={index} className="completed-page">
                            <p>
                                {page} <span className="checkmark">✔</span>
                            </p>
                            <div className="progress-bar-container">
                                <div className="progress-bar completed" style={{ width: '100%' }}></div>
                            </div>
                        </div>
                    ))}
            </div>
        </div>
    );
};

export default UploadLoadingBar;
