import { createContext, useContext } from "react";
export const WorkspaceOverlayContext = createContext<HTMLElement | null>(null);
export const useWorkspaceOverlay = () => useContext(WorkspaceOverlayContext);
