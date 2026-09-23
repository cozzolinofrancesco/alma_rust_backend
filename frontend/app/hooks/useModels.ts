import { useState, useEffect } from 'react';
import { ModelOption, sortModelsByRelease } from '../lib/modelConfig';
import importedModels from '../lib/models.json';

let cachedModels: ModelOption[] | null = null;
let fetchPromise: Promise<ModelOption[]> | null = null;

export function useModels() {
    const [models, setModels] = useState<ModelOption[]>(
        sortModelsByRelease(cachedModels || (importedModels as ModelOption[]))
    );

    useEffect(() => {
        if (cachedModels) {
            return;
        }

        let mounted = true;

        if (!fetchPromise) {
            fetchPromise = fetch('/api/models')
                .then(res => res.json())
                .then(data => {
                    if (data.models && data.models.length > 0) {
                        cachedModels = data.models;
                        return data.models;
                    }
                    throw new Error('No models found');
                })
                .catch(err => {
                    console.error('Error fetching models:', err);
                    return importedModels as ModelOption[];
                });
        }

        fetchPromise.then(fetchedModels => {
            if (mounted && fetchedModels) {
                setModels(sortModelsByRelease(fetchedModels));
            }
        });

        return () => {
            mounted = false;
        };
    }, []);

    return models;
}
