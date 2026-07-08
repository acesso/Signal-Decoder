import { n as onDestroy } from "../../chunks/index-server.js";
import { C as escape_html, S as clsx, a as ensure_array_like, c as stringify, i as derived, n as attr_style, r as bind_props, t as attr_class, x as attr } from "../../chunks/server.js";
//#region src/lib/audio/globalAudio.svelte.ts
function createGlobalAudio() {
	const state = {
		isRecording: false,
		isSupported: false,
		error: null
	};
	let analyser = null;
	let stream = null;
	let audioCtx = null;
	let recTap = null;
	if (typeof window !== "undefined") state.isSupported = typeof window.AudioContext !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
	function stop() {
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
		if (recTap) {
			recTap.onaudioprocess = null;
			recTap.disconnect();
			recTap = null;
		}
		analyser?.disconnect();
		analyser = null;
		audioCtx?.close();
		audioCtx = null;
		state.isRecording = false;
		state.error = null;
	}
	async function start() {
		try {
			if (audioCtx) stop();
			const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: {
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false
			} });
			stream = mediaStream;
			const ctx = new AudioContext();
			audioCtx = ctx;
			const node = ctx.createAnalyser();
			node.fftSize = 4096;
			node.smoothingTimeConstant = .75;
			const source = ctx.createMediaStreamSource(mediaStream);
			source.connect(node);
			const silencer = ctx.createGain();
			silencer.gain.value = .001;
			node.connect(silencer);
			silencer.connect(ctx.destination);
			const tap = ctx.createScriptProcessor(4096, 1, 1);
			source.connect(tap);
			tap.connect(ctx.destination);
			recTap = tap;
			analyser = node;
			state.isRecording = true;
			state.error = null;
			return node;
		} catch (err) {
			state.isRecording = false;
			state.error = err instanceof Error ? err.message : "Microphone access failed";
			return null;
		}
	}
	return {
		get state() {
			return state;
		},
		get analyser() {
			return analyser;
		},
		start,
		stop
	};
}
var globalAudio = createGlobalAudio();
//#endregion
//#region ../src/lib/rtty/sessions.ts
var PASTEL_COLORS = [
	"#88c0a8",
	"#88aed0",
	"#d0a888",
	"#c088b8",
	"#a888d0",
	"#c8b870",
	"#88c0c8",
	"#d09090",
	"#b0a0e0",
	"#90d0b0",
	"#e0b090",
	"#90b8e0"
];
var _counter = 0;
function makeSession(config) {
	_counter++;
	return {
		id: crypto.randomUUID(),
		label: `Decoder ${_counter}`,
		color: PASTEL_COLORS[(_counter - 1) % PASTEL_COLORS.length],
		config: { ...config },
		preview: "",
		fullText: ""
	};
}
function normalizeText(text) {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n");
}
function sessionsReducer(state, action) {
	switch (action.type) {
		case "ADD_SESSION": {
			const s = makeSession(action.config);
			return {
				...state,
				sessions: [...state.sessions, s]
			};
		}
		case "REMOVE_SESSION": {
			if (state.sessions.length <= 1) return state;
			const sessions = state.sessions.filter((s) => s.id !== action.id);
			return {
				sessions,
				activeSessionId: state.activeSessionId === action.id ? sessions[0].id : state.activeSessionId
			};
		}
		case "ACTIVATE": return {
			...state,
			activeSessionId: action.id
		};
		case "UPDATE_CONFIG": return {
			...state,
			sessions: state.sessions.map((s) => s.id === action.id ? {
				...s,
				config: {
					...s.config,
					...action.patch
				}
			} : s)
		};
		case "APPEND_TEXT": return {
			...state,
			sessions: state.sessions.map((s) => {
				if (s.id !== action.id) return s;
				const full = normalizeText(s.fullText + action.chars);
				const preview = full.split("\n").filter((l) => l.length > 0).slice(-2).map((l) => l.slice(-120)).join("\n");
				return {
					...s,
					fullText: full,
					preview
				};
			})
		};
		case "UPDATE_LABEL": return {
			...state,
			sessions: state.sessions.map((s) => s.id === action.id ? {
				...s,
				label: action.label
			} : s)
		};
		case "UPDATE_COLOR": return {
			...state,
			sessions: state.sessions.map((s) => s.id === action.id ? {
				...s,
				color: action.color
			} : s)
		};
		case "CLEAR_TEXT": return {
			...state,
			sessions: state.sessions.map((s) => s.id === action.id ? {
				...s,
				fullText: "",
				preview: ""
			} : s)
		};
		case "CLEAR_ALL_TEXT": return {
			...state,
			sessions: state.sessions.map((s) => ({
				...s,
				fullText: "",
				preview: ""
			}))
		};
		default: return state;
	}
}
//#endregion
//#region ../src/lib/rtty/baudot.ts
var LTRS_TABLE = [
	"\0",
	"E",
	"\n",
	"A",
	" ",
	"S",
	"I",
	"U",
	"\r",
	"D",
	"R",
	"J",
	"N",
	"F",
	"C",
	"K",
	"T",
	"Z",
	"L",
	"W",
	"H",
	"Y",
	"P",
	"Q",
	"O",
	"B",
	"G",
	"\x1B",
	"M",
	"X",
	"V",
	""
];
var FIGS_TABLE = [
	"\0",
	"3",
	"\n",
	"-",
	" ",
	"'",
	"8",
	"7",
	"\r",
	"",
	"4",
	"\x07",
	",",
	"!",
	":",
	"(",
	"5",
	"\"",
	")",
	"2",
	"#",
	"6",
	"0",
	"1",
	"9",
	"?",
	"&",
	"\x1B",
	".",
	"/",
	"=",
	""
];
//#endregion
//#region ../src/lib/rtty/decoder.ts
var RTTYDecoder$1 = class {
	constructor(sampleRate, config) {
		this.mCos = 1;
		this.mSin = 0;
		this.mDCos = 1;
		this.mDSin = 0;
		this.sCos = 1;
		this.sSin = 0;
		this.sDCos = 1;
		this.sDSin = 0;
		this.mI1 = 0;
		this.mQ1 = 0;
		this.mI2 = 0;
		this.mQ2 = 0;
		this.sI1 = 0;
		this.sQ1 = 0;
		this.sI2 = 0;
		this.sQ2 = 0;
		this.lpfAlpha = .01;
		this.samplesPerBit = 882;
		this.samplesUntilSample = 0;
		this.prevSymbol = 1;
		this.fsmState = "IDLE";
		this.dataBits = 0;
		this.bitIndex = 0;
		this.inFigs = false;
		this.sampleRate = sampleRate;
		this.config = { ...config };
		this.reconfigure();
	}
	updateConfig(config) {
		this.config = { ...config };
		this.reconfigure();
		this.fsmState = "IDLE";
	}
	reconfigure() {
		const { centerFreq, carrierShift, baudRate } = this.config;
		const Fs = this.sampleRate;
		const halfShift = carrierShift / 2;
		const markF = this.config.reverseShift ? centerFreq + halfShift : centerFreq - halfShift;
		const spaceF = this.config.reverseShift ? centerFreq - halfShift : centerFreq + halfShift;
		const mW = 2 * Math.PI * markF / Fs;
		const sW = 2 * Math.PI * spaceF / Fs;
		this.mDCos = Math.cos(mW);
		this.mDSin = Math.sin(mW);
		this.sDCos = Math.cos(sW);
		this.sDSin = Math.sin(sW);
		const cutoff = Math.max(baudRate * .6, Math.min(carrierShift / 3, baudRate * 4));
		this.lpfAlpha = 1 - Math.exp(-2 * Math.PI * cutoff / Fs);
		this.samplesPerBit = Fs / baudRate;
	}
	advanceOscillators() {
		let t;
		t = this.mDCos * this.mCos - this.mDSin * this.mSin;
		this.mSin = this.mDSin * this.mCos + this.mDCos * this.mSin;
		this.mCos = t;
		t = this.sDCos * this.sCos - this.sDSin * this.sSin;
		this.sSin = this.sDSin * this.sCos + this.sDCos * this.sSin;
		this.sCos = t;
	}
	lpf(x, y) {
		return y + this.lpfAlpha * (x - y);
	}
	demodSample(sample) {
		this.advanceOscillators();
		const mI0 = sample * this.mCos, mQ0 = sample * this.mSin;
		const sI0 = sample * this.sCos, sQ0 = sample * this.sSin;
		this.mI1 = this.lpf(mI0, this.mI1);
		this.mI2 = this.lpf(this.mI1, this.mI2);
		this.mQ1 = this.lpf(mQ0, this.mQ1);
		this.mQ2 = this.lpf(this.mQ1, this.mQ2);
		this.sI1 = this.lpf(sI0, this.sI1);
		this.sI2 = this.lpf(this.sI1, this.sI2);
		this.sQ1 = this.lpf(sQ0, this.sQ1);
		this.sQ2 = this.lpf(this.sQ1, this.sQ2);
		return this.mI2 * this.mI2 + this.mQ2 * this.mQ2 >= this.sI2 * this.sI2 + this.sQ2 * this.sQ2 ? 1 : 0;
	}
	decodeBaudot(code) {
		if (code === 31) {
			this.inFigs = false;
			return "";
		}
		if (code === 27) {
			this.inFigs = true;
			return "";
		}
		const ch = (this.inFigs ? FIGS_TABLE : LTRS_TABLE)[code] ?? "";
		if (!ch) return "";
		const c = ch.charCodeAt(0);
		if (c === 0 || c === 5 || c === 27 || c === 31) return "";
		if (c === 7) return "🔔";
		return ch;
	}
	decodeASCII(code) {
		if (code < 32 || code > 126) return "";
		return String.fromCharCode(code);
	}
	processSamples(samples) {
		let output = "";
		for (let i = 0; i < samples.length; i++) {
			const symbol = this.demodSample(samples[i]);
			if (this.fsmState === "IDLE") {
				if (this.prevSymbol === 1 && symbol === 0) {
					this.samplesUntilSample = Math.round(this.samplesPerBit * 1.5);
					this.dataBits = 0;
					this.bitIndex = 0;
					this.fsmState = "DATA";
				}
				this.prevSymbol = symbol;
				continue;
			}
			this.prevSymbol = symbol;
			if (--this.samplesUntilSample > 0) continue;
			this.samplesUntilSample = Math.round(this.samplesPerBit);
			switch (this.fsmState) {
				case "DATA":
					this.dataBits |= symbol << this.bitIndex;
					if (++this.bitIndex >= this.config.bitsPerChar) this.fsmState = this.config.parity !== "none" ? "PARITY" : "STOP";
					break;
				case "PARITY":
					this.fsmState = "STOP";
					break;
				case "STOP":
					if (symbol === 1) {
						const code = this.dataBits & (1 << this.config.bitsPerChar) - 1;
						output += this.config.bitsPerChar === 5 ? this.decodeBaudot(code) : this.decodeASCII(code);
					}
					this.fsmState = "IDLE";
					break;
			}
		}
		return output;
	}
	reset() {
		this.mCos = 1;
		this.mSin = 0;
		this.sCos = 1;
		this.sSin = 0;
		this.mI1 = 0;
		this.mQ1 = 0;
		this.mI2 = 0;
		this.mQ2 = 0;
		this.sI1 = 0;
		this.sQ1 = 0;
		this.sI2 = 0;
		this.sQ2 = 0;
		this.samplesUntilSample = 0;
		this.prevSymbol = 1;
		this.fsmState = "IDLE";
		this.dataBits = 0;
		this.bitIndex = 0;
		this.inFigs = false;
	}
};
//#endregion
//#region src/lib/rtty/multiProcessor.svelte.ts
function createMultiRTTYProcessor(onText) {
	const state = {
		isRecording: false,
		status: "idle",
		snr: null,
		signalStrength: 0,
		errorMessage: null
	};
	let audioContext = null;
	let stream = null;
	let source = null;
	let processor = null;
	let analyser = null;
	let snrInterval = null;
	const decoders = /* @__PURE__ */ new Map();
	const configs = /* @__PURE__ */ new Map();
	let activeId = "";
	function getAnalyser() {
		return analyser;
	}
	function addSession(id, config) {
		configs.set(id, { ...config });
		if (audioContext) decoders.set(id, new RTTYDecoder$1(audioContext.sampleRate, config));
	}
	function removeSession(id) {
		configs.delete(id);
		decoders.delete(id);
	}
	function updateSessionConfig(id, config) {
		configs.set(id, { ...config });
		decoders.get(id)?.updateConfig(config);
	}
	function resetSession(id) {
		decoders.get(id)?.reset();
	}
	function setActiveSession(id) {
		activeId = id;
	}
	function computeSNR() {
		if (!analyser || !audioContext) return;
		const buf = new Uint8Array(analyser.frequencyBinCount);
		analyser.getByteFrequencyData(buf);
		const hzPerBin = audioContext.sampleRate / 2 / analyser.frequencyBinCount;
		const cfg = configs.get(activeId);
		if (!cfg) return;
		const halfShift = cfg.carrierShift / 2;
		const markF = cfg.reverseShift ? cfg.centerFreq + halfShift : cfg.centerFreq - halfShift;
		const spaceF = cfg.reverseShift ? cfg.centerFreq - halfShift : cfg.centerFreq + halfShift;
		const bw = cfg.baudRate;
		const bandEnergy = (lo, hi) => {
			const b0 = Math.max(0, Math.round(lo / hzPerBin));
			const b1 = Math.min(buf.length - 1, Math.round(hi / hzPerBin));
			if (b1 <= b0) return 0;
			let sum = 0;
			for (let k = b0; k <= b1; k++) sum += buf[k];
			return sum / (b1 - b0 + 1);
		};
		const signalE = Math.max(bandEnergy(markF - bw, markF + bw), bandEnergy(spaceF - bw, spaceF + bw));
		const noiseE = (bandEnergy(Math.max(0, spaceF - bw * 5), Math.max(0, spaceF - bw * 2)) + bandEnergy(markF + bw * 2, markF + bw * 5)) / 2;
		const strength = signalE / 255;
		const snr = noiseE > 1 ? 20 * Math.log10(signalE / noiseE) : null;
		state.snr = snr;
		state.signalStrength = strength;
		state.status = strength > .15 ? "receiving" : "syncing";
	}
	async function startRecording() {
		try {
			const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: {
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false
			} });
			stream = mediaStream;
			const ctx = new AudioContext();
			audioContext = ctx;
			const sampleRate = ctx.sampleRate;
			decoders.clear();
			configs.forEach((config, id) => {
				decoders.set(id, new RTTYDecoder$1(sampleRate, config));
			});
			const analyserNode = ctx.createAnalyser();
			analyserNode.fftSize = 2048;
			analyserNode.smoothingTimeConstant = .75;
			analyser = analyserNode;
			const sourceNode = ctx.createMediaStreamSource(mediaStream);
			source = sourceNode;
			const processorNode = ctx.createScriptProcessor(4096, 1, 1);
			processor = processorNode;
			processorNode.onaudioprocess = (e) => {
				const input = e.inputBuffer.getChannelData(0);
				decoders.forEach((decoder, id) => {
					const text = decoder.processSamples(input);
					if (text) onText(id, text);
				});
			};
			sourceNode.connect(analyserNode);
			sourceNode.connect(processorNode);
			processorNode.connect(ctx.destination);
			snrInterval = setInterval(computeSNR, 200);
			state.isRecording = true;
			state.errorMessage = null;
			state.status = "syncing";
		} catch (err) {
			state.isRecording = false;
			state.status = "error";
			state.errorMessage = err instanceof Error ? err.message : "Microphone access failed";
		}
	}
	function stopRecording() {
		if (snrInterval) {
			clearInterval(snrInterval);
			snrInterval = null;
		}
		processor?.disconnect();
		source?.disconnect();
		analyser?.disconnect();
		stream?.getTracks().forEach((t) => t.stop());
		audioContext?.close();
		processor = null;
		source = null;
		analyser = null;
		stream = null;
		audioContext = null;
		decoders.forEach((d) => d.reset());
		state.isRecording = false;
		state.status = "idle";
		state.snr = null;
		state.signalStrength = 0;
	}
	function destroy() {
		if (snrInterval) clearInterval(snrInterval);
		processor?.disconnect();
		source?.disconnect();
		analyser?.disconnect();
		stream?.getTracks().forEach((t) => t.stop());
		audioContext?.close();
	}
	return {
		get state() {
			return state;
		},
		startRecording,
		stopRecording,
		addSession,
		removeSession,
		updateSessionConfig,
		resetSession,
		setActiveSession,
		getAnalyser,
		destroy
	};
}
//#endregion
//#region src/lib/rtty/sessionsStore.svelte.ts
function createSessionsStore(initialConfig) {
	const initialSession = makeSession(initialConfig);
	const state = {
		sessions: [initialSession],
		activeSessionId: initialSession.id
	};
	function dispatch(action) {
		const next = sessionsReducer(state, action);
		state.sessions = next.sessions;
		state.activeSessionId = next.activeSessionId;
	}
	return {
		get state() {
			return state;
		},
		dispatch,
		initialSession
	};
}
//#endregion
//#region src/lib/components/GLSpectrogram.svelte
function GLSpectrogram($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { view, gamma, height, minHz = 0, maxHz, bands, bandAlpha = .3, markers, sqlLevel, sqlAlpha = .3, sqlGridSize, vfoFrequency = 0, txMarkerHz } = $$props;
		const TEX_W = 512;
		const BG = [
			.051,
			.067,
			.09
		];
		const SQL_COLOR = [
			.89,
			.7,
			.25
		];
		const MAX_BANDS = 8;
		const TERRAIN_X = 192;
		const TERRAIN_Z = 56;
		`${BG[0]}${BG[1]}${BG[2]}`;
		`${SQL_COLOR[0]}${SQL_COLOR[1]}${SQL_COLOR[2]}`;
		function formatHz(hz) {
			if (hz >= 1e3) return `${hz % 1e3 === 0 ? hz / 1e3 : (hz / 1e3).toFixed(1)}k`;
			return String(hz);
		}
		const TERRAIN_CAM = {
			az: 0,
			el: Math.PI / 4,
			dist: 2.6,
			tx: 0,
			tz: 0
		};
		let rowInterval = 33;
		const terrainHeights = new Float32Array(TERRAIN_X * TERRAIN_Z);
		const terrainPrev = new Float32Array(TERRAIN_X * TERRAIN_Z);
		const terrainLerped = new Float32Array(TERRAIN_X * TERRAIN_Z);
		let lastPushTime = 0;
		new Float32Array(MAX_BANDS * 2), new Float32Array(MAX_BANDS * 3), new Float32Array(MAX_BANDS);
		({ ...TERRAIN_CAM });
		new Uint8Array(TEX_W);
		new Float32Array(TEX_W);
		const span = derived(() => maxHz - minHz);
		derived(() => span() > 2e3 ? 250 : 125);
		const gridMajorHz = derived(() => span() > 2e3 ? 1e3 : 500);
		const labels = derived(() => {
			const out = [];
			const firstMaj = Math.ceil(minHz / gridMajorHz()) * gridMajorHz();
			for (let hz = firstMaj; hz < maxHz; hz += gridMajorHz()) {
				let text;
				if (vfoFrequency > 0) {
					const absHz = vfoFrequency + hz;
					const mhzInt = Math.floor(absHz / 1e6);
					const khzFrac = Math.round(absHz % 1e6 / 1e3);
					text = `${mhzInt}.${String(khzFrac).padStart(3, "0")}`;
				} else text = formatHz(hz);
				out.push({
					x: (hz - minHz) / span(),
					text
				});
			}
			return out;
		});
		function pushRow(data) {}
		function render() {
			const t = Math.min((performance.now() - lastPushTime) / rowInterval, 1);
			for (let i = 0; i < terrainLerped.length; i++) terrainLerped[i] = terrainPrev[i] + (terrainHeights[i] - terrainPrev[i]) * t;
		}
		function setSmooth(alpha) {}
		function setRowInterval(ms) {
			rowInterval = ms;
		}
		$$renderer.push(`<canvas width="640"${attr("height", height)}${attr_style(`height: ${stringify(height)}px`)} class="block w-full rounded border border-[#30363d] bg-[#0d1117] select-none"></canvas> <!--[-->`);
		const each_array = ensure_array_like(labels());
		for (let i = 0, $$length = each_array.length; i < $$length; i++) {
			let lb = each_array[i];
			$$renderer.push(`<span class="pointer-events-none absolute text-[9px] font-mono text-[#8b949e] select-none" style="display: none; transform: translateX(-50%); text-shadow: 0 0 4px #0d1117, 0 0 4px #0d1117">${escape_html(lb.text)}</span>`);
		}
		$$renderer.push(`<!--]--> <!--[-->`);
		const each_array_1 = ensure_array_like(markers ?? []);
		for (let i = 0, $$length = each_array_1.length; i < $$length; i++) {
			let mk = each_array_1[i];
			$$renderer.push(`<div class="pointer-events-none absolute"${attr_style(`display: none; width: 1px; transform: translateX(-50%); background: ${stringify(mk.color)}; opacity: 0.55; box-shadow: 0 0 3px ${stringify(mk.color)}`)}></div>`);
		}
		$$renderer.push(`<!--]--> <div class="pointer-events-none absolute" style="display: none; width: 2px; transform: translateX(-50%); background: rgba(88,166,255,0.75); box-shadow: 0 0 4px rgba(88,166,255,0.5)"></div> <div class="pointer-events-none absolute right-2 bottom-1.5 text-[9px] font-mono text-[#484f58] select-none">drag rotate · shift+drag pan · scroll zoom · dblclick reset</div> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]-->`);
		bind_props($$props, {
			pushRow,
			render,
			setSmooth,
			setRowInterval
		});
	});
}
//#endregion
//#region src/lib/components/AudioAnalysisPanel.svelte
function AudioAnalysisPanel($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		const CANVAS_H = 200;
		let { analyser, isRecording, markers = [], onMarkerDrag, squelch = 0, onSquelchChange, showGrid = false, gridSize = 48, defaultMaxHz = 3e3, glBands, vfoFrequency, txMarkerHz, class: className, style, storageKeyPrefix } = $$props;
		storageKeyPrefix && `${storageKeyPrefix}`;
		storageKeyPrefix && `${storageKeyPrefix}`;
		let displayMinHz = 0;
		let displayMaxHz = defaultMaxHz;
		let sgView = "legacy";
		let sgGamma = 2;
		let sg3dSpeed = 80;
		let sg2dSpeed = 16;
		let sg3dSmooth = .35;
		let bandAlpha = .3;
		let sgH = 300;
		const centerFreq = derived(() => markers.length ? Math.round(markers.reduce((s, m) => s + m.freq, 0) / markers.length) : Math.round((displayMinHz + displayMaxHz) / 2));
		const glBandsComputed = derived(() => glBands ? glBands.map((ch) => {
			const halfBw = 40;
			return {
				fromHz: ch.freq - halfBw,
				toHz: ch.freq + halfBw,
				color: ch.color
			};
		}) : markers.map((m) => {
			const halfBw = m.bandwidthHz != null ? m.bandwidthHz / 2 : 40;
			return {
				fromHz: m.freq - halfBw,
				toHz: m.freq + halfBw,
				color: m.color
			};
		}));
		const glMarkers = derived(() => markers.map((m) => ({
			fromHz: m.freq,
			toHz: m.freq,
			color: m.color
		})));
		$$renderer.push(`<div${attr_class(`flex flex-col rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4${className ? ` ${className}` : ""}`)}${attr_style(style)}><div class="mb-2 shrink-0"><h2 class="text-lg font-semibold sm:text-xl">Audio Analysis</h2></div> <div class="shrink-0">`);
		if (markers.length > 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="mb-1.5 flex items-center gap-2 text-xs text-[#8b949e]"><span class="shrink-0">Center</span> `);
			if (vfoFrequency) {
				$$renderer.push("<!--[0-->");
				const absHz = vfoFrequency + centerFreq();
				const mhzInt = Math.floor(absHz / 1e6);
				const khzFrac = Math.round(absHz % 1e6 / 1e3);
				$$renderer.push(`<span class="w-24 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-xs text-[#c9d1d9]">${escape_html(mhzInt)}.${escape_html(String(khzFrac).padStart(3, "0"))}</span>`);
			} else {
				$$renderer.push("<!--[-1-->");
				$$renderer.push(`<input type="number" min="50"${attr("max", displayMaxHz)} step="1"${attr("value", centerFreq())}${attr("readonly", !onMarkerDrag, true)}${attr_class(`w-20 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none ${!onMarkerDrag ? "cursor-default opacity-60" : ""}`)}/>`);
			}
			$$renderer.push(`<!--]--> <span class="shrink-0 text-[#484f58]">${escape_html(vfoFrequency ? "MHz" : "Hz")}</span> <span class="ml-auto text-[10px] text-[#484f58]">${escape_html(markers.length)} marker${escape_html(markers.length !== 1 ? "s" : "")}</span></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <canvas width="640"${attr("height", CANVAS_H)}${attr_class(`block w-full touch-manipulation rounded border border-[#30363d] bg-[#0a0a0a] ${onMarkerDrag ? "cursor-ew-resize" : onSquelchChange ? "cursor-ns-resize" : "cursor-crosshair"}`)}></canvas> <div class="mt-1 flex items-center gap-1.5 text-[10px] text-[#8b949e]"><span class="shrink-0">View</span> <input type="number" min="0"${attr("max", displayMaxHz - 100)} step="100"${attr("value", displayMinHz)} class="w-16 rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"/> <span class="shrink-0 text-[#484f58]">–</span> <input type="number"${attr("min", 100)} max="24000" step="100"${attr("value", displayMaxHz)} class="w-16 rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"/> <span class="shrink-0 text-[#484f58]">Hz</span> <!--[-->`);
		const each_array = ensure_array_like([
			1e3,
			2e3,
			3e3,
			4e3
		]);
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let mx = each_array[$$index];
			$$renderer.push(`<button${attr_class(`rounded border px-1.5 py-0.5 text-[9px] transition-colors ${displayMaxHz === mx ? "border-[#2ea043]/50 bg-[#238636]/20 text-[#2ea043]" : "border-[#30363d] text-[#484f58] hover:text-[#8b949e]"}`)}>${escape_html(mx / 1e3)}k</button>`);
		}
		$$renderer.push(`<!--]--></div> <div class="mt-0.5 flex items-center justify-between">`);
		if (onSquelchChange) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="flex items-center gap-2 text-xs text-[#8b949e]"><span class="shrink-0">Squelch</span> <input type="range" min="0" max="100" step="1"${attr("value", squelch)} class="w-24 accent-[#e3b341]"/> <span class="w-8 shrink-0 text-right font-mono text-[#e3b341]">${escape_html(squelch)}%</span></div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<p class="text-[10px] text-[#484f58]">${escape_html(isRecording ? "Receiving audio" : "Start decoding to see spectrum")}</p>`);
		}
		$$renderer.push(`<!--]--></div></div> <div class="mt-3 flex min-h-0 flex-1 flex-col gap-2"><h3 class="shrink-0 text-xs font-medium text-[#8b949e]">Spectrogram</h3> <div class="relative min-h-[100px] flex-1"><div${attr_class(`relative ${sgView === "legacy" ? "block" : "hidden"}`)}><canvas width="640"${attr("height", sgH)}${attr_style(`height: ${stringify(sgH)}px`)} class="block w-full rounded border border-[#30363d] bg-[#0d1117]"></canvas> <canvas width="640"${attr("height", sgH)}${attr_style(`height: ${stringify(sgH)}px`)} class="pointer-events-none absolute inset-0 w-full"></canvas></div> <div${attr_class(clsx(sgView !== "legacy" ? "block" : "hidden"))}>`);
		GLSpectrogram($$renderer, {
			view: "terrain",
			gamma: sgGamma,
			height: sgH,
			maxHz: displayMaxHz,
			minHz: displayMinHz,
			bands: glBandsComputed(),
			bandAlpha,
			markers: glMarkers(),
			sqlLevel: onSquelchChange != null ? squelch / 100 : void 0,
			sqlAlpha: .6,
			sqlGridSize: showGrid ? gridSize : void 0,
			vfoFrequency,
			txMarkerHz
		});
		$$renderer.push(`<!----></div></div> <div class="flex flex-wrap items-center gap-3 text-xs text-[#8b949e]"><label class="flex items-center gap-1.5">View `);
		$$renderer.select({
			value: sgView,
			onchange: (e) => sgView = e.currentTarget.value,
			class: "cursor-pointer rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
		}, ($$renderer) => {
			$$renderer.option({ value: "terrain" }, ($$renderer) => {
				$$renderer.push(`3D Terrain`);
			});
			$$renderer.option({ value: "legacy" }, ($$renderer) => {
				$$renderer.push(`Classic 2D`);
			});
		});
		$$renderer.push(`</label> `);
		if (sgView !== "legacy") {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<label class="flex items-center gap-1.5">Range <input type="range" min="0" max="1" step="0.05"${attr("value", bandAlpha)} class="w-14 accent-[#2ea043]"/></label>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <label class="flex items-center gap-1.5">Contrast <input type="range" min="0.2" max="2.0" step="0.1"${attr("value", sgGamma)} class="w-14 accent-[#2ea043]"/></label> `);
		if (sgView === "legacy") {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<label class="flex items-center gap-1.5">Speed `);
			$$renderer.select({
				value: sg2dSpeed,
				onchange: (e) => sg2dSpeed = parseInt(e.currentTarget.value),
				class: "cursor-pointer rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
			}, ($$renderer) => {
				$$renderer.option({ value: 16 }, ($$renderer) => {
					$$renderer.push(`Fast`);
				});
				$$renderer.option({ value: 50 }, ($$renderer) => {
					$$renderer.push(`Normal`);
				});
				$$renderer.option({ value: 150 }, ($$renderer) => {
					$$renderer.push(`Slow`);
				});
				$$renderer.option({ value: 500 }, ($$renderer) => {
					$$renderer.push(`Very Slow`);
				});
			});
			$$renderer.push(`</label>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<label class="flex items-center gap-1.5">Speed `);
			$$renderer.select({
				value: sg3dSpeed,
				onchange: (e) => sg3dSpeed = parseInt(e.currentTarget.value),
				class: "cursor-pointer rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
			}, ($$renderer) => {
				$$renderer.option({ value: 80 }, ($$renderer) => {
					$$renderer.push(`Normal`);
				});
				$$renderer.option({ value: 200 }, ($$renderer) => {
					$$renderer.push(`Slow`);
				});
				$$renderer.option({ value: 500 }, ($$renderer) => {
					$$renderer.push(`Very Slow`);
				});
				$$renderer.option({ value: 1200 }, ($$renderer) => {
					$$renderer.push(`Paused`);
				});
			});
			$$renderer.push(`</label> <label class="flex items-center gap-1.5">Smooth <input type="range" min="0.05" max="1" step="0.05"${attr("value", sg3dSmooth)} class="w-14 accent-[#2ea043]"/></label>`);
		}
		$$renderer.push(`<!--]--></div></div></div>`);
	});
}
//#endregion
//#region ../src/lib/formatFreq.ts
/** Format absolute frequency in Hz with dot-separated thousands groups.
*  e.g. 14225750 → "14.225.750" */
function fmtAbsHz(hz) {
	return Math.round(hz).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
//#endregion
//#region src/lib/components/SessionCard.svelte
function SessionCard($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		const BAUD_RATES = [
			45,
			45.45,
			50,
			65,
			75,
			100,
			110,
			150,
			200,
			300
		];
		const inputCls = "bg-[#0d1117] border border-[#30363d] rounded px-1 py-0.5 text-[#c9d1d9] text-xs font-mono focus:outline-none focus:border-[#2ea043] transition-colors w-full";
		let { session, isActive, canRemove, vfoFrequency, onActivate, onRemove, onConfigChange, onLabelChange, onColorChange } = $$props;
		$$renderer.push(`<div role="button" tabindex="0"${attr_style(`border-color: ${stringify(session.color)}60`)}${attr_class(`min-w-0 overflow-hidden rounded-lg border p-3 transition-all ${isActive ? "cursor-default bg-[#161b22]" : "cursor-pointer bg-[#0d1117] hover:brightness-110"}`)}><div class="mb-2 flex items-center justify-between gap-2"><div class="flex min-w-0 items-center gap-2">`);
		if (isActive) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="shrink-0 font-mono text-[10px] tracking-wide uppercase"${attr_style(`color: ${stringify(session.color)}`)}>● active</span>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <input${attr("value", session.label)} class="min-w-0 flex-1 truncate border-b border-transparent bg-transparent font-mono text-sm text-[#c9d1d9] focus:border-[#30363d] focus:outline-none"/></div> <div class="flex shrink-0 items-center gap-1.5">`);
		if (!isActive) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<button class="rounded border border-[#30363d] px-2 py-0.5 text-xs text-[#8b949e] transition-colors hover:border-[#2ea043]/40 hover:text-[#2ea043]">Promote</button>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (canRemove) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<button class="rounded border border-[#30363d] px-2 py-0.5 text-xs text-[#8b949e] transition-colors hover:border-[#f85149]/40 hover:text-[#f85149]">✕</button>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div></div>  <div class="mb-2 grid grid-cols-2 gap-x-2 gap-y-2"><label class="flex flex-col gap-0.5"><span class="text-[10px] text-[#8b949e]">Carrier Shift (Hz)</span> <input type="number"${attr("value", session.config.carrierShift)} min="1"${attr_class(clsx(inputCls))}/></label> <label class="flex flex-col gap-0.5"><span class="text-[10px] text-[#8b949e]">Center Freq (Hz)</span> `);
		if (vfoFrequency) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="bg-[#0d1117] border border-[#30363d] rounded px-1 py-0.5 text-[#c9d1d9] text-xs font-mono focus:outline-none focus:border-[#2ea043] transition-colors w-full block">${escape_html(fmtAbsHz(vfoFrequency + session.config.centerFreq))}</span>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<input type="number"${attr("value", session.config.centerFreq)} min="0" max="1500"${attr_class(clsx(inputCls))}/>`);
		}
		$$renderer.push(`<!--]--></label> <label class="flex flex-col gap-0.5"><span class="text-[10px] text-[#8b949e]">Baud Rate</span> `);
		$$renderer.select({
			value: session.config.baudRate,
			onchange: (e) => onConfigChange(session.id, { baudRate: parseFloat(e.currentTarget.value) }),
			class: inputCls
		}, ($$renderer) => {
			$$renderer.push(`<!--[-->`);
			const each_array = ensure_array_like(BAUD_RATES);
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let b = each_array[$$index];
				$$renderer.option({ value: b }, ($$renderer) => {
					$$renderer.push(`${escape_html(b)}`);
				});
			}
			$$renderer.push(`<!--]-->`);
		});
		$$renderer.push(`</label> <div class="flex flex-col gap-0.5"><span class="text-[10px] text-[#8b949e]">Sideband</span> <button${attr_class(`rounded border px-2 py-0.5 text-xs transition-colors ${session.config.reverseShift ? "border-[#f0883e]/50 bg-[#f0883e]/10 text-[#f0883e]" : "border-[#30363d] bg-[#0d1117] text-[#8b949e] hover:border-[#58a6ff]/40 hover:text-[#58a6ff]"}`)}>${escape_html(session.config.reverseShift ? "LSB" : "USB")}</button></div></div>  <div class="mb-2 flex flex-wrap gap-1"><!--[-->`);
		const each_array_1 = ensure_array_like(PASTEL_COLORS);
		for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
			let c = each_array_1[$$index_1];
			$$renderer.push(`<button${attr("title", c)}${attr_style(`background-color: ${stringify(c)}; outline: ${c === session.color ? `2px solid ${c}` : "none"}; outline-offset: 2px; transform: ${c === session.color ? "scale(1.25)" : "scale(1)"}`)} class="h-4 w-4 rounded-full transition-all"></button>`);
		}
		$$renderer.push(`<!--]--></div> <div${attr_class(`overflow-hidden rounded px-2 py-1.5 font-mono text-xs ${isActive ? "bg-[#0d1117]" : "bg-[#0a0a0a]"}`)} style="height: 3rem"><div>`);
		if (session.preview) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="break-all whitespace-pre-wrap"${attr_style(`color: ${stringify(session.color)}`)}>${escape_html(session.preview)}</span>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<span class="text-[#30363d]">No output yet…</span>`);
		}
		$$renderer.push(`<!--]--></div></div></div>`);
	});
}
//#endregion
//#region src/lib/components/RTTYDecoder.svelte
function RTTYDecoder($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		const DISPLAY_MAX_HZ = 1500;
		const DEFAULT_PANEL_WEIGHTS = [
			1,
			1,
			1
		];
		const DEFAULT_CONFIG = {
			centerFreq: 500,
			carrierShift: 450,
			baudRate: 50,
			bitsPerChar: 5,
			parity: "none",
			stopBits: 1.5,
			reverseShift: false
		};
		let { analyser = null, vfoFrequency, onStateChange } = $$props;
		const sessions = createSessionsStore(DEFAULT_CONFIG);
		sessions.initialSession;
		const processor = createMultiRTTYProcessor((sessionId, chars) => {
			sessions.dispatch({
				type: "APPEND_TEXT",
				id: sessionId,
				chars
			});
		});
		const activeSession = derived(() => sessions.state.sessions.find((s) => s.id === sessions.state.activeSessionId) ?? sessions.state.sessions[0]);
		const activeConfig = derived(() => activeSession().config);
		let panelWeights = [...DEFAULT_PANEL_WEIGHTS];
		activeConfig().centerFreq;
		activeConfig().carrierShift;
		activeConfig().baudRate;
		activeConfig().reverseShift;
		onDestroy(() => processor.destroy());
		sessions.state.sessions.length;
		function removeSession(id) {
			sessions.dispatch({
				type: "REMOVE_SESSION",
				id
			});
			processor.removeSession(id);
		}
		function promoteSession(id) {
			sessions.dispatch({
				type: "ACTIVATE",
				id
			});
			processor.setActiveSession(id);
		}
		function updateSessionConfig(id, patch) {
			sessions.dispatch({
				type: "UPDATE_CONFIG",
				id,
				patch
			});
			const current = sessions.state.sessions.find((s) => s.id === id)?.config;
			if (current) processor.updateSessionConfig(id, {
				...current,
				...patch
			});
		}
		function updateSessionColor(id, color) {
			sessions.dispatch({
				type: "UPDATE_COLOR",
				id,
				color
			});
		}
		const markFreq = derived(() => Math.round(activeConfig().reverseShift ? activeConfig().centerFreq + activeConfig().carrierShift / 2 : activeConfig().centerFreq - activeConfig().carrierShift / 2));
		const spaceFreq = derived(() => Math.round(activeConfig().reverseShift ? activeConfig().centerFreq - activeConfig().carrierShift / 2 : activeConfig().centerFreq + activeConfig().carrierShift / 2));
		const halfBW = derived(() => activeConfig().baudRate / 2);
		const spectrumMarkers = derived(() => [{
			freq: markFreq(),
			color: "#58a6ff",
			label: "M",
			bandwidthHz: halfBW() * 2
		}, {
			freq: spaceFreq(),
			color: "#f0883e",
			label: "S",
			bandwidthHz: halfBW() * 2
		}]);
		async function handleStart() {
			await processor.startRecording();
		}
		function handleStop() {
			processor.stopRecording();
		}
		function handleReset() {
			processor.resetSession(sessions.state.activeSessionId);
			sessions.dispatch({
				type: "CLEAR_TEXT",
				id: sessions.state.activeSessionId
			});
		}
		function start() {
			return handleStart();
		}
		function stop() {
			handleStop();
		}
		function reset() {
			handleReset();
		}
		function isRecording() {
			return processor.state.isRecording;
		}
		function isSupported() {
			return typeof window !== "undefined" && !!(window.AudioContext ?? window.webkitAudioContext);
		}
		function error() {
			return processor.state.errorMessage;
		}
		$$renderer.push(`<div class="space-y-4 sm:space-y-6"><div class="flex flex-col gap-4 lg:flex-row lg:items-stretch lg:gap-0"><div class="flex min-w-0 flex-col rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4"${attr_style(`flex: ${stringify(panelWeights[0])}`)}><div class="mb-2 flex items-center justify-between sm:mb-3"><h2 class="text-lg font-semibold sm:text-xl">RTTY Output `);
		if (sessions.state.sessions.length > 1) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="ml-2 text-xs font-normal text-[#8b949e]">— ${escape_html(activeSession().label)}</span>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></h2> <div class="flex items-center gap-3"><span class="font-mono text-xs text-[#8b949e]">${escape_html(activeSession().fullText.length)} chars</span> <button${attr("disabled", !activeSession().fullText, true)} class="rounded border border-[#30363d] px-2 py-0.5 text-xs text-[#8b949e] transition-colors hover:border-[#f85149]/40 hover:text-[#f85149] disabled:cursor-not-allowed disabled:opacity-30">Clear</button></div></div> <textarea readonly="" placeholder="Decoded RTTY text will appear here..."${attr_style(`color: ${stringify(activeSession().color)}`)} class="min-h-[300px] w-full flex-1 resize-none rounded border border-[#30363d] bg-[#0d1117] p-3 font-mono text-sm leading-snug placeholder:text-[#30363d] focus:outline-none">`);
		const $$body = escape_html(activeSession().fullText);
		if ($$body) $$renderer.push(`${$$body}`);
		$$renderer.push(`</textarea></div>  <div role="separator" aria-orientation="vertical" class="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch lg:flex"><div class="h-full w-px bg-[#30363d] transition-colors group-hover:bg-[#2ea043]/50"></div></div> `);
		AudioAnalysisPanel($$renderer, {
			analyser,
			isRecording: processor.state.isRecording,
			defaultMaxHz: DISPLAY_MAX_HZ,
			storageKeyPrefix: "rtty",
			markers: spectrumMarkers(),
			onMarkerDrag: (idx, newHz) => {
				const half = activeConfig().carrierShift / 2;
				const newCenter = idx === 0 ? activeConfig().reverseShift ? newHz - half : newHz + half : activeConfig().reverseShift ? newHz + half : newHz - half;
				updateSessionConfig(sessions.state.activeSessionId, { centerFreq: Math.round(newCenter) });
			},
			vfoFrequency,
			class: "min-w-0",
			style: `flex: ${stringify(panelWeights[1])}`
		});
		$$renderer.push(`<!---->  <div role="separator" aria-orientation="vertical" class="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch lg:flex"><div class="h-full w-px bg-[#30363d] transition-colors group-hover:bg-[#2ea043]/50"></div></div> <div class="min-w-0 rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4"${attr_style(`flex: ${stringify(panelWeights[2])}`)}><div class="mb-3 flex items-center justify-between"><h2 class="text-lg font-semibold sm:text-xl">Decoder Sessions</h2> <div class="relative"><button class="flex items-center gap-1 rounded-md border border-[#238636]/40 bg-[#238636]/10 px-2.5 py-1 font-mono text-xs text-[#2ea043] transition-colors hover:border-[#238636]/60 hover:bg-[#238636]/20"><svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"></path></svg> Add</button> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div></div> <div class="grid grid-cols-2 gap-2"><!--[-->`);
		const each_array_2 = ensure_array_like(sessions.state.sessions);
		for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
			let session = each_array_2[$$index_2];
			SessionCard($$renderer, {
				session,
				isActive: session.id === sessions.state.activeSessionId,
				canRemove: sessions.state.sessions.length > 1,
				vfoFrequency,
				onActivate: promoteSession,
				onRemove: removeSession,
				onConfigChange: updateSessionConfig,
				onLabelChange: (id, label) => sessions.dispatch({
					type: "UPDATE_LABEL",
					id,
					label
				}),
				onColorChange: updateSessionColor
			});
		}
		$$renderer.push(`<!--]--></div></div></div> <details class="rounded-lg border border-[#30363d] bg-[#161b22]"><summary class="cursor-pointer rounded-lg p-4 text-lg font-semibold transition-colors select-none hover:bg-[#21262d] sm:p-6 sm:text-xl">How to Use</summary> <div class="px-4 pb-4 sm:px-6 sm:pb-6"><ol class="list-inside list-decimal space-y-2 text-sm text-[#c9d1d9] sm:text-base"><li>Click "Start Decoding" to begin capturing audio from your microphone</li> <li>Tune your radio to an RTTY signal (typically 45 or 50 baud, 170 or 450 Hz shift)</li> <li>On the Spectrum panel, click and drag to position the <span class="font-mono text-[#58a6ff]">M</span> (mark) and <span class="font-mono text-[#f0883e]">S</span> (space) markers over the two signal
					peaks</li> <li>Adjust Carrier Shift and Baud Rate in the configuration panel to match the transmission</li> <li>Use <strong>Add Decoder</strong> to run multiple decoders simultaneously with different settings
					— promote the best one to take over the main output</li> <li>Decoded text will appear in the terminal output area as characters are received</li> <li>Click "Copy Text" to copy the decoded output to clipboard</li></ol> <p class="mt-4 text-xs text-[#8b949e] sm:text-sm">Tip: On the spectrogram, an RTTY signal appears as two persistent vertical lines — align the
				M/S markers with those lines using the spectrum panel.</p></div></details> <details class="rounded-lg border border-[#30363d] bg-[#161b22]"><summary class="cursor-pointer rounded-lg p-4 text-lg font-semibold transition-colors select-none hover:bg-[#21262d] sm:p-6 sm:text-xl">Privacy</summary> <div class="space-y-3 px-4 pb-4 text-sm text-[#c9d1d9] sm:px-6 sm:pb-6 sm:text-base"><p>This application runs entirely in your browser. No audio data or decoded text is ever
				transmitted to any server.</p> <p>The microphone permission is only used to capture and process the audio signal in real-time
				for RTTY decoding using the Web Audio API.</p> <p class="text-xs text-[#8b949e] sm:text-sm">Your privacy is fully protected — we don't collect, store, or transmit any of your data.</p></div></details></div>`);
		bind_props($$props, {
			start,
			stop,
			reset,
			isRecording,
			isSupported,
			error
		});
	});
}
//#endregion
//#region src/routes/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let isRecording = false;
		let error = null;
		$$renderer.push(`<main class="flex h-screen flex-col overflow-hidden"><div class="px-4 pt-4 pb-3 sm:px-6 sm:pt-6 lg:px-8 lg:pt-8"><h1 class="mb-1 text-2xl font-bold text-[#c9d1d9] sm:text-3xl lg:text-4xl">Radio Signal Decoder <span class="text-base font-normal text-[#8b949e]">(SvelteKit prototype — RTTY only)</span></h1> <p class="text-sm text-[#8b949e] sm:text-base">Real-time Radioteletype signal decoder from microphone</p></div> <div class="px-4 pb-2 sm:px-6 lg:px-8"><div class="flex items-center gap-3 rounded-lg border border-[#30363d] bg-[#161b22] px-4 py-3">`);
		if (!isRecording) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<button${attr("disabled", true, true)} class="flex items-center gap-2 rounded-md bg-[#238636] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-50">Start Decoding</button>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<button class="flex items-center gap-2 rounded-md bg-[#da3633] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#f85149]">Stop</button>`);
		}
		$$renderer.push(`<!--]--> <button class="flex items-center gap-1.5 rounded-md border border-[#30363d] bg-[#21262d] px-4 py-2 text-sm font-semibold text-[#c9d1d9] transition-colors hover:bg-[#30363d]">Reset</button> `);
		if (error) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="ml-auto font-mono text-xs text-[#f85149]">${escape_html(error)}</span>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div></div> <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6 lg:px-8">`);
		RTTYDecoder($$renderer, {
			analyser: globalAudio.analyser,
			onStateChange: (s) => {
				isRecording = s.isRecording;
				error = s.error;
			}
		});
		$$renderer.push(`<!----></div></main>`);
	});
}
//#endregion
export { _page as default };
