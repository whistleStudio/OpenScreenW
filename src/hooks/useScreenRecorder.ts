import { useState, useRef, useEffect } from "react";
import { fixWebmDuration } from "@fix-webm-duration/fix";

type UseScreenRecorderReturn = {
  recording: boolean;
  toggleRecording: () => void;
  audioChoice: AudioChoice;
  setAudioChoice: (c: AudioChoice) => void;
};

export type AudioChoice = "none" | "microphone" | "system" | "both";

export function useScreenRecorder(initialOptions?: { audio?: AudioChoice }): UseScreenRecorderReturn {
  const [recording, setRecording] = useState(false);
  const [audioChoice, setAudioChoice] = useState<AudioChoice>(initialOptions?.audio ?? "none");

  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null); // final stream passed to MediaRecorder (video + mixed audio)
  const desktopStream = useRef<MediaStream | null>(null); // original desktop stream (may contain system audio)
  const micStream = useRef<MediaStream | null>(null); // microphone stream (if requested)
  const chunks = useRef<Blob[]>([]);
  const startTime = useRef<number>(0);

  // for mixing system + mic audio
  const audioContextRef = useRef<AudioContext | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const systemSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // Target visually lossless 4K @ 60fps; fall back gracefully when hardware cannot keep up
  const TARGET_FRAME_RATE = 60;
  const TARGET_WIDTH = 3840;
  const TARGET_HEIGHT = 2160;
  const FOUR_K_PIXELS = TARGET_WIDTH * TARGET_HEIGHT;
  const selectMimeType = () => {
    const preferred = [
      "video/webm;codecs=av1,opus",
      "video/webm;codecs=h264,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ];

    return preferred.find(type => MediaRecorder.isTypeSupported(type)) ?? "video/webm";
  };

  const computeBitrate = (width: number, height: number) => {
    const pixels = width * height;
    const highFrameRateBoost = TARGET_FRAME_RATE >= 60 ? 1.7 : 1;

    if (pixels >= FOUR_K_PIXELS) {
      return Math.round(45_000_000 * highFrameRateBoost);
    }

    if (pixels >= 2560 * 1440) {
      return Math.round(28_000_000 * highFrameRateBoost);
    }

    return Math.round(18_000_000 * highFrameRateBoost);
  };

  const cleanupAudioMixing = async () => {
    try {
      if (systemSourceRef.current) {
        try { systemSourceRef.current.disconnect(); } catch {}
        systemSourceRef.current = null;
      }
      if (micSourceRef.current) {
        try { micSourceRef.current.disconnect(); } catch {}
        micSourceRef.current = null;
      }
      if (destinationRef.current) {
        // no disconnect API for destination; let it be GC'd after closing context
        destinationRef.current = null;
      }
      if (audioContextRef.current) {
        try {
          await audioContextRef.current.close();
        } catch {}
        audioContextRef.current = null;
      }
    } catch (e) {
      console.warn("Error cleaning audio mixing resources", e);
    }
  };

  const stopAllStreams = () => {
    if (mediaRecorder.current?.state === "recording") {
      try {
        mediaRecorder.current.stop();
      } catch {}
    }

    if (stream.current) {
      stream.current.getTracks().forEach(track => {
        try { track.stop(); } catch {}
      });
      stream.current = null;
    }

    if (desktopStream.current) {
      desktopStream.current.getTracks().forEach(track => {
        try { track.stop(); } catch {}
      });
      desktopStream.current = null;
    }

    if (micStream.current) {
      micStream.current.getTracks().forEach(track => {
        try { track.stop(); } catch {}
      });
      micStream.current = null;
    }
  };

  const stopRecording = useRef(() => {
    if (mediaRecorder.current?.state === "recording") {
      if (stream.current) {
        stream.current.getTracks().forEach(track => track.stop());
      }
      mediaRecorder.current.stop();
      setRecording(false);

      window.electronAPI?.setRecordingState(false);
    }
    // cleanup mixing context
    cleanupAudioMixing();
  });

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    if (window.electronAPI?.onStopRecordingFromTray) {
      cleanup = window.electronAPI.onStopRecordingFromTray(() => {
        stopRecording.current();
      });
    }

    return () => {
      if (cleanup) cleanup();

      if (mediaRecorder.current?.state === "recording") {
        mediaRecorder.current.stop();
      }
      stopAllStreams();
      cleanupAudioMixing();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRecording = async () => {
    try {
      const selectedSource = await window.electronAPI.getSelectedSource();
      if (!selectedSource) {
        alert("Please select a source to record");
        return;
      }

      // Build desktop constraints (video always requested for screen capture)
      const desktopVideoConstraints = {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: selectedSource.id,
          maxWidth: TARGET_WIDTH,
          maxHeight: TARGET_HEIGHT,
          maxFrameRate: TARGET_FRAME_RATE,
          minFrameRate: 30,
        },
      };

      // We'll first try to get a desktop stream. If audioChoice requests system audio,
      // include the desktop audio constraint here. For microphone or both, we'll request
      // microphone separately and optionally mix.
      const requestSystemAudio = audioChoice === "system" || audioChoice === "both";
      const requestMicrophone = audioChoice === "microphone" || audioChoice === "both";

      // Request desktop (video + maybe system audio)
      const desktopConstraints: any = {
        audio: requestSystemAudio
          ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: selectedSource.id } }
          : false,
        video: { mandatory: desktopVideoConstraints.mandatory },
      };

      // Note: casting to any because TypeScript DOM lib doesn't declare chromeMediaSource.
      const obtainedDesktopStream = await (navigator.mediaDevices as any).getUserMedia(desktopConstraints);
      desktopStream.current = obtainedDesktopStream;
      if (!desktopStream.current) {
        throw new Error("Desktop media stream is not available.");
      }

      // If microphone requested, request mic stream separately
      if (requestMicrophone) {
        console.log("Requesting microphone access...");
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          micStream.current = mic;
        } catch (micErr) {
          console.warn("Microphone access denied or unavailable:", micErr);
          // continue — we may still have system audio
          micStream.current = null;
        }
      }

      const videoTrack = desktopStream.current.getVideoTracks()[0];
      try {
        await videoTrack.applyConstraints({
          frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
          width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
          height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
        });
      } catch (error) {
        console.warn("Unable to lock 4K/60fps constraints, using best available track settings.", error);
      }

      // At this point we may have:
      // - desktopStream (with video, maybe system audio)
      // - micStream (maybe)
      // We need to produce a single MediaStream (stream.current) that contains video + (mixed) audio
      // Some platforms / Electron versions will not provide system audio automatically. If not present, fallback gracefully.

      // Compose final stream
      const finalStream = new MediaStream();
      // Video track
      const vidTrack = desktopStream.current.getVideoTracks()[0];
      finalStream.addTrack(vidTrack);

      const systemAudioTracks = desktopStream.current.getAudioTracks(); // may be empty
      const hasSystemAudio = systemAudioTracks && systemAudioTracks.length > 0;
      const hasMic = !!(micStream.current && micStream.current.getAudioTracks().length > 0);

      if (hasSystemAudio && hasMic) {
        // Mix system audio + mic into a single audio track using Web Audio API
        try {
          const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          audioContextRef.current = audioCtx;
          const destination = audioCtx.createMediaStreamDestination();
          destinationRef.current = destination;

          // create sources
          const systemSource = audioCtx.createMediaStreamSource(new MediaStream(systemAudioTracks));
          systemSourceRef.current = systemSource;
          const micSource = audioCtx.createMediaStreamSource(micStream.current!);
          micSourceRef.current = micSource;

          // Optional: add gain nodes to control relative volumes
          const sysGain = audioCtx.createGain();
          sysGain.gain.value = 1.0;
          const micGain = audioCtx.createGain();
          micGain.gain.value = 1.0;

          systemSource.connect(sysGain).connect(destination);
          micSource.connect(micGain).connect(destination);

          const mixedTrack = destination.stream.getAudioTracks()[0];
          if (mixedTrack) finalStream.addTrack(mixedTrack);
        } catch (mixErr) {
          console.warn("Audio mixing failed, falling back to adding available audio tracks:", mixErr);
          // Fallback: add both tracks (some players/recorder may only record one track; behavior varies)
          systemAudioTracks.forEach(t => finalStream.addTrack(t));
          micStream.current!.getAudioTracks().forEach(t => finalStream.addTrack(t));
        }
      } else if (hasSystemAudio) {
        // just add system audio tracks
        systemAudioTracks.forEach(t => finalStream.addTrack(t));
      } else if (hasMic) {
        micStream.current!.getAudioTracks().forEach(t => finalStream.addTrack(t));
      } else {
        // no audio requested/available -> nothing to add
      }

      // Save final stream reference so stop handler can clean it
      stream.current = finalStream;

      // compute settings from the video track
      let { width = 1920, height = 1080, frameRate = TARGET_FRAME_RATE } = videoTrack.getSettings();

      // Ensure dimensions are divisible by 2 for VP9/AV1 codec compatibility
      width = Math.floor(width / 2) * 2;
      height = Math.floor(height / 2) * 2;

      const videoBitsPerSecond = computeBitrate(width, height);
      const mimeType = selectMimeType();

      console.log(
        `Recording at ${width}x${height} @ ${frameRate ?? TARGET_FRAME_RATE}fps using ${mimeType} / ${Math.round(
          videoBitsPerSecond / 1_000_000
        )} Mbps audioChoice=${audioChoice}`
      );

      chunks.current = [];
      const recorderOptions: any = {
        mimeType,
        videoBitsPerSecond,
      };
      // optionally set audioBitsPerSecond
      recorderOptions.audioBitsPerSecond = 128_000;

      const recorder = new MediaRecorder(stream.current, recorderOptions);
      mediaRecorder.current = recorder;
      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) chunks.current.push(e.data);
      };
      recorder.onstop = async () => {
        // stop and cleanup streams & audio nodes
        if (desktopStream.current) {
          desktopStream.current.getTracks().forEach(track => track.stop());
          desktopStream.current = null;
        }
        if (micStream.current) {
          micStream.current.getTracks().forEach(track => track.stop());
          micStream.current = null;
        }
        await cleanupAudioMixing();

        if (chunks.current.length === 0) return;
        const duration = Date.now() - startTime.current;
        const recordedChunks = chunks.current;
        const buggyBlob = new Blob(recordedChunks, { type: mimeType });
        // Clear chunks early to free memory immediately after blob creation
        chunks.current = [];
        const timestamp = Date.now();
        const videoFileName = `recording-${timestamp}.webm`;

        try {
          const videoBlob = await fixWebmDuration(buggyBlob, duration);
          const arrayBuffer = await videoBlob.arrayBuffer();
          const videoResult = await window.electronAPI.storeRecordedVideo(arrayBuffer, videoFileName);
          if (!videoResult.success) {
            console.error("Failed to store video:", videoResult.message);
            return;
          }

          if (videoResult.path) {
            await window.electronAPI.setCurrentVideoPath(videoResult.path);
          }

          await window.electronAPI.switchToEditor();
        } catch (error) {
          console.error("Error saving recording:", error);
        }
      };
      recorder.onerror = () => setRecording(false);
      recorder.start(1000);
      startTime.current = Date.now();
      setRecording(true);
      window.electronAPI?.setRecordingState(true);
    } catch (error) {
      console.error("Failed to start recording:", error);
      setRecording(false);
      if (desktopStream.current) {
        desktopStream.current.getTracks().forEach(track => track.stop());
        desktopStream.current = null;
      }
      if (micStream.current) {
        micStream.current.getTracks().forEach(track => track.stop());
        micStream.current = null;
      }
      await cleanupAudioMixing();
    }
  };

  const toggleRecording = () => {
    recording ? stopRecording.current() : startRecording();
  };

  return { recording, toggleRecording, audioChoice, setAudioChoice };
}