import React, { useEffect, useState } from 'react';
import '../styles/projectSetupLoadingBar.css';

interface ProjectSetupLoadingBarProps {
  loadingSetup: boolean;
  totalSteps: number;
}

const ProjectSetupLoadingBar: React.FC<ProjectSetupLoadingBarProps> = ({ loadingSetup, totalSteps }) => {
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [progress, setProgress] = useState<number>(0);

  useEffect(() => {
    if (loadingSetup) {
      const timePerStep = 5000;
      const interval = setInterval(() => {
        setProgress((prev) => {
          const nextProgress = prev + 10;
          if (nextProgress >= 100) {
            if (currentStep < totalSteps) {
              setCurrentStep(currentStep + 1);
              return 0;
            } else {
              clearInterval(interval);
              return 100;
            }
          }
          return nextProgress;
        });
      }, timePerStep / 10);
      return () => clearInterval(interval);
    } else {
      setProgress(0);
      setCurrentStep(1);
    }
  }, [loadingSetup, totalSteps, currentStep]);

  if (!loadingSetup) return null;

  return (
    <div className="project-setup-loading-bar">
      <p>Setting up project folder: Step {currentStep} of {totalSteps}</p>
      <div className="progress-bar-container">
        <div className="progress-bar" style={{ width: `${progress}%` }}></div>
      </div>
      <p>{Math.floor(progress)}% complete for step {currentStep}</p>
    </div>
  );
};

export default ProjectSetupLoadingBar;
