'use client';

import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

export const DOCUMENT_TEMPLATES = {
    'scientific': {
        name: 'Scientific Paper',
        sections: [
            'Abstract',
            'Introduction',
            'Methodology',
            'Results',
            'Discussion',
            'Conclusion',
            'References'
        ]
    },
    'investigative': {
        name: 'Investigative Brochure',
        sections: [
            'Executive Summary',
            'Background',
            'Investigation Process',
            'Key Findings',
            'Evidence Analysis',
            'Recommendations',
            'Conclusion'
        ]
    },
    'pk-report': {
        name: 'PK Report',
        sections: [
            'Abstract',
            'Introduction',
            'Methods',
            'Results',
            'Pharmacokinetic Analysis',
            'Safety Analysis',
            'Discussion',
            'Conclusion'
        ]
    },
    'investigators-brochure': {
        name: 'Investigator\'s Brochure (IB)',
        sections: [
            '1. SUMMARY',
            '1.1 SCIENTIFIC RATIONALE',
            '1.2 PHYSICAL, CHEMICAL, AND PHARMACEUTICAL PROPERTIES AND CLINICAL FORMULATION',
            '1.3 Nonclinical Information',
            '1.3.1 Nonclinical Pharmacology',
            '1.3.2 Pharmacokinetics and Drug Metabolism in Animals',
            '1.3.3 Toxicology and Safety Pharmacology',
            '1.4 Clinical Information',
            '2. INTRODUCTION',
            '2.1 Background on [Disease/Condition]',
            '2.2 CURRENT THERAPIES AND UNMET MEDICAL NEED',
            '2.3 SCIENTIFIC RATIONALE',
            '2.4 OVERVIEW OF CLINICAL DEVELOPMENT',
            '3. PHYSICAL, CHEMICAL, AND PHARMACEUTICAL PROPERTIES AND CLINICAL FORMULATION',
            '3.1 Physical and Chemical Properties',
            '3.2 Clinical Formulation',
            '4. NONCLINICAL STUDIES',
            '4.1 NONCLINICAL PHARMACOLOGY',
            '4.1.1 Introduction',
            '4.1.2 Primary Pharmacodynamics',
            '4.1.2.1 In Vitro Studies',
            '4.1.2.2 In Vivo Studies',
            '4.1.5 Pharmacodynamic Drug Interactions',
            '4.2 Pharmacokinetics and Drug Metabolism in Animals',
            '4.2.1 Introduction',
            '4.2.2 Methods of Analysis',
            '4.2.3 Absorption/Pharmacokinetic/Toxicokinetic Parameters',
            '4.2.3.1 Single-Dose Absorption/Pharmacokinetics',
            '4.2.3.2 Multiple-Dose Pharmacokinetics/Toxicokinetics',
            '4.2.4 Distribution',
            '4.2.5 Metabolism',
            '4.2.5.1 In Vitro Metabolism',
            '4.2.5.2 In Vivo Metabolism',
            '4.2.6 Excretion',
            '4.2.7 Pharmacokinetic Drug Interactions',
            '4.2.7.1 Potential for Other Drugs to Affect the Pharmacokinetics of [Drug Name]',
            '4.2.7.2 Potential for [Drug Name] to Affect the Pharmacokinetics of Other Drugs',
            '4.3 Toxicology and Safety Pharmacology',
            '4.3.1 Introduction',
            '4.3.2 Single-Dose Toxicity',
            '4.3.3 Repeat-Dose Toxicity',
            '4.3.4 Genotoxicity',
            '4.3.5 Carcinogenicity',
            '4.3.6 Reproductive and Developmental Toxicity',
            '4.3.7 Local Tolerance',
            '4.3.8 Safety Pharmacology',
            '4.4 Nonclinical Pharmacology, Pharmacokinetics and Toxicology Integrated Analysis',
            '5. EFFECTS IN HUMANS',
            '5.1 INTRODUCTION',
            '5.2 CLINICAL PHARMACOKINETICS',
            '5.2.1 Absorption, Bioavailability, Distribution, Metabolism, and Elimination',
            '5.2.2 Pharmacokinetics of Metabolites',
            '5.2.4 Pharmacokinetic Interactions',
            '5.3 Clinical Pharmacodynamics',
            '5.3.1 Pharmacodynamic Parameters',
            '5.3.2 Pharmacodynamic Interactions',
            '5.4 Clinical Efficacy',
            '5.5 Clinical Safety',
            '5.5.1 Overview of Adverse Events',
            '5.5.2 Deaths',
            '5.5.3 Serious Adverse Events',
            '5.5.4 Adverse Events that led to Withdrawal of Study Treatment / Study Discontinuation',
            '6. GUIDANCE FOR THE INVESTIGATOR (INCLUDING REFERENCE SAFETY INFORMATION)',
            '6.1 Approved Indications',
            '6.2 Contraindications',
            '6.3 Warnings and Precautions',
            '6.4 Identified Risks and Adverse Drug Reactions',
            '6.4.1 Reference Safety Information (Expected Serious Adverse Drug Reactions / Reactions)',
            '6.5 Potential Risks',
            '6.6 Special Patient Populations',
            '6.6.1 Pregnancy',
            '6.6.2 Nursing Mothers',
            '6.6.3 Children',
            '6.6.4 Geriatric Patients',
            '6.7 Concomitant use with Other Medications',
            '6.8 Overdose',
            '7. REFERENCES',
            '7.1 SPONSOR REPORTS',
            '7.2 LITERATURE REFERENCES',
            'LIST OF APPENDICES',
            'Appendix 1 Summary of Nonclinical Pharmacology Studies',
            'Appendix 2 Summary of Nonclinical Pharmacokinetic and Metabolism Studies',
            'Appendix 3 Summary of Toxicology Studies',
            'Appendix 4 Summary of Clinical Studies'
        ]
    }
};

export type DocumentTemplate = keyof typeof DOCUMENT_TEMPLATES;
export type DocumentMode = 'writing' | 'previewing';

interface SectionContent {
    [sectionName: string]: string;
}

interface DocumentState {
    mode: DocumentMode;
    template: DocumentTemplate | null;
    sections: SectionContent;
    activeSection: string | null;
    isInitialized: boolean;
}

interface DocumentContextType {
    mode: DocumentMode;
    template: DocumentTemplate | null;
    sections: SectionContent;
    activeSection: string | null;
    isInitialized: boolean;

    setTemplate: (template: DocumentTemplate) => void;
    setActiveSection: (section: string | null) => void;
    updateSectionContent: (section: string, content: string) => void;
    setMode: (mode: DocumentMode) => void;
    getMergedDocument: () => string;
    resetDocument: () => void;

    getCurrentSectionContent: () => string;
    getAvailableSections: () => string[];
    getActiveSection: () => string | null;
    getActiveSectionInitial: () => string;
}

const DocumentContext = createContext<DocumentContextType | undefined>(undefined);

const STORAGE_KEY = 'ai-editor-document-state';

export function DocumentProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<DocumentState>({
        mode: 'writing',
        template: null,
        sections: {},
        activeSection: null,
        isInitialized: false
    });

    useEffect(() => {
        const savedState = localStorage.getItem(STORAGE_KEY);
        if (savedState) {
            try {
                const parsed = JSON.parse(savedState);
                setState(prev => ({ ...prev, ...parsed, isInitialized: true }));
            } catch (error) {
                console.warn('Failed to parse saved document state:', error);
                setState(prev => ({ ...prev, isInitialized: true }));
            }
        } else {
            setState(prev => ({ ...prev, isInitialized: true }));
        }
    }, []);

    useEffect(() => {
        if (state.isInitialized) {
            const stateToSave = {
                mode: state.mode,
                template: state.template,
                sections: state.sections,
                activeSection: state.activeSection
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(stateToSave));
        }
    }, [state]);

    const setTemplate = (template: DocumentTemplate) => {
        const templateData = DOCUMENT_TEMPLATES[template];
        const newSections: SectionContent = {};

        templateData.sections.forEach(section => {
            newSections[section] = state.sections[section] || '';
        });

        setState(prev => ({
            ...prev,
            template,
            sections: newSections,
            activeSection: templateData.sections[0] || null,
            mode: 'writing'
        }));
    };

    const setActiveSection = (section: string | null) => {
        setState(prev => ({
            ...prev,
            activeSection: section
        }));
    };

    const updateSectionContent = (section: string, content: string) => {
        setState(prev => ({
            ...prev,
            sections: {
                ...prev.sections,
                [section]: content
            }
        }));
    };

    const setMode = (mode: DocumentMode) => {
        setState(prev => ({
            ...prev,
            mode
        }));
    };

    const getMergedDocument = (): string => {
        if (!state.template) return '';

        const templateData = DOCUMENT_TEMPLATES[state.template];
        const sections = templateData.sections;

        let mergedContent = '';

        sections.forEach((section, index) => {
            const content = state.sections[section] || '';

            mergedContent += `# ${section}\n\n`;

            if (content.trim()) {
                mergedContent += `${content}\n\n`;
            } else {
                mergedContent += `*Content for ${section} section...*\n\n`;
            }

            if (index < sections.length - 1) {
                mergedContent += '---\n\n';
            }
        });

        return mergedContent;
    };

    const resetDocument = () => {
        setState({
            mode: 'writing',
            template: null,
            sections: {},
            activeSection: null,
            isInitialized: true
        });
        localStorage.removeItem(STORAGE_KEY);
    };

    const getCurrentSectionContent = (): string => {
        if (!state.activeSection) return '';
        return state.sections[state.activeSection] || '';
    };

    const getAvailableSections = (): string[] => {
        if (!state.template) return [];
        return DOCUMENT_TEMPLATES[state.template].sections;
    };

    const getActiveSection = (): string | null => {
        return state.activeSection;
    };

    const getActiveSectionInitial = (): string => {
        if (!state.activeSection) return '';
        return state.activeSection.charAt(0).toUpperCase();
    };

    const contextValue: DocumentContextType = {
        mode: state.mode,
        template: state.template,
        sections: state.sections,
        activeSection: state.activeSection,
        isInitialized: state.isInitialized,

        setTemplate,
        setActiveSection,
        updateSectionContent,
        setMode,
        getMergedDocument,
        resetDocument,

        getCurrentSectionContent,
        getAvailableSections,
        getActiveSection,
        getActiveSectionInitial
    };

    return (
        <DocumentContext.Provider value={contextValue}>
            {children}
        </DocumentContext.Provider>
    );
}

export function useDocument() {
    const context = useContext(DocumentContext);
    if (context === undefined) {
        throw new Error('useDocument must be used within a DocumentProvider');
    }
    return context;
} 