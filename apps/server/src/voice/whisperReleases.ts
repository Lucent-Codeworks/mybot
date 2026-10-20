import { VOICE_MODEL_SIZES, type VoiceModelId } from "@mybot/contracts";

/**
 * The whisper.cpp CLI and models that voice input runs. To bump a pin, change
 * the version and build tag, then copy each asset's SHA-256 from the release
 * and each model's SHA-256 from its Hugging Face file page.
 */
export const WHISPER_VERSION = "1.9.5";
const WHISPER_BUILD = "b5454";
const WHISPER_CLI_BASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_BUILD}`;
const WHISPER_MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export interface WhisperCliRelease {
  readonly url: string;
  readonly sha256: string;
  readonly format: "tar.gz" | "zip";
  /** The archive's top directory, which becomes the install. */
  readonly root: string;
  /** Path to the executable inside the install. */
  readonly executable: ReadonlyArray<string>;
  /** Shared libraries sit beside the executable and need LD_LIBRARY_PATH. */
  readonly libraryDir: boolean;
}

export interface WhisperModelRelease {
  readonly model: VoiceModelId;
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly fileName: string;
}

const WHISPER_CLI_RELEASES: Partial<Record<string, WhisperCliRelease>> = {
  "linux-x64": {
    url: `${WHISPER_CLI_BASE_URL}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: "a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c",
    format: "tar.gz",
    root: "whisper-bin-ubuntu-x64",
    executable: ["whisper-cli"],
    libraryDir: true,
  },
  "linux-arm64": {
    url: `${WHISPER_CLI_BASE_URL}/whisper-bin-ubuntu-arm64.tar.gz`,
    sha256: "6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149",
    format: "tar.gz",
    root: "whisper-bin-ubuntu-arm64",
    executable: ["whisper-cli"],
    libraryDir: true,
  },
  "win32-x64": {
    url: `${WHISPER_CLI_BASE_URL}/whisper-bin-x64.zip`,
    sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
    format: "zip",
    root: "Release",
    executable: ["whisper-cli.exe"],
    libraryDir: false,
  },
  "win32-arm64": {
    url: `${WHISPER_CLI_BASE_URL}/whisper-bin-win-cpu-arm64.zip`,
    sha256: "28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d",
    format: "zip",
    root: "Release",
    executable: ["whisper-cli.exe"],
    libraryDir: false,
  },
};

const WHISPER_MODEL_FILES: Record<VoiceModelId, { fileName: string; sha256: string }> = {
  tiny: {
    fileName: "ggml-tiny.bin",
    sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
  },
  base: {
    fileName: "ggml-base.bin",
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  },
  small: {
    fileName: "ggml-small.bin",
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  },
  "large-v3-turbo": {
    fileName: "ggml-large-v3-turbo-q5_0.bin",
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  },
};

/** macOS builds are published later; until then voice input reports unsupported there. */
export const pinnedWhisperCli = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): WhisperCliRelease | null => WHISPER_CLI_RELEASES[`${platform}-${arch}`] ?? null;

export const pinnedWhisperModel = (model: VoiceModelId): WhisperModelRelease => {
  const file = WHISPER_MODEL_FILES[model];
  return {
    model,
    url: `${WHISPER_MODEL_BASE_URL}/${file.fileName}`,
    sha256: file.sha256,
    sizeBytes: VOICE_MODEL_SIZES[model],
    fileName: file.fileName,
  };
};

/**
 * Whole-token markers Whisper emits for silence and non-speech audio, such as
 * `[MUSIC]` or `(laughs),`, with any punctuation Whisper attached to them.
 */
const NON_SPEECH_MARKER = /(^|\s)(\[[^\]\n]*\]|\([^)\n]*\))[.,!?;:]*(?=\s|$)/g;

export const cleanTranscript = (stdout: string): string =>
  stdout.replace(NON_SPEECH_MARKER, " ").split(/\s+/).filter(Boolean).join(" ");

export const whisperArgs = (input: {
  readonly model: string;
  readonly wav: string;
  readonly threads: number;
}): ReadonlyArray<string> => [
  "-m",
  input.model,
  "-f",
  input.wav,
  "-l",
  "auto",
  "-nt",
  "-np",
  "-t",
  String(input.threads),
];
