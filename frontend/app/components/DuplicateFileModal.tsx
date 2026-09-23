'use client';

import React from 'react';
import { FaExclamationTriangle, FaFile, FaEdit, FaTimes } from 'react-icons/fa';

export interface FileConflict {
  file: File;
  targetFolder: string;
  suggestedName: string;
  resolution?: 'rename' | 'cancel';
}

interface DuplicateFileModalProps {
  conflicts: FileConflict[];
  isOpen: boolean;
  onResolve: (resolvedConflicts: FileConflict[]) => void;
  onCancel: () => void;
}

export default function DuplicateFileModal({ 
  conflicts, 
  isOpen, 
  onResolve, 
  onCancel 
}: DuplicateFileModalProps) {
  const [localConflicts, setLocalConflicts] = React.useState<FileConflict[]>(conflicts);

  React.useEffect(() => {
    setLocalConflicts(conflicts);
  }, [conflicts]);

  const updateResolution = (index: number, resolution: 'rename' | 'cancel') => {
    const updated = [...localConflicts];
    updated[index].resolution = resolution;
    setLocalConflicts(updated);
  };

  const handleResolveAll = () => {
    const resolved = localConflicts.map(conflict => ({
      ...conflict,
      resolution: conflict.resolution || 'cancel'
    })) as FileConflict[];
    onResolve(resolved);
  };

  const handleBatchAction = (action: 'rename' | 'cancel') => {
    const updated = localConflicts.map(conflict => ({
      ...conflict,
      resolution: action
    }));
    setLocalConflicts(updated);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl max-h-[80vh] overflow-hidden">
        {}
        <div className="bg-orange-500 text-white p-4 flex items-center gap-3">
          <FaExclamationTriangle size={20} />
          <h2 className="text-lg font-semibold">
            File Name Conflicts Detected
          </h2>
        </div>

        {}
        <div className="p-4 max-h-[60vh] overflow-y-auto">
          <p className="text-gray-600 mb-4">
            {conflicts.length} file(s) have the same name as existing files. 
            Choose how to handle each conflict:
          </p>

          {}
          <div className="bg-gray-50 p-3 rounded-lg mb-4">
            <p className="text-sm font-medium text-gray-700 mb-2">Quick Actions:</p>
            <div className="flex gap-2">
              <button
                onClick={() => handleBatchAction('rename')}
                className="px-3 py-1 bg-blue-100 text-blue-700 rounded text-sm hover:bg-blue-200"
              >
                Rename All
              </button>
              <button
                onClick={() => handleBatchAction('cancel')}
                className="px-3 py-1 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200"
              >
                Skip All
              </button>
            </div>
          </div>

          {}
          <div className="space-y-4">
            {localConflicts.map((conflict, index) => (
              <div key={index} className="border rounded-lg p-4 bg-gray-50">
                <div className="flex items-start gap-3">
                  <FaFile className="text-blue-500 mt-1" />
                  <div className="flex-1">
                    <h3 className="font-medium text-gray-900">{conflict.file.name}</h3>
                    <p className="text-sm text-gray-600">
                      Target folder: <span className="font-medium">{conflict.targetFolder}</span>
                    </p>
                    <p className="text-sm text-gray-600">
                      Suggested rename: <span className="font-medium text-blue-600">{conflict.suggestedName}</span>
                    </p>
                  </div>
                </div>

                {}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => updateResolution(index, 'rename')}
                    className={`px-3 py-2 rounded text-sm flex items-center gap-2 ${
                      conflict.resolution === 'rename'
                        ? 'bg-blue-500 text-white'
                        : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                    }`}
                  >
                    <FaEdit size={12} />
                    Rename to "{conflict.suggestedName}"
                  </button>
                  <button
                    onClick={() => updateResolution(index, 'cancel')}
                    className={`px-3 py-2 rounded text-sm flex items-center gap-2 ${
                      conflict.resolution === 'cancel'
                        ? 'bg-gray-500 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    <FaTimes size={12} />
                    Skip This File
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {}
        <div className="bg-gray-50 p-4 flex justify-between items-center">
          <div className="text-sm text-gray-600">
            {localConflicts.filter(c => c.resolution).length} of {conflicts.length} conflicts resolved
          </div>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-gray-600 hover:text-gray-800"
            >
              Cancel Upload
            </button>
            <button
              onClick={handleResolveAll}
              disabled={localConflicts.some(c => !c.resolution)}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              Proceed with Upload
            </button>
          </div>
        </div>
      </div>
    </div>
  );
} 