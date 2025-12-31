export type PcmData = {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
};

const downmixToMono = (buffer: AudioBuffer): Float32Array => {
  if (buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0).slice();
  }
  const length = buffer.length;
  const output = new Float32Array(length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      output[i] += data[i] ?? 0;
    }
  }
  const scale = 1 / buffer.numberOfChannels;
  for (let i = 0; i < length; i += 1) {
    output[i] *= scale;
  }
  return output;
};

const resampleLinear = (
  input: Float32Array,
  inputRate: number,
  targetRate: number
): Float32Array => {
  if (inputRate === targetRate) {
    return input.slice();
  }
  const ratio = inputRate / targetRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const nextIndex = Math.min(index + 1, input.length - 1);
    const frac = position - index;
    const sampleA = input[index] ?? 0;
    const sampleB = input[nextIndex] ?? 0;
    output[i] = sampleA + (sampleB - sampleA) * frac;
  }
  return output;
};

export const decodeMediaToPcm = async (
  blob: Blob,
  targetSampleRate = 16_000
): Promise<PcmData> => {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  } finally {
    if (audioContext.state !== "closed") {
      await audioContext.close();
    }
  }
  const mono = downmixToMono(audioBuffer);
  const sampleRate =
    typeof targetSampleRate === "number" && targetSampleRate > 0
      ? targetSampleRate
      : audioBuffer.sampleRate;
  const samples =
    audioBuffer.sampleRate === sampleRate
      ? mono
      : resampleLinear(mono, audioBuffer.sampleRate, sampleRate);
  return {
    samples,
    sampleRate,
    durationMs: Math.round(audioBuffer.duration * 1000),
  };
};
