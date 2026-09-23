'use client';

import { ReactNode } from "react";

export { useCollectionContext } from './CompatibilityHooks';

export interface Extract {
  fileId: string;
  fileName: string;
  pageNumber: string;
  content: string;
  PDFName: string;
  collection?: number;
}

export interface CollectionContextProps {
  collections: Extract[][];
  setCollections: (value: Extract[][]) => void;
}

export function CollectionContextProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}