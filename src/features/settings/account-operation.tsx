import { createContext, useContext } from 'react';

/** Inline connections share the account picker lock; standalone screens keep their own locks. */
export type AccountOperation = { busy: boolean; acquire(): boolean; release(): void };
export const AccountOperationContext = createContext<AccountOperation | null>(null);
export const useAccountOperation = () => useContext(AccountOperationContext);
