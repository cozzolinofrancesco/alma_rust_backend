'use client';

import { createContext, ReactNode, useContext, useRef } from 'react';

interface EditorContextType {
    insertText: (text: string) => void;
    saveToHistory: (content: string) => void;
    getContent: () => string;
    clearContent: () => void;
    loadFileContent: (fileId: string) => Promise<void>;
    setInsertTextRef: (fn: (text: string) => void) => void;
    setSaveToHistoryRef: (fn: (content: string) => void) => void;
    setGetContentRef: (fn: () => string) => void;
    setClearContentRef: (fn: () => void) => void;
    setLoadFileContentRef: (fn: (fileId: string) => Promise<void>) => void;
}

const EditorContext = createContext<EditorContextType | undefined>(undefined);

export function EditorProvider({ children }: { children: ReactNode }) {
    const insertTextRef = useRef<(text: string) => void>();
    const saveToHistoryRef = useRef<(content: string) => void>();
    const getContentRef = useRef<() => string>();
    const clearContentRef = useRef<() => void>();
    const loadFileContentRef = useRef<(fileId: string) => Promise<void>>();

    const insertText = (text: string) => {
        if (insertTextRef.current) {
            insertTextRef.current(text);
        }
    };

    const saveToHistory = (content: string) => {
        if (saveToHistoryRef.current) {
            saveToHistoryRef.current(content);
        }
    };

    const getContent = () => {
        if (getContentRef.current) {
            return getContentRef.current();
        }
        return '';
    };

    const clearContent = () => {
        if (clearContentRef.current) {
            clearContentRef.current();
        }
    };

    const loadFileContent = async (fileId: string) => {
        if (loadFileContentRef.current) {
            await loadFileContentRef.current(fileId);
        }
    };

    const setInsertTextRef = (fn: (text: string) => void) => {
        insertTextRef.current = fn;
    };

    const setSaveToHistoryRef = (fn: (content: string) => void) => {
        saveToHistoryRef.current = fn;
    };

    const setGetContentRef = (fn: () => string) => {
        getContentRef.current = fn;
    };

    const setClearContentRef = (fn: () => void) => {
        clearContentRef.current = fn;
    };

    const setLoadFileContentRef = (fn: (fileId: string) => Promise<void>) => {
        loadFileContentRef.current = fn;
    };

    return (
        <EditorContext.Provider
            value={{
                insertText,
                saveToHistory,
                getContent,
                clearContent,
                loadFileContent,
                setInsertTextRef,
                setSaveToHistoryRef,
                setGetContentRef,
                setClearContentRef,
                setLoadFileContentRef,
            }}
        >
            {children}
        </EditorContext.Provider>
    );
}

export function useEditor() {
    const context = useContext(EditorContext);
    if (context === undefined) {
        throw new Error('useEditor must be used within an EditorProvider');
    }
    return context;
} 