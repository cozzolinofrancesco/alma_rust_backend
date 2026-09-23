'use client';

import { useState } from 'react';
import SkillsBar from './SkillsBar';
import SkillModal from './SkillModal';
import SkillsHelpModal from './SkillsHelpModal';
import type { SkillsLibrary } from './useSkillsLibrary';

interface SkillsPanelProps {
  lib: SkillsLibrary;
  attachedIds: string[];
  onChange: (nextIds: string[]) => void;
  disabled?: boolean;
  className?: string;
}

// Self-contained skills UI for an editor surface: renders the icon bar and owns
// the add/edit modal. Both the form and graph views drop this in and only
// supply the attached ids + a change handler that persists onto the agent.
export default function SkillsPanel({ lib, attachedIds, onChange, disabled, className }: SkillsPanelProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingSkill = editingId ? lib.library.find((s) => s.id === editingId) ?? null : null;

  const attach = (id: string) => {
    if (!attachedIds.includes(id)) onChange([...attachedIds, id]);
  };
  const detach = (id: string) => {
    onChange(attachedIds.filter((x) => x !== id));
  };

  return (
    <>
      <SkillsBar
        library={lib.library}
        attachedIds={attachedIds}
        loading={lib.loading}
        error={lib.error}
        disabled={disabled}
        className={className}
        onSelectSkill={attach}
        onRefresh={() => { void lib.refresh(); }}
        onAddClick={() => {
          setEditingId(null);
          setModalOpen(true);
          void lib.refresh();
        }}
        onSkillClick={(id) => {
          setEditingId(id);
          setModalOpen(true);
        }}
        onDetach={detach}
        onHelpClick={() => setHelpOpen(true)}
      />
      <SkillModal
        open={modalOpen}
        library={lib.library}
        attachedIds={attachedIds}
        libraryLoading={lib.loading}
        libraryError={lib.error}
        onRefresh={() => { void lib.refresh(); }}
        editingSkill={editingSkill}
        onClose={() => setModalOpen(false)}
        onCreate={lib.create}
        onUpdate={lib.update}
        onDelete={async (id) => {
          await lib.remove(id);
          detach(id);
        }}
        onAttach={attach}
        onDetach={detach}
      />
      <SkillsHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
