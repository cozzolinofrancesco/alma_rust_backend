import { useState, useCallback } from 'react';

interface GlobalExecutionState {
  isAnyStepRunning: boolean;
  runningSteps: Record<string, boolean>;
  executionErrors: Record<string, string | undefined>;
  currentExecutingStep: string | null;
}

interface UseGlobalStepExecutionReturn {
  isAnyStepRunning: boolean;
  runningSteps: Record<string, boolean>;
  executionErrors: Record<string, string | undefined>;
  currentExecutingStep: string | null;
  startExecution: (stepId: string) => boolean;
  completeExecution: (stepId: string) => void;
  failExecution: (stepId: string, error?: Error) => void;
  isStepRunning: (stepId: string) => boolean;
}

export const useGlobalStepExecution = (): UseGlobalStepExecutionReturn => {
  const [state, setState] = useState<GlobalExecutionState>({
    isAnyStepRunning: false,
    runningSteps: {},
    executionErrors: {},
    currentExecutingStep: null,
  });

  const startExecution = useCallback((stepId: string): boolean => {
    if (state.isAnyStepRunning) {
      console.warn(`Cannot start step ${stepId}: another step is already running (${state.currentExecutingStep})`);
      return false;
    }

    setState(prevState => ({
      ...prevState,
      isAnyStepRunning: true,
      runningSteps: { ...prevState.runningSteps, [stepId]: true },
      executionErrors: { ...prevState.executionErrors, [stepId]: undefined },
      currentExecutingStep: stepId,
    }));

    console.log(`Started execution of step: ${stepId}`);
    return true;
  }, [state.isAnyStepRunning, state.currentExecutingStep]);

  const completeExecution = useCallback((stepId: string): void => {
    setState(prevState => {
      const newRunningSteps = { ...prevState.runningSteps };
      delete newRunningSteps[stepId];

      return {
        ...prevState,
        isAnyStepRunning: false,
        runningSteps: newRunningSteps,
        currentExecutingStep: null,
      };
    });

    console.log(`Completed execution of step: ${stepId}`);
  }, []);

  const failExecution = useCallback((stepId: string, error?: Error): void => {
    setState(prevState => {
      const newRunningSteps = { ...prevState.runningSteps };
      delete newRunningSteps[stepId];

      return {
        ...prevState,
        isAnyStepRunning: false,
        runningSteps: newRunningSteps,
        executionErrors: { ...prevState.executionErrors, [stepId]: error?.message || 'Generation failed' },
        currentExecutingStep: null,
      };
    });

    console.error(`Failed execution of step ${stepId}:`, error);
  }, []);

  const isStepRunning = useCallback((stepId: string): boolean => {
    return Boolean(state.runningSteps[stepId]);
  }, [state.runningSteps]);

  return {
    isAnyStepRunning: state.isAnyStepRunning,
    runningSteps: state.runningSteps,
    executionErrors: state.executionErrors,
    currentExecutingStep: state.currentExecutingStep,
    startExecution,
    completeExecution,
    failExecution,
    isStepRunning,
  };
}; 