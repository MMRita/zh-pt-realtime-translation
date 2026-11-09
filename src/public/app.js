import { buildAudioMixState } from "/audio-mix.js";

const TRANSLATION_CALL_URL = "/realtime-call";

const OUTPUT_TRANSCRIPT_EVENTS = new Set(["session.output_transcript.delta"]);
const INPUT_TRANSCRIPT_EVENTS = new Set(["session.input_transcript.delta"]);

const targetLanguage = document.querySelector("#targetLanguage");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const muteButton = document.querySelector("#muteButton");
const audioMix = document.querySelector("#audioMix");
const mixValue = document.querySelector("#mixValue");
const originalMixLabel = document.querySelector("#originalMixLabel");
const translatedMixLabel = document.querySelector("#translatedMixLabel");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const inputMeter = document.querySelector("#inputMeter");
const queueProgress = document.querySelector("#queueProgress");
const translatedTranscript = document.querySelector("#translatedTranscript");
const sourceTranscript = document.querySelector("#sourceTranscript");
const eventLog = document.querySelector("#eventLog");
const captureState = document.querySelector("#captureState");
const chunksSent = document.querySelector("#chunksSent");
const activeInputFrames = document.querySelector("#activeInputFrames");
const peakInputLevel = document.querySelector("#peakInputLevel");
const outputAudioDeltas = document.querySelector("#outputAudioDeltas");
const transcriptDeltas = document.querySelector("#transcriptDeltas");
const lastEventType = document.querySelector("#lastEventType");

let peerConnection = null;
let dataChannel = null;
let captureStream = null;
let meterContext = null;
let meterSource = null;
let meterAnalyser = null;
let meterTimer = null;
let sourceAudio = null;
let translatedAudio = null;
let diagnostics = createEmptyDiagnostics();

applyAudioMix();

audioMix.addEventListener("input", () => {
  applyAudioMix();
});

startButton.addEventListener("click", async () => {
  clearTranscript();
  resetDiagnostics();
  setControls({ running: true });
  setStatus("正在请求麦克风权限…", "idle");

  try {
    captureStream = await captureTabAudio();
    startInputMeter(captureStream);

    setStatus("正在创建翻译会话", "idle");
    logEvent("session", "requesting local session endpoint");
    const session = await createSession(targetLanguage.value);
    logEvent("session", "client secret received");

    setStatus("正在连接实时翻译", "idle");
    logEvent("webrtc", "sending local relay request");
    await connectRealtimeTranslation(session, captureStream);

    setStatus("正在实时翻译", "live");
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    logEvent("error", detail);
    await stop("启动失败，请查看事件日志", "error");
  }
});

stopButton.addEventListener("click", async () => {
  await stop("Stopped", "idle");
});

muteButton.addEventListener("click", () => {
  if (!translatedAudio) return;
  translatedAudio.muted = !translatedAudio.muted;
  muteButton.textContent = translatedAudio.muted ? "打开译音" : "静音译音";
});

async function createSession(language) {
  let response;
  try {
    response = await fetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetLanguage: language }),
    });
  } catch {
    throw new Error("无法连接本地翻译服务，请重新双击启动BAT文件。");
  }

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error ?? "Failed to create session.");
  }

  return body;
}

async function connectRealtimeTranslation(session, stream) {
  peerConnection = new RTCPeerConnection();
  dataChannel = peerConnection.createDataChannel("oai-events");

  translatedAudio = new Audio();
  translatedAudio.autoplay = true;
  translatedAudio.playsInline = true;
  applyAudioMix();
  muteButton.disabled = false;

  peerConnection.onconnectionstatechange = () => {
    diagnostics.connectionState = peerConnection?.connectionState ?? "closed";
    chunksSent.textContent = diagnostics.connectionState;
    logEvent("webrtc.connection", diagnostics.connectionState);
    updateDiagnostics();
  };

  peerConnection.oniceconnectionstatechange = () => {
    diagnostics.iceConnectionState =
      peerConnection?.iceConnectionState ?? "closed";
    if (queueProgress) {
      queueProgress.value =
        diagnostics.iceConnectionState === "connected" ||
        diagnostics.iceConnectionState === "completed" ? 1 : 0;
    }
    updateDiagnostics();
  };

  peerConnection.ontrack = ({ streams }) => {
    diagnostics.remoteAudioTracks += 1;
    outputAudioDeltas.textContent = String(diagnostics.remoteAudioTracks);
    translatedAudio.srcObject = streams[0];
    applyAudioMix();
    void translatedAudio.play().catch((error) => {
      logEvent("audio.play", error.message);
    });
    logEvent("remote.audio", "track received");
    updateDiagnostics();
  };

  dataChannel.onopen = () => {
    diagnostics.dataChannelState = dataChannel?.readyState ?? "open";
    activeInputFrames.textContent = diagnostics.dataChannelState;
    logEvent("datachannel.open", "ok");
    updateDiagnostics();
  };
  dataChannel.onclose = () => {
    diagnostics.dataChannelState = "closed";
    activeInputFrames.textContent = "closed";
    logEvent("datachannel.close", "closed");
    updateDiagnostics();
  };
  dataChannel.onerror = () => {
    logEvent("datachannel.error", "error");
  };
  dataChannel.onmessage = handleRealtimeEvent;

  for (const track of stream.getAudioTracks()) {
    peerConnection.addTrack(track, stream);
  }

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  let sdpResponse;
  try {
    sdpResponse = await fetch(TRANSLATION_CALL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.client_secret}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });
  } catch (error) {
    throw new Error(`无法连接本地WebRTC转发服务：${error?.message ?? error}`);
  }

  const answerSdp = await sdpResponse.text();
  if (!sdpResponse.ok) {
    throw new Error(`WebRTC连接失败（${sdpResponse.status}）：${answerSdp.slice(0, 300)}`);
  }

  await peerConnection.setRemoteDescription({
    type: "answer",
    sdp: answerSdp,
  });

  logEvent("webrtc.offer", `connected for ${session.targetLanguage}`);
}

async function captureTabAudio() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support microphone capture.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("没有检测到麦克风，请检查浏览器权限和设备。");
  }

  audioTracks[0].addEventListener(
    "ended",
    () => {
      void stop("Tab audio sharing ended", "idle");
    },
    { once: true },
  );

  captureState.textContent = `microphone=${audioTracks[0].readyState}`;
  logEvent("capture.started", "microphone ready");

  return stream;
}

function startInputMeter(stream) {
  meterContext = new AudioContext();
  meterSource = meterContext.createMediaStreamSource(stream);
  meterAnalyser = meterContext.createAnalyser();
  meterAnalyser.fftSize = 2048;
  meterSource.connect(meterAnalyser);

  const samples = new Float32Array(meterAnalyser.fftSize);
  meterTimer = window.setInterval(() => {
    meterAnalyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / samples.length);
    inputMeter.value = Math.min(1, rms * 12);
    diagnostics.peakInputLevel = Math.max(diagnostics.peakInputLevel, rms);
    peakInputLevel.textContent = diagnostics.peakInputLevel.toFixed(3);
  }, 100);
}

function startSourceAudio(stream) {
  sourceAudio = new Audio();
  sourceAudio.autoplay = true;
  sourceAudio.playsInline = true;
  sourceAudio.srcObject = stream;
  applyAudioMix();

  void sourceAudio.play().catch((error) => {
    logEvent("source.audio.play", error.message);
  });
}

function applyAudioMix() {
  const mix = buildAudioMixState(audioMix.value);

  audioMix.value = String(mix.translatedPercent);
  mixValue.textContent = mix.valueLabel;
  originalMixLabel.textContent = mix.originalLabel;
  translatedMixLabel.textContent = mix.translatedLabel;

  if (sourceAudio) {
    sourceAudio.volume = mix.originalVolume;
  }
  if (translatedAudio) {
    translatedAudio.volume = mix.translatedVolume;
  }
}

function handleRealtimeEvent(message) {
  let event;
  try {
    event = JSON.parse(message.data);
  } catch {
    logEvent("message", "Received non-JSON data channel message.");
    return;
  }

  diagnostics.lastEventType = event.type;
  lastEventType.textContent = event.type;

  if (event.type === "error") {
    logEvent("error", JSON.stringify(event.error ?? event));
    return;
  }

  if (OUTPUT_TRANSCRIPT_EVENTS.has(event.type) && typeof event.delta === "string") {
    diagnostics.transcriptDeltas += 1;
    appendTranslatedText(event.delta);
    updateDiagnostics();
    return;
  }

  if (INPUT_TRANSCRIPT_EVENTS.has(event.type) && typeof event.delta === "string") {
    sourceTranscript.textContent += event.delta;
    sourceTranscript.scrollTop = sourceTranscript.scrollHeight;
    logEvent("input", event.delta);
    return;
  }

  if (
    event.type === "session.created" ||
    event.type === "session.updated" ||
    event.type === "output_audio_buffer.started"
  ) {
    logEvent(event.type, "ok");
  }

  updateDiagnostics();
}

async function stop(message, state = "idle") {
  if (meterTimer) {
    window.clearInterval(meterTimer);
    meterTimer = null;
  }

  meterSource?.disconnect();
  meterAnalyser?.disconnect();
  meterSource = null;
  meterAnalyser = null;

  if (meterContext?.state !== "closed") {
    await meterContext?.close();
  }
  meterContext = null;

  dataChannel?.close();
  dataChannel = null;

  peerConnection?.close();
  peerConnection = null;

  if (sourceAudio) {
    sourceAudio.pause();
    sourceAudio.srcObject = null;
  }
  sourceAudio = null;

  captureStream?.getTracks().forEach((track) => track.stop());
  captureStream = null;

  if (translatedAudio) {
    translatedAudio.pause();
    translatedAudio.srcObject = null;
    translatedAudio.muted = false;
  }
  muteButton.disabled = true;
  muteButton.textContent = "静音译音";
  translatedAudio = null;

  inputMeter.value = 0;
  if (queueProgress) queueProgress.value = 0;
  setControls({ running: false });
  setStatus(message, state);
}

function setControls({ running }) {
  startButton.disabled = running;
  stopButton.disabled = !running;
  targetLanguage.disabled = running;
}

function setStatus(message, state) {
  statusText.textContent = message;
  statusDot.className = `status-dot ${state === "live" ? "live" : ""} ${
    state === "error" ? "error" : ""
  }`;
}

function appendTranslatedText(text) {
  translatedTranscript.textContent += text;
  translatedTranscript.scrollTop = translatedTranscript.scrollHeight;
}

function clearTranscript() {
  sourceTranscript.textContent = "";
  translatedTranscript.textContent = "";
}

function createEmptyDiagnostics() {
  return {
    connectionState: "new",
    dataChannelState: "connecting",
    iceConnectionState: "new",
    lastEventType: "none",
    peakInputLevel: 0,
    remoteAudioTracks: 0,
    transcriptDeltas: 0,
  };
}

function resetDiagnostics() {
  diagnostics = createEmptyDiagnostics();
  captureState.textContent = "Starting";
  eventLog.textContent = "";
  updateDiagnostics();
}

function updateDiagnostics() {
  chunksSent.textContent = diagnostics.connectionState;
  activeInputFrames.textContent = diagnostics.dataChannelState;
  peakInputLevel.textContent = diagnostics.peakInputLevel.toFixed(3);
  outputAudioDeltas.textContent = String(diagnostics.remoteAudioTracks);
  transcriptDeltas.textContent = String(diagnostics.transcriptDeltas);
  lastEventType.textContent = diagnostics.lastEventType;
}

function logEvent(type, detail) {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${type}: ${detail}`;
  eventLog.append(entry);
  eventLog.scrollTop = eventLog.scrollHeight;
}
