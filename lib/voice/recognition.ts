/**
 * Thin wrapper around the browser-native Web Speech API
 * (SpeechRecognition). Exposes a single `startVoiceRecognition` function
 * that returns a controller with `.stop()`. The hook into the global
 * `window.SpeechRecognition` (or webkit-prefixed equivalent) lives here
 * so React components don't have to touch globals directly and so feature
 * detection is testable.
 *
 * Browser support (April 2026): Chrome/Edge/Safari yes, Firefox no.
 * Use `isVoiceSupported()` to feature-detect before showing the mic UI.
 *
 * No external API call: speech recognition runs on-device (Chrome/Edge
 * may proxy through Google for higher accuracy; Safari is on-device).
 * Either way, the user experience is a few hundred ms of latency between
 * speech and transcript — fine for live brief dictation.
 */

export type VoiceTranscriptResult = {
  /** Final transcript fragments (committed by the recognizer). Append-only. */
  final: string;
  /** Interim transcript (not yet final, may change). Replaces on every event. */
  interim: string;
};

export type VoiceController = {
  /** Stop listening. Idempotent. */
  stop: () => void;
};

export type VoiceCallbacks = {
  onTranscript: (result: VoiceTranscriptResult) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
};

type SpeechRecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

/** Resolve the browser-prefixed constructor, or null if unsupported. */
function getRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isVoiceSupported(): boolean {
  return getRecognitionCtor() !== null;
}

/**
 * Start a recognition session. Returns a controller with `.stop()`. The
 * recognizer streams interim results until `stop()` is called or the
 * browser's silence-timeout fires (typically ~5s on Chrome).
 */
export function startVoiceRecognition(callbacks: VoiceCallbacks): VoiceController {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    callbacks.onError?.("Voice input isn't supported in this browser. Try Chrome, Edge, or Safari.");
    return { stop: () => {} };
  }

  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  let finalAccumulator = "";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0]?.transcript ?? "";
      if (result.isFinal) {
        // Make sure each finalized chunk is followed by a space so words
        // from separate utterances don't slam together.
        finalAccumulator += transcript.endsWith(" ") ? transcript : transcript + " ";
      } else {
        interim += transcript;
      }
    }
    callbacks.onTranscript({ final: finalAccumulator, interim });
  };

  recognition.onerror = (event) => {
    const code = event.error ?? "unknown";
    const friendly =
      code === "not-allowed" || code === "service-not-allowed"
        ? "Microphone permission was blocked. Allow it from your browser address bar."
        : code === "no-speech"
          ? "Didn't catch anything. Try speaking up or moving closer to the mic."
          : `Voice input error: ${code}.`;
    callbacks.onError?.(friendly);
  };

  recognition.onend = () => {
    callbacks.onEnd?.();
  };

  try {
    recognition.start();
  } catch (error) {
    // Most likely cause: already running. Silent — the controller's
    // stop() will still work and onend will fire normally.
    callbacks.onError?.(error instanceof Error ? error.message : "Couldn't start the mic.");
  }

  return {
    stop: () => {
      try {
        recognition.stop();
      } catch {
        // Already stopped — safe to ignore.
      }
    }
  };
}
