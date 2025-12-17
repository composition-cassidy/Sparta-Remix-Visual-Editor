/// <reference types="vite/client" />

export type TrimmerOpenParams = {
  videoPath: string;
  videoName: string;
  videoDuration: number;
  videoFps: number;
  currentIn: number;
  currentOut: number;
  layerId: string;
};

export type TrimmerResult = {
  layerId: string;
  inPoint: number;
  outPoint: number;
  cancelled: boolean;
};

declare global {
  interface Window {
    srve?: {
      versions: Record<string, string>;
      getBackendStatus?: () => Promise<{
        running: boolean;
        spawned: boolean;
        pid: number | null;
        lastHealth: { status: string; ffmpeg: boolean } | null;
        lastError: string | null;
      }>;
      openVideoDialog?: () => Promise<string[]>;
      openMidiDialog?: () => Promise<string[]>;
      openAudioDialog?: () => Promise<string[]>;
      openTrimmer?: (params: TrimmerOpenParams) => Promise<void>;
      closeTrimmer?: (result: TrimmerResult) => Promise<void>;
      onTrimmerResult?: (callback: (result: TrimmerResult) => void) => () => void;
    };
  }
}

export {};
