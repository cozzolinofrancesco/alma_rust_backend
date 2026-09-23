import { useModels } from '../hooks/useModels';
import React from 'react';
import { DEFAULT_MODEL } from '../lib/modelConfig';

interface ModelSelectorProps {
    selectedModel: string;
    setSelectedModel: (model: string) => void;
    className?: string;
    style?: React.CSSProperties;
    showDescriptions?: boolean;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
    selectedModel,
    setSelectedModel,
    className = "detail-select",
    style,
    showDescriptions = false
}) => {
    const models = useModels();
    return (
        <select
            className={className}
            value={selectedModel || DEFAULT_MODEL}
            onChange={(e) => setSelectedModel(e.target.value)}
            style={style}
        >
            {models.map((model) => (
                <option key={model.value} value={model.value}>
                    {showDescriptions ? `${model.label} - ${model.description}` : model.label}
                </option>
            ))}
        </select>
    );
};

export default ModelSelector;
