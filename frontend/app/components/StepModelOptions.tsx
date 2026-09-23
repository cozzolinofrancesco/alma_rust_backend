'use client';

import { useLanguage } from '../contexts/LanguageContext';
import { canSelectStepModel, isGalileoModel, type StepModelOption } from '../lib/stepModels';

export default function StepModelOptions({ models, selectedModel }: {
  models: StepModelOption[];
  selectedModel?: string;
}) {
  const { t } = useLanguage();
  const options = [...models];
  if (selectedModel && !options.some(model => model.value === selectedModel)) {
    options.push({
      value: selectedModel,
      label: `${selectedModel} (${t('galileoModels.unavailable')})`,
      description: '',
      capabilities: [],
    });
  }
  const galileoOptions = options.filter(model => isGalileoModel(model.value));
  const renderOption = (model: StepModelOption) => {
    const unverified = isGalileoModel(model.value);
    const disabled = !canSelectStepModel(model.value, options);
    return (
      <option key={model.value} value={model.value} disabled={disabled}
        style={disabled ? { color: '#9ca3af' } : undefined}
        title={unverified ? t('galileoModels.keyEndpointUnverified') : undefined}>
        {model.label}{unverified && disabled ? ` (${t('galileoModels.unverified')})` : ''}
      </option>
    );
  };
  return <>
    {options.filter(model => !isGalileoModel(model.value)).map(renderOption)}
    {galileoOptions.length > 0 ? (
      <optgroup label={t(galileoOptions.every(model => !canSelectStepModel(model.value, options)) ? 'galileoModels.groupLabel' : 'galileoModels.enabledGroup')}
        disabled={galileoOptions.every(model => !canSelectStepModel(model.value, options))}>
        {galileoOptions.map(renderOption)}
      </optgroup>
    ) : null}
  </>;
}