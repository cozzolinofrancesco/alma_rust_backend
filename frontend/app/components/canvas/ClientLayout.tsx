'use client'

import { useState } from 'react';
import LoadingScreen from './LoadingScreen';

export default function ClientLayout({
    children,
}: {
    children: React.ReactNode
}) {
    const [loading, setLoading] = useState(true);

    const handleLoadingFinish = () => {
        console.log('ClientLayout: handleLoadingFinish called');
        setLoading(false);
    };

    console.log('ClientLayout render - loading:', loading);

    if (loading) {
        console.log('ClientLayout: rendering LoadingScreen');
        return <LoadingScreen onFinish={handleLoadingFinish} />
    }

    console.log('ClientLayout: rendering children');
    return (
        <div className="h-full min-h-0">
            {children}
        </div>
    )
} 