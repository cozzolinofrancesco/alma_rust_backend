'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import type { Recipe, StepCategory } from '../lib/recipesCatalog';
import { localizeRecipes } from '../lib/recipesCatalog';

export type { Recipe, RecipeEdge, RecipeStep, StepCategory } from '../lib/recipesCatalog';

interface RecipesListProps {
  onSimulateRecipe?: (recipe: Recipe) => void;
}

const STEP_INTERVAL_MS = 700;
const DONE_DISPLAY_MS = 1200;

function categoryClass(cat: StepCategory): string {
  return `c272-recipe__step--cat-${cat}`;
}

interface SimState {
  index: number;
  done: boolean;
}

export default function RecipesList({ onSimulateRecipe }: RecipesListProps) {
  const { t, locale } = useLanguage();
  const recipes = useMemo(() => localizeRecipes(t), [t, locale]);

  const [simMap, setSimMap] = useState<Record<string, SimState | null>>({});
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const clearTimer = (id: string) => {
    if (timersRef.current[id]) {
      clearTimeout(timersRef.current[id]);
      delete timersRef.current[id];
    }
  };

  const advanceSim = useCallback((recipeId: string, nextIndex: number, totalSteps: number) => {
    if (nextIndex >= totalSteps) {
      setSimMap((prev) => ({ ...prev, [recipeId]: { index: totalSteps - 1, done: true } }));
      timersRef.current[recipeId] = setTimeout(() => {
        setSimMap((prev) => ({ ...prev, [recipeId]: null }));
      }, DONE_DISPLAY_MS);
      return;
    }
    setSimMap((prev) => ({ ...prev, [recipeId]: { index: nextIndex, done: false } }));
    timersRef.current[recipeId] = setTimeout(() => {
      advanceSim(recipeId, nextIndex + 1, totalSteps);
    }, STEP_INTERVAL_MS);
  }, []);

  const handleSimulate = useCallback(
    (recipe: Recipe) => {
      if (onSimulateRecipe) {
        onSimulateRecipe(recipe);
        return;
      }
      clearTimer(recipe.id);
      setSimMap((prev) => ({ ...prev, [recipe.id]: { index: 0, done: false } }));
      timersRef.current[recipe.id] = setTimeout(() => {
        advanceSim(recipe.id, 1, recipe.steps.length);
      }, STEP_INTERVAL_MS);
    },
    [advanceSim, onSimulateRecipe],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      Object.values(timers).forEach((timer) => clearTimeout(timer));
    };
  }, []);

  return (
    <div className="c272-recipes-list" role="tabpanel" id="c272-panel-recipes" aria-labelledby="c272-tab-recipes">
      {recipes.map((recipe) => {
        const sim = simMap[recipe.id] ?? null;
        const isRunning = sim !== null && !sim.done;
        const isDone = sim?.done ?? false;

        return (
          <div key={recipe.id} className="c272-recipe">
            <div className="c272-recipe__header">
              <span className="c272-recipe__name">{recipe.name}</span>
              <span className={`c272-recipe__badge c272-recipe__badge--${recipe.featuredCategory}`}>
                {recipe.featuredLabel}
              </span>
              {recipe.wip && (
                <span className="c272-recipe__badge c272-recipe__badge--wip">{t('canvas272Page.recipes.wipBadge')}</span>
              )}
            </div>

            <p className="c272-recipe__desc">{recipe.description}</p>

            <div className="c272-recipe__flow" aria-hidden="true">
              {recipe.steps.map((step, i) => {
                let stepClass = `c272-recipe__step ${categoryClass(step.category)}`;
                if (sim !== null) {
                  if (i < sim.index) stepClass += ' c272-recipe__step--done';
                  else if (i === sim.index) stepClass += ' c272-recipe__step--active';
                }
                return (
                  <span key={i}>
                    {i > 0 && <span className="c272-recipe__arrow">›</span>}
                    <span className={stepClass}>{step.label}</span>
                  </span>
                );
              })}
            </div>

            <div className="c272-recipe__footer">
              {isDone && <span className="c272-recipe__status c272-recipe__status--done">{t('canvas272Page.recipes.done')}</span>}
              {isRunning && <span className="c272-recipe__status">{t('canvas272Page.recipes.simulating')}</span>}
              <button
                type="button"
                className="c272-recipe__simulate-btn"
                onClick={() => handleSimulate(recipe)}
                disabled={isRunning}
                aria-label={t('canvas272Page.recipes.viewAria', { name: recipe.name })}
              >
                {isRunning ? t('canvas272Page.recipes.running') : t('canvas272Page.recipes.viewBtn')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
