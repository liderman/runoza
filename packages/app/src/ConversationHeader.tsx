import { createContext } from "react";
// Portal destination keeps conversation actions in the native title bar without duplicating state.
export const ConversationHeader = createContext<HTMLElement | null>(null);
