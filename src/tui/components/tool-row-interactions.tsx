import { createContext, useContext, type RefObject } from 'react';
import type { DOMElement } from 'ink';

export interface ToolSummaryRowRegistration {
  id: string;
  element: RefObject<DOMElement | null>;
  expandable: boolean;
}

export interface ToolRowInteractionRegistry {
  register: (registration: ToolSummaryRowRegistration) => () => void;
}

export const ToolRowInteractionContext = createContext<ToolRowInteractionRegistry | null>(null);

export function useToolRowInteractionRegistry(): ToolRowInteractionRegistry | null {
  return useContext(ToolRowInteractionContext);
}
