import React from 'react';

interface CopyIconProps {
    textToCopy: string;
}

const CopyIcon: React.FC<CopyIconProps> = ({ textToCopy }) => {
    const copyToClipboard = () => {
        if (!textToCopy.trim()) {
            alert("No text available to copy!");
            return;
        }
        navigator.clipboard.writeText(textToCopy).then(() => {
            alert("Copied to clipboard!");
        }).catch((error) => {
            console.error("Failed to copy: ", error);
        });
    };

    return (
        <span
            style={{
                top: '50px',
                right: '50px',
                color: 'black',
                fontSize: '16px',
                cursor: 'pointer',
                zIndex: 1000
            }}
            onClick={copyToClipboard}
            title="Copy to clipboard"
        >
            🗎
        </span>
    );
};

export default CopyIcon;
