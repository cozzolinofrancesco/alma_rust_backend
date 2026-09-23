'use client';

import { createContext, ReactNode, useContext, useState } from 'react';

export interface AgentStep {
    id: string;
    name: string;
    index: number;
}

interface AgentStepContextType {
    agentSteps: AgentStep[];
    activeStepId: string | null;
    stepContents: Record<string, string>;
    stepCorpusIds: Record<string, string>;
    setAgentSteps: (steps: AgentStep[]) => void;
    setActiveStepId: (id: string | null) => void;
    setStepContent: (id: string, content: string) => void;
    setStepCorpusIds: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    clearAgentSteps: () => void;
}

const AgentStepContext = createContext<AgentStepContextType | undefined>(undefined);

export function AgentStepProvider({ children }: { children: ReactNode }) {
    const [agentSteps, setAgentStepsState] = useState<AgentStep[]>([]);
    const [activeStepId, setActiveStepId] = useState<string | null>(null);
    const [stepContents, setStepContents] = useState<Record<string, string>>({});
    const [stepCorpusIds, setStepCorpusIds] = useState<Record<string, string>>({});

    const setAgentSteps = (steps: AgentStep[]) => {
        setAgentStepsState(steps);
        if (steps.length > 0) {
            setActiveStepId(steps[0].id);
        } else {
            setActiveStepId(null);
        }
        setStepContents(prev => {
            const next: Record<string, string> = {};
            steps.forEach(step => {
                next[step.id] = prev[step.id] ?? '';
            });
            return next;
        });
    };

    const setStepContent = (id: string, content: string) => {
        setStepContents(prev => ({ ...prev, [id]: content }));
        setActiveStepId(id);
    };

    const clearAgentSteps = () => {
        setAgentStepsState([]);
        setActiveStepId(null);
        setStepContents({});
        setStepCorpusIds({});
    };

    return (
        <AgentStepContext.Provider
            value={{
                agentSteps,
                activeStepId,
                stepContents,
                stepCorpusIds,
                setAgentSteps,
                setActiveStepId,
                setStepContent,
                setStepCorpusIds,
                clearAgentSteps,
            }}
        >
            {children}
        </AgentStepContext.Provider>
    );
}

export function useAgentSteps() {
    const context = useContext(AgentStepContext);
    if (!context) {
        throw new Error('useAgentSteps must be used within AgentStepProvider');
    }
    return context;
}

