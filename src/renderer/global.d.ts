import type {
  AppSettings,
  CredentialStatus,
  DbLocationInfo,
  GameRow,
  SteamGuardRequest,
  SyncProgress,
  SyncResult,
  UpdateCheckResult,
} from '../shared/types';

export type ApiKeyName = 'steamWebApiKey' | 'itadApiKey';
export type LinkName = 'steamKey' | 'itadKey' | 'steamPrivacy' | 'store';

export interface PlaytimeRoiBridge {
  games: {
    list: () => Promise<GameRow[]>;
    setManualPrice: (appId: number, cents: number | null, currency: string) => Promise<{ success: true }>;
  };
  sync: {
    run: () => Promise<SyncResult>;
    lastSyncedAt: () => Promise<number | null>;
    onProgress: (listener: (p: SyncProgress) => void) => () => void;
  };
  steam: {
    signIn: (accountName: string, password: string) => Promise<SyncResult>;
    signOut: () => Promise<{ success: true }>;
    onGuard: (listener: (r: SteamGuardRequest) => void) => () => void;
    sendGuardCode: (code: string) => Promise<{ success: boolean }>;
    cancelGuard: () => Promise<{ success: true }>;
  };
  credentials: {
    status: () => Promise<CredentialStatus>;
    setKey: (name: ApiKeyName, value: string) => Promise<{ success: true }>;
    removeKey: (name: ApiKeyName) => Promise<{ success: true }>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    setCountry: (country: string) => Promise<{ success: true }>;
  };
  dbLocation: {
    get: () => Promise<DbLocationInfo>;
    browseExisting: () => Promise<string | null>;
    browseNew: () => Promise<string | null>;
    set: (newPath: string) => Promise<{ success: true }>;
    resetToDefault: () => Promise<{ success: true }>;
  };
  app: {
    getVersion: () => Promise<string>;
    openLink: (which: LinkName, appId?: number) => Promise<{ success: boolean }>;
  };
  updates: {
    check: () => Promise<UpdateCheckResult>;
  };
}

declare global {
  interface Window {
    playtimeRoi: PlaytimeRoiBridge;
  }
}
