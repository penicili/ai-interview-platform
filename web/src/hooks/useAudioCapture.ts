import { useRef, useState, useCallback } from "react";

interface UseAudioCaptureOptions {
  onFrame: (buffer: ArrayBuffer) => void;
  onError?: (error: Error) => void;
}

export function useAudioCapture({ onFrame, onError }: UseAudioCaptureOptions) {
  const [isCapturing, setIsCapturing] = useState(false);

  // True when the microphone has stopped delivering data ENTIRELY — the track
  // ended, the device changed, or permission was withdrawn. It is not the
  // same as the candidate being quiet: silence still arrives as samples the
  // worklet can measure, so a normal pause never sets this.
  const [micLost, setMicLost] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Mute gate — mic stays hot, we just skip sending frames.
  // Avoids AudioContext.suspend/resume async state issues entirely.
  const mutedRef = useRef(false);
  // Guards every microphone-loss signal: the track listeners, the readyState
  // poll below, and the worklet's port messages. Shutdown flips this false
  // BEFORE the track is stopped, so a late callback cannot tell the candidate
  // "we can't hear you" once the interview has already finished.
  const activeRef = useRef(false);
  // Chromium does not announce a dead track through events alone, so the
  // readyState is polled while capture is live. See the note in start().
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = useCallback(async () => {
    if (isCapturing) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;

      await ctx.audioWorklet.addModule("/audio-worklet-processor.js");

      const workletNode = new AudioWorkletNode(ctx, "pcm-processor");
      workletNode.port.onmessage = (e: MessageEvent) => {
        const data = e.data;

        // PCM frames and control messages share this port, so the shape has
        // to be told apart here — an object reaching onFrame would be pushed
        // to the server as though it were audio.
        if (data instanceof ArrayBuffer) {
          if (!mutedRef.current) onFrame(data);
          return;
        }

        if (data && data.type === "no_input") setMicLost(true);
        else if (data && data.type === "input_restored") setMicLost(false);
      };
      workletNodeRef.current = workletNode;

      const source = ctx.createMediaStreamSource(stream);
      source.connect(workletNode);

      // The worklet only reports an absent input once its threshold passes.
      // A track that announces it is finished or muted should warn at once.
      const track = stream.getAudioTracks()[0];
      if (track) {
        const markLost = () => {
          if (activeRef.current) setMicLost(true);
        };
        const markRestored = () => {
          if (activeRef.current) setMicLost(false);
        };
        track.addEventListener("ended", markLost);
        track.addEventListener("mute", markLost);
        track.addEventListener("unmute", markRestored);

        // Events are not enough on their own, and this is measured rather
        // than assumed. Once a track ends, createMediaStreamSource keeps
        // feeding the worklet SILENCE instead of an empty input — input still
        // looks present — so the worklet's no_input branch never fires, and a
        // stop() this page performed itself raises no 'ended' either. On
        // Chromium 156 nothing warned at all until readyState was read
        // directly, and that read was 'ended' in every observed case.
        //
        // 'ended' is terminal: it can be set but never cleared, so this can
        // only ever warn. It also cannot false-positive on a quiet candidate,
        // which is the whole reason the threshold above exists.
        if (watchdogRef.current) clearInterval(watchdogRef.current);
        watchdogRef.current = setInterval(() => {
          if (activeRef.current && track.readyState === "ended") setMicLost(true);
        }, 1000);
      }

      activeRef.current = true;
      setMicLost(false);
      setIsCapturing(true);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[AudioCapture] Failed to start:", error.message);
      onError?.(error);
    }
  }, [isCapturing, onFrame, onError]);

  const mute = useCallback(() => {
    mutedRef.current = true;
  }, []);

  const unmute = useCallback(() => {
    mutedRef.current = false;
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mutedRef.current = false;
    setMicLost(false);
    setIsCapturing(false);
  }, []);

  return { start, stop, mute, unmute, isCapturing, micLost };
}
