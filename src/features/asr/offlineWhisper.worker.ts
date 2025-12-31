import { pipeline } from "@huggingface/transformers";

type WorkerRequest = {
  type: "transcribe";
  requestId: string;
  audio: ArrayBuffer;
  sampleRate: number;
  model: string;
};

type WorkerStatusPhase = "loading-model" | "transcribing" | "done" | "error";

type WorkerStatusMessage = {
  type: "status";
  requestId: string;
  phase: WorkerStatusPhase;
  progress?: number;
  message?: string;
  cached?: boolean;
  device?: "webgpu" | "wasm";
};

type WorkerSegment = { start: number; end: number; text: string };

type WorkerResultMessage = {
  type: "result";
  requestId: string;
  segments: WorkerSegment[];
  cached?: boolean;
  device?: "webgpu" | "wasm";
};

type WorkerMessage = WorkerRequest;

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

let pipelinePromise: Promise<any> | null = null;
let pipelineModel: string | null = null;
let lastCached = false;
let lastDevice: "webgpu" | "wasm" = "wasm";

const resolveDevice = (): "webgpu" | "wasm" => {
  const nav = ctx.navigator as Navigator | undefined;
  if (nav && "gpu" in nav) {
    return "webgpu";
  }
  return "wasm";
};

const extractSegments = (result: any): WorkerSegment[] => {
  const chunks = Array.isArray(result?.chunks)
    ? result.chunks
    : Array.isArray(result?.segments)
      ? result.segments
      : [];
  if (!Array.isArray(chunks) || chunks.length === 0) {
    if (typeof result?.text === "string" && result.text.trim().length > 0) {
      return [{ start: 0, end: 0, text: result.text.trim() }];
    }
    return [];
  }
  const segments: WorkerSegment[] = [];
  chunks.forEach((chunk: any) => {
    if (!chunk || typeof chunk !== "object") {
      return;
    }
    const text = typeof chunk.text === "string" ? chunk.text.trim() : "";
    if (!text) {
      return;
    }
    let start = 0;
    let end = 0;
    if (Array.isArray(chunk.timestamp) && chunk.timestamp.length >= 2) {
      const startValue = chunk.timestamp[0];
      const endValue = chunk.timestamp[1];
      if (typeof startValue === "number") {
        start = startValue;
      }
      if (typeof endValue === "number") {
        end = endValue;
      }
    } else if (typeof chunk.start === "number" && typeof chunk.end === "number") {
      start = chunk.start;
      end = chunk.end;
    }
    segments.push({ start, end: Math.max(end, start), text });
  });
  return segments;
};

const getPipeline = async (
  model: string,
  requestId: string
): Promise<{ pipe: any; cached: boolean; device: "webgpu" | "wasm" }> => {
  if (pipelinePromise && pipelineModel === model) {
    return { pipe: await pipelinePromise, cached: lastCached, device: lastDevice };
  }
  const device = resolveDevice();
  lastDevice = device;
  let sawDownload = false;
  pipelineModel = model;
  pipelinePromise = pipeline("automatic-speech-recognition", model, {
    device,
    progress_callback: (progress: any) => {
      sawDownload = true;
      let ratio: number | null = null;
      if (typeof progress?.progress === "number") {
        ratio = progress.progress;
      } else if (
        typeof progress?.loaded === "number" &&
        typeof progress?.total === "number" &&
        progress.total > 0
      ) {
        ratio = progress.loaded / progress.total;
      }
      const status: WorkerStatusMessage = {
        type: "status",
        requestId,
        phase: "loading-model",
        device,
      };
      if (ratio !== null) {
        status.progress = Math.min(Math.max(ratio, 0), 1);
      }
      ctx.postMessage(status);
    },
  } as Record<string, unknown>);
  try {
    const pipe = await pipelinePromise;
    lastCached = !sawDownload;
    return { pipe, cached: lastCached, device };
  } catch (error) {
    pipelinePromise = null;
    pipelineModel = null;
    throw error;
  }
};

ctx.addEventListener("message", async (event: MessageEvent<WorkerMessage>) => {
  const data = event.data;
  if (!data || data.type !== "transcribe") {
    return;
  }
  const { requestId, audio, sampleRate, model } = data;
  const beginStatus: WorkerStatusMessage = {
    type: "status",
    requestId,
    phase: "loading-model",
    progress: 0,
    device: resolveDevice(),
  };
  ctx.postMessage(beginStatus);
  try {
    const { pipe, cached, device } = await getPipeline(model, requestId);
    const readyStatus: WorkerStatusMessage = {
      type: "status",
      requestId,
      phase: "loading-model",
      cached,
      device,
    };
    ctx.postMessage(readyStatus);
    const transcribeStatus: WorkerStatusMessage = {
      type: "status",
      requestId,
      phase: "transcribing",
      cached,
      device,
    };
    ctx.postMessage(transcribeStatus);
    const audioData = new Float32Array(audio);
    const result = await pipe(audioData, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: "segment",
      sampling_rate: sampleRate,
    });
    const segments = extractSegments(result);
    const message: WorkerResultMessage = {
      type: "result",
      requestId,
      segments,
      cached,
      device,
    };
    ctx.postMessage(message);
    const doneStatus: WorkerStatusMessage = {
      type: "status",
      requestId,
      phase: "done",
      cached,
      device,
    };
    ctx.postMessage(doneStatus);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Offline transcription failed.";
    const status: WorkerStatusMessage = {
      type: "status",
      requestId,
      phase: "error",
      message: errorMessage,
    };
    ctx.postMessage(status);
  }
});
