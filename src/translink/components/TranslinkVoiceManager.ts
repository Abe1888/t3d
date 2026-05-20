import { pcmToBase64, base64ToFloat32 } from './audio-utils';

// Module-level registry: tracks which AudioContext instances have already had
// 'microphone-processor' registered. Prevents NotSupportedError on reconnection.
const _workletRegisteredContexts = new WeakSet<AudioContext>();
import { TranslinkLanguageController } from '../controllers/TranslinkLanguageController';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'speaking';

export interface VoiceManagerCallbacks {
    onStateChange?: (state: VoiceState) => void;
    onTranscription?: (text: string) => void;
    onError?: (error: string) => void;
    onSetupComplete?: () => void;
}

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

const AUDIO_WORKLET_CODE = `
class MicrophoneProcessor extends AudioWorkletProcessor {
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (input && input.length > 0) {
            const channelData = input[0];
            this.port.postMessage(channelData.slice());
        }
        return true;
    }
}
registerProcessor('microphone-processor', MicrophoneProcessor);
`;

export class TranslinkVoiceManager {
    private ws: WebSocket | null = null;
    private audioCtx: AudioContext | null = null;
    private nextStartTime = 0;
    private state: VoiceState = 'idle';
    private callbacks: VoiceManagerCallbacks = {};
    private mediaStream: MediaStream | null = null;
    private workletNode: AudioWorkletNode | null = null;
    private workletMonitorGain: GainNode | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private activeAudioSources: Set<AudioBufferSourceNode> = new Set();
    private playbackAnalyser: AnalyserNode | null = null;
    private _turnCompleteReceived = false;

    constructor(callbacks: VoiceManagerCallbacks = {}) {
        this.callbacks = callbacks;
    }

    private _changeState(newState: VoiceState): void {
        this.state = newState;
        if (this.callbacks.onStateChange) {
            this.callbacks.onStateChange(newState);
        }
    }

    async connect(welcome: boolean = true, enableMic: boolean = true, onConnected?: () => void): Promise<void> {
        if (this.ws) return;

        this._changeState('connecting');

        try {
            // Setup Web Audio Context if not present
            if (!this.audioCtx) {
                const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
                this.audioCtx = new AudioContextClass();
            }
            if (this.audioCtx.state === 'suspended') {
                await this.audioCtx.resume().catch(() => {});
            }
            if (!this.playbackAnalyser) {
                this.playbackAnalyser = this.audioCtx.createAnalyser();
                this.playbackAnalyser.fftSize = 256;
                this.playbackAnalyser.connect(this.audioCtx.destination);
            }

            const lang = TranslinkLanguageController.getInstance().getLanguage();
            let wsUrl = '';
            
            // Check if a dedicated WebSocket backend URL is provided via Vite environment variables
            const envBackendUrl = (import.meta.env as any).VITE_WS_BACKEND_URL;
            if (envBackendUrl) {
                if (envBackendUrl.startsWith('ws:') || envBackendUrl.startsWith('wss:')) {
                    wsUrl = `${envBackendUrl}/ws/live?lang=${encodeURIComponent(lang)}&welcome=${welcome}`;
                } else {
                    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                    wsUrl = `${protocol}//${envBackendUrl}/ws/live?lang=${encodeURIComponent(lang)}&welcome=${welcome}`;
                }
            } else {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                wsUrl = `${protocol}//${window.location.host}/ws/live?lang=${encodeURIComponent(lang)}&welcome=${welcome}`;
            }

            console.log('[VoiceManager] Connecting to WebSocket:', wsUrl);
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('[VoiceManager] WebSocket connected');
                this._changeState('listening');
                if (enableMic) {
                    this._startMicrophone();
                } else {
                    console.log('[VoiceManager] Microphone stream disabled for output-only announcements');
                }
                // Notify caller the moment the socket is confirmed open and ready.
                // This is the only safe point to send the first text prompt.
                if (onConnected) onConnected();
            };

            this.ws.onmessage = async (event) => {
                try {
                    const msg = JSON.parse(event.data);

                    if (msg.error) {
                        console.error('[VoiceManager] Server Error:', msg.error);
                        if (this.callbacks.onError) this.callbacks.onError(msg.error);
                        this.disconnect();
                        return;
                    }

                    if (msg.setupComplete) {
                        console.log('[VoiceManager] Server setup complete received');
                        if (this.callbacks.onSetupComplete) {
                            this.callbacks.onSetupComplete();
                        }
                    }

                    if (msg.audio) {
                        this._changeState('speaking');
                        this._playAudioChunk(msg.audio);
                    }

                    if (msg.interrupted) {
                        this._stopPlayback();
                    }

                    if (msg.text && this.callbacks.onTranscription) {
                        this.callbacks.onTranscription(msg.text);
                    }

                    if (msg.turnComplete) {
                        this._turnCompleteReceived = true;
                        if (this.activeAudioSources.size === 0) {
                            this._changeState('listening');
                        }
                    }
                } catch (err) {
                    console.error('[VoiceManager] Error parsing message:', err);
                }
            };

            this.ws.onclose = (event) => {
                console.log('[VoiceManager] WebSocket connection closed', event.code, event.reason);
                this.disconnect();
            };

            this.ws.onerror = (err) => {
                console.error('[VoiceManager] WebSocket error occurred:', err);
                if (this.callbacks.onError) this.callbacks.onError('Connection error');
                this.disconnect();
            };
        } catch (error: any) {
            console.error('[VoiceManager] Failed to connect:', error);
            if (this.callbacks.onError)
                this.callbacks.onError(error.message || 'Failed to connect');
            this.disconnect();
        }
    }

    disconnect(): void {
        this._stopMicrophone();
        this._stopPlayback();
        this._turnCompleteReceived = false;

        if (this.ws) {
            if (
                this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING
            ) {
                this.ws.close();
            }
            this.ws = null;
        }

        this._changeState('idle');
    }

    private async _startMicrophone(): Promise<void> {
        if (!this.audioCtx) return;

        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.sourceNode = this.audioCtx.createMediaStreamSource(this.mediaStream);

            // Register inline AudioWorklet module — guarded by WeakSet to prevent
            // NotSupportedError: 'microphone-processor already registered' on reconnect.
            if (!_workletRegisteredContexts.has(this.audioCtx)) {
                const blob = new Blob([AUDIO_WORKLET_CODE], { type: 'application/javascript' });
                const workletUrl = URL.createObjectURL(blob);
                await this.audioCtx.audioWorklet.addModule(workletUrl);
                URL.revokeObjectURL(workletUrl);
                _workletRegisteredContexts.add(this.audioCtx);
            }

            this.workletNode = new AudioWorkletNode(this.audioCtx, 'microphone-processor');

            this.sourceNode.connect(this.workletNode);
            this.workletMonitorGain = this.audioCtx.createGain();
            this.workletMonitorGain.gain.value = 0;
            this.workletNode.connect(this.workletMonitorGain);
            this.workletMonitorGain.connect(this.audioCtx.destination);

            this.workletNode.port.onmessage = (e) => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    const inputData: Float32Array = e.data;
                    const currentSampleRate = this.audioCtx!.sampleRate;
                    const ratio = currentSampleRate / INPUT_SAMPLE_RATE;
                    const newLength = Math.floor(inputData.length / ratio);
                    const resampledData = new Float32Array(newLength);

                    // Linear interpolation resampling
                    for (let i = 0; i < newLength; i++) {
                        const index = i * ratio;
                        const left = Math.floor(index);
                        const right = Math.min(left + 1, inputData.length - 1);
                        const frac = index - left;
                        resampledData[i] = inputData[left] * (1 - frac) + inputData[right] * frac;
                    }

                    const base64Audio = pcmToBase64(resampledData);

                    this.ws.send(JSON.stringify({
                        audio: base64Audio,
                        mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
                    }));
                }
            };

            console.log('[VoiceManager] Microphone active and streaming');
        } catch (err: any) {
            console.warn('[VoiceManager] Microphone accessibility error. Falling back to Output-Only Text-to-Speech mode:', err);
            // Do NOT call disconnect() or trigger onError. Keeping connection open allows text-to-speech audio responses to still play!
        }
    }

    private _stopMicrophone(): void {
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((track) => track.stop());
            this.mediaStream = null;
        }
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        if (this.workletMonitorGain) {
            this.workletMonitorGain.disconnect();
            this.workletMonitorGain = null;
        }
        if (this.sourceNode) {
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }
        console.log('[VoiceManager] Microphone stopped');
    }

    private _playAudioChunk(base64Audio: string): void {
        if (!this.audioCtx) return;
        this._turnCompleteReceived = false;

        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }

        const float32Data = base64ToFloat32(base64Audio);
        const buffer = this.audioCtx.createBuffer(1, float32Data.length, OUTPUT_SAMPLE_RATE);
        buffer.getChannelData(0).set(float32Data);

        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        if (this.playbackAnalyser) {
            source.connect(this.playbackAnalyser);
        } else {
            source.connect(this.audioCtx.destination);
        }

        const LOOKAHEAD = 0.05;
        const startTime = Math.max(this.audioCtx.currentTime + LOOKAHEAD, this.nextStartTime);

        this.activeAudioSources.add(source);
        source.onended = () => {
            this.activeAudioSources.delete(source);
            if (this.activeAudioSources.size === 0 && this._turnCompleteReceived && this.state === 'speaking') {
                this._changeState('listening');
            }
        };

        source.start(startTime);
        this.nextStartTime = startTime + buffer.duration;
    }

    private _stopPlayback(): void {
        this._turnCompleteReceived = false;
        this.activeAudioSources.forEach((src) => {
            try {
                src.stop();
            } catch (e) {}
        });
        this.activeAudioSources.clear();
        if (this.audioCtx) {
            this.nextStartTime = this.audioCtx.currentTime;
        }
        console.log('[VoiceManager] Playback interrupted');
    }

    isConnected(): boolean {
        return this.state !== 'idle';
    }

    getState(): VoiceState {
        return this.state;
    }

    sendText(text: string): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this._changeState('connecting');
            console.log('[VoiceManager] Sending text context to server:', text);
            this.ws.send(JSON.stringify({ text }));
        }
    }

    getPlaybackVolume(): number {
        if (!this.playbackAnalyser) return 0;
        const dataArray = new Uint8Array(this.playbackAnalyser.frequencyBinCount);
        this.playbackAnalyser.getByteTimeDomainData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            const val = (dataArray[i] - 128) / 128;
            sum += val * val;
        }
        return Math.sqrt(sum / dataArray.length);
    }

    isMicrophoneActive(): boolean {
        return this.mediaStream !== null;
    }

    async startMicrophoneIfInactive(): Promise<void> {
        if (this.mediaStream) return;
        await this._startMicrophone();
    }
}
