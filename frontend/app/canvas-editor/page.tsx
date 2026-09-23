'use client';

import Layout from '../components/canvas/Layout';
import { ThemeProvider } from '../contexts/ThemeContext';

export default function CanvasEditor() {
    return (
        <ThemeProvider>
            <div className="h-full min-h-0 flex-1 flex flex-col overflow-hidden">
                <Layout />
            </div>
        </ThemeProvider>
    );
} 