
'use client';

import React from 'react';
import { AgentJsonWithMetadata } from '../lib/types';

interface JsonViewerProps {
    parsedContent: AgentJsonWithMetadata | null;
}

const JsonViewer: React.FC<JsonViewerProps> = ({ parsedContent }) => {
    const displayContent = parsedContent || {};

    return (
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {JSON.stringify(displayContent, null, 2)}
        </pre>
    );
};

export default JsonViewer;
