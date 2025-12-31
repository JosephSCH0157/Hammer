export type MediaMetadata = {
  durationMs: number;
  width: number;
  height: number;
  fps?: number;
};

const waitForMetadata = (video: HTMLVideoElement): Promise<void> =>
  new Promise((resolve, reject) => {
    const handleLoaded = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Unable to load video metadata."));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
    };
    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("error", handleError);
  });

export const getMediaMetadata = async (file: File): Promise<MediaMetadata> => {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.src = url;
  video.load();

  try {
    await waitForMetadata(video);
    const durationMs = Math.round(video.duration * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error("Invalid duration metadata.");
    }
    if (video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw new Error("Invalid dimension metadata.");
    }
    return {
      durationMs,
      width: video.videoWidth,
      height: video.videoHeight,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
};
