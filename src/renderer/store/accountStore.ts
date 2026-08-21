import { create } from 'zustand';
import { Account } from '../types';

interface AccountState {
  accounts: Account[];
  pairingCodes: Record<string, string>;
  qrCodes: Record<string, string>;
  loading: boolean;
  error: string | null;
  loadAccounts: () => Promise<void>;
  addAccount: (name?: string) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;
  setAccount: (account: Account) => void;
  patchAccount: (accountId: string, patch: Partial<Account>) => void;
  updateStatus: (accountId: string, status: Account['status']) => void;
  setPairingCode: (accountId: string, code: string) => void;
  setQrCode: (accountId: string, qr: string) => void;
}

export const useAccountStore = create<AccountState>((set, get) => ({
  accounts: [],
  pairingCodes: {},
  qrCodes: {},
  loading: false,
  error: null,

  loadAccounts: async () => {
    set({ loading: true, error: null });
    try {
      if (!window.api) {
        set({ error: 'IPC 未就绪', loading: false });
        return;
      }
      const accounts = (await window.api.accounts.list()) as Account[];
      set({ accounts, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  addAccount: async (name) => {
    const account = (await window.api.accounts.create({ name })) as Account;
    set({ accounts: [account, ...get().accounts] });
  },

  removeAccount: async (accountId) => {
    await window.api.accounts.remove(accountId);
    set({ accounts: get().accounts.filter((a) => a.id !== accountId) });
  },

  setAccount: (account) => {
    set({
      accounts: get().accounts.map((a) => (a.id === account.id ? account : a))
    });
  },

  patchAccount: (accountId, patch) => {
    set({
      accounts: get().accounts.map((a) =>
        a.id === accountId ? { ...a, ...patch } : a
      )
    });
  },

  updateStatus: (accountId, status) => {
    get().patchAccount(accountId, { status });
  },

  setPairingCode: (accountId, code) => {
    set({ pairingCodes: { ...get().pairingCodes, [accountId]: code } });
  },

  setQrCode: (accountId, qr) => {
    set({ qrCodes: { ...get().qrCodes, [accountId]: qr } });
  }
}));