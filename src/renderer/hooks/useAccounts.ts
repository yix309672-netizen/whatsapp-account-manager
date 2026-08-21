import { useEffect } from 'react';
import { useAccountStore } from '../store/accountStore';
import { AccountEvent } from '../types';

export function useAccounts(): ReturnType<typeof useAccountStore.getState> {
  const store = useAccountStore();

  useEffect(() => {
    store.loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return store;
}

export function useAccountEvents(): void {
  useEffect(() => {
    const channels: Array<[string, (data: AccountEvent) => void]> = [
      ['account:qr', (data) => {
        useAccountStore.getState().patchAccount(data.accountId, { status: 'qr_pending' });
        if (data.qr) useAccountStore.getState().setQrCode(data.accountId, data.qr);
      }],
      ['account:pairing_code', (data) => {
        useAccountStore.getState().patchAccount(data.accountId, { status: 'qr_pending' });
        if (data.code) useAccountStore.getState().setPairingCode(data.accountId, data.code);
      }],
      ['account:authenticated', (data) => useAccountStore.getState().patchAccount(data.accountId, { status: 'authenticated' })],
      ['account:ready', (data) => {
        useAccountStore.getState().patchAccount(data.accountId, { status: 'online' });
        useAccountStore.getState().loadAccounts();
      }],
      ['account:disconnected', (data) => useAccountStore.getState().patchAccount(data.accountId, { status: 'offline' })],
      ['account:auth_failure', (data) => useAccountStore.getState().patchAccount(data.accountId, { status: 'failed' })]
    ];

    const cleanups = channels.map(([channel, handler]) => window.api.on(channel, handler));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);
}