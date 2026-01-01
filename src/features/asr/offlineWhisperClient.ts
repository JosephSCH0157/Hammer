export type OfflineWhisperPhase =
  | "loading"
  | "downloading"
  | "decoding"
  | "transcribing"
  | "finalizing"
  | "done"
  | "error";

export type OfflineWhisperStatus = {
  phase: OfflineWhisperPhase;
  progress?: number;
  message?: string;
  cached?: boolean;
  device?: "webgpu" | "wasm";
};

export type OfflineWhisperSegment = {
  start: number;
  end: number;
  text: string;
};

export type OfflineWhisperResult = {
  segments: OfflineWhisperSegment[];
  cached: boolean;
  device: "webgpu" | "wasm";
};

type WorkerStatusMessage = {
  type: "status";
  requestId: string;
  phase: OfflineWhisperPhase;
  progress?: number;
  message?: string;
  cached?: boolean;
  device?: "webgpu" | "wasm";
};

type WorkerResultMessage = {
  type: "result";
  requestId: string;
  segments: OfflineWhisperSegment[];
  cached?: boolean;
  device?: "webgpu" | "wasm";
};

type WorkerMessage = WorkerStatusMessage | WorkerResultMessage;

type TranscribeOptions = {
  model: string;
};

export type OfflineWhisperClient = {
  transcribe: (
    audio: Float32Array,
    sampleRate: number,
    options: TranscribeOptions,
    onStatus?: (status: OfflineWhisperStatus) => void,
  ) => Promise<OfflineWhisperResult>;
  terminate: () => void;
};

const createWorker = (): Worker =>
  new Worker(new URL("./offlineWhisper.worker.ts", import.meta.url), {
    type: "module",
  });

const createId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
};

export const createOfflineWhisperClient = (): OfflineWhisperClient => {
  let worker: Worker | null = createWorker();
  let activeRequest: string | null = null;

  const terminate = () => {
    if (worker) {
      worker.terminate();
    }
    worker = null;
    activeRequest = null;
  };

  const transcribe: OfflineWhisperClient["transcribe"] = (
    audio,
    sampleRate,
    options,
    onStatus,
  ) => {
    if (activeRequest) {
      return Promise.reject(new Error("Transcription already running."));
    }
    if (!worker) {
      worker = createWorker();
    }
    const requestId = createId();
    activeRequest = requestId;

    return new Promise((resolve, reject) => {
      if (!worker) {
        activeRequest = null;
        reject(new Error("Offline transcription worker unavailable."));
        return;
      }
      const handleMessage = (event: MessageEvent<WorkerMessage>) => {
        const data = event.data;
        if (!data || data.requestId !== requestId) {
          return;
        }
        if (data.type === "status") {
          const status: OfflineWhisperStatus = { phase: data.phase };
          if (typeof data.progress === "number") {
            status.progress = data.progress;
          }
          if (typeof data.message === "string") {
            status.message = data.message;
          }
          if (typeof data.cached === "boolean") {
            status.cached = data.cached;
          }
          if (data.device) {
            status.device = data.device;
          }
          onStatus?.(status);
          if (data.phase === "error") {
            cleanup();
            reject(new Error(data.message ?? "Offline transcription failed."));
          }
          return;
        }
        if (data.type === "result") {
          const cached = data.cached ?? false;
          const device = data.device ?? "wasm";
          cleanup();
          resolve({ segments: data.segments, cached, device });
        }
      };
      const handleError = (event: ErrorEvent) => {
        cleanup();
        reject(new Error(event.message || "Offline transcription failed."));
      };
      const cleanup = () => {
        if (!worker) {
          activeRequest = null;
          return;
        }
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
        activeRequest = null;
      };

      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", handleError);

      worker.postMessage(
        {
          type: "transcribe",
          requestId,
          audio: audio.buffer,
          sampleRate,
          model: options.model,
        },
        [audio.buffer],
      );
    });
  };

  return { transcribe, terminate };
};
