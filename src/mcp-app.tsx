/**
 * Pictionary MCP App — React UI
 *
 * Two-panel layout:
 * - Left: Excalidraw canvas showing the drawing (progressively rendered)
 * - Right: Game panel with word blanks, guess input, and status
 *
 * Uses MCP App SDK's ontoolinputpartial for progressive rendering:
 * As the LLM streams Excalidraw elements JSON, partial (healed) JSON
 * is fed to the canvas, making the drawing appear stroke-by-stroke.
 */
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import "./global.css";

// ─── Filler words to skip when matching STT output ───────────────────
const FILLER_WORDS = new Set([
    "the", "a", "an", "is", "it", "i", "me", "my", "we", "he", "she",
    "and", "or", "but", "to", "of", "in", "on", "at", "for", "so",
    "um", "uh", "like", "just", "that", "this", "with", "do", "does",
    "was", "are", "be", "been", "not", "no", "yes", "yeah", "ok",
    "its", "am", "if", "as", "by", "up", "oh", "ah", "hmm",
]);

// ─── useAudioGuess Hook ─────────────────────────────────────────────
interface AudioGuessOpts {
    wordLength: number;
    onWordMatch: (word: string) => void;
    enabled: boolean;
}

function useAudioGuess({ wordLength, onWordMatch, enabled }: AudioGuessOpts) {
    const [isListening, setIsListening] = useState(false);
    const [liveTranscript, setLiveTranscript] = useState("");
    const [audioError, setAudioError] = useState<string | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    const matchedRef = useRef(false);
    const enabledRef = useRef(enabled);
    const timeoutRef = useRef<number | null>(null);

    // Keep enabledRef in sync
    useEffect(() => { enabledRef.current = enabled; }, [enabled]);

    const cleanup = useCallback(() => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current = null;
        }
        if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
            audioCtxRef.current.close().catch(() => { });
            audioCtxRef.current = null;
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        setIsListening(false);
        setLiveTranscript("");
    }, []);

    const start = useCallback(async () => {
        setAudioError(null);
        matchedRef.current = false;

        try {
            // 1. Request mic
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            // 2. Open WebSocket to our backend proxy instead of direct to ElevenLabs
            // The MCP app is hosted in an iframe by basic-host on port 8081, but the 
            // backend MCP server is running on port 3001. So we must hardcode the port.
            const wsUrl = `ws://localhost:3001/api/stt`;
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = () => {
                console.log("[AudioGuess] WebSocket connected");
                setIsListening(true);

                // Auto-stop after 3 minutes
                if (timeoutRef.current) clearTimeout(timeoutRef.current);
                timeoutRef.current = window.setTimeout(() => {
                    console.log("[AudioGuess] 3 minute timeout reached, stopping.");
                    cleanup();
                }, 180000);

                // 3. Start capturing & sending audio
                const audioCtx = new AudioContext({ sampleRate: 16000 });
                audioCtxRef.current = audioCtx;
                const source = audioCtx.createMediaStreamSource(stream);
                const processor = audioCtx.createScriptProcessor(4096, 1, 1);
                processorRef.current = processor;

                source.connect(processor);
                processor.connect(audioCtx.destination);

                processor.onaudioprocess = (e) => {
                    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
                    const float32 = e.inputBuffer.getChannelData(0);
                    const int16 = new Int16Array(float32.length);
                    for (let i = 0; i < float32.length; i++) {
                        const s = Math.max(-1, Math.min(1, float32[i]));
                        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                    const bytes = new Uint8Array(int16.buffer);
                    let binary = "";
                    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
                    const b64 = btoa(binary);
                    wsRef.current.send(JSON.stringify({
                        message_type: "input_audio_chunk",
                        audio_base_64: b64,
                    }));
                };
            };

            ws.onmessage = async (event) => {
                if (matchedRef.current) return;

                try {
                    let textData = event.data;
                    if (textData instanceof Blob) {
                        textData = await textData.text();
                    }
                    const msg = JSON.parse(textData);
                    console.log("[AudioGuess] STT message:", msg);

                    // Different providers use different keys. ElevenLabs might use 'type' or 'message_type'
                    const isTranscript = msg.message_type === "partial_transcript" ||
                        msg.message_type === "committed_transcript" ||
                        msg.type === "partial_transcript" ||
                        msg.type === "committed_transcript" ||
                        msg.type === "realtimeResponse" ||
                        msg.text !== undefined;

                    if (isTranscript) {
                        const text = (msg.text || msg.transcript || "").trim();
                        if (text) {
                            setLiveTranscript(text);
                            // Submit the entire transcribed segment to the backend
                            if (enabledRef.current) {
                                console.log(`[AudioGuess] Submitting phrase: "${text}"`);
                                onWordMatch(text);
                            }
                        }
                    }

                    if (msg.message_type && msg.message_type.includes("error")) {
                        console.error("[AudioGuess] ElevenLabs error:", msg);
                        setAudioError(msg.message_type);
                    }
                } catch (err) {
                    console.error("[AudioGuess] JSON parse error on message:", err, event.data);
                }
            };

            ws.onclose = (e) => {
                console.log("[AudioGuess] WebSocket closed:", e.code, e.reason);
                cleanup();
            };

            ws.onerror = () => {
                setAudioError("WebSocket connection error");
                cleanup();
            };
        } catch (err: any) {
            console.error("[AudioGuess] Start error:", err);
            setAudioError(err.message || "Microphone error");
            cleanup();
        }
    }, [wordLength, onWordMatch, cleanup]);

    // Auto-cleanup if disabled externally
    useEffect(() => {
        if (!enabled && isListening) cleanup();
    }, [enabled, isListening, cleanup]);

    // Cleanup on unmount
    useEffect(() => cleanup, [cleanup]);

    return { isListening, liveTranscript, audioError, start, stop: cleanup };
}

// ─── Types ──────────────────────────────────────────────────────────────

interface DrawInput {
    elements?: string;
}

interface GameState {
    wordLength: number;
    category: string;
    blanks: string;
    attemptsLeft: number;
    won: boolean;
    gameOver: boolean;
}

interface GuessResult {
    correct: boolean;
    blanks: string;
    attemptsLeft: number;
    won: boolean;
    gameOver: boolean;
    word?: string;
}

// ─── MCP App Wrapper ────────────────────────────────────────────────────

function McpAppWrapper() {
    const [toolInputs, setToolInputs] = useState<DrawInput | null>(null);
    const [toolInputsPartial, setToolInputsPartial] = useState<DrawInput | null>(null);
    const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
    const [hostContext, setHostContext] = useState<McpUiHostContext | null>(null);

    const { app, error } = useApp({
        appInfo: { name: "Pictionary", version: "1.0.0" },
        capabilities: {},
        onAppCreated: (app) => {
            // Complete tool input (streaming finished)
            app.ontoolinput = (params) => {
                setToolInputs(params.arguments as DrawInput);
                setToolInputsPartial(null);
            };
            // Partial tool input (streaming in progress — healed JSON)
            app.ontoolinputpartial = (params) => {
                setToolInputsPartial(params.arguments as DrawInput);
            };
            // Tool execution result
            app.ontoolresult = (params) => {
                setToolResult(params as CallToolResult);
            };
            // Host context changes
            app.onhostcontextchanged = (params) => {
                setHostContext((prev) => ({ ...prev, ...params }));
            };
            app.ontoolcancelled = (params) => {
                console.info("Tool cancelled:", params.reason);
            };
            app.onerror = console.error;
        },
    });

    useHostStyles(app);

    useEffect(() => {
        if (app) {
            const ctx = app.getHostContext();
            if (ctx) setHostContext(ctx);
        }
    }, [app]);

    if (error) return <div style={{ padding: 20, color: "#ef4444" }}>Error: {error.message}</div>;
    if (!app) return <div style={{ padding: 20, color: "#8b99b5" }}>Connecting...</div>;

    return (
        <PictionaryApp
            app={app}
            toolInputs={toolInputs}
            toolInputsPartial={toolInputsPartial}
            toolResult={toolResult}
            hostContext={hostContext}
        />
    );
}

// ─── Pictionary Game ────────────────────────────────────────────────────

interface PictionaryProps {
    app: App;
    toolInputs: DrawInput | null;
    toolInputsPartial: DrawInput | null;
    toolResult: CallToolResult | null;
    hostContext: McpUiHostContext | null;
}

function PictionaryApp({ app, toolInputs, toolInputsPartial, toolResult, hostContext }: PictionaryProps) {
    const [gameState, setGameState] = useState<GameState | null>(null);
    const [guess, setGuess] = useState("");
    const [feedback, setFeedback] = useState<{ type: "wrong" | "hint" | "success"; text: string } | null>(null);
    // Store fully-converted Excalidraw elements (already processed by convertToExcalidrawElements)
    const [excalidrawElements, setExcalidrawElements] = useState<any[]>([]);
    const [canvasKey, setCanvasKey] = useState(0);
    const [isStreaming, setIsStreaming] = useState(false);
    const [isNewGameLoading, setIsNewGameLoading] = useState(false);
    const [audioMode, setAudioMode] = useState(true);
    const [pointsWon, setPointsWon] = useState(0);
    const [pointsLost, setPointsLost] = useState(0);
    const [selectedModel, setSelectedModel] = useState("mistral-large-2512");
    const [rating, setRating] = useState<"up" | "down" | null>(null);
    const hasMountedRef = useRef(false);
    const timerRef = useRef<number | null>(null);

    const animationRef = useRef<number | null>(null);
    const excalidrawApiRef = useRef<any>(null);
    const drawWsRef = useRef<WebSocket | null>(null);
    const jsonBufferRef = useRef<string>("");

    // Helper: Heal partial JSON array streamed from LLM
    const healJsonArray = useCallback((partial: string): any[] => {
        let s = partial.trim();
        if (!s.startsWith("[")) {
            // Sometimes it starts with ```json
            if (s.includes("[")) {
                s = s.substring(s.indexOf("["));
            } else {
                return [];
            }
        }

        try { return JSON.parse(s); } catch (e) { }

        // Remove trailing commas
        if (s.endsWith(",")) s = s.slice(0, -1);

        // Try common closures
        try { return JSON.parse(s + "}]"); } catch (e) { }
        try { return JSON.parse(s + "]}"); } catch (e) { }
        try { return JSON.parse(s + "]"); } catch (e) { }

        // Fallback: finding the last complete object
        const lastBrace = s.lastIndexOf("}");
        if (lastBrace > 0) {
            try { return JSON.parse(s.substring(0, lastBrace + 1) + "]"); } catch (e) { }
        }

        return [];
    }, []);

    // Helper: parse -> filter -> convert -> immediate update scene
    const applyElementsInstant = useCallback((rawJson: any[]) => {
        const valid = rawJson.filter(
            (el: any) => el.type && !["cameraUpdate", "delete", "restoreCheckpoint"].includes(el.type)
        );
        if (valid.length > 0) {
            try {
                const full = convertToExcalidrawElements(valid);
                setExcalidrawElements(full);
                if (excalidrawApiRef.current) {
                    excalidrawApiRef.current.updateScene({ elements: full });
                }
            } catch (e) {
                console.error("[Pictionary UI] convertToExcalidrawElements failed:", e);
            }
        }
    }, []);

    // Cleanup WebSockets on unmount
    useEffect(() => {
        return () => {
            if (drawWsRef.current) drawWsRef.current.close();
        };
    }, []);

    // Initial fetch of game state (if reconnected)
    useEffect(() => {
        (async () => {
            try {
                const result = await app.callServerTool({ name: "get_game_state", arguments: {} });
                const text = result.content?.find((c: any) => c.type === "text");
                if (text && "text" in text) {
                    const data = JSON.parse(text.text);
                    setGameState({
                        wordLength: data.wordLength,
                        category: data.category,
                        blanks: data.blanks,
                        attemptsLeft: data.attemptsLeft,
                        won: data.won ?? false,
                        gameOver: data.gameOver ?? false,
                    });
                }
            } catch {
                // Server may not have a game yet
            }
        })();
    }, [app]);

    const submitGuess = useCallback(async (word: string): Promise<boolean> => {
        if (!word.trim() || !gameState || gameState.won || gameState.gameOver) return false;

        try {
            const result = await app.callServerTool({
                name: "check_guess",
                arguments: { guess: word.trim() },
            });
            const text = result.content?.find((c: any) => c.type === "text");
            if (text && "text" in text) {
                const data: GuessResult = JSON.parse(text.text);
                setGameState((prev) =>
                    prev
                        ? {
                            ...prev,
                            blanks: data.blanks,
                            attemptsLeft: data.attemptsLeft,
                            won: data.won,
                            gameOver: data.gameOver,
                        }
                        : prev
                );

                if (data.won) setPointsWon(p => p + 1);
                if (data.gameOver && !data.won) setPointsLost(p => p + 1);

                if (data.correct) {
                    setFeedback({ type: "success", text: `🎉 "${word.trim()}" is correct! Great job!` });
                    return true;
                } else {
                    setFeedback({
                        type: "wrong",
                        text: `"${word.trim()}" is not correct!`,
                    });
                }
            }
        } catch (e) {
            console.error("Guess error:", e);
        }
        return false;
    }, [app, gameState]);

    const handleGuess = useCallback(async () => {
        if (!guess.trim()) return;
        await submitGuess(guess.trim());
        setGuess("");
    }, [guess, submitGuess]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "Enter") handleGuess();
        },
        [handleGuess]
    );

    // Audio guess: when a matching word is spoken, auto-submit it
    const handleAudioWordMatch = useCallback(async (word: string) => {
        setGuess(word);
        await submitGuess(word);
        // Do not toggle setAudioMode(false) here, keep it listening permanently for next game
        setGuess("");
    }, [submitGuess]);

    const audioGuess = useAudioGuess({
        wordLength: gameState?.wordLength ?? 0,
        onWordMatch: handleAudioWordMatch,
        enabled: audioMode && !!(gameState && !gameState.won && !gameState.gameOver),
    });

    const toggleAudio = useCallback(() => {
        if (audioGuess.isListening) {
            audioGuess.stop();
            setAudioMode(false);
        } else {
            setAudioMode(true);
            audioGuess.start();
        }
    }, [audioGuess]);

    const handleNewGame = useCallback(() => {
        if (isNewGameLoading) return;
        setIsNewGameLoading(true);

        // Reset audio state and timer
        if (audioGuess.isListening) {
            audioGuess.stop();
        }
        setAudioMode(false);

        // Reset canvas & streaming state
        if (drawWsRef.current) drawWsRef.current.close();
        jsonBufferRef.current = "";
        setExcalidrawElements([]);
        setCanvasKey(k => k + 1); // Force clear board immediately
        setFeedback(null);
        setGuess("");
        setRating(null); // Reset rating for the new game
        setGameState(null);
        setIsStreaming(true);

        try {
            const wsUrl = `ws://localhost:3001/api/draw-stream?model=${selectedModel}`;
            const ws = new WebSocket(wsUrl);
            drawWsRef.current = ws;
            const startTime = performance.now();
            let elementCount = 0;

            ws.onmessage = (event) => {
                try {
                    const elapsed = Math.round(performance.now() - startTime);
                    const msg = JSON.parse(event.data);

                    if (msg.type === "game_state") {
                        console.log(`[UI Stream] +${elapsed}ms - Got game state`);
                        setGameState({
                            wordLength: msg.wordLength,
                            category: msg.category,
                            blanks: msg.blanks,
                            attemptsLeft: msg.attemptsLeft,
                            won: false,
                            gameOver: false,
                        });
                        setIsNewGameLoading(false); // Game is ready to play

                        // Automatically start audio guess if in audio mode
                        if (audioMode && !audioGuess.isListening) {
                            audioGuess.start();
                        }
                    } else if (msg.type === "chunk" && msg.text) {
                        console.log(`[UI Stream] +${elapsed}ms - Received chunk (${msg.text.length} chars)`);
                        jsonBufferRef.current += msg.text;
                        const partialElements = healJsonArray(jsonBufferRef.current);
                        if (partialElements.length > elementCount) {
                            const newCount = partialElements.length - elementCount;
                            console.log(`[UI Stream] +${elapsed}ms - Parsed ${newCount} new elements (Total: ${partialElements.length})`);
                            applyElementsInstant(partialElements);
                            elementCount = partialElements.length;
                        }
                    } else if (msg.type === "done") {
                        console.log(`[UI Stream] +${elapsed}ms - Stream complete`);
                        setIsStreaming(false);
                        ws.close();
                    }
                } catch (e) {
                    console.error("[Pictionary UI] Error in draw stream message:", e);
                }
            };

            ws.onerror = (err) => {
                console.error("[Pictionary UI] WebSocket error:", err);
                setIsStreaming(false);
                setIsNewGameLoading(false);
            };

            ws.onclose = () => {
                setIsStreaming(false);
                setIsNewGameLoading(false);
            };

        } catch (e) {
            console.error("[Pictionary UI] Failed to start WebSocket streaming:", e);
            setIsNewGameLoading(false);
            setIsStreaming(false);
        }
    }, [isNewGameLoading, applyElementsInstant, healJsonArray, audioGuess, audioMode]);

    // Auto-start new game exactly once on mount
    useEffect(() => {
        if (!hasMountedRef.current) {
            hasMountedRef.current = true;
            if (!gameState && !isStreaming && !isNewGameLoading) {
                handleNewGame();
            }
        }
    }, [handleNewGame, gameState, isStreaming, isNewGameLoading]);

    const isGameActive = gameState && !gameState.won && !gameState.gameOver;

    // 15-second timer per attempt
    useEffect(() => {
        if (!isGameActive) {
            if (timerRef.current) clearInterval(timerRef.current);
            return;
        }

        if (timerRef.current) clearInterval(timerRef.current);

        timerRef.current = window.setInterval(async () => {
            try {
                const result = await app.callServerTool({
                    name: "decrement_attempt",
                    arguments: {},
                });
                const text = result.content?.find((c: any) => c.type === "text");
                if (text && "text" in text) {
                    const data: GuessResult = JSON.parse(text.text);
                    setGameState((prev) =>
                        prev
                            ? {
                                ...prev,
                                blanks: data.blanks,
                                attemptsLeft: data.attemptsLeft,
                                won: data.won,
                                gameOver: data.gameOver,
                            }
                            : prev
                    );

                    if (data.gameOver && !data.won) setPointsLost(p => p + 1);

                    setFeedback({
                        type: "hint",
                        text: "Time's up for that attempt! 15 seconds passed.",
                    });
                }
            } catch (e) {
                console.error("Timeout attempt error:", e);
            }
        }, 15000);

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [isGameActive, app, gameState?.attemptsLeft]);

    const MAX_ATTEMPTS = 6;

    return (
        <div className="app-container">
            <div className="main-content">
                {/* Left: Drawing Canvas */}
                <div className="canvas-panel">
                    {isStreaming && (
                        <div className="streaming-indicator">
                            <span className="streaming-dot" />
                            Drawing...
                        </div>
                    )}
                    {isStreaming || excalidrawElements.length > 0 ? (
                        <div className="canvas-wrapper">
                            <Excalidraw
                                key={canvasKey}
                                excalidrawAPI={(api) => excalidrawApiRef.current = api}
                                initialData={{
                                    elements: excalidrawElements,
                                    appState: {
                                        viewBackgroundColor: "#ffffff",
                                        theme: "light",
                                        viewModeEnabled: true,
                                        zenModeEnabled: true,
                                        gridModeEnabled: false,
                                    },
                                    scrollToContent: true,
                                }}
                                viewModeEnabled={true}
                                zenModeEnabled={true}
                                gridModeEnabled={false}
                                theme="light"
                                UIOptions={{
                                    canvasActions: {
                                        changeViewBackgroundColor: false,
                                        clearCanvas: false,
                                        export: false,
                                        loadScene: false,
                                        saveAsImage: false,
                                        saveToActiveFile: false,
                                        toggleTheme: false,
                                    },
                                }}
                            />
                        </div>
                    ) : (
                        <div className="canvas-placeholder">
                            <div className="icon">
                                <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" /><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" /></svg>
                            </div>
                            <p>Waiting for the drawing...</p>
                            <button
                                className="btn-primary"
                                onClick={handleNewGame}
                                disabled={isNewGameLoading}
                                style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '8px' }}
                            >
                                {isNewGameLoading ? (
                                    <><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spinning"><path d="M5 22h14" /><path d="M5 2h14" /><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" /><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" /></svg> Starting...</>
                                ) : "START NEW ROUND"}
                            </button>
                        </div>
                    )}
                </div>

                {/* Right: Game Panel */}
                <div className="game-panel">
                    {/* Panel header with PICTIONARY title, Mic and New Game buttons always visible */}
                    <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span className="panel-title" style={{ fontSize: '20px', letterSpacing: '2px', color: 'var(--accent-purple)' }}>PICTIONARY</span>
                            <div style={{ display: 'flex', gap: '12px', fontSize: '14px', fontWeight: 'bold' }}>
                                <span style={{ color: 'var(--accent-green)' }}>Won: {pointsWon}</span>
                                <span style={{ color: 'var(--accent-red)' }}>Lost: {pointsLost}</span>
                            </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                            <span className="panel-title" style={{ fontSize: '12px' }}>Guess the word</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <select
                                    value={selectedModel}
                                    onChange={(e) => setSelectedModel(e.target.value)}
                                    disabled={isNewGameLoading || !!(gameState && !gameState.won && !gameState.gameOver)}
                                    className="model-select"
                                    style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-color)', fontSize: '13px' }}
                                >
                                    <option value="gemini">Gemini</option>
                                    <option value="devstral-2512">Devstral</option>
                                    <option value="mistral-large-2512">Mistral Large</option>
                                    <option value="ministral-8b-2410">Ministral 8B</option>
                                    <option value="ministral-8b-2512">Ministral 8B (finetuned)</option>
                                    <option value="ministral-3b-2512">Ministral 3B</option>
                                </select>
                                <button
                                    className={`mic-btn header-mic ${audioGuess.isListening ? "active" : ""}`}
                                    onClick={toggleAudio}
                                    disabled={!gameState || gameState.won || gameState.gameOver}
                                    title={audioGuess.isListening ? "Stop listening" : "Voice guess"}
                                >
                                    {audioGuess.isListening ? (
                                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="12" height="12" x="6" y="6" rx="2" /></svg>
                                    ) : (
                                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" /></svg>
                                    )}
                                </button>
                                <button
                                    id="new-game-btn"
                                    className={`btn-icon ${isNewGameLoading ? "spinning" : ""}`}
                                    onClick={handleNewGame}
                                    disabled={isNewGameLoading}
                                    title="Restart Game"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
                                </button>
                            </div>
                        </div>
                    </div>
                    {gameState ? (
                        <>
                            {/* Word Info */}
                            <div className="info-card">
                                <div className="category-badge">{gameState.category}</div>
                                <div className="word-blanks">{gameState.blanks}</div>
                                <div className="attempts-bar">
                                    <span className="attempts-label">
                                        Attempts: {gameState.attemptsLeft}/{MAX_ATTEMPTS}
                                    </span>
                                    <div className="attempts-dots">
                                        {Array.from({ length: MAX_ATTEMPTS }).map((_, i) => (
                                            <div
                                                key={i}
                                                className={`attempt-dot ${i >= gameState.attemptsLeft ? "used" : ""}`}
                                            />
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {/* Win / Game Over */}
                            {gameState.won || gameState.gameOver ? (
                                <div className={`overlay-card ${gameState.won ? "win" : "lose"}`}>
                                    <div className="overlay-emoji">
                                        {gameState.won ? (
                                            <svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" /></svg>
                                        ) : (
                                            <svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--accent-red)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M16 16s-1.5-2-4-2-4 2-4 2" /><line x1="9" x2="9.01" y1="9" y2="9" /><line x1="15" x2="15.01" y1="9" y2="9" /></svg>
                                        )}
                                    </div>
                                    <div className="overlay-title" style={{ color: gameState.won ? "var(--accent-green)" : "var(--accent-red)" }}>
                                        {gameState.won ? "You got it!" : "Game Over"}
                                    </div>
                                    <div className="overlay-word">
                                        The word was <span>{gameState.blanks.replace(/ /g, "")}</span>
                                    </div>

                                    {/* Rating UI */}
                                    <div className="rating-section" style={{ marginTop: '16px', marginBottom: '16px', textAlign: 'center' }}>
                                        <p style={{ fontSize: '14px', marginBottom: '8px', color: 'var(--text-secondary)' }}>How was the drawing?</p>
                                        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                                            <button
                                                className={`btn-icon ${rating === "up" ? "active" : ""}`}
                                                style={{ border: rating === "up" ? "2px solid var(--accent-green)" : "1px solid var(--border-color)", padding: "8px" }}
                                                onClick={() => setRating("up")}
                                            >
                                                👍
                                            </button>
                                            <button
                                                className={`btn-icon ${rating === "down" ? "active" : ""}`}
                                                style={{ border: rating === "down" ? "2px solid var(--accent-red)" : "1px solid var(--border-color)", padding: "8px" }}
                                                onClick={() => setRating("down")}
                                            >
                                                👎
                                            </button>
                                        </div>
                                    </div>

                                    <button className="btn btn-success" onClick={handleNewGame}>
                                        {gameState.won ? "Play Again" : "Try Again"}
                                    </button>
                                </div>
                            ) : (
                                <>
                                    {/* Guess Input */}
                                    <div className="guess-section">
                                        <div className="guess-form">
                                            <input
                                                type="text"
                                                className="guess-input"
                                                placeholder={audioGuess.isListening ? "Listening..." : "Type your guess..."}
                                                value={guess}
                                                onChange={(e) => setGuess(e.target.value)}
                                                onKeyDown={handleKeyDown}
                                                disabled={!isGameActive}
                                                autoFocus
                                            />
                                            <button
                                                className="btn btn-primary"
                                                onClick={handleGuess}
                                                disabled={!guess.trim() || !isGameActive}
                                            >
                                                Guess
                                            </button>
                                        </div>
                                        {audioGuess.isListening && audioGuess.liveTranscript && (
                                            <div className="live-transcript">
                                                <span className="transcript-dot" />
                                                {audioGuess.liveTranscript}
                                            </div>
                                        )}
                                        {audioGuess.audioError && (
                                            <div className="feedback wrong">{audioGuess.audioError}</div>
                                        )}
                                        {feedback && (
                                            <div className={`feedback ${feedback.type}`}>{feedback.text}</div>
                                        )}
                                    </div>
                                </>
                            )}
                        </>
                    ) : (
                        <div className="waiting-card">
                            <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'center' }}>
                                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>
                            </div>
                            <p>Ready to play!</p>
                            <p style={{ marginTop: 4, fontSize: 13, color: "var(--text-muted)" }}>
                                Hit <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', margin: '0 2px' }}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg> to start, or ask the model to draw
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─── Mount ──────────────────────────────────────────────────────────────

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <McpAppWrapper />
    </StrictMode>
);
