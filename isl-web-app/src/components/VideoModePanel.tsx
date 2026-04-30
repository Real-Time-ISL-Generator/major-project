import {useEffect, useMemo, useRef, useState} from 'react';
import {buildBackendWsUrl} from '../lib/backend';
import type {PlaybackState, TranscriptState} from '../lib/playback';

type PermissionStateValue = 'prompt' | 'granted' | 'denied' | 'unsupported';

export type VideoModeSessionPhase =
  | 'idle'
  | 'testing'
  | 'connecting'
  | 'listening'
  | 'processing'
  | 'signing'
  | 'unsupported'
  | 'error';

type MediaDeviceOption = {
  deviceId: string;
  label: string;
};

export type LiveTranscriptEvent = {
  confidence: number | null;
  createdAtMs: number;
  id: string;
  speechEndMs: number | null;
  speechStartMs: number | null;
  text: string;
  transcriptState: TranscriptState;
};

type ServerEvent =
  | {
      type: 'session_started';
      session_id: string;
      mode: 'browser_fallback';
      requires_client_transcripts: boolean;
    }
  | {
      type: 'transcript_interim' | 'transcript_final';
      session_id: string;
      sequence_id: number;
      text: string;
      confidence: number | null;
      created_at_ms: number;
      speech_start_ms: number | null;
      speech_end_ms: number | null;
    }
  | {
      type: 'vad_state';
      state: 'listening' | 'speaking' | 'processing';
    }
  | {
      type: 'error';
      detail: string;
    }
  | {
      type: 'session_ended';
      session_id: string;
    };

type Props = {
  isLagging: boolean;
  latestSignedText: string;
  nextPhraseText: string | null;
  playbackState: PlaybackState;
  queuedPhraseCount: number;
  onSessionActiveChange: (active: boolean) => void;
  onSessionPhaseChange: (phase: VideoModeSessionPhase) => void;
  onSessionReset: () => void;
  onTranscriptEvent: (event: LiveTranscriptEvent) => void;
};

type BrowserSpeechRecognitionResult = {
  confidence?: number;
  transcript: string;
};

type BrowserSpeechRecognitionResultList = {
  [index: number]: {
    isFinal: boolean;
    length: number;
    [resultIndex: number]: BrowserSpeechRecognitionResult;
  };
  length: number;
};

type BrowserSpeechRecognitionEvent = Event & {
  resultIndex: number;
  results: BrowserSpeechRecognitionResultList;
};

type BrowserSpeechRecognitionInstance = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: ((event: Event) => void) | null;
  onerror: ((event: Event & {error?: string}) => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onspeechend: ((event: Event) => void) | null;
  onspeechstart: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognitionInstance;

type WindowWithSpeechRecognition = Window & {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
};

const AUDIO_CHUNK_MS = 400;

function getSpeechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const candidateWindow = window as WindowWithSpeechRecognition;
  return candidateWindow.SpeechRecognition ?? candidateWindow.webkitSpeechRecognition ?? null;
}

function isPermissionDeniedError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
}

function isCameraUnavailableError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'OverconstrainedError');
}

function buildDeviceLabel(device: MediaDeviceInfo, fallback: string) {
  return device.label.trim() || fallback;
}

function normalizeTranscriptText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function SessionIcon({children}: {children: React.ReactNode}) {
  return <span className="live-overlay-glyph" aria-hidden="true">{children}</span>;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function VideoModePanel({
  isLagging,
  latestSignedText,
  nextPhraseText,
  playbackState,
  queuedPhraseCount,
  onSessionActiveChange,
  onSessionPhaseChange,
  onSessionReset,
  onTranscriptEvent,
}: Props) {
  const [audioDevices, setAudioDevices] = useState<MediaDeviceOption[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceOption[]>([]);
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState('');
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState('');
  const [cameraPermission, setCameraPermission] = useState<PermissionStateValue>('prompt');
  const [microphonePermission, setMicrophonePermission] = useState<PermissionStateValue>('prompt');
  const [sessionPhase, setSessionPhase] = useState<VideoModeSessionPhase>('idle');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [cameraPaused, setCameraPaused] = useState(false);
  const [microphoneMuted, setMicrophoneMuted] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [latestFinalizedTranscript, setLatestFinalizedTranscript] = useState('');
  const [sessionElapsedSeconds, setSessionElapsedSeconds] = useState(0);
  const [supportsVideoMode, setSupportsVideoMode] = useState(true);
  const [supportsBrowserSpeech, setSupportsBrowserSpeech] = useState(true);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [backendFallbackActive, setBackendFallbackActive] = useState(false);

  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognitionInstance | null>(null);
  const sessionStartMsRef = useRef<number | null>(null);
  const speechSegmentStartMsRef = useRef<number | null>(null);
  const speechSessionIdRef = useRef<string | null>(null);
  const shouldRestartRecognitionRef = useRef(false);
  const hasUnmountedRef = useRef(false);
  const lastInterimTranscriptRef = useRef('');
  const clientTranscriptSequenceRef = useRef(0);

  const isSigning = playbackState === 'playing';
  const hasVideoTrack = Boolean(previewStream && previewStream.getVideoTracks().length > 0);
  const hasCameraPreview = Boolean(hasVideoTrack && !cameraPaused);
  const displayPhase: VideoModeSessionPhase = useMemo(() => {
    if (!supportsVideoMode || !supportsBrowserSpeech) {
      return 'unsupported';
    }
    if (sessionPhase === 'listening' && isSigning) {
      return 'signing';
    }
    return sessionPhase;
  }, [isSigning, sessionPhase, supportsBrowserSpeech, supportsVideoMode]);

  const headerStatus = useMemo(() => {
    if (sessionError) {
      return 'Session issue';
    }

    switch (displayPhase) {
      case 'connecting':
        return 'Connecting';
      case 'processing':
        return 'Processing';
      case 'signing':
        return 'Signing';
      case 'testing':
        return 'Testing';
      case 'listening':
        return 'Listening';
      case 'unsupported':
        return 'Unsupported';
      default:
        return sessionActive ? 'Live' : 'Ready';
    }
  }, [displayPhase, sessionActive, sessionError]);

  useEffect(() => {
    onSessionPhaseChange(displayPhase);
  }, [displayPhase, onSessionPhaseChange]);

  useEffect(() => {
    if (!previewVideoRef.current) {
      return;
    }

    previewVideoRef.current.srcObject = previewStream;
  }, [previewStream]);

  useEffect(() => {
    previewStreamRef.current = previewStream;
  }, [previewStream]);

  useEffect(() => {
    const constructor = getSpeechRecognitionConstructor();
    setSupportsBrowserSpeech(Boolean(constructor));
    setSupportsVideoMode(
      typeof navigator !== 'undefined' &&
        typeof navigator.mediaDevices?.getUserMedia === 'function' &&
        typeof WebSocket !== 'undefined'
    );
  }, []);

  useEffect(() => {
    if (!sessionActive) {
      setSessionElapsedSeconds(0);
      return;
    }

    const interval = window.setInterval(() => {
      const startedAt = sessionStartMsRef.current;
      if (!startedAt) {
        return;
      }

      setSessionElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [sessionActive]);

  useEffect(() => {
    if (!showSettingsModal) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowSettingsModal(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showSettingsModal]);

  useEffect(() => {
    void refreshDevicesAndPermissions();

    return () => {
      hasUnmountedRef.current = true;
      teardownSession({clearPreview: true, notifyParent: false});
    };
  }, []);

  async function refreshDevicesAndPermissions() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const queriedPermissions = await Promise.all([
      queryPermission('camera'),
      queryPermission('microphone'),
    ]);

    setCameraPermission(queriedPermissions[0]);
    setMicrophonePermission(queriedPermissions[1]);

    const devices = await navigator.mediaDevices.enumerateDevices();
    const nextAudioDevices = devices
      .filter(device => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: buildDeviceLabel(device, `Microphone ${index + 1}`),
      }));
    const nextVideoDevices = devices
      .filter(device => device.kind === 'videoinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: buildDeviceLabel(device, `Camera ${index + 1}`),
      }));

    setAudioDevices(nextAudioDevices);
    setVideoDevices(nextVideoDevices);

    setSelectedAudioDeviceId(current =>
      current && nextAudioDevices.some(device => device.deviceId === current)
        ? current
        : nextAudioDevices[0]?.deviceId ?? ''
    );
    setSelectedVideoDeviceId(current =>
      current && nextVideoDevices.some(device => device.deviceId === current)
        ? current
        : nextVideoDevices[0]?.deviceId ?? ''
    );
  }

  async function queryPermission(name: 'camera' | 'microphone'): Promise<PermissionStateValue> {
    if (typeof navigator === 'undefined') {
      return 'unsupported';
    }

    if (!navigator.permissions?.query) {
      return 'prompt';
    }

    try {
      const result = await navigator.permissions.query({name} as PermissionDescriptor);
      if (result.state === 'granted' || result.state === 'denied') {
        return result.state;
      }
      return 'prompt';
    } catch {
      return 'prompt';
    }
  }

  async function openPreviewStream({forceRestart = false}: {forceRestart?: boolean} = {}) {
    if (!supportsVideoMode || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setSessionPhase('unsupported');
      setSessionError('This browser does not support the media APIs required for Video Mode.');
      return null;
    }

    if (!forceRestart && previewStreamRef.current) {
      return previewStreamRef.current;
    }

    stopMediaRecorder();
    stopPreviewTracks();

    const audioConstraints =
      selectedAudioDeviceId
        ? {deviceId: {exact: selectedAudioDeviceId}, echoCancellation: true, noiseSuppression: true}
        : {echoCancellation: true, noiseSuppression: true};
    const videoConstraints =
      selectedVideoDeviceId
        ? {deviceId: {exact: selectedVideoDeviceId}, width: {ideal: 960}, height: {ideal: 540}, facingMode: 'user'}
        : {width: {ideal: 960}, height: {ideal: 540}, facingMode: 'user'};

    try {
      const fullStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: videoConstraints,
      });
      setCameraPermission('granted');
      setMicrophonePermission('granted');
      setCameraPaused(false);
      setMicrophoneMuted(false);
      setPreviewStream(fullStream);
      await refreshDevicesAndPermissions();
      return fullStream;
    } catch (error) {
      if (!isPermissionDeniedError(error) && !isCameraUnavailableError(error)) {
        throw error;
      }

      try {
        const audioOnlyStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false,
        });
        setCameraPermission('denied');
        setMicrophonePermission('granted');
        setCameraPaused(true);
        setMicrophoneMuted(false);
        setPreviewStream(audioOnlyStream);
        await refreshDevicesAndPermissions();
        return audioOnlyStream;
      } catch (audioError) {
        if (isPermissionDeniedError(audioError)) {
          setMicrophonePermission('denied');
        }
        if (isPermissionDeniedError(error) || isCameraUnavailableError(error)) {
          setCameraPermission('denied');
        }
        throw audioError;
      }
    }
  }

  function stopPreviewTracks() {
    const stream = previewStreamRef.current;
    if (!stream) {
      return;
    }

    stream.getTracks().forEach(track => {
      track.stop();
    });

    previewStreamRef.current = null;
    setPreviewStream(null);
  }

  function stopMediaRecorder() {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      return;
    }

    mediaRecorderRef.current = null;

    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
  }

  function stopRecognition() {
    shouldRestartRecognitionRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    speechSegmentStartMsRef.current = null;
    lastInterimTranscriptRef.current = '';
    setInterimTranscript('');
  }

  function closeSocket() {
    const socket = socketRef.current;
    socketRef.current = null;
    speechSessionIdRef.current = null;

    if (!socket) {
      return;
    }

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({type: 'end_session'}));
    }
    socket.close();
  }

  function teardownSession({
    clearPreview,
    notifyParent,
  }: {
    clearPreview: boolean;
    notifyParent: boolean;
  }) {
    stopRecognition();
    stopMediaRecorder();
    closeSocket();

    if (clearPreview) {
      stopPreviewTracks();
    }

    sessionStartMsRef.current = null;
    setSessionActive(false);
    setSessionPhase('idle');
    setSessionElapsedSeconds(0);
    setSessionError(null);
    setLatestFinalizedTranscript('');
    setInterimTranscript('');
    setCameraPaused(false);
    setMicrophoneMuted(false);
    setBackendFallbackActive(false);

    if (notifyParent) {
      onSessionActiveChange(false);
      onSessionPhaseChange('idle');
      onSessionReset();
    }
  }

  function sendSocketMessage(payload: Record<string, unknown>) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(JSON.stringify(payload));
    return true;
  }

  function emitTranscriptUpdate(
    transcriptState: TranscriptState,
    text: string,
    confidence: number | null
  ) {
    const normalizedText = normalizeTranscriptText(text);
    if (!normalizedText) {
      return;
    }

    const createdAtMs = Date.now();
    const speechStartMs = speechSegmentStartMsRef.current ?? createdAtMs;
    const speechEndMs = transcriptState === 'final' ? createdAtMs : null;
    const payload = {
      confidence,
      created_at_ms: createdAtMs,
      speech_end_ms: speechEndMs,
      speech_start_ms: speechStartMs,
      text: normalizedText,
      transcript_state: transcriptState,
      type: 'client_transcript',
      client_sequence_id: ++clientTranscriptSequenceRef.current,
    };

    const wasSentToServer = sendSocketMessage(payload);

    if (transcriptState === 'final') {
      setLatestFinalizedTranscript(normalizedText);
      if (!wasSentToServer) {
        onTranscriptEvent({
          confidence,
          createdAtMs,
          id: `local-${clientTranscriptSequenceRef.current}`,
          speechEndMs,
          speechStartMs,
          text: normalizedText,
          transcriptState: 'final',
        });
      }
      setInterimTranscript('');
      speechSegmentStartMsRef.current = null;
      lastInterimTranscriptRef.current = '';
      return;
    }

    if (!wasSentToServer) {
      setInterimTranscript(normalizedText);
    }
    lastInterimTranscriptRef.current = normalizedText;
  }

  function startBrowserSpeechRecognition() {
    const Constructor = getSpeechRecognitionConstructor();
    if (!Constructor) {
      setSupportsBrowserSpeech(false);
      setSessionPhase('unsupported');
      setSessionError('Live speech recognition is not available in this browser yet.');
      return;
    }

    const recognition = new Constructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    shouldRestartRecognitionRef.current = true;

    recognition.onspeechstart = () => {
      speechSegmentStartMsRef.current = speechSegmentStartMsRef.current ?? Date.now();
      sendSocketMessage({type: 'vad_state', state: 'speaking'});
      setSessionPhase('listening');
    };

    recognition.onspeechend = () => {
      sendSocketMessage({type: 'vad_state', state: 'processing'});
      if (sessionActive) {
        setSessionPhase('processing');
      }
    };

    recognition.onerror = event => {
      if (event.error === 'aborted') {
        return;
      }

      setSessionPhase('error');
      setSessionError('Speech recognition was interrupted. Try restarting the live session.');
    };

    recognition.onend = () => {
      if (shouldRestartRecognitionRef.current && !hasUnmountedRef.current && sessionActive) {
        try {
          recognition.start();
        } catch {
          setSessionPhase('error');
          setSessionError('Speech recognition could not restart automatically.');
        }
      }
    };

    recognition.onresult = event => {
      let nextInterimTranscript = '';

      for (let resultIndex = event.resultIndex; resultIndex < event.results.length; resultIndex += 1) {
        const result = event.results[resultIndex];
        const alternative = result[0];
        const transcript = normalizeTranscriptText(alternative?.transcript ?? '');

        if (!transcript) {
          continue;
        }

        if (result.isFinal) {
          emitTranscriptUpdate('final', transcript, alternative?.confidence ?? null);
          continue;
        }

        nextInterimTranscript = transcript;
      }

      if (nextInterimTranscript && nextInterimTranscript !== lastInterimTranscriptRef.current) {
        emitTranscriptUpdate('interim', nextInterimTranscript, null);
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  }

  function startAudioStreaming(stream: MediaStream) {
    if (typeof MediaRecorder === 'undefined' || stream.getAudioTracks().length === 0) {
      return;
    }

    const mimeTypeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mimeType = mimeTypeCandidates.find(candidate => {
      try {
        return typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(candidate);
      } catch {
        return false;
      }
    });

    const recorder = mimeType ? new MediaRecorder(stream, {mimeType}) : new MediaRecorder(stream);
    recorder.ondataavailable = async event => {
      if (!event.data || event.data.size === 0) {
        return;
      }

      const arrayBuffer = await event.data.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      bytes.forEach(byte => {
        binary += String.fromCharCode(byte);
      });

      sendSocketMessage({
        type: 'audio_chunk',
        chunk_base64: btoa(binary),
        duration_ms: AUDIO_CHUNK_MS,
        mime_type: event.data.type || mimeType || 'application/octet-stream',
      });
    };

    recorder.start(AUDIO_CHUNK_MS);
    mediaRecorderRef.current = recorder;
  }

  function handleServerEvent(rawEvent: MessageEvent<string>) {
    const payload = JSON.parse(rawEvent.data) as ServerEvent;

    if (payload.type === 'session_started') {
      speechSessionIdRef.current = payload.session_id;
      setSessionActive(true);
      setSessionPhase('listening');
      setSessionError(null);
      onSessionActiveChange(true);
      return;
    }

    if (payload.type === 'transcript_interim') {
      setSessionPhase('listening');
      setInterimTranscript(payload.text);
      return;
    }

    if (payload.type === 'transcript_final') {
      setSessionPhase(isSigning ? 'signing' : 'processing');
      setInterimTranscript('');
      setLatestFinalizedTranscript(payload.text);
      onTranscriptEvent({
        confidence: payload.confidence,
        createdAtMs: payload.created_at_ms,
        id: `${payload.session_id}-${payload.sequence_id}`,
        speechEndMs: payload.speech_end_ms,
        speechStartMs: payload.speech_start_ms,
        text: payload.text,
        transcriptState: 'final',
      });
      return;
    }

    if (payload.type === 'vad_state') {
      if (payload.state === 'processing') {
        setSessionPhase(isSigning ? 'signing' : 'processing');
        return;
      }

      setSessionPhase('listening');
      return;
    }

    if (payload.type === 'error') {
      setSessionPhase('error');
      setSessionError(payload.detail);
      return;
    }

    if (payload.type === 'session_ended') {
      teardownSession({clearPreview: true, notifyParent: true});
    }
  }

  async function connectSpeechSocket() {
    const wsUrl = buildBackendWsUrl('/speech/stream');
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'start_session',
          preferred_mode: 'browser_fallback',
          language: 'en-US',
        })
      );
    };
    socket.onmessage = handleServerEvent;
    socket.onerror = () => {
      setBackendFallbackActive(true);
      setSessionPhase('listening');
    };
    socket.onclose = () => {
      if (!hasUnmountedRef.current && sessionActive && speechSessionIdRef.current) {
        teardownSession({clearPreview: true, notifyParent: true});
      }
    };
  }

  async function handleTestDevices() {
    setSessionError(null);

    try {
      await openPreviewStream({forceRestart: true});
      setSessionPhase('testing');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not access the selected camera or microphone.';
      setSessionPhase('error');
      setSessionError(message);
    }
  }

  async function handleStartSession() {
    setSessionError(null);
    onSessionReset();

    try {
      const stream = await openPreviewStream({forceRestart: true});
      if (!stream || stream.getAudioTracks().length === 0) {
        setSessionPhase('error');
        setSessionError('Video Mode needs microphone access before a live session can begin.');
        return;
      }

      sessionStartMsRef.current = Date.now();
      setSessionElapsedSeconds(0);
      setSessionActive(true);
      setBackendFallbackActive(false);
      onSessionActiveChange(true);
      setSessionPhase('connecting');
      startBrowserSpeechRecognition();
      await connectSpeechSocket();
      startAudioStreaming(stream);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not start the live session with the selected devices.';
      setSessionPhase('error');
      setSessionError(message);
    }
  }

  function handleEndSession() {
    teardownSession({clearPreview: true, notifyParent: true});
  }

  async function restartPreviewForSelectionChange(nextAudioDeviceId: string, nextVideoDeviceId: string) {
    if (!previewStreamRef.current) {
      setSelectedAudioDeviceId(nextAudioDeviceId);
      setSelectedVideoDeviceId(nextVideoDeviceId);
      return;
    }

    const previousAudioId = selectedAudioDeviceId;
    const previousVideoId = selectedVideoDeviceId;

    setSelectedAudioDeviceId(nextAudioDeviceId);
    setSelectedVideoDeviceId(nextVideoDeviceId);

    try {
      const stream = await openPreviewStream({forceRestart: true});
      if (sessionActive && stream) {
        startAudioStreaming(stream);
      }
    } catch {
      setSelectedAudioDeviceId(previousAudioId);
      setSelectedVideoDeviceId(previousVideoId);
      setSessionPhase('error');
      setSessionError('The selected device could not be activated.');
    }
  }

  function handleToggleMicrophone() {
    const stream = previewStreamRef.current;
    if (!stream) {
      return;
    }

    const nextMutedState = !microphoneMuted;
    stream.getAudioTracks().forEach(track => {
      track.enabled = !nextMutedState;
    });
    setMicrophoneMuted(nextMutedState);
  }

  function handleToggleCamera() {
    const stream = previewStreamRef.current;
    if (!stream) {
      return;
    }

    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length === 0) {
      return;
    }

    const nextPausedState = !cameraPaused;
    videoTracks.forEach(track => {
      track.enabled = !nextPausedState;
    });
    setCameraPaused(nextPausedState);
  }

  function bindPreviewVideo(node: HTMLVideoElement | null) {
    previewVideoRef.current = node;

    if (node) {
      node.srcObject = previewStreamRef.current;
    }
  }

  return (
    <section className="panel panel-live" aria-label="Video mode live session panel">
      <div className="panel-section-header">
        <div className="panel-section-copy">
          <p className="panel-section-label">Video Mode</p>
          <h2>Video-based sign translation</h2>
        </div>
        <div className="live-session-meta">
          <span className="live-status-pill">{headerStatus}</span>
          {sessionActive ? <span className="live-timer">{formatDuration(sessionElapsedSeconds)}</span> : null}
        </div>
      </div>

      <div className="live-panel-grid">
        <div className="live-meet-frame">
          {hasCameraPreview ? (
            <video
              ref={bindPreviewVideo}
              className="live-preview-video"
              autoPlay
              muted
              playsInline
            />
          ) : (
            <div className="live-preview-placeholder">
              <p>{sessionActive ? 'Camera preview off' : 'Ready for live audio'}</p>
              <span>
                {sessionActive
                  ? 'Microphone input continues normally even when the camera preview is off.'
                  : 'Start the session to begin signing from microphone audio. Camera is optional and visual-only.'}
              </span>
            </div>
          )}

          <div className="live-overlay-topbar">
            <span className="live-overlay-label">{sessionActive ? 'You' : 'Preview'}</span>
          </div>

          {isLagging ? (
            <div className="live-preview-badge" role="status" aria-live="polite">
              Catching up
            </div>
          ) : null}

          {!sessionActive ? (
            <button
              type="button"
              className="live-start-button"
              onClick={handleStartSession}
              disabled={!supportsVideoMode || !supportsBrowserSpeech}
            >
              Start Live Session
            </button>
          ) : null}

          <div className="live-overlay-controls" aria-label="Session controls">
            <button
              type="button"
              className={microphoneMuted ? 'live-overlay-button live-overlay-button-muted' : 'live-overlay-button'}
              aria-label={microphoneMuted ? 'Unmute microphone' : 'Mute microphone'}
              onClick={handleToggleMicrophone}
              disabled={!previewStream || previewStream.getAudioTracks().length === 0}
            >
              <SessionIcon>
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3Z" />
                  <path d="M19 11a7 7 0 0 1-14 0" />
                  <path d="M12 18v3" />
                  <path d="M8 21h8" />
                </svg>
              </SessionIcon>
            </button>

            <button
              type="button"
              className={cameraPaused ? 'live-overlay-button live-overlay-button-muted' : 'live-overlay-button'}
              aria-label={cameraPaused ? 'Turn camera preview on' : 'Turn camera preview off'}
              onClick={handleToggleCamera}
              disabled={!previewStream || !hasVideoTrack}
            >
              <SessionIcon>
                <svg viewBox="0 0 24 24" focusable="false">
                  <rect x="4" y="7" width="11" height="10" rx="2" />
                  <path d="m15 11 5-3v8l-5-3" />
                </svg>
              </SessionIcon>
            </button>

            <button
              type="button"
              className="live-overlay-button"
              aria-label="Open session settings"
              onClick={() => setShowSettingsModal(true)}
            >
              <SessionIcon>
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M12 9.5A2.5 2.5 0 1 1 9.5 12 2.5 2.5 0 0 1 12 9.5Z" />
                  <path d="m19.4 15-.8 1.8-2 .2a6.8 6.8 0 0 1-1 .9l.2 2-1.8.8-1.4-1.4a6.7 6.7 0 0 1-1.2 0L10 21.7l-1.8-.8.2-2a6.8 6.8 0 0 1-1-.9l-2-.2L4.6 15l1.4-1.4a6.7 6.7 0 0 1 0-1.2L4.6 11l.8-1.8 2-.2a6.8 6.8 0 0 1 1-.9l-.2-2L10 5.3l1.4 1.4a6.7 6.7 0 0 1 1.2 0L14 5.3l1.8.8-.2 2a6.8 6.8 0 0 1 1 .9l2 .2.8 1.8-1.4 1.4a6.7 6.7 0 0 1 0 1.2Z" />
                </svg>
              </SessionIcon>
            </button>

            <button
              type="button"
              className="live-overlay-button live-overlay-button-danger"
              aria-label="End live session"
              onClick={handleEndSession}
              disabled={!previewStream && !sessionActive}
            >
              <SessionIcon>
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M6 8.5A13.4 13.4 0 0 1 12 7a13.4 13.4 0 0 1 6 1.5" />
                  <path d="M5 9.5 8 13" />
                  <path d="m19 9.5-3 3.5" />
                  <path d="M8 13h8" />
                </svg>
              </SessionIcon>
            </button>
          </div>
        </div>
      </div>

      {showSettingsModal ? (
        <div
          className="live-settings-backdrop"
          role="presentation"
          onClick={() => setShowSettingsModal(false)}
        >
          <div
            className="live-settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Session settings"
            onClick={event => event.stopPropagation()}
          >
            <div className="live-settings-modal-header">
              <div className="panel-section-copy">
                <p className="panel-section-label">Settings</p>
                <h2>Session settings</h2>
              </div>
              <button
                type="button"
                className="live-settings-close"
                aria-label="Close session settings"
                onClick={() => setShowSettingsModal(false)}
              >
                <SessionIcon>
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M6 6 18 18" />
                    <path d="M18 6 6 18" />
                  </svg>
                </SessionIcon>
              </button>
            </div>

            <p className="field-helper live-settings-copy">
              Microphone drives translation. Camera is only used for optional visual presence in the preview tile.
            </p>

            <div className="live-settings-grid">
              <label className="live-field">
                <span className="field-label">Microphone source</span>
                <select
                  className="control-select"
                  value={selectedAudioDeviceId}
                  onChange={event => {
                    void restartPreviewForSelectionChange(event.target.value, selectedVideoDeviceId);
                  }}
                >
                  <option value="">Default microphone</option>
                  {audioDevices.map(device => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="live-field">
                <span className="field-label">Camera source</span>
                <select
                  className="control-select"
                  value={selectedVideoDeviceId}
                  onChange={event => {
                    void restartPreviewForSelectionChange(selectedAudioDeviceId, event.target.value);
                  }}
                >
                  <option value="">Default camera</option>
                  {videoDevices.map(device => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="live-settings-helpers">
              <div className="live-settings-helper-card">
                <span className="live-settings-helper-label">Microphone</span>
                <p>{microphonePermission === 'granted' ? 'Ready' : microphonePermission}</p>
              </div>
              <div className="live-settings-helper-card">
                <span className="live-settings-helper-label">Camera</span>
                <p>{cameraPermission === 'granted' ? 'Optional and ready' : cameraPermission}</p>
              </div>
              {backendFallbackActive ? (
                <div className="live-settings-helper-card">
                  <span className="live-settings-helper-label">Speech mode</span>
                  <p>Using browser fallback</p>
                </div>
              ) : null}
            </div>

            <div className="live-settings-actions">
              <button
                type="button"
                className="control-chip"
                onClick={handleTestDevices}
                disabled={!supportsVideoMode || sessionActive}
              >
                Test Devices
              </button>
              <button
                type="button"
                className="control-chip"
                onClick={() => {
                  void refreshDevicesAndPermissions();
                }}
              >
                Refresh Devices
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!supportsBrowserSpeech ? (
        <div className="viewer-overlay viewer-overlay-error live-panel-error" role="alert">
          This browser does not currently support the speech recognition fallback needed for Video Mode.
        </div>
      ) : null}

      {sessionError ? (
        <div className="viewer-overlay viewer-overlay-error live-panel-error" role="alert">
          {sessionError}
        </div>
      ) : null}
    </section>
  );
}
