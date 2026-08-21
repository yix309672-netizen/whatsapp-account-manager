export type AccountStatus =
  | 'offline'
  | 'initializing'
  | 'qr_pending'
  | 'authenticated'
  | 'ready'
  | 'online'
  | 'disconnected'
  | 'failed';

export interface Account {
  id: string;
  device_id: string;
  name: string;
  phone: string | null;
  status: AccountStatus;
  login_time: number | null;
  updated_time: number | null;
  session_path: string | null;
  created_at: number;
  has_session?: boolean;
  assigned_to?: string | null;
  remark?: string | null;
  pairingCode?: string;
}

export interface LoginLog {
  id: number;
  account_id: string;
  action: string;
  detail: string | null;
  created_at: number;
}

export interface AccountEvent {
  accountId: string;
  qr?: string;
  code?: string;
  reason?: string;
  message?: string;
}